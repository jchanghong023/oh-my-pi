import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { workflowNativeContext } from "../aireq-workbench/workflow-fixture";
import { createWorkflowStage } from "./tui-materials-cases";

test("executor receives frozen whole-group bytes and explicit decisions while Goal remains opt-in", async () => {
	const { fixture, srId, view } = await createWorkflowStage("executing");
	await using owned = fixture;
	const sr = view.srs.find(item => item.id === srId)!;
	const request = fixture.provider.requests.findLast(request => workflowNativeContext(request)?.role === "executor");
	if (!request) throw new Error("Real native executor request missing");
	const context = workflowNativeContext(request)!;
	const authority = context.authority as { files: { path: string; content: string }[] };
	expect(authority.files.length).toBeGreaterThan(1);
	for (const file of authority.files)
		expect(file.content).toBe(await fs.readFile(path.join(sr.worktree!.path, file.path), "utf8"));
	const contextFiles = context.contextFiles as { path: string; content: string }[];
	for (const material of sr.materials.filter(
		material => material.valid && ["solution", "planning"].includes(material.stage),
	)) {
		const supplied = contextFiles.find(file => file.path === material.path);
		expect(supplied?.content).toBe(await fs.readFile(path.join(sr.worktree!.path, material.path), "utf8"));
	}
	const decisions = JSON.stringify(context.decisions);
	for (const approval of sr.approvals) expect(decisions).toContain(approval.operationId);
	const goalCalls = fixture.provider.requests
		.flatMap(request => request.messages)
		.flatMap(message => message.tool_calls ?? [])
		.filter(
			call =>
				isRecord(call) &&
				isRecord(call.function) &&
				typeof call.function.name === "string" &&
				call.function.name.replace(/^_/u, "") === "goal",
		);
	expect(goalCalls).toEqual([]);
}, 240_000);
