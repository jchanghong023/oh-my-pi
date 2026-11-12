import type { AIReqProgressAnalysis } from "./types.js";

export interface AIReqAnalysisFilter { projectId?: string; irId?: string; srId?: string; srSearch?: string }
export interface AIReqAnalysisProject {
  id: string; name: string; enabled: boolean;
  pendingCount: number; runningCount: number; lastRunAt?: string; lastStatus?: AIReqAnalysisRunSummary["status"];
}
export interface AIReqAnalysisTask {
  id: string; projectId: string; irId: string; irTitle: string; srId: string; srTitle: string;
  branch: string;
  state: "waiting" | "running" | "failed" | "completed" | "paused";
  nextRunAt?: string; lastRunAt?: string; lastRunId?: string; error?: string; percent: number;
}
export interface AIReqAnalysisRunSummary {
  id: string; batchId: string; taskId: string; projectId: string; irId: string; srId: string; srTitle: string;
  branch: string;
  trigger: "schedule" | "manual"; status: "running" | "succeeded" | "failed" | "skipped";
  startedAt: string; endedAt?: string; message: string; before: number; after: number;
}
export interface AIReqAnalysisFailure {
  stage: "仓库读取" | "模型调用" | "文档读取";
  reason: string; nextStep: string; retryable: boolean;
}
export interface AIReqAnalysisRun extends AIReqAnalysisRunSummary { report?: AIReqProgressAnalysis; failure?: AIReqAnalysisFailure }
export interface AIReqAnalysisHistoryFilter extends AIReqAnalysisFilter { status?: AIReqAnalysisRunSummary["status"]; since?: string; until?: string }
export interface AIReqAnalysisPage<T> { items: T[]; total: number; page: number; pageSize: number }
export interface AIReqAnalysisTaskPage extends AIReqAnalysisPage<AIReqAnalysisTask> { eligibleCount: number }
export interface AIReqAnalysisSnapshot {
  enabled: boolean; intervalMinutes: number; nextCheckAt?: string;
  currentTime?: string; lastCheckAt?: string;
  projects: AIReqAnalysisProject[];
  irs: { projectId: string; id: string; title: string }[];
  tasksTotal: number; runsTotal: number; scaleDemo: boolean;
}
/** Scheduler queries are paginated by the owning service. */
export interface AIReqProgressScheduler {
  read(): AIReqAnalysisSnapshot | Promise<AIReqAnalysisSnapshot>;
  queryTasks(filter: AIReqAnalysisFilter, page: number, pageSize: number): AIReqAnalysisTaskPage | Promise<AIReqAnalysisTaskPage>;
  queryRuns(filter: AIReqAnalysisHistoryFilter, page: number, pageSize: number): AIReqAnalysisPage<AIReqAnalysisRunSummary> | Promise<AIReqAnalysisPage<AIReqAnalysisRunSummary>>;
  readRun(id: string): AIReqAnalysisRun | undefined | Promise<AIReqAnalysisRun | undefined>;
  subscribe(listener: () => void): () => void;
  setProjectEnabled(projectId: string, enabled: boolean): void | Promise<void>;
  configure(enabled: boolean, intervalMinutes: number): void | Promise<void>;
  runNow(filter: AIReqAnalysisFilter): void | Promise<void>;
  advance(): void | Promise<void>;
  dispose(): void;
}
