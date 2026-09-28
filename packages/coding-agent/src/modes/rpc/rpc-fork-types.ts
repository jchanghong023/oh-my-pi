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
 * Wire union of fork-extension commands, appended to `RpcCommand`. Grows as
 * requirement sections land.
 */
export type RpcForkCommand =
	// 4.1 tool permission approval
	| { id?: string; type: "set_approval_mode"; mode: "always-ask" | "write" | "yolo" }
	// 4.2 session listing
	| { id?: string; type: "list_sessions"; scope: "cwd" | "all"; cursor?: string; limit?: number }
	| { id?: string; type: "pin_session"; sessionId: string }
	| { id?: string; type: "unpin_session"; sessionId: string }
	| { id?: string; type: "rename_session"; sessionFile: string; name: string }
	| { id?: string; type: "delete_session"; sessionFile: string };

/** Base shape shared by fork-extension success responses. */
export interface RpcForkSuccessResponseBase {
	id?: string;
	type: "response";
	command: string;
	success: true;
	data?: unknown;
}

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
	| { id?: string; type: "response"; command: "delete_session"; success: true };

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
