/**
 * Cooperative pause gate for agent loops.
 *
 * Every agent loop polls its owning gate before each model call and tool
 * execution. Engaging a gate freezes its agents at the next safe point without
 * aborting anything: in-flight provider streams and already-started tools run
 * to completion, then the loops park until {@link AgentPauseGate.resume}.
 * Queued steering/follow-up messages remain queued until resume.
 *
 * A run's own `AbortSignal` releases only its wait without releasing the gate,
 * so cancelling one run never resumes its siblings or another root.
 *
 * By default agents share {@link agentPauseGate}, preserving process-wide TUI
 * `/pause`. Hosts with independent roots provide one explicit gate per root
 * and share it with that root's descendant, advisor, and capture agents.
 */

/** Listener invoked with the new state on every pause/resume transition. */
export type AgentPauseListener = (paused: boolean) => void;

/** Freeze switch shared by an owning root's loops, or by the process default. */
export class AgentPauseGate {
	/** Pending while paused; resolved and cleared on resume. */
	#gate: PromiseWithResolvers<void> | undefined;
	#pausedAt = 0;
	#listeners = new Set<AgentPauseListener>();

	/** True while the gate is engaged. */
	get paused(): boolean {
		return this.#gate !== undefined;
	}

	/** Epoch ms when the current pause began; undefined when running. */
	get pausedAt(): number | undefined {
		return this.#gate ? this.#pausedAt : undefined;
	}

	/** Engage the gate. Returns false (and does nothing) when already paused. */
	pause(): boolean {
		if (this.#gate) return false;
		this.#gate = Promise.withResolvers<void>();
		this.#pausedAt = Date.now();
		this.#notify(true);
		return true;
	}

	/**
	 * Release the gate, waking every parked loop. Returns the pause duration in
	 * ms, or undefined when the gate was not engaged.
	 */
	resume(): number | undefined {
		const gate = this.#gate;
		if (!gate) return undefined;
		this.#gate = undefined;
		gate.resolve();
		this.#notify(false);
		return Date.now() - this.#pausedAt;
	}

	/** Subscribe to pause/resume transitions. Returns an unsubscribe function. */
	onChange(listener: AgentPauseListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Park until the gate is released. Resolves immediately when not paused.
	 * An abort on `signal` releases only this wait — the gate stays engaged —
	 * so a cancelled run unwinds while the gate's other agents stay frozen.
	 */
	async waitUntilResumed(signal?: AbortSignal): Promise<void> {
		// Loop: resume() swaps the gate promise, so a pause re-engaged while a
		// waiter is between awaits must re-park instead of slipping through.
		while (this.#gate) {
			if (signal?.aborted) return;
			const gate = this.#gate.promise;
			if (!signal) {
				await gate;
				continue;
			}
			const abort = Promise.withResolvers<void>();
			const onAbort = () => abort.resolve();
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				await Promise.race([gate, abort.promise]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}

	#notify(paused: boolean): void {
		for (const listener of this.#listeners) {
			try {
				listener(paused);
			} catch {
				// Host UI listeners must never break the gate.
			}
		}
	}
}

/** Default process-wide gate when no explicit owning gate is supplied. */
export const agentPauseGate = new AgentPauseGate();
