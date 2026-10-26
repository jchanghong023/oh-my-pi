import type { SpecDrivenPhase, SpecStageRole } from "./stages";
export type { SpecDrivenPhase, SpecStageRole } from "./stages";

export type SpecInputMode = "chat" | "dev";
export interface SpecConversationRecipient {
	role: SpecStageRole;
	actorId: string;
	sessionId: string;
}
export interface SpecConversationReply {
	text: string;
}
export interface SpecControllerAction {
	id: string;
	label: string;
	command: string;
	available: boolean;
	blockedReason?: string;
	requiresInput?: boolean;
	version?: string;
}
export interface SpecUserMessage extends SpecConversationRecipient {
	id: string;
	text: string;
	runId: string;
	generation: number;
	phase: SpecDrivenPhase;
	status: "queued" | "processing" | "cancelling" | "cancelled" | "completed" | "failed";
	reply?: string;
	error?: string;
}
export type SpecTextReceipt = { kind: "draft"; text: string } | { kind: "queued"; messageId: string };
export interface SpecInteractionState {
	mode: SpecInputMode;
	draft: string;
	recipient?: SpecConversationRecipient;
	messages: SpecUserMessage[];
	actions: SpecControllerAction[];
	blockedReason?: string;
}
export interface SpecDocument {
	path: string;
	content: string;
	version: string;
}
export interface SpecRequirements {
	files: SpecDocument[];
	version: string;
}
export interface SpecCandidate {
	id: string;
	title: string;
	content: string;
}
export interface SpecSolution extends SpecDocument {
	candidates: SpecCandidate[];
}
export interface SpecArtifactPaths {
	requirements: string[];
	solution: string;
	plan: string;
	report: string;
}
export interface SpecRunContext {
	runId: string;
	generation: number;
	signal: AbortSignal;
}
export interface SpecAgentInput {
	role: SpecStageRole;
	request: string;
	files: SpecDocument[];
	outputPaths: string[];
	userReply?: string;
	candidateId?: string;
	feedback?: string;
	readOnly?: boolean;
	useTeam?: boolean;
	useGoal?: boolean;
}
export interface SpecDrivenStatus {
	phase: SpecDrivenPhase;
	paused: boolean;
	generation: number;
	changeId?: string;
	blockedReason?: string;
	paths?: SpecArtifactPaths;
	specification?: SpecRequirements;
	solution?: SpecSolution;
	selection?: { candidateId: string; userReply: string };
	plan?: SpecDocument;
	report?: SpecDocument;
	lastReply?: string;
	archivedChangePath?: string;
	useTeam?: boolean;
	useGoal?: boolean;
}
export interface SpecDrivenPorts {
	agents: {
		recipient(role: SpecStageRole): SpecConversationRecipient | undefined;
		run(input: SpecAgentInput, context: SpecRunContext): Promise<SpecConversationReply>;
	};
	artifacts: {
		initialize(changeId: string, context: SpecRunContext): Promise<SpecArtifactPaths>;
		readRequirements(context: SpecRunContext): Promise<SpecRequirements>;
		readSolution(context: SpecRunContext): Promise<SpecSolution>;
		readPlan(context: SpecRunContext): Promise<SpecDocument>;
		readReport(context: SpecRunContext): Promise<SpecDocument>;
		close(
			input: { specification: SpecRequirements; report: SpecDocument },
			context: SpecRunContext,
		): Promise<{ archivedChangePath?: string }>;
	};
}
export interface SpecDrivenOptions {
	currentModel: string;
	members?: readonly string[];
	unavailableMembers?: readonly string[];
	runId?: string;
	onStatusChange?: (status: SpecDrivenStatus) => void;
	assertTransitionAllowed?: () => void;
}
