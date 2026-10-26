import { describe, expect, it } from "bun:test";
import { ZCodeProjection } from "../../src/modes/zcode/projection";
import { ZCodeTopics } from "../../src/modes/zcode/topics";
import {
	applyConversationDelta,
	applyConversationDeltas,
	commandPayloadSchemas,
	conversationDeltaSchema,
	conversationSnapshotSchema,
	ompSpecDetailsSchema,
	ompSpecRunSchema,
	parseCommandEnvelope,
	routedTopicWireFrameSchema,
	v4ConversationSubscribeParamsSchema,
	v4ConversationWorkflowRunsParamsSchema,
	zcodeWorkflowsRunsParamsSchema,
	v4ConversationWorkflowRunArtifactsResultSchema,
	v4ConversationWorkflowRunArtifactReadParamsSchema,
	type ConversationDelta,
	type OmpSpecDetails,
	type OmpSpecRun,
	type RoutedTopicWireFrame,
} from "../../src/modes/zcode/schema";
import * as baseline from "../../src/modes/zcode/schema/vendor/zcode-protocol-v4/index";

function details(): OmpSpecDetails {
	return {
		changeId: "change",
		phase: "awaiting-plan",
		stage: "plan",
		state: "waiting",
		explanation: "Plan approval required",
		generation: 2,
		live: true,
		readOnly: false,
		workspaceIdentity: "/work",
		workspacePath: "/work",
		sessionId: "s",
		createdAt: 1,
		updatedAt: 2,
		versions: { plan: "native-token" },
		candidates: [],
		selectedCandidate: null,
		actions: [
			{
				id: "confirm-plan",
				label: "Confirm plan",
				command: "/dev confirm-plan",
				binding: { runId: "native-run", generation: 2 },
			},
		],
		interaction: {
			mode: "dev",
			draft: "Retained paused draft",
			recipient: { role: "planner", actorId: "planner-actor", sessionId: "planner-session" },
			messages: [
				{
					id: "native-message",
					text: "Explain task ordering without implementation.",
					runId: "native-run",
					generation: 2,
					phase: "awaiting-plan",
					role: "planner",
					actorId: "planner-actor",
					sessionId: "planner-session",
					status: "completed",
					reply: "The dependency is preserved; explicit approval is still required.",
				},
			],
			actions: [
				{
					id: "confirm-plan",
					label: "Approve plan and begin execution",
					command: "/dev confirm-plan",
					available: true,
				},
			],
		},
		materials: [
			{
				id: "plan",
				title: "Plan",
				readiness: "present",
				sourceVersion: "native-token",
				artifactId: "plan",
				version: 1,
			},
		],
	};
}
function run(): OmpSpecRun {
	return { runId: "native-run", status: "pending", usage: null, actors: [], nodes: [], spec: details() };
}
function complete(wire: RoutedTopicWireFrame) {
	if (wire.kind !== "complete") throw new Error("Small regression fixture unexpectedly fragmented");
	return wire.frame;
}

