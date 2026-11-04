import { afterEach, describe, expect, it } from "bun:test";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "../../src/config/model-registry";
import { ZCodeSessionManager } from "../../src/modes/zcode/sessions";
import { ZCodeWorkflowService } from "../../src/modes/zcode/workflows/service";
import { serializeSavedWorkflow } from "../../src/modes/zcode/workflows/definitions";
import { AuthStorage } from "../../src/session/auth-storage";
import type { ZCodeSavedWorkflowMeta } from "../../src/modes/zcode/schema/vendor/zcode-protocol/index";
import { workflowRunsStateSchema } from "../../src/modes/zcode/schema/vendor/zcode-protocol-v4/workflow-runs";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "omp-workflow-service-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	cleanup.push(async () => {
		// Settings/SDK storage is process-owned, not closed by an individual session.
		// Release the same singleton owners as the workflow-driver/tools fixtures
		// before removing this fixture's directories on Windows.
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
	const modelRegistry = new ModelRegistry(authStorage);
	const manager = new ZCodeSessionManager({
		cwd,
		agentDir,
		sessionOptions: {
			authStorage,
			modelRegistry,
			toolNames: [],
			restrictToolNames: true,
			skills: [],
			customTools: [],
			extensions: [],
			disableExtensionDiscovery: true,
		},
	});
	cleanup.push(() => manager.dispose());
	const service = new ZCodeWorkflowService({ agentDir, manager, catalog: async () => [] });
	cleanup.push(() => service.dispose());
	async function definition(
		name: string,
		script: string,
		meta: ZCodeSavedWorkflowMeta = { description: "Service regression" },
	) {
		await writeFile(join(cwd, ".zcode", "workflows", `${name}.dwf.ts`), serializeSavedWorkflow(meta, script));
	}
	return { root, cwd, agentDir, manager, service, definition };
}

