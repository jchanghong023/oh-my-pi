import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	env.HOME = home;
	env.USERPROFILE = home;
	env.CLAUDE_CONFIG_DIR = claudeDir;
	return env;
}

interface ProbeResult {
	providers: string[];
	companySelector: string | null;
	zcodeSelector: string | null;
}

/** Resolve selectors through the real bench runtime; unresolved selectors come back null. */
async function probeBenchRuntime(env: Record<string, string>, offline: boolean): Promise<ProbeResult> {
	const script = `
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
			console.log(JSON.stringify({
				providers,
				companySelector: await resolve("GLM-5.2-public"),
				zcodeSelector: await resolve("zcode-api/glm-5.2"),
			}));
		} finally {
			runtime.close?.();
		}
	`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
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
		expect(probe.zcodeSelector).toBeNull();
	}, 30_000);

	it("keeps zcode-api selectors working without a company config", async () => {
		const env = await isolatedEnv(false);
		const probe = await probeBenchRuntime(env, true);

		expect(probe.providers).not.toContain("company");
		expect(probe.providers).toContain("zcode-api");
		expect(probe.companySelector).toBeNull();
		expect(probe.zcodeSelector).toBe("zcode-api/glm-5.2");
	}, 30_000);

	it("advertises the flag on the command", async () => {
		const env = await isolatedEnv(false);
		const child = Bun.spawn([process.execPath, CLI, "bench", "--help"], {
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		expect(stdout).toContain("--offline");
	}, 30_000);
});
