import { describe, expect, it, vi } from "bun:test";
import { Agent, type AgentUserMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "../../src/async/job-manager";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import type { SessionEntry } from "../../src/session/session-entries";
import { ZCodeProjection } from "../../src/modes/zcode/projection";
import { ZCodeTopics } from "../../src/modes/zcode/topics";
import {
	applyConversationDeltas,
	conversationSnapshotSchema,
	routedTopicWireFrameSchema,
	type ConversationDelta,
	type ConversationSnapshot,
} from "../../src/modes/zcode/schema";

const user = (inputId: string): AgentUserMessage => ({ role: "user", content: "same text", timestamp: 100, inputId });
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("native Bash live output preview", () => {
	it.each(["completed", "backgrounded", "stopped"] as const)(
		"delivers bounded UTF-8 progress and clears it when %s without reviving stale output",
		ending => {
			const projection = new ZCodeProjection({ sessionId: "bash", cwd: "/work" });
			const peer = new ZCodeProjection({ sessionId: "peer", cwd: "/work" });
			let consumer = projection.snapshot();
			projection.subscribe(deltas => {
				consumer = applyConversationDeltas(consumer, deltas);
			});
			const assistant: AssistantMessage = {
				role: "assistant",
				timestamp: 200,
				api: "openai-completions",
				provider: "local",
				model: "mock",
				usage,
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "actual command" } }],
			};
			projection.applyEvent({ type: "agent_start" });
			projection.applyEvent({ type: "message_end", message: assistant });
			projection.applyEvent({
				type: "tool_execution_start",
				toolCallId: "bash-call",
				toolName: "bash",
				args: { command: "actual command" },
			});
			const progress = (text: string) =>
				projection.applyEvent({
					type: "tool_execution_update",
					toolCallId: "bash-call",
					toolName: "bash",
					args: { command: "actual command" },
					partialResult: { content: [{ type: "text", text }], details: {} },
				});
			const row = () => {
				const tool = consumer.rows.window.find(row => row.kind === "toolCall");
				if (!tool || tool.kind !== "toolCall") throw new Error("Missing consumer tool row");
				return tool;
			};
			try {
				const output = Array.from({ length: 150 }, (_, index) => `中文😀-${index}`).join("\n");
				progress(output);
				expect(row().outputPreview?.fullText).toBe(output.split("\n").slice(-100).join("\n"));
				expect(row().outputPreview?.text).toBe(output.split("\n").slice(-5).join("\n"));
				expect(row().outputPreview?.totalBytes).toBe(Buffer.byteLength(output));
				progress("前".repeat(2000) + "😀尾");
				expect(Buffer.byteLength(row().outputPreview!.fullText)).toBeLessThanOrEqual(4096);
				expect(row().outputPreview!.fullText.endsWith("😀尾")).toBe(true);
				expect(row().outputPreview!.fullText).not.toContain("\uFFFD");
				expect(Buffer.byteLength(row().output!.text)).toBeLessThanOrEqual(4096);
				expect(conversationSnapshotSchema.safeParse(consumer).success).toBe(true);
				progress("fresh\n中文阶段");
				expect(row().outputPreview).toMatchObject({ text: "fresh\n中文阶段", fullText: "fresh\n中文阶段" });
				expect(peer.rows()).toEqual([]);
				if (ending === "stopped") projection.applyEvent({ type: "agent_end", messages: [] });
				else {
					const result = {
						content: [
							{
								type: "text" as const,
								text: ending === "completed" ? "actual final" : "Backgrounded actual-job",
							},
						],
						details:
							ending === "backgrounded"
								? { async: { state: "running", jobId: "actual-job", type: "bash" } }
								: {},
					};
					projection.applyEvent({
						type: "tool_execution_end",
						toolCallId: "bash-call",
						toolName: "bash",
						result,
						isError: false,
					});
					projection.applyEvent({
						type: "message_end",
						message: {
							role: "toolResult",
							timestamp: 201,
							toolCallId: "bash-call",
							toolName: "bash",
							isError: false,
							...result,
						},
					});
					expect(row().output?.text).toBe(ending === "completed" ? "actual final" : "Backgrounded actual-job");
					// BDO02 新语义:前台终态行带合规 kind:"bash_output" display(小输出 truncated:false,
					// 内容即全文);后台移交 receipt 不产 display,输出走 backgroundWorks 链路。
					if (ending === "completed")
						expect(row().output?.display).toEqual({
							kind: "bash_output",
							output: "actual final",
							truncated: false,
						});
					else expect(row().output?.display).toBeUndefined();
					// 后台移交的 receipt(details.async)按协议合同把 toolCall 行锚定到后台任务。
					if (ending === "backgrounded") expect(row()).toMatchObject({ backgrounded: true, workId: "actual-job" });
					else expect(row().backgrounded).toBeUndefined();
				}
				expect(row().outputPreview).toBeUndefined();
				progress("late stale progress");
				expect(row().outputPreview).toBeUndefined();
			} finally {
				projection.dispose();
				peer.dispose();
			}
		},
	);
	it("anchors a backgrounded bash toolCall row to its job for cold and live projections", () => {
		const input = user("bg");
		const assistant: AssistantMessage = {
			role: "assistant",
			timestamp: 200,
			api: "openai-completions",
			provider: "local",
			model: "mock",
			usage,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "sleep 5" } }],
		};
		// tools/bash.ts 的后台启动 receipt:toolResult.details.async = { state, jobId, type:"bash" }。
		const result: ToolResultMessage = {
			role: "toolResult",
			timestamp: 300,
			toolCallId: "bash-1",
			toolName: "bash",
			content: [{ type: "text", text: "Backgrounded job-1" }],
			isError: false,
			details: { async: { state: "running", jobId: "job-1", type: "bash" } },
		};
		for (const projection of [
			new ZCodeProjection({ sessionId: "s", cwd: "/work", messages: [input, assistant, result] }),
			new ZCodeProjection({ sessionId: "s", cwd: "/work", messages: [input, assistant, result] }),
		]) {
			expect(projection.rows().find(row => row.kind === "toolCall")).toMatchObject({
				toolName: "Bash",
				backgrounded: true,
				workId: "job-1",
			});
		}
	});

	it("bounds the terminal bash_output display head by UTF-8 bytes without splitting characters (BDO02)", () => {
		const projection = new ZCodeProjection({ sessionId: "bash-display", cwd: "/work" });
		const bash: AssistantMessage = {
			role: "assistant",
			timestamp: 200,
			api: "openai-completions",
			provider: "local",
			model: "mock",
			usage,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "make" } }],
		};
		const read: AssistantMessage = {
			...bash,
			content: [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "file" } }],
		};
		try {
			projection.applyEvent({ type: "agent_start" });
			projection.applyEvent({ type: "message_end", message: bash });
			projection.applyEvent({ type: "message_end", message: read });
			// 首字节 1 字节 + 每个中文 3 字节:30000 字节切点落在第 10000 个「前」内部,
			// 必须按 continuation-byte 边界回退,不能按 UTF-16 码元切出 U+FFFD。
			const big = `a${"前".repeat(11_000)}`;
			for (const [toolCallId, toolName] of [
				["bash-call", "bash"],
				["read-call", "read"],
			] as const)
				projection.applyEvent({
					type: "tool_execution_end",
					toolCallId,
					toolName,
					result: { content: [{ type: "text", text: big }], details: {} },
					isError: false,
				});
			const rows = projection.rows().filter(row => row.kind === "toolCall");
			const bashRow = rows.find(row => row.toolName === "Bash")!;
			const readRow = rows.find(row => row.toolName === "Read")!;
			const display = bashRow.output?.display;
			expect(display).toMatchObject({ kind: "bash_output", truncated: true });
			// 头部是原文前缀、字节预算内、无替换符,且截断点恰好在完整「前」字符边界。
			const bounded = (display as { output: string }).output;
			expect(bounded).toBe(`a${"前".repeat(9_999)}`);
			expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(30_000);
			expect(bounded).not.toContain("\uFFFD");
			// 原始长度事实保留在 output.text 全文;truncated 如实反映原文超出头部预算。
			expect(bashRow.output?.text).toBe(big);
			// display 仅 Bash 终态行产出,非 bash 工具不携带。
			expect(readRow.output?.display).toBeUndefined();
			expect(conversationSnapshotSchema.safeParse(projection.snapshot()).success).toBe(true);
		} finally {
			projection.dispose();
		}
	});
});