describe("native saved workflow preflight", () => {
	it("rejects real TypeScript diagnostics before materializing any parent or run", async () => {
		const { cwd, manager, service, definition } = await fixture();
		await definition("broken", 'const n: number = "bad"; return n;');
		const result = await service.prepareSaved({ cwd, name: "broken" });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected compile rejection");
		expect(result.reason).toBe("compile_failed");
		expect(result.message).toContain("2322");
		expect(await manager.list()).toEqual([]);
		expect(service.journal.listRuns({ cwd, limit: 10 })).toEqual([]);
	});
	it("reports the actual unresolved model name as 9011 without creating a session", async () => {
		const { cwd, manager, service, definition } = await fixture();
		await definition("model", 'agent("judge", { model: "missing-native-model" }); return 1;');
		const result = await service.prepareSaved({ cwd, name: "model" });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected named-model rejection");
		expect(result.reason).toBe("compile_failed");
		expect(result.message).toContain("9011");
		expect(result.message).toContain("missing-native-model");
		expect(await manager.list()).toEqual([]);
		expect(service.journal.listRuns({ cwd, limit: 10 })).toEqual([]);
	});
	it("checks required and typed args and injects declared defaults before admission", async () => {
		const { cwd, manager, service, definition } = await fixture();
		await definition("args", "return args;", {
			description: "Argument contract",
			args: {
				count: { type: "number", required: true },
				greeting: { type: "string", default: "hello" },
			},
		});
		const rejected = await service.prepareSaved({ cwd, name: "args", args: { count: "three" } });
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("Expected args rejection");
		expect(rejected.reason).toBe("invalid_args");
		expect(rejected.message).toContain("count");
		const accepted = await service.prepareSaved({ cwd, name: "args", args: { count: 3 } });
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) throw new Error(accepted.message);
		expect(accepted.prepared.args).toEqual({ count: 3, greeting: "hello" });
		expect(await manager.list()).toEqual([]);
	});
	it("reconstructs completed runs from journal after disposal without an active execution registry", async () => {
		const { cwd, agentDir, manager, service } = await fixture();
		service.journal.createRun({
			runId: "recorded",
			parentSessionId: "parent",
			cwd,
			name: "recorded",
			scriptText: "return 42;",
			caps: { maxConcurrency: 1 },
			spentTokens: 0,
			status: "pending",
		});
		service.journal.appendEvent("recorded", { type: "run-started", runId: "recorded", caps: { maxConcurrency: 1 } });
		service.journal.updateRunStatus("recorded", "completed", { result: 42 });
		service.journal.appendEvent("recorded", { type: "run-settled", status: "completed" });
		await service.dispose();
		const reopened = new ZCodeWorkflowService({ agentDir, manager, catalog: async () => [] });
		cleanup.push(() => reopened.dispose());
		const projection = workflowRunsStateSchema.parse(reopened.projection("parent").workflowRuns);
		expect(projection.runs.find(run => run.runId === "recorded")?.status).toBe("completed");
		expect(reopened.projection("unrelated").workflowRuns.runs).toEqual([]);
		expect(() => reopened.getRun("unrelated", "recorded")).toThrow("does not belong");
		expect(reopened.listRuns("parent").runs[0]?.resumable).toBe(false);
	});
	it("reads scoped named history with durable artifact summaries and a true extra-row truncation flag", async () => {
		const { cwd, service } = await fixture();
		for (const [runId, workspace, name] of [
			["older", cwd, "saved"],
			["other-project", `${cwd}-other`, "saved"],
			["different-name", cwd, "different"],
			["latest", cwd, "saved"],
		])
			service.journal.createRun({
				runId: runId!,
				cwd: workspace!,
				name,
				parentSessionId: "parent",
				toolCallId: `tool-${runId}`,
				caps: { maxConcurrency: 1 },
				spentTokens: 0,
				status: "completed",
				args: { count: 2 },
			});
		service.journal.putNode({
			runId: "latest",
			siteId: "artifact#1",
			ordinal: 1,
			kind: "artifact",
			inputHash: "published-artifact",
			status: "completed",
			artifactId: "report",
			result: {
				id: "report",
				kind: "markdown",
				version: 1,
				title: "Report",
				contentType: "text/markdown",
				uri: "artifact://0",
				bytes: 8,
				publishedAt: 10,
			},
		});
		const project = service.runs({ workspace: { workspacePath: cwd, workspaceKey: cwd }, name: "saved", limit: 1 });
		expect(project.truncated).toBe(true);
		expect(project.runs).toEqual([
			{
				runId: "latest",
				name: "saved",
				cwd,
				parentSessionId: "parent",
				toolCallId: "tool-latest",
				status: "completed",
				spentTokens: 0,
				args: { count: 2 },
				createdAt: expect.any(Number),
				updatedAt: expect.any(Number),
				artifacts: [{ id: "report", kind: "markdown", version: 1, title: "Report", contentType: "text/markdown" }],
			},
		]);
		const global = service.runs({
			workspace: { workspacePath: cwd, workspaceKey: cwd },
			name: "saved",
			scope: "global",
			limit: 50,
		});
		expect(global.runs.map(run => run.runId)).toEqual(["latest", "other-project", "older"]);
		expect(global.truncated).toBeUndefined();
		expect(
			service.runs({ workspace: { workspacePath: `${cwd}-absent`, workspaceKey: `${cwd}-absent` }, limit: 50 }),
		).toEqual({ runs: [] });
	});
	it("reads cold workflow artifact bytes without activating the parent runtime or acquiring its write lease", async () => {
		const { manager, service, cwd } = await fixture();
		const parent = await manager.create();
		const native = parent.session.sessionManager;
		const artifact = await native.allocateArtifactPath("workflow-md");
		if (!artifact.id || !artifact.path) throw new Error("Missing native artifact allocation");
		const content = "# Cold artifact\n只读历史，不恢复执行。\n";
		await writeFile(artifact.path, content);
		service.journal.createRun({
			runId: "cold-artifact",
			parentSessionId: parent.id,
			cwd,
			status: "completed",
			caps: { maxConcurrency: 1 },
			spentTokens: 0,
		});
		service.journal.putNode({
			runId: "cold-artifact",
			siteId: "report",
			ordinal: 0,
			kind: "artifact",
			artifactId: "report",
			inputHash: "cold-artifact",
			status: "completed",
			result: {
				id: "report",
				kind: "markdown",
				version: 1,
				uri: `artifact://${artifact.id}`,
				contentType: "text/markdown",
				bytes: Buffer.byteLength(content),
				publishedAt: 1,
			},
		});
		await manager.close(parent.id);
		expect(manager.get(parent.id)).toBeUndefined();
		const before = await manager.readEntries(parent.id);
		const result = await service.artifactRead({
			sessionId: parent.id,
			runId: "cold-artifact",
			artifactId: "report",
			version: 1,
			offset: 0,
			limit: 4096,
		});
		expect(result).toEqual({
			dataBase64: Buffer.from(content).toString("base64"),
			mediaType: "text/markdown",
			totalBytes: Buffer.byteLength(content),
			nextOffset: null,
		});
		expect(manager.get(parent.id)).toBeUndefined();
		expect(await manager.readEntries(parent.id)).toEqual(before);
	});
});

