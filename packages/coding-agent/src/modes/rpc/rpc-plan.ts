/** Plan-mode host lifecycle for RPC; planning and approval use the shared session implementation. */
import { createHash } from "node:crypto";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { PROPOSE_DEVICE_NAME } from "@oh-my-pi/pi-tui/tools/resolve";
import { logger } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import type { PlanApprovalDetails } from "../../plan-mode/approved-plan";
import { resolvePlanModelTransition } from "../../plan-mode/model-transition";
import { listPlanFiles, readPlanFile } from "../../plan-mode/plan-files";
import { dispatchApprovedPlan } from "../../plan-mode/session-approval";
import { cfgPlanEnabled } from "../../plan-mode/settings";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { SlashCommandResult } from "../../slash-commands/types";
import { isMCPToolName } from "../../tools/builtin-names";
import { writeDeviceDispatch } from "../../tools/resolve";

function rpcPlanDiagnosticId(value: string): string {
	return /^[A-Za-z0-9_-]{1,96}$/.test(value) ? value : createHash("sha256").update(value).digest("hex").slice(0, 24);
}

interface ModelSnapshot {
	model: Model;
	thinkingLevel: ConfiguredThinkingLevel | undefined;
}

interface ToolPresentation {
	enabled: string[];
	mounted: string[];
}

/** Narrow session seam also used by the controller's contract tests. */
export type RpcPlanSession = Pick<
	AgentSession,
	| "settings"
	| "sessionManager"
	| "sessionId"
	| "sessionGeneration"
	| "isDisposed"
	| "isStreaming"
	| "isSessionTransitioning"
	| "model"
	| "getGoalModeState"
	| "getVibeModeState"
	| "getPlanModeState"
	| "setPlanModeState"
	| "getPlanReferencePath"
	| "getEnabledToolNames"
	| "getMountedXdevToolNames"
	| "hasBuiltInTool"
	| "setActiveToolsByName"
	| "setActiveToolPresentation"
	| "restoreNonMCPToolPresentation"
	| "setPlanProposalHandler"
	| "preparePlanForReview"
	| "sendPlanModeContext"
	| "configuredThinkingLevel"
	| "resolveRoleModelWithThinking"
	| "setModelTemporary"
	| "setThinkingLevel"
	| "waitForIdle"
	| "runModeExitTeardown"
	| "abort"
	| "markPlanInternalAbortPending"
	| "clearPlanInternalAbortPending"
>;

export class RpcPlanController {
	readonly #session: RpcPlanSession;
	readonly #ui: Pick<ExtensionUIContext, "select" | "confirm" | "input">;
	readonly #output: (text: string) => void;
	readonly #runInBackground: (task: () => Promise<void>) => void;
	readonly #onReviewRejected: (() => void) | undefined;
	#previousTools: ToolPresentation | undefined;
	#previousModel: ModelSnapshot | undefined;
	#pendingModel: ModelSnapshot | undefined;
	#modelRevision = 0;
	#paused = false;
	#entered = false;
	#lastPlanFilePath: string | undefined;
	#operation = new AbortController();
	#reviewing = false;
	#tail: Promise<void> = Promise.resolve();
	#sessionChanges = 0;
	#sessionBeforeChange: { id: string; generation: number; detachesRun: boolean } | undefined;
	#proposal: { details: PlanApprovalDetails; current: () => boolean } | undefined;
	#logContext: Record<string, unknown> = {};

	#log(event: string, stage: string, result: string, fields: Record<string, unknown> = {}): void {
		logger.info("RPC plan lifecycle", {
			...this.#logContext,
			...logger.getLogContext(),
			component: "rpc-plan",
			event,
			stage,
			result,
			session_id: rpcPlanDiagnosticId(this.#session.sessionManager.getSessionId()),
			session_generation: this.#session.sessionGeneration,
			...fields,
		});
	}

	constructor(
		session: RpcPlanSession,
		ui: Pick<ExtensionUIContext, "select" | "confirm" | "input">,
		output: (text: string) => void,
		runInBackground: (task: () => Promise<void>) => void,
		onReviewRejected?: () => void,
	) {
		this.#session = session;
		this.#ui = ui;
		this.#output = output;
		this.#runInBackground = runInBackground;
		this.#onReviewRejected = onReviewRejected;
	}

	get reviewPending(): boolean {
		return this.#reviewing;
	}

