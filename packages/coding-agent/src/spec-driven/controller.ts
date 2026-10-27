import * as crypto from "node:crypto";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../session/agent-session";
import type { SlashCommandRuntime } from "../slash-commands/types";
import { hasExplicitRepairIntent, SpecAdmissionError, SpecDrivenOrchestrator } from "./orchestrator";
import { createSpecDrivenRuntime, type SpecDrivenRuntime } from "./runtime";
import { SPEC_PHASES } from "./stages";
import type { SpecControllerAction, SpecDrivenStatus, SpecInteractionState, SpecSavedRun } from "./types";
import { DevWorkspace } from "./workspace";
export type { SpecControllerAction } from "./types";
export type SpecRuntimeFactory = typeof createSpecDrivenRuntime;
interface WorkspaceState {
	version: 1;
	team: boolean;
	run?: SpecSavedRun;
}
export interface SpecControllerObservation {
	runId: string | null;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	active: boolean;
	released: boolean;
	disposed: boolean;
	status: SpecDrivenStatus;
	approvals: SpecSavedRun["approvals"];
	interaction: SpecInteractionState;
	teamMutable: boolean;
	error?: string;
	notice?: string;
}
type Listener = (observation: SpecControllerObservation) => void;
const controllers = new WeakMap<object, SpecDrivenController>();
const observers = new WeakMap<object, Set<Listener>>();
function deliver(listener: Listener, value: SpecControllerObservation): void {
	try {
		listener(value);
	} catch {
		/* Presentation cannot own execution. */
	}
}
export function observeSpecDrivenController(manager: object, listener: Listener): () => void {
	let listeners = observers.get(manager);
	if (!listeners) {
		listeners = new Set();
		observers.set(manager, listeners);
	}
	const registered: Listener = value => listener(value);
	listeners.add(registered);
	const controller = controllers.get(manager);
	if (controller) deliver(registered, controller.observation());
	return () => {
		listeners.delete(registered);
		if (!listeners.size) observers.delete(manager);
	};
}
export function peekSpecDrivenController(manager: object): SpecDrivenController | undefined {
	return controllers.get(manager);
}
export function getSpecDrivenController(
	host: SlashCommandRuntime,
	options: { factory?: SpecRuntimeFactory } = {},
): SpecDrivenController {
	let controller = controllers.get(host.sessionManager);
	if (!controller) {
		controller = new SpecDrivenController(host, options.factory);
		controllers.set(host.sessionManager, controller);
	}
	return controller;
}
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function validState(value: unknown): value is WorkspaceState {
	if (
		!object(value) ||
		value.version !== 1 ||
		typeof value.team !== "boolean" ||
		Object.keys(value).some(key => !["version", "team", "run"].includes(key))
	)
		return false;
	if (value.run === undefined) return true;
	const run = value.run;
	if (
		!object(run) ||
		!text(run.runId) ||
		!SPEC_PHASES.includes(run.phase as SpecDrivenStatus["phase"]) ||
		!object(run.sessions) ||
		!object(run.approvals)
	)
		return false;
	if (
		Object.keys(run).some(
			key =>
				![
					"runId",
					"phase",
					"changeId",
					"paths",
					"approvals",
					"sessions",
					"awaitingAcceptance",
					"reportNeedsUpdate",
					"closing",
					"archivedChangePath",
				].includes(key),
		)
	)
		return false;
	for (const flag of ["awaitingAcceptance", "reportNeedsUpdate"])
		if (run[flag] !== undefined && typeof run[flag] !== "boolean") return false;
	if (run.archivedChangePath !== undefined && typeof run.archivedChangePath !== "string") return false;
	if (
		run.closing !== undefined &&
		(!object(run.closing) ||
			(run.closing.synced !== undefined && typeof run.closing.synced !== "boolean") ||
			(run.closing.archivedChangePath !== undefined && typeof run.closing.archivedChangePath !== "string"))
	)
		return false;
	if (object(run.closing) && run.closing.retirementCleanup !== undefined) {
		const cleanup = run.closing.retirementCleanup;
		if (!object(cleanup) || !Array.isArray(cleanup.paths) || !cleanup.paths.every(text) || !text(cleanup.diagnostic))
			return false;
	}
	const roles = ["requirements", "solution", "planner", "executor"];
	for (const [role, ref] of Object.entries(run.sessions))
		if (
			!roles.includes(role) ||
			!object(ref) ||
			ref.role !== role ||
			!text(ref.actorId) ||
			!text(ref.sessionId) ||
			!text(ref.sessionFile)
		)
			return false;
	for (const [role, approval] of Object.entries(run.approvals))
		if (
			!roles.includes(role) ||
			!object(approval) ||
			!text(approval.userReply) ||
			!Array.isArray(approval.files) ||
			!approval.files.length ||
			!approval.files.every(file => object(file) && text(file.path) && text(file.version)) ||
			(approval.candidateId !== undefined && !text(approval.candidateId))
		)
			return false;
	if (run.phase !== "idle" && (!text(run.changeId) || !object(run.paths))) return false;
	const paths = run.paths;
	if (
		paths !== undefined &&
		(!object(paths) ||
			!Array.isArray(paths.requirements) ||
			!paths.requirements.length ||
			!paths.requirements.every(text) ||
			!["solution", "plan", "report"].every(key => text(paths[key])))
	)
		return false;
	if (run.phase !== "idle") {
		const stage = SPEC_PHASES.indexOf(run.phase as SpecDrivenStatus["phase"]) - 1;
		if (!run.sessions[roles[stage]]) return false;
		// Advancing commits the original decision and exact formal-file versions before model work.
		const requiredFiles = [paths!.requirements as string[], [paths!.solution], [paths!.plan]];
		for (let index = 0; index < stage; index++) {
			const approval = run.approvals[roles[index]];
			if (!object(approval) || !Array.isArray(approval.files)) return false;
			const files = approval.files;
			if (
				!requiredFiles[index].every(required => {
					const pattern =
						index === 0 && typeof required === "string" && required.includes("*")
							? new Bun.Glob(required)
							: undefined;
					return files.some(
						file =>
							object(file) &&
							(pattern
								? typeof file.path === "string" && !file.path.includes("*") && pattern.match(file.path)
								: file.path === required),
					);
				})
			)
				return false;
			if (roles[index] === "solution" && !text(approval.candidateId)) return false;
		}
	}
	return true;
}
function nativeBusy(session: AgentSession): boolean {
	return (
		session.isBusyForSnapshot ||
		session.hasAdmittedSubmission ||
		session.queuedMessageCount > 0 ||
		session.hasPendingAsyncWork() ||
		(session.getAsyncJobTree()?.running.length ?? 0) > 0
	);
}
/** One held workspace lease; all conversation, admission and cancellation remain native. */
export class SpecDrivenController {
	readonly #host: SlashCommandRuntime;
	readonly #factory: SpecRuntimeFactory;
	readonly #root: AgentSession;
	readonly #managers = new Set<object>();
	readonly #subscriptions = new Map<AgentSession, () => void>();
	readonly #createdAt = Date.now();
	#updatedAt = this.#createdAt;
	#workspace?: DevWorkspace;
	#state: WorkspaceState = { version: 1, team: false };
	#core?: SpecDrivenOrchestrator;
	#native?: SpecDrivenRuntime;
	#mode: "chat" | "dev" = "chat";
	#control = false;
	#stopping = false;
	#halted = false;
	#controlSettled?: PromiseWithResolvers<void>;
	#teamInterrupt?: { session: AgentSession; promise: Promise<boolean> };
	#error?: string;
	#notice?: string;
	constructor(host: SlashCommandRuntime, factory: SpecRuntimeFactory = createSpecDrivenRuntime) {
		this.#host = host;
		this.#root = host.session;
		this.#factory = factory;
		this.#register(this.#root);
	}
	#register(session: AgentSession): void {
		controllers.set(session.sessionManager, this);
		this.#managers.add(session.sessionManager);
		if (!this.#subscriptions.has(session))
			this.#subscriptions.set(
				session,
				session.subscribe(event => {
					this.publishObservation();
					if (event.type !== "agent_end") return;
					// agent_end can precede the admitting prompt's finally block. Do not
					// return this barrier to the event dispatcher: waitForIdle drains it.
					void Promise.allSettled([session.waitForAdmittedSubmissions(), session.waitForIdle()]).then(() => {
						if (this.#subscriptions.has(session)) this.publishObservation();
					});
				}),
			);
	}
	rootSession(): AgentSession {
		return this.#root;
	}
	nativeSession(): AgentSession | undefined {
		const role = this.#core?.currentRole();
		return role ? this.#native?.nativeSession(role) : undefined;
	}
	hasPendingTeam(session: AgentSession): boolean {
		return (
			this.#mode === "dev" &&
			session === this.nativeSession() &&
			(this.#teamInterrupt?.session === session || this.#native?.hasPendingTeam(session) === true)
		);
	}
	/** Interrupt only the current owner's external discussion, retaining the Dev run. */
	interrupt(session: AgentSession): Promise<boolean> {
		if (!this.hasPendingTeam(session)) return Promise.resolve(false);
		if (this.#teamInterrupt) return this.#teamInterrupt.promise;
		// An existing leave owns the stop barrier; ordinary interruption must not release it.
		if (this.#stopping) return Promise.resolve(false);
		const native = this.#native!;
		const controlSettled = this.#controlSettled;
		this.#stopping = true;
		const promise = (async () => {
			try {
				if (!(await native.interruptTeam(session))) return false;
				await controlSettled?.promise;
				return true;
			} finally {
				this.#stopping = false;
				this.#teamInterrupt = undefined;
				this.publishObservation();
			}
		})();
		this.#teamInterrupt = { session, promise };
		this.publishObservation();
		return promise;
	}
	inputMode(): "chat" | "dev" {
		return this.#mode;
	}
	status(): SpecDrivenStatus {
		return (
			this.#core?.status() ?? {
				phase: this.#state.run?.phase ?? "idle",
				generation: 0,
				useTeam: this.#state.team,
				changeId: this.#state.run?.changeId,
				paths: this.#state.run?.paths,
				closing: this.#state.run?.closing,
				archivedChangePath: this.#state.run?.archivedChangePath,
				awaitingAcceptance: this.#state.run?.awaitingAcceptance,
			}
		);
	}
	#teamMutable(): boolean {
		return (
			["idle", "requirements"].includes(this.status().phase) && !this.#control && !this.#stopping && !this.#halted
		);
	}
	#busy(): boolean {
		return [...this.#subscriptions.keys()].some(session => session !== this.#root && nativeBusy(session));
	}
	assertControlAllowed(): void {
		if (this.#control || this.#stopping) throw new SpecAdmissionError("当前控制操作尚未结清");
		if (this.#halted) throw new SpecAdmissionError("停止尚未完成，请重试退出或丢弃");
		if (this.#busy()) throw new SpecAdmissionError("原生会话、已接收输入或异步任务尚未结清");
	}
	actions(state = this.status()): SpecControllerAction[] {
		const reason =
			this.#control || this.#stopping
				? "当前控制操作尚未结清"
				: this.#halted
					? "停止尚未完成，请重试退出或丢弃"
					: this.#busy()
						? "原生输入或任务尚未结清"
						: undefined;
		const closing = !!(state.closing?.synced || state.closing?.archivedChangePath);
		return [
			{ id: "new", label: "新需求", command: "/dev new", requiresInput: true, allowed: state.phase === "idle" },
			{ id: "next", label: "确认并继续", command: "/dev next", allowed: state.phase !== "idle" && !!this.#native },
			{
				id: "back",
				label: "返回上一阶段",
				command: "/dev back",
				allowed: !closing && ["solution", "planning", "executing"].includes(state.phase) && !!this.#native,
			},
			{ id: "config", label: "配置 Team", command: "/dev config", allowed: this.#teamMutable() },
			{ id: "drop", label: "丢弃跟踪（已发生的同步和归档不会撤销）", command: "/dev drop", allowed: true },
			{ id: "exit", label: "退出 Dev", command: "/dev", allowed: true },
		].map(({ allowed, ...action }) => ({
			...action,
			available: allowed && (!reason || action.id === "exit" || action.id === "drop"),
			...(!allowed || reason ? { blockedReason: reason ?? "当前阶段不允许此操作" } : {}),
		}));
	}
	observation(): SpecControllerObservation {
		const status = this.status();
		return {
			runId: this.#state.run?.runId ?? null,
			cwd: this.#workspace?.root ?? this.#root.sessionManager.getCwd(),
			createdAt: this.#createdAt,
			updatedAt: this.#updatedAt,
			active: this.#control || this.#busy(),
			released: !this.#workspace,
			disposed: false,
			status,
			approvals: this.#core?.save().approvals ?? this.#state.run?.approvals ?? {},
			teamMutable: this.#teamMutable(),
			error: this.#error,
			notice: this.#notice,
			interaction: {
				mode: this.#mode,
				recipient: this.#mode === "dev" ? this.#core?.recipient() : undefined,
				actions: this.actions(status),
				blockedReason: this.#error ?? status.blockedReason,
			},
		};
	}
	publishObservation(): void {
		this.#updatedAt = Date.now();
		const value = this.observation();
		for (const manager of this.#managers)
			for (const listener of observers.get(manager) ?? []) deliver(listener, value);
	}
	async #save(run: SpecSavedRun | undefined, team = this.#state.team): Promise<void> {
		if (!this.#workspace) throw new Error("Dev 工作区尚未取得控制权");
		const state: WorkspaceState = { version: 1, team, ...(run ? { run } : {}) };
		await this.#workspace.save(state);
		this.#state = state;
	}
	async #bind(): Promise<void> {
		await this.#host.bindMainSession?.(this.#mode === "dev" ? (this.nativeSession() ?? this.#root) : this.#root);
	}
	async #initialize(saved?: SpecSavedRun): Promise<void> {
		const native = await this.#factory({
			session: this.#root,
			settings: this.#host.settings,
			cwd: this.#workspace!.root,
			saved,
			checkApproved: () => this.#core!.checkApproved(),
			observeReport: () => this.#core!.observeReport(),
			getStatus: () => this.status(),
			getSavedRun: () => this.#core?.save(),
			beginRepair: () => this.#core!.beginRepair(),
			onSessionCreated: (_role, session) => this.#register(session),
		});
		this.#native = native;
		this.#core = new SpecDrivenOrchestrator(native.ports, {
			...native.options,
			getUseTeam: () => this.#state.team,
			// Restoring references must not rewrite a valid saved run before entry succeeds.
			persist: async run => {
				if (this.#mode === "dev") {
					await this.#bind();
					await this.#save(run);
				}
			},
			onStatusChange: () => this.publishObservation(),
		});
		if (saved) await this.#core.restore(saved);
	}
	async #operation<T>(work: () => Promise<T>, retryEntryCleanup = false): Promise<T> {
		if (this.#control || this.#stopping) throw new SpecAdmissionError("当前控制操作尚未结清");
		if (!(retryEntryCleanup && this.#mode === "chat" && this.#halted && this.#workspace)) this.assertControlAllowed();
		this.#control = true;
		this.#error = undefined;
		this.#notice = undefined;
		this.publishObservation();
		const settled = Promise.withResolvers<void>();
		this.#controlSettled = settled;
		try {
			return await work();
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
			try {
				await this.#bind();
			} catch (bindError) {
				this.#error += `；恢复会话绑定失败：${bindError instanceof Error ? bindError.message : String(bindError)}`;
				throw new AggregateError([error, bindError], this.#error);
			}
			throw error;
		} finally {
			this.#control = false;
			settled.resolve();
			if (this.#controlSettled === settled) this.#controlSettled = undefined;
			this.publishObservation();
		}
	}
	async #cleanupFailedEntry(): Promise<void> {
		try {
			// Failed entry must retain ordinary chat while its owned work is settled.
			await this.#stopNative();
			await this.#disposeNative();
			await this.#bind();
			this.#workspace!.release();
			this.#workspace = undefined;
		} catch (error) {
			this.#halted = true;
			throw error;
		}
	}
	async enter(): Promise<void> {
		return this.#operation(async () => {
			if (this.#mode === "dev") return;
			if (this.#halted && this.#workspace) await this.#cleanupFailedEntry();
			if (nativeBusy(this.#root)) throw new SpecAdmissionError("普通会话仍有原生输入或任务，不能进入 Dev");
			this.#host.assertCanActivateMode?.("dev");
			const workspace = await DevWorkspace.acquire(this.#root.sessionManager.getCwd());
			this.#workspace = workspace;
			try {
				let saved: unknown;
				let cleared = false;
				try {
					saved = await workspace.read();
				} catch (error) {
					if (!(error instanceof SyntaxError)) throw error;
					await workspace.clear();
					cleared = true;
				}
				if (saved !== undefined && !validState(saved)) {
					await workspace.clear();
					saved = undefined;
					cleared = true;
				}
				this.#state = saved === undefined ? { version: 1, team: false } : (saved as WorkspaceState);
				if (this.#state.run && this.#state.run.phase !== "idle") await this.#initialize(this.#state.run);
				this.#mode = "dev";
				await this.#bind();
				if (this.#core) await this.#save(this.#core.save());
				if (cleared)
					this.#notice =
						"旧 Dev 状态无法恢复，已清除；配置已恢复默认，可执行 `/dev config` 或 `/dev new <需求内容>`。";
			} catch (error) {
				this.#mode = "chat";
				await this.#cleanupFailedEntry();
				throw error;
			}
		}, true);
	}
	async new(request: string, images?: ImageContent[], imageLinks?: (string | undefined)[]): Promise<void> {
		if (this.#mode !== "dev") throw new SpecAdmissionError("请先 /dev 进入开发模式");
		return this.#operation(async () => {
			if (!request.trim()) throw new SpecAdmissionError("需求不能为空");
			if (this.status().phase !== "idle" || (this.#state.run && !this.#state.run.archivedChangePath))
				throw new SpecAdmissionError("已有流程，请先丢弃");
			if (this.#native) await this.#disposeNative();
			try {
				await this.#initialize();
				const changeId = `dev-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
				await this.#core!.start(request, changeId, images, imageLinks);
			} catch (error) {
				if (!this.#state.run || this.#state.run.archivedChangePath) {
					await this.#stopNative();
					await this.#disposeNative();
					await this.#save(undefined);
					await this.#bind();
				}
				throw error;
			}
		});
	}
	async next(candidateId?: string, raw?: string): Promise<void> {
		return this.#operation(async () => {
			if (!this.#core || !this.#native) throw new SpecAdmissionError("请先建立或恢复阶段会话");
			await this.#core.next(candidateId, raw);
			await this.#bind();
			const completed = this.status();
			if (completed.phase === "idle" && completed.archivedChangePath) {
				this.#notice = `验收完成，需求已归档：${completed.archivedChangePath}`;
			}
		});
	}
	async back(): Promise<void> {
		return this.#operation(async () => {
			if (!this.#core || !this.#native) throw new SpecAdmissionError("没有可回退流程");
			await this.#core.back();
			await this.#bind();
		});
	}
	async setTeam(team: boolean): Promise<void> {
		return this.#operation(async () => {
			if (!["idle", "requirements"].includes(this.status().phase))
				throw new SpecAdmissionError("方案阶段起 Team 配置冻结");
			if (!this.#workspace) throw new SpecAdmissionError("请先进入 Dev");
			await this.#save(this.#state.run, team);
		});
	}
	async checkConversationAllowed(): Promise<void> {
		if (this.#stopping || this.#halted) throw new SpecAdmissionError("原生停止尚未结清");
		if (this.#mode !== "dev" || !this.#core || !this.nativeSession())
			throw new SpecAdmissionError("请先 /dev new <需求内容>");
		if (this.#core.isTransitioning()) throw new SpecAdmissionError("当前控制操作尚未结清");
		const core = this.#core;
		const phase = core.status().phase;
		const generation = core.status().generation;
		// Mismatches permit native read-only diagnosis; actor tool guards enforce writes.
		await this.#core.checkApproved();
		if (core.isTransitioning()) throw new SpecAdmissionError("当前控制操作尚未结清");
		if (
			this.#stopping ||
			this.#halted ||
			core !== this.#core ||
			phase !== core.status().phase ||
			generation !== core.status().generation
		)
			throw new SpecAdmissionError("阶段已改变，请重新提交");
	}
	async submitText(text: string, images?: ImageContent[], imageLinks?: (string | undefined)[]): Promise<void> {
		const core = this.#core;
		const phase = this.status().phase;
		const generation = this.status().generation;
		await this.checkConversationAllowed();
		if (core !== this.#core || phase !== this.status().phase || generation !== this.status().generation)
			throw new SpecAdmissionError("阶段已改变，请重新提交");
		const intent = hasExplicitRepairIntent(text) ? "repair" : undefined;
		try {
			await core!.converse(text, images, imageLinks, intent);
			this.#error = undefined;
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			this.publishObservation();
		}
	}
	async #stopNative(): Promise<void> {
		this.#halted = true;
		await this.#core?.stop();
		await this.#native?.stop();
	}
	async #disposeNative(): Promise<void> {
		await this.#native?.dispose();
		this.#native = undefined;
		this.#core = undefined;
		this.#halted = false;
		for (const [session, unsubscribe] of this.#subscriptions)
			if (session !== this.#root) {
				unsubscribe();
				this.#subscriptions.delete(session);
				controllers.delete(session.sessionManager);
				this.#managers.delete(session.sessionManager);
			}
	}
	async #leave(drop: boolean): Promise<void> {
		if (this.#stopping) throw new SpecAdmissionError("停止操作尚未结清");
		if (!this.#workspace) {
			if (drop) throw new SpecAdmissionError("尚未进入 Dev");
			return;
		}
		this.#stopping = true;
		this.#notice = undefined;
		try {
			const empty = drop && (await this.#workspace.read()) === undefined;
			await this.#stopNative();
			await this.#controlSettled?.promise;
			await this.#save(drop ? undefined : (this.#core?.save() ?? this.#state.run), drop ? false : this.#state.team);
			await this.#disposeNative();
			const previousMode = this.#mode;
			this.#mode = drop ? "dev" : "chat";
			try {
				await this.#host.bindMainSession?.(this.#root);
			} catch (error) {
				this.#mode = previousMode;
				this.#halted = true;
				throw error;
			}
			if (!drop) {
				this.#workspace.release();
				this.#workspace = undefined;
			}
			this.#error = undefined;
			if (empty) this.#notice = "没有 Dev 状态，无需清除。";
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			this.#stopping = false;
			this.publishObservation();
		}
	}
	async exit(): Promise<void> {
		await this.#leave(false);
	}
	async drop(): Promise<void> {
		await this.#leave(true);
	}
	async dispose(): Promise<void> {
		await this.exit();
	}
}
