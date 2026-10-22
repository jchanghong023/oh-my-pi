import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ZCodeQueries, type ZCodeQueryContext } from "../../src/modes/zcode/queries";
import { ZCodeProjection } from "../../src/modes/zcode/projection";
import type { ZCodeSessionRecord } from "../../src/modes/zcode/sessions";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const usage = {
	input: 10,
	output: 3,
	cacheRead: 4,
	cacheWrite: 2,
	totalTokens: 19,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
async function fixture(messages: Record<string, unknown>[], extra: Record<string, unknown>[] = []) {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "omp-zcode-queries-"));
	directories.push(cwd);
	const file = path.join(cwd, "session.jsonl");
	const entries = messages.map((message, index) => ({
		type: "message",
		id: `entry-${index}`,
		parentId: index ? `entry-${index - 1}` : null,
		timestamp: new Date(Number(message.timestamp)).toISOString(),
		message,
	}));
	await writeFile(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "session", timestamp: new Date(0).toISOString(), cwd }),
			...entries.map(entry => JSON.stringify(entry)),
			...extra.map(entry => JSON.stringify(entry)),
		].join("\n") + "\n",
	);
	const projection = new ZCodeProjection({
		sessionId: "session",
		cwd,
		messages: messages as unknown as AgentMessage[],
		logEpoch: "epoch",
	});
	let activations = 0;
	const manager = {
		get: () => undefined,
		list: async () => [{ id: "session" }],
		read: async (id: string) => {
			if (id !== "session") throw new Error("Session not found");
			return { id, cwd, messages: messages as unknown as AgentMessage[], info: { path: file } };
		},
		resume: () => {
			activations++;
			throw new Error("must not activate");
		},
	} as unknown as ZCodeQueryContext["manager"];
	const journal: Record<string, unknown>[] = [...entries];
	const activeRecord = {
		cwd,
		session: {
			sessionManager: {
				getEntries: () => journal,
				getBranch: () => journal,
				appendCustomEntry: (customType: string, data: unknown) => {
					const id = `receipt-${journal.length}`;
					journal.push({ type: "custom", id, customType, data });
					return id;
				},
				flush: async () => {},
			},
		},
		run: <T>(fn: () => T) => fn(),
	} as unknown as ZCodeSessionRecord;
	return {
		cwd,
		projection,
		manager,
		queries: new ZCodeQueries({ manager, getProjection: () => projection }),
		activations: () => activations,
		host: () => {
			manager.get = () => activeRecord;
			projection.resolveTarget = target => ({
				entryId: "entry-0",
				message: messages[0] as unknown as AgentMessage,
				messageIndex: 0,
				row: projection.rows().find(row => row.entityId === target.entityId)!,
			});
		},
	};
}
describe("ZCode business read queries", () => {
	test("cold accounting includes persisted off-transcript usage without runtime activation", async () => {
		const at = Date.now();
		const f = await fixture(
			[{ role: "assistant", content: [], timestamp: at, model: "m", provider: "p", usage, stopReason: "stop" }],
			[
				{
					type: "model_usage",
					id: "warm",
					parentId: "entry-0",
					timestamp: new Date(at).toISOString(),
					purpose: "cache-warm",
					api: "openai",
					provider: "p",
					model: "m",
					usage,
					stopReason: "stop",
					activeLeafId: "entry-0",
				},
			],
		);
		const result = await f.queries.conversationUsage({ sessionId: "session" });
		expect(result.totalTokens).toBe(38);
		expect(result.modelRequestCount).toBe(2);
		expect(f.activations()).toBe(0);
	});
	test("cold projection uses persisted selection and actual child session identities", async () => {
		const at = Date.now(),
			timestamp = new Date(at).toISOString();
		const f = await fixture(
			[{ role: "assistant", content: [], timestamp: at, model: "old", provider: "old", usage, stopReason: "stop" }],
			[
				{
					type: "model_change",
					id: "model",
					parentId: "entry-0",
					timestamp,
					role: "default",
					model: "chosen/new-model",
				},
				{ type: "thinking_level_change", id: "thought", parentId: "model", timestamp, thinkingLevel: "high" },
			],
		);
		const childrenDir = path.join(f.cwd, "session");
		await mkdir(childrenDir);
		await writeFile(
			path.join(childrenDir, "AgentName.jsonl"),
			JSON.stringify({
				type: "session",
				version: 3,
				id: "actual-child-session",
				timestamp,
				cwd: f.cwd,
				parentSession: path.join(f.cwd, "session.jsonl"),
			}) + "\n",
		);
		const state = await f.queries.projectionState("session");
		expect(state.config?.provider).toBe("chosen");
		expect(state.config?.model).toBe("new-model");
		expect(state.config?.thought).toBe("high");
		expect(state.subagents?.childSessionIds).toEqual(["actual-child-session"]);
		expect(state.subagents?.running).toEqual([]);
		expect(state.usage?.cumulative.inputTokens).toBe(10);
		expect(f.activations()).toBe(0);
	});
	test("cold projection normalizes saved reasoning and consumes declared choices without activation", async () => {
		const timestamp = new Date().toISOString();
		const f = await fixture(
			[],
			[
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp,
					role: "default",
					model: "chosen/new-model",
				},
				{ type: "thinking_level_change", id: "thought", parentId: "model", timestamp, thinkingLevel: "off" },
			],
		);
		const requests: string[][] = [];
		const queries = new ZCodeQueries({
			manager: f.manager,
			getProjection: () => undefined,
			reasoning: async (provider, model, level) => {
				requests.push([provider, model, level]);
				return { thought: "disabled", thoughtLevels: ["disabled", "enabled"] };
			},
		});
		const state = await queries.projectionState("session");
		expect(requests).toEqual([["chosen", "new-model", "off"]]);
		expect(state.config).toMatchObject({
			provider: "chosen",
			model: "new-model",
			thought: "disabled",
			thoughtLevels: ["disabled", "enabled"],
		});
		expect((await f.queries.projectionState("session")).config?.thought).toBe("disabled");
		expect(f.activations()).toBe(0);
	});
	test("cold projection restores the accepted sparse model selection from its journal record", async () => {
		// 缺陷1:冷恢复的 sessionConfig.modelSelection 必须来自持久化的已接受意图
		// (zcode_model_selection custom entry),不是 effective provider/model/thought 伪造。
		const timestamp = new Date().toISOString();
		const f = await fixture(
			[],
			[
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp,
					role: "temporary",
					model: "omp-e2e/omp-alternate",
				},
				{ type: "thinking_level_change", id: "thought", parentId: "model", timestamp, thinkingLevel: "off" },
				{
					type: "custom",
					id: "selection",
					parentId: "thought",
					timestamp,
					customType: "zcode_model_selection",
					data: { providerId: "omp-e2e", modelId: "omp-alternate", options: { reasoningLevel: "disabled" } },
				},
			],
		);
		const state = await f.queries.projectionState("session");
		expect(state.config).toMatchObject({
			provider: "omp-e2e",
			model: "omp-alternate",
			modelSelection: { providerId: "omp-e2e", modelId: "omp-alternate", options: { reasoningLevel: "disabled" } },
		});
		expect(f.activations()).toBe(0);
	});
	test("usage range is based on message time in requested timezone, not session creation", async () => {
		const f = await fixture([
			{
				role: "assistant",
				content: [],
				timestamp: Date.now() - 40 * 86400000,
				model: "old",
				usage,
				stopReason: "stop",
			},
			{ role: "assistant", content: [], timestamp: Date.now(), model: "new", usage, stopReason: "stop" },
		]);
		const result = await f.queries.usageStats({ range: "7d", timeZone: "Pacific/Kiritimati" });
		expect(result.timeZone).toBe("Pacific/Kiritimati");
		expect(result.summary.totalTokens).toBe(19);
		expect(result.models.map(model => model.modelId)).toEqual(["new"]);
	});
	test("plans directory includes persisted proposals before the display tail", async () => {
		const at = Date.now();
		const messages: Record<string, unknown>[] = [
			{ role: "user", content: "plan", timestamp: at, inputId: "plan-input" },
			{
				role: "assistant",
				timestamp: at + 1,
				content: [
					{
						type: "toolCall",
						id: "plan-call",
						name: "write",
						arguments: { path: "xd://propose", content: "Plan" },
					},
				],
			},
			{
				role: "toolResult",
				timestamp: at + 2,
				toolCallId: "plan-call",
				toolName: "write",
				content: [{ type: "text", text: "Plan ready" }],
				details: {
					xdev: {
						tool: "propose",
						mode: "execute",
						inner: { planFilePath: "local://plan.md", title: "Plan", planExists: true },
					},
				},
			},
			...Array.from({ length: 100 }, (_, index) => ({
				role: "user",
				content: `later-${index}`,
				inputId: `later-${index}`,
				timestamp: at + 3 + index,
			})),
		];
		const f = await fixture(messages);
		const result = await f.queries.plans({ sessionId: "session" });
		expect(result.plans).toHaveLength(1);
		expect(result.plans[0].toolCallId).toBe("plan-call");
		expect(result.atLogEpoch).toBe("epoch");
		expect(f.activations()).toBe(0);
	});
	test("pruned checkpoints are unsafe, never an empty successful rewind", async () => {
		const at = Date.now();
		const f = await fixture([
			{ role: "user", content: "edit", timestamp: at, inputId: "input" },
			{
				role: "assistant",
				timestamp: at + 1,
				content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: {} }],
			},
			{
				role: "toolResult",
				timestamp: at + 2,
				toolCallId: "edit-1",
				toolName: "edit",
				content: [],
				details: { path: "a.txt", op: "update", snapshotsPruned: true, diff: "@@ -1 +1 @@\n-before\n+after\n" },
			},
		]);
		const row = f.projection.rows().find(row => row.kind === "turnHeader")!;
		const params = {
			sessionId: "session",
			target: { rowId: row.rowId, entityId: row.entityId },
			baseRevision: f.projection.snapshot().revision,
			baseLogEpoch: "epoch",
		};
		const changes = await f.queries.fileChanges(params);
		expect(changes.additions).toBe(1);
		expect(changes.deletions).toBe(1);
		const preview = await f.queries.fileRewindPreview(params);
		expect(preview.canApply).toBe(false);
		expect(preview.unsafeFiles[0].reason).toBe("checkpoint_missing");
	});
	test("file changes reflect edit preimages and preview rejects an external modification and stale entity", async () => {
		const at = Date.now();
		const f = await fixture([
			{ role: "user", content: "edit", timestamp: at, inputId: "input" },
			{
				role: "assistant",
				timestamp: at + 1,
				content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: {} }],
			},
			{
				role: "toolResult",
				timestamp: at + 2,
				toolCallId: "edit-1",
				toolName: "edit",
				content: [],
				details: { path: "a.txt", op: "update", oldText: "before\n", newText: "after\n", diff: "" },
			},
		]);
		await writeFile(path.join(f.cwd, "a.txt"), "after\n");
		const row = f.projection.rows().find(row => row.kind === "turnHeader")!;
		const params = {
			sessionId: "session",
			target: { rowId: row.rowId, entityId: row.entityId },
			baseRevision: f.projection.snapshot().revision,
			baseLogEpoch: "epoch",
		};
		const changes = await f.queries.fileChanges(params);
		expect(changes.files).toBe(1);
		expect(changes.additions).toBe(1);
		expect(changes.deletions).toBe(1);
		expect((await f.queries.fileRewindPreview(params)).safeFiles).toHaveLength(1);
		await writeFile(path.join(f.cwd, "a.txt"), "external\n");
		expect((await f.queries.fileRewindPreview(params)).unsafeFiles[0].reason).toBe("external_modified");
		await expect(
			f.queries.fileChanges({ ...params, target: { ...params.target, entityId: "other" } }),
		).rejects.toThrow();
		await expect(f.queries.fileChanges({ ...params, baseLogEpoch: "old" })).rejects.toThrow();
	});
	test("file rewind command restores through business owner and preserves external changes on rejection", async () => {
		const at = Date.now();
		const f = await fixture([
			{ role: "user", content: "edit", timestamp: at, inputId: "input" },
			{
				role: "assistant",
				timestamp: at + 1,
				content: [{ type: "toolCall", id: "write-1", name: "write", arguments: {} }],
			},
			{
				role: "toolResult",
				timestamp: at + 2,
				toolCallId: "write-1",
				toolName: "write",
				content: [],
				details: { path: "a.txt", op: "update", oldText: "before\n", newText: "after\n" },
			},
		]);
		f.host();
		const file = path.join(f.cwd, "a.txt");
		await writeFile(file, "after\n");
		const row = f.projection.rows().find(row => row.kind === "turnHeader");
		if (!row?.entityId) throw new Error("Missing rewind turn identity");
		const params = {
			sessionId: "session",
			target: { rowId: row.rowId, entityId: row.entityId },
			baseRevision: f.projection.snapshot().revision,
			baseLogEpoch: "epoch",
		};
		expect((await f.queries.applyFileRewind(params)).applied).toBe(true);
		expect(await readFile(file, "utf8")).toBe("before\n");
		expect((await f.queries.fileChanges(params)).state).toBe("reverted");
		expect(await f.queries.revertedTargets("session")).toEqual([row.entityId]);
		await writeFile(file, "external\n");
		expect((await f.queries.applyFileRewind(params)).applied).toBe(false);
		expect(await readFile(file, "utf8")).toBe("external\n");
	});
});
