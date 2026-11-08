import { AsyncLocalStorage } from "node:async_hooks";
import type {
	PendingInteraction,
	UserInputRequestPayload,
} from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/snapshot";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import type { CollabHost } from "../collab/host";
import type {
	ExtensionApprovalAnswer,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "../extensibility/extensions/types";
import { getExtensionUISelectOptionLabel, timedOutAskDialogResult } from "../extensibility/extensions/types";
import type { AgentSession } from "../session/agent-session";
import type { WebGuiBrowserAction } from "../slash-commands/types";
import type { NativeWebGuiCommandOwner } from "./native-command-host";

export interface NativeWebGuiInteractionOrigin {
	connectionId: string;
	clientId?: string;
	sessionId?: string;
}
const interactionOrigin = new AsyncLocalStorage<NativeWebGuiInteractionOrigin>();
export function withNativeWebGuiInteractionScope<T>(
	origin: NativeWebGuiInteractionOrigin,
	task: () => Promise<T>,
): Promise<T> {
	return interactionOrigin.run(origin, task);
}
export function nativeWebGuiInteractionOrigin(): NativeWebGuiInteractionOrigin | undefined {
	return interactionOrigin.getStore();
}
const localDialogs = new AsyncLocalStorage<boolean>();
export function withNativeWebGuiLocalDialogs<T>(task: () => Promise<T>): Promise<T> {
	return localDialogs.run(true, task);
}

let admitHandoff:
	| ((origin: NativeWebGuiInteractionOrigin, interactionId: string, session: AgentSession) => boolean)
	| undefined;
export function configureNativeWebGuiHandoffAdmission(
	admit: (origin: NativeWebGuiInteractionOrigin, interactionId: string, session: AgentSession) => boolean,
): () => void {
	const previous = admitHandoff;
	admitHandoff = admit;
	return () => {
		if (admitHandoff === admit) admitHandoff = previous;
	};
}

export interface NativeWebGuiInteractionAnswer {
	optionId?: string;
	freeText?: string;
	action?: "accept" | "decline" | "cancel";
	content?: Record<string, unknown>;
}

export interface NativeWebGuiInteractionBindings {
	setToolUIContext: (ui: ExtensionUIContext, hasUI: boolean) => void;
	restoreToolUIContext?: () => void;
	commandHost?: NativeWebGuiCommandOwner;
}

interface PendingRequest {
	interaction: PendingInteraction;
	sessionId: string;
	origin?: NativeWebGuiInteractionOrigin;
	answer: (answer: NativeWebGuiInteractionAnswer) => unknown;
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	cleanup: () => void;
}

function isNativeNavigation(payload: PendingInteraction["payload"]): boolean {
	if (payload.kind !== "userInput") return false;
	const input = payload.input;
	return (
		payload.toolName === "webgui-command" &&
		typeof input === "object" &&
		input !== null &&
		"kind" in input &&
		input.kind === "webgui-browser-action" &&
		"action" in input &&
		input.action === "openSession"
	);
}

/** One broker per actual native session, never per browser tab or global current cwd. */
export class NativeWebGuiQuestions {
	readonly #session: AgentSession;
	readonly #requests = new Map<string, PendingRequest>();
	readonly #listeners = new Set<() => void>();
	readonly ui: ExtensionUIContext;
	#restore: (() => void) | undefined;
	#getGuestHost: (() => CollabHost | undefined) | undefined;

	constructor(session: AgentSession) {
		this.#session = session;
		const unavailable = (): never => {
			throw new Error("This operation requires an interactive host surface");
		};
		const notify = (message: string) => {
			session.emitNotice("info", message, "webgui-command");
		};
		const ui: ExtensionUIContext = {
			select: unavailable,
			confirm: unavailable,
			input: unavailable,
			notify,
			onTerminalInput: unavailable,
			rerenderMessage: unavailable,
			refreshTranscript: unavailable,
			getLinkClicksAvailable: () => false,
			setStatus: (_key, text) => {
				if (text) notify(text);
			},
			setWorkingMessage: message => {
				if (message) notify(message);
			},
			setWidget: unavailable,
			setFooter: unavailable,
			setHeader: unavailable,
			setTitle: notify,
			custom: unavailable,
			setEditorText: unavailable,
			pasteToEditor: unavailable,
			getEditorText: unavailable,
			editor: unavailable,
			addAutocompleteProvider: unavailable,
			setEditorComponent: unavailable,
			getEditorComponent: () => undefined,
			theme,
			getAllThemes: unavailable,
			getTheme: unavailable,
			setTheme: unavailable,
			getToolsExpanded: unavailable,
			setToolsExpanded: unavailable,
		};
		ui.select = (title, options, dialogOptions) => {
			const labels = options.map(getExtensionUISelectOptionLabel);
			return this.#request(
				{
					kind: "userInput",
					prompt: title,
					freeText: false,
					options: labels.map((label, index) => ({ optionId: String(index), label })),
				},
				answer => {
					if (answer.action === "cancel" || answer.action === "decline") return undefined;
					const label = answer.optionId === undefined ? answer.freeText : labels[Number(answer.optionId)];
					if (label === undefined || !labels.includes(label)) throw new Error("Select a current native option");
					return label;
				},
				dialogOptions,
				undefined,
				{ kind: "select", title, options },
			);
		};
		ui.confirm = (title, message, dialogOptions) =>
			this.#request(
				{
					kind: "userInput",
					prompt: `${title}\n${message}`,
					freeText: false,
					options: [
						{ optionId: "accept", label: "Yes" },
						{ optionId: "decline", label: "No" },
					],
				},
				answer => {
					if (answer.action === "cancel" || answer.action === "decline" || answer.optionId === "decline")
						return false;
					if (answer.action === "accept" || answer.optionId === "accept") return true;
					throw new Error("Confirm or decline this native request");
				},
				dialogOptions,
				undefined,
				{ kind: "select", title: `${title}\n${message}`, options: ["Yes", "No"] },
			);
		ui.input = (title, placeholder, dialogOptions) =>
			this.#request(
				{
					kind: "userInput",
					prompt: title,
					freeText: true,
					sensitive: dialogOptions?.secret === true,
					...(placeholder ? { input: { placeholder } } : {}),
				},
				answer => {
					if (answer.action === "cancel" || answer.action === "decline") return undefined;
					if (typeof answer.freeText !== "string") throw new Error("Enter a native text response");
					return answer.freeText;
				},
				dialogOptions,
				undefined,
				dialogOptions?.secret ? undefined : { kind: "editor", title },
			);
		ui.editor = (title, prefill, options) =>
			this.#request(
				{
					kind: "userInput",
					prompt: title,
					freeText: true,
					sensitive: options?.secret === true,
					input: { multiline: true, prefill: prefill ?? "" },
				},
				answer => {
					if (answer.action === "cancel" || answer.action === "decline") return undefined;
					if (typeof answer.freeText !== "string") throw new Error("Enter native editor text");
					return answer.freeText;
				},
				options,
				undefined,
				options?.secret ? undefined : { kind: "editor", title, prefill },
			);
		Object.defineProperty(ui, "askDialog", {
			get: () =>
				this.#getGuestHost?.()
					? undefined
					: (questions: ExtensionAskDialogQuestion[], options?: ExtensionUIDialogOptions) =>
							this.#ask(questions, options),
		});
		ui.approve = async (prompt, options): Promise<ExtensionApprovalAnswer> => {
			const choices: Array<{ label: string; answer: ExtensionApprovalAnswer }> = [
				{ label: "Approve once", answer: "once" },
				...(prompt.session ? [{ label: prompt.session, answer: "session" as const }] : []),
				...(prompt.grants ?? []).flatMap(grant => [
					{ label: grant.label, answer: { grant: grant.scope, always: false } },
					{ label: grant.alwaysLabel, answer: { grant: grant.scope, always: true } },
				]),
				{ label: "Deny", answer: "deny" },
			];
			const selected = await ui.select(
				prompt.full,
				choices.map(choice => choice.label),
				options,
			);
			return choices.find(choice => choice.label === selected)?.answer ?? "deny";
		};
		ui.notify = notify;
		this.ui = ui;
	}

	get pendingInteractions(): PendingInteraction[] {
		return [...this.#requests.values()].map(request => request.interaction);
	}

	pendingInteractionsFor(origin: NativeWebGuiInteractionOrigin): PendingInteraction[] {
		return [...this.#requests.values()]
			.filter(
				request =>
					!request.origin ||
					(request.origin.connectionId === origin.connectionId && request.origin.clientId === origin.clientId),
			)
			.map(request => request.interaction);
	}

	cancelConnectionActions(connectionId: string): void {
		for (const [id, request] of this.#requests) {
			if (request.origin?.connectionId === connectionId)
				this.#remove(id, new Error("Originating browser connection closed"));
		}
	}

	async browserAction(
		action: WebGuiBrowserAction,
		options?: ExtensionUIDialogOptions,
	): Promise<Record<string, unknown>> {
		const origin = interactionOrigin.getStore();
		if (!origin) throw new Error("Browser command action has no originating connection");
		return this.#request(
			{
				kind: "userInput",
				toolName: "webgui-command",
				prompt: action.action,
				freeText: false,
				sensitive: action.action === "openUrl",
				input: {
					kind: "webgui-browser-action",
					...action,
					originSessionId: origin.sessionId ?? this.#session.sessionId,
					connectionId: origin.connectionId,
					clientId: origin.clientId,
				},
			},
			answer => {
				if (answer.action !== "accept") throw new Error("Browser command action was not applied");
				return answer.content ?? {};
			},
			{
				...options,
				timeout:
					options?.timeout ??
					(action.action === "recordStop" || action.action === "liveStop" ? 15_000 : undefined),
			},
			origin,
		);
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}

	async #request<T>(
		payload: UserInputRequestPayload,
		answer: (answer: NativeWebGuiInteractionAnswer) => T,
		options?: ExtensionUIDialogOptions,
		origin?: NativeWebGuiInteractionOrigin,
		guestDialog?: CollabUiRequestDraft,
		timeoutAnswer?: () => T,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		if (this.#session.isDisposed && !(origin && isNativeNavigation(payload)))
			throw new Error("Native session has closed");
		const id = `webgui-question:${crypto.randomUUID()}`;
		const pending = Promise.withResolvers<unknown>();
		let timer: Timer | undefined;
		const mirrorAbort = new AbortController();
		const cancel = () => this.#remove(id, options?.signal?.reason ?? new Error("Native interaction cancelled"));
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			options?.signal?.removeEventListener("abort", cancel);
			mirrorAbort.abort();
		};
		this.#requests.set(id, {
			interaction: { interactionId: id, kind: "userInput", anchorRowId: null, createdAt: Date.now(), payload },
			sessionId: this.#session.sessionId,
			origin,
			answer,
			resolve: pending.resolve,
			reject: pending.reject,
			cleanup,
		});
		if (
			origin &&
			payload.toolName === "webgui-command" &&
			typeof payload.input === "object" &&
			payload.input !== null &&
			"action" in payload.input &&
			payload.input.action === "openUrl"
		)
			admitHandoff?.(origin, id, this.#session);
		const mirrored =
			guestDialog && !localDialogs.getStore()
				? this.#getGuestHost?.()?.requestGuestUi(guestDialog, mirrorAbort.signal, { retainOnReconnect: true })
				: null;
		if (mirrored)
			void mirrored
				.then(async result => {
					if (result.kind !== "answered" || !this.#requests.has(id)) return;
					const selected =
						result.value === undefined
							? undefined
							: payload.options?.find(option => option.label === result.value);
					await this.resolveInteraction(
						id,
						result.value === undefined
							? { action: "cancel" }
							: { freeText: result.value, optionId: selected?.optionId },
					);
				})
				.catch(error => {
					this.#session.emitNotice("warning", String(error), "webgui-collab-ui");
				});
		options?.signal?.addEventListener("abort", cancel, { once: true });
		if (options?.timeout && options.timeout > 0) {
			options.onTimeoutStart?.();
			timer = setTimeout(() => {
				const request = this.#requests.get(id);
				if (!request) return;
				this.#requests.delete(id);
				request.cleanup();
				try {
					options.onTimeout?.();
					request.resolve(timeoutAnswer ? timeoutAnswer() : answer({ action: "cancel" }));
				} catch (error) {
					request.reject(error);
				}
				this.#notify();
			}, options.timeout);
		}
		this.#notify();
		return (await (this.#session.isDisposed
			? pending.promise
			: this.#session.waitForUser(() => pending.promise))) as T;
	}

	#remove(id: string, reason: unknown): void {
		const request = this.#requests.get(id);
		if (!request) return;
		this.#requests.delete(id);
		request.cleanup();
		request.reject(reason);
		this.#notify();
	}

	async resolveInteraction(
		id: string,
		answer: NativeWebGuiInteractionAnswer,
		origin?: NativeWebGuiInteractionOrigin,
	): Promise<void> {
		const request = this.#requests.get(id);
		if (
			!request ||
			request.sessionId !== this.#session.sessionId ||
			(this.#session.isDisposed && !(request.origin && isNativeNavigation(request.interaction.payload))) ||
			(request.origin &&
				(request.origin.connectionId !== origin?.connectionId || request.origin.clientId !== origin?.clientId))
		) {
			throw new Error("Native interaction is expired, cancelled, already answered, or belongs to another session");
		}
		if (request.origin && (answer.action === "cancel" || answer.action === "decline")) {
			this.#remove(id, new Error("Browser command action cancelled"));
			return;
		}
		// Validate before removing the waiter so a rejected response preserves the form and native wait.
		const value = request.answer(answer);
		this.#requests.delete(id);
		request.cleanup();
		request.resolve(value);
		this.#notify();
	}

	async #ask(
		questions: ExtensionAskDialogQuestion[],
		options?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		return this.#request<ExtensionAskDialogResult | undefined>(
			{
				kind: "userInput",
				prompt: questions.map(question => question.question).join("\n"),
				freeText: true,
				questions: questions.map(question => ({
					question: question.question,
					header: question.header ?? "",
					multiSelect: question.multi ?? false,
					options: question.options.map(option => ({
						value: option.label,
						label: option.label,
						description: option.description,
					})),
				})),
			},
			answer => {
				if (answer.action === "cancel" || answer.action === "decline") return undefined;
				return {
					kind: "submit",
					results: questions.map((question, index) => {
						const raw =
							answer.content?.[`answer_${index}`] ??
							(questions.length === 1 ? (answer.freeText ?? answer.content?.answer) : undefined);
						const values =
							typeof raw === "string"
								? [raw]
								: Array.isArray(raw) && raw.every(value => typeof value === "string")
									? (raw as string[])
									: [];
						const labels = question.options.map(option => option.label);
						const selectedOptions = values.filter(value => labels.includes(value));
						if (!question.multi && selectedOptions.length > 1)
							throw new Error("This native question accepts one option");
						return {
							id: question.id,
							question: question.question,
							options: labels,
							multi: question.multi ?? false,
							selectedOptions,
							customInput: values.filter(value => !labels.includes(value)).join("\n") || undefined,
						};
					}),
				};
			},
			options,
			undefined,
			undefined,
			() => timedOutAskDialogResult(questions),
		);
	}

	cancelPendingInteractions(reason = "Native interactions cancelled by host"): void {
		for (const id of this.#requests.keys()) this.#remove(id, new Error(reason));
	}

	install(bindings: NativeWebGuiInteractionBindings): void {
		if (this.#restore) return;
		const restoreExtensions = this.#session.extensionRunner?.overrideUIContext(this.ui);
		const restoreUsage = this.#session.overrideUsageFallbackConfirmer((confirmation, signal) => {
			const reserve =
				confirmation.remainingPercent === undefined
					? "inside the configured reserve margin"
					: `${confirmation.remainingPercent.toFixed(1)}% remaining`;
			return this.ui.confirm(
				"Coding-plan reserve reached",
				`${confirmation.from} has ${reserve}. Switch to ${confirmation.to}? Choose No to keep using the current plan.`,
				{ signal },
			);
		});
		try {
			bindings.setToolUIContext(this.ui, true);
		} catch (error) {
			restoreExtensions?.();
			restoreUsage();
			throw error;
		}
		this.#restore = () => {
			this.cancelPendingInteractions();
			restoreExtensions?.();
			restoreUsage();
			bindings.restoreToolUIContext?.();
		};
	}

	restore(): void {
		this.#restore?.();
		this.#restore = undefined;
	}

	bindGuestUI(getHost: () => CollabHost | undefined): () => void {
		const previous = this.#getGuestHost;
		this.#getGuestHost = getHost;
		return () => {
			if (this.#getGuestHost === getHost) this.#getGuestHost = previous;
		};
	}
}

const brokers = new WeakMap<AgentSession, NativeWebGuiQuestions>();
export function nativeWebGuiQuestions(session: AgentSession): NativeWebGuiQuestions {
	let broker = brokers.get(session);
	if (!broker) {
		broker = new NativeWebGuiQuestions(session);
		brokers.set(session, broker);
	}
	return broker;
}
export function installNativeWebGuiInteractions(
	session: AgentSession,
	bindings: NativeWebGuiInteractionBindings,
): void {
	nativeWebGuiQuestions(session).install(bindings);
}
export function restoreNativeWebGuiInteractions(session: AgentSession): void {
	brokers.get(session)?.restore();
}
export function cancelPendingInteractions(session: AgentSession, reason?: string): void {
	brokers.get(session)?.cancelPendingInteractions(reason);
}
export function bindNativeWebGuiGuestUI(session: AgentSession, getHost: () => CollabHost | undefined): () => void {
	return nativeWebGuiQuestions(session).bindGuestUI(getHost);
}
