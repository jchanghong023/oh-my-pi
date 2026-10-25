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
	questions: [],
	tasks: [],
	reviews: [],
	pendingClosure: [],
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
	controller.setOutput(host.output);
	return controller;
}

export function renderSpecDrivenSummary(state: SpecDrivenStatus): string {
	const lines = [`协同开发模式：${stageLabel(stageForPhase(state.phase))}${state.paused ? "（暂停）" : ""}`];
	if (state.blockedReason) lines.push(`阻塞：${state.blockedReason}`);
	lines.push(...state.questions.map(question => `待回答：${question}`));
	if (state.tasks.length)
		lines.push(`任务完成：${state.tasks.filter(task => task.status === "completed").length}/${state.tasks.length}`);
	for (const review of state.reviews)
		if (review.lastReview)
			lines.push(
				`审查 ${review.kind}：${review.lastReview.verdict}；${review.lastReview.summary}`,
				...review.findings.map(finding => `[${finding.severity}] ${finding.issue}\n依据：${finding.evidence}`),
			);
	if (state.phase === "awaiting-plan")
		lines.push("批准计划会开始执行并授权范围内任务的本地提交；不授权推送、发布、PR、改写历史或无关改动。");
	if (state.pendingClosure.length) lines.push(`待收尾：${state.pendingClosure.join("；")}`);
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
	#output: SlashCommandRuntime["output"];
	#core?: SpecDrivenOrchestrator;
	#native?: SpecControllerRuntime;
	#initializing?: Promise<void>;
	#releasePolicy?: () => void;
	#jobs = new Set<string>();
	#epoch = 0;
	#disposed = false;
	#released = false;
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
		this.#output = host.output;
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
	setOutput(output: SlashCommandRuntime["output"]): void {
		this.#output = output;
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
	actions(): SpecControllerAction[] {
		const state = this.status();
		const blocked = this.#disposed
			? "流程所有者已释放"
			: (this.#messageBlock() ?? (this.#active ? "阶段操作正在运行" : undefined));
		const result: SpecControllerAction[] = [];
		const add = (id: string, label: string, command: string, requiresInput = false, control = false): void => {
			result.push({
				id,
				label,
				command: `/dev ${command}`,
				available: control ? !this.#disposed : !blocked,
				version: id === "answer" ? `${command}:${state.clarification?.id ?? ""}` : `/dev ${command}`,
				...(blocked && !control ? { blockedReason: blocked } : {}),
				...(requiresInput ? { requiresInput: true } : {}),
			});
		};
		add("status", "查看当前阶段摘要", "status", false, true);
		if (["idle", "completed", "cancelled"].includes(state.phase)) add("start", "开始新流程", "start", true);
		else if (!["completed", "cancelled"].includes(state.phase)) {
			if (state.paused) add("resume", "恢复流程（不自动发送草稿）", "resume", false, !this.#outstanding());
			else {
				if (state.phase === "awaiting-answers") add("answer", "回答本轮澄清（不批准转换）", "answer", true);
				if (state.phase === "awaiting-specification" && state.specification)
					add("confirm-spec", "确认需求并进入方案", `confirm-spec ${state.specification.version}`);
				if (state.phase === "awaiting-choice" && state.team) {
					for (const candidate of state.team.candidates)
						if (
							state.team.status === "completed" &&
							candidate.adoptable &&
							candidate.reviewSucceeded &&
							candidate.recheckSucceeded &&
							!candidate.exclusionReason &&
							!candidate.unresolvedBlocking.length &&
							!state.team.interpretationDifferences.some(item => item.affectsChoice && !item.resolved)
						)
							add(
								`choose:${candidate.id}`,
								`选择 ${candidate.label} 并编写计划`,
								`choose ${state.team.runId} ${candidate.id} ${candidate.version}`,
							);
				}
				if (state.phase === "awaiting-plan" && state.plan) {
					add("confirm-plan", "批准计划并开始普通执行", `confirm-plan ${state.plan.version}`);
					add("confirm-plan-goal", "批准计划并启用原生 Goal 执行", `confirm-plan ${state.plan.version} --goal`);
				}
				if (state.phase === "awaiting-acceptance" && state.acceptanceVersion) {
					add("accept", "验收当前交付并执行已授权收尾", `accept ${state.acceptanceVersion}`);
					add("repair", "撤销当前验收资格并返回获批范围内修复", `repair ${state.acceptanceVersion}`, true);
				}
				add("pause", "立即暂停流程", "pause", false, true);
			}
			add("amend", "修改需求并撤销受影响下游批准", "amend", true);
			if (state.specificationApproval) add("change-solution", "重新讨论方案并撤销下游批准", "change-solution", true);
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
			clarificationId: state.clarification?.id,
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
			message.clarificationId !== core.status().clarification?.id ||
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
					const reply = await core.converse(message.text, message.id, recipient, abort.signal);
					if (abort.signal.aborted || this.#disposed) message.status = "cancelled";
					else {
						message.reply = reply.text;
						message.status = "completed";
						await this.#emit(
							`${reply.text}\n\n${renderSpecDrivenSummary(this.status())}\n${this.#actionSummary()}`,
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
	repair(acceptanceVersion: string, text: string): string {
		if (this.#active || this.#outstanding() || !this.#core) throw new SpecAdmissionError("流程或用户消息尚未结清");
		try {
			this.#core.assertRepair(acceptanceVersion, text);
		} catch (error) {
			throw new SpecAdmissionError(error instanceof Error ? error.message : String(error), { cause: error });
		}
		let run: (() => Promise<SpecDrivenStatus>) | undefined;
		return this.schedule(
			() => run!(),
			false,
			() => {
				run = this.#core!.prepareRepair(acceptanceVersion, text);
			},
		);
	}
	status(): SpecDrivenStatus {
		const state = this.#core?.status() ?? emptyStatus();
		if (this.#cancelled) state.phase = "cancelled";
		if (this.#paused) state.paused = true;
		if (this.#failure) state.blockedReason = this.#failure;
		return state;
	}
	observation(): SpecControllerObservation {
		return {
			runId: this.#core?.runId ?? null,
			cwd: this.#host.cwd,
			createdAt: this.#createdAt,
			updatedAt: this.#updatedAt,
			active: this.#active,
			released: this.#released,
			disposed: this.#disposed,
			status: this.status(),
			interaction: {
				mode: this.#mode,
				draft: this.#draft,
				recipient: this.#core?.recipient(),
				messages: structuredClone(this.#messages),
				actions: this.actions(),
				clarification: this.status().clarification,
				blockedReason:
					this.#messageBlock() ??
					this.status().blockedReason ??
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
		const recipient = this.#core?.recipient();
		const destination = state.paused
			? "已暂停；新文字仅保留草稿"
			: recipient
				? `${roleLabel(recipient.role)} · ${this.#active ? "运行中" : "等待你"}`
				: "尚无可接收消息的阶段 Agent；文字仅保留草稿";
		let text = `输入模式：${this.#mode === "dev" ? "协同开发" : "普通聊天"}；接收：${destination}\n${renderSpecDrivenSummary(state)}${options.rawPhase ? `\n阶段键：${state.phase}` : ""}\n${this.#actionSummary()}\n/dev help 打开操作界面`;
		if (this.#active) text += "\n后台运行中；/dev status、/dev pause、/dev cancel 可立即使用。";
		for (const message of this.#messages)
			text += `\n消息 ${message.id}：${message.status}${message.error ? `；${message.error}` : ""}`;
		if (this.#native) {
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
		// Team discussion already streams ordered progress through onOutput.
		if (!recipient || recipient.role === "solution") return;
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
	schedule(operation: Operation, interrupt = false, onAdmission?: () => void): string {
		if (this.#disposed) throw new SpecAdmissionError("流程已释放");
		if (this.#outstanding()) throw new SpecAdmissionError(this.#messageBlock());
		if (this.#active && !interrupt)
			throw new SpecAdmissionError("流程正在运行；请使用 /dev status、/dev pause 或 /dev cancel");
		if (interrupt) this.pause();
		this.#paused = false;
		this.#failure = undefined;
		this.#pending = operation;
		this.#bind("dispatching");
		const epoch = ++this.#epoch;
		this.#active = true;
		this.#startHeartbeat();
		onAdmission?.();
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
						if (epoch !== this.#epoch || signal.aborted || !this.#core) return "已停止旧调度";
						// Synchronously admitted repair owns messages queued afterward; drain them after its operation.
						if (!onAdmission && this.#outstanding()) throw new Error(this.#messageBlock());
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
		this.#messageAbort?.abort();
		this.#stopHeartbeat();
		for (const message of this.#messages) {
			if (message.status === "processing") message.status = "cancelling";
		}
		this.#paused = true;
		this.#epoch++;
		this.#core?.pause();
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
		this.#core?.cancel();
		if (!this.#core) this.#failure = "已取消初始化中的流程";
		this.publishObservation();
		await this.report();
		for (const message of this.#messages) if (message.status === "queued") message.status = "cancelled";
		await this.#messageWork;
		await this.#release();
	}
	async #release(): Promise<void> {
		this.#stopHeartbeat();
		this.#releasePolicy?.();
		this.#releasePolicy = undefined;
		if (this.#released) return;
		this.#released = true;
		this.publishObservation();
		await this.#native?.dispose();
	}
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.pause();
		this.#mode = "chat";
		this.#disposed = true;
		for (const message of this.#messages) if (message.status === "queued") message.status = "cancelled";
		await this.#messageWork;
		this.#core?.cancel();
		this.publishObservation();
		await this.#release();
	}
}
