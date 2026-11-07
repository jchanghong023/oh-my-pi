import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closePublicWorkbenches, WorkbenchFixture } from "../dev-workbench/fixture";
import { contentText, rolePayload } from "./provider-fixture";
afterEach(closePublicWorkbenches);

test("Back invalidates downstream decisions but preserves implementation and does not start background work", async () => {
	await using fixture = await WorkbenchFixture.create();
	await fixture.start();
	const executing = await fixture.developUntil("executing");
	const id = executing.record.requirementId;
	const source = await fs.readFile(path.join(fixture.cwd, "src/greeting.ts"), "utf8");
	const before = fixture.provider.requests.length;
	const result = await fixture.act(executing, { kind: "back" });
	expect(result.snapshot.record.stage).toBe("planning");
	expect(result.snapshot.record.decisions.map(decision => decision.stage)).toEqual([
		"business",
		"requirements",
		"solution",
	]);
	expect(await fs.readFile(path.join(fixture.cwd, "src/greeting.ts"), "utf8")).toBe(source);
	expect(fixture.provider.requests).toHaveLength(before);
	expect((await fixture.get(id)).runtime?.execution).not.toBe("running");
}, 180_000);

test("stage entry keeps Goal opt-in and handoff contains original material bytes and raw decisions", async () => {
	await using fixture = await WorkbenchFixture.create();
	await fixture.start();
	const snapshot = await fixture.developUntil("executing");
	const request = fixture.provider.requests.findLast(request => rolePayload(request)?.specDrivenRole === "executor");
	if (!request) throw new Error("Native executor request missing");
	const input = rolePayload(request)!.input;
	const files = input.files as Array<{ path: string; content: string }>;
	expect(files.length).toBeGreaterThan(0);
	for (const file of files) expect(file.content).toBe(await fs.readFile(path.join(fixture.cwd, file.path), "utf8"));
	expect(request.messages.map(message => contentText(message.content)).join("\n")).toContain(
		snapshot.record.decisions[0]!.userReply,
	);
	const goalCalls = fixture.provider.requests
		.flatMap(request => request.messages)
		.flatMap(message => message.tool_calls ?? [])
		.filter(call => typeof call === "object" && call !== null && JSON.stringify(call).includes('"name":"goal"'));
	expect(goalCalls).toEqual([]);
	expect(snapshot.record.marks).toEqual({});
}, 180_000);
