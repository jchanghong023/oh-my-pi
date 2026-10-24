import type { AsyncJobManager } from "../async/job-manager";
import type { SlashCommandRuntime } from "../slash-commands/types";
import { summarizeSpecRun, type SpecRunMeasurement } from "./metrics";
import { SpecDrivenOrchestrator } from "./orchestrator";
import { createSpecDrivenRuntime } from "./runtime";
import { bindSpecSkillPolicy } from "./skill-policy";
import type { SpecDrivenOptions, SpecDrivenPorts, SpecDrivenStatus } from "./types";

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
const emptyStatus = (): SpecDrivenStatus => ({
	phase: "idle",
	paused: false,
	generation: 0,
	questions: [],
	tasks: [],
	reviews: [],
	pendingClosure: [],
});

/** One in-memory workflow per native session-manager identity, shared by every host. */
export function getSpecDrivenController(
	host: SlashCommandRuntime,
	options: { factory?: SpecRuntimeFactory; restart?: boolean } = {},
): SpecDrivenController {
	let controller = controllers.get(host.sessionManager);
	if (
		controller &&
		(!controller.belongsTo(host) ||
			(options.restart && ["completed", "cancelled"].includes(controller.status().phase)))
	) {
		void controller.dispose();
		controller = undefined;
	}
	if (!controller) {
		controller = new SpecDrivenController(host, options.factory);
		controllers.set(host.sessionManager, controller);
		controller.publishObservation();
	}
	controller.setOutput(host.output);
	return controller;
}

