import type { AIReqIssue, AIReqIssueInput, AIReqIssueScope, AIReqIssueSnapshot } from "../packages/ui/src/aireq/issues.js";
import type { IServiceAccessor } from "@zcode/services";
import type { SkillSummary, SkillsListResult, ZCodeProvider } from "@zcode/shared";
import type {
	AIReqBackendView,
	AIReqDataSource,
	AIReqDataProvenance,
	AIReqDirectory,
	AIReqDirectoryCheck,
	AIReqEmployeeDirectory,
} from "../packages/ui/src/aireq/data-source.js";
import type {
	AIReqAction,
	AIReqAgentModelBinding,
	AIReqAgentModelSettings,
	AIReqNativeSessionRef,
	AIReqPeer,
	AIReqSelection,
	AIReqSkillDesignDraft,
	AIReqSkillDesignPreview,
	AIReqWorkflowView,
	AIReqWorkflowResult,
	AIReqWorkspace,
	AIReqSrPlanningInput,
	AIReqProposalMergeScenario,
	AIReqPrHandoff,
	AIReqPrHandoffScenario,
} from "../packages/ui/src/aireq/types.js";
import type {
	AIReqAnalysisFilter,
	AIReqAnalysisHistoryFilter,
	AIReqAnalysisSnapshot,
	AIReqAnalysisTaskPage,
	AIReqAnalysisPage,
	AIReqAnalysisRunSummary,
	AIReqAnalysisRun,
} from "../packages/ui/src/aireq/progress-scheduler.js";

/** HTTP: GET /api/aireq/bootstrap and POST /api/aireq/call return the same envelope.
 * Errors use non-2xx status plus a stable code/message, never a success fallback.
 * /api/aireq/events carries AIReqRemoteEvent as JSON WebSocket text frames.
 * Unknown operation names are rejected before invoking a service. */
export const AIREQ_CONTRACT_VERSION = 1;
export type AIReqRemoteErrorCode =
	| "NOT_FOUND"
	| "METHOD_NOT_ALLOWED"
	| "INVALID_IDENTITY"
	| "INVALID_CLIENT"
	| "INVALID_SCENARIO"
	| "FORBIDDEN"
	| "INVALID_UPGRADE"
	| "BACKEND_UNAVAILABLE"
	| "INVALID_JSON"
	| "INVALID_ARGUMENT"
	| "UNKNOWN_PATH"
	| "INVALID_ACTION";
export interface AIReqRemoteError {
	code: AIReqRemoteErrorCode;
	message: string;
}
export type AIReqRemoteResponse<T> = { ok: true; value: T } | { ok: false; error: AIReqRemoteError };
export interface AIReqRemoteWorkflow {
	view: AIReqWorkflowView;
	session?: AIReqNativeSessionRef;
	workspace: AIReqWorkspace;
}
export interface AIReqRemoteFreeChat {
	projectId: string;
	taskId: string;
}
export interface AIReqRemoteRepositoryInput {
	projectId?: string;
	name: string;
	repositoryUrl: string;
	defaultBranch: string;
}
export interface AIReqRemotePrompts {
	saved: Record<string, string>;
	draft: Record<string, string>;
}
export interface AIReqRemoteSkillsInput {
	workspacePath: string;
	workspaceIdentity?: string;
	provider?: ZCodeProvider;
}
interface Operation<A extends unknown[], R> {
	args: A;
	result: R;
}

