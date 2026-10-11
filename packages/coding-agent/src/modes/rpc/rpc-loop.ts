import { createHash } from "node:crypto";
import type { LoopConditionConfig, LoopLimitRuntime } from "@oh-my-pi/pi-tui/status-line/loop";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { SlashCommandResult } from "../../slash-commands/types";
import { describeLoopCondition, evaluateLoopCondition } from "../loop-condition";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	isLoopDurationExpired,
	isLoopLimitExhausted,
	parseLoopArgs,
} from "../loop-limit";
import { cfgLoopConditionTimeoutMs, cfgLoopMode } from "../settings";

function rpcLoopDiagnosticId(value: string): string {
	return /^[A-Za-z0-9_-]{1,96}$/.test(value) ? value : createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export interface RpcLoopOptions {
	output(text: string): void;
	/** Re-enter the host pipeline; recheck current at admission after any input-gate wait. */
	submit(text: string, current: () => boolean): Promise<void>;
	/** Use the host's session-change hooks, preserving this loop for its own reset. */
	reset(current: () => boolean): Promise<boolean | void>;
	onContinuationDropped(): void;
	/** A plan approval or another host-owned operation may hold automatic turns. */
	continuationAllowed?(): boolean;
}

/** RPC host scheduling for the shared /loop parser, limits, and condition runner. */
export class RpcLoopController {
	readonly #session: AgentSession;
	readonly #options: RpcLoopOptions;
	#enabled = false;
	#paused = false;
	#prompt: string | undefined;
	#limit: LoopLimitRuntime | undefined;
	#condition: LoopConditionConfig | undefined;
	#transcriptId: string | undefined;
	#timer: Timer | undefined;
	#conditionAbort: AbortController | undefined;
	#scheduled = false;
	#generation = 0;
	#logContext: Record<string, unknown> = {};
	#iteration = 0;

	constructor(session: AgentSession, options: RpcLoopOptions) {
		this.#session = session;
		this.#options = options;
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	get continuationPending(): boolean {
		return this.#scheduled;
	}

	async handle(args = ""): Promise<SlashCommandResult> {
		if (this.#enabled) {
			this.clear();
			this.#options.output("Loop mode disabled.");
			return;
		}
		const parsed = parseLoopArgs(args);
		if (typeof parsed === "string") throw new Error(parsed);
		this.#enabled = true;
		this.#paused = false;
		this.#prompt = undefined;
		this.#limit = createLoopLimitRuntime(parsed.limit);
		this.#condition = parsed.condition;
		this.#transcriptId = this.#session.sessionManager.getSessionId();
		this.#logContext = {
			...logger.getLogContext(),
			operation_id: logger.getLogContext().operation_id ?? `rpc-loop-${crypto.randomUUID()}`,
			session_id: rpcLoopDiagnosticId(this.#transcriptId),
		};
		this.#iteration = 0;
		logger.info("RPC loop enabled", {
			...this.#logContext,
			component: "rpc-loop",
			event: "loop_enabled",
			stage: "configure",
			result: "enabled",
			generation: this.#generation,
			condition_present: !!parsed.condition,
			limit_present: !!parsed.limit,
		});
		const limit = parsed.limit ? ` Limited to ${describeLoopLimit(parsed.limit)}.` : "";
		const condition = parsed.condition ? ` Continuing ${describeLoopCondition(parsed.condition)}.` : "";
		this.#options.output(
			`Loop mode enabled.${limit}${condition} ${parsed.prompt ? "Repeating it after each turn." : "Your next prompt will repeat after each turn."} Stop pauses the loop; /loop again disables it.`,
		);
		return parsed.prompt ? { prompt: parsed.prompt } : undefined;
	}

	/** Only manual model input belongs here; preserve /skill: text before expansion. */
	capturePrompt(text: string): void {
		if (!this.#enabled) return;
		this.cancel();
		this.#prompt = text;
		this.#paused = false;
		this.#transcriptId = this.#session.sessionManager.getSessionId();
		this.#logContext = {
			...logger.getLogContext(),
			operation_id: logger.getLogContext().operation_id ?? `rpc-loop-${crypto.randomUUID()}`,
			session_id: rpcLoopDiagnosticId(this.#transcriptId),
		};
	}

	observe(event: AgentSessionEvent): void {
		if (event.type === "agent_end" && event.isTerminal !== false) this.#schedule();
	}

	/** Cancel pending work while preserving the captured prompt and mode. */
	cancel(): void {
		if (this.#scheduled)
			logger.info("RPC loop pending continuation cancelled", {
				...this.#logContext,
				component: "rpc-loop",
				event: "loop_cancelled",
				stage: "schedule",
				result: "cancelled",
				generation: this.#generation,
			});
		this.#generation++;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#conditionAbort?.abort();
		this.#conditionAbort = undefined;
		const pending = this.#scheduled;
		this.#scheduled = false;
		if (pending) this.#options.onContinuationDropped();
	}

	/** A host abort keeps loop enabled; the next manual prompt resumes it. */
	pause(): void {
		this.#paused = true;
		this.#prompt = undefined;
		this.cancel();
	}

	/** External session changes and EOF discard every part of the old loop. */
	clear(): void {
		this.#enabled = false;
		this.#paused = false;
		this.#prompt = undefined;
		this.#limit = undefined;
		this.#condition = undefined;
		this.#transcriptId = undefined;
		this.cancel();
	}

	#current(generation: number, prompt: string): boolean {
		return (
			generation === this.#generation &&
			this.#enabled &&
			!this.#paused &&
			this.#prompt === prompt &&
			!this.#session.isDisposed &&
			this.#options.continuationAllowed?.() !== false &&
			this.#transcriptId === this.#session.sessionManager.getSessionId()
		);
	}

	#idle(): boolean {
		const session = this.#session;
		return (
			!session.isStreaming &&
			!session.isCompacting &&
			!session.hasPostPromptWork &&
			!session.hasAdmittedSubmission &&
			session.queuedMessageCount === 0 &&
			!session.isSessionTransitioning
		);
	}

	#schedule(): void {
		const prompt = this.#prompt;
		if (
			this.#scheduled ||
			!this.#enabled ||
			this.#paused ||
			!prompt ||
			this.#session.isDisposed ||
			this.#options.continuationAllowed?.() === false
		) {
			return;
		}
		this.#scheduled = true;
		const generation = ++this.#generation;
		// Match the TUI's interrupt window between repeated submissions.
		logger.info("RPC loop iteration scheduled", {
			...this.#logContext,
			component: "rpc-loop",
			event: "loop_iteration_scheduled",
			stage: "interrupt_wait",
			result: "scheduled",
			generation,
			wait_ms: 800,
		});
		this.#timer = logger.withLogContext(
			{
				...this.#logContext,
				call_id: `rpc-loop-iteration-${crypto.randomUUID()}`,
				generation,
				iteration: ++this.#iteration,
			},
			() =>
				setTimeout(() => {
					this.#timer = undefined;
					void this.#iterate(generation, prompt).catch(error => {
						if (this.#current(generation, prompt)) this.#disable(`Loop failed: ${String(error)}`);
					});
				}, 800),
		);
	}

	#disable(message: string): void {
		this.clear();
		this.#options.output(message);
	}

	async #waitUntilIdle(generation: number, prompt: string): Promise<boolean> {
		while (this.#current(generation, prompt)) {
			await this.#session.waitForIdle();
			if (!this.#current(generation, prompt)) return false;
			if (this.#idle()) return true;
			// Maintenance and post-prompt work can outlive the agent's idle promise.
			await Bun.sleep(800);
		}
		return false;
	}

	async #iterate(generation: number, prompt: string): Promise<void> {
		const started = performance.now();
		let stage = "idle_wait";
		let result = "cancelled";
		const fields = () => ({
			component: "rpc-loop",
			generation,
			stage,
			session_id: rpcLoopDiagnosticId(this.#session.sessionManager.getSessionId()),
			elapsed_ms: performance.now() - started,
		});
		logger.info("RPC loop iteration started", { ...fields(), event: "loop_iteration_started", result: "started" });
		try {
			if (!(await this.#waitUntilIdle(generation, prompt))) return;
			logger.info("RPC loop idle wait completed", { ...fields(), event: "loop_stage_completed", result: "idle" });
			stage = "limit";
			if (isLoopLimitExhausted(this.#limit)) {
				result = "limit_reached";
				this.#disable("Loop limit reached. Loop mode disabled.");
				return;
			}
			const action = cfgLoopMode.get(this.#session.settings);
			if (action === "reset" && this.#session.getVibeModeState()?.enabled) {
				result = "vibe_mode_gate";
				this.#disable("Exit vibe mode before using reset loops. Loop mode disabled.");
				return;
			}
			if (this.#condition) {
				stage = "condition";
				const conditionStarted = performance.now();
				logger.info("RPC loop condition started", {
					...fields(),
					event: "loop_stage_started",
					result: "started",
					timeout_ms: cfgLoopConditionTimeoutMs.get(this.#session.settings),
				});
				const controller = new AbortController();
				this.#conditionAbort = controller;
				const verdict = await evaluateLoopCondition(this.#condition, {
					cwd: this.#session.sessionManager.getCwd(),
					timeoutMs: cfgLoopConditionTimeoutMs.get(this.#session.settings),
					signal: controller.signal,
					sessionId: this.#session.sessionManager.getSessionId(),
				});
				if (this.#conditionAbort === controller) this.#conditionAbort = undefined;
				logger.info("RPC loop condition returned", {
					...fields(),
					event: "loop_stage_completed",
					result: verdict.kind,
					elapsed_ms: performance.now() - conditionStarted,
				});
				if (!this.#current(generation, prompt)) return;
				if (verdict.kind === "aborted") return;
				if (verdict.kind !== "continue") {
					result = verdict.kind === "error" ? "condition_failed" : "condition_halt";
					this.#disable(verdict.message);
					return;
				}
			}
			// A condition may have waited while new host input or a session change arrived.
			if (!this.#current(generation, prompt)) return;
			if (!this.#idle()) {
				// A new turn superseded the condition verdict. Re-evaluate at its yield.
				this.#scheduled = false;
				result = "rescheduled";
				this.#schedule();
				return;
			}
			if (action === "reset" && this.#session.getVibeModeState()?.enabled) {
				result = "vibe_mode_gate";
				this.#disable("Exit vibe mode before using reset loops. Loop mode disabled.");
				return;
			}
			if (!consumeLoopLimitIteration(this.#limit)) {
				result = "limit_reached";
				this.#disable("Loop limit reached. Loop mode disabled.");
				return;
			}
			if (action === "compact") {
				stage = "compact";
				logger.info("RPC loop compact started", { ...fields(), event: "loop_stage_started", result: "started" });
				await this.#session.compact();
				logger.info("RPC loop compact completed", {
					...fields(),
					event: "loop_stage_completed",
					result: "completed",
				});
			} else if (action === "reset") {
				stage = "reset";
				logger.info("RPC loop reset started", { ...fields(), event: "loop_stage_started", result: "started" });
				const reset = await this.#options.reset(() => this.#current(generation, prompt));
				logger.info("RPC loop reset returned", {
					...fields(),
					event: "loop_stage_completed",
					result: reset === false ? "cancelled" : "completed",
				});
				if (reset === false) {
					if (generation === this.#generation) this.#disable("Loop reset was cancelled. Loop mode disabled.");
					return;
				}
				// Only this delegated reset may intentionally adopt a new transcript.
				if (generation === this.#generation) this.#transcriptId = this.#session.sessionManager.getSessionId();
			}
			stage = "idle_wait_after_action";
			logger.info("RPC loop idle wait started", { ...fields(), event: "loop_stage_started", result: "started" });
			if (!(await this.#waitUntilIdle(generation, prompt))) return;
			// The awaited action can outlast a duration budget its own consume approved:
			// like the TUI's pre-submission gate, never submit a turn past the deadline.
			if (isLoopDurationExpired(this.#limit)) {
				result = "duration_limit";
				this.#disable("Loop time limit reached. Loop mode disabled.");
				return;
			}
			// The submission claims the session synchronously. A following agent_end can
			// then schedule its own continuation, including skills submitted inline.
			this.#scheduled = false;
			stage = "submit";
			logger.info("RPC loop submission started", { ...fields(), event: "loop_stage_started", result: "started" });
			await this.#options.submit(
				prompt,
				() => this.#current(generation, prompt) && !isLoopDurationExpired(this.#limit),
			);
			if (this.#current(generation, prompt) && isLoopDurationExpired(this.#limit)) {
				result = "duration_limit";
				this.#disable("Loop time limit reached. Loop mode disabled.");
				return;
			}
			result = "submission_returned";
		} catch (error) {
			result =
				this.#current(generation, prompt) && !(error instanceof Error && error.name === "AbortError")
					? "failed"
					: "cancelled";
			if (result === "failed")
				logger.error("RPC loop iteration failed", {
					...fields(),
					event: "loop_iteration_failed",
					result,
					...logger.diagnosticError(error),
				});
			throw error;
		} finally {
			if (result !== "failed")
				logger.info("RPC loop iteration ended", { ...fields(), event: "loop_iteration_terminal", result });
			if (generation === this.#generation) {
				this.#scheduled = false;
				this.#options.onContinuationDropped();
			}
		}
	}
}
