import { escapeXmlText, logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import goalBudgetLimitPrompt from "../prompts/goals/goal-budget-limit.md" with { type: "text" };
import goalContinuationPrompt from "../prompts/goals/goal-continuation.md" with { type: "text" };
import goalModeActivePrompt from "../prompts/goals/goal-mode-active.md" with { type: "text" };
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { GoalBudgetSteering, GoalModeState, GoalRuntimeEvent, GoalTokenUsage } from "./state";

export interface GoalRuntimeHost {
	getState(): GoalModeState | undefined;
	setState(state: GoalModeState | undefined): void;
	getCurrentUsage(): GoalTokenUsage;
	emit(event: GoalRuntimeEvent): void | Promise<void>;
	persist(mode: "goal" | "goal_paused" | "none", state?: GoalModeState): void;
	sendHiddenMessage(message: {
		customType: string;
		content: string;
		deliverAs?: "steer" | "followUp" | "nextTurn";
	}): Promise<void>;
	now?(): number;
}

export interface GoalTurnSnapshot {
	turnId: string;
	baselineUsage: GoalTokenUsage;
	activeGoalId?: string;
}

export interface GoalWallClockSnapshot {
	lastAccountedAt: number;
	activeGoalId?: string;
}

export interface GoalRuntimeSnapshot {
	turnSnapshot?: GoalTurnSnapshot;
	wallClock: GoalWallClockSnapshot;
	budgetReportedFor?: string;
}

export type GoalPromptKind = "active" | "continuation" | "budget-limit";

function cloneGoal(goal: Goal): Goal {
	return { ...goal };
}

function cloneState(state: GoalModeState): GoalModeState {
	return { ...state, goal: cloneGoal(state.goal) };
}

function budgetValue(goal: Goal): string {
	return goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget);
}

function remainingValue(goal: Goal): string {
	return goal.tokenBudget === undefined ? "unbounded" : String(Math.max(0, goal.tokenBudget - goal.tokensUsed));
}

export function remainingTokens(goal: Goal | null | undefined): number | null {
	if (!goal || goal.tokenBudget === undefined) return null;
	return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

export function renderTrustedObjective(objective: string): string {
	return `<objective>\n${escapeXmlText(objective)}\n</objective>`;
}

export function goalTokenDelta(current: GoalTokenUsage, baseline: GoalTokenUsage): number {
	// Diverges from codex-rs: codex omits cache creation because its target providers
	// do not bill cache writes distinctly through the token-usage stream. Pi receives
	// cacheWrite separately on Anthropic/Bedrock; rotating a 1h ephemeral cache or
	// re-anchoring a changed system prompt can write 100K+ tokens, which the goal
	// budget must account for. cacheRead is excluded because it is reused prefix,
	// not new work consumed by the goal.
	return (
		Math.max(0, current.input - baseline.input) +
		Math.max(0, current.cacheWrite - baseline.cacheWrite) +
		Math.max(0, current.output - baseline.output)
	);
}

export function renderGoalPrompt(kind: GoalPromptKind, goal: Goal): string {
	const template =
		kind === "active"
			? goalModeActivePrompt
			: kind === "continuation"
				? goalContinuationPrompt
				: goalBudgetLimitPrompt;
	return prompt.render(template, {
		objective: escapeXmlText(goal.objective),
		tokensUsed: String(goal.tokensUsed),
		tokenBudget: budgetValue(goal),
		remainingTokens: remainingValue(goal),
		timeUsedSeconds: String(goal.timeUsedSeconds),
	});
}

export function completionBudgetReport(goal: Goal): string | null {
	const parts: string[] = [];
	if (goal.tokenBudget !== undefined) {
		parts.push(`tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}`);
	}
	if (goal.timeUsedSeconds > 0) {
		parts.push(`time used: ${goal.timeUsedSeconds} seconds`);
	}
	if (parts.length === 0) return null;
	return `Goal achieved. Report final budget usage to the user: ${parts.join("; ")}.`;
}

function validateTokenBudget(tokenBudget: number | undefined): void {
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new Error("goal token_budget must be a positive integer when provided");
	}
}

function isAccountingStatus(goal: Goal): boolean {
	return goal.status === "active" || goal.status === "budget-limited";
}

