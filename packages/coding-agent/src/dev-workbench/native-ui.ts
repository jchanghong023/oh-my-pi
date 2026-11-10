import { randomUUID } from "node:crypto";
import { theme, getAvailableThemesWithPaths, getThemeByName } from "@oh-my-pi/pi-tui/theme";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionApprovalAnswer,
	ExtensionAskDialogResult,
} from "../extensibility/extensions/types";
import { timedOutAskDialogResult } from "../extensibility/extensions/types";
import type {
	DevNativeUiRequest,
	DevNativeUiResponse,
	DevNativeUiState,
	DevNativeUiStateEvent,
	DevNativeSurfaceTarget as DevSessionTarget,
} from "./native/native-surface-types";
import { devNativeSurfaceOwnerKey, sameDevNativeSurfaceOwner } from "./native/native-surface-types";

type UiValue = DevNativeUiResponse["value"];
type UiEvent =
	| { t: "native-ui"; request: DevNativeUiRequest }
	| { t: "native-ui-end"; requestId: string }
	| DevNativeUiStateEvent;
type UiEventInput =
	| Exclude<UiEvent, DevNativeUiStateEvent>
	| (DevNativeUiState & { t: "native-ui-state"; target: DevSessionTarget });
interface PendingRequest {
	request: DevNativeUiRequest;
	current: () => DevSessionTarget;
	validate(value: UiValue): boolean;
	settle(value: UiValue): void;
}
function validImages(value: unknown): boolean {
	if (value === undefined) return true;
	if (!Array.isArray(value)) return false;
	const images: unknown[] = value;
	return images.every(
		image =>
			typeof image === "object" &&
			image !== null &&
			"type" in image &&
			image.type === "image" &&
			"data" in image &&
			typeof image.data === "string" &&
			"mimeType" in image &&
			typeof image.mimeType === "string",
	);
}

/** Human waits belong to the native host, never to a browser connection. */
export class DevNativeUiController {
	readonly #pending = new Map<string, PendingRequest>();
	readonly #listeners = new Set<(event: UiEvent) => void>();
	readonly #editors = new Map<string, string>();
	readonly #surface = new Map<string, DevNativeUiStateEvent>();
	#closed = false;
	#theme: Theme | undefined;
	#sequence = 0;

