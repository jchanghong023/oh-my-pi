import * as crypto from "node:crypto";
import type { AsyncJobManager } from "../async/job-manager";
import type { SlashCommandRuntime } from "../slash-commands/types";
import { summarizeSpecRun, type SpecRunMeasurement } from "./metrics";
import { SpecAdmissionError, SpecDrivenOrchestrator, StaleRun } from "./orchestrator";
import { createSpecDrivenRuntime } from "./runtime";
import { bindSpecSkillPolicy } from "./skill-policy";
import { roleLabel, stageForPhase, stageLabel } from "./stages";
import type {
	SpecControllerAction,
	SpecDrivenOptions,
	SpecDrivenPorts,
	SpecDrivenStatus,
	SpecInputMode,
	SpecInteractionState,
	SpecTextReceipt,
	SpecUserMessage,
} from "./types";
export type { SpecControllerAction, SpecTextReceipt } from "./types";

export interface SpecControllerRuntime {
	ports: SpecDrivenPorts;
	options: SpecDrivenOptions;
	dispose(): Promise<void>;
	measurement(): SpecRunMeasurement;
}
export type SpecRuntimeFactory = (input: {
	session: SlashCommandRuntime["session"];
	settings: SlashCommandRuntime["settings"];
	cwd: string;
	onOutput: (text: string) => Promise<void>;
	onRequest?: () => void;
}) => Promise<SpecControllerRuntime>;

type Operation = (core: SpecDrivenOrchestrator) => Promise<SpecDrivenStatus>;
const controllers = new WeakMap<object, SpecDrivenController>();
export interface SpecControllerObservation {
	runId: string | null;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	active: boolean;
	released: boolean;
	disposed: boolean;
	status: SpecDrivenStatus;
	interaction: SpecInteractionState;
}

type ObservationListener = (observation: SpecControllerObservation) => void;
const observers = new WeakMap<object, Set<ObservationListener>>();

function deliver(listener: ObservationListener, observation: SpecControllerObservation): void {
	try {
		listener(observation);
	} catch {
		// An observer is not an execution or approval owner.
	}
}

/** Attaches to the manager identity without creating a controller or native runtime. */
export function observeSpecDrivenController(sessionManager: object, listener: ObservationListener): () => void {
	let listeners = observers.get(sessionManager);
	if (!listeners) {
		listeners = new Set();
		observers.set(sessionManager, listeners);
	}
	// Each registration owns its lifetime, even when the same callback is registered twice.
	const registered: ObservationListener = observation => listener(observation);
	listeners.add(registered);
	const controller = controllers.get(sessionManager);
	if (controller) deliver(registered, controller.observation());
	return () => {
		listeners.delete(registered);
		if (!listeners.size && observers.get(sessionManager) === listeners) observers.delete(sessionManager);
	};
}
function formatHeartbeatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}

const emptyStatus = (): SpecDrivenStatus => ({
	phase: "idle",
	paused: false,
	generation: 0,
});

export function peekSpecDrivenController(sessionManager: object): SpecDrivenController | undefined {
	const controller = controllers.get(sessionManager);
	return controller && !controller.observation().disposed ? controller : undefined;
}
/** One in-memory workflow per native session-manager identity, shared by every host. */
export function getSpecDrivenController(
	host: SlashCommandRuntime,
	options: { factory?: SpecRuntimeFactory; restart?: boolean } = {},
): SpecDrivenController {
	let controller = controllers.get(host.sessionManager);
	const retainedInput = controller?.belongsTo(host) ? controller.observation().interaction : undefined;
	if (controller?.belongsTo(host) && options.restart) {
		const blocked = controller.restartBlock();
		if (blocked) throw new SpecAdmissionError(blocked);
	}
	if (
		controller &&
		(!controller.belongsTo(host) ||
			(options.restart && ["completed", "cancelled"].includes(controller.status().phase)))
	) {
		void controller.dispose();
		controller = undefined;
	}
	if (!controller) {
		controller = new SpecDrivenController(host, options.factory, retainedInput);
		controllers.set(host.sessionManager, controller);
		controller.publishObservation();
	}
	controller.setOutput(host.output, host.observesCustomMessages);
	return controller;
}

