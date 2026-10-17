import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOfflineShmState } from "@oh-my-pi/pi-natives/offline-root";
import type { BenchSummary } from "../src/cli/bench-cli";

/**
 * Company environment (OMP_OFFLINE=1 with a usable company config): the bench
 * runtime must expose the internal company lane to selectors. Probed in
 * subprocesses because the company lane snapshot is process-global and read once.
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

async function isolatedEnv(companyConfig: boolean, offline = false): Promise<Record<string, string>> {
	const home = await tempDir("omp-bench-home-");
	const claudeDir = await tempDir("omp-bench-claude-");
	if (companyConfig) await fs.writeFile(path.join(claudeDir, "settings.json"), COMPANY_SETTINGS);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		SystemRoot: process.env.SystemRoot ?? "",
		HOME: home,
		USERPROFILE: home,
		OMP_CONFIG_ROOT: path.join(home, ".omp"),
		CLAUDE_CONFIG_DIR: claudeDir,
		PI_CODING_AGENT_DIR: path.join(home, "agent"),
		PI_CONFIG_DIR: ".omp",
		NO_COLOR: "1",
	};
	if (offline) env.OMP_OFFLINE = "1";
	const shm = getOfflineShmState(env);
	if (shm) tempDirs.push(path.dirname(shm.runtimeRoot));
	const agentDir = shm ? path.join(shm.runtimeRoot, "agent") : env.PI_CODING_AGENT_DIR!;
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	return env;
}

interface ProbeResult {
	providers: string[];
	companySelector: string | null;
	companyContextWindow: number | null;
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

describe("OMP_OFFLINE=1 omp bench company environment", () => {
	it("resolves company selectors and inherits the offline lane", async () => {
		const env = await isolatedEnv(true, true);
		const probe = await probeBenchRuntime(env, true);

		expect(probe.providers).toContain("company");
		expect(probe.companySelector).toBe("company/GLM-5.2-public");
		expect(probe.companyContextWindow).toBe(200_000);
		expect(probe.offlineRequests).toBe(0);
		expect(probe.subsequentProviders).not.toContain("company");
		expect(probe.inheritedProviders).toContain("company");
		expect(probe.inheritedRequests).toBe(0);
		expect(probe.ordinaryInheritedProviders).not.toContain("company");
	}, 30_000);

	it("keeps company selectors unavailable without a company config under OMP_OFFLINE", async () => {
		const env = await isolatedEnv(false, true);
		const probe = await probeBenchRuntime(env, true);

		expect(probe.providers).not.toContain("company");
		expect(probe.companySelector).toBeNull();
		expect(probe.offlineRequests).toBe(0);
		expect(probe.inheritedRequests).toBe(0);
	}, 30_000);

	it("runs a public company benchmark over the Anthropic route without discovery", async () => {
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
			const env = await isolatedEnv(true, true);
			await fs.writeFile(
				path.join(env.CLAUDE_CONFIG_DIR!, "settings.json"),
				JSON.stringify({
					env: {
						ANTHROPIC_BASE_URL: `${server.url.origin}/prefix/v1/`,
						ANTHROPIC_AUTH_TOKEN: "fixture-token",
					},
				}),
			);
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
			expect(requests).toEqual([
				{
					url: endpoint,
					authorization: "Bearer fixture-token",
					apiKey: null,
					model: modelId,
				},
			]);
		} finally {
			server.stop(true);
		}
	}, 30_000);
});
