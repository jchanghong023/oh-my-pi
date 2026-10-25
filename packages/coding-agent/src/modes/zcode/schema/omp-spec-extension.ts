// Local opt-in /dev observation vocabulary; the pinned desktop protocol stays unchanged.
import { z } from "zod";
import * as baseline from "./vendor/zcode-protocol-v4/index";
import * as legacy from "./vendor/zcode-protocol/index";
import { createTopicWireFrameSchema } from "./vendor/zcode-protocol-v4/wire";

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();
export const ompSpecRunBindingSchema = z
	.object({
		runId: id,
		generation: z.number().int().nonnegative(),
		actionId: id.optional(),
		actionVersion: id.optional(),
	})
	.strict();
export const ompSpecPhaseSchema = z.enum([
	"idle",
	"requirements",
	"requirements-review",
	"awaiting-answers",
	"awaiting-specification",
	"team",
	"awaiting-choice",
	"planning",
	"plan-review",
	"awaiting-plan",
	"executing",
	"validating",
	"overall-review",
	"awaiting-acceptance",
	"closing",
	"completed",
	"cancelled",
]);
export const ompSpecStageSchema = z.enum(["requirements", "solution", "plan", "execution", "acceptance", "closure"]);
export const ompSpecCandidateSchema = z
	.object({
		id,
		label: id,
		version: id,
		proposal: z.string(),
		adoptable: z.boolean(),
		reviewSucceeded: z.boolean(),
		recheckSucceeded: z.boolean(),
		unresolvedBlocking: z.array(z.object({ id, evidence: z.string() }).strict()),
		exclusionReason: z.string().optional(),
		conditions: z.array(z.object({ id, description: z.string(), command: z.string().optional() }).strict()),
	})
	.strict();
export const ompSpecActionSchema = z
	.object({
		id,
		label: id,
		command: z
			.string()
			.regex(/^\/dev(?:\s|$)/u)
			.optional(),
		commandPrefix: z
			.string()
			.regex(/^\/dev(?:\s|$)/u)
			.optional(),
		binding: ompSpecRunBindingSchema,
		available: z.boolean().optional(),
		blockedReason: z.string().optional(),
		requiresInput: z.boolean().optional(),
		version: id.optional(),
	})
	.strict()
	.refine(action => (action.command !== undefined) !== (action.commandPrefix !== undefined), {
		message: "An action requires exactly one native command or text-input command prefix",
	});
const recipientSchema = z
	.object({
		role: z.enum(["requirements", "solution", "planner", "executor"]),
		actorId: id,
		sessionId: id,
	})
	.strict();
const clarificationSchema = z.object({ id, questions: z.array(z.string()) }).strict();
const messageSchema = recipientSchema.extend({
	id,
	text: z.string(),
	runId: id,
	generation: z.number().int().nonnegative(),
	phase: ompSpecPhaseSchema,
	status: z.enum(["queued", "processing", "cancelling", "cancelled", "completed", "failed"]),
	reply: z.string().optional(),
	error: z.string().optional(),
	clarificationId: id.optional(),
});
const nativeActionSchema = z
	.object({
		id,
		label: id,
		command: z.string().regex(/^\/dev(?:\s|$)/u),
		available: z.boolean(),
		blockedReason: z.string().optional(),
		requiresInput: z.boolean().optional(),
		version: id.optional(),
	})
	.strict();
export const ompSpecInteractionSchema = z
	.object({
		mode: z.enum(["chat", "dev"]),
		draft: z.string(),
		recipient: recipientSchema.optional(),
		messages: z.array(messageSchema),
		actions: z.array(nativeActionSchema),
		blockedReason: z.string().optional(),
		clarification: clarificationSchema.optional(),
	})
	.strict();
export type OmpSpecInteraction = z.infer<typeof ompSpecInteractionSchema>;
export const ompSpecMaterialSchema = z
	.object({
		id,
		title: id,
		readiness: z.enum(["not_generated", "present", "missing", "unreadable", "unknown"]),
		sourceVersion: z.string().nullable(),
		artifactId: id.optional(),
		version: z.number().int().positive().optional(),
	})
	.strict();