function projectionSession(entries: SessionEntry[], manager?: AsyncJobManager, durable = true): AgentSession {
	return {
		sessionManager: {
			getBranch: () => entries,
			getBranchView: () => entries,
			getLeafId: () => entries.at(-1)?.id ?? null,
			getSessionFile: () => (durable ? "/work/session.jsonl" : undefined),
			onSessionNameChanged: () => () => {},
		},
		agent: {
			// SDK 在非流式状态保留 state，并用 null 表示没有活动消息。
			state: { streamMessage: null } satisfies Pick<Agent["state"], "streamMessage">,
			peekSteeringQueue: () => [],
		},
		getQueuedMessages: () => ({ steering: [], followUp: [], liveSteered: 0 }),
		getQueuedInputMessages: () => [],
		getQueueAutoDrain: () => true,
		getGoalModeState: () => undefined,
		getContextUsage: () => undefined,
		getAvailableThinkingLevels: () => [],
		getAsyncJobSnapshot: (options?: { recentLimit?: number }) => {
			if (!manager) return null;
			const owner = { ownerId: "parent" };
			return {
				running: manager.getRunningJobs(owner),
				recent: manager.getRecentJobs(options?.recentLimit, owner),
				delivery: manager.getDeliveryState(owner),
			};
		},
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

describe("native held queue projection", () => {
	it.each(["settle", "runtime refresh"] as const)(
		"publishes unchanged-item hold and resume facts through the consumer on %s",
		boundary => {
			vi.useFakeTimers();
			const card = {
				schemaVersion: 1 as const,
				cardId: "queued-card",
				taskId: "queued-task",
				provider: "local",
				model: "mock",
				issuedAt: 100,
				expiresAt: 10_000,
			};
			const entries: SessionEntry[] = [
				{
					type: "custom",
					id: "queued-admission",
					parentId: null,
					timestamp: new Date(100).toISOString(),
					customType: "session_input",
					data: { inputId: "queued-first", state: "admitted", delivery: "queue", highspeed: card },
				},
			];
			const agent = new Agent();
			agent.followUp(user("queued-first"));
			agent.followUp(user("queued-second"));
			const session = projectionSession(entries);
			let streaming = true;
			let tokens = 11373;
			session.getContextUsage = () => ({ tokens, contextWindow: 128_000, percent: tokens / 1280 });
			Object.assign(session, {
				agent,
				getQueueAutoDrain: AgentSession.prototype.getQueueAutoDrain,
				getQueuedInputMessages: AgentSession.prototype.getQueuedInputMessages,
			});
			Object.defineProperty(session, "isStreaming", { get: () => streaming });
			const projection = new ZCodeProjection({ sessionId: "held", cwd: "/work", session });
			let consumer = projection.snapshot();
			const frames: ConversationSnapshot[] = [];
			projection.subscribe(deltas => {
				consumer = applyConversationDeltas(consumer, deltas);
				frames.push(consumer);
			});
			try {
				projection.applyEvent({ type: "agent_start" });
				const items = consumer.queue.items;
				expect(items.map(item => item.queueItemId)).toEqual(["queued-first", "queued-second"]);
				expect(items[0]!.highspeed).toEqual(card);
				expect(items[1]!.highspeed).toBeUndefined();
				expect(consumer.queue.autoDrain).toBe(true);
				frames.length = 0;
				// 真正切换原生 owner 的 held；不伪造 queue_update，也不把期望值写回投影。
				agent.queuedMessagesHeld = true;
				streaming = false;
				tokens = 11381;
				if (boundary === "settle") projection.applyEvent({ type: "agent_end", messages: [] });
				else vi.advanceTimersByTime(250);
				expect(consumer.queue.autoDrain).toBe(false);
				expect(consumer.inputRouting.mode).toBe("choice");
				expect(consumer.queue.items).toEqual(items);
				expect(frames.every(frame => frame.queue.autoDrain || frame.inputRouting.mode === "choice")).toBe(true);
				// Stop 的末次水位随 held/idle 一次发布；没有新事实时，后续轮询
				// 不能把 consumer 刚拿到、供 Resume 使用的 revision 再推进。
				expect(consumer.usage.contextWindow?.usedTokens).toBe(11381);
				const heldRevision = consumer.revision;
				vi.advanceTimersByTime(250);
				expect(consumer.revision).toBe(heldRevision);

				// 继续只改变 owner 事实；idle 恢复 startNow，running 继续保持 enqueue。
				agent.queuedMessagesHeld = false;
				vi.advanceTimersByTime(250);
				expect(consumer.queue.autoDrain).toBe(true);
				expect(consumer.inputRouting.mode).toBe("startNow");
				agent.queuedMessagesHeld = true;
				vi.advanceTimersByTime(250);
				streaming = true;
				projection.applyEvent({ type: "agent_start" });
				agent.queuedMessagesHeld = false;
				vi.advanceTimersByTime(250);
				expect(consumer.queue.autoDrain).toBe(true);
				expect(consumer.inputRouting.mode).toBe("enqueue");
				expect(consumer.queue.items).toEqual(items);

				// 普通条目更新仍走原队列投影，既有身份及 journal 卡不能被刷新丢失。
				agent.followUp(user("queued-third"));
				projection.applyEvent({
					type: "queue_update",
					steering: [],
					followUp: ["same text", "same text", "same text"],
					liveSteered: 0,
				});
				expect(consumer.queue.items.slice(0, 2)).toEqual(items);
				expect(consumer.queue.items[2]).toMatchObject({
					queueItemId: "queued-third",
					sourceCommandId: "queued-third",
				});
				expect(consumer.queue.items[2]!.highspeed).toBeUndefined();
				expect(consumer.queue).toEqual(projection.snapshot().queue);
				expect(conversationSnapshotSchema.safeParse(consumer).success).toBe(true);
			} finally {
				projection.dispose();
				vi.useRealTimers();
			}
		},
	);
});

describe("native context usage projection", () => {
	it("publishes changed session usage without a model refresh, including a lower post-compaction watermark", () => {
		vi.useFakeTimers();
		const session = projectionSession([]);
		let tokens = 42;
		session.getContextUsage = () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 });
		const projection = new ZCodeProjection({ sessionId: "usage", cwd: "/work", session });
		let consumer = projection.snapshot();
		projection.subscribe(deltas => {
			consumer = applyConversationDeltas(consumer, deltas);
		});
		try {
			expect(consumer.usage.contextWindow).toMatchObject({ usedTokens: 42, maxTokens: 1_000_000 });
			// A cold-resumed session receives a high-usage provider reply without
			// changing its model. The runtime remains the sole context usage owner.
			tokens = 157_900;
			projection.applyEvent({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "cw-tool-followup-ok" }],
					api: "openai-completions",
					provider: "context-provider",
					model: "model-1m",
					usage: { ...usage, input: 157_900, output: 8, totalTokens: 157_908 },
					stopReason: "stop",
					timestamp: 200,
				},
			});
			projection.applyEvent({ type: "agent_end", messages: [] });
			// terminal must already contain the native watermark: a later facts poll
			// must not invalidate the revision the consumer can use for Resume.
			expect(consumer.control.canStop).toBe(false);
			expect(consumer.usage.contextWindow).toMatchObject({ usedTokens: 157_900, maxTokens: 1_000_000 });
			expect(consumer.usage.cumulative.inputTokens).toBe(157_900);
			const terminalRevision = consumer.revision;
			vi.advanceTimersByTime(250);
			expect(consumer.revision).toBe(terminalRevision);
			// Compaction can lower current usage while cumulative provider usage
			// stays high; the adapter must not derive one from the other.
			tokens = 256;
			vi.advanceTimersByTime(250);
			expect(consumer.usage.contextWindow).toMatchObject({ usedTokens: 256, maxTokens: 1_000_000 });
			expect(consumer.usage.cumulative.inputTokens).toBe(157_900);
		} finally {
			projection.dispose();
			vi.useRealTimers();
		}
	});
});

describe("native assistant fork availability", () => {
	it("offers fork only after a stable reply has its matching durable assistant target", () => {
		const entries: SessionEntry[] = [];
		const session = projectionSession(entries);
		const projection = new ZCodeProjection({ sessionId: "fork", cwd: "/work", session });
		const assistant: AssistantMessage = {
			role: "assistant",
			timestamp: 200,
			api: "openai-completions",
			provider: "local",
			model: "mock",
			usage,
			stopReason: "stop",
			content: [{ type: "text", text: "actual reply" }],
		};
		const reply = () => projection.rows().find(row => row.kind === "assistantText")!;
		try {
			projection.applyEvent({ type: "message_start", message: assistant });
			expect(reply().state).toBe("streaming");
			expect(reply().actions?.canFork).not.toBe(true);
			projection.applyEvent({ type: "message_end", message: assistant });
			expect(reply().state).toBe("complete");
			expect(reply().actions?.canFork).not.toBe(true);
			entries.push({
				type: "message",
				id: "durable-assistant",
				parentId: null,
				timestamp: new Date(200).toISOString(),
				message: assistant,
			});
			projection.refresh();
			expect(reply().state).toBe("complete");
			expect(reply().actions?.canFork).toBe(true);
			const target = reply();
			if (!target.entityId) throw new Error("Forkable assistant row is missing its durable identity");
			expect(projection.resolveTarget({ rowId: target.rowId, entityId: target.entityId })).toMatchObject({
				entryId: "durable-assistant",
				message: { role: "assistant" },
			});
			const streaming = new ZCodeProjection({ sessionId: "streaming", cwd: "/work", session, messages: [] });
			try {
				streaming.applyEvent({ type: "message_start", message: assistant });
				const streamingReply = streaming.rows().find(row => row.kind === "assistantText")!;
				expect(streamingReply.state).toBe("streaming");
				expect(streamingReply.actions?.canFork).not.toBe(true);
				streaming.applyEvent({ type: "message_end", message: assistant });
				const completeReply = streaming.rows().find(row => row.kind === "assistantText")!;
				expect(completeReply.state).toBe("complete");
				expect(completeReply.actions?.canFork).toBe(true);
			} finally {
				streaming.dispose();
			}
			for (const stopReason of ["error", "aborted"] as const) {
				const failed = { ...assistant, stopReason };
				entries[0] = { ...entries[0], type: "message", message: failed };
				const rejected = new ZCodeProjection({ sessionId: stopReason, cwd: "/work", session });
				try {
					expect(rejected.rows().find(row => row.kind === "assistantText")?.actions?.canFork).not.toBe(true);
				} finally {
					rejected.dispose();
				}
			}
			const temporary = new ZCodeProjection({
				sessionId: "temporary",
				cwd: "/work",
				session: projectionSession([{ ...entries[0], type: "message", message: assistant }], undefined, false),
			});
			try {
				expect(temporary.rows().find(row => row.kind === "assistantText")?.actions?.canFork).not.toBe(true);
			} finally {
				temporary.dispose();
			}
		} finally {
			projection.dispose();
		}
	});
});

