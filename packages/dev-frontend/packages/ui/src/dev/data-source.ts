import { createContext, createElement, useContext, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { SkillSummary } from "@zcode/shared";
import type { DevAction, DevSelection, DevWorkflowView, DevWorkflowResult, DevNativeSessionRef, DevPeer, DevAgentModelSettings, DevAgentModelBinding, DevSkillDesignDraft, DevPrHandoff, DevPrHandoffScenario, DevWorkspace } from "./types.js";

export interface DevDirectory { path: string; name: string; git: boolean; branch: string; repositoryRoot?: string }
export type DevDirectoryCheck = { valid: false; error: string } | { valid: true; root: string; directory: DevDirectory };
export interface DevProjectServices {
  readDevelopmentRoot(projectId: string, employeeId?: string): string | undefined;
  listDirectories(): DevDirectory[];
  checkProjectDirectory(path: string, existingRoots: string[]): Promise<DevDirectoryCheck>;
  checkDevelopmentDirectory(path: string, sharedRoot: string): Promise<DevDirectoryCheck>;
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
  workspaceIdentity(projectId: string): string;
  read(sessionId: string): DevSkillDesignDraft;
  saveDraft(sessionId: string, value: DevSkillDesignDraft): void;
  subscribe(listener: (sessionId: string) => void): { dispose(): void };
  render(name: string, value: DevSkillDesignDraft): string;
  listSkills(workspacePath: string): SkillSummary[];
  saveSkill(workspacePath: string, name: string, description: string, body: string): string;
  sample?: DevSkillDesignDraft;
}
export interface DevPrototypeScenarios {
  directoryIssue(path: string): string | undefined;
  restoreDirectory(path: string): void;
  readPrHandoff(group: DevWorkflowView["groups"][number], scenario?: DevPrHandoffScenario): DevPrHandoff;
}
export interface DevDataSource {
  mode: "prototype" | "omp";
  clientId: string;
  capabilities: { workflowCommands: readonly DevAction["type"][]; prototypeBusiness: boolean; freeChat: boolean; nativeChat: boolean; nativeSurface: boolean };
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