export class GoalRuntime {
	readonly #host: GoalRuntimeHost;
	#turnSnapshot: GoalTurnSnapshot | undefined;
	#wallClock: GoalWallClockSnapshot;
	#budgetReportedFor: string | undefined;
	#accountingTail: Promise<void> = Promise.resolve();

	constructor(host: GoalRuntimeHost) {
		this.#host = host;
		this.#wallClock = { lastAccountedAt: this.#now() };
	}

	get snapshot(): GoalRuntimeSnapshot {
		return {
			turnSnapshot: this.#turnSnapshot
				? { ...this.#turnSnapshot, baselineUsage: { ...this.#turnSnapshot.baselineUsage } }
				: undefined,
			wallClock: { ...this.#wallClock },
			budgetReportedFor: this.#budgetReportedFor,
		};
	}

	#now(): number {
		return this.#host.now?.() ?? Date.now();
	}

	#hasAccountingState(): boolean {
		const state = this.#host.getState();
		return Boolean(state?.enabled && isAccountingStatus(state.goal));
	}

	async #withAccounting<T>(fn: () => Promise<T> | T): Promise<T> {
		const previous = this.#accountingTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#accountingTail = previous.then(
			() => promise,
			() => promise,
		);
		await previous.catch(() => {});
		try {
			return await logger.withLogContext(
				{
					operation_id: logger.getLogContext().operation_id ?? `goal-${crypto.randomUUID()}`,
					goal_id: this.#host.getState()?.goal.id,
					turn_id: this.#turnSnapshot?.turnId,
				},
				fn,
			);
		} finally {
			resolve();
		}
	}

	#getStateClone(): GoalModeState | undefined {
		const state = this.#host.getState();
		return state ? cloneState(state) : undefined;
	}

	async #commitState(
		state: GoalModeState | undefined,
		options?: { persist?: "goal" | "goal_paused" | "none"; emit?: boolean; transition?: string },
	): Promise<void> {
		const previous = this.#host.getState();
		const startedAt = performance.now();
		const fields = {
			component: "goal.runtime",
			event: "goal_state_transition",
			operation_id: logger.getLogContext().operation_id ?? `goal-${crypto.randomUUID()}`,
			goal_id: state?.goal.id ?? previous?.goal.id,
			previous_goal_id: previous?.goal.id,
			transition: options?.transition ?? "usage",
			previous_status: previous?.goal.status ?? "none",
			previous_mode: previous?.mode ?? "none",
			previous_enabled: previous?.enabled === true,
			previous_auto_orchestrate: previous?.autoOrchestrate === true,
			status: state?.goal.status ?? "none",
			mode: state?.mode ?? "none",
			enabled: state?.enabled ?? false,
			auto_orchestrate: state?.autoOrchestrate === true,
			token_budget: state?.goal.tokenBudget ?? null,
			tokens_used: state?.goal.tokensUsed ?? 0,
			tokens_remaining: remainingTokens(state?.goal),
			budget_reached: state?.goal.status === "budget-limited",
			time_used_seconds: state?.goal.timeUsedSeconds ?? 0,
			persist_mode: options?.persist ?? "memory",
		};
		let stage = "set_state";
		logger.info("Goal state transition started", { ...fields, stage, result: "started" });
		try {
			this.#host.setState(state ? cloneState(state) : undefined);
			if (options?.persist) {
				stage = "persist";
				this.#host.persist(options.persist, state);
			}
			if (options?.emit !== false) {
				stage = "emit";
				await this.#host.emit({ type: "goal_updated", goal: state ? cloneGoal(state.goal) : null, state });
			}
			logger.info("Goal state transition completed", {
				...fields,
				stage: "completed",
				result: "completed",
				elapsed_ms: performance.now() - startedAt,
			});
		} catch (error) {
			logger.error("Goal state transition failed", {
				...fields,
				stage,
				result: "failed",
				elapsed_ms: performance.now() - startedAt,
				...logger.diagnosticError(error),
			});
			throw error;
		}
	}

	#markActiveAccounting(goal: Goal, resetWallClock = false): void {
		if (resetWallClock || this.#wallClock.activeGoalId !== goal.id) {
			this.#wallClock = { lastAccountedAt: this.#now(), activeGoalId: goal.id };
		}
		if (this.#turnSnapshot) {
			this.#turnSnapshot.activeGoalId = goal.id;
			this.#turnSnapshot.baselineUsage = { ...this.#host.getCurrentUsage() };
		}
	}

	#clearActiveAccounting(): void {
		this.#wallClock = { lastAccountedAt: this.#now() };
		if (this.#turnSnapshot) {
			this.#turnSnapshot.activeGoalId = undefined;
		}
	}

	clearAccounting(): void {
		this.#turnSnapshot = undefined;
		this.#clearActiveAccounting();
		this.#budgetReportedFor = undefined;
	}

	onTurnStart(turnId: string, baselineUsage: GoalTokenUsage): void {
		this.#turnSnapshot = { turnId, baselineUsage: { ...baselineUsage } };
		const state = this.#host.getState();
		if (state?.enabled && isAccountingStatus(state.goal)) {
			this.#turnSnapshot.activeGoalId = state.goal.id;
			if (this.#wallClock.activeGoalId !== state.goal.id) {
				this.#wallClock = { lastAccountedAt: this.#now(), activeGoalId: state.goal.id };
			}
		}
	}

	async onToolCompleted(toolName: string): Promise<void> {
		if (toolName === "goal") return;
		if (!this.#hasAccountingState()) return;
		await this.flushUsage("allowed");
	}

	async onGoalToolCompleted(): Promise<void> {
		if (!this.#hasAccountingState()) return;
		await this.flushUsage("suppressed");
	}

	/**
	 * `currentUsage` may be a thunk: it is read synchronously (before any await)
	 * only when goal accounting is active, so idle sessions skip the usage walk.
	 */
	async onAgentEnd(options?: {
		turnCompleted?: boolean;
		currentUsage?: GoalTokenUsage | (() => GoalTokenUsage);
	}): Promise<void> {
		if (!this.#hasAccountingState()) {
			this.#turnSnapshot = undefined;
			return;
		}
		const currentUsage = options?.currentUsage;
		await this.flushUsage("suppressed", typeof currentUsage === "function" ? currentUsage() : currentUsage);
		this.#turnSnapshot = undefined;
	}

	async onTaskAborted(options?: { reason?: "interrupted" | "internal" }): Promise<void> {
		const state = this.#host.getState();
		const needsAccounting = state?.enabled && isAccountingStatus(state.goal);
		const needsPause = options?.reason === "interrupted" && state?.enabled && state.goal.status === "active";
		if (state)
			logger.info("Goal task aborted", {
				component: "goal.runtime",
				event: "goal_task_aborted",
				stage: "abort",
				result: "cancelled",
				goal_id: state.goal.id,
				turn_id: this.#turnSnapshot?.turnId,
				reason: options?.reason ?? "unspecified",
				pause_required: Boolean(needsPause),
				auto_orchestrate: state.autoOrchestrate === true,
			});
		if (!needsAccounting && !needsPause) {
			this.#turnSnapshot = undefined;
			return;
		}
		await this.#withAccounting(async () => {
			await this.#flushUsageLocked("suppressed", undefined, options?.reason === "internal");
			this.#turnSnapshot = undefined;
			if (options?.reason !== "interrupted") return;
			const cloned = this.#getStateClone();
			if (!cloned?.enabled || cloned.goal.status !== "active") return;
			cloned.enabled = false;
			cloned.goal.status = "paused";
			cloned.goal.updatedAt = this.#now();
			this.#clearActiveAccounting();
			this.#budgetReportedFor = undefined;
			await this.#commitState(cloned, { persist: "goal_paused", transition: "abort" });
		});
	}

	async onThreadResumed(options?: { preserveActiveGoal?: boolean }): Promise<GoalModeState | undefined> {
		const state = this.#getStateClone();
		if (!state) return undefined;
		if (options?.preserveActiveGoal && state.enabled && state.goal.status === "active") {
			this.#markActiveAccounting(state.goal, true);
			await this.#commitState(state, { emit: true, transition: "restore_preserved" });
			return state;
		}
		if (state.goal.status === "active") {
			state.enabled = false;
			state.goal.status = "paused";
			state.goal.updatedAt = this.#now();
			this.#clearActiveAccounting();
			this.#budgetReportedFor = undefined;
			await this.#commitState(state, { persist: "goal_paused", transition: "restore_paused" });
			return state;
		}
		if (state.enabled && isAccountingStatus(state.goal)) {
			this.#markActiveAccounting(state.goal);
		} else {
			this.#clearActiveAccounting();
		}
		await this.#commitState(state, { emit: true, transition: "restore" });
		return state;
	}

	async onBudgetMutated(newBudget: number | undefined): Promise<GoalModeState | undefined> {
		validateTokenBudget(newBudget);
		return await this.#withAccounting(async () => {
			this.#budgetReportedFor = undefined;
			await this.#flushUsageLocked("suppressed");
			const state = this.#getStateClone();
			if (!state?.goal) return undefined;
			state.goal.tokenBudget = newBudget;
			state.goal.updatedAt = this.#now();
			let shouldSteer = false;
			if (newBudget !== undefined && state.goal.tokensUsed >= newBudget) {
				if (state.goal.status === "active") {
					state.goal.status = "budget-limited";
					shouldSteer = true;
				}
			} else if (state.goal.status === "budget-limited") {
				state.goal.status = "active";
				state.enabled = true;
				this.#markActiveAccounting(state.goal);
			}
			await this.#commitState(state, {
				persist: state.enabled ? "goal" : "goal_paused",
				transition: "budget_mutated",
			});
			if (shouldSteer) {
				await this.#sendBudgetLimitSteer(state.goal);
			}
			return state;
		});
	}

	/** `currentUsage` defaults to the host's live totals, read only once a token delta is needed. */
	async #flushUsageLocked(
		steering: GoalBudgetSteering,
		currentUsage?: GoalTokenUsage,
		persistWallClock = false,
	): Promise<void> {
		const state = this.#getStateClone();
		if (!state?.enabled || !isAccountingStatus(state.goal)) return;
		if (this.#turnSnapshot?.activeGoalId !== state.goal.id && this.#wallClock.activeGoalId !== state.goal.id) return;

		let usage: GoalTokenUsage | undefined;
		let tokenDelta = 0;
		if (this.#turnSnapshot?.activeGoalId === state.goal.id) {
			usage = currentUsage ?? this.#host.getCurrentUsage();
			tokenDelta = goalTokenDelta(usage, this.#turnSnapshot.baselineUsage);
		}
		const wallSeconds =
			this.#wallClock.activeGoalId === state.goal.id
				? Math.max(0, Math.floor((this.#now() - this.#wallClock.lastAccountedAt) / 1000))
				: 0;
		if (tokenDelta <= 0 && wallSeconds <= 0) return;

		state.goal.tokensUsed += tokenDelta;
		state.goal.timeUsedSeconds += wallSeconds;
		state.goal.updatedAt = this.#now();
		const flippedToBudgetLimited =
			state.goal.tokenBudget !== undefined &&
			state.goal.tokensUsed >= state.goal.tokenBudget &&
			state.goal.status === "active";
		if (flippedToBudgetLimited) {
			state.goal.status = "budget-limited";
		}

		if (usage && this.#turnSnapshot?.activeGoalId === state.goal.id) {
			this.#turnSnapshot.baselineUsage = { ...usage };
		}
		if (this.#wallClock.activeGoalId === state.goal.id && wallSeconds > 0) {
			this.#wallClock.lastAccountedAt += wallSeconds * 1000;
		}
		// Persisting wall-clock-only accounting on every tool event bloats /goal sessions with full
		// objective snapshots. Keep normal tool flushes in memory/UI only, but make wall-clock
		// usage durable before internal session switches because the active runtime is leaving.
		const shouldPersistUsage = tokenDelta > 0 || flippedToBudgetLimited || (persistWallClock && wallSeconds > 0);
		await this.#commitState(state, { persist: shouldPersistUsage ? "goal" : undefined });
		logger.info("Goal usage accounted", {
			component: "goal.runtime",
			event: "goal_usage_accounted",
			stage: "budget",
			result: "completed",
			goal_id: state.goal.id,
			turn_id: this.#turnSnapshot?.turnId,
			auto_orchestrate: state.autoOrchestrate === true,
			token_delta: tokenDelta,
			time_delta_seconds: wallSeconds,
			tokens_used: state.goal.tokensUsed,
			time_used_seconds: state.goal.timeUsedSeconds,
			token_budget: state.goal.tokenBudget ?? null,
			tokens_remaining: remainingTokens(state.goal),
			budget_reached: flippedToBudgetLimited,
			persisted: shouldPersistUsage,
		});
		if (flippedToBudgetLimited && steering !== "allowed") {
			logger.info("Goal budget steer suppressed", {
				component: "goal.runtime",
				event: "goal_budget_steer",
				stage: "steer",
				result: "suppressed",
				goal_id: state.goal.id,
				reason: "accounting_boundary",
			});
		}

		if (state.goal.status !== "budget-limited") {
			this.#budgetReportedFor = undefined;
		}
		if (steering === "allowed" && flippedToBudgetLimited && this.#budgetReportedFor !== state.goal.id) {
			await this.#sendBudgetLimitSteer(state.goal);
		}
	}

	async flushUsage(steering: GoalBudgetSteering, currentUsage?: GoalTokenUsage): Promise<void> {
		await this.#withAccounting(() => this.#flushUsageLocked(steering, currentUsage));
	}

	#createGoalState(objective: string, tokenBudget: number | undefined, autoOrchestrate?: boolean): GoalModeState {
		const now = this.#now();
		const goal: Goal = {
			id: String(Snowflake.next()),
			objective,
			status: "active",
			tokenBudget,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		};
		return { enabled: true, mode: "active", autoOrchestrate: autoOrchestrate === true ? true : undefined, goal };
	}

	async createGoal(input: {
		objective: string;
		tokenBudget?: number;
		autoOrchestrate?: boolean;
	}): Promise<GoalModeState> {
		const objective = input.objective.trim();
		if (!objective) throw new Error("objective is required when op=create");
		validateTokenBudget(input.tokenBudget);
		return await this.#withAccounting(async () => {
			const existing = this.#host.getState();
			if (existing?.goal && existing.goal.status !== "dropped" && existing.goal.status !== "complete") {
				throw new Error("cannot create a new goal because this session already has a goal");
			}
			const state = this.#createGoalState(objective, input.tokenBudget, input.autoOrchestrate);
			this.#budgetReportedFor = undefined;
			this.#markActiveAccounting(state.goal);
			await this.#commitState(state, { persist: "goal", transition: "create" });
			return state;
		});
	}

	async replaceGoal(input: {
		objective: string;
		tokenBudget?: number;
		autoOrchestrate?: boolean;
	}): Promise<GoalModeState> {
		const objective = input.objective.trim();
		if (!objective) throw new Error("objective is required when op=replace");
		validateTokenBudget(input.tokenBudget);
		return await this.#withAccounting(async () => {
			const existing = this.#host.getState();
			if (!existing?.enabled || !isAccountingStatus(existing.goal)) {
				throw new Error("cannot replace goal because no goal is active");
			}
			await this.#flushUsageLocked("suppressed");
			const state = this.#createGoalState(objective, input.tokenBudget, input.autoOrchestrate);
			this.#budgetReportedFor = undefined;
			this.#markActiveAccounting(state.goal);
			await this.#commitState(state, { persist: "goal", transition: "replace" });
			return state;
		});
	}

	async resumeGoal(): Promise<GoalModeState> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.goal) throw new Error("No paused goal.");
			if (state.goal.status === "complete") throw new Error("Goal is already complete.");
			state.enabled = true;
			state.mode = "active";
			state.reason = undefined;
			state.goal.status = "active";
			state.goal.updatedAt = this.#now();
			this.#budgetReportedFor = undefined;
			this.#markActiveAccounting(state.goal);
			await this.#commitState(state, { persist: "goal", transition: "resume" });
			return state;
		});
	}

	async pauseGoal(): Promise<GoalModeState | undefined> {
		return await this.#withAccounting(async () => {
			await this.#flushUsageLocked("suppressed");
			const state = this.#getStateClone();
			if (!state?.goal) return undefined;
			state.enabled = false;
			state.mode = "active";
			state.reason = undefined;
			if (state.goal.status === "active" || state.goal.status === "budget-limited") {
				state.goal.status = "paused";
			}
			state.goal.updatedAt = this.#now();
			this.#clearActiveAccounting();
			this.#budgetReportedFor = undefined;
			await this.#commitState(state, { persist: "goal_paused", transition: "pause" });
			return state;
		});
	}

	async dropGoal(): Promise<Goal | undefined> {
		return await this.#withAccounting(async () => {
			await this.#flushUsageLocked("suppressed");
			const state = this.#getStateClone();
			if (!state?.goal) return undefined;
			const dropped = { ...state.goal, status: "dropped" as const, updatedAt: this.#now() };
			this.#clearActiveAccounting();
			this.#budgetReportedFor = undefined;
			const startedAt = performance.now();
			const fields = {
				component: "goal.runtime",
				event: "goal_drop_emit",
				stage: "emit",
				operation_id: logger.getLogContext().operation_id ?? `goal-${crypto.randomUUID()}`,
				goal_id: dropped.id,
				auto_orchestrate: state.autoOrchestrate === true,
			};
			logger.info("Goal drop notification started", { ...fields, result: "started" });
			try {
				await this.#host.emit({
					type: "goal_updated",
					goal: dropped,
					state: { ...state, enabled: false, goal: dropped },
				});
				logger.info("Goal drop notification completed", {
					...fields,
					result: "completed",
					elapsed_ms: performance.now() - startedAt,
				});
			} catch (error) {
				logger.error("Goal drop notification failed", {
					...fields,
					result: "failed",
					elapsed_ms: performance.now() - startedAt,
					...logger.diagnosticError(error),
				});
				throw error;
			}
			await this.#commitState(undefined, { persist: "none", emit: false, transition: "drop" });
			return dropped;
		});
	}

	async completeGoalFromTool(): Promise<Goal> {
		return await this.#withAccounting(async () => {
			await this.#flushUsageLocked("suppressed");
			const state = this.#getStateClone();
			if (!state?.goal) {
				throw new Error("cannot complete goal because no goal is active");
			}
			if (state.goal.status === "complete") {
				throw new Error("goal is already complete");
			}
			if (state.goal.status === "dropped") {
				throw new Error("cannot complete a dropped goal");
			}
			state.enabled = false;
			state.goal.status = "complete";
			state.goal.updatedAt = this.#now();
			state.mode = "exiting";
			state.reason = "completed";
			this.#clearActiveAccounting();
			this.#budgetReportedFor = undefined;
			await this.#commitState(state, { persist: "goal", transition: "complete" });
			return state.goal;
		});
	}

	buildActivePrompt(): string | undefined {
		const state = this.#host.getState();
		return state?.enabled && state.goal && state.goal.status === "active"
			? renderGoalPrompt("active", state.goal)
			: undefined;
	}

	buildContinuationPrompt(): string | undefined {
		const state = this.#host.getState();
		return state?.enabled && state.goal.status === "active"
			? renderGoalPrompt("continuation", state.goal)
			: undefined;
	}

	async #sendBudgetLimitSteer(goal: Goal): Promise<void> {
		const startedAt = performance.now();
		const fields = {
			component: "goal.runtime",
			event: "goal_budget_steer",
			stage: "steer",
			operation_id: logger.getLogContext().operation_id ?? `goal-${crypto.randomUUID()}`,
			goal_id: goal.id,
			token_budget: goal.tokenBudget ?? null,
			tokens_used: goal.tokensUsed,
			tokens_remaining: remainingTokens(goal),
		};
		if (this.#budgetReportedFor === goal.id) {
			logger.info("Goal budget steer suppressed", { ...fields, result: "suppressed", reason: "already_reported" });
			return;
		}
		this.#budgetReportedFor = goal.id;
		logger.info("Goal budget steer started", { ...fields, result: "started" });
		try {
			await this.#host.sendHiddenMessage({
				customType: "goal-budget-limit",
				content: renderGoalPrompt("budget-limit", goal),
				deliverAs: "steer",
			});
			logger.info("Goal budget steer sent", {
				...fields,
				result: "sent",
				elapsed_ms: performance.now() - startedAt,
			});
		} catch (error) {
			logger.error("Goal budget steer failed", {
				...fields,
				result: "failed",
				elapsed_ms: performance.now() - startedAt,
				...logger.diagnosticError(error),
			});
			throw error;
		}
	}
}
