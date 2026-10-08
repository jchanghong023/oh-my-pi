import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `OMP_OFFLINE=1 omp models` in the company environment must list the internal
 * company lane and hide the local zcode-api lane; an OMP_OFFLINE=1 run without
 * a usable company config (home usage) and a plain `omp models` keep zcode-api
 * visible. Covered as subprocesses because the company lane snapshot is
 * process-global and read once, so one process cannot serve both fixtures.
 */
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

async function runModels(
	args: readonly string[],
	options: {
		companyConfig: boolean;
		modelsConfig?: unknown;
		malformedCompanyConfig?: boolean;
		extensionCache?: "cold" | "warm";
		offline?: boolean;
	},
): Promise<{
	providers: Set<string>;
	selectors: string[];
	companyContextWindows: number[];
	companyMaxTokens: number[];
	stderr: string;
}> {
	const home = await tempDir("omp-models-home-");
	const claudeDir = await tempDir("omp-models-claude-");
	if (options.companyConfig) {
		await fs.writeFile(
			path.join(claudeDir, "settings.json"),
			options.malformedCompanyConfig ? "{ invalid fixture JSON" : COMPANY_SETTINGS,
		);
	}
	const agentDir = path.join(home, "agent");
	await fs.mkdir(agentDir);
	if (options.modelsConfig !== undefined) {
		await fs.writeFile(path.join(agentDir, "models.yml"), JSON.stringify(options.modelsConfig));
	}
	const guard = path.join(home, "network-guard.ts");
	await fs.writeFile(
		guard,
		`globalThis.fetch = async () => {
			process.stderr.write("UNEXPECTED_NETWORK_FETCH\\n");
			throw new Error("model CLI fixture forbids network");
		};`,
	);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		SystemRoot: process.env.SystemRoot ?? "",
		HOME: home,
		USERPROFILE: home,
		CLAUDE_CONFIG_DIR: claudeDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: ".omp",
		NO_COLOR: "1",
	};
	if (options.offline) env.OMP_OFFLINE = "1";
	const extensionArgs: string[] = [];
	if (options.extensionCache) {
		const extensionFile = path.join(home, "offline-extension.ts");
		await fs.writeFile(
			extensionFile,
			`
			export default function (pi) {
				pi.registerProvider("offline-extension", {
					api: "anthropic-messages", baseUrl: "https://extension.invalid", apiKey: "extension-fixture-key",
					fetchDynamicModels: async () => {
						process.stderr.write("UNEXPECTED_EXTENSION_DISCOVERY\\n");
						throw new Error("offline extension catalog must use cache only");
					},
				});
			}
		`,
		);
		extensionArgs.push("--extension", extensionFile);
		if (options.extensionCache === "warm") {
			const child = Bun.spawnSync(
				[
					process.execPath,
					"--eval",
					`
				// Absolute imports keep the cache writer isolated from the working directory.
				const { buildModel } = await import(${JSON.stringify(path.join(import.meta.dir, "../../catalog/src/build.ts"))});
				const { writeModelCache, closeModelCache } = await import(${JSON.stringify(path.join(import.meta.dir, "../../catalog/src/model-cache.ts"))});
				writeModelCache("offline-extension", Date.now() - 48 * 60 * 60 * 1000, [buildModel({
					provider: "offline-extension", id: "cached-model", name: "Cached model",
					api: "anthropic-messages", baseUrl: "https://extension.invalid", reasoning: false,
					input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10000, maxTokens: 1000,
				})], true, "", ${JSON.stringify(path.join(agentDir, "models.db"))});
				closeModelCache();
			`,
				],
				{ cwd: home, env, stdout: "pipe", stderr: "pipe" },
			);
			expect(child.exitCode, child.stderr.toString()).toBe(0);
		}
	}

	const child = Bun.spawn([process.execPath, "--preload", guard, CLI, "models", ...args, ...extensionArgs], {
		cwd: home,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect(await child.exited).toBe(0);
	if (options.offline) {
		expect(stderr).not.toContain("UNEXPECTED_NETWORK_FETCH");
		expect(stderr).not.toContain("UNEXPECTED_EXTENSION_DISCOVERY");
	}
	const payload = JSON.parse(stdout) as {
		models: Array<{ provider: string; selector: string; contextWindow: number; maxTokens: number }>;
	};
	return {
		providers: new Set(payload.models.map(model => model.provider)),
		selectors: payload.models.map(model => model.selector),
		companyContextWindows: payload.models
			.filter(model => model.provider === "company")
			.map(model => model.contextWindow),
		companyMaxTokens: payload.models.filter(model => model.provider === "company").map(model => model.maxTokens),
		stderr,
	};
}

describe("OMP_OFFLINE=1 omp models company environment", () => {
	it("lists the company lane and hides zcode-api", async () => {
		const { providers, companyContextWindows, companyMaxTokens, stderr } = await runModels(["--json"], {
			companyConfig: true,
			offline: true,
		});

		expect(providers.has("company")).toBe(true);
		expect(providers.has("zcode-api")).toBe(false);
		expect(companyContextWindows).toHaveLength(6);
		expect(companyContextWindows.every(window => window === 200_000)).toBe(true);
		expect(companyMaxTokens.every(tokens => tokens === 81_920)).toBe(true);
		expect(stderr).not.toContain("Company provider unavailable");
	}, 30_000);

	it("hides zcode-api without a company config and reports the reason", async () => {
		const { providers, stderr } = await runModels(["--json"], { companyConfig: false, offline: true });

		expect(providers.has("company")).toBe(false);
		expect(providers.has("zcode-api")).toBe(false);
		expect(stderr).toContain("Company provider unavailable");
	}, 30_000);

	it("does not register the company lane without OMP_OFFLINE", async () => {
		const { providers } = await runModels(["--json"], { companyConfig: true });

		expect(providers.has("company")).toBe(false);
		expect(providers.has("zcode-api")).toBe(true);
	}, 30_000);

	for (const action of ["ls", "list", "refresh", "company"]) {
		it(`keeps ${action} cache-only under OMP_OFFLINE=1`, async () => {
			const { providers, companyContextWindows } = await runModels([action, "--json"], {
				companyConfig: true,
				offline: true,
			});
			expect(providers.has("company")).toBe(true);
			expect(providers.has("zcode-api")).toBe(false);
			expect(companyContextWindows).toHaveLength(6);
		}, 30_000);
	}

	it("filters explicit find selectors without fetching a hidden or missing provider", async () => {
		const { providers } = await runModels(["find", "zcode-api/*", "--json"], {
			companyConfig: true,
			offline: true,
		});
		expect([...providers]).toEqual([]);
	}, 30_000);

	it("reports malformed company configuration without falling back to zcode-api", async () => {
		const { providers, stderr } = await runModels(["refresh", "--json"], {
			companyConfig: true,
			malformedCompanyConfig: true,
			offline: true,
		});
		expect(providers.has("company")).toBe(false);
		expect(providers.has("zcode-api")).toBe(false);
		expect(stderr).toContain("not valid JSON");
	}, 30_000);

	it("surfaces ignored reserved policy at the public command without leaking credentials", async () => {
		const { providers, stderr } = await runModels(["refresh", "--json"], {
			companyConfig: true,
			offline: true,
			modelsConfig: {
				providers: {
					company: { models: false, apiKey: "ignored-company-key" },
					"zcode-api": { apiKey: "proxy-fixture-key", discovery: false, models: false },
				},
			},
		});
		expect(providers.has("company")).toBe(true);
		expect(stderr).toContain("whole section is ignored");
		expect(stderr).toContain("only apiKey");
		expect(stderr).not.toContain("ignored-company-key");
		expect(stderr).not.toContain("proxy-fixture-key");
	}, 30_000);

	for (const extensionCache of ["cold", "warm"] as const) {
		for (const action of ["ls", "refresh"]) {
			it(`uses ${extensionCache} extension cache for offline ${action} without invoking discovery`, async () => {
				const { providers, selectors } = await runModels([action, "--json"], {
					companyConfig: true,
					extensionCache,
					offline: true,
				});
				expect(providers.has("offline-extension")).toBe(extensionCache === "warm");
				expect(selectors.includes("offline-extension/cached-model")).toBe(extensionCache === "warm");
			}, 30_000);
		}
	}

	it("keeps an extension selector miss cache-only", async () => {
		const { selectors } = await runModels(["find", "offline-extension/missing", "--json"], {
			companyConfig: true,
			extensionCache: "warm",
			offline: true,
		});
		expect(selectors).toEqual([]);
	}, 30_000);
});
