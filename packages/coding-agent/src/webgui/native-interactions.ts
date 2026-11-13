import { AsyncLocalStorage } from "node:async_hooks";
import type {
	PendingInteraction,
	UserInputRequestPayload,
} from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/snapshot";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type {
	ExtensionApprovalAnswer,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "../extensibility/extensions/types";
import { getExtensionUISelectOptionLabel, timedOutAskDialogResult } from "../extensibility/extensions/types";
import type { AgentSession } from "../session/agent-session";
import type { BlockedStatus } from "../utils/run-status";

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

export interface NativeWebGuiInteractionAnswer {
	optionId?: string;
	freeText?: string;
	action?: "accept" | "decline" | "cancel";
	content?: Record<string, unknown>;
}

export interface NativeWebGuiInteractionBindings {
	setToolUIContext: (ui: ExtensionUIContext, hasUI: boolean) => void;
	restoreToolUIContext?: () => void;
	holdBlockedStatus?: (status: BlockedStatus) => () => void;
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

/** One broker per actual native session, never per browser tab or global current cwd. */
export class NativeWebGuiQuestions {
	readonly #session: AgentSession;
	readonly #requests = new Map<string, PendingRequest>();
	readonly #listeners = new Set<() => void>();
	readonly ui: ExtensionUIContext;
	#restore: (() => void) | undefined;
	#holdBlockedStatus: ((status: BlockedStatus) => () => void) | undefined;

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
		const select = (
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
			approval = false,
		) => {
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
				approval,
			);
		};
		ui.select = select;
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
				true,
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
			);
		ui.askDialog = (questions, options) => this.#ask(questions, options);
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
		approval = false,
		timeoutAnswer?: () => T,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		if (this.#session.isDisposed) throw new Error("Native session has closed");
		const id = `webgui-question:${crypto.randomUUID()}`;
		const pending = Promise.withResolvers<unknown>();
		let timer: Timer | undefined;
		const cancel = () => this.#remove(id, options?.signal?.reason ?? new Error("Native interaction cancelled"));
		const release = origin
			? undefined
			: this.#holdBlockedStatus?.({
					state: "blocked",
					kind: approval ? "permission" : "question",
					msg: payload.prompt,
				});
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			options?.signal?.removeEventListener("abort", cancel);
			release?.();
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
			this.#session.isDisposed ||
			(request.origin &&
				(request.origin.connectionId !== origin?.connectionId || request.origin.clientId !== origin?.clientId))
		) {
			throw new Error("Native interaction is expired, cancelled, already answered, or belongs to another session");
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
			this.#holdBlockedStatus = bindings.holdBlockedStatus;
			bindings.setToolUIContext(this.ui, true);
		} catch (error) {
			restoreExtensions?.();
			restoreUsage();
			this.#holdBlockedStatus = undefined;
			throw error;
		}
		this.#restore = () => {
			this.cancelPendingInteractions();
			this.#holdBlockedStatus = undefined;
			restoreExtensions?.();
			restoreUsage();
			bindings.restoreToolUIContext?.();
		};
	}

	restore(): void {
		this.#restore?.();
		this.#restore = undefined;
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
