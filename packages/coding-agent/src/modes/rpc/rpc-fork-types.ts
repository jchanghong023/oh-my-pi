/**
 * Fork-extension RPC protocol surface (protocol v3).
 *
 * This module owns the fork-only protocol-v3 side-channel frame types used by
 * `rpc-fork-*` modules. Upstream clients stay on v1/v2 and never receive these
 * frames; a client sees this surface only after it negotiates
 * `negotiate_protocol {protocolVersion:3}`.
 */

/** Fork protocol version; implies v2 chunked framing. */
export const RPC_FORK_PROTOCOL_VERSION = 3;

/** Versions announced in the `ready` frame: upstream v1/v2 plus the fork v3 surface. */
export const RPC_SUPPORTED_PROTOCOL_VERSIONS: [1, 2, 3] = [1, 2, RPC_FORK_PROTOCOL_VERSION];

/** True for every version `negotiate_protocol` accepts (v2 baseline + fork v3). */
export function isNegotiableRpcProtocolVersion(version: number): version is 2 | 3 {
	return version === 2 || version === RPC_FORK_PROTOCOL_VERSION;
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
