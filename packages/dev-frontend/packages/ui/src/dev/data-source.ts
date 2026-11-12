import { createContext, createElement, useContext, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { SkillSummary } from "@zcode/shared";
import type { DevAction, DevSelection, DevWorkflowView, DevWorkflowResult, DevNativeSessionRef, DevPeer, DevAgentModelSettings, DevAgentModelBinding, DevSkillDesignDraft, DevSkillDesignPreview, DevPrHandoff, DevPrHandoffScenario, DevWorkspace, DevProposalMergeScenario, DevSrPlanningInput } from "./types.js";
import type { DevProgressScheduler } from "./progress-scheduler.js";

export interface DevBackendView {
  id: string; kind: "developer" | "team"; owner: string; name: string; configDirectory: string; userSkillsDirectory: string;
}

export interface DevDirectory { path: string; name: string; git: boolean; branch: string; repositoryRoot?: string }
export type DevDirectoryCheck = { valid: false; error: string } | { valid: true; root: string; directory: DevDirectory };
export interface DevProjectServices {
  saveRepository?(input: { projectId?: string; name: string; repositoryUrl: string; defaultBranch: string }): Promise<void>;
  readDevelopmentRoot(projectId: string, employeeId?: string): string | undefined;
  listDirectories(): DevDirectory[];
  checkProjectDirectory(path: string, existingRoots: string[]): Promise<DevDirectoryCheck>;
  checkDevelopmentDirectory(path: string, sharedRoot: string): Promise<DevDirectoryCheck>;
  checkSharedProjectDirectory(path: string, projectId: string): Promise<DevDirectoryCheck>;
}
export interface DevModelServices {
  choices: readonly { id: string; name: string; provider: string }[];
  read(): DevAgentModelSettings;
  save(settings: DevAgentModelSettings): void;
  revision(): number;
  subscribe(listener: () => void): () => void;
  bindingChanged(binding: DevAgentModelBinding): boolean;
  samples?: () => DevAgentModelSettings;
}
export interface DevPromptServices {
  read(): { saved: Record<string, string>; draft: Record<string, string> };
  updateDraft(value: Record<string, string>): void;
  save(value: Record<string, string>): void;
}
export interface DevSkillDesignServices {
  session(projectId: string): string;
  binding(sessionId: string): DevAgentModelBinding;
  workspaceIdentity(projectId: string): string;
  read(sessionId: string): DevSkillDesignDraft;
  saveDraft(sessionId: string, value: DevSkillDesignDraft): void;
  subscribe(listener: (sessionId: string) => void): { dispose(): void };
  prompt(sessionId: string, value: DevSkillDesignDraft): string;
  temporaryDirectory(sessionId: string): string;
  readPreview(sessionId: string): DevSkillDesignPreview | undefined;
  listSkills(workspacePath: string): SkillSummary[];
  savePreview(sessionId: string, workspacePath: string, name: string, target: "project" | "user"): string;
  sample?: DevSkillDesignDraft;
}
export interface DevPrototypeScenarios {
  setProposalMergeScenario(projectId: string, irId: string, scenario: DevProposalMergeScenario): void;
  directoryIssue(path: string): string | undefined;
  restoreDirectory(path: string): void;
  readPrHandoff(group: DevWorkflowView["groups"][number], scenario?: DevPrHandoffScenario): DevPrHandoff;
}
export interface DevEmployeeDirectory {
  kind: "sample";
  entries: readonly { employeeId: string; name: string; department: string }[];
}
export interface DevDataSource {
  employeeDirectory?: DevEmployeeDirectory;
  planning?: { updateSr(projectId: string, irId: string, srId: string, input: DevSrPlanningInput): Promise<void> };
  progressScheduler?: DevProgressScheduler;
  progress?: {
    assignOwner(projectId: string, irId: string, employeeId: string): Promise<void>;
    updateSr(projectId: string, irId: string, srId: string, percent: number, reason: string): Promise<void>;
  };
  mode: "prototype" | "omp";
  clientId: string;
  backend?: DevBackendView;
  capabilities: { settingsWrite?: boolean; proposalDiscussion?: boolean; codeDevelopment?: boolean; workflowCommands: readonly DevAction["type"][]; prototypeBusiness: boolean; freeChat: boolean; nativeChat: boolean; nativeSurface: boolean };
  initialSelection: DevSelection;
  readWorkflow(selection: DevSelection): Promise<DevWorkflowView>;
  subscribeWorkflow(listener: () => void): () => void;
  command(action: DevAction, selection: DevSelection, revision: number): Promise<DevWorkflowResult>;
  resolveSession(view: DevWorkflowView, selection: DevSelection): DevNativeSessionRef | undefined;
  retryMaterial(path: string, selection: DevSelection): Promise<boolean>;
  retrySession(selection: DevSelection): Promise<void>;
  createFreeChat(projectId: string): Promise<{ projectId: string; taskId: string }>;
  readFreeChat(taskId: string): Promise<{ projectId: string; taskId: string } | undefined>;
  selectProject(projectId?: string): void;
  readRecentFreeChats(projectId: string): Promise<{ taskId: string }[]>;
  resolveWorkspace(view: DevWorkflowView | undefined, selection: DevSelection): DevWorkspace;
  connectWorkspace(workspace: DevWorkspace, selection: DevSelection, session?: DevNativeSessionRef): Promise<{ services: IServiceAccessor; dispose(): void | Promise<void> }>;
  dispose(): void | Promise<void>;
  projects?: DevProjectServices;
  models?: DevModelServices;
  prompts?: DevPromptServices;
  skillDesign?: DevSkillDesignServices;
  skills?: Pick<IServiceAccessor["skillsService"], "list">;
  collaboration?: { peers(projectId?: string): DevPeer[] };
  freeChats?: { subscribe(listener: () => void): () => void };
  prototype?: DevPrototypeScenarios;
}
const DataSourceContext = createContext<DevDataSource | null>(null);
export function DevDataSourceProvider({ source, children }: { source: DevDataSource; children: ReactNode }) {
  return createElement(DataSourceContext.Provider, { value: source }, children);
}
export function useDevDataSource(): DevDataSource {
  const source = useContext(DataSourceContext);
  if (!source) throw new Error("DevDataSourceProvider is required.");
  return source;
}
export function useOptionalDevDataSource(): DevDataSource | null { return useContext(DataSourceContext); }
