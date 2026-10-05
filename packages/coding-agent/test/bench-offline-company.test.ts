import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BenchSummary } from "../src/cli/bench-cli";

/**
 * Company environment (`--offline` with a usable company config): the bench
 * runtime must expose the internal company lane to selectors and hide the local
 * zcode-api lane. Probed in subprocesses because the company lane snapshot is
 * process-global and read once.
 */
const RUNTIME_MODULE = path.join(import.meta.dir, "../src/cli/bench-runtime.ts");
const CLI = path.join(import.meta.dir, "../src/cli.ts");
const COMPANY_SETTINGS = JSON.stringify({
	env: { ANTHROPIC_BASE_URL: "http://company.invalid", ANTHROPIC_AUTH_TOKEN: "fixture-token" },
});

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function isolatedEnv(companyConfig: boolean): Promise<Record<string, string>> {
	const home = await tempDir("omp-bench-home-");
	const claudeDir = await tempDir("omp-bench-claude-");
	if (companyConfig) await fs.writeFile(path.join(claudeDir, "settings.json"), COMPANY_SETTINGS);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		SystemRoot: process.env.SystemRoot ?? "",
		HOME: home,
		USERPROFILE: home,
		CLAUDE_CONFIG_DIR: claudeDir,
		PI_CODING_AGENT_DIR: path.join(home, "agent"),
		PI_CONFIG_DIR: ".omp",
		NO_COLOR: "1",
	};
	return env;
}

interface ProbeResult {
	providers: string[];
	companySelector: string | null;
	companyContextWindow: number | null;
	zcodeSelector: string | null;
	offlineRequests: number;
	subsequentProviders: string[];
	inheritedProviders: string[];
	inheritedRequests: number;
	ordinaryInheritedProviders: string[];
}

