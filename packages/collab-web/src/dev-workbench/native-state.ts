import type { DevNativeUiStateEvent, DevSessionTarget } from "../../../coding-agent/src/spec-driven/types";
import type { Notice } from "../lib/client";
import type { ComposerEditorUpdate } from "../components/shell/Composer";

export interface NativeWidget {
	content: readonly string[];
	placement: "aboveEditor" | "belowEditor";
}
export type NativeEditorUpdate = ComposerEditorUpdate;
export interface NativeViewState {
	target: DevSessionTarget;
	revision: number;
	statuses: ReadonlyMap<string, string>;
	widgets: ReadonlyMap<string, NativeWidget>;
	workingMessage: string | null;
	title: string | null;
	toolsExpanded: boolean | undefined;
	editorUpdate: NativeEditorUpdate | null;
	notices: readonly Notice[];
	customHeader: null;
	customFooter: null;
}

/** Native UI state is presentation, not a second session, action record, or prompt queue. */
export function reduceNativeView(
	previous: NativeViewState | undefined,
	event: DevNativeUiStateEvent,
	identity: string,
	editorText: string,
	now: number,
): NativeViewState {
	const state: NativeViewState = previous ?? {
		target: event.target,
		revision: 0,
		statuses: new Map(),
		widgets: new Map(),
		workingMessage: null,
		title: null,
		toolsExpanded: undefined,
		editorUpdate: null,
		notices: [],
		customHeader: null,
		customFooter: null,
	};
	const next = { ...state, revision: state.revision + 1 };
	switch (event.method) {
		case "notify":
			return {
				...next,
				notices: [
					...state.notices.slice(-49),
					{ id: -next.revision, level: event.value.type ?? "info", message: event.value.message, at: now },
				],
			};
		case "setStatus": {
			const statuses = new Map(state.statuses);
			if (event.value.text === undefined) statuses.delete(event.value.key);
			else statuses.set(event.value.key, event.value.text);
			return { ...next, statuses };
		}
		case "setWidget": {
			const widgets = new Map(state.widgets);
			if (event.value.content === undefined) widgets.delete(event.value.key);
			else
				widgets.set(event.value.key, {
					content: event.value.content,
					placement: event.value.options?.placement ?? "aboveEditor",
				});
			return { ...next, widgets };
		}
		case "setWorkingMessage":
			return { ...next, workingMessage: event.value ?? null };
		case "setTitle":
			return { ...next, title: event.value };
		case "setToolsExpanded":
			return { ...next, toolsExpanded: event.value };
		case "setEditorText":
			return { ...next, editorUpdate: { identity, revision: next.revision, text: event.value } };
		case "pasteToEditor":
			return { ...next, editorUpdate: { identity, revision: next.revision, text: editorText + event.value } };
		case "setHeader":
			return { ...next, customHeader: null };
		case "setFooter":
			return { ...next, customFooter: null };
		case "rerenderMessage":
		case "refreshTranscript":
			return next;
	}
}
