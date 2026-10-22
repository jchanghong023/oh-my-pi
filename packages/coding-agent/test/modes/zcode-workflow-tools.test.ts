import { afterEach, describe, expect, it } from "bun:test";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "../../src/config/model-registry";
import type { AgentToolResult } from "../../src/extensibility/extensions/types";
import { ZCodeSessionManager, type ZCodeSessionRecord } from "../../src/modes/zcode/sessions";
import { ZCodeWorkflowService } from "../../src/modes/zcode/workflows/service";
import { createZCodeWorkflowTools } from "../../src/modes/zcode/workflows/tools";
import { serializeSavedWorkflow } from "../../src/modes/zcode/workflows/definitions";
import { toolResultDisplaySchema } from "../../src/modes/zcode/schema";
import { AgentStorage } from "../../src/session/agent-storage";
import { AuthStorage } from "../../src/session/auth-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "omp-workflow-tools-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	cleanup.push(async () => {
		HistoryStorage.close();
		closeSessionIndex();
		AgentStorage.close();
		closeModelCache();
	});
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(join(cwd, ".zcode", "workflows"), { recursive: true });
	const authStorage = await AuthStorage.create(":memory:");
	cleanup.push(async () => authStorage.close());
	const manager = new ZCodeSessionManager({
		cwd,
		agentDir,
		runtimeTools: () => tools,
		sessionOptions: {
			authStorage,
			modelRegistry: new ModelRegistry(authStorage),
			toolNames: ["CreateWorkflow", "ResumeWorkflowRun"],
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
			skills: [],
			customTools: [],
			extensions: [],
			disableExtensionDiscovery: true,
		},
	});
	cleanup.push(() => manager.dispose());
	const changed = new Set<() => void>();
	const service = new ZCodeWorkflowService({
		agentDir,
		manager,
		catalog: async () => [],
		onChange: () => {
			for (const listener of changed) listener();
		},
	});
	cleanup.push(() => service.dispose());
	const tools = createZCodeWorkflowTools({ record: () => record, service });
	const record: ZCodeSessionRecord = await manager.create();
	record.session.agent.appendMessage({
		role: "user",
		content: "Run workflow",
		timestamp: Date.now(),
		inputId: "delivered-input",
	});
	const call = async (name: string, input: unknown, signal?: AbortSignal) => {
		// Exercise the SDK-registered AgentTool and its CustomTool argument bridge;
		// directly invoking the factory callback hides a misplaced AbortSignal.
		const tool = record.session.agent.state.tools.find(tool => tool.name === name);
		if (!tool) throw new Error(`Missing registered tool ${name}`);
		return tool.execute("actual-tool-call", input as never, signal);
	};
	const waitFor = (runId: string, status: string) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const check = () => {
			if (service.getRun(record.id, runId).status === status) {
				changed.delete(check);
				resolve();
			}
		};
		changed.add(check);
		check();
		return promise;
	};
	return { cwd, service, record, tools, call, waitFor, changed };
}
function output(value: AgentToolResult<unknown>) {
	const text = value.content[0];
	if (text?.type !== "text") throw new Error("Expected workflow JSON output");
	return JSON.parse(text.text);
}