describe("native goal transitions", () => {
	it("publishes active, actual completion work, paused and complete facts without leaking to a peer", () => {
		const projection = new ZCodeProjection({ sessionId: "goal", cwd: "/work" });
		const peer = new ZCodeProjection({ sessionId: "peer", cwd: "/work" });
		const goal = {
			id: "g",
			objective: "deliver",
			status: "active" as const,
			tokensUsed: 0,
			timeUsedSeconds: 2,
			createdAt: 10,
			updatedAt: 20,
		};
		projection.applyEvent({ type: "goal_updated", goal, state: { enabled: true, mode: "active", goal } });
		expect(projection.snapshot().goal).toMatchObject({ targetId: "g", status: "active" });
		projection.applyEvent({
			type: "tool_execution_start",
			toolCallId: "complete",
			toolName: "goal",
			args: { op: "complete" },
		});
		expect(projection.snapshot().goal?.status).toBe("verifying");
		projection.applyEvent({ type: "goal_updated", goal: { ...goal, status: "paused" } });
		expect(projection.snapshot().goal?.status).toBe("paused");
		projection.applyEvent({ type: "goal_updated", goal: { ...goal, status: "complete" } });
		expect(projection.snapshot().goal?.status).toBe("verified");
		expect(projection.summary("workspace").goalStatus).toBe("verified");
		expect(peer.snapshot().goal).toBeNull();
	});

	it("recovers completed native Goal identity, but never resurrects it after a later drop", () => {
		const goal = {
			id: "finished",
			objective: "deliver",
			status: "complete" as const,
			tokensUsed: 4,
			timeUsedSeconds: 2,
			createdAt: 10,
			updatedAt: 20,
		};
		const base = { parentId: null, timestamp: new Date(20).toISOString() };
		const completed = new ZCodeProjection({
			sessionId: "goal",
			cwd: "/work",
			entries: [
				{ ...base, type: "mode_change", id: "goal", mode: "goal", data: { goal } },
				{ ...base, type: "mode_change", id: "exit", mode: "none" },
				{
					...base,
					type: "custom",
					id: "complete",
					customType: "goal-completed",
					data: { objective: goal.objective },
				},
			],
		});
		expect(completed.snapshot().goal).toMatchObject({ targetId: "finished", status: "verified" });
		const dropped = new ZCodeProjection({
			sessionId: "goal",
			cwd: "/work",
			entries: [
				{ ...base, type: "mode_change", id: "goal", mode: "goal", data: { goal } },
				{
					...base,
					type: "custom",
					id: "complete",
					customType: "goal-completed",
					data: { objective: goal.objective },
				},
				{ ...base, type: "mode_change", id: "drop", mode: "none" },
			],
		});
		expect(dropped.snapshot().goal).toBeNull();
	});
});