describe("workflow mutation admission", () => {
	it("preflights missing actor boundaries before changing a predecessor or creating a successor", async () => {
		const { manager, service, cwd } = await fixture();
		const parent = await manager.create();
		service.journal.createRun({
			runId: "missing-boundary",
			parentSessionId: parent.id,
			cwd,
			scriptText: "return 1;",
			status: "running",
			caps: { maxConcurrency: 1 },
			spentTokens: 0,
		});
		service.journal.putNode({
			runId: "missing-boundary",
			siteId: "ask",
			ordinal: 0,
			kind: "ask",
			actorSiteId: "actor",
			actorOrdinal: 0,
			actorSeq: 0,
			inputHash: "ask",
			status: "completed",
			result: "committed answer",
		});
		const before = service.getRun(parent.id, "missing-boundary");
		await expect(service.amend(parent, { workId: "missing-boundary", maxConcurrency: 2 })).rejects.toMatchObject({
			reason: "missing_boundaries",
		});
		expect(service.getRun(parent.id, "missing-boundary")).toEqual(before);
		expect(service.listRuns(parent.id).runs.map(run => run.runId)).toEqual(["missing-boundary"]);
	});

	it("makes amend and resume mutually exclusive and releases the mutation after an unchanged rejection", async () => {
		const { manager, service, cwd } = await fixture();
		const parent = await manager.create();
		service.journal.createRun({
			runId: "unchanged",
			parentSessionId: parent.id,
			cwd,
			scriptText: "return 1;",
			status: "stopped",
			stopReason: "user",
			caps: { maxConcurrency: 3 },
			spentTokens: 0,
		});
		const first = service.amend(parent, { workId: "unchanged", maxConcurrency: 3 });
		await expect(service.resume(parent, "unchanged")).rejects.toThrow("control is busy");
		await expect(first).rejects.toMatchObject({ reason: "unchanged" });
		await expect(service.amend(parent, { workId: "unchanged", maxConcurrency: 3 })).rejects.toMatchObject({
			reason: "unchanged",
		});
		expect(service.listRuns(parent.id).runs.map(run => run.runId)).toEqual(["unchanged"]);
		expect(service.getRun(parent.id, "unchanged")).toMatchObject({ status: "stopped", caps: { maxConcurrency: 3 } });
	});
});

describe("workflow successor settings", () => {
	it("amends an ended run into a distinct successor retaining script, args and spent tokens without rewriting its predecessor", async () => {
		const { manager, service, cwd } = await fixture();
		const parent = await manager.create();
		const scriptText = "return args;";
		const args = { marker: "retained native input" };
		service.journal.createRun({
			runId: "ended",
			parentSessionId: parent.id,
			cwd,
			scriptText,
			args,
			status: "stopped",
			stopReason: "user",
			caps: { maxConcurrency: 3 },
			spentTokens: 17,
		});
		const predecessor = service.getRun(parent.id, "ended");
		const successor = await service.amend(parent, { workId: "ended", maxConcurrency: 4 });
		expect(successor.runId).not.toBe("ended");
		expect(successor.launch.amend).toMatchObject({ predecessorRunId: "ended" });
		expect(service.getRun(parent.id, successor.runId)).toMatchObject({
			parentSessionId: parent.id,
			scriptText,
			args,
			caps: { maxConcurrency: 4 },
			spentTokens: 17,
			resumedFrom: "ended",
		});
		expect(service.getRun(parent.id, "ended")).toEqual(predecessor);
		expect(new Set(service.listRuns(parent.id).runs.map(run => run.runId))).toEqual(
			new Set(["ended", successor.runId]),
		);
		await service.cancel(parent.id, successor.runId);
	});
});

describe("workflow default and live caps", () => {
	it("uses the OS concurrency ceiling and durably records only effective live cap changes", async () => {
		const { manager, service, cwd } = await fixture();
		const parent = await manager.create();
		const prepared = await service.prepareScript({ cwd, script: "return 1;" });
		if (!prepared.ok) throw new Error(prepared.message);
		const started = await service.start(parent, prepared.prepared);
		const ceiling = Math.max(1, availableParallelism());
		expect(service.getRun(parent.id, started.runId).caps).toEqual({ maxConcurrency: ceiling });
		expect(service.control(parent.id, started.runId, { maxConcurrency: ceiling + 1 })).toEqual({
			changed: true,
			maxConcurrency: ceiling + 1,
		});
		expect(service.control(parent.id, started.runId, { maxConcurrency: 1 })).toEqual({
			changed: true,
			maxConcurrency: 1,
		});
		expect(service.control(parent.id, started.runId, { maxConcurrency: 1 })).toEqual({
			changed: false,
			maxConcurrency: 1,
		});
		const changes = service.journal.getEvents(started.runId, { types: ["run-caps-changed"], reportItems: "all" });
		expect(changes.map(row => row.event)).toEqual([
			{
				type: "run-caps-changed",
				runId: started.runId,
				caps: { maxConcurrency: ceiling + 1 },
				previous: { maxConcurrency: ceiling },
			},
			{
				type: "run-caps-changed",
				runId: started.runId,
				caps: { maxConcurrency: 1 },
				previous: { maxConcurrency: ceiling + 1 },
			},
		]);
		expect(service.getRun(parent.id, started.runId).caps).toEqual({ maxConcurrency: 1 });
		await service.cancel(parent.id, started.runId);
	});
});