export function renderSpecDrivenStatus(state: SpecDrivenStatus): string {
	const lines = [
		"规格驱动流程（仅本进程内暂停/继续，不支持重启恢复）",
		JSON.stringify({
			phase: state.phase,
			paused: state.paused,
			generation: state.generation,
			executionMode: state.executionMode,
			changeId: state.changeId,
			specificationVersion: state.specification?.version,
			solutionVersion: state.solution?.version,
			planVersion: state.plan?.version,
			artifactVersion: state.plan?.artifactVersion,
			runId: state.team?.runId,
			selection: state.selection,
			acceptanceVersion: state.acceptanceVersion,
		}),
	];
	if (state.blockedReason) lines.push(`暂停/阻塞原因：${state.blockedReason}`);
	for (const question of state.questions) lines.push(`待回答：${question}`);
	for (const review of state.reviews)
		lines.push(
			`审查 ${review.kind} ${review.id}：${review.lastReview?.verdict ?? "未完成"}；${review.sameModelIndependent ? "同模型独立分析" : review.model}；${review.lastReview?.summary ?? ""}`,
			...review.findings.map(
				finding => `${finding.id} [${finding.severity}] ${finding.issue}\n依据：${finding.evidence}`,
			),
		);
	if (state.phase === "awaiting-specification" && state.specification) {
		lines.push(
			"待确认的 OpenSpec 需求提案及规格：",
			state.specification.proposal,
			...state.specification.specs.map(spec => `### ${spec.path}\n${spec.content}`),
		);
	}
	if (state.team && (state.phase === "awaiting-choice" || state.phase === "team")) {
		lines.push(`讨论状态：${state.team.status}；输入规格：${state.team.inputVersion}`, state.team.report);
		for (const candidate of state.team.candidates)
			lines.push(
				JSON.stringify({
					id: candidate.id,
					version: candidate.version,
					label: candidate.label,
					adoptable: candidate.adoptable,
					reviewSucceeded: candidate.reviewSucceeded,
					recheckSucceeded: candidate.recheckSucceeded,
					unresolvedBlocking: candidate.unresolvedBlocking,
					exclusionReason: candidate.exclusionReason,
					conditions: candidate.conditions,
				}),
				candidate.proposal,
			);
		for (const difference of state.team.interpretationDifferences)
			lines.push(`理解差异：${JSON.stringify(difference)}`);
	}
	if (state.solution) lines.push(`已选方案原文（${state.solution.artifactVersion}）：`, state.solution.proposal);
	for (const handoff of state.handoffs ?? [])
		lines.push(
			`原生交接 ${handoff.transition}：${handoff.path}`,
			JSON.stringify({
				actorId: handoff.actorId,
				sessionId: handoff.sessionId,
				runId: handoff.runId,
				generation: handoff.generation,
				digest: handoff.digest,
				versions: handoff.versions,
			}),
			handoff.body,
		);
	if (state.phase === "awaiting-plan" && state.plan)
		lines.push(
			"待批准的唯一计划：",
			state.plan.content,
			"确认计划会启动自主执行（默认 normal；--goal 仅为执行代理启用原生 Goal），并仅授权已批准工作区内本任务相关改动的本地 commit；不授权最终分支合并、推送、发布、PR 或改写历史。",
		);
	for (const task of state.tasks)
		lines.push(
			`任务 ${task.id}：${task.status}；验证 ${task.records.length} 项；提交 ${task.commits.length} 项；审查 ${task.review?.lastReview?.verdict ?? "未完成"}`,
		);
	if (state.pendingClosure.length) lines.push(`待收尾：${state.pendingClosure.join("；")}`);
	const next: string[] = [];
	if (state.paused && state.phase !== "cancelled") next.push("/spec resume", "/spec amend <修改后的需求>");
	else if (state.phase === "idle") next.push("/spec start <change-id> <完整需求>");
	else if (state.phase === "awaiting-answers") next.push("/spec answer <完整回答>");
	else if (state.phase === "awaiting-specification" && state.specification)
		next.push(`/spec confirm-spec ${state.specification.version}`);
	else if (state.phase === "awaiting-choice" && state.team) {
		for (const candidate of state.team.candidates)
			if (
				state.team.status === "completed" &&
				candidate.adoptable &&
				candidate.reviewSucceeded &&
				candidate.recheckSucceeded &&
				!candidate.unresolvedBlocking.length &&
				!state.team.interpretationDifferences.some(item => item.affectsChoice && !item.resolved)
			)
				next.push(`/spec choose ${state.team.runId} ${candidate.id} ${candidate.version}`);
		if (!next.length) next.push("/spec change-solution <重新讨论的原因>");
	} else if (state.phase === "awaiting-plan" && state.plan)
		next.push(`/spec confirm-plan ${state.plan.version}`, `/spec confirm-plan ${state.plan.version} --goal`);
	else if (state.phase === "awaiting-acceptance" && state.acceptanceVersion)
		next.push(`/spec accept ${state.acceptanceVersion}`);
	else if (!["completed", "cancelled"].includes(state.phase)) next.push("/spec status", "/spec pause");
	if (!["idle", "completed", "cancelled"].includes(state.phase)) next.push("/spec cancel");
	lines.push(next.length ? `下一步（完整命令）：\n${next.join("\n")}` : "流程已停止；/spec status 查看最终状态。");
	return lines.join("\n\n");
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

	constructor(host: SlashCommandRuntime, factory: SpecRuntimeFactory = createSpecDrivenRuntime) {
		if (!host.session.asyncJobManager) throw new Error("当前会话缺少原生 AsyncJobManager，无法启动 /spec");
		this.#host = host;
		this.#manager = host.session.asyncJobManager;
		this.#factory = factory;
		this.#output = host.output;
		this.#sessionGeneration = host.session.sessionGeneration;
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
	async report(): Promise<void> {
		let text = renderSpecDrivenStatus(this.status());
		if (this.#active) text += "\n后台运行中；/spec status、/spec pause、/spec cancel 可立即使用。";
		if (this.#native)
			text += `\n实际投入（未知值为 null；不代表质量提高）：${JSON.stringify(summarizeSpecRun(this.#native.measurement()))}`;
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
	#bind(phase: string): void {
		this.#releasePolicy?.();
		// 阶段变更先撤销全部旧技能授权；程序节点在自己的独立上下文精确加载所需技能。
		this.#releasePolicy = bindSpecSkillPolicy(this.#host.sessionManager, { phase, allowedSkills: [] });
	}
	async #initialize(): Promise<void> {
		if (!this.#initializing)
			this.#initializing = (async () => {
				const native = await this.#factory({
					session: this.#host.session,
					settings: this.#host.settings,
					cwd: this.#host.cwd,
					onOutput: async text => {
						if (!this.#paused && !this.#disposed && this.#core && !this.#core.status().paused)
							await this.#emit(text);
					},
				});
				if (this.#disposed) {
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
					get onStatusChange() {
						return native.options.onStatusChange || observers.get(controller.#host.sessionManager)?.size
							? notify
							: undefined;
					},
				});
				this.publishObservation();
			})();
		await this.#initializing;
	}
	schedule(operation: Operation, interrupt = false): string {
		if (this.#disposed) throw new Error("流程已释放");
		if (this.#active && !interrupt) throw new Error("流程正在运行；请使用 /spec status、/spec pause 或 /spec cancel");
		if (interrupt) this.pause();
		this.#paused = false;
		this.#failure = undefined;
		this.#pending = operation;
		this.#bind("dispatching");
		const epoch = ++this.#epoch;
		this.#active = true;
		this.publishObservation();
		let jobId = "";
		try {
			jobId = this.#manager.register(
				"task",
				"规格驱动 /spec",
				async ({ signal, reportProgress }) => {
					const abort = () => {
						if (epoch === this.#epoch) this.pause();
					};
					signal.addEventListener("abort", abort, { once: true });
					try {
						await this.#initialize();
						if (epoch !== this.#epoch || signal.aborted || !this.#core) return "已停止旧调度";
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
					}
				},
				{ ownerId: this.#host.session.getAgentId(), suppressDelivery: true },
			);
		} catch (error) {
			this.#active = false;
			this.#bind(this.status().phase);
			this.publishObservation();
			throw error;
		}
		this.#jobs.add(jobId);
		return jobId;
	}
	pause(): void {
		this.#paused = true;
		this.#epoch++;
		this.#core?.pause();
		this.#active = false;
		this.#bind(this.status().phase);
		for (const id of this.#jobs) this.#manager.cancel(id, { ownerId: this.#host.session.getAgentId() });
		this.publishObservation();
	}
	resume(): string {
		if (!this.#paused && !this.#core?.status().paused) throw new Error("流程未暂停");
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
		await this.dispose();
	}
	async #release(): Promise<void> {
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
		this.#core?.cancel();
		this.#disposed = true;
		this.publishObservation();
		await this.#release();
	}
}
