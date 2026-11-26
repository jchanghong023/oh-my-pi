import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";

/**
 * Exercise the public CLI in isolated processes because the company configuration
 * is snapshotted once per process.
 */
const CLI = path.join(import.meta.dir, "../src/cli.ts");
const COMPANY_SETTINGS = JSON.stringify({
	env: { ANTHROPIC_BASE_URL: "http://company.invalid", ANTHROPIC_AUTH_TOKEN: "fixture-token" },
});

const tempDirs: string[] = [];
interface ModelRow {
	provider: string;
	selector: string;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function runModels(
	args: readonly string[],
	options: {
		companyConfig?: boolean;
		modelsConfig?: unknown;
		extensionCache?: "cold" | "warm";
	},
): Promise<{
	models: ModelRow[];
	stderr: string;
}> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-models-home-"));
	tempDirs.push(home);
	const claudeDir = path.join(home, "claude");
	if (options.companyConfig !== false) {
		await fs.mkdir(claudeDir);
		await fs.writeFile(path.join(claudeDir, "settings.json"), COMPANY_SETTINGS);
	}
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		SystemRoot: process.env.SystemRoot ?? "",
		HOME: home,
		USERPROFILE: home,
		OMP_CONFIG_ROOT: path.join(home, ".omp"),
		CLAUDE_CONFIG_DIR: claudeDir,
		PI_CODING_AGENT_DIR: path.join(home, "agent"),
		OMP_OFFLINE: "1",
		PI_CONFIG_DIR: ".omp",
		NO_COLOR: "1",
	};
	const agentDir = env.PI_CODING_AGENT_DIR!;
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
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
	const extensionArgs: string[] = [];
	if (options.extensionCache) {
		const extensionFile = path.join(home, "offline-extension.ts");
		await fs.writeFile(
			extensionFile,
			`
			export default function (pi) {
				pi.registerProvider("opencode-go", {
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
			writeModelCache(
				"opencode-go",
				Date.now() - 48 * 60 * 60 * 1000,
				[
					buildModel({
						provider: "opencode-go",
						id: "cached-model",
						name: "Cached model",
						api: "anthropic-messages",
						baseUrl: "https://extension.invalid",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 10000,
						maxTokens: 1000,
					}),
				],
				true,
				"",
				path.join(agentDir, "models.db"),
			);
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
	expect(await child.exited, stderr).toBe(0);
	expect(stderr).not.toContain("UNEXPECTED_NETWORK_FETCH");
	expect(stderr).not.toContain("UNEXPECTED_EXTENSION_DISCOVERY");
	const { models } = JSON.parse(stdout) as { models: ModelRow[] };
	return { models, stderr };
}

describe("OMP_OFFLINE=1 omp models company environment", () => {
	it("lists company and stale extension models without discovery", async () => {
		const { models } = await runModels(["--json"], { extensionCache: "warm" });

		expect(models.some(model => model.provider === "company")).toBe(true);
		expect(models.some(model => model.selector === "opencode-go/cached-model")).toBe(true);
	}, 30_000);

	it("reports the reason when company configuration is missing", async () => {
		const { models, stderr } = await runModels(["--json"], { companyConfig: false });

		expect(models.some(model => model.provider === "company")).toBe(false);
		expect(stderr).toContain("settings.json");
	}, 30_000);

	it("keeps extension refresh cache-only and reports ignored company policy without leaking credentials", async () => {
		const { models, stderr } = await runModels(["refresh", "--json"], {
			extensionCache: "cold",
			modelsConfig: {
				providers: {
					company: { models: false, apiKey: "ignored-company-key" },
				},
			},
		});
		expect(models.some(model => model.provider === "company")).toBe(true);
		expect(stderr).toContain("providers.company");
		expect(stderr).not.toContain("ignored-company-key");
	}, 30_000);

	it("keeps an extension selector miss cache-only", async () => {
		const { models } = await runModels(["find", "opencode-go/missing", "--json"], { extensionCache: "warm" });
		expect(models).toEqual([]);
	}, 30_000);
});
