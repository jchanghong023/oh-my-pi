export type NativeTaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "blocked"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface NativeTaskActor {
  agentId: string;
  sessionId: string;
  parentSessionId: string;
  title: string;
  status: NativeTaskStatus;
  startedAt?: number;
  endedAt?: number;
}

export interface NativeTaskOutput {
  id: string;
  sessionId: string;
  agentId?: string;
  title: string;
  kind: "transcript" | "file";
  createdAt?: number;
}

export interface NativeTaskRun {
  runId: string;
  sessionId: string;
  toolCallId: string;
  title: string;
  status: NativeTaskStatus;
  startedAt?: number;
  endedAt?: number;
  actors: NativeTaskActor[];
  outputs: NativeTaskOutput[];
}

/** Observed native task invocations, not saved executable graph definitions. */
export interface NativeTaskRunsSnapshot {
  source: "omp-native-task";
  sessionId: string;
  revision: number;
  runs: NativeTaskRun[];
}

export interface NativeTaskOutputContent {
  outputId: string;
  title: string;
  content: string;
  format: "text" | "markdown" | "json";
}

export interface NativeTaskRunsRequest {
  /** Admission scope of the bound native Host; never inferred from the session UUID. */
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
}

export interface NativeTaskOutputRequest extends NativeTaskRunsRequest {
  runId: string;
  outputId: string;
}
