/**
 * Fork-extension RPC protocol surface (protocol v3).
 *
 * Everything in the `rpc-fork-*` modules is fork-only (contract:
 * docs-zh-CN/requirements/rpc-ui-protocol.md). Upstream clients stay on v1/v2
 * and never receive fork frames; a client only sees this surface after it
 * negotiates `negotiate_protocol {protocolVersion:3}`. `rpc-types.ts` appends
 * the command/response unions declared here, so the wire contract has a single
 * home per direction while implementations stay in dedicated fork modules.
 */

import type { ProviderValidationConfig } from "../../config/models-config";
/** Fork protocol version; implies v2 chunked framing. */
export const RPC_FORK_PROTOCOL_VERSION = 3;

/** Versions announced in the `ready` frame: upstream v1/v2 plus the fork v3 surface. */
export const RPC_SUPPORTED_PROTOCOL_VERSIONS: [1, 2, 3] = [1, 2, RPC_FORK_PROTOCOL_VERSION];

/** True for every version `negotiate_protocol` accepts (v2 baseline + fork v3). */
export function isNegotiableRpcProtocolVersion(version: number): version is 2 | 3 {
	return version === 2 || version === RPC_FORK_PROTOCOL_VERSION;
}

/** Base shape shared by every fork-extension command. */
export interface RpcForkCommandBase {
	id?: string;
	type: string;
}

/**
 * Wire union of every command registered by the fork config/manage/session
 * controllers, appended to `RpcCommand`.
 */
export type RpcForkCommand =
	// 4.1 tool permission approval
	| { id?: string; type: "set_approval_mode"; mode: "always-ask" | "write" | "yolo" }
	// 4.2 session listing
	| { id?: string; type: "list_sessions"; scope: "cwd" | "all"; cursor?: string; limit?: number }
	| { id?: string; type: "pin_session"; sessionId: string }
	| { id?: string; type: "unpin_session"; sessionId: string }
	| { id?: string; type: "rename_session"; sessionFile: string; name: string }
	| { id?: string; type: "delete_session"; sessionFile: string }
	// 5.1 queued messages
	| { id?: string; type: "get_queue" }
	| { id?: string; type: "remove_queued"; queue: "steering" | "followUp"; entryId: string }
	| { id?: string; type: "reorder_queue"; queue: "steering" | "followUp"; ids: string[] }
	| { id?: string; type: "clear_queue"; queue?: "steering" | "followUp" }
	// 5.2 background jobs
	| { id?: string; type: "get_jobs"; includeRecent?: boolean; recentLimit?: number }
	| { id?: string; type: "cancel_job"; jobId: string }
	// 5.7 file search
	| { id?: string; type: "search_paths"; query: string; cwd?: string; limit?: number }
	// 5.8 session state completion
	| { id?: string; type: "submit_feedback"; messageId: string; rating: "up" | "down"; comment?: string }
	// 5.3 plan mode
	| { id?: string; type: "set_plan_mode"; enabled: boolean }
	| { id?: string; type: "get_plan_state" }
	| { id?: string; type: "list_plans" }
	| { id?: string; type: "read_plan"; path: string }
	| {
			id?: string;
			type: "approve_plan";
			decision: "approve" | "refine" | "reject";
			feedback?: string;
			model?: string;
			/** Project mode: identity returned by the actual pending plan proposal. */
			approvalId?: string;
			/** Project mode: content revision returned by `get_plan_state`. */
			expectedRevision?: string;
	  }
	// 5.6 configuration and management
	| { id?: string; type: "get_settings"; scope: "user" | "project" }
	| {
			id?: string;
			type: "set_settings";
			scope: "user" | "project";
			key: string;
			value: unknown;
			expectedRevision?: string;
	  }
	| { id?: string; type: "unset_settings"; scope: "user" | "project"; key: string; expectedRevision?: string }
	| { id?: string; type: "list_providers" }
	| {
			id?: string;
			type: "upsert_provider";
			provider: Pick<ProviderValidationConfig, "api" | "baseUrl" | "apiKey" | "auth"> & {
				name: string;
				models?: Array<{
					id: string;
					api?: ProviderValidationConfig["api"];
					contextWindow?: number;
					maxTokens?: number;
				}>;
			};
	  }
	| { id?: string; type: "delete_provider"; provider: string }
	| { id?: string; type: "set_model_enabled"; provider: string; modelId: string; enabled: boolean }
	| { id?: string; type: "test_model"; provider: string; modelId: string }
	| { id?: string; type: "list_mcp_servers" }
	| {
			id?: string;
			type: "upsert_mcp_server";
			name: string;
			config: Record<string, unknown>;
			scope: "user" | "project";
	  }
	| { id?: string; type: "delete_mcp_server"; name: string; scope: "user" | "project" }
	| { id?: string; type: "set_mcp_server_disabled"; name: string; disabled: boolean }
	| { id?: string; type: "mcp_reconnect"; name: string }
	| { id?: string; type: "list_skills" }
	| {
			id?: string;
			type: "set_skill_source_enabled";
			source: string;
			enabled: boolean;
			scope?: "user" | "project";
			expectedRevision?: string;
	  }
	| {
			id?: string;
			type: "set_skill_ignored";
			name: string;
			ignored: boolean;
			scope?: "user" | "project";
			expectedRevision?: string;
	  }
	| { id?: string; type: "list_agent_definitions" }
	| {
			id?: string;
			type: "upsert_agent_definition";
			definition: { name: string; description: string; tools?: string[]; model?: string; systemPrompt?: string };
	  }
	| { id?: string; type: "delete_agent_definition"; name: string }
	| { id?: string; type: "get_usage"; provider?: string; days?: number; history?: boolean }
	| { id?: string; type: "get_stats_summary"; range?: string };

