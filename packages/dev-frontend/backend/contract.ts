import type { IServiceAccessor } from "@zcode/services";
import type { SkillSummary, SkillsListResult, ZCodeProvider } from "@zcode/shared";
import type {
	DevBackendView,
	DevDataSource,
	DevDataProvenance,
	DevDirectory,
	DevDirectoryCheck,
	DevEmployeeDirectory,
} from "../packages/ui/src/dev/data-source.js";
import type {
	DevAction,
	DevAgentModelBinding,
	DevAgentModelSettings,
	DevNativeSessionRef,
	DevPeer,
	DevSelection,
	DevSkillDesignDraft,
	DevSkillDesignPreview,
	DevWorkflowView,
	DevWorkflowResult,
	DevWorkspace,
	DevSrPlanningInput,
	DevProposalMergeScenario,
	DevPrHandoff,
	DevPrHandoffScenario,
} from "../packages/ui/src/dev/types.js";
import type {
	DevAnalysisFilter,
	DevAnalysisHistoryFilter,
	DevAnalysisSnapshot,
	DevAnalysisTaskPage,
	DevAnalysisPage,
	DevAnalysisRunSummary,
	DevAnalysisRun,
} from "../packages/ui/src/dev/progress-scheduler.js";

/** HTTP: GET /api/dev/bootstrap and POST /api/dev/call return the same envelope.
 * Errors use non-2xx status plus a stable code/message, never a success fallback.
 * /api/dev/events carries DevRemoteEvent as JSON WebSocket text frames.
 * Unknown operation names are rejected before invoking a service. */
export const DEV_CONTRACT_VERSION = 1;
export type DevRemoteErrorCode =
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
export interface DevRemoteError {
	code: DevRemoteErrorCode;
	message: string;
}
export type DevRemoteResponse<T> = { ok: true; value: T } | { ok: false; error: DevRemoteError };
export interface DevRemoteWorkflow {
	view: DevWorkflowView;
	session?: DevNativeSessionRef;
	workspace: DevWorkspace;
}
export interface DevRemoteFreeChat {
	projectId: string;
	taskId: string;
}
export interface DevRemoteRepositoryInput {
	projectId?: string;
	name: string;
	repositoryUrl: string;
	defaultBranch: string;
}
export interface DevRemotePrompts {
	saved: Record<string, string>;
	draft: Record<string, string>;
}
export interface DevRemoteSkillsInput {
	workspacePath: string;
	workspaceIdentity?: string;
	provider?: ZCodeProvider;
}
interface Operation<A extends unknown[], R> {
	args: A;
	result: R;
}

