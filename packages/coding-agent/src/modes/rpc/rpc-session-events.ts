/**
 * Session-event forwarding for RPC mode: stamps message lifecycle frames with a
 * `messageId` and applies the host's `set_event_filter` selection.
 */
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { AgentSessionEvent } from "../../session/agent-session";
import { toWireEvent, type WireSessionEvent } from "../../session/loop-end-wire";
import { toRpcGoalModeState } from "./rpc-goal";
import type {
	RpcAgentSessionEventFrame,
	RpcDeltaAssistantMessageEvent,
	RpcMessageUpdates,
	RpcProjectedSessionEventFrame,
	RpcSessionEventProjection,
	RpcTodoItem,
	RpcTodoPhase,
} from "./rpc-types";

function isRpcTodoItem(item: TodoItem): item is RpcTodoItem {
	return item.status !== "blocked" && !("blocker" in item);
}

function isRpcTodoPhase(phase: TodoPhase): phase is RpcTodoPhase {
	return phase.tasks.every(isRpcTodoItem);
}

function toRpcTodoItems(items: TodoItem[]): RpcTodoItem[] {
	if (items.every(isRpcTodoItem)) return items;
	return items.map(item => {
		if (isRpcTodoItem(item)) return item;
		const { blocker: _, status, ...wire } = item;
		// The upstream protocol has no blocked status. Keep the unfinished item visible.
		return { ...wire, status: status === "blocked" ? "pending" : status };
	});
}

export function toRpcTodoPhases(phases: TodoPhase[]): RpcTodoPhase[] {
	if (phases.every(isRpcTodoPhase)) return phases;
	return phases.map(phase =>
		isRpcTodoPhase(phase) ? phase : { name: phase.name, tasks: toRpcTodoItems(phase.tasks) },
	);
}

export function projectRpcSessionEvent(
	event: WireSessionEvent,
): RpcSessionEventProjection<WireSessionEvent> | undefined;
export function projectRpcSessionEvent(
	event: AgentSessionEvent,
): RpcSessionEventProjection<AgentSessionEvent> | undefined;
export function projectRpcSessionEvent(event: AgentSessionEvent | WireSessionEvent) {
	switch (event.type) {
		case "session_abort":
			return undefined;
		case "tool_execution_end": {
			if (!("cancelled" in event)) return event;
			const { cancelled: _, ...wire } = event;
			return wire;
		}
		case "manual_compaction_start":
		case "manual_compaction_end": {
			const { operationId: _, ...wire } = event;
			return wire;
		}
		case "todo_reminder":
			return { ...event, todos: toRpcTodoItems(event.todos) };
		case "goal_updated": {
			if (!event.state) return event;
			const state = toRpcGoalModeState(event.state);
			return state === event.state ? event : { ...event, state };
		}
		default:
			return event;
	}
}

/**
 * The shell of a block a `*_start` opens. The snapshot behind a start event is cloned when the agent loop consumes the
 * event, after the provider may have streamed more into the same partial, so its streamed content is not trustworthy:
 * empty it, and every following delta applies cleanly. The matching `*_end` carries the final content.
 */
function openedBlock(block: AssistantMessage["content"][number] | undefined) {
	switch (block?.type) {
		case "text":
			return { ...block, text: "" };
		case "thinking":
			return { ...block, thinking: "" };
		case "toolCall":
			return { ...block, arguments: {} };
		default:
			return block;
	}
}

/** Drops the accumulated snapshot a streaming event carries, keeping what a client needs to rebuild it; `done` and `error` have none. */
function toDelta(event: AssistantMessageEvent): RpcDeltaAssistantMessageEvent {
	switch (event.type) {
		case "done":
		case "error":
			return event;
		case "start": {
			const { partial, ...rest } = event;
			return { ...rest, message: partial };
		}
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta": {
			const { partial: _partial, ...increment } = event;
			return increment;
		}
		case "text_end": {
			// `content` already carries the text; the block adds only what it cannot (the signature).
			const { partial, ...rest } = event;
			const block = partial.content[event.contentIndex];
			if (block?.type !== "text") return rest;
			const { text: _text, ...meta } = block;
			return { ...rest, block: meta };
		}
		case "thinking_end": {
			const { partial, ...rest } = event;
			const block = partial.content[event.contentIndex];
			if (block?.type !== "thinking") return rest;
			const { thinking: _thinking, ...meta } = block;
			return { ...rest, block: meta };
		}
		case "image_end":
		case "toolcall_end": {
			// `content` / `toolCall` is the whole block.
			const { partial: _partial, ...rest } = event;
			return rest;
		}
		default: {
			const { partial, ...rest } = event;
			const block = openedBlock(partial.content[event.contentIndex]);
			return block === undefined ? rest : { ...rest, block };
		}
	}
}

/**
 * Writes session events to the RPC output. Message ids are assigned whether or
 * not the frame passes the filter, so changing the filter mid-message never
 * splits one message across two ids.
 */
export class RpcSessionEventForwarder {
	#filter: Set<string> | undefined;
	#messageUpdates: RpcMessageUpdates = "full";
	#messageCount = 0;
	/** Ids of started, unfinished messages. External records (advisor cards, IRC) nest inside a streaming reply. */
	#openMessageIds: string[] = [];
	readonly #output: (frame: RpcProjectedSessionEventFrame) => void;

	constructor(output: (frame: RpcProjectedSessionEventFrame) => void) {
		this.#output = output;
	}

	/** Forward only the listed RPC event types; `null` forwards every RPC event. Returns the active selection. */
	setFilter(events: readonly string[] | null, messageUpdates: RpcMessageUpdates = "full"): string[] | null {
		this.#filter = events === null ? undefined : new Set(events);
		this.#messageUpdates = messageUpdates;
		return this.#filter ? Array.from(this.#filter) : null;
	}

	forward(event: AgentSessionEvent): void {
		const projected = projectRpcSessionEvent(toWireEvent(event));
		if (!projected) return;
		const frame = this.#stamp(projected);
		if (this.#filter && !this.#filter.has(frame.type)) return;
		if (frame.type === "message_update" && this.#messageUpdates === "delta") {
			this.#output({
				...frame,
				message: { role: frame.message.role },
				assistantMessageEvent: toDelta(frame.assistantMessageEvent),
			});
			return;
		}
		this.#output(frame);
	}

	#stamp(event: RpcSessionEventProjection<WireSessionEvent>): RpcAgentSessionEventFrame {
		switch (event.type) {
			case "message_start": {
				const messageId = this.#mintMessageId();
				this.#openMessageIds.push(messageId);
				return { ...event, messageId };
			}
			case "message_update": {
				let messageId = this.#openMessageIds.at(-1);
				if (messageId === undefined) {
					messageId = this.#mintMessageId();
					this.#openMessageIds.push(messageId);
				}
				return { ...event, messageId };
			}
			case "message_end":
				return { ...event, messageId: this.#openMessageIds.pop() ?? this.#mintMessageId() };
			case "agent_end":
				// A run never leaves a message open; drop anything a dropped frame stranded.
				this.#openMessageIds.length = 0;
				return event;
			default:
				return event;
		}
	}

	#mintMessageId(): string {
		return `msg-${++this.#messageCount}`;
	}
}
