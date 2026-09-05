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
	lintLog: string;
	formatLog: string;
};

async function createFixture(options?: {
	changed?: string[];
	untracked?: string[];
	lintExitCode?: number;
	formatExitCode?: number;
}): Promise<Fixture> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fastcheck-"));
	tempDirs.push(repo);
	const binDir = path.join(repo, ".test-bin");
	const lintLog = path.join(repo, ".oxlint-argv");
	const formatLog = path.join(repo, ".oxfmt-argv");
	await fs.mkdir(binDir);
	await Bun.write(lintLog, "");
	await Bun.write(formatLog, "");
	await writeRepoFile(repo, "scripts/fastcheck.ts", await Bun.file(sourceScript).text());

	const tracked = [
		"packages/sample/src/included.ts",
		"packages/sample/src/unchanged.ts",
		"outside/tracked-outside.ts",
	];
	for (const file of tracked) await writeRepoFile(repo, file, "export const baseline = 1;\n");
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "fastcheck@example.invalid");
	await git(repo, "config", "user.name", "Fastcheck Test");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "fixture baseline");

	for (const file of options?.changed ?? []) await writeRepoFile(repo, file, "export const changed = 2;\n");
	for (const file of options?.untracked ?? []) await writeRepoFile(repo, file, "export const untracked = 3;\n");

	for (const [tool, logEnv, exitCode] of [
		["oxlint", "LINT_LOG", options?.lintExitCode ?? 0],
		["oxfmt", "FORMAT_LOG", options?.formatExitCode ?? 0],
	] as const) {
		const stub = path.join(binDir, tool);
		await Bun.write(
			stub,
			`#!/bin/sh
for arg do printf '%s\\0' "$arg" >> "$${logEnv}"; done
exit ${exitCode}
`,
		);
		await fs.chmod(stub, 0o755);
	}

	return {
		repo,
		lintLog,
		formatLog,
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			LINT_LOG: lintLog,
			FORMAT_LOG: formatLog,
		},
	};
}

async function runFastcheck(fixture: Fixture) {
	const result = await spawn(
		[process.execPath, path.join(fixture.repo, "scripts/fastcheck.ts")],
		fixture.repo,
		fixture.env,
	);
	const lintArgv = (await Bun.file(fixture.lintLog).text()).split("\0").filter(Boolean);
	const formatArgv = (await Bun.file(fixture.formatLog).text()).split("\0").filter(Boolean);
	return { ...result, lintArgv, formatArgv };
}

describe("fastcheck oxlint/oxfmt scope", () => {
	test("lints only modified and untracked TypeScript paths and formats the root-managed subset", async () => {
		const fixture = await createFixture({
			changed: ["packages/sample/src/included.ts", "outside/tracked-outside.ts"],
			untracked: ["scripts/untracked.ts", "outside/untracked.ts", "notes.md"],
		});
		const result = await runFastcheck(fixture);
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(result.lintArgv).toEqual([
			"outside/tracked-outside.ts",
			"outside/untracked.ts",
			"packages/sample/src/included.ts",
			"scripts/untracked.ts",
		]);
		expect(result.formatArgv).toEqual(["--check", "packages/sample/src/included.ts", "scripts/untracked.ts"]);
	});

	test("still lints when every changed path is outside the formatter scope", async () => {
		const fixture = await createFixture({
			changed: ["outside/tracked-outside.ts"],
			untracked: ["outside/untracked.ts"],
		});
		const result = await runFastcheck(fixture);
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(result.lintArgv).toEqual(["outside/tracked-outside.ts", "outside/untracked.ts"]);
		expect(result.formatArgv).toEqual([]);
	});

	test.each(["oxlint", "oxfmt"])("propagates the %s exit code unchanged", async tool => {
		const fixture = await createFixture({
			changed: ["packages/sample/src/included.ts"],
			lintExitCode: tool === "oxlint" ? 7 : 0,
			formatExitCode: tool === "oxfmt" ? 7 : 0,
		});
		const result = await runFastcheck(fixture);
		expect(result.exitCode).toBe(7);
		expect(result.lintArgv).toEqual(["packages/sample/src/included.ts"]);
		expect(result.formatArgv).toEqual(tool === "oxlint" ? [] : ["--check", "packages/sample/src/included.ts"]);
	});

	test("does not invoke either tool when no TypeScript files have changed", async () => {
		const fixture = await createFixture({ untracked: ["notes.md"] });
		const result = await runFastcheck(fixture);
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(result.lintArgv).toEqual([]);
		expect(result.formatArgv).toEqual([]);
	});
});
