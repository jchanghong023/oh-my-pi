// Extracted from jchanghong023/OmpCode at c7c190724f3a00a2de998a0a5511201d5a2ba1a0.
// vendor/ preserves packages/shared/src layout and the complete public V4 +
// legacy dependency closure. No runtime import crosses repositories.
export const ZCODE_SCHEMA_SOURCE = {
	repository: "https://github.com/jchanghong023/OmpCode",
	commit: "c7c190724f3a00a2de998a0a5511201d5a2ba1a0",
	paths: [
		"packages/shared/src/zcode-protocol-v4/index.ts",
		"packages/shared/src/zcode-protocol/index.ts",
		"packages/shared/src/session-debug.ts",
	],
} as const;
export * from "./vendor/zcode-protocol-v4/index";
export * as LegacyProtocol from "./vendor/zcode-protocol/index";
export * from "./omp-config-extension";
export * from "./vendor/session-debug";
// Explicit local overrides retain /spec metadata without changing the vendor baseline.
export * from "./omp-spec-extension";
export {
	workflowRunSchema,
	workflowRunsStateSchema,
	workflowRunHeaderSchema,
	workflowRunHeaderPatchSchema,
	workflowRunHeaderKeySchema,
	statePatchSchema,
	conversationDeltaSchema,
	conversationSnapshotSchema,
	conversationTopicFrameSchema,
	conversationTopicWireFrameSchema,
	routedTopicFrameSchema,
	routedTopicWireFrameSchema,
	subscribeParamsSchema,
	v4ConversationSubscribeParamsSchema,
	v4ConversationWorkflowRunsParamsSchema,
	v4ConversationWorkflowRunSummarySchema,
	v4ConversationWorkflowRunsResultSchema,
	commandPayloadSchemas,
	parseCommandEnvelope,
	filterConversationDeltasForProfile,
	applyConversationDelta,
	applyConversationDeltas,
	applyWorkflowRunUpdated,
	applyWorkflowRunRemoved,
	workflowRunArtifactVersionSchema,
	workflowRunArtifactSchema,
	workflowRunArtifactSummarySchema,
	v4ConversationWorkflowRunArtifactsResultSchema,
	v4ConversationWorkflowRunArtifactReadParamsSchema,
	type WorkflowRunArtifactVersion,
	type WorkflowRunArtifact,
	type WorkflowRunArtifactSummary,
	type V4ConversationWorkflowRunArtifactsResult,
	type V4ConversationWorkflowRunArtifactReadParams,
	type WorkflowRunState,
	type WorkflowRunsState,
	type WorkflowRunHeader,
	type WorkflowRunHeaderPatch,
	type WorkflowRunHeaderKey,
	type StatePatch,
	type ConversationDelta,
	type WorkflowRunUpdatedDelta,
	type ConversationSnapshot,
	type ConversationTopicFrame,
	type ConversationTopicWireFrame,
	type RoutedTopicFrame,
	type RoutedTopicWireFrame,
	type SubscribeParams,
	type V4ConversationSubscribeParams,
	type V4ConversationWorkflowRunsParams,
	type V4ConversationWorkflowRunSummary,
	type V4ConversationWorkflowRunsResult,
	type CommandPayloadMap,
} from "./omp-spec-extension";