	observe(listener: (event: UiEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#emit(event: UiEventInput): void {
		const emitted: UiEvent = event.t === "native-ui-state" ? { ...event, sequence: ++this.#sequence } : event;
		if (emitted.t === "native-ui-state") this.#remember(emitted);
		for (const listener of this.#listeners) {
			try {
				listener(emitted);
			} catch {
				this.#listeners.delete(listener);
			}
		}
	}
	#remember(event: DevNativeUiStateEvent): void {
		if (event.method === "notify" || event.method === "rerenderMessage" || event.method === "refreshTranscript")
			return;
		const owner = devNativeSurfaceOwnerKey(event.target);
		if (event.method === "pasteToEditor" || event.method === "setEditorText") {
			this.#surface.set(`${owner}:editor`, {
				...event,
				method: "setEditorText",
				value: this.#editors.get(owner) ?? "",
			});
			return;
		}
		const field = event.method === "setStatus" || event.method === "setWidget" ? `:${event.value.key}` : "";
		this.#surface.set(`${owner}:${event.method}${field}`, event);
	}
	snapshot(target?: DevSessionTarget): DevNativeUiStateEvent[] {
		return [...this.#surface.values()].filter(event => !target || sameDevNativeSurfaceOwner(event.target, target));
	}
	pending(target?: DevSessionTarget): DevNativeUiRequest[] {
		return [...this.#pending.values()]
			.filter(({ request }) => !target || sameDevNativeSurfaceOwner(request, target))
			.map(({ request }) => request);
	}
	updateEditor(target: DevSessionTarget, text: string): void {
		this.#editors.set(devNativeSurfaceOwnerKey(target), text);
		this.#emit({ t: "native-ui-state", target, method: "setEditorText", value: text });
	}
	async respondDevNativeUi(input: DevNativeUiResponse): Promise<{ accepted: boolean; reason?: string }> {
		const pending = this.#pending.get(input.requestId);
		if (!pending) return { accepted: false, reason: "This native request has already ended" };
		let current: DevSessionTarget;
		try {
			current = pending.current();
		} catch {
			return { accepted: false, reason: "Native request owner or generation changed" };
		}
		const request = pending.request;
		if (
			!sameDevNativeSurfaceOwner(request, input) ||
			request.clientId !== input.clientId ||
			!sameDevNativeSurfaceOwner(current, request)
		) {
			return { accepted: false, reason: "Native request owner or generation changed" };
		}
		if (!pending.validate(input.value)) return { accepted: false, reason: "Invalid native response" };
		pending.settle(input.value);
		return { accepted: true };
	}
	cancelSession(sessionId: string): void {
		for (const pending of this.#pending.values()) if (pending.request.sessionId === sessionId) pending.settle(null);
		for (const [key, event] of this.#surface) {
			if (event.target.sessionId !== sessionId) continue;
			this.#editors.delete(devNativeSurfaceOwnerKey(event.target));
			this.#surface.delete(key);
		}
	}
	close(): void {
		this.#closed = true;
		for (const pending of this.#pending.values()) pending.settle(null);
		this.#listeners.clear();
		this.#editors.clear();
		this.#surface.clear();
	}
	async #request(
		current: () => DevSessionTarget,
		body: Omit<DevNativeUiRequest, keyof DevSessionTarget | "requestId">,
		validate: (value: UiValue) => boolean,
		options?: ExtensionUIDialogOptions,
		timeoutValue?: () => UiValue,
	): Promise<UiValue> {
		if (this.#closed || options?.signal?.aborted) return null;
		const target = current();
		const request: DevNativeUiRequest = {
			...body,
			...target,
			requestId: randomUUID(),
		};
		const { promise, resolve } = Promise.withResolvers<UiValue>();
		let timer: Timer | undefined;
		const abort = () => settle(null);
		const settle = (value: UiValue) => {
			if (!this.#pending.delete(request.requestId)) return;
			if (timer) clearTimeout(timer);
			options?.signal?.removeEventListener("abort", abort);
			this.#emit({ t: "native-ui-end", requestId: request.requestId });
			resolve(value);
		};
		this.#pending.set(request.requestId, { request, current, validate, settle });
		options?.signal?.addEventListener("abort", abort, { once: true });
		if (options?.timeout !== undefined) {
			options.onTimeoutStart?.();
			timer = setTimeout(() => {
				options.onTimeout?.();
				settle(timeoutValue ? timeoutValue() : null);
			}, options.timeout);
		}
		this.#emit({ t: "native-ui", request });
		return promise;
	}
	createContext(current: () => DevSessionTarget): ExtensionUIContext {
		const controller = this;
		const editorKey = () => {
			const target = current();
			return devNativeSurfaceOwnerKey(target);
		};
		let expanded = false;
		const emit = (payload: DevNativeUiState) => this.#emit({ ...payload, t: "native-ui-state", target: current() });
		const unsupported = (): never => {
			throw new Error("This native terminal component cannot render in a browser; use a portable native dialog");
		};
		return {
			supportsEditor: true,
			select: async (title, options, dialogOptions) => {
				const value = await this.#request(
					current,
					{ kind: "select", title, options },
					value =>
						value === null ||
						(typeof value === "string" &&
							options.some(option => (typeof option === "string" ? option : option.label) === value)),
					dialogOptions,
				);
				return typeof value === "string" ? value : undefined;
			},
			confirm: async (title, message, options) =>
				(await this.#request(
					current,
					{ kind: "confirm", title, prefill: message },
					value => value === null || typeof value === "boolean",
					options,
				)) === true,
			input: async (title, placeholder, options) => {
				const value = await this.#request(
					current,
					{ kind: "editor", title, prefill: placeholder, secret: options?.secret },
					value => value === null || typeof value === "string",
					options,
				);
				return typeof value === "string" ? value : undefined;
			},
			editor: async (title, prefill, options) => {
				const value = await this.#request(
					current,
					{ kind: "editor", title, prefill },
					value => value === null || typeof value === "string",
					options,
				);
				return typeof value === "string" ? value : undefined;
			},
			askDialog: async (questions, options) => {
				const value = await this.#request(
					current,
					{ kind: "ask", title: "Questions", questions },
					value => {
						if (value === null) return true;
						if (typeof value !== "object" || !("kind" in value)) return false;
						if (value.kind === "chat") return true;
						if (
							value.kind !== "submit" ||
							!("results" in value) ||
							!Array.isArray(value.results) ||
							value.results.length !== questions.length
						)
							return false;
						return questions.every(question => {
							const result = value.results.find(result => result.id === question.id);
							const labels = question.options.map(option => option.label);
							return (
								!!result &&
								result.question === question.question &&
								result.multi === !!question.multi &&
								Array.isArray(result.options) &&
								result.options.length === labels.length &&
								result.options.every((label, index) => label === labels[index]) &&
								Array.isArray(result.selectedOptions) &&
								result.selectedOptions.every(label => labels.includes(label)) &&
								(!!question.multi || result.selectedOptions.length <= 1) &&
								(result.customInput === undefined || typeof result.customInput === "string") &&
								(result.note === undefined || typeof result.note === "string") &&
								validImages(result.customInputImages) &&
								validImages(result.noteImages)
							);
						});
					},
					options,
					() => timedOutAskDialogResult(questions),
				);
				return value === null ? undefined : (value as ExtensionAskDialogResult);
			},
			approve: async (approval, options) => {
				const value = await this.#request(
					current,
					{ kind: "approve", title: approval.compact, approval },
					value =>
						value === null ||
						value === "once" ||
						value === "deny" ||
						(value === "session" && !!approval.session) ||
						(typeof value === "object" &&
							"grant" in value &&
							"always" in value &&
							typeof value.always === "boolean" &&
							!!approval.grants?.some(grant => grant.scope === value.grant)),
					options,
				);
				return value === null ? "deny" : (value as ExtensionApprovalAnswer);
			},
			notify: (message, type) => emit({ method: "notify", value: { message, type } }),
			onTerminalInput: unsupported,
			rerenderMessage: timestamp => emit({ method: "rerenderMessage", value: timestamp }),
			refreshTranscript: ids => emit({ method: "refreshTranscript", value: ids }),
			getLinkClicksAvailable: () => false,
			setStatus: (key, text) => emit({ method: "setStatus", value: { key, text } }),
			setWorkingMessage: message => emit({ method: "setWorkingMessage", value: message }),
			setWidget: (key, content, options) => {
				if (content !== undefined && !Array.isArray(content)) return unsupported();
				emit({ method: "setWidget", value: { key, content, options } });
			},
			setFooter: factory => {
				if (factory) unsupported();
				emit({ method: "setFooter", value: null });
			},
			setHeader: factory => {
				if (factory) unsupported();
				emit({ method: "setHeader", value: null });
			},
			setTitle: title => emit({ method: "setTitle", value: title }),
			custom: unsupported,
			setEditorText: text => {
				this.#editors.set(editorKey(), text);
				emit({ method: "setEditorText", value: text });
			},
			pasteToEditor: text => {
				const key = editorKey();
				this.#editors.set(key, (this.#editors.get(key) ?? "") + text);
				emit({ method: "pasteToEditor", value: text });
			},
			getEditorText: () => this.#editors.get(editorKey()) ?? "",
			addAutocompleteProvider: unsupported,
			setEditorComponent: factory => {
				if (factory) unsupported();
			},
			getEditorComponent: () => undefined,
			get theme() {
				return controller.#theme ?? theme;
			},
			getAllThemes: async () => getAvailableThemesWithPaths(),
			getTheme: async name => getThemeByName(name),
			setTheme: async (value: string | Theme) => {
				const selected = typeof value === "string" ? await getThemeByName(value) : value;
				if (!selected) return { success: false, error: `Native theme is unavailable: ${value}` };
				this.#theme = selected;
				return { success: true };
			},
			getToolsExpanded: () => expanded,
			setToolsExpanded: value => {
				expanded = value;
				emit({ method: "setToolsExpanded", value });
			},
		};
	}
}

export function respondDevNativeUi(
	controller: DevNativeUiController,
	input: DevNativeUiResponse,
): Promise<{ accepted: boolean; reason?: string }> {
	return controller.respondDevNativeUi(input);
}
