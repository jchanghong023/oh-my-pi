/**
 * Fork-extension queued-message panel (requirement 5.1, rpc-ui-protocol.md).
 *
 * Wraps the session-level queue APIs (`agent.peekSteeringQueue` /
 * `peekFollowUpQueue` / `agent.replaceQueues`) with stable client-facing ids.
 * Queued entries are bare `AgentMessage`s in the agent core; ids are minted
 * lazily per message object (WeakMap) so they stay stable across
 * `get_queue`/`reorder_queue` round-trips for as long as the entry stays
 * queued. `queue_updated` carries counts only; clients re-pull for contents.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../../session/agent-session";
import { toRestoredQueuedMessage } from "../../session/queued-messages";
import type { RpcForkHost } from "./rpc-fork-host";
import type { RpcForkCommandBase, RpcForkQueueUpdatedFrame } from "./rpc-fork-types";
import type { RpcResponse } from "./rpc-types";

export type RpcForkQueueName = "steering" | "followUp";

export interface RpcForkQueuedEntry {
	id: string;
	text: string;
	imageCount: number;
}

export interface RpcForkQueueSnapshot {
	steering: RpcForkQueuedEntry[];
	followUp: RpcForkQueuedEntry[];
}

export class RpcForkQueueController {
	readonly #ids = new WeakMap<AgentMessage, string>();
	#nextId = 1;

	constructor(
		private readonly host: RpcForkHost,
		private readonly session: AgentSession,
	) {
		host.registerCommand("get_queue", command => this.#getQueue(command));
		host.registerCommand("remove_queued", command => this.#removeQueued(command));
		host.registerCommand("reorder_queue", command => this.#reorderQueue(command));
		host.registerCommand("clear_queue", command => this.#clearQueue(command));
	}

	#idFor(message: AgentMessage): string {
		let id = this.#ids.get(message);
		if (!id) {
			id = `q${this.#nextId++}`;
			this.#ids.set(message, id);
		}
		return id;
	}

	#queue(queue: RpcForkQueueName): readonly AgentMessage[] {
		return queue === "steering" ? this.session.agent.peekSteeringQueue() : this.session.agent.peekFollowUpQueue();
	}

	#entryFor(message: AgentMessage): RpcForkQueuedEntry {
		const restored = toRestoredQueuedMessage(message);
		return { id: this.#idFor(message), text: restored.text, imageCount: restored.images?.length ?? 0 };
	}

	#counts(): { steeringCount: number; followUpCount: number } {
		return {
			steeringCount: this.session.agent.peekSteeringQueue().length,
			followUpCount: this.session.agent.peekFollowUpQueue().length,
		};
	}

	emitQueueUpdated(): void {
		this.host.context.emit({
			type: "queue_updated",
			...this.#counts(),
		} satisfies RpcForkQueueUpdatedFrame);
	}

	async #getQueue(command: RpcForkCommandBase): Promise<RpcResponse> {
		const data: RpcForkQueueSnapshot = {
			steering: this.#queue("steering").map(message => this.#entryFor(message)),
			followUp: this.#queue("followUp").map(message => this.#entryFor(message)),
		};
		return this.host.context.success(command.id, "get_queue", data);
	}

	async #removeQueued(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { queue: queueName, entryId } = command as { queue?: unknown; entryId?: unknown };
		if (queueName !== "steering" && queueName !== "followUp") {
			return this.host.context.error(command.id, "remove_queued", `Invalid queue: ${String(queueName)}`);
		}
		if (typeof entryId !== "string" || !entryId) {
			return this.host.context.error(command.id, "remove_queued", "entryId is required");
		}
		const remaining = this.#queue(queueName).filter(message => this.#idFor(message) !== entryId);
		if (remaining.length === this.#queue(queueName).length) {
			return this.host.context.error(
				command.id,
				"remove_queued",
				`Unknown queued message id: ${entryId}`,
				"unknown_queue_entry",
			);
		}
		this.#applyQueue(queueName, remaining);
		this.emitQueueUpdated();
		return this.host.context.success(command.id, "remove_queued");
	}

	async #reorderQueue(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { queue: queueName, ids } = command as { queue?: unknown; ids?: unknown };
		if (queueName !== "steering" && queueName !== "followUp") {
			return this.host.context.error(command.id, "reorder_queue", `Invalid queue: ${String(queueName)}`);
		}
		if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) {
			return this.host.context.error(command.id, "reorder_queue", "ids must be an array of queued message ids");
		}
		const current = [...this.#queue(queueName)];
		const byId = new Map(current.map(message => [this.#idFor(message), message] as const));
		const wanted = ids as string[];
		if (
			wanted.length !== current.length ||
			new Set(wanted).size !== wanted.length ||
			wanted.some(id => !byId.has(id))
		) {
			return this.host.context.error(
				command.id,
				"reorder_queue",
				"ids must be a permutation of the current queued message ids",
				"unknown_queue_entry",
			);
		}
		this.#applyQueue(
			queueName,
			wanted.map(id => byId.get(id)!),
		);
		this.emitQueueUpdated();
		return this.host.context.success(command.id, "reorder_queue");
	}

	async #clearQueue(command: RpcForkCommandBase): Promise<RpcResponse> {
		const queueName = (command as { queue?: unknown }).queue;
		if (queueName === undefined) {
			this.#applyQueue("steering", []);
			this.#applyQueue("followUp", []);
		} else if (queueName === "steering" || queueName === "followUp") {
			this.#applyQueue(queueName, []);
		} else {
			return this.host.context.error(command.id, "clear_queue", `Invalid queue: ${String(queueName)}`);
		}
		this.emitQueueUpdated();
		return this.host.context.success(command.id, "clear_queue");
	}

	#applyQueue(queueName: RpcForkQueueName, messages: readonly AgentMessage[]): void {
		if (queueName === "steering") {
			this.session.agent.replaceQueues([...messages], [...this.session.agent.peekFollowUpQueue()]);
		} else {
			this.session.agent.replaceQueues([...this.session.agent.peekSteeringQueue()], [...messages]);
		}
	}
}
