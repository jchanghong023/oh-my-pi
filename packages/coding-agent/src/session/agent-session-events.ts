import type { AgentEvent, AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort } from "@oh-my-pi/pi-ai";
import type { Rule } from "../capability/rule";
import type { RetryErrorUpdate } from "../extensibility/shared-events";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import { type GoalModeState, type LocalGoalModeState, publicGoalModeState } from "../goals/state";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { type LocalTodoItem, publicTodoItems, type TodoItem } from "@oh-my-pi/pi-tui/tools/todo";
import type { CustomMessage } from "./messages";
import type { CacheWarmingRefreshEnd, CacheWarmingRefreshStart } from "./cache-warmer";

/**
 * Session-specific events that extend the core AgentEvent.
 *
 * Run lifecycle: a *run* opens at the first `agent_start` and closes at exactly one
 * `agent_end`, emitted once nothing can resume it — no model loop is live, nothing
 * the session scheduled is pending, and no background job, child agent or peer
 * message can wake it ({@link AgentSession.wakeSources}). Every model loop that stops
 * while the run goes on emits `agent_pause` instead, followed by the next loop's
 * `agent_start` or by the run's `agent_end`. A session transition (`/new`, a switch,
 * dispose) abandons an open run without either. The RPC, JSON print and collab wires and
 * the extension `agent_end` keep their per-loop `agent_end` shape (see `loop-end-wire.ts`).
 */
