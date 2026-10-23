import { describe, expect, test } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent, AgentSessionEventListener } from "../../src/session/agent-session-events";
import { ZCodeProjection } from "../../src/modes/zcode/projection";
import { AsyncJobManager } from "../../src/async/job-manager";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { SessionEntry } from "../../src/session/session-entries";
import { OmpTeamBridge, readOmpTeamJournal } from "../../src/modes/zcode/team";
import type { ZCodeSessionRecord } from "../../src/modes/zcode/sessions";
import { EventBus } from "../../src/utils/event-bus";
import {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../src/task/types";

function fixture() {
	const bus = new EventBus();
	const registry = new AgentRegistry();
	const jobs = new AsyncJobManager({ maxRunningJobs: 5 });
	const entries: SessionEntry[] = [];
	let coldReads = 0;
	const listeners = new Set<AgentSessionEventListener>();
	const record = {
		id: "root",
		cwd: "/fixture",
		registry,
		session: {
			eventBus: bus,
			subagentEventBus: bus,
			asyncJobManager: jobs,
			getAgentId: () => "Main",
			subscribe: (listener: AgentSessionEventListener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			sessionManager: {
				getBranch: () => entries,
				getBranchView: () => entries,
				appendCustomEntry: (customType: string, data: unknown) => {
					entries.push({
						type: "custom",
						customType,
						data,
						id: `entry-${entries.length}`,
						parentId: entries.at(-1)?.id ?? null,
						timestamp: new Date().toISOString(),
					});
				},
			},
		},
	} as unknown as ZCodeSessionRecord;
	let live = true;
	const bridge = new OmpTeamBridge({
		sessions: {
			get: id => (live && id === record.id ? record : undefined),
			read: async () => {
				coldReads++;
				return { entries };
			},
		},
	});
	bridge.observeSession(record);
	return {
		bridge,
		bus,
		jobs,
		registry,
		record,
		entries,
		emit: (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event);
		},
		cold: () => {
			bridge.detach(record.id);
			live = false;
		},
		coldReads: () => coldReads,
	};
}

async function read(bridge: OmpTeamBridge, jobId: string) {
	const response = await bridge.handle({ action: "read", sessionId: "root", jobId });
	if (!("run" in response)) throw new Error("Expected run");
	return response.run;
}

describe("omp/team native observation bridge", () => {
	test("coalesces equivalent progress and flushes changed facts and final child failure for cold recovery", async () => {
		const f = fixture();
		const ready = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const jobId = f.jobs.register(
			"task",
			"/team progress",
			async ({ reportProgress }) => {
				await reportProgress("investigating", {
					stage: "investigation",
					participants: [{ label: "A", status: "running" }],
				});
				ready.resolve();
				await finish.promise;
				return {
					text: "failed",
					structured: {
						source: "none",
						mode: "permissive",
						status: "unavailable",
						data: {
							status: "failed",
							failureReason: "review rejected",
							reportMarkdown: "native failure report",
							subagentResults: [
								{
									label: "team-proposal-A",
									outcome: { data: { finding: "preserved" }, error: "child failed" },
								},
							],
						},
					},
				};
			},
			{ ownerId: "Main", suppressDelivery: true },
		);
		await ready.promise;
		await logger.withLogContext({ job_id: jobId }, async () => {
			const id = "native.team-proposal-A";
			f.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id, status: "started" });
			const snapshots = f.entries.length;
			for (let durationMs = 0; durationMs < 50; durationMs++) {
				f.bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
					id,
					progress: { status: "running", currentTool: "read", resolvedModel: "provider/first", durationMs },
				});
			}
			f.bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				id,
				progress: { status: "running", currentTool: "grep", resolvedModelIdentity: "provider/resolved" },
			});
			expect(f.entries).toHaveLength(snapshots);
			const run = await read(f.bridge, jobId);
			expect(run.stage).toBe("investigation");
			expect(run.participants).toEqual([{ label: "A", status: "running" }]);
			expect(run.timeline.filter(item => item.kind === "progress").map(item => item.data)).toEqual([
				{ status: "running", currentTool: "read", model: "provider/first" },
				{ status: "running", currentTool: "grep", model: "provider/resolved" },
			]);
			expect(f.entries).toHaveLength(snapshots + 1);
			f.bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				id,
				progress: { status: "failed", resolvedModel: "provider/resolved" },
			});
			expect(readOmpTeamJournal("root", f.entries).get(jobId)!.nodes[0].status).toBe("failed");
		});
		finish.resolve();
		await f.jobs.getJob(jobId)!.promise;
		const run = await read(f.bridge, jobId);
		expect(run.status).toBe("failed");
		expect(run.nodes[0].output).toEqual({ finding: "preserved" });
		expect(run.nodes[0].error).toBe("child failed");
		f.cold();
		const restored = await read(f.bridge, jobId);
		expect(restored.status).toBe("failed");
		expect(restored.error).toBe("review rejected");
		expect(restored.report).toBe("native failure report");
		expect(restored.stage).toBe("investigation");
		expect(restored.participants).toEqual(run.participants);
		expect(restored.nodes).toEqual(run.nodes);
		expect(restored.timeline).toEqual(run.timeline);
		f.bridge.dispose();
	});

	test("does not serialize settled results again for unrelated stream deltas or unchanged job samples", async () => {
		const f = fixture();
		let serialized = 0;
		const result = {
			status: "completed",
			reportMarkdown: "large final report",
			subagentResults: [],
			toJSON() {
				serialized++;
				return { status: this.status, reportMarkdown: this.reportMarkdown, subagentResults: this.subagentResults };
			},
		};
		const jobId = f.jobs.publishCompleted(
			"task",
			"/team settled",
			{ text: "done", structured: { source: "none", mode: "permissive", status: "unavailable", data: result } },
			{ ownerId: "Main" },
		);
		const run = await read(f.bridge, jobId);
		const snapshots = f.entries.length;
		const timeline = [...run.timeline];
		const initialSerializations = serialized;
		expect(initialSerializations).toBeGreaterThan(0);
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "unrelated chat" }],
			api: "openai-responses",
			provider: "openai",
			model: "fixture",
			usage: {} as AssistantMessage["usage"],
			stopReason: "stop",
			timestamp: 1,
		};
		for (let index = 0; index < 30; index++) {
			f.emit({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "chat", partial: message },
			});
			f.emit({ type: "agent_start" });
			await read(f.bridge, jobId);
		}
		expect(serialized).toBe(initialSerializations);
		expect(f.entries).toHaveLength(snapshots);
		expect(run.timeline).toEqual(timeline);
		expect(run.report).toBe("large final report");
		f.cold();
		const restored = await read(f.bridge, jobId);
		expect(restored.status).toBe("completed");
		expect(restored.result).toEqual({
			status: "completed",
			reportMarkdown: "large final report",
			subagentResults: [],
		});
		expect(serialized).toBe(initialSerializations);
		f.bridge.dispose();
	});

	test("anchors concurrent same-model jobs to exact public dispatch rows through refresh and cold recovery", async () => {
		const f = fixture();
		const { promise, resolve } = Promise.withResolvers<void>();
		const jobIds = [0, 1].map(() =>
			f.jobs.register(
				"task",
				"/team identical question",
				async () => {
					await promise;
					return "done";
				},
				{ ownerId: "Main", suppressDelivery: true },
			),
		);
		const timestamp = "2026-10-23T00:00:00.000Z";
		const append = (customType: string, display: boolean, details?: unknown) => {
			f.entries.push({
				type: "custom_message",
				id: `native-${f.entries.length}`,
				parentId: f.entries.at(-1)?.id ?? null,
				timestamp,
				customType,
				display,
				content: "identical question",
				details,
			});
		};
		append("hidden", false);
		append("notice", true);
		for (const [index, jobId] of jobIds.entries()) {
			append("team-dispatch", true, { jobId, question: "identical question" });
			await logger.withLogContext({ job_id: jobId }, async () => {
				const id = `native-${index}.team-proposal-A`;
				f.registry.register({
					id,
					displayName: "team-proposal-A",
					kind: "sub",
					session: null,
					history: { resolvedModel: "provider/same" },
				});
				f.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
					id,
					agent: "team-proposer",
					status: "started",
				});
			});
		}
		// 消费真实 projection 的公开行，不由测试重复拼接 entityId 算法。
		const messages = f.entries.flatMap(entry =>
			entry.type === "custom_message" && entry.display
				? [
						{
							role: "custom",
							customType: entry.customType,
							content: entry.content,
							display: entry.display,
							details: entry.details,
							timestamp: new Date(entry.timestamp).getTime(),
						} as AgentMessage,
					]
				: [],
		);
		const projection = new ZCodeProjection({
			sessionId: "root",
			cwd: "/fixture",
			messages,
			entries: f.entries,
		});
		const dispatchRows = projection
			.snapshot()
			.rows.window.filter(row => row.kind === "assistantText")
			.slice(1);
		expect(dispatchRows).toHaveLength(2);
		expect(dispatchRows[0].entityId).not.toBe(dispatchRows[1].entityId);
		for (const [index, jobId] of jobIds.entries()) {
			const live = await read(f.bridge, jobId);
			expect(live.dispatchEntityId).toBe(dispatchRows[index].entityId);
			expect(live.nodes.map(node => node.id)).toEqual([`native-${index}.team-proposal-A`]);
			expect(live.nodes[0].model).toBe("provider/same");
			expect((await read(f.bridge, jobId)).dispatchEntityId).toBe(live.dispatchEntityId);
		}
		resolve();
		await Promise.all(jobIds.map(jobId => f.jobs.getJob(jobId)!.promise));
		f.cold();
		for (const [index, jobId] of jobIds.entries()) {
			const restored = await read(f.bridge, jobId);
			expect(restored.source).toBe("native-journal");
			expect(restored.dispatchEntityId).toBe(dispatchRows[index].entityId);
			expect(restored.nodes.map(node => node.id)).toEqual([`native-${index}.team-proposal-A`]);
		}
		expect(f.coldReads()).toBe(2);
		f.bridge.dispose();
	});

	test("keeps same-model calls distinct, target edges and native final yields through cold recovery", async () => {
		const f = fixture();
		const { promise: gate, resolve: finish } = Promise.withResolvers<void>();
		const jobId = f.jobs.register(
			"task",
			"/team compare",
			async () => {
				await gate;
				return {
					text: "done",
					structured: {
						source: "none",
						mode: "permissive",
						status: "unavailable",
						data: {
							status: "completed",
							subagentResults: [
								{
									label: "team-review-A",
									modelPattern: "provider/same",
									role: "reviewer",
									outcome: { ok: true, data: { reviewSummary: "evidence" } },
								},
							],
						},
					},
				};
			},
			{ ownerId: "Main", suppressDelivery: true },
		);
		await logger.withLogContext({ job_id: jobId }, async () => {
			for (const name of ["team-proposal-A", "team-proposal-B", "team-review-A"]) {
				const id = `team-native.${name}`;
				f.registry.register({
					id,
					displayName: name,
					kind: "sub",
					session: null,
					history: { resolvedModel: "provider/same" },
				});
				f.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
					id,
					agent: name === "team-review-A" ? "team-reviewer" : "team-proposer",
					status: "started",
				});
			}
			f.bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				id: "team-native.team-review-A",
				event: {
					type: "tool_execution_end",
					toolCallId: "read-1",
					toolName: "read",
					result: { content: [{ type: "text", text: "source evidence" }] },
					isError: false,
				},
			});
			f.bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				id: "team-native.team-review-A",
				event: {
					type: "message_end",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "must not project" },
							{ type: "text", text: "accepted output" },
						],
					},
				},
			});
		});
		finish();
		await f.jobs.getJob(jobId)!.promise;
		const run = await read(f.bridge, jobId);
		expect(run.status).toBe("completed");
		expect(run.nodes.map(node => node.id)).toEqual([
			"team-native.team-proposal-A",
			"team-native.team-proposal-B",
			"team-native.team-review-A",
		]);
		expect(run.nodes.every(node => node.model === "provider/same")).toBe(true);
		expect(run.edges).toEqual([
			{
				source: "team-native.team-review-A",
				target: "team-native.team-proposal-A",
				kind: "reviews",
				evidence: "native-call-label:team-review-A",
			},
		]);
		expect(run.nodes[2].output).toEqual({ reviewSummary: "evidence" });
		expect(run.nodes[2].tools).toHaveLength(1);
		expect(JSON.stringify(run.nodes[2].messages)).not.toContain("must not project");
		f.cold();
		const restored = await read(f.bridge, jobId);
		expect(restored.source).toBe("native-journal");
		expect(restored.nodes).toEqual(run.nodes);
		expect(restored.timeline).toEqual(run.timeline);
		expect(f.coldReads()).toBe(1);
		f.bridge.dispose();
	});

	test("stop cancels the owning native job and cold stop does not create runtime", async () => {
		const f = fixture();
		const jobId = f.jobs.register(
			"task",
			"/team stop",
			async ({ signal }) => {
				const { promise, resolve } = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => resolve(), { once: true });
				await promise;
				return "cancelled";
			},
			{ ownerId: "Main", suppressDelivery: true },
		);
		await read(f.bridge, jobId);
		const response = await f.bridge.handle({ action: "stop", sessionId: "root", jobId });
		expect("accepted" in response && response.accepted).toBe(true);
		expect(f.jobs.getJob(jobId)!.abortController.signal.aborted).toBe(true);
		await f.jobs.getJob(jobId)!.promise;
		expect((await read(f.bridge, jobId)).status).toBe("cancelled");
		f.cold();
		const coldStop = await f.bridge.handle({ action: "stop", sessionId: "root", jobId });
		expect("accepted" in coldStop && coldStop.accepted).toBe(false);
		f.bridge.dispose();
	});

	test("uses native structured failure, does not infer success from a displayed report", async () => {
		const f = fixture();
		const jobId = f.jobs.publishCompleted(
			"task",
			"/team failure",
			{
				text: "audit",
				structured: {
					source: "none",
					mode: "permissive",
					status: "unavailable",
					data: { status: "failed", failureReason: "alignment failed" },
				},
			},
			{ ownerId: "Main" },
		);
		const run = await read(f.bridge, jobId);
		expect(run.status).toBe("failed");
		expect(run.error).toBe("alignment failed");
		const historical = readOmpTeamJournal("root", [
			{
				type: "custom_message",
				customType: "team-result",
				content: "report",
				display: true,
				details: { jobId: "old" },
				id: "old-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
			},
		]);
		expect(historical.get("old")!.status).toBe("unavailable");
		expect(historical.get("old")!.nodes).toEqual([]);
		f.bridge.dispose();
	});

	test("records all native stage roles and round-specific rechecks without invented synthesis edges", async () => {
		const f = fixture();
		const { promise, resolve } = Promise.withResolvers<void>();
		const jobId = f.jobs.register(
			"task",
			"/team stages",
			async () => {
				await promise;
				return "done";
			},
			{ ownerId: "Main", suppressDelivery: true },
		);
		await logger.withLogContext({ job_id: jobId }, async () => {
			for (const label of [
				"team-proposal-A",
				"team-alignment",
				"team-review-A",
				"team-revision-A-1",
				"team-recheck-A-1",
				"team-synthesis",
			]) {
				f.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: `team-run.${label}`, status: "started" });
				f.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: `team-run.${label}`, status: "completed" });
			}
		});
		resolve();
		await f.jobs.getJob(jobId)!.promise;
		const run = await read(f.bridge, jobId);
		expect(run.nodes.map(node => node.role)).toEqual([
			"proposer",
			"aligner",
			"reviewer",
			"reviser",
			"recheck",
			"synthesizer",
		]);
		expect(run.edges.map(edge => edge.kind)).toEqual(["reviews", "revises", "rechecks"]);
		expect(run.edges[2].target).toBe("team-run.team-revision-A-1");
		expect(run.unavailable).toContain("Native causal inputs for alignment/synthesis are not exposed as graph edges.");
		f.bridge.dispose();
	});

	test("rejects unknown fields and does not attach an unrelated child without native job context", async () => {
		const f = fixture();
		await expect(f.bridge.handle({ action: "list", sessionId: "root", cwd: "/other" })).rejects.toThrow("fields");
		f.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "team-other.team-proposal-A", status: "started" });
		expect(await f.bridge.handle({ action: "list", sessionId: "root" })).toEqual({ runs: [] });
		f.bridge.dispose();
	});
});
