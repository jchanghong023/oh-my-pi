import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AIReqNativeSessionRef } from "../workflow-types";
import type { PendingInteraction } from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol-v4/snapshot";

/** Browser identity is checked by transport; native state is shared by the exact object/round. */
export interface AIReqNativeSurfaceTarget {
	projectId: string;
	irId: string;
	srId?: string;
	sessionId: string;
	phase: AIReqNativeSessionRef["phase"];
	round: number;
	clientId: string;
}
export function aiReqNativeSurfaceOwnerKey(target: AIReqNativeSurfaceTarget): string {
	return JSON.stringify([
		target.projectId,
		target.irId,
		target.srId ?? null,
		target.sessionId,
		target.phase,
		target.round,
	]);
}
export function sameAIReqNativeSurfaceOwner(a: AIReqNativeSurfaceTarget, b: AIReqNativeSurfaceTarget): boolean {
	return aiReqNativeSurfaceOwnerKey(a) === aiReqNativeSurfaceOwnerKey(b);
}
export interface AIReqNativeAskResult {
	kind: "submit";
	results: Array<{
		id: string;
		question: string;
		options: string[];
		multi: boolean;
		selectedOptions: string[];
		customInput?: string;
		customInputImages?: ImageContent[];
		note?: string;
		noteImages?: ImageContent[];
		noteOption?: string;
		timedOut?: boolean;
	}>;
}
export type AIReqNativeUiValue =
	| string
	| boolean
	| null
	| { grant: "folder" | "target"; always: boolean }
	| { kind: "chat" }
	| AIReqNativeAskResult;
export interface AIReqNativeUiRequest extends AIReqNativeSurfaceTarget {
	requestId: string;
	kind: "select" | "editor" | "confirm" | "ask" | "approve";
	title: string;
	options?: Array<string | { label: string; description?: string }>;
	prefill?: string;
	secret?: boolean;
	questions?: Array<{
		id: string;
		question: string;
		header?: string;
		options: Array<{ label: string; description?: string; preview?: string }>;
		multi?: boolean;
		recommended?: number;
	}>;
	approval?: {
		full: string;
		compact: string;
		session?: string;
		grants?: readonly { scope: "folder" | "target"; label: string; alwaysLabel: string }[];
	};
}
export interface AIReqNativeUiResponse extends AIReqNativeSurfaceTarget {
	requestId: string;
	value: AIReqNativeUiValue;
}
export type AIReqNativeUiState =
	| { method: "notify"; value: { message: string; type?: "info" | "warning" | "error" } }
	| { method: "setStatus"; value: { key: string; text: string | undefined } }
	| { method: "setWorkingMessage"; value: string | undefined }
	| {
			method: "setWidget";
			value: { key: string; content: string[] | undefined; options?: { placement?: "aboveEditor" | "belowEditor" } };
	  }
	| { method: "setTitle" | "setEditorText" | "pasteToEditor"; value: string }
	| { method: "rerenderMessage"; value: number }
	| { method: "refreshTranscript"; value: readonly string[] }
	| { method: "setToolsExpanded"; value: boolean }
	| { method: "setHeader" | "setFooter"; value: null };
export type AIReqNativeUiStateEvent = AIReqNativeUiState & {
	t: "native-ui-state";
	target: AIReqNativeSurfaceTarget;
	sequence: number;
};
export type AIReqNativeUiEvent =
	| { t: "native-ui"; request: AIReqNativeUiRequest }
	| { t: "native-ui-end"; requestId: string }
	| AIReqNativeUiStateEvent;
export interface AIReqNativePredictionSnapshot {
	target: AIReqNativeSurfaceTarget;
	generation: number;
	choices: readonly string[];
}
export type AIReqNativePredictionAction =
	| { type: "cancel" }
	| { type: "draft"; text: string }
	| { type: "shown"; generation: number }
	| { type: "accepted"; generation: number; rank: number };
export type AIReqNativeSurfaceEvent =
	| AIReqNativeUiStateEvent
	| { t: "native-prediction"; prediction: AIReqNativePredictionSnapshot };
export interface AIReqNativeSurfaceSnapshot {
	target: AIReqNativeSurfaceTarget;
	events: AIReqNativeUiStateEvent[];
	pendingInteractions: PendingInteraction[];
	prediction: AIReqNativePredictionSnapshot;
}
