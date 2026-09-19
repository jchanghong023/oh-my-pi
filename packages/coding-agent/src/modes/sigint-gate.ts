/**
 * Double-press gate for process-level SIGINT in the interactive TUI.
 *
 * The TUI consumes Ctrl+C as a key event in raw mode, so keyboard interrupts
 * go through the input controller's 500ms double-tap gate instead of the
 * postmortem SIGINT handler. On Windows that assumption can break: a console
 * ctrl event (Ctrl+Break, a flipped `ENABLE_PROCESSED_INPUT` on the shared
 * console, or any sibling process broadcasting
 * `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)`) reaches the process as a real
 * signal regardless of raw mode — and the historical signal path exits on the
 * first hit, destroying a live session with in-flight subagents.
 *
 * This gate gives real signals the same double-press semantics as the keypress
 * path: the first signal inside the confirm window is consumed with a visible
 * hint; a repeat within the window, any signal while teardown is already
 * running, or any signal while no gate is registered falls through to the
 * postmortem signal teardown (persisted `session_exit` reason `sigint`,
 * exit code 130). The confirm window is deliberately longer than the keypress
 * gate's 500ms double-tap: the hint asks the user to act on a prompt, which
 * they cannot do in half a second.
 *
 * Extracted standalone (rather than inlined into `InteractiveMode`) so the
 * gate logic is directly unit-testable without instantiating the TUI stack.
 */
import { postmortem } from "@oh-my-pi/pi-utils";

/** Window in which a second SIGINT confirms the exit. */
export const SIGINT_CONFIRM_WINDOW_MS = 5_000;

/** Dependencies the gate captures at construction time. */
export interface SigintGateDeps {
	/** True once `shutdown()` teardown has begun; signals must hard-exit then. */
	isShuttingDown: () => boolean;
	/** Visible feedback shown when a signal is consumed (editor stays intact). */
	showHint: () => void;
	/** Injectable clock for tests. */
	now?: () => number;
}

export interface SigintGate {
	/**
	 * Postmortem SIGINT interceptor: `true` consumed the signal (process keeps
	 * running), `false` defers to the signal teardown + exit 130 path.
	 */
	interceptor: () => boolean;
}

export function createSigintGate(deps: SigintGateDeps): SigintGate {
	let lastConsumedAt = Number.NEGATIVE_INFINITY;
	const now = deps.now ?? Date.now;
	return {
		interceptor: (): boolean => {
			// During teardown a signal is the stuck-teardown hard abort — let it
			// reach the postmortem signal path immediately.
			if (deps.isShuttingDown()) return false;
			const at = now();
			if (at - lastConsumedAt < SIGINT_CONFIRM_WINDOW_MS) return false;
			lastConsumedAt = at;
			deps.showHint();
			return true;
		},
	};
}

/**
 * Register a gate as a postmortem SIGINT interceptor. Returns the unregister
 * function the owner must call on dispose so later signals (headless re-init,
 * test harnesses) keep the immediate-exit semantics.
 */
export function registerInteractiveSigintGate(deps: SigintGateDeps): () => void {
	const gate = createSigintGate(deps);
	return postmortem.interceptSigint(gate.interceptor);
}
