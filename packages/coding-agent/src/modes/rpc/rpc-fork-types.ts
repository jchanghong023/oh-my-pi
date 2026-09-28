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
 * requirement sections land; empty until then.
 */
export type RpcForkCommand = never;

/** Base shape shared by fork-extension success responses. */
export interface RpcForkSuccessResponseBase {
	id?: string;
	type: "response";
	command: string;
	success: true;
	data?: unknown;
}

/** Wire union of fork-extension success responses, appended to `RpcResponse`. */
export type RpcForkResponse = never;
