import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const sourceScript = path.join(import.meta.dir, "fastcheck.ts");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function spawn(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
	const proc = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function git(repo: string, ...args: string[]): Promise<void> {
	const result = await spawn(["git", ...args], repo);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

async function writeRepoFile(repo: string, relativePath: string, content: string): Promise<void> {
	const file = path.join(repo, relativePath);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
}

type Fixture = {
	repo: string;
	env: NodeJS.ProcessEnv;
	biomeLog: string;
};

async function createFixture(options?: {
	changed?: string[];
	untracked?: string[];
	biomeExitCode?: number;
	biomeIncludes?: string[];
	invalidBiomeJson?: boolean;
}): Promise<Fixture> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fastcheck-"));
	tempDirs.push(repo);
	const binDir = path.join(repo, ".test-bin");
	const biomeLog = path.join(repo, ".biome-argv");
	await fs.mkdir(binDir);
	await Bun.write(biomeLog, "");
	await writeRepoFile(repo, "scripts/fastcheck.ts", await Bun.file(sourceScript).text());
	await writeRepoFile(
		repo,
		"biome.json",
		options?.invalidBiomeJson
			? "{"
			: JSON.stringify({ files: { includes: options?.biomeIncludes ?? ["src/**/*.ts", "!**/excluded*.ts"] } }),
	);

	const tracked = ["src/included.ts", "src/excluded.ts", "outside/tracked-outside.ts"];
	for (const file of tracked) await writeRepoFile(repo, file, "export const baseline = 1;\n");
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "fastcheck@example.invalid");
	await git(repo, "config", "user.name", "Fastcheck Test");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "fixture baseline");

	for (const file of options?.changed ?? []) await writeRepoFile(repo, file, "export const changed = 2;\n");
	for (const file of options?.untracked ?? []) await writeRepoFile(repo, file, "export const untracked = 3;\n");

	const biomeStub = path.join(binDir, "biome");
	await Bun.write(
		biomeStub,
		`#!/bin/sh
for arg do printf '%s\\0' "$arg" >> "$BIOME_LOG"; done
exit ${options?.biomeExitCode ?? 0}
`,
	);
	await fs.chmod(biomeStub, 0o755);

	return {
		repo,
		biomeLog,
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			BIOME_LOG: biomeLog,
		},
	};
}

async function runFastcheck(fixture: Fixture) {
	const result = await spawn([process.execPath, path.join(fixture.repo, "scripts/fastcheck.ts")], fixture.repo, fixture.env);
	const argv = (await Bun.file(fixture.biomeLog).text()).split("\0").filter(Boolean);
	return { ...result, argv };
}

describe("fastcheck biome scope", () => {
	test("checks only included modified and untracked TypeScript paths", async () => {
		const fixture = await createFixture({
			changed: ["src/included.ts", "src/excluded.ts", "outside/tracked-outside.ts"],
			untracked: ["src/untracked.ts", "src/excluded-untracked.ts", "outside/untracked.ts"],
		});
		const result = await runFastcheck(fixture);
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(result.argv).toEqual([
			"check",
			"--no-errors-on-unmatched",
			"src/included.ts",
			"src/untracked.ts",
		]);
		for (const file of [
			"src/excluded.ts",
			"src/excluded-untracked.ts",
			"outside/tracked-outside.ts",
			"outside/untracked.ts",
		]) {
			expect(result.stdout).toContain(`skipping ${file} (outside biome.json files.includes)`);
		}
		expect(result.stdout).toContain("fastcheck: checking 2 Biome-managed file(s):");
		expect(result.stdout).toContain("  src/included.ts");
		expect(result.stdout).toContain("  src/untracked.ts");
	});

	test("succeeds without invoking biome when every changed path is outside scope", async () => {
		const fixture = await createFixture({
			changed: ["src/excluded.ts", "outside/tracked-outside.ts"],
			untracked: ["outside/untracked.ts"],
		});
		const result = await runFastcheck(fixture);
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(result.argv).toEqual([]);
		expect(result.stdout).toContain("no Biome-managed files");
	});

	test("propagates the biome exit code unchanged", async () => {
		const fixture = await createFixture({ changed: ["src/included.ts"], biomeExitCode: 7 });
		const result = await runFastcheck(fixture);
		expect(result.exitCode).toBe(7);
	});

	test("fails closed when biome includes cannot be parsed or have no positive pattern", async () => {
		for (const options of [{ invalidBiomeJson: true }, { biomeIncludes: ["!**/excluded*.ts"] }]) {
			const fixture = await createFixture({ ...options, changed: ["src/included.ts"] });
			const result = await runFastcheck(fixture);
			expect(result.exitCode).not.toBe(0);
			expect(result.argv).toEqual([]);
		}
	});
});
