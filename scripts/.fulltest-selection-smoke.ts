import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { strict as assert } from "node:assert";

const repo = path.resolve(import.meta.dir, "..");
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "fulltest-scope-"));
const log = path.join(fixture, "executed.jsonl");
async function run(argv: string[], env: Record<string, string | undefined> = process.env): Promise<string> {
	const child = Bun.spawn(argv, { cwd: fixture, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	assert.equal(exit, 0, `${argv.join(" ")}\n${stdout}\n${stderr}`);
	return stdout + stderr;
}
async function put(file: string, content: string): Promise<void> {
	await Bun.write(path.join(fixture, file), content);
}
function testSource(name: string, relative: string): string {
	return `import { test, expect } from "bun:test"; import { appendFileSync } from "node:fs"; import { value } from ${JSON.stringify(relative)}; test(${JSON.stringify(name)}, () => { expect(value).toBe(2); appendFileSync(process.env.SCOPE_SMOKE_LOG!, ${JSON.stringify(`${name}\n`)}); });`;
}
try {
	for (const file of ["scripts/fulltest.ts", "scripts/ci-test-ts.ts", "scripts/windows-test-temp.ts"]) {
		await Bun.write(path.join(fixture, file), Bun.file(path.join(repo, file)));
	}
	await put("package.json", JSON.stringify({ workspaces: { packages: ["packages/*"] } }));
	await put("packages/leaf/package.json", JSON.stringify({ name: "leaf", type: "module" }));
	await put("packages/unrelated/package.json", JSON.stringify({ name: "unrelated", type: "module" }));
	await put("packages/leaf/src/main.ts", "export const value = 1;\n");
	await put("packages/leaf/test/plain.test.ts", testSource("unchanged-test", "../src/main"));
	await put("packages/leaf/src/main.test.ts", testSource("colocated-test", "./main"));
	await put(
		"packages/unrelated/test/fail.test.ts",
		'import { test, expect } from "bun:test"; test("must not run", () => expect(true).toBe(false));',
	);
	await run(["git", "init", "--quiet"]);
	await run(["git", "add", "."]);
	await run([
		"git",
		"-c",
		"user.name=Scope Smoke",
		"-c",
		"user.email=smoke@example.invalid",
		"commit",
		"--quiet",
		"-m",
		"fixture baseline",
	]);
	await run(["git", "branch", "upstream"]);
	await put("packages/leaf/src/main.ts", "export const value = 2;\n");
	await put("packages/leaf/test/new.spec.ts", testSource("untracked-spec", "../src/main"));
	const plan = await run([process.execPath, "scripts/fulltest.ts", "--dry-run"]);
	assert.match(plan, /TS modules=packages\/leaf;/);
	assert.doesNotMatch(plan, /==> (?:rust\/|ui\/|scripts|build\/)/);
	assert.match(plan, /plain\.test\.ts/);
	assert.match(plan, /main\.test\.ts/);
	assert.match(plan, /new\.spec\.ts/);
	console.log(
		"Public fulltest plan: source-only change + untracked spec select all leaf tests, no unrelated module/build/Rust/UI/scripts.",
	);
	const execution = await run(
		[process.execPath, "scripts/ci-test-ts.ts", "affected", '--packages=["packages/leaf"]'],
		{ ...process.env, SCOPE_SMOKE_LOG: log, OMP_TEST_SHARD: "1/10", OMP_TEST_CONCURRENCY: "1" },
	);
	assert.deepEqual(
		(await Bun.file(log).text()).trim().split("\n").sort(),
		["unchanged-test", "colocated-test", "untracked-spec"].sort(),
	);
	console.log(execution);
	console.log("PASS: all three selected tests executed despite shard env; untouched failing module skipped.");
} finally {
	await fs.rm(fixture, { recursive: true, force: true });
}