/** Frozen /api/aireq/call operations. Void/absent top-level results are JSON null. */
export interface AIReqRemoteOperations {
  "issues.read": Operation<[scope: AIReqIssueScope], AIReqIssueSnapshot>;
  "issues.create": Operation<[input: AIReqIssueInput], AIReqIssue>;
  "issues.configure": Operation<[scope: AIReqIssueScope, enabled: boolean, intervalMinutes: number], null>;
  "issues.runNow": Operation<[scope: AIReqIssueScope], null>;
  "issues.confirm": Operation<[scope: AIReqIssueScope, id: string], null>;
  "issues.reopen": Operation<[scope: AIReqIssueScope, id: string, reason: string], null>;
	readWorkflow: Operation<[selection: AIReqSelection], AIReqRemoteWorkflow>;
	readPrHandoff: Operation<[group: AIReqWorkflowView["groups"][number]], AIReqPrHandoff>;
	command: Operation<[action: AIReqAction, selection: AIReqSelection, revision: number], AIReqWorkflowResult>;
	retryMaterial: Operation<[path: string, selection: AIReqSelection], boolean>;
	retrySession: Operation<[selection: AIReqSelection], null>;
	createFreeChat: Operation<[projectId: string], AIReqRemoteFreeChat>;
	readFreeChat: Operation<[taskId: string], AIReqRemoteFreeChat | null>;
	readRecentFreeChats: Operation<[projectId: string], { taskId: string }[]>;
	selectProject: Operation<[projectId?: string], null>;
	"progress.assignOwner": Operation<[projectId: string, irId: string, employeeId: string], null>;
	"progress.updateSr": Operation<
		[projectId: string, irId: string, srId: string, percent: number, reason: string],
		null
	>;
	"planning.updateSr": Operation<[projectId: string, irId: string, srId: string, input: AIReqSrPlanningInput], null>;
	"projects.saveRepository": Operation<[input: AIReqRemoteRepositoryInput], null>;
	"projects.readDevelopmentRoot": Operation<[projectId: string, employeeId?: string], string | null>;
	"projects.listDirectories": Operation<[], AIReqDirectory[]>;
	"projects.checkProjectDirectory": Operation<[path: string, existingRoots: string[]], AIReqDirectoryCheck>;
	"projects.checkDevelopmentDirectory": Operation<[path: string, sharedRoot: string], AIReqDirectoryCheck>;
	"projects.checkSharedProjectDirectory": Operation<[path: string, projectId: string], AIReqDirectoryCheck>;
	"models.read": Operation<[], AIReqAgentModelSettings>;
	"models.save": Operation<[settings: AIReqAgentModelSettings], null>;
	"models.samples": Operation<[], AIReqAgentModelSettings>;
	"models.revision": Operation<[], number>;
	"models.bindingChanged": Operation<[binding: AIReqAgentModelBinding], boolean>;
	"prompts.read": Operation<[], AIReqRemotePrompts>;
	"prompts.updateDraft": Operation<[value: Record<string, string>], null>;
	"prompts.save": Operation<[value: Record<string, string>], null>;
	"skills.list": Operation<[input: AIReqRemoteSkillsInput], SkillsListResult>;
	"skillDesign.session": Operation<[projectId: string], string>;
	"skillDesign.binding": Operation<[sessionId: string], AIReqAgentModelBinding>;
	"skillDesign.workspaceIdentity": Operation<[projectId: string], string>;
	"skillDesign.read": Operation<[sessionId: string], AIReqSkillDesignDraft>;
	"skillDesign.saveDraft": Operation<[sessionId: string, value: AIReqSkillDesignDraft], null>;
	"skillDesign.prompt": Operation<[sessionId: string, value: AIReqSkillDesignDraft], string>;
	"skillDesign.temporaryDirectory": Operation<[sessionId: string], string>;
	"skillDesign.readPreview": Operation<[sessionId: string], AIReqSkillDesignPreview | null>;
	"skillDesign.listSkills": Operation<[workspacePath: string], SkillSummary[]>;
	"skillDesign.savePreview": Operation<
		[sessionId: string, workspacePath: string, name: string, target: "project" | "user"],
		string
	>;
	"collaboration.peers": Operation<[projectId?: string], AIReqPeer[]>;
	"prototype.setProposalMergeScenario": Operation<
		[projectId: string, irId: string, scenario: AIReqProposalMergeScenario],
		null
	>;
	"prototype.directoryIssue": Operation<[path: string], string | null>;
	"prototype.restoreDirectory": Operation<[path: string], null>;
	"prototype.readPrHandoff": Operation<
		[group: AIReqWorkflowView["groups"][number], scenario?: AIReqPrHandoffScenario],
		AIReqPrHandoff
	>;
	"progressScheduler.read": Operation<[], AIReqAnalysisSnapshot>;
	"progressScheduler.queryTasks": Operation<
		[filter: AIReqAnalysisFilter, page: number, pageSize: number],
		AIReqAnalysisTaskPage
	>;
	"progressScheduler.queryRuns": Operation<
		[filter: AIReqAnalysisHistoryFilter, page: number, pageSize: number],
		AIReqAnalysisPage<AIReqAnalysisRunSummary>
	>;
	"progressScheduler.readRun": Operation<[id: string], AIReqAnalysisRun | null>;
	"progressScheduler.setProjectEnabled": Operation<[projectId: string, enabled: boolean], null>;
	"progressScheduler.configure": Operation<[enabled: boolean, intervalMinutes: number], null>;
	"progressScheduler.runNow": Operation<[filter: AIReqAnalysisFilter], null>;
	"progressScheduler.advance": Operation<[], null>;
}
export type AIReqRemotePath = keyof AIReqRemoteOperations;
export type AIReqRemoteArgs<P extends AIReqRemotePath> = AIReqRemoteOperations[P]["args"];
export type AIReqRemoteResult<P extends AIReqRemotePath> = AIReqRemoteOperations[P]["result"];
export type AIReqRemoteCall = {
	[P in AIReqRemotePath]: { path: P; args: AIReqRemoteArgs<P>; selection?: AIReqSelection };
}[AIReqRemotePath];
export interface AIReqRemoteBootstrap {
	contractVersion: typeof AIREQ_CONTRACT_VERSION;
	provenance: AIReqDataProvenance;
	backend: AIReqBackendView;
	capabilities: AIReqDataSource["capabilities"];
	initialSelection: AIReqSelection;
	scenarioOperations?: boolean;
	employeeDirectory?: AIReqEmployeeDirectory;
	models: {
		choices: readonly { id: string; name: string; provider: string }[];
		settings: AIReqAgentModelSettings;
		samples?: AIReqAgentModelSettings;
		revision: number;
	};
	prompts: AIReqRemotePrompts;
	projects: { directories: AIReqDirectory[]; developmentRoots: Record<string, string> };
	peers: AIReqPeer[];
	skillDesignSample?: AIReqSkillDesignDraft;
}
export type AIReqRemoteEvent =
	| { type: "workflow" }
	| { type: "issues" }
	| { type: "models" }
	| { type: "scheduler" }
	| { type: "freeChats" }
	| { type: "skills"; sessionId: string }
	| { type: "error"; error: AIReqRemoteError };

/** /api/aireq/services reuses @zcode/rpc SocketProtocol binary framing and the
 * existing @zcode/services descriptors/methods/events, not a second RPC schema.
 * Both WebSocket endpoints and HTTP use clientId, employeeId and optional demo;
 * services additionally takes JSON selection, workspace and optional session. */
export type AIReqRemoteServices = IServiceAccessor;
