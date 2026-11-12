import type { AIReqRemoteResponse } from "./contract.js";
export interface ScopeRequest {
	kind: "http" | "open" | "message" | "close" | "shutdown";
	id: string;
	url?: string;
	body?: string;
	data?: string | Uint8Array | ArrayBuffer;
}
export interface ScopeResponse {
	kind: "response";
	id: string;
	status: number;
	response: AIReqRemoteResponse<unknown>;
}
export type ScopeMessage =
	| ScopeResponse
	| { kind: "ready" }
	| { kind: "send"; id: string; data: string | Uint8Array }
	| { kind: "close"; id: string };