export function renderSpecDrivenSummary(state: SpecDrivenStatus, compact = false): string {
	const phase =
		state.phase === "idle"
			? "尚未启动"
			: state.phase === "completed"
				? "已完成"
				: state.phase === "cancelled"
					? "已取消"
					: stageLabel(stageForPhase(state.phase));
	const lines = [`协同开发模式：${phase}${state.paused ? "（暂停）" : ""}`];
	if (state.blockedReason) lines.push(`阻塞：${state.blockedReason}`);
	if (state.lastReply && !compact) lines.push(state.lastReply);
	if (state.specification) lines.push(`需求文件：${state.specification.files.map(file => file.path).join("、")}`);
	if (state.solution) lines.push(`方案文件：${state.solution.path}`);
	if (state.plan) lines.push(`计划文件：${state.plan.path}`);
	if (state.report) lines.push(`完成报告：${state.report.path}`);
	if (state.phase === "awaiting-acceptance") lines.push("完成报告等待明确验收；验收后才同步需求并归档。");
	return lines.join("\n");
}

/** Full native material projection; chat uses the summary instead. */
export function renderSpecDrivenStatus(state: SpecDrivenStatus): string {
	return `${renderSpecDrivenSummary(state)}\n\n${JSON.stringify(state, null, 2)}`;
}

export class SpecDrivenController {
	readonly #host: SlashCommandRuntime;
	readonly #manager: AsyncJobManager;
	readonly #factory: SpecRuntimeFactory;
	readonly #sessionGeneration: number;
	#output!: SlashCommandRuntime["output"];
	#observesCustomMessages = false;
	#core?: SpecDrivenOrchestrator;
	#native?: SpecControllerRuntime;
	#initializing?: Promise<void>;
	#releasePolicy?: () => void;
	#jobs = new Set<string>();
	#epoch = 0;
	#disposed = false;
	#released = false;
	#releaseWork?: Promise<void>;
	#paused = false;
	#pending?: Operation;
	#active = false;
	#cancelled = false;
	#failure?: string;
	readonly #createdAt = Date.now();
	#updatedAt = this.#createdAt;
	#mode: SpecInputMode = "chat";
	#draft = "";
	#messages: SpecUserMessage[] = [];
	#messageAbort?: AbortController;
	#messageWork?: Promise<void>;
	#controlWork?: Promise<unknown>;
	#heartbeat?: NodeJS.Timeout;
	#heartbeatSince = 0;