	assertCanEnterGoal(): void {
		if (this.#paused) throw new Error("Plan mode is paused — run /plan again to fully exit.");
		if (this.#session.getPlanModeState()?.enabled) throw new Error("Exit plan mode first.");
	}

	/** Cancel only pending work; the draft and plan mode remain available. */
	cancel(): void {
		if (this.#reviewing) this.#log("plan_cancelled", "approval", "cancelled");
		this.#operation.abort();
		this.#operation = new AbortController();
		this.#reviewing = false;
		this.#proposal = undefined;
	}

	async settled(): Promise<void> {
		for (let tail = this.#tail; ; tail = this.#tail) {
			await tail;
			if (tail === this.#tail) return;
		}
	}

	/** Restore the source session's transient presentation before changing sessions. */
	async beginSessionChange(options?: { detachesRun?: boolean }): Promise<void> {
		if (this.#sessionChanges++ > 0) return;
		this.#sessionBeforeChange = {
			id: this.#session.sessionManager.getSessionId(),
			generation: this.#session.sessionGeneration,
			detachesRun: options?.detachesRun !== false,
		};
		this.cancel();
		try {
			await this.settled();
			if (options?.detachesRun !== false && this.#session.getPlanModeState()?.enabled) {
				await this.#session.runModeExitTeardown(async () => {
					this.#session.markPlanInternalAbortPending();
					try {
						if (this.#session.isStreaming) await this.#session.abort();
					} finally {
						this.#session.clearPlanInternalAbortPending();
					}
					await this.#exit(false, false);
				});
			}
		} catch (error) {
			this.#sessionChanges = 0;
			this.#sessionBeforeChange = undefined;
			throw error;
		}
	}

	async endSessionChange(_options?: { detachesRun?: boolean }): Promise<void> {
		if (--this.#sessionChanges > 0) return;
		this.#sessionChanges = 0;
		const previous = this.#sessionBeforeChange;
		this.#sessionBeforeChange = undefined;
		const changed =
			!previous ||
			previous.id !== this.#session.sessionManager.getSessionId() ||
			previous.generation !== this.#session.sessionGeneration;
		if (changed || previous?.detachesRun) {
			await this.reconcile({ preserveRestoredModel: changed });
		}
	}

	/** Reattach a journaled plan after startup, switching, or cancelled navigation. */
	async reconcile(options?: { preserveRestoredModel?: boolean }): Promise<void> {
		this.#logContext = {
			...logger.getLogContext(),
			operation_id: logger.getLogContext().operation_id ?? `rpc-plan-${crypto.randomUUID()}`,
		};
		const started = performance.now();
		this.#log("plan_reconcile_started", "reconcile", "started");
		try {
			this.cancel();
			await this.settled();
			this.#previousTools = undefined;
			this.#previousModel = undefined;
			this.#pendingModel = undefined;
			this.#lastPlanFilePath = undefined;
			this.#session.setPlanModeState(undefined);
			this.#session.setPlanProposalHandler(null);
			const context = this.#session.sessionManager.buildSessionContext();
			this.#paused = context.mode === "plan_paused";
			this.#entered = context.mode === "plan" || this.#paused;
			if (!cfgPlanEnabled.get(this.#session.settings)) {
				if (this.#entered) this.#session.sessionManager.appendModeChange("none");
				this.#paused = false;
				this.#entered = false;
				this.#log("plan_reconcile_completed", "reconcile", "disabled", { elapsed_ms: performance.now() - started });
				return;
			}
			const current = this.#guard(this.#operation.signal);
			if (this.#entered) {
				const path = context.modeData?.planFilePath;
				this.#lastPlanFilePath = await this.#findDraft(typeof path === "string" ? path : undefined, current);
				if (!current()) {
					this.#log("plan_reconcile_terminal", "reconcile", "cancelled", {
						elapsed_ms: performance.now() - started,
					});
					return;
				}
			}
			if (context.mode === "plan") {
				const path = context.modeData?.planFilePath;
				await this.#enter(
					typeof path === "string" ? path : undefined,
					options?.preserveRestoredModel !== false,
					current,
				);
			}
			this.#log("plan_reconcile_completed", "reconcile", this.#entered ? "restored" : "inactive", {
				elapsed_ms: performance.now() - started,
				paused: this.#paused,
			});
		} catch (error) {
			this.#log(
				"plan_reconcile_terminal",
				"reconcile",
				error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed",
				{ elapsed_ms: performance.now() - started },
			);
			throw error;
		}
	}

	async handle(args: string, signal?: AbortSignal): Promise<SlashCommandResult> {
		this.#logContext = {
			...logger.getLogContext(),
			operation_id: logger.getLogContext().operation_id ?? `rpc-plan-${crypto.randomUUID()}`,
		};
		if (signal?.aborted) return { consumed: true };
		const task = args.trim();
		if (this.#session.getPlanModeState()?.enabled) {
			this.cancel();
			this.#background(async () => {
				const operationSignal = this.#signal(signal);
				const current = this.#guard(operationSignal);
				const path = this.#session.getPlanModeState()?.planFilePath;
				const draftPath = await this.#findDraft(path, current);
				if (!current()) return;
				if (draftPath) this.#lastPlanFilePath = draftPath;
				if (draftPath) {
					this.#log("plan_stage_started", "exit_confirmation", "started");
					const confirmed = await this.#ui.confirm(
						"Exit plan mode?",
						"This exits plan mode without approving a plan.",
						{ signal: operationSignal },
					);
					this.#log(
						"plan_stage_completed",
						"exit_confirmation",
						current() ? (confirmed ? "approved" : "rejected") : "cancelled",
					);
					if (!confirmed) return;
				}
				if (!current()) return;
				await this.#enqueue(async () => {
					if (!current()) return;
					await this.#session.runModeExitTeardown(async () => {
						if (this.#session.isStreaming) await this.#session.abort({ reason: USER_INTERRUPT_LABEL });
						if (current()) await this.#exit(true);
					});
				});
			}, signal);
			return { consumed: true };
		}
		if (this.#paused && !task) {
			this.#paused = false;
			this.#entered = false;
			this.#lastPlanFilePath = undefined;
			this.#session.sessionManager.appendModeChange("none");
			this.#output("Plan mode disabled.");
			return { consumed: true };
		}
		const current = this.#guard(this.#signal(signal));
		await this.#enqueue(async () => {
			if (!current()) return;
			try {
				await this.#enter(undefined, false, current);
			} catch (error) {
				if (current() || !(error instanceof Error && error.name === "AbortError")) throw error;
			}
		});
		if (!current()) return { consumed: true };
		return task ? { prompt: task } : { consumed: true };
	}

	/** Re-resolve a saved plan role without replacing the pre-plan restoration snapshot. */
	async refreshModelRole(): Promise<void> {
		await this.#enqueue(async () => {
			if (this.#session.getPlanModeState()?.enabled) await this.#applyPlanModel();
		});
	}

	observe(event: AgentSessionEvent): void {
		if (event.type === "agent_end" && event.isTerminal !== false && this.#pendingModel) {
			const pending = this.#pendingModel;
			const revision = this.#modelRevision;
			this.#pendingModel = undefined;
			// Cancelling a dialog must not discard the plan role at this yield.
			const current = this.#guard();
			this.#background(async () => {
				await this.#session.waitForIdle();
				await this.#enqueue(async () => {
					if (current() && revision === this.#modelRevision && this.#session.getPlanModeState()?.enabled)
						await this.#restoreModel(pending);
				});
			});
		}
		if (
			event.type !== "tool_execution_end" ||
			event.isError ||
			this.#reviewing ||
			this.#session.isDisposed ||
			this.#session.isSessionTransitioning ||
			this.#sessionChanges > 0
		)
			return;
		const dispatch = writeDeviceDispatch(event.toolName, event.result);
		const details = dispatch?.tool === PROPOSE_DEVICE_NAME ? dispatch.inner : undefined;
		if (
			!this.#session.getPlanModeState()?.enabled ||
			!isPlanApprovalDetails(details) ||
			this.#proposal?.details !== details ||
			!this.#proposal.current()
		)
			return;
		this.#proposal = undefined;
		this.#reviewing = true;
		const operationSignal = this.#operation.signal;
		this.#background(() => this.#review(details, operationSignal));
	}

	#signal(signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, this.#operation.signal]) : this.#operation.signal;
	}

	#guard(signal?: AbortSignal): () => boolean {
		const manager = this.#session.sessionManager;
		const id = manager.getSessionId();
		const generation = this.#session.sessionGeneration;
		return () =>
			!signal?.aborted &&
			!this.#session.isDisposed &&
			this.#session.sessionManager === manager &&
			manager.getSessionId() === id &&
			this.#session.sessionGeneration === generation;
	}

	#enqueue(task: () => Promise<void>): Promise<void> {
		const next = this.#tail.then(task);
		this.#tail = next.catch(() => {});
		return next;
	}

	#background(task: () => Promise<void>, signal?: AbortSignal): void {
		const current = this.#guard(this.#signal(signal));
		const context = {
			...this.#logContext,
			...logger.getLogContext(),
			operation_id:
				logger.getLogContext().operation_id ?? this.#logContext.operation_id ?? `rpc-plan-${crypto.randomUUID()}`,
			call_id: `rpc-plan-background-${crypto.randomUUID()}`,
			session_id: rpcPlanDiagnosticId(this.#session.sessionManager.getSessionId()),
		};
		const started = performance.now();
		this.#runInBackground(() =>
			logger.withLogContext(context, async () => {
				logger.info("RPC plan background started", {
					component: "rpc-plan",
					event: "plan_background_started",
					stage: "background",
					result: "started",
				});
				let result = "cancelled";
				try {
					if (current()) {
						await task();
						result = current() ? "completed" : "cancelled";
					}
				} catch (error) {
					if (current()) {
						result = error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed";
						if (result === "failed")
							logger.error("RPC plan background failed", {
								component: "rpc-plan",
								event: "plan_background_failed",
								stage: "background",
								result,
								elapsed_ms: performance.now() - started,
								...logger.diagnosticError(error),
							});
						this.#output(`Plan operation failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				} finally {
					if (result !== "failed")
						logger.info("RPC plan background ended", {
							component: "rpc-plan",
							event: "plan_background_terminal",
							stage: "background",
							result,
							elapsed_ms: performance.now() - started,
						});
				}
			}),
		);
	}

	#read(path: string): Promise<string | null> {
		const manager = this.#session.sessionManager;
		return readPlanFile(path, {
			cwd: manager.getCwd(),
			localProtocolOptions: {
				getArtifactsDir: () => manager.getArtifactsDir(),
				getSessionId: () => manager.getSessionId(),
			},
		});
	}

	/** A model may write a slugged draft before it submits xd://propose. */
	async #findDraft(preferred: string | undefined, current: () => boolean): Promise<string | undefined> {
		const started = performance.now();
		this.#log("plan_stage_started", "draft_search", "started");
		const manager = this.#session.sessionManager;
		const candidates = new Set([
			...(preferred ? [preferred] : []),
			...(await listPlanFiles({
				localProtocolOptions: {
					getArtifactsDir: () => manager.getArtifactsDir(),
					getSessionId: () => manager.getSessionId(),
				},
			})),
		]);
		let readCount = 0;
		for (const path of candidates) {
			if (!current()) {
				this.#log("plan_stage_completed", "draft_search", "cancelled", {
					candidate_count: candidates.size,
					read_count: readCount,
					elapsed_ms: performance.now() - started,
				});
				return undefined;
			}
			readCount++;
			const content = await this.#read(path);
			if (!current()) {
				this.#log("plan_stage_completed", "draft_search", "cancelled", {
					candidate_count: candidates.size,
					read_count: readCount,
					elapsed_ms: performance.now() - started,
				});
				return undefined;
			}
			if (content?.trim()) {
				this.#log("plan_stage_completed", "draft_search", "found", {
					candidate_count: candidates.size,
					read_count: readCount,
					elapsed_ms: performance.now() - started,
				});
				return path;
			}
		}
		this.#log("plan_stage_completed", "draft_search", "missing", {
			candidate_count: candidates.size,
			read_count: readCount,
			elapsed_ms: performance.now() - started,
		});
		return undefined;
	}

	async #enter(path?: string, preserveModel = false, current: () => boolean = () => true): Promise<void> {
		const started = performance.now();
		this.#log("plan_enter_started", "enter", "started");
		const session = this.#session;
		const assertCurrent = () => {
			if (!current()) throw new DOMException("Plan mode entry cancelled.", "AbortError");
		};
		assertCurrent();
		if (!cfgPlanEnabled.get(session.settings)) throw new Error("Plan mode is disabled (plan.enabled).");
		if (session.getGoalModeState()?.goal) throw new Error("Exit goal mode first.");
		if (session.getVibeModeState()?.enabled) throw new Error("Exit vibe mode first.");
		const planFilePath = this.#lastPlanFilePath || path || session.getPlanReferencePath() || "local://PLAN.md";
		const tools = session.getEnabledToolNames();
		const mounted = session.getMountedXdevToolNames();
		const previousState = session.getPlanModeState();
		const model = session.model;
		this.#previousTools = {
			enabled: tools.filter(name => !isMCPToolName(name)),
			mounted: mounted.filter(name => !isMCPToolName(name)),
		};
		this.#previousModel = model ? { model, thinkingLevel: session.configuredThinkingLevel() } : undefined;
		session.setPlanModeState({ enabled: true, planFilePath, workflow: "parallel", reentry: this.#entered });
		try {
			await session.setActiveToolsByName([
				...new Set([...tools, ...(session.hasBuiltInTool("write") ? ["write"] : [])]),
			]);
			assertCurrent();
			if (!preserveModel) await this.#applyPlanModel();
			assertCurrent();
			session.setPlanProposalHandler(async title => {
				const current = this.#guard(this.#operation.signal);
				this.#log("plan_stage_started", "proposal_prepare", "started");
				const result = await session.preparePlanForReview(title);
				this.#log(
					"plan_proposal_prepared",
					"proposal_prepare",
					current() ? (result.details ? "ready" : "unavailable") : "cancelled",
				);
				if (current() && result.details) this.#proposal = { details: result.details, current };
				return result;
			});
			if (session.isStreaming) await session.sendPlanModeContext({ deliverAs: "steer" });
			assertCurrent();
		} catch (error) {
			this.#log("plan_rollback_started", "enter_rollback", "started", { elapsed_ms: performance.now() - started });
			session.setPlanModeState(previousState);
			await session.setActiveToolPresentation(tools, mounted);
			if (this.#previousModel) await this.#restoreModel(this.#previousModel);
			session.setPlanProposalHandler(null);
			this.#pendingModel = undefined;
			this.#previousTools = undefined;
			this.#previousModel = undefined;
			this.#log("plan_rollback_completed", "enter_rollback", "restored", {
				elapsed_ms: performance.now() - started,
			});
			this.#log("plan_enter_terminal", "enter", current() ? "failed" : "cancelled", {
				elapsed_ms: performance.now() - started,
			});
			throw error;
		}
		this.#paused = false;
		this.#entered = true;
		this.#lastPlanFilePath = planFilePath;
		session.sessionManager.appendModeChange("plan", { planFilePath });
		this.#output(`Plan mode enabled. Plan file: ${planFilePath}`);
		this.#log("plan_enter_completed", "enter", "enabled", { elapsed_ms: performance.now() - started });
	}

	async #applyPlanModel(): Promise<void> {
		this.#modelRevision++;
		const session = this.#session;
		const transition = resolvePlanModelTransition(
			session.model,
			session.resolveRoleModelWithThinking("plan"),
			session.isStreaming,
		);
		this.#pendingModel = undefined;
		if (transition.kind === "thinking") session.setThinkingLevel(transition.thinkingLevel);
		else if (transition.kind === "apply") {
			const target = { model: transition.model, thinkingLevel: transition.thinkingLevel };
			if (transition.deferred) this.#pendingModel = target;
			else await this.#restoreModel(target);
		}
	}

	async #restoreModel(previous: ModelSnapshot): Promise<void> {
		if (modelsAreEqual(this.#session.model, previous.model)) this.#session.setThinkingLevel(previous.thinkingLevel);
		else await this.#session.setModelTemporary(previous.model, previous.thinkingLevel);
	}

	async #exit(paused: boolean, journal = true, ensureRead = false): Promise<void> {
		const started = performance.now();
		this.#log("plan_exit_started", "exit", "started", { paused });
		const session = this.#session;
		const state = session.getPlanModeState();
		const tools = session.getEnabledToolNames();
		const mounted = session.getMountedXdevToolNames();
		const model = session.model;
		const currentModel = model ? { model, thinkingLevel: session.configuredThinkingLevel() } : undefined;
		session.setPlanModeState(undefined);
		try {
			if (this.#previousTools) {
				// Approved execution keeps the durable plan readable, as in the TUI approval flow.
				const enabled = this.#previousTools.enabled;
				const executionTools = ensureRead && !enabled.includes("read") ? [...enabled, "read"] : enabled;
				await session.restoreNonMCPToolPresentation(executionTools, this.#previousTools.mounted);
			}
			if (this.#previousModel) await this.#restoreModel(this.#previousModel);
		} catch (error) {
			this.#log("plan_rollback_started", "exit_rollback", "started", { elapsed_ms: performance.now() - started });
			session.setPlanModeState(state);
			await session.setActiveToolPresentation(tools, mounted);
			if (currentModel) await this.#restoreModel(currentModel);
			this.#log("plan_rollback_completed", "exit_rollback", "restored", { elapsed_ms: performance.now() - started });
			this.#log("plan_exit_terminal", "exit", "failed", { elapsed_ms: performance.now() - started });
			throw error;
		}
		this.#pendingModel = undefined;
		this.#modelRevision++;
		this.#previousTools = undefined;
		this.#previousModel = undefined;
		session.setPlanProposalHandler(null);
		this.#paused = paused;
		if (journal) {
			session.sessionManager.appendModeChange(paused ? "plan_paused" : "none");
			this.#output(paused ? "Plan mode paused." : "Plan mode disabled.");
		}
		this.#log("plan_exit_completed", "exit", paused ? "paused" : "disabled", {
			elapsed_ms: performance.now() - started,
		});
	}

	async #review(details: PlanApprovalDetails, signal: AbortSignal): Promise<void> {
		const current = this.#guard(signal);
		const started = performance.now();
		let stage = "proposal_abort";
		let result = "cancelled";
		this.#log("plan_review_started", stage, "started");
		try {
			// This runs after the proposal tool returned, so abort cannot wait on its own handler.
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
			if (!current()) return;
			this.#session.markPlanInternalAbortPending();
			try {
				await this.#session.abort();
			} finally {
				this.#session.clearPlanInternalAbortPending();
			}
			if (!current()) return;
			stage = "proposal_read";
			this.#log("plan_stage_started", stage, "started");
			const content = await this.#read(details.planFilePath);
			this.#log("plan_stage_completed", stage, content?.trim() ? "read" : "missing");
			if (!current()) return;
			if (!content?.trim()) throw new Error(`Plan file not found at ${details.planFilePath}`);
			const state = this.#session.getPlanModeState();
			if (!state?.enabled) return;
			this.#session.setPlanModeState({ ...state, planFilePath: details.planFilePath });
			this.#lastPlanFilePath = details.planFilePath;
			this.#session.sessionManager.appendModeChange("plan", { planFilePath: details.planFilePath });
			this.#output(content);
			stage = "approval";
			this.#log("plan_stage_started", stage, "started");
			const approved = await this.#ui.confirm(
				"Approve plan?",
				`Execute ${details.title} while keeping the current context?`,
				{ signal },
			);
			result = current() ? (approved ? "approved" : "rejected") : "cancelled";
			this.#log("plan_stage_completed", stage, result);
			if (!current() || !approved) return;
			await this.#enqueue(async () => {
				result = "cancelled";
				if (!current() || !this.#session.getPlanModeState()?.enabled) return;
				await this.#exit(false, true, true);
			});
			if (!current()) return;
			result = "cancelled";
			stage = "dispatch";
			this.#log("plan_stage_started", stage, "started");
			await dispatchApprovedPlan(this.#session as AgentSession, {
				...details,
				planContent: content,
				preserveContext: true,
				signal,
				beforeDispatch: () => {
					if (!current()) throw new Error("Plan approval cancelled.");
					this.#reviewing = false;
				},
				onAutosave: ({ savedPath, error }) => {
					if (current()) {
						if (error)
							logger.warn("RPC plan autosave failed", {
								component: "rpc-plan",
								event: "plan_autosave_failed",
								stage: "autosave",
								result: "failed",
								...logger.diagnosticError(error),
							});
						else this.#log("plan_autosave_completed", "autosave", savedPath ? "saved" : "not_saved");
					}
					if (!current()) return;
					if (savedPath) this.#output(`Saved plan to ${savedPath}.`);
					else if (error) this.#output(`Failed to autosave plan: ${error.message}`);
				},
			});
			result = current() ? "dispatched" : "cancelled";
		} catch (error) {
			// The background boundary owns error classification; this supplies its failing stage.
			result = current() ? "failed" : "cancelled";
			throw error;
		} finally {
			this.#log("plan_review_terminal", stage, result, { elapsed_ms: performance.now() - started });
			if (signal === this.#operation.signal) {
				this.#reviewing = false;
				if (result === "rejected" && current()) this.#onReviewRejected?.();
			}
		}
	}
}

function isPlanApprovalDetails(value: unknown): value is PlanApprovalDetails {
	return (
		typeof value === "object" &&
		value !== null &&
		"planFilePath" in value &&
		typeof value.planFilePath === "string" &&
		"title" in value &&
		typeof value.title === "string" &&
		"planExists" in value &&
		typeof value.planExists === "boolean"
	);
}
