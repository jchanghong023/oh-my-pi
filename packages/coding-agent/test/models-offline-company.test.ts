import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `omp models --offline` in the company environment must list the internal
 * company lane and hide the local zcode-api lane; an `--offline` run without a
 * usable company config (home usage) and a plain `omp models` keep zcode-api
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
	options: { companyConfig: boolean },
): Promise<{ providers: Set<string>; stderr: string }> {
	const home = await tempDir("omp-models-home-");
	const claudeDir = await tempDir("omp-models-claude-");
	if (options.companyConfig) {
		await fs.writeFile(path.join(claudeDir, "settings.json"), COMPANY_SETTINGS);
	}
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	env.HOME = home;
	env.USERPROFILE = home;
	env.CLAUDE_CONFIG_DIR = claudeDir;

	const child = Bun.spawn([process.execPath, CLI, "models", ...args], {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect(await child.exited).toBe(0);
	const payload = JSON.parse(stdout) as { models: Array<{ provider: string }> };
	return { providers: new Set(payload.models.map(model => model.provider)), stderr };
}

describe("omp models --offline company environment", () => {
	it("lists the company lane and hides zcode-api", async () => {
		const { providers, stderr } = await runModels(["--offline", "--json"], { companyConfig: true });

		expect(providers.has("company")).toBe(true);
		expect(providers.has("zcode-api")).toBe(false);
		expect(stderr).not.toContain("Company provider unavailable");
	});

	it("keeps zcode-api visible and reports the reason when the company config is missing", async () => {
		const { providers, stderr } = await runModels(["--offline", "--json"], { companyConfig: false });

		expect(providers.has("company")).toBe(false);
		expect(providers.has("zcode-api")).toBe(true);
		expect(stderr).toContain("Company provider unavailable");
	});

	it("does not register the company lane without --offline", async () => {
		const { providers } = await runModels(["--json"], { companyConfig: true });

		expect(providers.has("company")).toBe(false);
		expect(providers.has("zcode-api")).toBe(true);
	});
});
