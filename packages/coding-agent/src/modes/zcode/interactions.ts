import { theme } from "@oh-my-pi/pi-tui/theme";
import type { ExtensionUIDialogOptions, ExtensionUIContext } from "../../extensibility/extensions/types";
import type { ToolSession } from "../../tools";
import type { PendingInteraction, UserInputRequestPayload } from "./schema";

/**
 * resolve(answer.action === "decline") 的应答标记(用户裁定,findings B):
 * decline(Escape dismiss 等)是「用户拒绝」,须产出 declined 结果而非硬取消;
 * cancel 仍映射 undefined 保持取消语义。不识别该标记的消费者按无答案处理
 * (confirm → false、select/input → undefined),与其拒绝语义一致。
 */
export const DECLINE_ANSWER = Symbol("zcode.userDeclined");

/** declined 提交在 AskUserQuestion tool_result 中的模型可见文案(findings B)。 */
const DECLINED_CUSTOM_INPUT = "User declined to answer";

interface WaitingInteraction {
	interaction: PendingInteraction;
	finish(value: unknown): void;
	setAutoResolution(enabled: boolean): void;
	snooze(): "paused" | "noop";
}

/** Per-session dialogs. No terminal reads and no response may outlive its request. */
export class ZCodeInteractions {
	readonly #waiting = new Map<string, WaitingInteraction>();
	#closed = false;
	#autoResolutionEnabled = true;
	readonly #children = new Set<ZCodeInteractions>();
	readonly ui: ExtensionUIContext;
	constructor(
		readonly publish: (pending: PendingInteraction[]) => void,
		readonly output: (text: string) => void = () => {},
		readonly origin?: UserInputRequestPayload["origin"],
	) {
		const textAnswer = (value: unknown): string | undefined => {
			if (typeof value === "string") return value;
			if (!value || typeof value !== "object") return undefined;
			const answer = value as Record<string, unknown>;
			return [answer.optionId, answer.freeText, answer.text, answer.value, answer.answer, answer.answer_0].find(
				item => typeof item === "string",
			) as string | undefined;
		};
		const input: ExtensionUIContext["input"] = async (title, placeholder, options) =>
			textAnswer(
				await this.request({ kind: "userInput", prompt: title, freeText: true, input: placeholder }, options),
			);
		this.ui = {
			select: async (title, items, options) => {
				const labels = items.map(item => (typeof item === "string" ? item : item.label));
				const answer = textAnswer(
					await this.request(
						{
							kind: "userInput",
							prompt: title,
							freeText: false,
							options: labels.map(label => ({ optionId: label, label })),
						},
						options,
					),
				);
				return answer && labels.includes(answer) ? answer : undefined;
			},
			approve: async () => {
				// Keep this hook present so native requestApproval cannot fall back to select.
				throw new Error("Native tool approval is not supported by the ZCode host");
			},
			confirm: async (title, message, options) => {
				const answer = await this.request(
					{
						kind: "userInput",
						prompt: `${title}\n\n${message}`,
						freeText: false,
						options: [
							{ optionId: "yes", label: "Confirm" },
							{ optionId: "no", label: "Cancel" },
						],
					},
					options,
				);
				return answer === true || textAnswer(answer) === "yes";
			},
			input,
			editor: (title, prefill, options) => input(title, prefill, options),
			askDialog: async (questions, options) => {
				if (questions.length === 0) return { kind: "submit", results: [] };
				const answer = await this.request(
					{
						kind: "userInput",
						prompt: questions[0]!.question,
						freeText: true,
						toolName: "AskUserQuestion",
						questions: questions.map(question => ({
							question: question.question,
							header: question.header ?? question.id,
							options: question.options.map(item => ({
								value: item.label,
								label: item.label,
								description: item.description,
								preview: item.preview,
							})),
							multiSelect: question.multi,
						})),
						currentQuestionIndex: 0,
						options: questions[0]!.options.map(item => ({ optionId: item.label, label: item.label })),
					},
					options,
				);
				if (answer === undefined) return undefined;
				// decline(用户拒绝,如 Escape dismiss)与取消分开(用户裁定,findings B):
				// tools/ask.ts 只认 submit/chat 结果,这里以显式 customInput 产出 declined
				// tool_result 并继续收口请求,而不是让 ask.ts:833 判 undefined 硬取消整轮。
				if (answer === DECLINE_ANSWER)
					return {
						kind: "submit",
						results: questions.map(question => ({
							id: question.id,
							question: question.question,
							options: question.options.map(item => item.label),
							multi: question.multi ?? false,
							selectedOptions: [],
							customInput: DECLINED_CUSTOM_INPUT,
						})),
					};
				const answers =
					answer &&
					typeof answer === "object" &&
					"answers" in answer &&
					answer.answers &&
					typeof answer.answers === "object" &&
					!Array.isArray(answer.answers)
						? answer.answers
						: undefined;
				const results = [];
				for (const [index, question] of questions.entries()) {
					const labels = question.options.map(item => item.label);
					// 桌面按索引提交原始数组，避免展示用的逗号拼接答案丢失多选值。
					const indexedAnswer =
						answer && typeof answer === "object" ? Reflect.get(answer, `answer_${index}`) : undefined;
					const candidate =
						indexedAnswer ??
						(answers
							? (Reflect.get(answers, question.id) ??
								(question.header ? Reflect.get(answers, question.header) : undefined) ??
								Reflect.get(answers, question.question))
							: questions.length === 1
								? textAnswer(answer)
								: undefined);
					// 任一题缺答案字段不再整单作废(用户裁定,findings B):缺失题按空串处理,
					// 与显式空提交同一语义,由 tools/ask.ts 按空回答收口而非硬取消。
					const values =
						typeof candidate === "string"
							? [candidate]
							: Array.isArray(candidate) && candidate.every(value => typeof value === "string")
								? candidate
								: [""];
					const selectedValues = values.filter(value => labels.includes(value));
					// 单选多命中不再整单作废(用户裁定,findings B):取首个命中,其余忽略。
					const selectedOptions = question.multi ? selectedValues : selectedValues.slice(0, 1);
					const customValues = values.filter(value => !labels.includes(value));
					results.push({
						id: question.id,
						question: question.question,
						options: labels,
						multi: question.multi ?? false,
						selectedOptions,
						// 显式空串不再被 || undefined 吞掉(用户裁定,findings B):保留空串让
						// 单题空提交成为一次有效回答(customInput !== undefined),而非被
						// tools/ask.ts:884-898 判为用户取消。
						customInput: customValues.length > 0 ? customValues.join("\n") : undefined,
					});
				}
				return { kind: "submit", results };
			},
			notify: message => output(message),
			onTerminalInput: () => () => {},
			setStatus: (_key, text) => {
				if (text) output(text);
			},
			setWorkingMessage: text => {
				if (text) output(text);
			},
			setWidget: (_key, content) => {
				if (Array.isArray(content)) output(content.join("\n"));
			},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: title => output(title),
			custom: async () => {
				throw new Error("This command requires a terminal UI");
			},
			setEditorText: text => output(text),
			pasteToEditor: text => output(text),
			getEditorText: () => "",
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			theme,
			getAllThemes: async () => [],
			getTheme: async () => undefined,
			setTheme: async () => ({ success: false, error: "Theme switching requires a terminal UI" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}
	get pending(): PendingInteraction[] {
		return [
			...Array.from(this.#waiting.values(), item => item.interaction),
			...Array.from(this.#children).flatMap(child => child.pending),
		];
	}
	/** Each native child gets its own lifetime and answers; the root only aggregates presentation. */
	readonly createSubagentUI: NonNullable<ToolSession["createInteractionUI"]> = origin => {
		const child = new ZCodeInteractions(() => this.publish(this.pending), this.output, {
			kind: "subagent",
			agentId: origin.agentId,
			agentType: origin.agentName,
			childSessionId: origin.sessionId,
			parentSessionId: origin.parentSessionId,
			parentToolCallId: origin.parentToolCallId,
		});
		child.#autoResolutionEnabled = this.#autoResolutionEnabled;
		if (this.#closed) child.dispose();
		else this.#children.add(child);
		return {
			ui: child.ui,
			cancel: () => child.cancel(),
			dispose: () => {
				child.dispose();
				this.#children.delete(child);
				this.publish(this.pending);
			},
		};
	};
	request(payload: UserInputRequestPayload, options?: ExtensionUIDialogOptions): Promise<unknown> {
		if (this.#closed || options?.signal?.aborted) return Promise.resolve(undefined);
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const interactionId = crypto.randomUUID();
		let timer: Timer | undefined;
		// snoozeInteractionAutoResolution 命中后的单交互永久暂停标记(见 snooze())。
		let permanentlySnoozed = false;
		const abort = () => finish(undefined);
		const finish = (value: unknown) => {
			if (!this.#waiting.delete(interactionId)) return;
			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", abort);
			this.publish(this.pending);
			resolve(value);
		};
		const interaction: PendingInteraction = {
			interactionId,
			kind: "userInput",
			anchorRowId: null,
			createdAt: Date.now(),
			payload: this.origin ? { ...payload, origin: this.origin } : payload,
		};
		const setAutoResolution = (enabled: boolean) => {
			clearTimeout(timer);
			if (options?.timeout === undefined) return;
			const startedAt = Date.now();
			// snoozeInteractionAutoResolution 的暂停是「本次自动结束」的永久暂停
			// (vendor schema command.ts:250 注释),全局偏好重开不得重启该交互的倒计时。
			if (!enabled || permanentlySnoozed) {
				interaction.autoResolution = { state: "snoozed", startedAt, snoozedAt: startedAt };
				return;
			}
			interaction.autoResolution = {
				state: "visibleCountdown",
				startedAt,
				visibleAt: startedAt,
				deadlineAt: startedAt + options.timeout,
			};
			options.onTimeoutStart?.();
			timer = setTimeout(() => {
				options.onTimeout?.();
				finish(undefined);
			}, options.timeout);
		};
		const snooze = (): "paused" | "noop" => {
			// 首次有效操作永久暂停本次自动结束;重复/迟到调用为幂等 noop
			// (vendor schema command.ts:250 注释,用户裁定 S2-1)。
			if (permanentlySnoozed) return "noop";
			permanentlySnoozed = true;
			setAutoResolution(false);
			return "paused";
		};
		this.#waiting.set(interactionId, { interaction, finish, setAutoResolution, snooze });
		options?.signal?.addEventListener("abort", abort, { once: true });
		setAutoResolution(this.#autoResolutionEnabled);
		this.publish(this.pending);
		return promise;
	}
	resolve(id: string, response: unknown): boolean {
		const request = this.#waiting.get(id);
		if (!request) {
			for (const child of this.#children) if (child.resolve(id, response)) return true;
			return false;
		}
		if (response && typeof response === "object" && "action" in response && response.action === "cancel")
			// cancel 保持取消语义:消费者以 undefined 表达硬取消(用户裁定,findings B)。
			request.finish(undefined);
		else if (response && typeof response === "object" && "action" in response && response.action === "decline")
			// decline 与 cancel 分开(用户裁定,findings B):decline 是「用户拒绝」,
			// 以可区分标记传递,由 askDialog/审批等消费者产出 declined 语义而非硬取消。
			request.finish(DECLINE_ANSWER);
		else if (
			response &&
			typeof response === "object" &&
			"content" in response &&
			response.content &&
			typeof response.content === "object"
		)
			request.finish(response.content);
		else request.finish(response);
		return true;
	}
	/**
	 * snoozeInteractionAutoResolution:首次有效操作永久暂停该交互的自动结束;
	 * 重复/迟到调用为幂等 noop(vendor schema command.ts:250 注释)。
	 * @returns "paused" = 本次调用完成了暂停;"noop" = 重复/迟到,幂等无操作。
	 */
	snoozeAutoResolution(id: string): "paused" | "noop" {
		const request = this.#waiting.get(id);
		if (!request) {
			for (const child of this.#children) if (child.snoozeAutoResolution(id) === "paused") return "paused";
			return "noop";
		}
		const outcome = request.snooze();
		this.publish(this.pending);
		return outcome;
	}
	setAutoResolutionEnabled(enabled: boolean): number {
		this.#autoResolutionEnabled = enabled;
		let affected = 0;
		for (const request of this.#waiting.values()) {
			if (request.interaction.autoResolution) affected++;
			request.setAutoResolution(enabled);
		}
		for (const child of this.#children) affected += child.setAutoResolutionEnabled(enabled);
		this.publish(this.pending);
		return affected;
	}
	cancel(): void {
		for (const request of [...this.#waiting.values()]) request.finish(undefined);
		// Retire child UI generations: a stopped child cannot open a new request after Stop.
		for (const child of this.#children) child.dispose();
		this.#children.clear();
	}
	dispose(): void {
		this.#closed = true;
		this.cancel();
	}
}