/** Wire union of fork-extension success responses, appended to `RpcResponse`. */
export type RpcForkResponse =
	| {
			id?: string;
			type: "response";
			command: "set_approval_mode";
			success: true;
			data: { approvalMode: "always-ask" | "write" | "yolo" };
	  }
	| {
			id?: string;
			type: "response";
			command: "list_sessions";
			success: true;
			data: import("./rpc-fork-sessions").RpcForkSessionList;
	  }
	| {
			id?: string;
			type: "response";
			command: "pin_session" | "unpin_session";
			success: true;
			data: { pinned: boolean };
	  }
	| { id?: string; type: "response"; command: "rename_session"; success: true }
	| { id?: string; type: "response"; command: "delete_session"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_queue";
			success: true;
			data: import("./rpc-fork-queue").RpcForkQueueSnapshot;
	  }
	| { id?: string; type: "response"; command: "remove_queued" | "reorder_queue" | "clear_queue"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_jobs";
			success: true;
			data: {
				running: import("./rpc-fork-jobs").RpcForkJobRow[];
				recent: import("./rpc-fork-jobs").RpcForkJobRow[];
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "cancel_job";
			success: true;
			data: { jobId: string; status: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "search_paths";
			success: true;
			data: { entries: Array<{ path: string; type: "file" | "dir" }>; truncated: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "submit_feedback";
			success: true;
			data: { stored: true; file: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_plan_mode";
			success: true;
			data: { enabled: boolean; planFilePath?: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_plan_state";
			success: true;
			data: {
				enabled: boolean;
				planFilePath?: string;
				workflow?: "parallel" | "iterative";
				pendingApproval?: boolean;
				approvalId?: string;
				revision?: string;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "list_plans";
			success: true;
			data: { plans: Array<{ path: string; title?: string; modified?: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "read_plan";
			success: true;
			data: { content: string; path: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "approve_plan";
			success: true;
			data: { decision: "approve" | "refine" | "reject"; dispatched: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command:
				| "get_settings"
				| "list_providers"
				| "list_mcp_servers"
				| "list_skills"
				| "list_agent_definitions"
				| "get_usage"
				| "get_stats_summary";
			success: true;
			data: Record<string, unknown>;
	  }
	| {
			id?: string;
			type: "response";
			command:
				| "set_settings"
				| "unset_settings"
				| "upsert_provider"
				| "delete_provider"
				| "set_model_enabled"
				| "upsert_mcp_server"
				| "delete_mcp_server"
				| "set_mcp_server_disabled"
				| "mcp_reconnect"
				| "set_skill_source_enabled"
				| "set_skill_ignored"
				| "upsert_agent_definition"
				| "delete_agent_definition";
			success: true;
			data?: Record<string, unknown>;
	  }
	| {
			id?: string;
			type: "response";
			command: "test_model";
			success: true;
			data: import("./rpc-fork-types").RpcForkModelTestResult;
	  };

// ============================================================================
// Fork bypass event frames (server → client)
// ============================================================================

/** 5.1: queue contents or counts may have changed; clients re-pull `get_queue`. */
export interface RpcForkQueueUpdatedFrame {
	type: "queue_updated";
	steeringCount: number;
	followUpCount: number;
	/** Queue revision after the change; `clear_queue` compares it via expectedRevision. */
	revision: number;
}

/** 5.6 A: one-shot model connectivity test result (six-way failure attribution). */
export interface RpcForkModelTestResult {
	ok: boolean;
	latencyMs: number;
	/** Failure attribution when `ok` is false. */
	error?: {
		category: "auth_failed" | "model_not_found" | "rate_limited" | "network" | "server" | "endpoint_not_configured";
		message: string;
		httpStatus?: number;
	};
}

/** 5.6 B event: settings files changed; clients re-pull (best effort). */
export interface RpcForkSettingsChangedFrame {
	type: "settings_changed";
	scope: "user" | "project";
}

/** 5.8: one extension-hook handler execution (per-hook telemetry). */
export interface RpcForkHookExecutedFrame {
	type: "hook_executed";
	hookId: string;
	event: string;
	source: "user" | "workspace" | "plugin";
	durationMs: number;
	status: "ok" | "timeout" | "error" | "aborted";
	reason?: string;
}

// ============================================================================
// Rich ask (requirement 4.3)
// ============================================================================

export interface RpcForkAskOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface RpcForkAskQuestion {
	id: string;
	question: string;
	header?: string;
	options: RpcForkAskOption[];
	multi?: boolean;
	/** 0-based default index used by timeout auto-submit. */
	recommended?: number;
}

/** Server → client: full question set of one ask tool invocation (v3 only). */
export interface RpcForkAskRequestFrame {
	type: "ask_request";
	id: string;
	questions: RpcForkAskQuestion[];
	note?: string;
	timeoutMs?: number;
	/** Absolute server-clock deadline matching `timeoutMs`. */
	deadlineAt?: number;
}

export interface RpcForkAskAnswer {
	questionId: string;
	/** Chosen option labels; empty array is a valid "select none" for multi questions. */
	selected: string[];
	/** Custom "Other" text. */
	other?: string;
}

/** Client → server bypass frame (immediate dispatch, same lane as extension_ui_response). */
export type RpcForkAskResponseFrame =
	| { type: "ask_response"; id: string; answers: RpcForkAskAnswer[] }
	| { type: "ask_response"; id: string; chat: string | boolean }
	| { type: "ask_response"; id: string; cancelled: true };

/** Client → server bypass frame: idempotent countdown pause (first one wins). */
export interface RpcForkAskPauseFrame {
	type: "ask_pause";
	targetId: string;
}