describe("local opt-in /dev protocol", () => {
	it("preserves default query shapes and validates explicit opt-in and sendText bindings", () => {
		const query = { sessionId: "s" };
		expect(v4ConversationWorkflowRunsParamsSchema.parse(query)).toEqual(
			baseline.v4ConversationWorkflowRunsParamsSchema.parse(query),
		);
		expect(
			v4ConversationWorkflowRunsParamsSchema.parse({ ...query, includeSpecDriven: true, runId: "native-run" }),
		).toEqual({ ...query, includeSpecDriven: true, runId: "native-run" });
		expect(v4ConversationWorkflowRunsParamsSchema.safeParse({ ...query, includeSpecDriven: false }).success).toBe(
			false,
		);
		expect(
			v4ConversationSubscribeParamsSchema.safeParse({
				topic: "conversation/s",
				connectionId: "desktop",
				clientMode: "desktop-continuous",
				includeSpecDriven: true,
			}).success,
		).toBe(true);
		const workspaceQuery = { workspace: { workspacePath: "/work", workspaceKey: "/work" }, limit: 1 };
		expect(zcodeWorkflowsRunsParamsSchema.parse(workspaceQuery)).toEqual(workspaceQuery);
		expect(zcodeWorkflowsRunsParamsSchema.parse({ ...workspaceQuery, includeSpecDriven: true })).toEqual({
			...workspaceQuery,
			includeSpecDriven: true,
		});
		expect(zcodeWorkflowsRunsParamsSchema.safeParse({ ...workspaceQuery, includeSpecDriven: "true" }).success).toBe(
			false,
		);
		const payload = { text: "/dev confirm-plan", specRun: { runId: "native-run", generation: 2 } };
		expect(commandPayloadSchemas.sendText.parse(payload)).toEqual(payload);
		const parsed = parseCommandEnvelope({
			commandId: "command",
			clientId: "client",
			sessionId: "s",
			issuedAt: 1,
			type: "sendText",
			payload,
		});
		expect(parsed.ok && parsed.envelope.payload).toEqual(payload);
		expect(
			commandPayloadSchemas.sendText.safeParse({ ...payload, specRun: { runId: "native-run", generation: -1 } })
				.success,
		).toBe(false);
		expect(
			commandPayloadSchemas.sendText.safeParse({ ...payload, specRun: { ...payload.specRun, path: "/arbitrary" } })
				.success,
		).toBe(false);
	});

	it("rejects fabricated script data, unknown metadata and cold controls", () => {
		expect(ompSpecRunSchema.parse(run())).toEqual(run());
		expect(ompSpecRunSchema.safeParse({ ...run(), toolCallId: "fake" }).success).toBe(false);
		expect(ompSpecRunSchema.safeParse({ ...run(), usage: { spentTokens: 0, nodesUsed: 0 } }).success).toBe(false);
		expect(
			ompSpecRunSchema.safeParse({ ...run(), actors: [{ siteId: "fake", ordinal: 0, status: "running" }] }).success,
		).toBe(false);
		expect(ompSpecDetailsSchema.safeParse({ ...details(), arbitrary: "unknown JSON" }).success).toBe(false);
		expect(ompSpecDetailsSchema.safeParse({ ...details(), live: false, readOnly: true }).success).toBe(false);
		expect(ompSpecDetailsSchema.parse({ ...details(), live: false, readOnly: true, actions: [] }).actions).toEqual(
			[],
		);
	});
	it("preserves full actor-bound messages and distinct cancellation states without granting transition authority", () => {
		const current = details();
		const message = current.interaction!.messages[0]!;
		for (const status of ["queued", "processing", "cancelling", "cancelled", "completed", "failed"] as const) {
			const interaction = {
				...current.interaction!,
				messages: [{ ...message, status }],
				actions: [
					{
						id: "confirm-plan",
						label: "Approve plan and begin execution",
						command: "/dev confirm-plan",
						available: false,
						blockedReason: "A stage message has not settled.",
					},
				],
			};
			const result = ompSpecDetailsSchema.parse({ ...current, interaction });
			expect(result.interaction).toEqual(interaction);
			expect(baseline.workflowRunSchema.safeParse({ ...run(), spec: result }).success).toBe(false);
		}
		expect(
			ompSpecDetailsSchema.safeParse({
				...current,
				interaction: { ...current.interaction!, messages: [{ ...message, status: "stopped" }] },
			}).success,
		).toBe(false);
		expect(
			ompSpecDetailsSchema.safeParse({
				...current,
				interaction: {
					...current.interaction!,
					recipient: { role: "outer", actorId: "fifth", sessionId: "ordinary" },
				},
			}).success,
		).toBe(false);
	});

	it("keeps real native artifact versions beyond sixteen without changing byte-read identity or bounds", () => {
		const metadata = {
			artifacts: [
				{
					id: "evidence",
					kind: "markdown" as const,
					version: 17,
					versions: Array.from({ length: 17 }, (_, index) => ({
						version: index + 1,
						publishedAt: index + 1,
						bytes: 10,
					})),
					itemCount: 0,
				},
			],
		};
		expect(v4ConversationWorkflowRunArtifactsResultSchema.parse(metadata)).toEqual(metadata);
		expect(baseline.v4ConversationWorkflowRunArtifactsResultSchema.safeParse(metadata).success).toBe(false);
		const read = { sessionId: "s", runId: "native-run", artifactId: "evidence", version: 17, offset: 0, limit: 64 };
		expect(v4ConversationWorkflowRunArtifactReadParamsSchema.parse(read)).toEqual(read);
		expect(v4ConversationWorkflowRunArtifactReadParamsSchema.safeParse({ ...read, version: 0 }).success).toBe(false);
		expect(v4ConversationWorkflowRunArtifactReadParamsSchema.safeParse({ ...read, path: "/arbitrary" }).success).toBe(
			false,
		);
		expect(
			v4ConversationWorkflowRunArtifactReadParamsSchema.safeParse({
				...read,
				limit: baseline.PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes + 1,
			}).success,
		).toBe(false);
		const summary = { id: "evidence", kind: "markdown" as const, version: 17 };
		expect(ompSpecRunSchema.parse({ ...run(), artifacts: [summary] }).artifacts).toEqual([summary]);
		expect(
			baseline.workflowRunSchema.safeParse({
				runId: "dynamic",
				status: "running",
				usage: { spentTokens: 0, nodesUsed: 0 },
				actors: [],
				nodes: [],
				lastEventSequence: 0,
				artifacts: [summary],
			}).success,
		).toBe(false);
	});

	it("reduces native compact updates alongside pinned dynamic runs and conversation rows", () => {
		const snapshot = new ZCodeProjection({ sessionId: "s", cwd: "/work" }).snapshot();
		const dynamic = baseline.workflowRunSchema.parse({
			runId: "dynamic",
			status: "running",
			usage: { spentTokens: 12, nodesUsed: 1 },
			actors: [],
			nodes: [],
			lastEventSequence: 7,
		});
		snapshot.workflowRuns = { revision: 1, runs: [dynamic, run()] };
		const row = baseline.conversationRowSchema.parse({
			rowId: 1,
			turnId: "turn",
			createdAt: 1,
			createdAtSeq: 1,
			kind: "assistantText",
			text: "Hello",
			state: "streaming",
		});
		const deltas: ConversationDelta[] = [
			{ op: "row.appended", row },
			{ op: "row.delta", rowId: 1, path: "text", append: " world" },
			{
				op: "workflowRun.updated",
				runId: "native-run",
				revision: 4,
				run: { spec: { ...details(), explanation: "Native progress", generation: 3 } },
			},
			{ op: "workflowRun.updated", runId: "native-run", revision: 3, run: { status: "running" } },
			{
				op: "workflowRun.updated",
				runId: "dynamic",
				revision: 5,
				run: { usage: { spentTokens: 20, nodesUsed: 2 }, lastEventSequence: 8 },
			},
		];
		const result = applyConversationDeltas(snapshot, deltas);
		expect(result.rows.window[0]).toHaveProperty("text", "Hello world");
		expect(result.workflowRuns).toEqual({
			revision: 5,
			runs: [
				baseline.applyWorkflowRunUpdated(
					{ revision: 1, runs: [dynamic] },
					{
						op: "workflowRun.updated",
						runId: "dynamic",
						revision: 5,
						run: { usage: { spentTokens: 20, nodesUsed: 2 }, lastEventSequence: 8 },
					},
				).runs[0],
				{ ...run(), status: "running", spec: { ...details(), explanation: "Native progress", generation: 3 } },
			],
		});
		expect(result.workflowRuns?.runs[1]).not.toHaveProperty("lastEventSequence");
		expect(snapshot.workflowRuns.runs).toEqual([dynamic, run()]);
		expect(snapshot.rows.window).toEqual([]);
		const born = applyConversationDelta(result, {
			op: "workflowRun.updated",
			runId: "second-native",
			revision: 6,
			run: { ...run(), runId: "second-native" },
		});
		expect(born.workflowRuns?.runs[2]).toEqual({ ...run(), runId: "second-native" });
		const incomplete = applyConversationDelta(born, {
			op: "workflowRun.updated",
			runId: "unknown-native",
			revision: 7,
			run: { usage: null },
		});
		expect(incomplete.workflowRuns?.runs).toEqual(born.workflowRuns?.runs);
		expect(incomplete.workflowRuns?.revision).toBe(7);
		const replacement = { revision: 8, runs: [dynamic] };
		const replaced = applyConversationDelta(incomplete, {
			op: "state.updated",
			patch: { workflowRuns: replacement },
		});
		expect(replaced.workflowRuns).toBe(replacement);
		const removed = applyConversationDelta(born, {
			op: "workflowRun.removed",
			runId: "native-run",
			revision: 9,
		});
		expect(removed.workflowRuns).toEqual({
			revision: 9,
			runs: [result.workflowRuns!.runs[0], { ...run(), runId: "second-native" }],
		});
	});

	it.each(["desktop-continuous", "web-remote-replayable"] as const)(
		"keeps native progress visible alongside a full dynamic window for %s",
		clientMode => {
			const projection = new ZCodeProjection({ sessionId: "s", cwd: "/work" });
			const dynamic = Array.from({ length: baseline.WORKFLOW_RUNS_LIMITS.maxRuns }, (_, index) => ({
				runId: `dynamic-${index}`,
				status: "running" as const,
				usage: { spentTokens: 12, nodesUsed: 1 },
				actors: [],
				nodes: [],
				lastEventSequence: 0,
			}));
			projection.setWorkflowState({ workflowRuns: { revision: 1, runs: dynamic } });
			projection.setSpecDrivenRuns([run()]);
			const topics = new ZCodeTopics();
			topics.register("conversation/s", projection);
			for (const includeSpecDriven of [false, true]) {
				const frames: RoutedTopicWireFrame[] = [];
				const subscription = topics.subscribe(
					{
						topic: "conversation/s",
						connectionId: String(includeSpecDriven),
						clientMode,
						...(includeSpecDriven ? { includeSpecDriven: true as const } : {}),
					},
					wire => frames.push(wire),
				);
				subscription.flush();
				expect(complete(frames[0])).toMatchObject({
					payload: {
						kind: "snapshot",
						snapshot: { workflowRuns: { runs: includeSpecDriven ? [...dynamic, run()] : dynamic } },
					},
				});
				const schema = includeSpecDriven ? routedTopicWireFrameSchema : baseline.routedTopicWireFrameSchema;
				expect(schema.parse(frames[0])).toEqual(frames[0]);
			}
			topics.dispose();
		},
	);

	it.each(["desktop-continuous", "web-remote-replayable"] as const)(
		"isolates /dev metadata per %s subscription across snapshot, delta and replay",
		clientMode => {
			const snapshot = new ZCodeProjection({ sessionId: "s", cwd: "/work" }).snapshot();
			const dynamic = {
				runId: "dynamic",
				status: "running" as const,
				usage: { spentTokens: 12, nodesUsed: 1 },
				actors: [],
				nodes: [],
				lastEventSequence: 0,
			};
			snapshot.workflowRuns = { revision: 1, runs: [dynamic, run()] };
			expect(conversationSnapshotSchema.parse(snapshot).workflowRuns?.runs[1]).toEqual(run());
			const topics = new ZCodeTopics();
			topics.register("conversation/s", { snapshot: () => structuredClone(snapshot) });
			const oldFrames: RoutedTopicWireFrame[] = [];
			const optFrames: RoutedTopicWireFrame[] = [];
			const old = topics.subscribe({ topic: "conversation/s", connectionId: "old", clientMode }, wire =>
				oldFrames.push(wire),
			);
			const opted = topics.subscribe(
				{ topic: "conversation/s", connectionId: "opted", clientMode, includeSpecDriven: true },
				wire => optFrames.push(wire),
			);
			old.flush();
			opted.flush();
			expect(complete(oldFrames[0])).toMatchObject({
				payload: { kind: "snapshot", snapshot: { workflowRuns: { runs: [dynamic] } } },
			});
			expect(complete(optFrames[0])).toMatchObject({
				payload: { kind: "snapshot", snapshot: { workflowRuns: { runs: [dynamic, run()] } } },
			});
			const delta: ConversationDelta = {
				op: "workflowRun.updated",
				runId: "native-run",
				revision: 2,
				run: { spec: { ...details(), explanation: "Updated native wait" } },
			};
			expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
			topics.publish("conversation/s", [delta]);
			expect(complete(oldFrames[1])).toMatchObject({
				fromSeq: 0,
				toSeq: 1,
				payload: { kind: "deltas", deltas: [] },
			});
			expect(complete(optFrames[1])).toMatchObject({
				fromSeq: 0,
				toSeq: 1,
				payload: { kind: "deltas", deltas: [delta] },
			});
			const recovery = topics.recover({
				subscriptionId: opted.ack.subscriptionId,
				base: { logEpoch: snapshot.logEpoch, seq: 0 },
			});
			expect(recovery.ack.mode).toBe("resume");
			recovery.flush();
			expect(complete(optFrames[2])).toMatchObject({ payload: { kind: "deltas", deltas: [delta] } });
			topics.publish("conversation/s", [
				{ op: "state.updated", patch: { workflowRuns: { revision: 3, runs: [dynamic, run()] } } },
			]);
			expect(complete(oldFrames[2])).toMatchObject({
				payload: {
					kind: "deltas",
					deltas: [{ op: "state.updated", patch: { workflowRuns: { runs: [dynamic] } } }],
				},
			});
			expect(complete(optFrames[3])).toMatchObject({
				payload: {
					kind: "deltas",
					deltas: [{ op: "state.updated", patch: { workflowRuns: { runs: [dynamic, run()] } } }],
				},
			});
			topics.publish("conversation/s", [{ op: "workflowRun.removed", runId: "native-run", revision: 4 }]);
			expect(complete(oldFrames[3])).toMatchObject({ payload: { kind: "deltas", deltas: [] } });
			for (const wire of oldFrames) {
				const baselineFrame: unknown = baseline.routedTopicWireFrameSchema.parse(wire);
				expect(baselineFrame).toEqual(wire);
				expect(JSON.stringify(wire)).not.toContain("native-run");
				expect(JSON.stringify(wire)).not.toContain('"spec"');
			}
			for (const wire of optFrames) expect(routedTopicWireFrameSchema.parse(wire)).toEqual(wire);
			topics.dispose();
		},
	);
});
