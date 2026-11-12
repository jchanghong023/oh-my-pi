import { expect, test } from "bun:test";
import { parseAIReqArgs } from "../../src/commands/aireq";
import { WorkflowConsumerFixture, WORKFLOW_ENTRY, WORKFLOW_MODEL } from "./workflow-fixture";

async function invoke(fixture: WorkflowConsumerFixture, args: string[]): Promise<{ code: number; text: string }> {
	const child = Bun.spawn([process.execPath, WORKFLOW_ENTRY, ...args], {
		cwd: fixture.project,
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

test("AIReq parser accepts launch configuration but never prompts, resumes, exports or enters old modes", () => {
	expect(parseAIReqArgs(["--cwd", ".", "--model", "deepseek/deepseek-v4-flash"])).toMatchObject({
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
		["--unknown-aireq-option"],
	])
		expect(() => parseAIReqArgs(args)).toThrow();
});

test("registered omp aireq help remains model-free and rejects retired commands before launch", async () => {
	await using fixture = await WorkflowConsumerFixture.create();
	const help = await invoke(fixture, ["aireq", "--help"]);
	expect(help.code).toBe(0);
	for (const command of ["new", "next", "drop", "business", "config"]) {
		const result = await invoke(fixture, ["aireq", command]);
		expect(result.code).not.toBe(0);
	}
	expect(fixture.provider.requests).toEqual([]);
}, 180_000);

test("tail profile and model flags reach the real registered command before lazy host startup", async () => {
	await using fixture = await WorkflowConsumerFixture.create();
	const process = await fixture.start(undefined, [
		"aireq",
		"--cwd",
		fixture.project,
		"--profile",
		"acceptance",
		"--model",
		WORKFLOW_MODEL,
	]);
	const view = await process.view();
	expect(view.groups).toEqual([]);
	expect(view.drafts).toEqual([]);
	expect(view.sessions).toEqual([]);
	expect(fixture.provider.requests).toEqual([]);
}, 180_000);