describe("native compaction lifecycle", () => {
	it("updates a single actual manual operation marker, never manufactures success on failure", () => {
		const projection = new ZCodeProjection({ sessionId: "compact", cwd: "/work" });
		const peer = new ZCodeProjection({ sessionId: "peer", cwd: "/work" });
		projection.applyEvent({ type: "manual_compaction_start", operationId: "operation" });
		const started = projection.rows().find(row => row.kind === "timelineMarker")!;
		expect(started).toMatchObject({ marker: { type: "compact", origin: "manual", status: "running" } });
		expect(projection.snapshot().control).toMatchObject({ canStop: true, stopTargetKind: "compact" });
		projection.applyEvent({ type: "agent_end", messages: [] });
		expect(projection.snapshot().control).toMatchObject({
			phase: "running",
			canStop: true,
			stopTargetKind: "compact",
		});
		projection.applyEvent({
			type: "manual_compaction_end",
			operationId: "operation",
			result: undefined,
			aborted: false,
			errorMessage: "provider rejected summary",
		});
		const ended = projection.rows().filter(row => row.kind === "timelineMarker");
		expect(ended).toHaveLength(1);
		expect(ended[0]).toMatchObject({ entityId: started.entityId, marker: { status: "failed" } });
		expect(peer.rows()).toEqual([]);
	});

	it("preserves manual success identity through canonical native journal recovery", () => {
		const projection = new ZCodeProjection({ sessionId: "compact", cwd: "/work" });
		projection.applyEvent({ type: "manual_compaction_start", operationId: "operation" });
		projection.applyEvent({
			type: "manual_compaction_end",
			operationId: "operation",
			result: { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 100 },
			summaryRef: "entry",
			aborted: false,
		});
		const recovered = new ZCodeProjection({
			sessionId: "compact",
			cwd: "/work",
			entries: [
				{
					type: "compaction",
					id: "entry",
					parentId: null,
					timestamp: new Date().toISOString(),
					summary: "summary",
					firstKeptEntryId: "kept",
					tokensBefore: 100,
					origin: "manual",
					operationId: "operation",
				},
			],
		});
		const live = projection.rows().find(row => row.kind === "timelineMarker")!;
		const cold = recovered.rows().find(row => row.kind === "timelineMarker")!;
		expect(cold).toMatchObject({
			entityId: live.entityId,
			marker: { origin: "manual", status: "success", summaryRef: "entry" },
		});
	});

	it("distinguishes automatic success, skipped maintenance and cancelled work", () => {
		const projection = new ZCodeProjection({ sessionId: "auto", cwd: "/work" });
		projection.applyEvent({ type: "auto_compaction_start", reason: "overflow", action: "context-full" });
		projection.applyEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: { summary: "actual summary", firstKeptEntryId: "kept", tokensBefore: 200 },
			aborted: false,
			willRetry: true,
		});
		expect(projection.rows().at(-1)).toMatchObject({ marker: { origin: "auto", status: "success" } });
		projection.applyEvent({ type: "auto_compaction_start", reason: "threshold", action: "shake" });
		projection.applyEvent({
			type: "auto_compaction_end",
			action: "shake",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		});
		expect(projection.rows().at(-1)).toMatchObject({ marker: { status: "noop" } });
		projection.applyEvent({ type: "manual_compaction_start", operationId: "cancel" });
		projection.applyEvent({ type: "manual_compaction_end", operationId: "cancel", result: undefined, aborted: true });
		expect(projection.rows().at(-1)).toMatchObject({ marker: { status: "cancelled" } });
	});

	it("does not invent a manual or automatic origin for legacy journal compactions", () => {
		const projection = new ZCodeProjection({
			sessionId: "legacy",
			cwd: "/work",
			entries: [
				{
					type: "compaction",
					id: "legacy",
					parentId: null,
					timestamp: new Date().toISOString(),
					summary: "legacy summary",
					firstKeptEntryId: "kept",
					tokensBefore: 100,
				},
			],
		});
		expect(projection.rows().filter(row => row.kind === "timelineMarker")).toEqual([]);
	});

	it("surfaces an exhausted native retry without reporting another session's failure", () => {
		const projection = new ZCodeProjection({ sessionId: "retry", cwd: "/work" });
		const peer = new ZCodeProjection({ sessionId: "peer", cwd: "/work" });
		projection.applyEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 4,
			finalError: "Assistant returned empty stop after retry cap",
		});
		expect(projection.snapshot().control).toMatchObject({
			phase: "error",
			lastError: { message: "Assistant returned empty stop after retry cap" },
		});
		expect(peer.snapshot().control.lastError).toBeNull();
	});
});
describe("ZCode public consumer projection", () => {
	it.each(["stop", "aborted", "error"] as const)(
		"publishes %s terminal rows and settled control at the same revision",
		stopReason => {
			const input = user("preview");
			const final: AssistantMessage = {
				role: "assistant",
				timestamp: 200,
				api: "openai-completions",
				provider: "local",
				model: "mock",
				usage,
				stopReason,
				content: [{ type: "text", text: "final preview source" }],
				...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
			};
			const projection = new ZCodeProjection({ sessionId: "s", cwd: "/work", messages: [input] });
			let consumer = projection.snapshot();
			const terminalSources: ConversationSnapshot[] = [];
			projection.subscribe(deltas => {
				consumer = applyConversationDeltas(consumer, deltas);
				if (consumer.rows.window.some(row => row.kind === "assistantText" && row.state !== "streaming")) {
					// A one-shot source query uses exactly the revision advertised by this frame.
					const source = projection.snapshot();
					expect(source.revision).toBe(consumer.revision);
					expect(source.rows).toEqual(consumer.rows);
					expect(source.control).toEqual(consumer.control);
					expect(source.control.canStop).toBe(false);
					terminalSources.push(source);
				}
			});
			projection.applyEvent({ type: "agent_start" });
			projection.applyEvent({ type: "message_start", message: { ...final, content: [{ type: "text", text: "" }] } });
			projection.applyEvent({ type: "message_end", message: final });
			expect(terminalSources).toHaveLength(0);
			expect(consumer.rows.window.find(row => row.kind === "assistantText")).toMatchObject({
				text: "final preview source",
				state: "streaming",
			});
			projection.applyEvent({ type: "agent_end", messages: [final], isTerminal: true });
			expect(terminalSources).toHaveLength(1);
			expect(consumer.control.phase).toBe(
				stopReason === "stop" ? "completedSuccess" : stopReason === "aborted" ? "completedInterrupted" : "error",
			);
			const revision = consumer.revision;
			projection.applyEvent({ type: "agent_end", messages: [final], isTerminal: true });
			expect(projection.snapshot().revision).toBe(revision);
			const cold = new ZCodeProjection({ sessionId: "s", cwd: "/work", messages: [input, final] });
			expect(projection.rows()).toEqual(cold.rows());
		},
	);

	it("keeps pending async delivery and queued execution live until the actual terminal end", () => {
		const projection = new ZCodeProjection({ sessionId: "s", cwd: "/work", messages: [user("first")] });
		const final: AssistantMessage = {
			role: "assistant",
			timestamp: 200,
			api: "openai-completions",
			provider: "local",
			model: "mock",
			usage,
			stopReason: "stop",
			content: [{ type: "text", text: "waiting for delivery" }],
		};
		projection.applyEvent({ type: "agent_start" });
		projection.applyEvent({ type: "message_start", message: final });
		projection.applyEvent({ type: "message_end", message: final });
		projection.applyEvent({ type: "agent_end", messages: [final], isTerminal: false, awaitingAsyncWork: true });
		// awaitingAsyncWork 的非终态 settle 也执行「会话回 idle」语义(BDO04,对齐 OMP TUI
		// event-controller 对该事件按 idle 处理):phase 回 completed、不可 Stop、stopState
		// idle、清主 turn 占位;后台任务行在 backgroundWorks 维护,不受影响。
		expect(projection.snapshot().control).toMatchObject({
			phase: "completedSuccess",
			sessionEnded: true,
			canStop: false,
			stopState: "idle",
			activeWorks: [],
		});
		expect(projection.rows().find(row => row.kind === "assistantText")).toMatchObject({ state: "complete" });
		projection.applyEvent({ type: "message_end", message: user("queued") });
		projection.applyEvent({ type: "agent_start" });
		const tool: AssistantMessage = {
			...final,
			timestamp: 300,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "read-source", name: "read", arguments: { path: "source.txt" } }],
		};
		projection.applyEvent({ type: "message_start", message: tool });
		projection.applyEvent({ type: "message_end", message: tool });
		projection.applyEvent({
			type: "tool_execution_start",
			toolCallId: "read-source",
			toolName: "read",
			args: { path: "source.txt" },
		});
		projection.applyEvent({
			type: "tool_execution_update",
			toolCallId: "read-source",
			toolName: "read",
			args: { path: "source.txt" },
			partialResult: { content: [{ type: "text", text: "live source bytes" }] },
		});
		expect(projection.rows().find(row => row.kind === "toolCall")).toMatchObject({
			status: "running",
			output: { text: "live source bytes" },
		});
		const result: ToolResultMessage = {
			role: "toolResult",
			timestamp: 350,
			toolCallId: "read-source",
			toolName: "read",
			content: [{ type: "text", text: "live source bytes" }],
			isError: false,
		};
		projection.applyEvent({
			type: "tool_execution_end",
			toolCallId: "read-source",
			toolName: "read",
			result: { content: result.content, details: {} },
			isError: false,
		});
		projection.applyEvent({ type: "message_end", message: result });
		projection.applyEvent({ type: "agent_end", messages: [tool], isTerminal: false });
		expect(projection.snapshot().control.sessionEnded).toBe(false);
		const delivered = { ...final, timestamp: 400, content: [{ type: "text" as const, text: "delivered result" }] };
		projection.applyEvent({ type: "message_start", message: delivered });
		projection.applyEvent({ type: "message_end", message: delivered });
		// 首个回已在 awaitingAsyncWork settle 收口;投递回合的文本在真正的终态前保持 live。
		expect(projection.rows().findLast(row => row.kind === "assistantText")).toMatchObject({
			state: "streaming",
		});
		projection.applyEvent({ type: "agent_end", messages: [delivered], isTerminal: true });
		expect(projection.snapshot().control).toMatchObject({
			phase: "completedSuccess",
			sessionEnded: true,
			canStop: false,
		});
		expect(
			projection
				.rows()
				.filter(row => row.kind === "assistantText")
				.every(row => row.state === "complete"),
		).toBe(true);
		// A later queued turn must get its own settlement, not inherit the old terminal watermark.
		projection.applyEvent({ type: "message_end", message: user("later") });
		projection.applyEvent({ type: "agent_start" });
		const later = { ...final, timestamp: 500 };
		projection.applyEvent({ type: "message_start", message: later });
		projection.applyEvent({ type: "message_end", message: later });
		expect(projection.snapshot().control.sessionEnded).toBe(false);
		expect(projection.rows().findLast(row => row.kind === "assistantText")).toMatchObject({ state: "streaming" });
		projection.applyEvent({ type: "agent_end", messages: [later], isTerminal: true });
		expect(projection.rows().findLast(row => row.kind === "assistantText")).toMatchObject({ state: "complete" });
	});

	it("applies real streaming deltas with the fixed public consumer reducer", () => {
		const projection = new ZCodeProjection({ sessionId: "s", cwd: "/work" });
		projection.applyEvent({ type: "message_end", message: user("stream") });
		let consumer = projection.snapshot();
		const observed: ConversationDelta[] = [];
		projection.subscribe(deltas => {
			observed.push(...deltas);
			consumer = applyConversationDeltas(consumer, deltas);
		});
		const partial: AssistantMessage = {
			role: "assistant",
			timestamp: 200,
			api: "openai-completions",
			provider: "local",
			model: "mock",
			usage,
			stopReason: "stop",
			content: [{ type: "text", text: "" }],
		};
		const growing: AssistantMessage = { ...partial, content: [{ type: "text", text: "hello" }] };
		projection.applyEvent({ type: "message_start", message: partial });
		projection.applyEvent({
			type: "message_update",
			message: growing,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: growing },
		});
		projection.applyEvent({ type: "message_end", message: growing });
		expect(observed.some(delta => delta.op === "row.delta" && delta.append === "hello")).toBe(true);
		expect(consumer.rows).toEqual(projection.snapshot().rows);
		expect(consumer.revision).toBe(projection.snapshot().revision);
	});

	it("keeps equal-text input identities distinct and cold/live rows canonical", () => {
		const messages = [user("first"), user("second")];
		const live = new ZCodeProjection({ sessionId: "s", cwd: "/work" });
		for (const message of messages) live.applyEvent({ type: "message_end", message });
		const cold = new ZCodeProjection({ sessionId: "s", cwd: "/work", messages });
		expect(live.rows()).toEqual(cold.rows());
		expect(
			live
				.rows()
				.filter(row => row.kind === "userInput")
				.map(row => row.sourceCommandId),
		).toEqual(["first", "second"]);
		expect(conversationSnapshotSchema.safeParse(live.snapshot()).success).toBe(true);
	});

	it("projects only the matching journal Highspeed fact through live deltas, refresh and cold recovery", () => {
		const card = {
			schemaVersion: 1 as const,
			cardId: "journal-card",
			taskId: "journal-task",
			provider: "local",
			model: "mock",
			issuedAt: 100,
			expiresAt: 10_000,
		};
		const entries: SessionEntry[] = [
			{
				type: "custom",
				id: "card-admission",
				parentId: null,
				timestamp: new Date(100).toISOString(),
				customType: "session_input",
				data: {
					inputId: "card-input",
					state: "admitted",
					delivery: "queue",
					highspeed: card,
				},
			},
		];
		const messages = [user("card-input"), user("plain-input")];
		const projection = new ZCodeProjection({ sessionId: "card", cwd: "/work", session: projectionSession(entries) });
		let consumer = projection.snapshot();
		projection.subscribe(deltas => {
			consumer = applyConversationDeltas(consumer, deltas);
		});
		try {
			for (const [index, message] of messages.entries()) {
				entries.push({
					type: "message",
					id: `user-${index}`,
					parentId: entries.at(-1)!.id,
					timestamp: new Date(message.timestamp ?? 0).toISOString(),
					message,
				});
				projection.applyEvent({ type: "message_end", message });
			}
			const inputs = consumer.rows.window.filter(row => row.kind === "userInput");
			expect(inputs).toHaveLength(2);
			expect(inputs[0]).toMatchObject({ sourceCommandId: "card-input", highspeed: card });
			expect(inputs[0]!.highspeed).toEqual(card);
			expect(inputs[1]).toMatchObject({ sourceCommandId: "plain-input" });
			expect(inputs[1]!.highspeed).toBeUndefined();
			projection.refresh();
			expect(consumer.rows.window.filter(row => row.kind === "userInput")).toEqual(inputs);
			const cold = new ZCodeProjection({ sessionId: "card", cwd: "/work", session: projectionSession(entries) });
			const other = new ZCodeProjection({ sessionId: "other", cwd: "/work", messages });
			try {
				expect(cold.rows().filter(row => row.kind === "userInput")).toEqual(inputs);
				expect(
					other
						.rows()
						.filter(row => row.kind === "userInput")
						.every(row => row.highspeed === undefined),
				).toBe(true);
			} finally {
				cold.dispose();
				other.dispose();
			}
		} finally {
			projection.dispose();
		}
	});

	it("reconstructs thinking, tool results and interruption identically after cold history", () => {
		const input = user("tool-turn");
		const assistant: AssistantMessage = {
			role: "assistant",
			timestamp: 200,
			api: "openai-completions",
			provider: "local",
			model: "mock",
			usage,
			content: [
				{ type: "thinking", thinking: "reason" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" } },
			],
			stopReason: "aborted",
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			timestamp: 300,
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "file bytes" }],
			isError: false,
		};
		const live = new ZCodeProjection({ sessionId: "s", cwd: "/work" });
		live.applyEvent({ type: "message_end", message: input });
		live.applyEvent({ type: "message_start", message: assistant });
		live.applyEvent({ type: "message_end", message: assistant });
		live.applyEvent({ type: "message_end", message: result });
		const cold = new ZCodeProjection({ sessionId: "s", cwd: "/work", messages: [input, assistant, result] });
		expect(live.rows()).toEqual(cold.rows());
		expect(live.rows().find(row => row.kind === "reasoning")).toMatchObject({ state: "interrupted", text: "reason" });
		expect(live.rows().find(row => row.kind === "toolCall")).toMatchObject({
			status: "success",
			output: { text: "file bytes" },
		});
		expect(conversationSnapshotSchema.safeParse(cold.snapshot()).success).toBe(true);
	});

	it.each([false, true])("distinguishes a durable tool failure from actual cancellation (cancelled=%s)", cancelled => {
		const input = user("failure");
		const assistant: AssistantMessage = {
			role: "assistant",
			timestamp: 200,
			api: "openai-completions",
			provider: "local",
			model: "mock",
			usage,
			content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "work" } }],
			stopReason: "toolUse",
		};
		// Match the durable cancellation marker emitted by agent-loop's emitToolResult.
		const result: ToolResultMessage & { cancelled?: boolean } = {
			role: "toolResult",
			timestamp: 300,
			toolCallId: "t",
			toolName: "bash",
			content: [{ type: "text", text: "result" }],
			isError: true,
			...(cancelled ? { cancelled: true } : {}),
		};
		const projection = new ZCodeProjection({ sessionId: "s", cwd: "/work", messages: [input, assistant, result] });
		const row = projection.rows().find(candidate => candidate.kind === "toolCall");
		expect(row).toMatchObject({ toolName: "Bash", status: cancelled ? "cancelled" : "error" });
		expect(conversationSnapshotSchema.safeParse(projection.snapshot()).success).toBe(true);
	});

	it("orders initial frame after ACK, isolates subscriptions and repairs an expired base", () => {
		const projection = new ZCodeProjection({ sessionId: "s", cwd: "/work" });
		const topics = new ZCodeTopics({ replayLimit: 1 });
		topics.register("conversation/s", projection);
		const first: unknown[] = [];
		const second: unknown[] = [];
		const a = topics.subscribe(
			{ topic: "conversation/s", connectionId: "desktop", clientMode: "desktop-continuous" },
			wire => first.push(wire),
		);
		const b = topics.subscribe(
			{ topic: "conversation/s", connectionId: "mobile", clientMode: "web-remote-replayable" },
			wire => second.push(wire),
		);
		expect(first).toHaveLength(0);
		a.flush();
		b.flush();
		topics.cancel(a.ack.subscriptionId);
		projection.applyEvent({ type: "message_end", message: user("one") });
		projection.applyEvent({ type: "message_end", message: user("two") });
		expect(first).toHaveLength(1);
		expect(second.length).toBeGreaterThan(1);
		for (const frame of second) expect(routedTopicWireFrameSchema.safeParse(frame).success).toBe(true);
		const repair = topics.recover({
			subscriptionId: b.ack.subscriptionId,
			base: { logEpoch: b.ack.logEpoch, seq: 0 },
		});
		expect(repair.ack.mode).toBe("snapshot");
		repair.flush();
		topics.dispose();
	});

	it("replaces a closed session epoch without delivering stale-owner events", () => {
		const topics = new ZCodeTopics();
		const old = new ZCodeProjection({ sessionId: "s", cwd: "/work", logEpoch: "old" });
		topics.register("conversation/s", old);
		const frames: unknown[] = [];
		const sub = topics.subscribe(
			{ topic: "conversation/s", connectionId: "desktop", clientMode: "desktop-continuous" },
			frame => frames.push(frame),
		);
		sub.flush();
		const replacement = new ZCodeProjection({ sessionId: "s", cwd: "/work", logEpoch: "new" });
		topics.register("conversation/s", replacement);
		expect(frames).toHaveLength(2);
		old.applyEvent({ type: "message_end", message: user("stale") });
		expect(frames).toHaveLength(2);
		const recovery = topics.recover({ subscriptionId: sub.ack.subscriptionId, base: { logEpoch: "old", seq: 0 } });
		expect(recovery.ack).toMatchObject({ mode: "snapshot", logEpoch: "new" });
		recovery.flush();
		for (const frame of frames) expect(routedTopicWireFrameSchema.safeParse(frame).success).toBe(true);
		topics.dispose();
	});

	it("serves index and config snapshots only from registered existing sources", () => {
		const topics = new ZCodeTopics();
		topics.register("sessions-index/work", {
			snapshot: () => ({ protocolVersion: 1 as const, workspaceId: "work", logEpoch: "index", sessions: [] }),
		});
		topics.register("workspace-config/work", {
			snapshot: () => ({
				protocolVersion: 1 as const,
				workspaceId: "work",
				logEpoch: "config",
				config: { configOptions: [], slashCommands: [] },
			}),
		});
		for (const topic of ["sessions-index/work", "workspace-config/work"]) {
			const frames: unknown[] = [];
			topics
				.subscribe({ topic, connectionId: "observer", clientMode: "desktop-continuous" }, frame =>
					frames.push(frame),
				)
				.flush();
			expect(frames).toHaveLength(1);
			expect(routedTopicWireFrameSchema.safeParse(frames[0]).success).toBe(true);
		}
		expect(() =>
			topics.subscribe(
				{ topic: "conversation/missing", connectionId: "observer", clientMode: "desktop-continuous" },
				() => {},
			),
		).toThrow("Unknown existing topic");
		topics.dispose();
	});

	it("bounds one saturated attachment and repairs it without blocking another", () => {
		const projection = new ZCodeProjection({ sessionId: "s", cwd: "/work" });
		const topics = new ZCodeTopics();
		topics.register("conversation/s", projection);
		const slow: unknown[] = [];
		let liveFrames = 0;
		topics
			.subscribe({ topic: "conversation/s", connectionId: "slow", clientMode: "web-remote-replayable" }, frame =>
				slow.push(frame),
			)
			.flush();
		topics
			.subscribe({ topic: "conversation/s", connectionId: "live", clientMode: "desktop-continuous" }, () => {
				liveFrames++;
			})
			.flush();
		topics.setConnectionFlow("slow", "saturated");
		for (let index = 0; index < 501; index++)
			projection.setState({ meta: { title: `title-${index}`, titleSource: "custom" } });
		expect(slow).toHaveLength(1);
		expect(liveFrames).toBe(502);
		topics.setConnectionFlow("slow", "drained");
		expect(slow).toHaveLength(2);
		const repaired = routedTopicWireFrameSchema.parse(slow[1]);
		expect(repaired).toMatchObject({
			kind: "complete",
			deliveryKind: "recovery",
			frame: {
				toSeq: projection.snapshot().seq,
				payload: { kind: "snapshot", snapshot: { meta: { title: "title-500" } } },
			},
		});
		topics.dispose();
	});
});

