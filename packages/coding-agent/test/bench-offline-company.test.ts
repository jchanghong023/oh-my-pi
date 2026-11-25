import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BenchSummary } from "../src/cli/bench-cli";

/**
 * Company environment (OMP_OFFLINE=1 with a usable company config): the bench
 * runtime must expose the internal company lane to selectors. Probed in
 * subprocesses because the company lane snapshot is process-global and read once.
 */
const RUNTIME_MODULE = path.join(import.meta.dir, "../src/cli/bench-runtime.ts");
const SETTINGS_MODULE = path.join(import.meta.dir, "../src/config/settings.ts");
const CLI = path.join(import.meta.dir, "../src/cli.ts");
const COMPANY_TOKEN = "fixture-token";

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function isolatedEnv(companyUrl: string | null = "http://company.invalid"): Promise<Record<string, string>> {
	const home = await tempDir("omp-bench-home-");
	const claudeDir = path.join(home, "claude");
	if (companyUrl !== null) {
		await fs.mkdir(claudeDir);
		await fs.writeFile(
			path.join(claudeDir, "settings.json"),
			JSON.stringify({ env: { ANTHROPIC_BASE_URL: companyUrl, ANTHROPIC_AUTH_TOKEN: COMPANY_TOKEN } }),
		);
	}
	const agentDir = path.join(home, "agent");
	await fs.mkdir(agentDir, { mode: 0o700 });
	return {
		PATH: process.env.PATH ?? "",
		SystemRoot: process.env.SystemRoot ?? "",
		HOME: home,
		USERPROFILE: home,
		OMP_CONFIG_ROOT: path.join(home, ".omp"),
		CLAUDE_CONFIG_DIR: claudeDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: ".omp",
		OMP_OFFLINE: "1",
		NO_COLOR: "1",
	};
}

async function probeBenchRuntime(env: Record<string, string>, checks: string): Promise<void> {
	const script = `
		import assert from "node:assert/strict";

		let requests = 0;
		globalThis.fetch = async () => { requests++; throw new Error("fixture forbids model discovery"); };
		// Install the guard before importing the runtime and its providers.
		const { createDefaultBenchRuntime, resolveBenchTargets } = await import(${JSON.stringify(RUNTIME_MODULE)});
		const { Settings } = await import(${JSON.stringify(SETTINGS_MODULE)});
		const withRuntime = async (options, check) => {
			const runtime = await createDefaultBenchRuntime(options);
			try { await check(runtime); } finally { runtime.close?.(); }
		};
		const hasCompany = runtime => runtime.modelRegistry.getAvailable().some(model => model.provider === "company");
		const resolve = async (runtime, selector) => {
			const [target] = await resolveBenchTargets([selector], runtime.modelRegistry, runtime.settings, () => {});
			return \`\${target.model.provider}/\${target.model.id}\`;
		};
		${checks}
	`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		cwd: env.HOME,
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderr = await new Response(child.stderr).text();
	expect(await child.exited, stderr).toBe(0);
}

describe("OMP_OFFLINE=1 omp bench company environment", () => {
	it("inherits the offline lane without leaking its role defaults into later runtimes", async () => {
		const env = await isolatedEnv();
		await fs.writeFile(
			path.join(env.PI_CODING_AGENT_DIR!, "models.yml"),
			JSON.stringify({
				providers: {
					"probe-gateway": {
						api: "openai-completions",
						baseUrl: "http://discovery.invalid",
						apiKey: "probe-key",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		await probeBenchRuntime(
			env,
			`
			const host = await Settings.init({ cwd: process.cwd() });
			const publicModel = "deepseek/deepseek-v4-flash";
			host.setModelRoleDefaults({ smol: publicModel });
			await withRuntime({ offline: true }, async runtime => {
				assert.equal(await resolve(runtime, "GLM-5.2-public"), "company/GLM-5.2-public");
			});
			await withRuntime(undefined, async runtime => {
				assert.ok(hasCompany(runtime));
				assert.equal(await resolve(runtime, "@smol"), "company/Qwen3.8-27B");
				assert.ok(runtime.modelRegistry.getDiscoverableProviders().includes("probe-gateway"));
				await assert.rejects(() => resolve(runtime, "probe-gateway/offline-probe-missing"), /Could not resolve model/);
				assert.equal(requests, 0);
			});
			assert.equal(host.getModelRole("smol"), publicModel);
			await withRuntime({ offline: false }, async runtime => {
				assert.ok(!hasCompany(runtime));
				assert.equal(await resolve(runtime, "@smol"), publicModel);
			});
		`,
		);
	}, 30_000);

	it("keeps company selectors unavailable without a company config under OMP_OFFLINE", async () => {
		await probeBenchRuntime(
			await isolatedEnv(null),
			`
			await withRuntime({ offline: true }, async runtime => {
				assert.ok(!hasCompany(runtime));
				assert.equal(runtime.settings.getModelRole("smol") ?? null, null);
				await assert.rejects(() => resolve(runtime, "company/GLM-5.2-public"), /Could not resolve model/);
				assert.equal(requests, 0);
			});
		`,
		);
	}, 30_000);

	it("honors configured and explicitly cleared roles instead of applying company defaults", async () => {
		const env = await isolatedEnv();
		const configPath = path.join(env.HOME!, "roles.yml");
		const config = "modelRoles:\n  default: null\n  smol: null\n  tiny: deepseek/deepseek-v4-flash\n";
		await fs.writeFile(configPath, config);
		env.PI_CONFIG_FILES = configPath;
		await probeBenchRuntime(
			env,
			`
			await withRuntime({ offline: true }, async runtime => {
				assert.equal(await resolve(runtime, "@tiny"), "deepseek/deepseek-v4-flash");
				assert.equal(runtime.settings.getModelRole("smol") ?? null, null);
				assert.ok(!(await resolve(runtime, "@smol")).startsWith("company/"));
			});
		`,
		);
		expect(await fs.readFile(configPath, "utf8")).toBe(config);
	}, 30_000);

	it("does not install company role defaults when the provider is disabled", async () => {
		const env = await isolatedEnv();
		const configPath = path.join(env.HOME!, "disabled.yml");
		await fs.writeFile(configPath, "disabledProviders:\n  - company\n");
		env.PI_CONFIG_FILES = configPath;
		await probeBenchRuntime(
			env,
			`
			await withRuntime({ offline: true }, async runtime => {
				assert.ok(!hasCompany(runtime));
				assert.equal(runtime.settings.getModelRole("smol") ?? null, null);
				await assert.rejects(() => resolve(runtime, "company/GLM-5.2-public"), /Could not resolve model/);
			});
		`,
		);
	}, 30_000);

	it("runs a public company benchmark without discovery or raw credential dumps under PI_REQ_DEBUG", async () => {
		const provider = "company";
		const modelId = "GLM-5.2-public";
		const selector = `${provider}/${modelId}`;
		const requests: Array<{ url: string; authorization: string | null; apiKey: string | null; model: string }> = [];
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
			const env = await isolatedEnv(`${server.url.origin}/prefix/v1/`);
			env.PI_REQ_DEBUG = "1";
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
				[process.execPath, "--preload", guard, CLI, "bench", selector, "--runs", "1", "--par", "1", "--json"],
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
			expect((await fs.readdir(env.HOME!)).filter(name => name.startsWith("rr-session-"))).toEqual([]);
			expect(requests).toEqual([
				{
					url: endpoint,
					authorization: `Bearer ${COMPANY_TOKEN}`,
					apiKey: null,
					model: modelId,
				},
			]);
		} finally {
			server.stop(true);
		}
	}, 30_000);
});
