import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	LegacyProtocol,
	v4ConversationRowsRangeResultSchema,
	v4ConversationWorkflowRunsResultSchema,
	v4ConversationWorkflowRunArtifactsResultSchema,
	v4ConversationWorkflowRunArtifactReadResultSchema,
} from "../../src/modes/zcode/schema";
import {
	completed,
	create,
	definition,
	disposeWorkflowPeers,
	fixture,
	savedRuns,
	start,
	WorkflowPeer,
} from "./zcode-workflow-process-helpers";

afterEach(disposeWorkflowPeers);

describe("ZCode saved workflows through actual app-server process", () => {
	test("real sandbox publishes markdown, launch rows and durable history survive app-server reopen", async () => {
		await using root = TempDir.createSync("@zcode-workflow-sandbox-");
		await using config = await fixture(root);
		const name = "constant-artifact";
		const markdown = "# Real workflow\n\n持久化产物。\n";
		const script = `await artifact.markdown("proof", ${JSON.stringify(markdown)});\nreturn { ok: true, topic: args.topic };\n`;
		const file = path.join(config.projectDir, `${name}.dwf.ts`);
		await fs.writeFile(file, definition(script));
		let sessionId: string;
		let runId: string;
		let toolCallId: string;
		{
			await using peer = new WorkflowPeer(config.cwd, config.env);
			await peer.ready.promise;
			sessionId = await create(peer, config.workspace);
			const ack = await start(peer, sessionId, name, { topic: "sandbox proof" });
			if (ack.result?.type !== "startSavedWorkflow") {
				throw new Error(`Missing canonical launch references: ${JSON.stringify(ack)}`);
			}
			// Bun's nested asymmetric matcher replaces these ACK fields in place.
			// Retain the actual wire references before asserting the complete ACK shape.
			runId = ack.result.runId;
			toolCallId = ack.result.toolCallId;
			expect(ack).toMatchObject({
				status: "accepted",
				result: { type: "startSavedWorkflow", runId: expect.any(String), toolCallId: expect.any(String) },
			});
			const run = await completed(peer, config.workspace, name, runId);
			expect(run).toMatchObject({
				parentSessionId: sessionId,
				toolCallId,
				cwd: config.cwd,
				args: { topic: "sandbox proof" },
			});
			const rows = v4ConversationRowsRangeResultSchema.parse(
				await peer.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
			);
			expect(JSON.stringify(rows)).toContain(runId);
			expect(JSON.stringify(rows)).toContain(toolCallId);
			expect(rows.rows.filter(row => row.kind === "userInput" && row.origin === "realUser")).toEqual([]);
			expect(rows.rows).toContainEqual(
				expect.objectContaining({
					kind: "userInput",
					origin: "workflowLaunch",
					workflowLaunch: expect.objectContaining({ runId }),
				}),
			);
			await peer.close();
		}
		await using cold = new WorkflowPeer(config.cwd, config.env);
		await cold.ready.promise;
		expect(JSON.stringify(await cold.request("session/list", { workspace: config.workspace }))).toContain(sessionId);
		const runs = await savedRuns(cold, config.workspace, name);
		expect(runs.runs).toContainEqual(
			expect.objectContaining({ runId, status: "completed", parentSessionId: sessionId }),
		);
		const sessionRuns = v4ConversationWorkflowRunsResultSchema.parse(
			await cold.request("v4/conversation/workflowRuns", { sessionId, limit: 10 }),
		);
		expect(sessionRuns.runs).toContainEqual(expect.objectContaining({ runId, status: "completed" }));
		const artifacts = v4ConversationWorkflowRunArtifactsResultSchema.parse(
			await cold.request("v4/conversation/workflowRunArtifacts", { sessionId, runId }),
		);
		expect(artifacts.artifacts).toContainEqual(
			expect.objectContaining({ id: "proof", kind: "markdown", version: 1 }),
		);
		const content = v4ConversationWorkflowRunArtifactReadResultSchema.parse(
			await cold.request("v4/conversation/workflowRunArtifactRead", {
				sessionId,
				runId,
				artifactId: "proof",
				version: 1,
				offset: 0,
				limit: 4096,
			}),
		);
		expect(Buffer.from(content.dataBase64, "base64").toString("utf8")).toBe(markdown);
		expect(content.totalBytes).toBe(Buffer.byteLength(markdown));
		expect(content.nextOffset).toBeNull();
		await cold.request("workflows/delete", { workspace: config.workspace, name });
		expect(
			LegacyProtocol.zcodeWorkflowsForRunResultSchema.parse(
				await cold.request("workflows/forRun", { workspace: config.workspace, runId }),
			).entry,
		).toBeUndefined();
		expect(
			LegacyProtocol.zcodeWorkflowsSaveResultSchema.parse(
				await cold.request("workflows/save", {
					workspace: config.workspace,
					runId,
					name,
					meta: { description: "Saved actual run" },
				}),
			),
		).toMatchObject({ ok: true, path: file, overwritten: false });
		const saved = LegacyProtocol.zcodeWorkflowsGetResultSchema.parse(
			await cold.request("workflows/get", { workspace: config.workspace, name }),
		);
		expect(saved).toMatchObject({ ok: true, script });
		expect((await fs.readFile(file, "utf8")).endsWith(`*/\n${script}`)).toBe(true);
		const reopened = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await cold.request("session/resume", { sessionId }),
		);
		expect(reopened.session.sessionId).toBe(sessionId);
		const rows = v4ConversationRowsRangeResultSchema.parse(
			await cold.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
		);
		expect(JSON.stringify(rows)).toContain(runId);
		expect(config.requests).toEqual([]);
		await cold.close();
	}, 120_000);
});