describe("native task background projection", () => {
	it.each(["completed", "failed"] as const)(
		"projects real task assignments and %s delivery without manufacturing child output",
		status => {
			const args = {
				i: "Check background",
				tasks: [{ task: "Read the actual child file", agent: "scout", solutionSpace: "read only" }],
			};
			const assistant: AssistantMessage = {
				role: "assistant",
				timestamp: 200,
				api: "openai-completions",
				provider: "local",
				model: "mock",
				usage,
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "spawn", name: "task", arguments: args }],
			};
			const receipt: ToolResultMessage = {
				role: "toolResult",
				timestamp: 201,
				toolCallId: "spawn",
				toolName: "task",
				content: [{ type: "text", text: "Spawned agent `Child` (job `Child`)." }],
				isError: false,
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 1,
					async: { state: "running", jobId: "Child", type: "task" },
					progress: [{ id: "Child", agent: "scout", status: "running", task: args.tasks[0].task }],
				},
			};
			const delivery = {
				role: "custom" as const,
				customType: "async-result",
				timestamp: 300,
				display: true,
				content:
					"<system-notice>\nBackground job Child has completed. Resume your work using the result below.\nactual child result\n</system-notice>",
				details: { jobs: [{ jobId: "Child", agentId: "Child", type: "task", status, label: "Child" }] },
			};
			const projection = new ZCodeProjection({
				sessionId: "parent",
				cwd: "/work",
				messages: [user("start"), assistant, receipt],
			});
			const before = projection.rows().find(row => row.kind === "toolCall")!;
			expect(before).toMatchObject({
				toolName: "Agent",
				toolCallId: "spawn",
				inputText: JSON.stringify(args),
				input: {
					...args,
					description: "Check background",
					prompt: args.tasks[0].task,
					subagent_type: "scout",
					run_in_background: true,
				},
				output: { text: "Spawned agent `Child` (job `Child`)." },
			});
			projection.applyEvent({ type: "message_start", message: delivery });
			projection.applyEvent({ type: "message_end", message: delivery });
			expect(projection.rows().find(row => row.kind === "subagent")).toMatchObject({
				parentToolCallId: "spawn",
				subagentType: "scout",
				workId: "Child",
				status: status === "completed" ? "success" : "failed",
				summaryText: args.tasks[0].task,
			});
			expect(projection.rows().filter(row => row.kind === "userInput")).toHaveLength(1);
			expect(
				projection.rows().find(row => row.kind === "turnHeader" && row.origin === "backgroundResult"),
			).toMatchObject({
				originMeta: { backgroundSource: "subagent", workId: "Child", title: "Child" },
			});
			expect(
				projection.rows().some(row => row.kind === "assistantText" && row.text.includes("actual child result")),
			).toBe(false);
			const recovered = new ZCodeProjection({
				sessionId: "parent",
				cwd: "/work",
				messages: [user("start"), assistant, receipt, delivery],
			});
			expect(recovered.rows()).toEqual(projection.rows());
		},
	);

	it("publishes actual owner-scoped native cancellation without an async-result delivery", async () => {
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("parent", jobId => {
			deliveries.push(jobId);
		});
		const pending = Promise.withResolvers<string>();
		manager.register("task", "Child", () => pending.promise, {
			id: "actual-job",
			agentId: "Child",
			ownerId: "parent",
		});
		const peerPending = Promise.withResolvers<string>();
		manager.register("task", "Peer", () => peerPending.promise, {
			id: "peer-job",
			agentId: "Peer",
			ownerId: "peer",
		});
		const assistant: AssistantMessage = {
			role: "assistant",
			timestamp: 200,
			api: "openai-completions",
			provider: "local",
			model: "mock",
			usage,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "spawn", name: "task", arguments: { tasks: [] } }],
		};
		const receipt: ToolResultMessage = {
			role: "toolResult",
			timestamp: 201,
			toolCallId: "spawn",
			toolName: "task",
			content: [{ type: "text", text: "Backgrounded actual-job" }],
			isError: false,
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 1,
				async: { state: "running", jobId: "actual-job", type: "task" },
				progress: [{ id: "Child", agent: "scout", status: "running", task: "inspect actual child" }],
			},
		};
		const projection = new ZCodeProjection({
			sessionId: "parent",
			cwd: "/work",
			session: projectionSession([], manager),
			messages: [user("start"), assistant, receipt],
		});
		const deltas: ConversationDelta[] = [];
		projection.subscribe(batch => deltas.push(...batch));
		try {
			expect(projection.rows().find(row => row.kind === "subagent")).toMatchObject({
				status: "running",
				workId: "actual-job",
			});
			expect(manager.cancel("actual-job", { ownerId: "parent" })).toBe(true);
			projection.refresh();
			expect(projection.rows().find(row => row.kind === "subagent")).toMatchObject({
				status: "cancelled",
				workId: "actual-job",
			});
			expect(projection.snapshot().backgroundWorks).toMatchObject([
				{ workId: "actual-job", status: "cancelled", cancellable: false },
			]);
			expect(
				deltas.some(
					delta =>
						delta.op === "row.upserted" && delta.row.kind === "subagent" && delta.row.status === "cancelled",
				),
			).toBe(true);
			expect(projection.rows().some(row => row.kind === "turnHeader" && row.origin === "backgroundResult")).toBe(
				false,
			);
			expect(manager.getDeliveryState({ ownerId: "parent" }).pendingJobIds).toEqual([]);
			expect(deliveries).toEqual([]);
		} finally {
			projection.dispose();
			manager.cancel("peer-job");
			pending.resolve("cancelled child settled");
			peerPending.resolve("peer settled");
			await manager.dispose();
		}
	});
});