export const ompSpecDetailsSchema = z
	.object({
		changeId: id,
		phase: ompSpecPhaseSchema,
		stage: ompSpecStageSchema,
		state: z.enum(["active", "waiting", "paused", "blocked", "terminal"]),
		explanation: z.string(),
		generation: z.number().int().nonnegative(),
		live: z.boolean(),
		readOnly: z.boolean(),
		workspaceIdentity: id,
		workspacePath: id,
		sessionId: id,
		createdAt: timestamp,
		updatedAt: timestamp,
		progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
		tasks: z.array(
			z
				.object({
					id,
					title: z.string(),
					dependencies: z.array(id),
					requirementIds: z.array(id),
					status: z.enum(["pending", "implemented", "verified", "completed", "running", "blocked", "failed"]),
				})
				.strict(),
		),
		versions: z
			.object({
				specification: id.optional(),
				solution: id.optional(),
				plan: id.optional(),
				candidate: id.optional(),
				acceptance: id.optional(),
			})
			.strict(),
		questions: z.array(z.string()),
		clarification: clarificationSchema.optional(),
		candidates: z.array(ompSpecCandidateSchema),
		selectedCandidate: z.object({ id, version: id }).strict().nullable(),
		actions: z.array(ompSpecActionSchema),
		interaction: ompSpecInteractionSchema.optional(),
		materials: z.array(ompSpecMaterialSchema),
	})
	.strict()
	.superRefine((details, context) => {
		if (
			(!details.live || details.readOnly || details.phase === "cancelled" || details.phase === "completed") &&
			details.actions.length
		)
			context.addIssue({
				code: "custom",
				path: ["actions"],
				message: "Readonly or terminal observations cannot expose controls",
			});
		if (details.progress.completed > details.progress.total)
			context.addIssue({ code: "custom", path: ["progress"], message: "Completed tasks exceed total tasks" });
	});
export type OmpSpecRunBinding = z.infer<typeof ompSpecRunBindingSchema>;
export type OmpSpecDetails = z.infer<typeof ompSpecDetailsSchema>;
export type OmpSpecCandidate = z.infer<typeof ompSpecCandidateSchema>;
export type OmpSpecAction = z.infer<typeof ompSpecActionSchema>;
export type OmpSpecMaterial = z.infer<typeof ompSpecMaterialSchema>;

// Native immutable captures are not limited to the script engine's sixteen publications.
// Only the version domain changes; identity, metadata and byte-read bounds stay pinned.
const nativeArtifactVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const workflowRunArtifactVersionSchema = baseline.workflowRunArtifactVersionSchema.extend({
	version: nativeArtifactVersion,
});
export type WorkflowRunArtifactVersion = z.infer<typeof workflowRunArtifactVersionSchema>;
export const workflowRunArtifactSchema = baseline.workflowRunArtifactSchema.extend({
	version: nativeArtifactVersion,
	versions: z.array(workflowRunArtifactVersionSchema),
});
export type WorkflowRunArtifact = z.infer<typeof workflowRunArtifactSchema>;
export const workflowRunArtifactSummarySchema = baseline.workflowRunArtifactSummarySchema.extend({
	version: nativeArtifactVersion,
});
export type WorkflowRunArtifactSummary = z.infer<typeof workflowRunArtifactSummarySchema>;
export const v4ConversationWorkflowRunArtifactsResultSchema =
	baseline.v4ConversationWorkflowRunArtifactsResultSchema.extend({
		artifacts: z.array(workflowRunArtifactSchema),
	});
export type V4ConversationWorkflowRunArtifactsResult = z.infer<typeof v4ConversationWorkflowRunArtifactsResultSchema>;
export const v4ConversationWorkflowRunArtifactReadParamsSchema =
	baseline.v4ConversationWorkflowRunArtifactReadParamsSchema.extend({ version: nativeArtifactVersion });
export type V4ConversationWorkflowRunArtifactReadParams = z.infer<
	typeof v4ConversationWorkflowRunArtifactReadParamsSchema
>;

// Native observations never pretend to have a script, tool invocation, or token accounting.
export const ompSpecRunSchema = baseline.workflowRunSchema
	.omit({ usage: true, actors: true, nodes: true, toolCallId: true, resumable: true, lastEventSequence: true })
	.extend({
		spec: ompSpecDetailsSchema,
		usage: z.null(),
		actors: z.array(z.never()).length(0),
		nodes: z.array(z.never()).length(0),
		artifacts: z.array(workflowRunArtifactSummarySchema).max(baseline.WORKFLOW_RUNS_LIMITS.maxArtifacts).optional(),
	})
	.strict();