/** Frozen /api/dev/call operations. Void/absent top-level results are JSON null. */
export interface DevRemoteOperations {
	readWorkflow: Operation<[selection: DevSelection], DevRemoteWorkflow>;
	readPrHandoff: Operation<[group: DevWorkflowView["groups"][number]], DevPrHandoff>;
	command: Operation<[action: DevAction, selection: DevSelection, revision: number], DevWorkflowResult>;
	retryMaterial: Operation<[path: string, selection: DevSelection], boolean>;
	retrySession: Operation<[selection: DevSelection], null>;
	createFreeChat: Operation<[projectId: string], DevRemoteFreeChat>;
	readFreeChat: Operation<[taskId: string], DevRemoteFreeChat | null>;
	readRecentFreeChats: Operation<[projectId: string], { taskId: string }[]>;
	selectProject: Operation<[projectId?: string], null>;
	"progress.assignOwner": Operation<[projectId: string, irId: string, employeeId: string], null>;
	"progress.updateSr": Operation<
		[projectId: string, irId: string, srId: string, percent: number, reason: string],
		null
	>;
	"planning.updateSr": Operation<[projectId: string, irId: string, srId: string, input: DevSrPlanningInput], null>;
	"projects.saveRepository": Operation<[input: DevRemoteRepositoryInput], null>;
	"projects.readDevelopmentRoot": Operation<[projectId: string, employeeId?: string], string | null>;
	"projects.listDirectories": Operation<[], DevDirectory[]>;
	"projects.checkProjectDirectory": Operation<[path: string, existingRoots: string[]], DevDirectoryCheck>;
	"projects.checkDevelopmentDirectory": Operation<[path: string, sharedRoot: string], DevDirectoryCheck>;
	"projects.checkSharedProjectDirectory": Operation<[path: string, projectId: string], DevDirectoryCheck>;
	"models.read": Operation<[], DevAgentModelSettings>;
	"models.save": Operation<[settings: DevAgentModelSettings], null>;
	"models.samples": Operation<[], DevAgentModelSettings>;
	"models.revision": Operation<[], number>;
	"models.bindingChanged": Operation<[binding: DevAgentModelBinding], boolean>;
	"prompts.read": Operation<[], DevRemotePrompts>;
	"prompts.updateDraft": Operation<[value: Record<string, string>], null>;
	"prompts.save": Operation<[value: Record<string, string>], null>;
	"skills.list": Operation<[input: DevRemoteSkillsInput], SkillsListResult>;
	"skillDesign.session": Operation<[projectId: string], string>;
	"skillDesign.binding": Operation<[sessionId: string], DevAgentModelBinding>;
	"skillDesign.workspaceIdentity": Operation<[projectId: string], string>;
	"skillDesign.read": Operation<[sessionId: string], DevSkillDesignDraft>;
	"skillDesign.saveDraft": Operation<[sessionId: string, value: DevSkillDesignDraft], null>;
	"skillDesign.prompt": Operation<[sessionId: string, value: DevSkillDesignDraft], string>;
	"skillDesign.temporaryDirectory": Operation<[sessionId: string], string>;
	"skillDesign.readPreview": Operation<[sessionId: string], DevSkillDesignPreview | null>;
	"skillDesign.listSkills": Operation<[workspacePath: string], SkillSummary[]>;
	"skillDesign.savePreview": Operation<
		[sessionId: string, workspacePath: string, name: string, target: "project" | "user"],
		string
	>;
	"collaboration.peers": Operation<[projectId?: string], DevPeer[]>;
	"prototype.setProposalMergeScenario": Operation<
		[projectId: string, irId: string, scenario: DevProposalMergeScenario],
		null
	>;
	"prototype.directoryIssue": Operation<[path: string], string | null>;
	"prototype.restoreDirectory": Operation<[path: string], null>;
	"prototype.readPrHandoff": Operation<
		[group: DevWorkflowView["groups"][number], scenario?: DevPrHandoffScenario],
		DevPrHandoff
	>;
	"progressScheduler.read": Operation<[], DevAnalysisSnapshot>;
	"progressScheduler.queryTasks": Operation<
		[filter: DevAnalysisFilter, page: number, pageSize: number],
		DevAnalysisTaskPage
	>;
	"progressScheduler.queryRuns": Operation<
		[filter: DevAnalysisHistoryFilter, page: number, pageSize: number],
		DevAnalysisPage<DevAnalysisRunSummary>
	>;
	"progressScheduler.readRun": Operation<[id: string], DevAnalysisRun | null>;
	"progressScheduler.setProjectEnabled": Operation<[projectId: string, enabled: boolean], null>;
	"progressScheduler.configure": Operation<[enabled: boolean, intervalMinutes: number], null>;
	"progressScheduler.runNow": Operation<[filter: DevAnalysisFilter], null>;
	"progressScheduler.advance": Operation<[], null>;
}
export type DevRemotePath = keyof DevRemoteOperations;
export type DevRemoteArgs<P extends DevRemotePath> = DevRemoteOperations[P]["args"];
export type DevRemoteResult<P extends DevRemotePath> = DevRemoteOperations[P]["result"];
export type DevRemoteCall = {
	[P in DevRemotePath]: { path: P; args: DevRemoteArgs<P>; selection?: DevSelection };
}[DevRemotePath];
export interface DevRemoteBootstrap {
	contractVersion: typeof DEV_CONTRACT_VERSION;
	provenance: DevDataProvenance;
	backend: DevBackendView;
	capabilities: DevDataSource["capabilities"];
	initialSelection: DevSelection;
	scenarioOperations?: boolean;
	employeeDirectory?: DevEmployeeDirectory;
	models: {
		choices: readonly { id: string; name: string; provider: string }[];
		settings: DevAgentModelSettings;
		samples?: DevAgentModelSettings;
		revision: number;
	};
	prompts: DevRemotePrompts;
	projects: { directories: DevDirectory[]; developmentRoots: Record<string, string> };
	peers: DevPeer[];
	skillDesignSample?: DevSkillDesignDraft;
}
export type DevRemoteEvent =
	| { type: "workflow" }
	| { type: "models" }
	| { type: "scheduler" }
	| { type: "freeChats" }
	| { type: "skills"; sessionId: string }
	| { type: "error"; error: DevRemoteError };

/** /api/dev/services reuses @zcode/rpc SocketProtocol binary framing and the
 * existing @zcode/services descriptors/methods/events, not a second RPC schema.
 * Both WebSocket endpoints and HTTP use clientId, employeeId and optional demo;
 * services additionally takes JSON selection, workspace and optional session. */
export type DevRemoteServices = IServiceAccessor;