describe("native row identity stability", () => {
	it("preserves streamed targets after direct journal reminders and separates new branch messages", () => {
		const input = user("identity");
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "input",
				parentId: null,
				timestamp: new Date(100).toISOString(),
				message: input,
			},
		];
		const projection = new ZCodeProjection({
			sessionId: "identity",
			cwd: "/work",
			session: projectionSession(entries),
		});
		const assistant: AssistantMessage = {
			role: "assistant",
			timestamp: 300,
			api: "openai-completions",
			provider: "local",
			model: "mock",
			usage,
			stopReason: "stop",
			content: [{ type: "text", text: "first answer" }],
		};
		const deltas: ConversationDelta[] = [];
		let consumer = projection.snapshot();
		projection.subscribe(batch => {
			deltas.push(...batch);
			consumer = applyConversationDeltas(consumer, batch);
		});
		try {
			// 原生提醒无 message 事件，assistant 的临时 ordinal 比持久 ordinal 少一。
			entries.push({
				type: "message",
				id: "reminder",
				parentId: "input",
				timestamp: new Date(200).toISOString(),
				message: { role: "developer", content: [{ type: "text", text: "native reminder" }], timestamp: 200 },
			});
			projection.applyEvent({ type: "message_start", message: assistant });
			const before = projection.rows().find(row => row.kind === "assistantText")!;
			const target = { rowId: before.rowId, entityId: before.entityId! };
			expect(() => projection.resolveTarget(target)).toThrow("guard.rowNotPersisted");
			entries.push({
				type: "message",
				id: "answer-one",
				parentId: "reminder",
				timestamp: new Date(300).toISOString(),
				message: assistant,
			});
			deltas.length = 0;
			projection.applyEvent({ type: "message_end", message: assistant });
			expect(projection.rows().find(row => row.kind === "assistantText")).toMatchObject(target);
			expect(projection.resolveTarget(target).entryId).toBe("answer-one");
			expect(deltas.some(delta => delta.op === "row.removed" || delta.op === "row.appended")).toBe(false);
			expect(consumer.rows.window).toEqual(projection.rows());
			projection.resetEpoch();
			expect(projection.resolveTarget(target).entryId).toBe("answer-one");
			// 同时间戳的另一消息不能复用已发布实体；target 解析依据真实 entry 而非时间戳。
			const next = { ...assistant, content: [{ type: "text" as const, text: "second answer" }] };
			projection.applyEvent({ type: "message_start", message: next });
			entries.push({
				type: "message",
				id: "answer-two",
				parentId: "answer-one",
				timestamp: new Date(300).toISOString(),
				message: next,
			});
			projection.applyEvent({ type: "message_end", message: next });
			const second = projection.rows().find(row => row.kind === "assistantText" && row.text === "second answer")!;
			expect(second.entityId).not.toBe(target.entityId);
			expect(projection.resolveTarget({ rowId: second.rowId, entityId: second.entityId! }).entryId).toBe(
				"answer-two",
			);
			// 切到相同 ordinal/时间戳的真正新 branch，再切回旧 branch，均保留各自身份。
			const original = entries.slice();
			entries.splice(2, 2, {
				type: "message",
				id: "branch-answer",
				parentId: "reminder",
				timestamp: new Date(300).toISOString(),
				message: { ...assistant, content: [{ type: "text", text: "branch answer" }] },
			});
			projection.resetEpoch();
			const branch = projection.rows().find(row => row.kind === "assistantText")!;
			expect(branch.entityId).not.toBe(target.entityId);
			expect(() => projection.resolveTarget(target)).toThrow("guard.staleRowTarget");
			entries.splice(0, entries.length, ...original);
			projection.resetEpoch();
			expect(projection.resolveTarget(target).entryId).toBe("answer-one");
			expect(projection.resolveTarget({ rowId: second.rowId, entityId: second.entityId! }).entryId).toBe(
				"answer-two",
			);
		} finally {
			projection.dispose();
		}
	});

	it("uses native child identity for progress drilldown despite provider session overrides and keeps cold fallback", () => {
		const child = projectionSession([]);
		const nativeChild = {
			...child,
			sessionId: "provider-override",
			sessionManager: { ...child.sessionManager, getSessionId: () => "native-child" },
		} as unknown as AgentSession;
		const registry = new AgentRegistry();
		registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Main", session: nativeChild });
		const assistant: AssistantMessage = {
			role: "assistant",
			timestamp: 200,
			api: "openai-completions",
			provider: "local",
			model: "mock",
			usage,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "spawn", name: "task", arguments: { tasks: [] } }],
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			timestamp: 201,
			toolCallId: "spawn",
			toolName: "task",
			isError: false,
			content: [{ type: "text", text: "child progress" }],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 1,
				progress: [{ id: "Child", agent: "scout", status: "running", task: "inspect child" }],
			},
		};
		for (const live of [true, false]) {
			const projection = new ZCodeProjection({
				sessionId: "parent",
				cwd: "/work",
				messages: [user("child"), assistant, result],
				registry: live ? registry : undefined,
				childSessions: { Child: "native-child" },
			});
			try {
				expect(projection.rows().find(row => row.kind === "subagent")).toMatchObject({
					childSessionId: "native-child",
				});
				if (live) expect(projection.snapshot().subagents?.childSessionIds).toEqual(["native-child"]);
			} finally {
				projection.dispose();
			}
		}
	});

	it("keeps existing rowIds and appends late task child rows in rowId order", () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			timestamp: 200,
			api: "openai-completions",
			provider: "local",
			model: "mock",
			usage,
			stopReason: "toolUse",
			content: [
				{
					type: "toolCall",
					id: "spawn",
					name: "task",
					arguments: { i: "check", tasks: [{ task: "actual child work", agent: "scout" }] },
				},
				{ type: "text", text: "spawning now" },
			],
		};
		const projection = new ZCodeProjection({ sessionId: "stable", cwd: "/work" });
		const batches: ConversationDelta[][] = [];
		projection.subscribe(deltas => batches.push(deltas));
		try {
			projection.applyEvent({ type: "message_end", message: user("start") });
			projection.applyEvent({ type: "agent_start" });
			projection.applyEvent({ type: "message_start", message: assistant });
			projection.applyEvent({ type: "message_end", message: assistant });
			const rowsBefore = projection.rows();
			const textBefore = rowsBefore.findLast(row => row.kind === "assistantText")!;
			const toolBefore = rowsBefore.find(row => row.kind === "toolCall")!;
			// 迟到的 task receipt(progress)产生新子行;既有行必须保留稳定 rowId,
			// 对外窗口按 rowId 排序,不能按内容位置把新大 ID 插进旧行之间。
			projection.applyEvent({
				type: "message_end",
				message: {
					role: "toolResult",
					timestamp: 300,
					toolCallId: "spawn",
					toolName: "task",
					isError: false,
					content: [{ type: "text", text: "Spawned agent `Child` (job `Child`)." }],
					details: {
						projectAgentsDir: null,
						results: [],
						totalDurationMs: 1,
						progress: [{ id: "Child", agent: "scout", status: "running", task: "actual child work" }],
					},
				} as ToolResultMessage,
			});
			const rowsAfter = projection.rows();
			const child = rowsAfter.find(row => row.kind === "subagent")!;
			const textAfter = rowsAfter.findLast(row => row.kind === "assistantText")!;
			// 既有行 rowId/entityId 原样保留;迟到子行取全新单调 rowId,排在既有行之后。
			expect(textAfter).toMatchObject({ rowId: textBefore.rowId, entityId: textBefore.entityId });
			expect(rowsAfter.find(row => row.kind === "userInput")).toMatchObject({
				rowId: rowsBefore.find(row => row.kind === "userInput")!.rowId,
			});
			expect(rowsAfter.indexOf(child)).toBe(rowsAfter.length - 1);
			expect(rowsAfter.map(row => row.rowId)).toEqual([...rowsBefore.map(row => row.rowId), child.rowId]);
			expect(child.rowId).toBeGreaterThan(Math.max(...rowsBefore.map(row => row.rowId)));
			// delta 语义:新行 row.appended;既有行中只有真实变化的 toolCall 行被 upsert,
			// 未变化的 text/header/input 行不再因索引错位被整行 upsert。
			const touched: Array<{ rowId: number; op: string }> = [];
			for (const delta of batches.at(-1) ?? []) {
				if (delta.op === "row.appended" || delta.op === "row.upserted")
					touched.push({ rowId: delta.row.rowId, op: delta.op });
				else if (delta.op === "row.delta") touched.push({ rowId: delta.rowId, op: delta.op });
			}
			expect(touched).toEqual([
				{ rowId: toolBefore.rowId, op: "row.upserted" },
				{ rowId: child.rowId, op: "row.appended" },
			]);
		} finally {
			projection.dispose();
		}
	});

	it("keeps user row rowIds through a compact pseudo-message inserted by timestamp on epoch reset", () => {
		// #restoreCompactions 按时间戳把 compact 伪消息插进消息序列 —— 这正是位置型 rowId
		// 漂移的来源;reset 后同一实体的行必须保持原 rowId,compact 行取新单调 id。
		const message = (inputId: string, timestamp: number, id: string): SessionEntry => ({
			type: "message",
			id,
			parentId: null,
			timestamp: new Date(timestamp).toISOString(),
			message: { role: "user", content: inputId, timestamp, inputId } as AgentUserMessage,
		});
		const entries: SessionEntry[] = [message("one", 100, "u1"), message("two", 200, "u2")];
		const projection = new ZCodeProjection({
			sessionId: "stable",
			cwd: "/work",
			session: projectionSession(entries),
		});
		try {
			const inputsBefore = projection.rows().filter(row => row.kind === "userInput");
			expect(inputsBefore).toHaveLength(2);
			entries.splice(
				0,
				entries.length,
				{ type: "reset_boundary", id: "rb", parentId: null, timestamp: new Date(300).toISOString() },
				message("one", 100, "u1"),
				{
					type: "compaction",
					id: "compact-entry",
					parentId: "u1",
					timestamp: new Date(150).toISOString(),
					summary: "summary",
					firstKeptEntryId: "u1",
					tokensBefore: 100,
					origin: "manual",
					operationId: "op",
				},
				message("two", 200, "u2"),
				message("three", 250, "u3"),
			);
			projection.refresh();
			const rows = projection.rows();
			const marker = rows.find(row => row.kind === "timelineMarker")!;
			expect(marker).toMatchObject({ marker: { origin: "manual", status: "success" } });
			// 两个既有 user 行的 rowId 不因中途插入 compact 行而漂移。
			expect(
				rows
					.filter(row => row.kind === "userInput")
					.slice(0, 2)
					.map(row => row.rowId),
			).toEqual(inputsBefore.map(row => row.rowId));
			// compact 行虽按时间戳插入消息,对外仍按稳定 rowId 排在两个既有 user turn 之后。
			const markerIndex = rows.indexOf(marker);
			expect(markerIndex).toBeGreaterThan(rows.findIndex(row => row.rowId === inputsBefore.at(-1)!.rowId));
			expect(marker.rowId).toBeGreaterThan(Math.max(...inputsBefore.map(row => row.rowId)));
		} finally {
			projection.dispose();
		}
	});
});