export type LocalAgentSessionEvent =
	| AgentEvent
	| {
			type: "agent_pause";
			/** Messages of the model loop that stopped, as its `agent_end` would carry them. */
			messages: AgentMessage[];
			/**
			 * True when the model finished its turn and something outside it resumes the run:
			 * queued input, a peer message, a background-job result or a child agent. False
			 * while the session continues the model's own work (retry, compaction continuation,
			 * stop-time reminders, hook continuations).
			 */
			yielded: boolean;
			/**
			 * True when nothing the session scheduled resumes the run: it waits only on outside
			 * work (a background job, child agent or peer message; see {@link WakeSources}).
			 */
			awaiting: boolean;
	  }
	/** Target-session cancellation begins before any awaited teardown, including pending UI. */
	| { type: "session_abort"; reason?: string }
	| {
			type: "auto_compaction_start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
	  }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** True when compaction was skipped for a benign reason. */
			skipped?: boolean;
	  }
	// One pair per manual compaction (RPC `compact`, `/compact`, extension
	// `ctx.compact()`), emitted once the live turn is aborted; fallback passes to
	// the next configured method stay inside the same pair.
	| {
			type: "manual_compaction_start";
			operationId?: string;
			/** The `/compact <mode>` subcommand, when one was given. */
			mode?: string;
	  }
	| {
			type: "manual_compaction_end";
			operationId?: string;
			/** Present when the compaction committed. */
			result?: CompactionResult;
			/** True when the compaction was cancelled (abort, or a `session_before_compact` hook). */
			aborted: boolean;
			/** True when there was nothing to compact; `errorMessage` says why. */
			skipped?: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
			retryErrors?: RetryErrorUpdate[];
	  }
	| ({ type: "cache_warming_start" } & CacheWarmingRefreshStart)
	| ({ type: "cache_warming_end" } & CacheWarmingRefreshEnd)
	| { type: "retry_fallback_applied"; from: string; to: string; role: string; reason?: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "model_changed" }
	| { type: "config_warnings_changed" }
	| { type: "advisor_cost_changed" }
	| { type: "advisor_yielded" }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "todo_reminder"; todos: LocalTodoItem[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| {
			type: "thinking_level_changed";
			thinkingLevel: ThinkingLevel | undefined;
			/** The user-configured selector when it differs from the effective level. */
			configured?: ConfiguredThinkingLevel;
			/** The level `auto` resolved to this turn, once classified. */
			resolved?: Effort;
	  }
	| { type: "goal_updated"; goal: Goal | null; state?: LocalGoalModeState }
	// Coalesced snapshot of the displayable steering/follow-up queue: emitted
	// whenever it differs from the last `queue_update` (enqueue, dequeue on
	// delivery, remove, clear/restore, live-steering adoption/withdrawal, or
	// session switch), never on a no-op mutation. Mirrors
	// `AgentSession.getQueuedMessages()`; `liveSteered` counts the leading
	// `steering` entries already sent into the streaming response, which
	// `remove_queued_message` cannot reach.
	| { type: "queue_update"; steering: string[]; followUp: string[]; liveSteered: number };

type PublicEvent<Event> = Event extends { type: "session_abort" }
	? never
	: Event extends { type: "tool_execution_end" }
		? Omit<Event, "cancelled">
		: Event extends { type: "manual_compaction_start" | "manual_compaction_end" }
			? Omit<Event, "operationId">
			: Event extends { type: "todo_reminder" }
				? Omit<Event, "todos"> & { todos: TodoItem[] }
				: Event extends { type: "goal_updated" }
					? Omit<Event, "state"> & { state?: GoalModeState }
					: Event;

export type AgentSessionEvent = PublicEvent<LocalAgentSessionEvent>;

/** Strip local lifecycle and orchestration metadata before publishing events. */
function publicSessionEvent(event: LocalAgentSessionEvent): AgentSessionEvent | undefined {
	switch (event.type) {
		case "session_abort":
			return undefined;
		case "tool_execution_end": {
			if (!("cancelled" in event)) return event;
			const { cancelled: _, ...fields } = event;
			return fields;
		}
		case "manual_compaction_start":
		case "manual_compaction_end": {
			const { operationId: _, ...fields } = event;
			return fields;
		}
		case "todo_reminder":
			return { ...event, todos: publicTodoItems(event.todos) };
		case "goal_updated": {
			if (!event.state) return event;
			const state = publicGoalModeState(event.state);
			return state === event.state ? event : { ...event, state };
		}
		default:
			return event;
	}
}

/**
 * What can still resume a session's run without user input once its model loop
 * stops; see {@link AgentSession.wakeSources}.
 */
export interface WakeSources {
	/** Owned background jobs whose result will be delivered into the run. */
	readonly jobs: readonly string[];
	/** Child agents whose run is still open; a message from one wakes the run. */
	readonly agents: readonly string[];
	/** Job results, launch completions or peer messages already queued for a wake turn. */
	readonly queued: boolean;
}

/** Listener function for agent session events. */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
export type LocalAgentSessionEventListener = (event: LocalAgentSessionEvent) => void;

export function publicSessionListener(listener: AgentSessionEventListener): LocalAgentSessionEventListener {
	return event => {
		const published = publicSessionEvent(event);
		if (published) return listener(published);
	};
}

export type ModelStage = "waiting" | "thinking" | "replying" | "tool-arguments";

/** Display phase derived from real events, even while no terminal is watching. */
export function nextModelStage(stage: ModelStage | null, event: LocalAgentSessionEvent): ModelStage | null {
	switch (event.type) {
		case "turn_start":
			return "waiting";
		case "message_start":
			return event.message.role === "assistant" ? "waiting" : stage;
		case "message_end":
			return event.message.role === "assistant" ? null : stage;
		case "agent_end":
		case "agent_pause":
		case "session_abort":
		case "turn_end":
		case "tool_execution_start":
			return null;
		case "message_update":
			if (event.message.role !== "assistant") return stage;
			switch (event.assistantMessageEvent.type) {
				case "start":
				case "thinking_end":
				case "text_end":
				case "toolcall_end":
					return "waiting";
				case "thinking_start":
				case "thinking_delta":
					return "thinking";
				case "text_start":
				case "text_delta":
					return "replying";
				case "toolcall_start":
				case "toolcall_delta":
					return "tool-arguments";
				case "error":
				case "done":
					return null;
				default:
					return stage;
			}
		default:
			return stage;
	}
}