export type OmpSpecRun = z.infer<typeof ompSpecRunSchema>;
const dynamicRunSchema = baseline.workflowRunSchema.extend({ spec: z.never().optional() });
export const workflowRunSchema = z.union([ompSpecRunSchema, dynamicRunSchema]);
export type WorkflowRunState = z.infer<typeof workflowRunSchema>;
export const workflowRunsStateSchema = baseline.workflowRunsStateSchema.extend({
	// Keep each source's existing window without allowing native rows to evict script runs.
	runs: z
		.array(workflowRunSchema)
		.max(baseline.WORKFLOW_RUNS_LIMITS.maxRuns * 2)
		.superRefine((runs, context) => {
			let native = 0;
			for (const run of runs) if (run.spec !== undefined) native++;
			if (
				native > baseline.WORKFLOW_RUNS_LIMITS.maxRuns ||
				runs.length - native > baseline.WORKFLOW_RUNS_LIMITS.maxRuns
			)
				context.addIssue({ code: "custom", message: "Workflow source window exceeds its run limit" });
		}),
});
export type WorkflowRunsState = z.infer<typeof workflowRunsStateSchema>;
const nativeHeaderSchema = ompSpecRunSchema.omit({ actors: true, nodes: true });
const dynamicHeaderSchema = dynamicRunSchema.omit({ actors: true, nodes: true });
export const workflowRunHeaderSchema = z.union([nativeHeaderSchema, dynamicHeaderSchema]);
export type WorkflowRunHeader = z.infer<typeof workflowRunHeaderSchema>;
export const workflowRunHeaderPatchSchema = z.union([nativeHeaderSchema.partial(), dynamicHeaderSchema.partial()]);
export type WorkflowRunHeaderPatch = z.infer<typeof workflowRunHeaderPatchSchema>;
export const workflowRunHeaderKeySchema = z.enum([...baseline.workflowRunHeaderKeySchema.options, "spec"]);
export type WorkflowRunHeaderKey = z.infer<typeof workflowRunHeaderKeySchema>;
export const statePatchSchema = baseline.statePatchSchema.extend({
	workflowRuns: workflowRunsStateSchema.optional(),
	dev: ompSpecInteractionSchema.optional(),
});
export type StatePatch = z.infer<typeof statePatchSchema>;
const [
	appended,
	upserted,
	removed,
	rowDelta,
	stateUpdated,
	resourceUpdated,
	resourceListChanged,
	instanceClosed,
	appToolCall,
	runUpdated,
	runRemoved,
] = baseline.conversationDeltaSchema.options;
export const conversationDeltaSchema = z.discriminatedUnion("op", [
	appended,
	upserted,
	removed,
	rowDelta,
	stateUpdated.extend({ patch: statePatchSchema }),
	resourceUpdated,
	resourceListChanged,
	instanceClosed,
	appToolCall,
	runUpdated.extend({
		run: workflowRunHeaderPatchSchema.optional(),
		cleared: z.array(workflowRunHeaderKeySchema).max(workflowRunHeaderKeySchema.options.length).optional(),
	}),
	runRemoved,
]);
export type ConversationDelta = z.infer<typeof conversationDeltaSchema>;
export type WorkflowRunUpdatedDelta = Extract<ConversationDelta, { op: "workflowRun.updated" }>;
export const conversationSnapshotSchema = baseline.conversationSnapshotSchema.extend({
	workflowRuns: workflowRunsStateSchema.optional(),
	dev: ompSpecInteractionSchema.optional(),
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;

// Keep baseline row/state semantics in the pinned reducer; only native workflow entries need adaptation.
export function applyWorkflowRunUpdated(
	state: WorkflowRunsState | undefined,
	delta: WorkflowRunUpdatedDelta,
): WorkflowRunsState {
	const runs = state?.runs ?? [];
	const revision = Math.max(state?.revision ?? 0, delta.revision);
	const index = runs.findIndex(run => run.runId === delta.runId);
	const existing = runs[index];
	if (existing?.spec !== undefined || delta.run?.spec !== undefined || delta.run?.usage === null) {
		const merged: Record<string, unknown> = {
			...existing,
			...delta.run,
			actors: delta.actors ?? existing?.actors ?? [],
			nodes: delta.nodes ?? existing?.nodes ?? [],
		};
		for (const key of delta.cleared ?? []) delete merged[key];
		const parsed = ompSpecRunSchema.safeParse(merged);
		// Like the baseline, an incomplete header cannot create an unknown run.
		if (!parsed.success) {
			if (existing !== undefined) throw parsed.error;
			return state !== undefined && state.revision === revision ? state : { revision, runs };
		}
		const next = [...runs];
		if (index < 0) next.push(parsed.data);
		else next[index] = parsed.data;
		return { revision, runs: next };
	}
	const dynamicDelta = baseline.conversationDeltaSchema.parse(delta);
	if (dynamicDelta.op !== "workflowRun.updated") throw new Error("Expected workflow run update");
	const updated = baseline.applyWorkflowRunUpdated(
		existing === undefined ? undefined : { revision: state?.revision ?? 0, runs: [existing] },
		dynamicDelta,
	);
	const replacement = updated.runs[0];
	if (replacement === undefined)
		return state !== undefined && state.revision === revision ? state : { revision, runs };
	const next = [...runs];
	if (index < 0) next.push(replacement);
	else next[index] = replacement;
	return { revision, runs: next };
}

export function applyWorkflowRunRemoved(
	state: WorkflowRunsState | undefined,
	delta: baseline.WorkflowRunRemovedDelta,
): WorkflowRunsState {
	const runs = state?.runs ?? [];
	const revision = Math.max(state?.revision ?? 0, delta.revision);
	const remaining = runs.filter(run => run.runId !== delta.runId);
	if (remaining.length === runs.length)
		return state !== undefined && state.revision === revision ? state : { revision, runs };
	return { revision, runs: remaining };
}

export function applyConversationDelta(snapshot: ConversationSnapshot, delta: ConversationDelta): ConversationSnapshot {
	if (delta.op === "state.updated") return { ...snapshot, ...delta.patch };
	if (delta.op === "workflowRun.updated")
		return { ...snapshot, workflowRuns: applyWorkflowRunUpdated(snapshot.workflowRuns, delta) };
	if (delta.op === "workflowRun.removed")
		return { ...snapshot, workflowRuns: applyWorkflowRunRemoved(snapshot.workflowRuns, delta) };
	const { workflowRuns, dev, ...base } = snapshot;
	const applied = baseline.applyConversationDelta(base, delta);
	if (applied === base) return snapshot;
	return {
		...applied,
		...(workflowRuns === undefined ? {} : { workflowRuns }),
		...(dev === undefined ? {} : { dev }),
	};
}

export function applyConversationDeltas(
	snapshot: ConversationSnapshot,
	deltas: readonly ConversationDelta[],
): ConversationSnapshot {
	let current = snapshot;
	for (const delta of deltas) current = applyConversationDelta(current, delta);
	return current;
}
export const conversationTopicFrameSchema = baseline
	.createTopicFrameSchema(conversationSnapshotSchema, conversationDeltaSchema)
	.extend({
		ttft: baseline.localTtftFactsSchema.optional(),
		ttftRelated: z.array(baseline.localTtftFactsSchema).max(16).optional(),
	})
	.superRefine((frame, context) => {
		if (!frame.topic.startsWith("conversation/") || frame.topic.length === "conversation/".length)
			context.addIssue({ code: "custom", path: ["topic"], message: "invalid conversation topic" });
	});
export type ConversationTopicFrame = z.infer<typeof conversationTopicFrameSchema>;
export const conversationTopicWireFrameSchema = createTopicWireFrameSchema(conversationTopicFrameSchema);
export type ConversationTopicWireFrame = z.infer<typeof conversationTopicWireFrameSchema>;
export const routedTopicFrameSchema = z.union([
	conversationTopicFrameSchema,
	baseline.sessionsIndexTopicFrameSchema,
	baseline.workspaceConfigTopicFrameSchema,
]);
export type RoutedTopicFrame = z.infer<typeof routedTopicFrameSchema>;
export const routedTopicWireFrameSchema = z.union([
	conversationTopicWireFrameSchema,
	baseline.sessionsIndexTopicWireFrameSchema,
	baseline.workspaceConfigTopicWireFrameSchema,
]);
export type RoutedTopicWireFrame = z.infer<typeof routedTopicWireFrameSchema>;
export const subscribeParamsSchema = baseline.subscribeParamsSchema.extend({
	includeSpecDriven: z.literal(true).optional(),
});
export type SubscribeParams = z.infer<typeof subscribeParamsSchema>;
export const v4ConversationSubscribeParamsSchema = baseline.v4ConversationSubscribeParamsSchema.extend({
	includeSpecDriven: z.literal(true).optional(),
});
export type V4ConversationSubscribeParams = z.infer<typeof v4ConversationSubscribeParamsSchema>;
export const v4ConversationWorkflowRunsParamsSchema = baseline.v4ConversationWorkflowRunsParamsSchema.extend({
	includeSpecDriven: z.literal(true).optional(),
	runId: id.optional(),
});
export type V4ConversationWorkflowRunsParams = z.infer<typeof v4ConversationWorkflowRunsParamsSchema>;
export const v4ConversationWorkflowRunSummarySchema = baseline.v4ConversationWorkflowRunSummarySchema.extend({
	spec: ompSpecDetailsSchema.optional(),
});
export type V4ConversationWorkflowRunSummary = z.infer<typeof v4ConversationWorkflowRunSummarySchema>;
export const v4ConversationWorkflowRunsResultSchema = baseline.v4ConversationWorkflowRunsResultSchema.extend({
	runs: z.array(v4ConversationWorkflowRunSummarySchema),
	dev: ompSpecInteractionSchema.optional(),
});
export type V4ConversationWorkflowRunsResult = z.infer<typeof v4ConversationWorkflowRunsResultSchema>;
export const zcodeWorkflowsRunsParamsSchema = legacy.zcodeWorkflowsRunsParamsSchema.extend({
	includeSpecDriven: z.literal(true).optional(),
});
export type ZCodeWorkflowsRunsParams = z.infer<typeof zcodeWorkflowsRunsParamsSchema>;
const nativeSavedRunSchema = legacy.zcodeSavedWorkflowRunSchema
	.omit({ spentTokens: true, toolCallId: true })
	.extend({ spentTokens: z.null(), spec: ompSpecDetailsSchema })
	.strict();
export const zcodeSavedWorkflowRunSchema = z.union([
	nativeSavedRunSchema,
	legacy.zcodeSavedWorkflowRunSchema.extend({ spec: z.never().optional() }),
]);
export type ZCodeSavedWorkflowRun = z.infer<typeof zcodeSavedWorkflowRunSchema>;
export const zcodeWorkflowsRunsResultSchema = legacy.zcodeWorkflowsRunsResultSchema.extend({
	runs: z.array(zcodeSavedWorkflowRunSchema),
});
export type ZCodeWorkflowsRunsResult = z.infer<typeof zcodeWorkflowsRunsResultSchema>;

export const commandPayloadSchemas = {
	...baseline.commandPayloadSchemas,
	sendText: baseline.commandPayloadSchemas.sendText.and(z.object({ specRun: ompSpecRunBindingSchema.optional() })),
};
export type CommandPayloadMap = Omit<baseline.CommandPayloadMap, "sendText"> & {
	sendText: baseline.CommandPayloadMap["sendText"] & { specRun?: OmpSpecRunBinding };
};
export const parseCommandEnvelope: typeof baseline.parseCommandEnvelope = value => {
	const parsed = baseline.parseCommandEnvelope(value);
	if (!parsed.ok || parsed.envelope.type !== "sendText") return parsed;
	const envelope = baseline.commandEnvelopeSchema.parse(value);
	const payload = commandPayloadSchemas.sendText.safeParse(envelope.payload);
	if (!payload.success) return { ok: false, error: payload.error };
	return { ok: true, envelope: { ...parsed.envelope, payload: payload.data } };
};

/** Reuse the pinned profile policy without narrowing away local state metadata. */
export function filterConversationDeltasForProfile(
	deltas: readonly ConversationDelta[],
	profile: baseline.DeliveryProfile,
): ConversationDelta[] {
	return deltas.filter(
		delta => delta.op !== "row.delta" || baseline.filterConversationDeltasForProfile([delta], profile).length > 0,
	);
}
