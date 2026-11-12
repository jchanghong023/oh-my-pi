import type { AIReqAgentModelBinding } from "./types.js";

export const ISSUE_TYPES = { bug: "Bug", refactor: "重构", performance: "性能", security: "安全", maintenance: "维护 / 技术债", other: "其他" } as const;
export const ISSUE_STATUSES = { pending: "待开发", developing: "开发中", merging: "待合入", confirming: "待确认", completed: "已完成" } as const;
export interface AIReqIssueScope { projectId: string; releaseId: string }
export interface AIReqIssueInput extends AIReqIssueScope {
  requestId: string;
  title: string;
  type: keyof typeof ISSUE_TYPES;
  priority: "low" | "normal" | "high";
  description: string;
  acceptance: string;
  developerEmployeeId: string;
  requirement?: { irId: string; srId?: string };
}
export interface AIReqIssue extends AIReqIssueInput {
  id: string;
  branch: string;
  status: keyof typeof ISSUE_STATUSES;
  percent: number;
  remaining: string[];
  report: string;
  merged: boolean;
  createdAt: string;
  updatedAt: string;
  confirmedBy?: string;
}
export interface AIReqIssueRun {
  id: string; issueId: string; title: string; startedAt: string;
  status: "succeeded" | "failed"; summary: string;
  modelConfig?: AIReqAgentModelBinding;
}
export interface AIReqIssueSnapshot {
  issues: AIReqIssue[];
  runs: AIReqIssueRun[];
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt?: string;
}
export interface AIReqIssueServices {
  read(scope: AIReqIssueScope): Promise<AIReqIssueSnapshot>;
  create(input: AIReqIssueInput): Promise<AIReqIssue>;
  configure(scope: AIReqIssueScope, enabled: boolean, intervalMinutes: number): Promise<void>;
  runNow(scope: AIReqIssueScope): Promise<void>;
  confirm(scope: AIReqIssueScope, id: string): Promise<void>;
  reopen(scope: AIReqIssueScope, id: string, reason: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
