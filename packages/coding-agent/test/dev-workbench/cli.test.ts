import { afterEach, expect, test } from "bun:test";
import { parseDevArgs } from "../../src/commands/dev";
import { closePublicWorkbenches, SOURCE_ENTRY, WorkbenchFixture } from "./fixture";
afterEach(closePublicWorkbenches);

async function invoke(fixture: WorkbenchFixture, args: string[]): Promise<{ code: number; text: string }> {
	const child = Bun.spawn([process.execPath, SOURCE_ENTRY, ...args], {
		cwd: fixture.cwd,
		env: fixture.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, text: Bun.stripANSI(`${stdout}\n${stderr}`) };
	} finally {
		if (child.exitCode === null) child.kill();
		await child.exited;
	}
}

test("Dev parser accepts launch configuration but never prompts, resumes, exports or enters old modes", () => {
	expect(parseDevArgs(["--cwd", ".", "--model", "deepseek/deepseek-v4-flash"])).toMatchObject({
		cwd: ".",
		model: "deepseek/deepseek-v4-flash",
		messages: [],
	});
	for (const args of [
		["new"],
		["business"],
		["finish-business"],
		["next"],
		["back"],
		["drop"],
		["config"],
		["--mode", "rpc"],
		["--print"],
		["--resume"],
		["--join", "someone"],
		["--unknown-dev-option"],
	])
		expect(() => parseDevArgs(args)).toThrow();
});

test("registered omp dev help describes browser launch and rejects old commands without model side effects", async () => {
	await using fixture = await WorkbenchFixture.create();
	const help = await invoke(fixture, ["dev", "--help"]);
	expect(help.code).toBe(0);
	expect(help.text).toMatch(/browser|workbench|浏览器|工作台/iu);
	expect(help.text).toContain("--profile");
	expect(help.text).not.toContain("finish-business");
	for (const command of ["new", "next", "drop", "business", "config"]) {
		const result = await invoke(fixture, ["dev", command]);
		expect(result.code).not.toBe(0);
		expect(result.text).toMatch(/browser|workbench|subcommand|浏览器|工作台/iu);
	}
	expect(fixture.provider.requests).toEqual([]);
}, 180_000);

test("tail profile and model flags reach the real registered command before lazy host startup", async () => {
	await using fixture = await WorkbenchFixture.create();
	await fixture.start(undefined, ["--profile", "default", "--model", "deepseek/deepseek-v4-flash"]);
	expect(await fixture.list()).toEqual([]);
	expect(fixture.provider.requests).toEqual([]);
}, 180_000);
