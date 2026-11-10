import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { DevNativeSessionRef } from "../workflow-types";
import type { PendingInteraction } from "../../../../../packages/dev-frontend/packages/shared/src/zcode-protocol-v4/snapshot";

/** Browser identity is checked by transport; native state is shared by the exact object/round. */
export interface DevNativeSurfaceTarget {
	projectId: string;
	irId: string;
	srId?: string;
	sessionId: string;
	phase: DevNativeSessionRef["phase"];
	round: number;
	clientId: string;
}
export function devNativeSurfaceOwnerKey(target: DevNativeSurfaceTarget): string {
	return JSON.stringify([
		target.projectId,
		target.irId,
		target.srId ?? null,
		target.sessionId,
		target.phase,
		target.round,
	]);
}
export function sameDevNativeSurfaceOwner(a: DevNativeSurfaceTarget, b: DevNativeSurfaceTarget): boolean {
	return devNativeSurfaceOwnerKey(a) === devNativeSurfaceOwnerKey(b);
}
export interface DevNativeAskResult {
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
export type DevNativeUiValue =
	| string
	| boolean
	| null
	| { grant: "folder" | "target"; always: boolean }
	| { kind: "chat" }
	| DevNativeAskResult;
export interface DevNativeUiRequest extends DevNativeSurfaceTarget {
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
export interface DevNativeUiResponse extends DevNativeSurfaceTarget {
	requestId: string;
	value: DevNativeUiValue;
}
export type DevNativeUiState =
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
export type DevNativeUiStateEvent = DevNativeUiState & {
	t: "native-ui-state";
	target: DevNativeSurfaceTarget;
	sequence: number;
};
export type DevNativeUiEvent =
	| { t: "native-ui"; request: DevNativeUiRequest }
	| { t: "native-ui-end"; requestId: string }
	| DevNativeUiStateEvent;
export interface DevNativePredictionSnapshot {
	target: DevNativeSurfaceTarget;
	generation: number;
	choices: readonly string[];
}
export type DevNativePredictionAction =
	| { type: "cancel" }
	| { type: "draft"; text: string }
	| { type: "shown"; generation: number }
	| { type: "accepted"; generation: number; rank: number };
export type DevNativeSurfaceEvent =
	| DevNativeUiStateEvent
	| { t: "native-prediction"; prediction: DevNativePredictionSnapshot };
export interface DevNativeSurfaceSnapshot {
	target: DevNativeSurfaceTarget;
	events: DevNativeUiStateEvent[];
	pendingInteractions: PendingInteraction[];
	prediction: DevNativePredictionSnapshot;
}