describe("canonical session modelSelection", () => {
	const selectionEntry = (data: unknown, id = "sel", parentId = "e0"): SessionEntry =>
		({
			type: "custom",
			id,
			parentId,
			timestamp: new Date(150).toISOString(),
			customType: "zcode_model_selection",
			data,
		}) as SessionEntry;
	const historyEntry = (message: AgentUserMessage, id: string, parentId: string | null): SessionEntry => ({
		type: "message",
		id,
		parentId,
		timestamp: new Date(message.timestamp ?? 0).toISOString(),
		message,
	});

	it("restores the accepted sparse intent from the journal and keeps it through refresh and re-acceptance", () => {
		const entries: SessionEntry[] = [
			historyEntry(user("first"), "e0", null),
			selectionEntry({ providerId: "omp-e2e", modelId: "omp-alternate", options: { reasoningLevel: "disabled" } }),
		];
		const projection = new ZCodeProjection({ sessionId: "b", cwd: "/work", session: projectionSession(entries) });
		try {
			// 冷构造:canonical modelSelection 直接从 journal 派生,B 保持 omp-alternate + disabled,
			// 不用 effective provider/model/thought 伪造(缺陷1)。
			expect(projection.snapshot().config.modelSelection).toEqual({
				providerId: "omp-e2e",
				modelId: "omp-alternate",
				options: { reasoningLevel: "disabled" },
			});
			// server #model 写回的新选择成为会话事实;renderer 刷新只更新 effective,不丢意图。
			projection.acceptModelSelection({ providerId: "omp-chat", modelId: "omp-main" });
			projection.refresh();
			expect(projection.snapshot().config.modelSelection).toEqual({
				providerId: "omp-chat",
				modelId: "omp-main",
			});
			// rewind 截断掉持久化记录后 resetEpoch 按 remaining branch 重derive,不留陈旧意图。
			entries.splice(1, 1);
			projection.resetEpoch();
			expect(projection.snapshot().config.modelSelection).toBeUndefined();
		} finally {
			projection.dispose();
		}
	});

	it("ignores invalid persisted records instead of degrading into a fabricated selection", () => {
		const entries: SessionEntry[] = [
			historyEntry(user("first"), "e0", null),
			selectionEntry({ providerId: "", modelId: "x" }),
		];
		const projection = new ZCodeProjection({ sessionId: "b", cwd: "/work", session: projectionSession(entries) });
		try {
			expect(projection.snapshot().config.modelSelection).toBeUndefined();
		} finally {
			projection.dispose();
		}
	});
});

describe("native fork boundary projection", () => {
	const reply = (timestamp: number, text: string): AssistantMessage => ({
		role: "assistant",
		timestamp,
		api: "openai-completions",
		provider: "local",
		model: "mock",
		usage,
		stopReason: "stop",
		content: [{ type: "text", text }],
	});
	const journal = (messages: Array<AgentUserMessage | AssistantMessage>): SessionEntry[] =>
		messages.map((message, index) => ({
			type: "message",
			id: `e${index}`,
			parentId: index ? `e${index - 1}` : null,
			timestamp: new Date(message.timestamp ?? 0).toISOString(),
			message,
		})) as SessionEntry[];
	const forkSession = (entries: SessionEntry[], parentSession?: string): AgentSession => {
		const base = projectionSession(entries);
		return {
			...base,
			sessionManager: {
				...base.sessionManager,
				getHeader: () => (parentSession ? ({ id: "child", parentSession } as never) : null),
			},
		} as unknown as AgentSession;
	};

	it("projects a durable forkNotice turn-tail boundary only for genuine parent linkage", () => {
		const history = [user("first"), reply(200, "forked reply")];
		const entries = journal(history);
		const projection = new ZCodeProjection({
			sessionId: "child",
			cwd: "/work",
			session: forkSession(entries, "session_parent"),
			parentSessionId: "session_parent",
			inheritedMessageCount: 2,
		});
		try {
			const rows = projection.rows();
			const marker = rows.find(row => row.kind === "timelineMarker");
			expect(marker).toMatchObject({
				lane: "turnTailBoundary",
				marker: { type: "forkNotice", parentSessionId: "session_parent", parentRowId: 0 },
			});
			// 分割线在首 turn 卡片/actions 之后 = 首 turn 行尾(当前也是窗口末行);行全序 rowId 升序。
			expect(rows.at(-1)).toBe(marker);
			expect([...rows.map(row => row.rowId)].sort((a, b) => a - b)).toEqual(rows.map(row => row.rowId));
			// 子会话继续对话:新 turn 行落在分割线之后,marker 的 rowId 与位置稳定。
			const markerRowId = marker!.rowId;
			projection.applyEvent({ type: "message_end", message: { ...user("second"), timestamp: 300 } });
			const grown = projection.rows();
			const markerIndex = grown.findIndex(row => row.rowId === markerRowId);
			expect(grown.filter(row => row.kind === "userInput")).toHaveLength(2);
			expect(markerIndex).toBeGreaterThan(grown.findIndex(row => row.kind === "userInput"));
			expect(markerIndex).toBeLessThan(grown.findLastIndex(row => row.kind === "userInput"));
			// 分割线紧跟在首 turn 行尾:下一行就是第二 turn 的 header,不会漂进新 turn 内部。
			expect(grown[markerIndex + 1].kind).toBe("turnHeader");
			expect([...grown.map(row => row.rowId)].sort((a, b) => a - b)).toEqual(grown.map(row => row.rowId));
			// 冷恢复(live journal ↔ parentSessionId 注入)产出完全一致的行。canFork 是
			// live journal 目标的权威 action,冷投影(仅 messages)本来就不提供,比较时排除。
			const cold = new ZCodeProjection({
				sessionId: "child",
				cwd: "/work",
				messages: history,
				parentSessionId: "session_parent",
				inheritedMessageCount: 2,
			});
			const liveAgain = new ZCodeProjection({
				sessionId: "child",
				cwd: "/work",
				session: forkSession(journal(history), "session_parent"),
				parentSessionId: "session_parent",
				inheritedMessageCount: 2,
			});
			try {
				const withoutActions = (rows: ReturnType<ZCodeProjection["rows"]>) =>
					rows.map(row => ({ ...row, actions: undefined }));
				expect(withoutActions(cold.rows())).toEqual(withoutActions(liveAgain.rows()));
				expect(cold.rows().find(row => row.kind === "timelineMarker")).toMatchObject({
					lane: "turnTailBoundary",
					marker: { type: "forkNotice", parentSessionId: "session_parent" },
				});
			} finally {
				liveAgain.dispose();
			}
		} finally {
			projection.dispose();
		}
	});

	it("keeps every inherited turn before the later fork boundary across continuation and cold reconstruction", () => {
		const history = [
			user("first"),
			reply(200, "first reply"),
			{ ...user("second"), timestamp: 300 },
			reply(400, "selected reply"),
		];
		const projection = new ZCodeProjection({
			sessionId: "child",
			cwd: "/work",
			session: forkSession(journal(history), "session_parent"),
			parentSessionId: "session_parent",
			inheritedMessageCount: 4,
		});
		try {
			expect(projection.rows().at(-1)).toMatchObject({ kind: "timelineMarker", lane: "turnTailBoundary" });
			const marker = projection.rows().at(-1)!;
			const continuation = { ...user("child"), timestamp: 500 };
			projection.applyEvent({ type: "message_end", message: continuation });
			const cold = new ZCodeProjection({
				sessionId: "child",
				cwd: "/work",
				messages: [...history, continuation],
				parentSessionId: "session_parent",
				inheritedMessageCount: 4,
			});
			try {
				for (const rows of [projection.rows(), cold.rows()]) {
					const boundary = rows.findIndex(row => row.kind === "timelineMarker");
					expect(rows.slice(0, boundary).filter(row => row.kind === "userInput")).toHaveLength(2);
					expect(rows[boundary - 1]).toMatchObject({ kind: "assistantText", text: "selected reply" });
					expect(rows[boundary]).toMatchObject({
						rowId: marker.rowId,
						marker: { parentSessionId: "session_parent" },
					});
					expect(rows[boundary + 1].kind).toBe("turnHeader");
					expect(rows.map(row => row.rowId)).toEqual(rows.map(row => row.rowId).sort((a, b) => a - b));
				}
			} finally {
				cold.dispose();
			}
		} finally {
			projection.dispose();
		}
	});

	it("never synthesizes a fork divider without durable parent linkage", () => {
		const projection = new ZCodeProjection({
			sessionId: "plain",
			cwd: "/work",
			session: forkSession(journal([user("first"), reply(200, "plain reply")]), undefined),
		});
		try {
			expect(projection.rows().some(row => row.kind === "timelineMarker")).toBe(false);
		} finally {
			projection.dispose();
		}
	});
});

