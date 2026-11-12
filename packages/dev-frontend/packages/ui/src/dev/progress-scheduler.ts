import type { DevProgressAnalysis } from "./types.js";

export interface DevAnalysisFilter { projectId?: string; irId?: string; srId?: string; srSearch?: string }
export interface DevAnalysisProject {
  id: string; name: string; enabled: boolean;
  pendingCount: number; runningCount: number; lastRunAt?: string; lastStatus?: DevAnalysisRunSummary["status"];
}
export interface DevAnalysisTask {
  id: string; projectId: string; irId: string; irTitle: string; srId: string; srTitle: string;
  branch: string;
  state: "waiting" | "running" | "failed" | "completed" | "paused";
  nextRunAt?: string; lastRunAt?: string; lastRunId?: string; error?: string; percent: number;
}
export interface DevAnalysisRunSummary {
  id: string; batchId: string; taskId: string; projectId: string; irId: string; srId: string; srTitle: string;
  branch: string;
  trigger: "schedule" | "manual"; status: "running" | "succeeded" | "failed" | "skipped";
  startedAt: string; endedAt?: string; message: string; before: number; after: number;
}
export interface DevAnalysisFailure {
  stage: "仓库读取" | "模型调用" | "文档读取";
  reason: string; nextStep: string; retryable: boolean;
}
export interface DevAnalysisRun extends DevAnalysisRunSummary { report?: DevProgressAnalysis; failure?: DevAnalysisFailure }
export interface DevAnalysisHistoryFilter extends DevAnalysisFilter { status?: DevAnalysisRunSummary["status"]; since?: string; until?: string }
export interface DevAnalysisPage<T> { items: T[]; total: number; page: number; pageSize: number }
export interface DevAnalysisTaskPage extends DevAnalysisPage<DevAnalysisTask> { eligibleCount: number }
export interface DevAnalysisSnapshot {
  enabled: boolean; intervalMinutes: number; nextCheckAt?: string;
  currentTime?: string; lastCheckAt?: string;
  projects: DevAnalysisProject[];
  irs: { projectId: string; id: string; title: string }[];
  tasksTotal: number; runsTotal: number; scaleDemo: boolean;
}
/** Scheduler queries are paginated by the owning service. */
export interface DevProgressScheduler {
  read(): DevAnalysisSnapshot | Promise<DevAnalysisSnapshot>;
  queryTasks(filter: DevAnalysisFilter, page: number, pageSize: number): DevAnalysisTaskPage | Promise<DevAnalysisTaskPage>;
  queryRuns(filter: DevAnalysisHistoryFilter, page: number, pageSize: number): DevAnalysisPage<DevAnalysisRunSummary> | Promise<DevAnalysisPage<DevAnalysisRunSummary>>;
  readRun(id: string): DevAnalysisRun | undefined | Promise<DevAnalysisRun | undefined>;
  subscribe(listener: () => void): () => void;
  setProjectEnabled(projectId: string, enabled: boolean): void | Promise<void>;
  configure(enabled: boolean, intervalMinutes: number): void | Promise<void>;
  runNow(filter: DevAnalysisFilter): void | Promise<void>;
  advance(): void | Promise<void>;
  dispose(): void;
}