/** Resolve selectors through the real bench runtime; unresolved selectors come back null. */
async function probeBenchRuntime(env: Record<string, string>, offline: boolean): Promise<ProbeResult> {
	const script = `
		let requests = 0;
		globalThis.fetch = async () => { requests++; throw new Error("fixture forbids model discovery"); };
		// Import only after the request guard to cover the real loading boundary.
		const { createDefaultBenchRuntime, resolveBenchTargets } = await import(${JSON.stringify(RUNTIME_MODULE)});
		const runtime = await createDefaultBenchRuntime({ offline: ${offline} });
		try {
			const providers = [...new Set(runtime.modelRegistry.getAll().map(model => model.provider))].sort();
			const resolve = async selector => {
				try {
					const [target] = await resolveBenchTargets([selector], runtime.modelRegistry, runtime.settings, () => {});
					return target ? \`\${target.model.provider}/\${target.model.id}\` : null;
				} catch {
					return null;
				}
			};
			const result = {
				providers,
				companySelector: await resolve("GLM-5.2-public"),
				companyContextWindow: runtime.modelRegistry.getAll().find(model => model.provider === "company" && model.id === "GLM-5.2-public")?.contextWindow ?? null,
				zcodeSelector: await resolve("zcode-api/glm-5.2"),
				offlineRequests: requests,
				subsequentProviders: [],
				inheritedProviders: [],
				inheritedRequests: 0,
				ordinaryInheritedProviders: [],
			};
			if (${offline}) {
				const inherited = await createDefaultBenchRuntime();
				try {
					result.inheritedProviders = [...new Set(inherited.modelRegistry.getAll().map(model => model.provider))];
					try {
						await resolveBenchTargets(["offline-probe-missing"], inherited.modelRegistry, inherited.settings, () => {});
					} catch {}
					result.inheritedRequests = requests - result.offlineRequests;
				} finally { inherited.close?.(); }
				const ordinary = await createDefaultBenchRuntime({ offline: false });
				try {
					result.subsequentProviders = [...new Set(ordinary.modelRegistry.getAll().map(model => model.provider))];
				} finally { ordinary.close?.(); }
				const ordinaryInherited = await createDefaultBenchRuntime();
				try {
					result.ordinaryInheritedProviders = [...new Set(ordinaryInherited.modelRegistry.getAll().map(model => model.provider))];
				} finally { ordinaryInherited.close?.(); }
			}
			console.log(JSON.stringify(result));
		} finally {
			runtime.close?.();
		}
	`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		cwd: env.HOME,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`bench runtime probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout) as ProbeResult;
}

describe("omp bench --offline company environment", () => {
	it("resolves company selectors and hides zcode-api", async () => {
		const env = await isolatedEnv(true);
		const probe = await probeBenchRuntime(env, true);

		expect(probe.providers).toContain("company");
		expect(probe.providers).not.toContain("zcode-api");
		expect(probe.companySelector).toBe("company/GLM-5.2-public");
		expect(probe.companyContextWindow).toBe(200_000);
		expect(probe.zcodeSelector).toBeNull();
		expect(probe.offlineRequests).toBe(0);
		expect(probe.subsequentProviders).not.toContain("company");
		expect(probe.subsequentProviders).toContain("zcode-api");
		expect(probe.inheritedProviders).toContain("company");
		expect(probe.inheritedProviders).not.toContain("zcode-api");
		expect(probe.inheritedRequests).toBe(0);
		expect(probe.ordinaryInheritedProviders).not.toContain("company");
		expect(probe.ordinaryInheritedProviders).toContain("zcode-api");
	}, 30_000);

	it("keeps zcode-api selectors working without a company config", async () => {
		const env = await isolatedEnv(false);
		const probe = await probeBenchRuntime(env, true);

		expect(probe.providers).not.toContain("company");
		expect(probe.providers).toContain("zcode-api");
		expect(probe.companySelector).toBeNull();
		expect(probe.zcodeSelector).toBe("zcode-api/glm-5.2");
		expect(probe.offlineRequests).toBe(0);
		expect(probe.inheritedRequests).toBe(0);
	}, 30_000);

	it.each(["company", "keyless-proxy", "keyed-proxy"])(
		"runs a public %s benchmark over the Anthropic route without discovery",
		async lane => {
			const provider = lane === "company" ? "company" : "zcode-api";
			const modelId = lane === "company" ? "GLM-5.2-public" : "glm-5.2";
			const selector = `${provider}/${modelId}`;
			const requests: Array<{ url: string; authorization: string | null; apiKey: string | null; model: string }> =
				[];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const body = (await request.json()) as { model: string };
					requests.push({
						url: request.url,
						authorization: request.headers.get("authorization"),
						apiKey: request.headers.get("x-api-key"),
						model: body.model,
					});
					const events = [
						{
							type: "message_start",
							message: {
								id: "bench-fixture",
								type: "message",
								role: "assistant",
								model: modelId,
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 5, output_tokens: 0 },
							},
						},
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
						{ type: "content_block_stop", index: 0 },
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 1 },
						},
						{ type: "message_stop" },
					];
					return new Response(
						events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
						{
							headers: { "Content-Type": "text/event-stream" },
						},
					);
				},
			});
			try {
				const env = await isolatedEnv(lane === "company");
				if (lane === "company") {
					await fs.writeFile(
						path.join(env.CLAUDE_CONFIG_DIR!, "settings.json"),
						JSON.stringify({
							env: {
								ANTHROPIC_BASE_URL: `${server.url.origin}/prefix/v1/`,
								ANTHROPIC_AUTH_TOKEN: "fixture-token",
							},
						}),
					);
				} else {
					env.ZCODE_API_BASE_URL = `${server.url.origin}/prefix/v1/`;
					if (lane === "keyed-proxy") {
						env.ZCODE_PROXY_API_KEY = "lower-priority-env-key";
						await fs.mkdir(env.PI_CODING_AGENT_DIR!, { recursive: true });
						await fs.writeFile(
							path.join(env.PI_CODING_AGENT_DIR!, "models.yml"),
							JSON.stringify({
								providers: {
									"zcode-api": { apiKey: "proxy-yaml-key", headers: { Authorization: "Bearer ignored" } },
								},
							}),
						);
					}
				}
				const guard = path.join(env.HOME!, "network-guard.ts");
				const endpoint = `${server.url.origin}/prefix/v1/messages`;
				await fs.writeFile(
					guard,
					`
				const original = globalThis.fetch.bind(globalThis);
				globalThis.fetch = async (input, init) => {
					const url = input instanceof Request ? input.url : String(input);
					if (url !== ${JSON.stringify(endpoint)}) {
						process.stderr.write("UNEXPECTED_NETWORK_FETCH\\n");
						throw new Error("benchmark fixture forbids discovery");
					}
					return original(input, init);
				};
			`,
				);
				const child = Bun.spawn(
					[
						process.execPath,
						"--preload",
						guard,
						CLI,
						"bench",
						selector,
						"--runs",
						"1",
						"--par",
						"1",
						"--json",
						"--offline",
					],
					{
						cwd: env.HOME,
						env,
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [stdout, stderr] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(await child.exited).toBe(0);
				expect(stderr).not.toContain("UNEXPECTED_NETWORK_FETCH");
				const summary = JSON.parse(stdout) as BenchSummary;
				expect(summary.failures).toBe(0);
				expect(summary.models[0]?.model).toBe(selector);
				expect(summary.models[0]?.results).toHaveLength(1);
				expect(requests).toEqual([
					{
						url: endpoint,
						authorization:
							lane === "company"
								? "Bearer fixture-token"
								: lane === "keyed-proxy"
									? "Bearer proxy-yaml-key"
									: null,
						apiKey: null,
						model: modelId,
					},
				]);
			} finally {
				server.stop(true);
			}
		},
		30_000,
	);
});
