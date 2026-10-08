import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolate the cached company snapshot and environment from the rest of the suite.
// Resolve providers through backend.start before exercising the real embedding transport.
test("embedding gateways and explicit environment credentials survive managed provider resolution", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "embedding-routing-regression-"));
	const source = path.resolve(import.meta.dir, "../src");
	const mnemopiSource = path.resolve(import.meta.dir, "../../mnemopi/src");
	try {
		const child = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`
				import * as fs from "node:fs";
				import * as path from "node:path";
				import { Settings } from ${JSON.stringify(path.join(source, "config/settings.ts"))};
				import { setCompanyOfflineEnabled } from ${JSON.stringify(path.join(source, "config/company-provider.ts"))};
				import { mnemopiBackend } from ${JSON.stringify(path.join(source, "mnemopi/backend.ts"))};
				import { getMnemopiSessionState } from ${JSON.stringify(path.join(source, "mnemopi/state.ts"))};
				import { embed } from ${JSON.stringify(path.join(mnemopiSource, "core/embeddings.ts"))};
				import { withMnemopiRuntimeOptions } from ${JSON.stringify(path.join(mnemopiSource, "core/runtime-options.ts"))};
				import { isApiEmbeddingModel, apiEmbeddingsAvailable } from ${JSON.stringify(path.join(mnemopiSource, "config.ts"))};

				const root = ${JSON.stringify(root)};
				const requests = [];
				const server = Bun.serve({
					hostname: "127.0.0.1", port: 0,
					async fetch(request) {
						const body = await request.json();
						requests.push({ path: new URL(request.url).pathname,
							authorization: request.headers.get("authorization"), model: body.model, input: body.input });
						return Response.json({ data: [{ embedding: [0.25, 0.75] }] });
					},
				});
				const endpoint = server.url.origin;
				const nativeFetch = globalThis.fetch;
				globalThis.fetch = (input, init) => {
					const url = input instanceof Request ? input.url : String(input);
					if (url === "https://openrouter.ai/api/v1/embeddings") {
						return nativeFetch(endpoint + "/official/v1/embeddings", init);
					}
					if (!url.startsWith(endpoint + "/")) throw new Error("Public network forbidden in routing regression");
					return nativeFetch(input, init);
				};
				const envNames = ["MNEMOPI_EMBEDDING_MODEL", "MNEMOPI_EMBEDDING_API_URL", "MNEMOPI_EMBEDDING_API_KEY",
					"MNEMOPI_EMBEDDINGS_VIA_API", "OPENROUTER_BASE_URL", "OPENROUTER_API_KEY", "OPENAI_API_KEY"];
				const clearEnv = () => { for (const name of envNames) delete process.env[name]; };
				clearEnv();
				fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
				fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({
					env: { ANTHROPIC_BASE_URL: endpoint + "/company/v1", ANTHROPIC_AUTH_TOKEN: "company-fixture-key" },
				}));
				setCompanyOfflineEnabled(true);
				const registryLookups = [];
				const modelRegistry = {
					getApiKeyForProvider: async provider => { registryLookups.push(provider); return "registry-fixture-key"; },
					resolver: () => async () => "registry-fixture-key",
				};
				const vectors = [];
				async function run(name, overrides = {}) {
					const settings = Settings.isolated({
						"memory.backend": "mnemopi", "mnemopi.llmMode": "none", "mnemopi.scoping": "global",
						"mnemopi.noEmbeddings": true, "mnemopi.dbPath": path.join(root, name, "mnemopi.db"),
						...overrides,
					});
					const session = {
						sessionId: name, settings, modelRegistry,
						sessionManager: { getEntries: () => [], getCwd: () => root },
						emitNotice: () => {}, getHindsightSessionState: () => undefined, subscribe: () => () => {},
					};
					await mnemopiBackend.start({ session, settings, modelRegistry, agentDir: root, taskDepth: 0 });
					const state = getMnemopiSessionState(session);
					if (!state) throw new Error("Memory backend failed to start for " + name);
					try {
						const options = state.config.providerOptions;
						const result = await withMnemopiRuntimeOptions({ embeddings: {
							disabled: false, model: options.embeddingModel, apiUrl: options.embeddingApiUrl, apiKey: options.embeddingApiKey,
						} }, () => embed([name]));
						vectors.push(result?.map(vector => Array.from(vector)) ?? null);
					} finally { await state.dispose({ consolidate: false }); }
				}
				try {
					// Shared keys alone do not displace the company defaults.
					process.env.OPENROUTER_API_KEY = "shared-fixture-key";
					await run("company-default");
					clearEnv();
					process.env.OPENROUTER_BASE_URL = endpoint + "/openrouter.ai/v1";
					process.env.OPENROUTER_API_KEY = "generic-fixture-key";
					await run("gateway-path");
					clearEnv();
					process.env.OPENROUTER_BASE_URL = endpoint + "/openrouter.ai/no-auth/v1";
					await run("gateway-no-auth");
					clearEnv();
					process.env.MNEMOPI_EMBEDDING_API_URL = endpoint + "/explicit-env/v1";
					process.env.MNEMOPI_EMBEDDING_API_KEY = "explicit-env-fixture-key";
					process.env.OPENROUTER_API_KEY = "lower-priority-fixture-key";
					await run("explicit-env");
					await run("explicit-setting-no-auth", {
						"mnemopi.embeddingApiUrl": endpoint + "/setting/v1", "mnemopi.embeddingApiKey": "",
					});
					clearEnv();
					await run("official-registry", { "mnemopi.embeddingModel": "openai/text-embedding-3-small" });
					const suffixEnv = { OPENROUTER_BASE_URL: "https://openrouter.ai.gateway.internal/v1" };
					console.log(JSON.stringify({ requests, vectors, registryLookups,
						suffixApiModel: isApiEmbeddingModel("intfloat/multilingual-e5-large", suffixEnv),
						suffixAvailable: apiEmbeddingsAvailable(suffixEnv) }));
				} finally { server.stop(true); }
				`,
			],
			{
				env: {
					...process.env,
					CLAUDE_CONFIG_DIR: path.join(root, "claude"),
					PI_CODING_AGENT_DIR: path.join(root, "agent"),
					OMP_CONFIG_ROOT: root,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (child.exitCode !== 0) throw new Error(child.stderr.toString());
		const result = JSON.parse(child.stdout.toString());
		expect(result.requests).toEqual([
			{
				path: "/company/v1/embeddings",
				authorization: "Bearer company-fixture-key",
				model: "Qwen3-VL-Embedding-2B",
				input: ["company-default"],
			},
			{
				path: "/openrouter.ai/v1/embeddings",
				authorization: "Bearer generic-fixture-key",
				model: "intfloat/multilingual-e5-large",
				input: ["gateway-path"],
			},
			{
				path: "/openrouter.ai/no-auth/v1/embeddings",
				authorization: null,
				model: "intfloat/multilingual-e5-large",
				input: ["gateway-no-auth"],
			},
			{
				path: "/explicit-env/v1/embeddings",
				authorization: "Bearer explicit-env-fixture-key",
				model: "intfloat/multilingual-e5-large",
				input: ["explicit-env"],
			},
			{
				path: "/setting/v1/embeddings",
				authorization: null,
				model: "intfloat/multilingual-e5-large",
				input: ["explicit-setting-no-auth"],
			},
			{
				path: "/official/v1/embeddings",
				authorization: "Bearer registry-fixture-key",
				model: "openai/text-embedding-3-small",
				input: ["official-registry"],
			},
		]);
		expect(result.vectors).toEqual(Array.from({ length: 6 }, () => [[0.25, 0.75]]));
		expect(result.registryLookups).toEqual(["openrouter"]);
		expect(result.suffixApiModel).toBe(true);
		expect(result.suffixAvailable).toBe(true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
