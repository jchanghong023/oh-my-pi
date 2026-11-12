import { createContext, createElement, useContext, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { SkillSummary } from "@zcode/shared";
import type { AIReqAction, AIReqSelection, AIReqWorkflowView, AIReqWorkflowResult, AIReqNativeSessionRef, AIReqPeer, AIReqAgentModelSettings, AIReqAgentModelBinding, AIReqSkillDesignDraft, AIReqSkillDesignPreview, AIReqPrHandoff, AIReqPrHandoffScenario, AIReqWorkspace, AIReqProposalMergeScenario, AIReqSrPlanningInput } from "./types.js";
import type { AIReqProgressScheduler } from "./progress-scheduler.js";

export interface AIReqBackendView {
  id: string; kind: "developer" | "team"; owner: string; name: string; configDirectory: string; userSkillsDirectory: string;
}

/** Factual data origin only; supported workflows are selected by capabilities. */
export interface AIReqDataProvenance { kind: "sample" | "live"; notice?: string }

export interface AIReqDirectory { path: string; name: string; git: boolean; branch: string; repositoryRoot?: string }
export type AIReqDirectoryCheck = { valid: false; error: string } | { valid: true; root: string; directory: AIReqDirectory };
export interface AIReqProjectServices {
  saveRepository?(input: { projectId?: string; name: string; repositoryUrl: string; defaultBranch: string }): Promise<void>;
  readDevelopmentRoot(projectId: string, employeeId?: string): string | undefined;
  listDirectories(): AIReqDirectory[];
  checkProjectDirectory(path: string, existingRoots: string[]): Promise<AIReqDirectoryCheck>;
  checkDevelopmentDirectory(path: string, sharedRoot: string): Promise<AIReqDirectoryCheck>;
  checkSharedProjectDirectory(path: string, projectId: string): Promise<AIReqDirectoryCheck>;
}
export interface AIReqModelServices {
  choices: readonly { id: string; name: string; provider: string }[];
  read(): AIReqAgentModelSettings;
  save(settings: AIReqAgentModelSettings): void | Promise<void>;
  revision(): number;
  subscribe(listener: () => void): () => void;
  bindingChanged(binding: AIReqAgentModelBinding): boolean;
  samples?: () => AIReqAgentModelSettings;
}
export interface AIReqPromptServices {
  read(): { saved: Record<string, string>; draft: Record<string, string> };
  updateDraft(value: Record<string, string>): void;
  save(value: Record<string, string>): void | Promise<void>;
}
export interface AIReqSkillDesignServices {
  session(projectId: string): string | Promise<string>;
  binding(sessionId: string): AIReqAgentModelBinding | Promise<AIReqAgentModelBinding>;
  workspaceIdentity(projectId: string): string | Promise<string>;
  read(sessionId: string): AIReqSkillDesignDraft | Promise<AIReqSkillDesignDraft>;
  saveDraft(sessionId: string, value: AIReqSkillDesignDraft): void | Promise<void>;
  subscribe(listener: (sessionId: string) => void): { dispose(): void };
  prompt(sessionId: string, value: AIReqSkillDesignDraft): string | Promise<string>;
  temporaryDirectory(sessionId: string): string | Promise<string>;
  readPreview(sessionId: string): AIReqSkillDesignPreview | undefined | Promise<AIReqSkillDesignPreview | undefined>;
  listSkills(workspacePath: string): SkillSummary[] | Promise<SkillSummary[]>;
  savePreview(sessionId: string, workspacePath: string, name: string, target: "project" | "user"): string | Promise<string>;
  sample?: AIReqSkillDesignDraft;
}
export interface AIReqPrototypeScenarios {
  setProposalMergeScenario(projectId: string, irId: string, scenario: AIReqProposalMergeScenario): void | Promise<void>;
  directoryIssue(path: string): string | undefined | Promise<string | undefined>;
  restoreDirectory(path: string): void | Promise<void>;
  readPrHandoff(group: AIReqWorkflowView["groups"][number], scenario?: AIReqPrHandoffScenario): AIReqPrHandoff | Promise<AIReqPrHandoff>;
}
export interface AIReqEmployeeDirectory {
  kind: "sample" | "live";
  entries: readonly { employeeId: string; name: string; department: string }[];
}
export interface AIReqDataSource {
  employeeDirectory?: AIReqEmployeeDirectory;
  planning?: { updateSr(projectId: string, irId: string, srId: string, input: AIReqSrPlanningInput): Promise<void> };
  progressScheduler?: AIReqProgressScheduler;
  progress?: {
    assignOwner(projectId: string, irId: string, employeeId: string): Promise<void>;
    updateSr(projectId: string, irId: string, srId: string, percent: number, reason: string): Promise<void>;
  };
  provenance: AIReqDataProvenance;
  clientId: string;
  backend?: AIReqBackendView;
  capabilities: { settingsWrite?: boolean; proposalDiscussion?: boolean; codeDevelopment?: boolean; workflowCommands: readonly AIReqAction["type"][]; requirementManagement: boolean; freeChat: boolean; nativeChat: boolean; nativeSurface: boolean };
  initialSelection: AIReqSelection;
  refreshIdentity?(): Promise<void>;
  readWorkflow(selection: AIReqSelection): Promise<AIReqWorkflowView>;
  readPrHandoff(group: AIReqWorkflowView["groups"][number]): Promise<AIReqPrHandoff>;
  subscribeWorkflow(listener: () => void): () => void;
  command(action: AIReqAction, selection: AIReqSelection, revision: number): Promise<AIReqWorkflowResult>;
  resolveSession(view: AIReqWorkflowView, selection: AIReqSelection): AIReqNativeSessionRef | undefined;
  retryMaterial(path: string, selection: AIReqSelection): Promise<boolean>;
  retrySession(selection: AIReqSelection): Promise<void>;
  createFreeChat(projectId: string): Promise<{ projectId: string; taskId: string }>;
  readFreeChat(taskId: string): Promise<{ projectId: string; taskId: string } | undefined>;
  selectProject(projectId?: string): void;
  readRecentFreeChats(projectId: string): Promise<{ taskId: string }[]>;
  resolveWorkspace(view: AIReqWorkflowView | undefined, selection: AIReqSelection): AIReqWorkspace;
  connectWorkspace(workspace: AIReqWorkspace, selection: AIReqSelection, session?: AIReqNativeSessionRef): Promise<{ services: IServiceAccessor; dispose(): void | Promise<void> }>;
  dispose(): void | Promise<void>;
  projects?: AIReqProjectServices;
  models?: AIReqModelServices;
  prompts?: AIReqPromptServices;
  skillDesign?: AIReqSkillDesignServices;
  skills?: Pick<IServiceAccessor["skillsService"], "list">;
  collaboration?: { peers(projectId?: string): AIReqPeer[] };
  freeChats?: { subscribe(listener: () => void): () => void };
  prototype?: AIReqPrototypeScenarios;
}
const DataSourceContext = createContext<AIReqDataSource | null>(null);
export function AIReqDataSourceProvider({ source, children }: { source: AIReqDataSource; children: ReactNode }) {
  return createElement(DataSourceContext.Provider, { value: source }, children);
}
export function useAIReqDataSource(): AIReqDataSource {
  const source = useContext(DataSourceContext);
  if (!source) throw new Error("AIReqDataSourceProvider is required.");
  return source;
}
export function useOptionalAIReqDataSource(): AIReqDataSource | null { return useContext(DataSourceContext); }
