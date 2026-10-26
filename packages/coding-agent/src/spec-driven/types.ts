import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { SpecCloseProgress } from "./artifacts";
import type { SpecDrivenPhase, SpecStageRole } from "./stages";
export type { SpecDrivenPhase, SpecStageRole } from "./stages";
export type SpecInputMode = "chat" | "dev";
export interface SpecConversationRecipient {
	role: SpecStageRole;
	actorId: string;
	sessionId: string;
	sessionFile?: string;
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
}
export interface SpecInteractionState {
	mode: SpecInputMode;
	recipient?: SpecConversationRecipient;
	actions: SpecControllerAction[];
	blockedReason?: string;
}
export interface SpecFileVersion {
	path: string;
	version: string;
}
export interface SpecDocument extends SpecFileVersion {
	content: string;
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
	entry: boolean;
	request: string;
	files: SpecDocument[];
	outputPaths: string[];
	userReply?: string;
	candidateId?: string;
	feedback?: string;
	readOnly?: boolean;
	useTeam?: boolean;
	decisions?: Partial<Record<SpecStageRole, string>>;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
}
export interface SpecVersionCheck {
	matches: boolean;
	changed: { path: string; reason: string }[];
}
export interface SpecApproval {
	files: SpecFileVersion[];
	userReply: string;
	candidateId?: string;
}
export interface SpecDrivenStatus {
	phase: SpecDrivenPhase;
	generation: number;
	changeId?: string;
	blockedReason?: string;
	paths?: SpecArtifactPaths;
	specification?: SpecRequirements;
	solution?: SpecSolution;
	selection?: { candidateId: string; userReply: string };
	plan?: SpecDocument;
	report?: SpecDocument;
	awaitingAcceptance?: boolean;
	accepted?: SpecApproval;
	closing?: SpecCloseProgress;
	archivedChangePath?: string;
	useTeam: boolean;
}
/** Only durable references and explicit decisions; native session files own all conversation text. */
export interface SpecSavedRun {
	runId: string;
	phase: SpecDrivenPhase;
	changeId?: string;
	paths?: SpecArtifactPaths;
	approvals: Partial<Record<SpecStageRole, SpecApproval>>;
	sessions: Partial<Record<SpecStageRole, SpecConversationRecipient>>;
	awaitingAcceptance?: boolean;
	reportNeedsUpdate?: boolean;
	closing?: SpecCloseProgress;
	archivedChangePath?: string;
}
export interface SpecDrivenPorts {
	agents: {
		prepare(role: SpecStageRole, context: SpecRunContext, saved?: SpecConversationRecipient): Promise<void>;
		recipient(role: SpecStageRole): SpecConversationRecipient | undefined;
		originalRequest(): string;
		run(input: SpecAgentInput, context: SpecRunContext): Promise<SpecConversationReply>;
	};
	artifacts: {
		initialize(changeId: string, context: SpecRunContext): Promise<SpecArtifactPaths>;
		readRequirements(context: SpecRunContext): Promise<SpecRequirements>;
		readSolution(context: SpecRunContext): Promise<SpecSolution>;
		readPlan(context: SpecRunContext): Promise<SpecDocument>;
		readReport(context: SpecRunContext): Promise<SpecDocument>;
		checkVersions(files: readonly SpecFileVersion[], archivedChangePath?: string): Promise<SpecVersionCheck>;
		close(
			input: {
				acceptedVersions: readonly SpecFileVersion[];
				progress?: SpecCloseProgress;
				onProgress?: (progress: SpecCloseProgress) => void | Promise<void>;
			},
			context: SpecRunContext,
		): Promise<{ archivedChangePath: string }>;
	};
}
export interface SpecDrivenOptions {
	runId?: string;
	getUseTeam: () => boolean;
	persist: (run: SpecSavedRun) => Promise<void>;
	onStatusChange?: (status: SpecDrivenStatus) => void;
	assertTransitionAllowed?: () => void;
}
