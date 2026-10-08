import type { LoopConditionConfig, LoopLimitRuntime } from "@oh-my-pi/pi-tui/status-line/loop";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { SlashCommandResult } from "../../slash-commands/types";
import { describeLoopCondition, evaluateLoopCondition } from "../loop-condition";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	isLoopLimitExhausted,
	parseLoopArgs,
} from "../loop-limit";
import { cfgLoopConditionTimeoutMs, cfgLoopMode } from "../settings";

export interface RpcLoopOptions {
	output(text: string): void;
	/** Re-enter the host's normal prompt pipeline without capturing automatic input. */
	submit(text: string): Promise<void>;
	/** Use the host's session-change hooks, preserving this loop for its own reset. */
	reset(): Promise<boolean | void>;
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
	}

	observe(event: AgentSessionEvent): void {
		if (event.type === "agent_end" && event.isTerminal !== false) this.#schedule();
	}

	/** Cancel pending work while preserving the captured prompt and mode. */
	cancel(): void {
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
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#iterate(generation, prompt).catch(error => {
				logger.warn("RPC loop controller failed", { error: String(error) });
				if (this.#current(generation, prompt)) this.#disable(`Loop failed: ${String(error)}`);
			});
		}, 800);
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
		try {
			if (!(await this.#waitUntilIdle(generation, prompt))) return;
			if (isLoopLimitExhausted(this.#limit)) {
				this.#disable("Loop limit reached. Loop mode disabled.");
				return;
			}
			const action = cfgLoopMode.get(this.#session.settings);
			if (action === "reset" && this.#session.getVibeModeState()?.enabled) {
				this.#disable("Exit vibe mode before using reset loops. Loop mode disabled.");
				return;
			}
			if (this.#condition) {
				const controller = new AbortController();
				this.#conditionAbort = controller;
				const verdict = await evaluateLoopCondition(this.#condition, {
					cwd: this.#session.sessionManager.getCwd(),
					timeoutMs: cfgLoopConditionTimeoutMs.get(this.#session.settings),
					signal: controller.signal,
					sessionId: this.#session.sessionManager.getSessionId(),
				});
				if (this.#conditionAbort === controller) this.#conditionAbort = undefined;
				if (!this.#current(generation, prompt)) return;
				if (verdict.kind === "aborted") return;
				if (verdict.kind !== "continue") {
					this.#disable(verdict.message);
					return;
				}
			}
			// A condition may have waited while new host input or a session change arrived.
			if (!this.#current(generation, prompt)) return;
			if (!this.#idle()) {
				// A new turn superseded the condition verdict. Re-evaluate at its yield.
				this.#scheduled = false;
				this.#schedule();
				return;
			}
			if (action === "reset" && this.#session.getVibeModeState()?.enabled) {
				this.#disable("Exit vibe mode before using reset loops. Loop mode disabled.");
				return;
			}
			if (!consumeLoopLimitIteration(this.#limit)) {
				this.#disable("Loop limit reached. Loop mode disabled.");
				return;
			}
			if (action === "compact") {
				await this.#session.compact();
			} else if (action === "reset") {
				const reset = await this.#options.reset();
				if (reset === false) {
					if (generation === this.#generation) this.#disable("Loop reset was cancelled. Loop mode disabled.");
					return;
				}
				// Only this delegated reset may intentionally adopt a new transcript.
				if (generation === this.#generation) this.#transcriptId = this.#session.sessionManager.getSessionId();
			}
			if (!(await this.#waitUntilIdle(generation, prompt))) return;
			// The submission claims the session synchronously. A following agent_end can
			// then schedule its own continuation, including skills submitted inline.
			this.#scheduled = false;
			await this.#options.submit(prompt);
		} finally {
			if (generation === this.#generation) {
				this.#scheduled = false;
				this.#options.onContinuationDropped();
			}
		}
	}
}