describe("yielded awaiting background settle", () => {
	it("publishes the idle composer form together with live cancellable background work and keeps wake semantics", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		manager.register("bash", "bg", () => pending.promise, { id: "bg-1", ownerId: "parent" });
		const projection = new ZCodeProjection({
			sessionId: "yield",
			cwd: "/work",
			session: projectionSession([], manager),
			messages: [user("ask")],
		});
		try {
			const final: AssistantMessage = {
				role: "assistant",
				timestamp: 200,
				api: "openai-completions",
				provider: "local",
				model: "mock",
				usage,
				stopReason: "stop",
				content: [{ type: "text", text: "handed off to background" }],
			};
			projection.applyEvent({ type: "agent_start" });
			projection.applyEvent({ type: "message_end", message: final });
			projection.applyEvent({ type: "agent_end", messages: [final], isTerminal: false, awaitingAsyncWork: true });
			// 合同内的 yielded-awaiting-background 形态(缺陷3):前台回合已收口 → phase=completed*、
			// composer 满足 idle 判定(canStop=false 且 stopState=idle,Root 无 Stop 按钮);
			// 同一快照仍携带 running/cancellable 的后台事实,保留 cancelBackgroundWork 停止语义。
			expect(projection.snapshot().control).toMatchObject({
				phase: "completedSuccess",
				sessionEnded: true,
				canStop: false,
				stopState: "idle",
				activeWorks: [],
			});
			expect(projection.snapshot().backgroundWorks).toEqual([
				expect.objectContaining({ workId: "bg-1", kind: "bash", status: "running", cancellable: true }),
			]);
			expect(projection.rows().find(row => row.kind === "assistantText")).toMatchObject({ state: "complete" });
			// 后台结果唤醒:新 turn 重新进入 running,停止语义恢复。
			projection.applyEvent({ type: "agent_start" });
			expect(projection.snapshot().control).toMatchObject({
				phase: "running",
				canStop: true,
				stopState: "stoppable",
			});
		} finally {
			projection.dispose();
			manager.cancel("bg-1");
			pending.resolve("background settled");
			await manager.dispose();
		}
	});
});

describe("native turn header execution lifecycle", () => {
	const reply = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
		role: "assistant",
		timestamp: 1_000,
		api: "openai-completions",
		provider: "local",
		model: "mock",
		usage,
		stopReason: "stop",
		content: [{ type: "text", text: "done" }],
		...overrides,
	});

	it.each(["stop", "aborted", "error"] as const)(
		"publishes running before first content and settles %s with stable native timing",
		stopReason => {
			let now = 1_000;
			const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
			const oldInput = user("old");
			const oldReply = reply({ timestamp: 200, completedAt: 400, duration: 200 });
			const input = { ...user("current"), timestamp: 1_000 };
			const projection = new ZCodeProjection({
				sessionId: "header",
				cwd: "/work",
				messages: [oldInput, oldReply, input],
			});
			let consumer = projection.snapshot();
			projection.subscribe(deltas => {
				consumer = applyConversationDeltas(consumer, deltas);
				expect(consumer.rows).toEqual(projection.snapshot().rows);
				const current = consumer.rows.window.findLast(
					row => row.kind === "turnHeader" && row.executionKind === "agent",
				);
				if (consumer.control.canStop) expect(current).toMatchObject({ state: "running" });
			});
			const header = (id: string) =>
				consumer.rows.window.find(row => row.kind === "turnHeader" && row.sourceCommandId === id);
			try {
				const historical = structuredClone(header("old"));
				projection.applyEvent({ type: "agent_start" });
				now = 5_000;
				expect(header("current")).toMatchObject({ state: "running", startedAt: 1_000 });
				expect(header("old")).toEqual(historical);
				// 首内容之前 consumer 已能以同一 running header 的 startedAt 计算工作时长。
				expect(consumer.control).toMatchObject({ phase: "running", canStop: true });
				const final = reply({ stopReason, completedAt: 5_000, duration: 4_000 });
				projection.applyEvent({ type: "message_end", message: final });
				projection.applyEvent({ type: "agent_end", messages: [final], isTerminal: false });
				expect(header("current")).toMatchObject({ state: "running" });
				now = 6_000;
				projection.applyEvent({ type: "agent_end", messages: [final], isTerminal: true });
				expect(header("current")).toMatchObject({
					state:
						stopReason === "stop"
							? "completedSuccess"
							: stopReason === "aborted"
								? "completedInterrupted"
								: "failed",
					endedAt: 5_000,
					activeMs: 4_000,
				});
				expect(consumer.control.canStop).toBe(false);
				const settled = structuredClone(header("current"));
				now = 50_000;
				projection.applyEvent({ type: "agent_end", messages: [final], isTerminal: true });
				expect(header("current")).toEqual(settled);
				const cold = new ZCodeProjection({
					sessionId: "header",
					cwd: "/work",
					messages: [oldInput, oldReply, input, final],
				});
				try {
					expect(cold.rows()).toEqual(consumer.rows.window);
				} finally {
					cold.dispose();
				}
				projection.applyEvent({ type: "message_end", message: { ...user("next"), timestamp: now } });
				projection.applyEvent({ type: "agent_start" });
				expect(header("current")).toEqual(settled);
				expect(header("old")).toEqual(historical);
			} finally {
				projection.dispose();
				clock.mockRestore();
			}
		},
	);

	it("keeps tool-only and pending user work running, without inventing active tool duration", () => {
		let now = 1_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const input = { ...user("tool"), timestamp: now };
		const projection = new ZCodeProjection({ sessionId: "tool", cwd: "/work", messages: [input] });
		let consumer = projection.snapshot();
		projection.subscribe(deltas => {
			consumer = applyConversationDeltas(consumer, deltas);
		});
		const header = () => consumer.rows.window.find(row => row.kind === "turnHeader");
		const assistant = reply({
			stopReason: "toolUse",
			completedAt: 2_000,
			duration: 1_000,
			content: [{ type: "toolCall", id: "ask-call", name: "ask", arguments: {} }],
		});
		try {
			projection.applyEvent({ type: "agent_start" });
			now = 2_000;
			projection.applyEvent({ type: "message_end", message: assistant });
			projection.applyEvent({ type: "tool_execution_start", toolCallId: "ask-call", toolName: "ask", args: {} });
			now = 62_000;
			expect(header()).toMatchObject({ state: "running" });
			expect(consumer.control.canStop).toBe(true);
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "ask-call",
				toolName: "ask",
				timestamp: now,
				isError: false,
				content: [{ type: "text", text: "user answered" }],
			};
			projection.applyEvent({
				type: "tool_execution_end",
				toolCallId: "ask-call",
				toolName: "ask",
				result: { content: result.content, details: {} },
				isError: false,
			});
			projection.applyEvent({ type: "message_end", message: result });
			expect(header()).toMatchObject({ state: "running" });
			projection.applyEvent({ type: "agent_end", messages: [assistant, result], isTerminal: true });
			expect(header()).toMatchObject({ state: "completedSuccess", endedAt: 62_000 });
			expect(header()).not.toHaveProperty("activeMs");
			const settled = structuredClone(header());
			now = 100_000;
			projection.applyEvent({ type: "agent_end", messages: [], isTerminal: true });
			expect(header()).toEqual(settled);
			const cold = new ZCodeProjection({ sessionId: "tool", cwd: "/work", messages: [input, assistant, result] });
			try {
				expect(cold.rows()).toEqual(consumer.rows.window);
			} finally {
				cold.dispose();
			}
		} finally {
			projection.dispose();
			clock.mockRestore();
		}
	});

	it("merges overlapping native request intervals and leaves legacy unknown timing absent", () => {
		const projection = new ZCodeProjection({
			sessionId: "timing",
			cwd: "/work",
			messages: [
				user("measured"),
				reply({ timestamp: 100, completedAt: 1_000, duration: 900 }),
				reply({ timestamp: 900, completedAt: 2_000, duration: 1_100 }),
				// journal 恢复按原生 timestamp 排序；后续用户输入不能沿用 helper 的 100，
				// 否则第二个请求会如实归入 legacy turn，失去区间合并的测试前提。
				{ ...user("legacy"), timestamp: 2_500 },
				reply({ timestamp: 3_000 }),
			],
		});
		try {
			const headers = projection.rows().filter(row => row.kind === "turnHeader");
			expect(headers[0]).toMatchObject({ endedAt: 2_000, activeMs: 1_900 });
			expect(headers[1]).not.toHaveProperty("endedAt");
			expect(headers[1]).not.toHaveProperty("activeMs");
		} finally {
			projection.dispose();
		}
	});
});