	constructor(
		host: SlashCommandRuntime,
		factory: SpecRuntimeFactory = createSpecDrivenRuntime,
		input?: Pick<SpecInteractionState, "mode" | "draft">,
	) {
		if (!host.session.asyncJobManager) throw new Error("当前会话缺少原生 AsyncJobManager，无法启动 /dev");
		this.#host = host;
		this.#manager = host.session.asyncJobManager;
		this.#factory = factory;
		this.setOutput(host.output, host.observesCustomMessages);
		this.#sessionGeneration = host.session.sessionGeneration;
		this.#mode = input?.mode ?? "chat";
		this.#draft = input?.draft ?? "";
		const unregister = host.session.registerSessionChangeCallback(() => {
			void this.dispose();
		});
		host.session.addDisposer(() => {
			unregister();
			void this.dispose();
		});
	}
	belongsTo(host: SlashCommandRuntime): boolean {
		return (
			this.#host.session === host.session &&
			this.#sessionGeneration === host.session.sessionGeneration &&
			this.#host.cwd === host.cwd
		);
	}
	setOutput(output: SlashCommandRuntime["output"], observesCustomMessages = false): void {
		this.#observesCustomMessages = observesCustomMessages;
		this.#output = observesCustomMessages ? () => {} : output;
	}
	inputMode(): SpecInputMode {
		return this.#mode;
	}
	setInputMode(mode: SpecInputMode): void {
		if (this.#disposed) throw new SpecAdmissionError("流程已释放");
		this.#mode = mode;
		this.publishObservation();
	}
	#outstanding(): boolean {
		return this.#messages.some(message => ["queued", "processing", "cancelling"].includes(message.status));
	}
	#messageBlock(): string | undefined {
		return this.#outstanding() ? "用户消息尚未结清；请等待或取消指定消息" : undefined;
	}
	/** Terminal phase alone is not evidence that the old owner has finished releasing resources. */
	restartBlock(): string | undefined {
		if (!this.#disposed && !["completed", "cancelled"].includes(this.status().phase)) return;
		const unsettled = this.#messageBlock();
		if (unsettled) {
			const failure = this.#messages.find(message => message.status === "cancelling" && message.error)?.error;
			return `${unsettled}${failure ? `；${failure}` : ""}；旧流程清理确认完成前不能开始新流程`;
		}
		if (!this.#released) return "旧流程资源尚未释放；请等待清理完成后重新 /dev start；若取消失败，请重试 /dev cancel";
	}
	actions(state = this.status()): SpecControllerAction[] {
		const blocked = this.#disposed
			? "流程所有者已释放"
			: (this.restartBlock() ?? this.#messageBlock() ?? (this.#active ? "阶段操作正在运行" : undefined));
		const result: SpecControllerAction[] = [];
		const add = (
			id: string,
			label: string,
			command: string,
			requiresInput = false,
			control = false,
			interrupt = false,
		): void => {
			const actionBlocked = interrupt && !this.#disposed ? this.#messageBlock() : blocked;
			result.push({
				id,
				label,
				command: `/dev ${command}`,
				available: control ? !this.#disposed : !actionBlocked,
				version: `${state.generation}:${state.specification?.version ?? ""}:${state.solution?.version ?? ""}:${state.plan?.version ?? ""}:${state.report?.version ?? ""}:${command}`,
				...(actionBlocked && !control ? { blockedReason: actionBlocked } : {}),
				...(requiresInput ? { requiresInput: true } : {}),
			});
		};
		add("status", "查看当前阶段摘要", "status", false, true);
		if (["idle", "completed", "cancelled"].includes(state.phase)) add("start", "开始新流程", "start", true);
		else if (!["completed", "cancelled"].includes(state.phase)) {
			if (state.paused) add("resume", "恢复流程（不自动发送草稿）", "resume", false, !this.#outstanding());
			else {
				if (["requirements", "solution", "planning", "executing"].includes(state.phase))
					add("answer", "补充说明并继续当前阶段（不批准转换）", "answer", true);
				if (state.phase === "awaiting-specification" && state.specification)
					add("confirm-spec", "确认需求并进入方案", "confirm-spec");
				if (state.phase === "awaiting-choice" && state.solution)
					for (const candidate of state.solution.candidates)
						add(`choose:${candidate.id}`, `选择 ${candidate.title} 并编写计划`, `choose ${candidate.id}`);
				if (state.phase === "awaiting-plan" && state.plan)
					add("confirm-plan", "批准计划并开始执行", "confirm-plan");
				if (state.phase === "awaiting-acceptance" && state.report) {
					add("accept", "验收交付并同步需求、归档", "accept");
					add("repair", "返回当前范围内执行并修复", "repair", true);
				}
				add("pause", "立即暂停流程", "pause", false, true);
			}
			add("amend", "修改需求并撤销受影响下游批准", "amend", true);
			if (state.specification) add("change-solution", "重新讨论方案并撤销下游批准", "change-solution", true);
			if (state.plan) add("revise-plan", "修订当前计划（需重新批准）", "revise-plan", true);
			add("cancel", "停止流程并保留已有文件（需确认）", "cancel", false, true);
		}
		for (const message of this.#messages)
			if (
				!["completed", "cancelled"].includes(state.phase) &&
				["queued", "processing", "cancelling"].includes(message.status)
			)
				add(
					`cancel-message:${message.id}`,
					`取消消息 ${message.id}（保留已发生副作用）`,
					`cancel-message ${message.id}`,
					false,
					true,
				);
		return result;
	}
	async submitText(text: string): Promise<SpecTextReceipt> {
		if (this.#disposed) throw new SpecAdmissionError("流程已释放");
		if (!text.trim()) throw new SpecAdmissionError("消息不能为空");
		const state = this.status();
		if (["idle", "completed", "cancelled"].includes(state.phase) || state.paused) {
			this.#draft = text;
			this.publishObservation();
			return { kind: "draft", text };
		}
		const recipient = this.#core?.recipient();
		if (!recipient || !this.#core) throw new SpecAdmissionError("当前阶段 Agent 尚未准备好或已不可用");
		const message: SpecUserMessage = {
			...recipient,
			id: crypto.randomUUID(),
			text,
			runId: this.#core.runId,
			generation: state.generation,
			phase: state.phase,
			status: "queued",
		};
		this.#messages.push(message);
		this.#draft = "";
		this.publishObservation();
		this.#drainMessages();
		return { kind: "queued", messageId: message.id };
	}
	async cancelMessage(messageId: string): Promise<void> {
		const message = this.#messages.find(item => item.id === messageId);
		if (!message || !this.#core || message.runId !== this.#core.runId)
			throw new SpecAdmissionError("未知消息或消息归属不匹配");
		if (message.status === "completed" || message.status === "failed")
			throw new SpecAdmissionError("消息已经处理完成，不能取消");
		if (message.status === "cancelled") return;
		const recipient = this.#core.recipient();
		if (
			!recipient ||
			message.role !== recipient.role ||
			message.actorId !== recipient.actorId ||
			message.sessionId !== recipient.sessionId
		)
			throw new SpecAdmissionError("消息所属阶段或 Agent 已变化");
		if (message.status === "queued") {
			message.status = "cancelled";
			this.publishObservation();
			return;
		}
		message.status = "cancelling";
		this.#messageAbort?.abort();
		this.publishObservation();
		await this.#messageWork;
	}
	#drainMessages(): void {
		if (this.#messageWork || this.#active || this.#disposed || this.status().paused) return;
		const message = this.#messages.find(item => item.status === "queued");
		if (!message || !this.#core) return;
		const core = this.#core;
		const recipient = core.recipient();
		if (
			!recipient ||
			message.runId !== core.runId ||
			message.generation !== core.status().generation ||
			message.role !== recipient.role ||
			message.actorId !== recipient.actorId ||
			message.sessionId !== recipient.sessionId
		) {
			message.status = "failed";
			message.error = "消息所属阶段或 Agent 已变化；未投递";
			this.publishObservation();
			this.#drainMessages();
			return;
		}
		const abort = new AbortController();
		this.#messageAbort = abort;
		message.status = "processing";
		this.#messageWork = Promise.resolve()
			.then(async () => {
				try {
					const reply = await core.converse({
						text: message.text,
						messageId: message.id,
						recipient,
						signal: abort.signal,
					});
					if (abort.signal.aborted || this.#disposed) message.status = "cancelled";
					else {
						message.reply = reply.text;
						message.status = "completed";
						await this.#emit(
							`${reply.text}\n\n${renderSpecDrivenSummary(this.status(), this.#observesCustomMessages)}\n${this.#observesCustomMessages ? this.#nextStep() : this.#actionSummary()}`,
						);
					}
				} catch (error) {
					const aborted = abort.signal.aborted || this.#disposed;
					const abortError =
						error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";
					if (message.status !== "completed") {
						if (!aborted) message.status = "failed";
						else if (abortError || error instanceof StaleRun) message.status = "cancelled";
						else {
							message.status = "cancelling";
							message.error = `取消未确认：${error instanceof Error ? error.message : String(error)}`;
						}
					}
					if (!aborted) message.error = error instanceof Error ? error.message : String(error);
				} finally {
					this.publishObservation();
				}
			})
			.finally(() => {
				this.#messageWork = undefined;
				this.#messageAbort = undefined;
				this.#drainMessages();
			});
		this.publishObservation();
	}
	#actionSummary(): string {
		return this.actions()
			.map(
				action =>
					`${action.label}：${action.command}${action.available ? "" : `（不可用：${action.blockedReason}）`}`,
			)
			.join("\n");
	}
	#nextStep(): string {
		const state = this.status();
		if (["idle", "completed", "cancelled"].includes(state.phase))
			return "下一步：/dev help 打开操作界面，填写需求并明确开始新流程。";
		if (this.#active) return "后台运行中；完成后会提示下一步。/dev help 查看当前操作。";
		if (state.paused) return "下一步：/dev help 查看并恢复流程；草稿不会自动发送。";
		return "下一步：/dev help 查看本轮材料并明确作出决定。";
	}
	revisePlan(text: string): string {
		if (!this.#core) throw new SpecAdmissionError("尚无可修订的计划");
		return this.schedule(core => core.revisePlan(text));
	}
	repair(text: string): string {
		if (this.#active || this.#outstanding() || !this.#core) throw new SpecAdmissionError("流程或用户消息尚未结清");
		return this.schedule(core => core.repair(text));
	}
	status(): SpecDrivenStatus {
		const state = this.#core?.status() ?? emptyStatus();
		if (this.#cancelled) state.phase = "cancelled";
		if (this.#paused) state.paused = true;
		if (this.#failure) state.blockedReason = this.#failure;
		return state;
	}
	observation(): SpecControllerObservation {
		const status = this.status();
		return {
			runId: this.#core?.runId ?? null,
			cwd: this.#host.cwd,
			createdAt: this.#createdAt,
			updatedAt: this.#updatedAt,
			active: this.#active,
			released: this.#released,
			disposed: this.#disposed,
			status,
			interaction: {
				mode: this.#mode,
				draft: this.#draft,
				recipient: this.#core?.recipient(),
				messages: structuredClone(this.#messages),
				actions: this.actions(status),
				blockedReason:
					this.#messageBlock() ??
					status.blockedReason ??
					(!this.#core?.recipient() ? "尚无可接收消息的阶段 Agent" : undefined),
			},
		};
	}
	/** Publishes only through this manager's current controller, never through a global current run. */
	publishObservation(): void {
		this.#updatedAt = Date.now();
		if (controllers.get(this.#host.sessionManager) !== this) return;
		const listeners = observers.get(this.#host.sessionManager);
		if (!listeners?.size) return;
		// Keep registrations stable while callbacks subscribe or unsubscribe.
		const currentListeners = [...listeners];
		for (const listener of currentListeners) deliver(listener, this.observation());
	}
	async report(options: { rawPhase?: boolean } = {}): Promise<void> {
		const state = this.status();
		const compact = this.#observesCustomMessages && !options.rawPhase;
		const recipient = this.#core?.recipient();
		const destination = state.paused
			? "已暂停；新文字仅保留草稿"
			: recipient
				? `${roleLabel(recipient.role)} · ${this.#active ? "运行中" : "等待你"}`
				: "尚无可接收消息的阶段 Agent；文字仅保留草稿";
		let text = `输入模式：${this.#mode === "dev" ? "协同开发" : "普通聊天"}；接收：${destination}\n${renderSpecDrivenSummary(state, compact)}${options.rawPhase ? `\n阶段键：${state.phase}\n\n${JSON.stringify(state, null, 2)}` : ""}\n${compact ? this.#nextStep() : `${this.#actionSummary()}\n/dev help 打开操作界面`}`;
		if (!compact && this.#active) text += "\n后台运行中；/dev status、/dev pause、/dev cancel 可立即使用。";
		if (!compact)
			for (const message of this.#messages)
				text += `\n消息 ${message.id}：${message.status}${message.error ? `；${message.error}` : ""}`;
		if (this.#native && !compact) {
			const measurement = this.#native.measurement();
			const timing = this.#core?.timing();
			if (timing) {
				measurement.plannedDecisionWaitMs = timing.plannedDecisionWaitMs;
				measurement.executionWaitMs = timing.executionWaitMs;
			}
			const summary = summarizeSpecRun(measurement);
			text += `\n实际投入（不代表质量提高）：请求 ${summary.requests}；输入 token ${summary.inputTokens ?? "未知"}；输出 token ${summary.outputTokens ?? "未知"}；耗时 ${summary.elapsedMs}ms；等待决策 ${summary.plannedDecisionWaitMs ?? "未评估"}ms；执行 ${summary.executionWaitMs ?? "未评估"}ms；质量观测 ${measurement.assessmentComplete ? "已评估" : "未评估"}；费用 ${
				Object.entries(summary.costs)
					.map(([currency, amount]) => `${amount} ${currency}`)
					.join("，") || "未知"
			}；费用未知的请求 ${summary.unknownCostRequests}`;
		}
		await this.#emit(text);
	}
	async #emit(text: string): Promise<void> {
		if (this.#host.session.isDisposed || this.#sessionGeneration !== this.#host.session.sessionGeneration) return;
		const epoch = this.#epoch;
		await this.#host.session.appendCustomMessage({ customType: "spec-driven", content: text, display: true });
		if (
			epoch !== this.#epoch ||
			this.#host.session.isDisposed ||
			this.#sessionGeneration !== this.#host.session.sessionGeneration
		)
			return;
		await this.#output(text);
	}
	#startHeartbeat(): void {
		this.#stopHeartbeat();
		this.#heartbeatSince = Date.now();
		this.#heartbeat = setInterval(() => {
			void this.#publishHeartbeat().catch(() => {});
		}, 15_000);
	}
	#stopHeartbeat(): void {
		clearInterval(this.#heartbeat);
		this.#heartbeat = undefined;
	}
	async #publishHeartbeat(): Promise<void> {
		if (!this.#active || this.#paused || this.#disposed || !this.#core) return;
		const recipient = this.#core.recipient();
		if (!recipient) return;
		const state = this.status();
		const requests = this.#native?.measurement().requests.length ?? 0;
		const elapsed = formatHeartbeatElapsed(Date.now() - this.#heartbeatSince);
		await this.#output(
			`${roleLabel(recipient.role)} · ${stageLabel(stageForPhase(state.phase))} · 已用时 ${elapsed} · 第 ${requests} 次请求`,
		);
	}
	#bind(phase: string): void {
		this.#releasePolicy?.();
		// 阶段变更先撤销全部旧技能授权；程序节点在自己的独立上下文精确加载所需技能。
		this.#releasePolicy = bindSpecSkillPolicy(this.#host.sessionManager, { phase, allowedSkills: [] });
	}
	async #initialize(): Promise<void> {
		const pending =
			this.#initializing ??
			(this.#initializing = (async () => {
				const native = await this.#factory({
					session: this.#host.session,
					settings: this.#host.settings,
					cwd: this.#host.cwd,
					onOutput: async text => {
						if (!this.#paused && !this.#disposed && this.#core && !this.#core.status().paused)
							await this.#emit(text);
					},
					onRequest: () => {
						void this.#publishHeartbeat().catch(() => {});
					},
				});
				if (this.#disposed || this.#released) {
					await native.dispose();
					return;
				}
				this.#native = native;
				const controller = this;
				const notify = (status: SpecDrivenStatus): void => {
					try {
						native.options.onStatusChange?.(structuredClone(status));
					} catch {
						// A factory listener must not suppress manager observers.
					}
					controller.publishObservation();
				};
				this.#core = new SpecDrivenOrchestrator(native.ports, {
					...native.options,
					assertTransitionAllowed: () => {
						native.options.assertTransitionAllowed?.();
						if (this.#outstanding()) throw new SpecAdmissionError(this.#messageBlock());
					},
					get onStatusChange() {
						return native.options.onStatusChange || observers.get(controller.#host.sessionManager)?.size
							? notify
							: undefined;
					},
				});
				this.publishObservation();
			})());
		try {
			await pending;
		} catch (error) {
			if (this.#initializing === pending) this.#initializing = undefined;
			throw error;
		}
	}
	schedule(operation: Operation): string {
		if (this.#disposed) throw new SpecAdmissionError("流程已释放");
		if (this.#outstanding()) throw new SpecAdmissionError(this.#messageBlock());
		if (this.#active) throw new SpecAdmissionError("流程正在运行；请使用 /dev status、/dev pause 或 /dev cancel");
		this.#paused = false;
		this.#failure = undefined;
		this.#pending = operation;
		this.#bind("dispatching");
		const epoch = ++this.#epoch;
		this.#active = true;
		this.#startHeartbeat();
		this.publishObservation();
		let jobId = "";
		try {
			jobId = this.#manager.register(
				"task",
				"协同开发 /dev",
				async ({ signal, reportProgress }) => {
					const abort = () => {
						if (epoch === this.#epoch) this.pause();
					};
					signal.addEventListener("abort", abort, { once: true });
					try {
						await this.#initialize();
						await this.#controlWork;
						if (epoch !== this.#epoch || signal.aborted || !this.#core) return "已停止旧调度";
						if (this.#outstanding()) throw new Error(this.#messageBlock());
						this.#pending = undefined;
						await operation(this.#core);
						if (epoch !== this.#epoch || signal.aborted) return "已停止旧调度";
						this.#bind(this.#core.status().phase);
						await reportProgress(`phase=${this.#core.status().phase}`);
						this.#active = false;
						this.publishObservation();
						await this.report();
						if (["completed", "cancelled"].includes(this.#core.status().phase)) await this.#release();
						return renderSpecDrivenStatus(this.#core.status());
					} catch (error) {
						if (epoch === this.#epoch && !this.#disposed) {
							this.#failure = error instanceof Error ? error.message : String(error);
							this.#bind(this.status().phase);
							this.#active = false;
							this.publishObservation();
							await this.report();
						}
						throw error;
					} finally {
						signal.removeEventListener("abort", abort);
						this.#jobs.delete(jobId);
						if (epoch === this.#epoch && this.#active) {
							this.#active = false;
							this.publishObservation();
						}
						if (epoch === this.#epoch) this.#stopHeartbeat();
						this.#drainMessages();
					}
				},
				{ ownerId: this.#host.session.getAgentId(), suppressDelivery: true },
			);
		} catch (error) {
			this.#stopHeartbeat();
			this.#active = false;
			this.#bind(this.status().phase);
			this.publishObservation();
			throw error;
		}
		this.#jobs.add(jobId);
		return jobId;
	}
	pause(): void {
		const phase = this.status().phase;
		if (["completed", "cancelled"].includes(phase) || (phase === "idle" && !this.#active)) return;
		this.#messageAbort?.abort();
		this.#stopHeartbeat();
		for (const message of this.#messages) {
			if (message.status === "processing") message.status = "cancelling";
			else if (message.status === "queued") {
				// Pausing invalidates this generation; retain undelivered input as an explicit failure.
				message.status = "failed";
				message.error = "流程已暂停，消息未投递；恢复后请重新提交";
			}
		}
		this.#paused = true;
		this.#epoch++;
		this.#controlWork = this.#core?.pause().catch(error => {
			this.#failure = error instanceof Error ? error.message : String(error);
			this.publishObservation();
		});
		this.#active = false;
		this.#bind(this.status().phase);
		for (const id of this.#jobs) this.#manager.cancel(id, { ownerId: this.#host.session.getAgentId() });
		this.publishObservation();
	}
	resume(): string {
		if (!this.#paused && !this.#core?.status().paused) throw new SpecAdmissionError("流程未暂停");
		const pending = this.#pending;
		return this.schedule(pending ?? (core => core.resume()));
	}
	async cancel(): Promise<void> {
		this.pause();
		this.#cancelled = true;
		this.#pending = undefined;
		const cancelled = this.#core?.cancel();
		if (!this.#core) this.#failure = "已取消初始化中的流程";
		this.publishObservation();
		await this.report();
		for (const message of this.#messages) if (message.status === "queued") message.status = "cancelled";
		await this.#messageWork;
		await cancelled;
		await this.#controlWork;
		await this.#release();
	}
	async #release(): Promise<void> {
		this.#stopHeartbeat();
		this.#releasePolicy?.();
		this.#releasePolicy = undefined;
		if (this.#released) return;
		const work =
			this.#releaseWork ??
			(this.#releaseWork = (async () => {
				await this.#initializing;
				await this.#native?.dispose();
				this.#released = true;
				this.publishObservation();
			})());
		try {
			await work;
		} catch (error) {
			if (this.#releaseWork === work) this.#releaseWork = undefined;
			throw error;
		}
	}
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.pause();
		this.#mode = "chat";
		this.#disposed = true;
		for (const message of this.#messages) if (message.status === "queued") message.status = "cancelled";
		await this.#messageWork;
		await this.#core?.cancel();
		this.publishObservation();
		await this.#release();
	}
}
