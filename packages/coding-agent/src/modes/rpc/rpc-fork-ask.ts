/**
 * Fork-extension rich ask (requirement 4.3, rpc-ui-protocol.md).
 *
 * Implements `ExtensionUIContext.askDialog` over the RPC transport so the v3
 * `ask` tool path sends the full question set in one `ask_request` frame and
 * settles it from `ask_response` / `ask_pause` bypass frames. Semantics mirror
 * the ACP elicitation mapping (`modes/acp/acp-agent.ts`) and the TUI rich
 * dialog: no preselection, multi empty submission = "select none", single
 * unanswered submit = cancellation, timeout auto-answers recommended.
 *
 * Inactive until the client negotiates v3: `getAskDialog()` returns undefined
 * so the ask tool keeps its per-question `select` fallback unchanged.
 */
import { Snowflake, isRecord } from "@oh-my-pi/pi-utils";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "../../extensibility/extensions/types";
import type { RpcForkHost } from "./rpc-fork-host";
import type {
	RpcForkAskAnswer,
	RpcForkAskQuestion,
	RpcForkAskRequestFrame,
	RpcForkAskResponseFrame,
} from "./rpc-fork-types";

interface PendingAskRequest {
	resolveResponse: (response: RpcForkAskResponseFrame) => void;
	pause: () => void;
	reject: (error: Error) => void;
}

function toWireQuestion(question: ExtensionAskDialogQuestion): RpcForkAskQuestion {
	return {
		id: question.id,
		question: question.question,
		...(question.header ? { header: question.header } : {}),
		options: question.options.map(option => ({
			label: option.label,
			...(option.description ? { description: option.description } : {}),
			...(option.preview ? { preview: option.preview } : {}),
		})),
		...(question.multi !== undefined ? { multi: question.multi } : {}),
		...(question.recommended !== undefined ? { recommended: question.recommended } : {}),
	};
}

/** Maps client answers onto per-question results; unknown labels and ids are dropped. */
function mapAnswers(
	questions: ExtensionAskDialogQuestion[],
	answers: RpcForkAskAnswer[],
): ExtensionAskDialogResultItem[] {
	return questions.map(question => {
		const labels = question.options.map(option => option.label);
		const answer = answers.find(candidate => candidate && candidate.questionId === question.id);
		const selected = Array.isArray(answer?.selected)
			? answer.selected.filter(label => typeof label === "string" && labels.includes(label))
			: [];
		const other = typeof answer?.other === "string" && answer.other.trim() ? answer.other.trim() : undefined;
		const selectedOptions =
			question.multi === true ? selected : other === undefined && selected.length > 0 ? [selected[0]!] : [];
		return {
			id: question.id,
			question: question.question,
			options: labels,
			multi: question.multi ?? false,
			selectedOptions,
			...(other ? { customInput: other } : {}),
		};
	});
}

/** Timeout auto-answer: every question falls back to its recommended option (ACP semantics). */
function toTimeoutResult(question: ExtensionAskDialogQuestion): ExtensionAskDialogResultItem {
	const labels = question.options.map(option => option.label);
	const index = Math.min(Math.max(question.recommended ?? 0, 0), Math.max(labels.length - 1, 0));
	const fallback = labels[index];
	return {
		id: question.id,
		question: question.question,
		options: labels,
		multi: question.multi ?? false,
		selectedOptions: fallback === undefined ? [] : [fallback],
		timedOut: true,
	};
}

export class RpcForkAskBroker {
	readonly #pending = new Map<string, PendingAskRequest>();

	constructor(
		private readonly host: RpcForkHost,
		private readonly output: (frame: object) => void,
	) {
		host.registerFrameHandler(parsed => this.#handleFrame(parsed));
		host.registerDisposer(reason => this.#dispose(reason));
	}

	/** Value for `RpcExtensionUIContext.askDialog`; undefined until v3 is negotiated. */
	getAskDialog(): ExtensionUIContext["askDialog"] {
		if (!this.host.isActive) return undefined;
		return (questions, dialogOptions) => this.#askDialog(questions, dialogOptions);
	}

	async #askDialog(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		if (dialogOptions?.signal?.aborted) return undefined;

		const id = Snowflake.next() as string;
		const timeoutMs = dialogOptions?.timeout;
		const { promise, resolve, reject } = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: ExtensionAskDialogResult | undefined) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			dialogOptions?.signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
			resolve(result);
		};
		const onTimeout = () => {
			// Countdown expiry keeps the TUI/ACP semantics: unanswered questions
			// auto-answer recommended and the tool result reports timedOut.
			dialogOptions?.onTimeout?.();
			finish({ kind: "submit", results: questions.map(toTimeoutResult) });
		};
		const onAbort = () => {
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "cancel",
				targetId: id,
			});
			finish(undefined);
		};

		dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs !== undefined) timer = setTimeout(onTimeout, timeoutMs);

		this.#pending.set(id, {
			resolveResponse: response => {
				if ("chat" in response && response.chat !== undefined) {
					finish({ kind: "chat" });
					return;
				}
				if ("cancelled" in response && response.cancelled) {
					finish(undefined);
					return;
				}
				if ("answers" in response && Array.isArray(response.answers)) {
					finish({ kind: "submit", results: mapAnswers(questions, response.answers) });
					return;
				}
				// Malformed payload: keep waiting (mirrors extension_ui_response leniency).
			},
			pause: () => {
				// Idempotent: once paused (or settled) later pauses are no-ops and
				// the countdown never auto-submits for this request.
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
			},
			reject: (error: Error) => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				dialogOptions?.signal?.removeEventListener("abort", onAbort);
				this.#pending.delete(id);
				reject(error);
			},
		});

		const request: RpcForkAskRequestFrame = {
			type: "ask_request",
			id,
			questions: questions.map(toWireQuestion),
			...(timeoutMs !== undefined ? { timeoutMs, deadlineAt: Date.now() + timeoutMs } : {}),
		};
		this.output(request);
		return promise;
	}

	#handleFrame(parsed: unknown): boolean {
		if (!isRecord(parsed)) return false;
		if (parsed.type === "ask_response") {
			if (typeof parsed.id !== "string") return false;
			this.#pending.get(parsed.id)?.resolveResponse(parsed as RpcForkAskResponseFrame);
			return true;
		}
		if (parsed.type === "ask_pause") {
			if (typeof parsed.targetId !== "string") return false;
			this.#pending.get(parsed.targetId)?.pause();
			return true;
		}
		return false;
	}

	#dispose(reason: string): void {
		for (const pending of this.#pending.values()) {
			pending.reject(new Error(reason));
		}
		this.#pending.clear();
	}
}