describe("native workflow tool execution", () => {
	it("executes the real compiler and sandbox with canonical tool/input references and display", async () => {
		const f = await fixture();
		expect(f.tools.map(tool => [tool.name, tool.approval])).toEqual([
			["CreateWorkflow", "write"],
			["ResumeWorkflowRun", "write"],
		]);
		const result = await f.call("CreateWorkflow", { name: "Native constant", script: "return 6 * 7;" });
		const launched = output(result);
		expect(launched).toMatchObject({ ok: true, status: "backgrounded" });
		expect(toolResultDisplaySchema.parse(result.details)).toEqual({
			kind: "create_workflow",
			ok: true,
			errorCount: 0,
			diagnostics: [],
		});
		await f.waitFor(launched.backgroundTaskId, "completed");
		expect(f.service.getRun(f.record.id, launched.backgroundTaskId)).toMatchObject({
			result: 42,
			parentSessionId: f.record.id,
			toolCallId: "actual-tool-call",
		});
		expect(f.service.getRunEvents(f.record.id, launched.backgroundTaskId).events).toContainEqual(
			expect.objectContaining({
				type: "run-launched",
				payload: expect.objectContaining({ inputId: "delivered-input" }),
			}),
		);
	});
	it("returns actual compiler diagnostics without creating a run and rejects ambiguous sources", async () => {
		const f = await fixture();
		const rejected = await f.call("CreateWorkflow", { script: 'const n: number = "bad"; return n;' });
		expect(output(rejected)).toMatchObject({
			ok: false,
			diagnostics: expect.arrayContaining([expect.objectContaining({ code: 2322 })]),
		});
		expect(toolResultDisplaySchema.parse(rejected.details)).toMatchObject({ kind: "create_workflow", ok: false });
		await expect(f.call("CreateWorkflow", { script: "return 1;", saved: { name: "ambiguous" } })).rejects.toThrow(
			"exactly one",
		);
		await expect(f.call("CreateWorkflow", { script: "return 1;", args: {} })).rejects.toThrow("args belongs");
		expect(f.service.listRuns(f.record.id).runs).toEqual([]);
	});
	it("loads actual saved and path scripts and enforces declared argument defaults and types", async () => {
		const f = await fixture();
		const path = join(f.cwd, ".zcode", "workflows", "typed.dwf.ts");
		await writeFile(
			path,
			serializeSavedWorkflow(
				{
					description: "Typed tool input",
					args: { count: { type: "number", required: true }, greeting: { type: "string", default: "hello" } },
				},
				"return args;",
			),
		);
		await expect(f.call("CreateWorkflow", { saved: { name: "typed", args: { count: "wrong" } } })).rejects.toThrow(
			"count",
		);
		for (const source of [{ saved: { name: "typed", args: { count: 3 } } }, { path, args: { count: 3 } }]) {
			const runId = output(await f.call("CreateWorkflow", source)).backgroundTaskId;
			await f.waitFor(runId, "completed");
			expect(f.service.getRun(f.record.id, runId).result).toEqual({ count: 3, greeting: "hello" });
		}
	});
	it("cancels during real admission, drains the owned run, and resumes its same journal identity", async () => {
		const f = await fixture();
		const controller = new AbortController();
		const abortAdmission = () => controller.abort();
		f.changed.add(abortAdmission);
		await expect(f.call("CreateWorkflow", { script: "while (true) {}" }, controller.signal)).rejects.toThrow();
		f.changed.delete(abortAdmission);
		const run = f.service.listRuns(f.record.id).runs[0];
		expect(run).toBeDefined();
		expect(f.service.getRun(f.record.id, run!.runId).status).toBe("stopped");
		const resumed = output(await f.call("ResumeWorkflowRun", { run_id: run!.runId }));
		expect(resumed).toMatchObject({ ok: true, runId: run!.runId, backgroundTaskId: run!.runId });
		await f.service.cancel(f.record.id, run!.runId);
		expect(f.service.listRuns(f.record.id).runs).toHaveLength(1);
		expect(f.service.getRun(f.record.id, run!.runId).status).toBe("stopped");
		const other = await f.service.prepareScript({ cwd: f.cwd, script: "return 1;" });
		expect(other.ok).toBe(true);
	});
	it("never launches pre-cancelled calls and rejects completed or foreign run resumes", async () => {
		const f = await fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(f.call("CreateWorkflow", { script: "return 1;" }, controller.signal)).rejects.toThrow();
		expect(f.service.listRuns(f.record.id).runs).toEqual([]);
		const runId = output(await f.call("CreateWorkflow", { script: "return 1;" })).backgroundTaskId;
		await f.waitFor(runId, "completed");
		await expect(f.call("ResumeWorkflowRun", { run_id: runId })).rejects.toThrow();
		await expect(f.call("ResumeWorkflowRun", { run_id: "foreign-run" })).rejects.toThrow("does not belong");
	});
});
