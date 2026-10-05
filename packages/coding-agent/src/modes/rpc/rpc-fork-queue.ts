/**
 * Fork-extension queued-message panel (requirement 5.1, rpc-ui-protocol.md).
 *
 * Wraps the session-level queue APIs (`agent.peekSteeringQueue` /
 * `peekFollowUpQueue` / `agent.replaceQueue`) with stable client-facing ids.
 * Queued entries are bare `AgentMessage`s in the agent core; ids are minted
 * lazily per message object (WeakMap) so they stay stable across
 * `get_queue`/`reorder_queue` round-trips for as long as the entry stays
 * queued. `queue_updated` carries counts only; clients re-pull for contents.
 * The panel exposes user-authored entries; hidden companions move with their
 * owning user entry, while runtime/advisor messages remain outside the panel.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../../session/agent-session";
import {
	isHiddenUserCompanion,
	isUserAuthoredQueuedMessage,
	toRestoredQueuedMessage,
} from "../../session/queued-messages";
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
		const unsubscribe = session.agent.onQueueChange(() => this.emitQueueUpdated());
		host.registerDisposer(() => unsubscribe());
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
			steeringCount: this.#queue("steering").filter(isUserAuthoredQueuedMessage).length,
			followUpCount: this.#queue("followUp").filter(isUserAuthoredQueuedMessage).length,
		};
	}

	emitQueueUpdated(): void {
		if (!this.host.isActive) return;
		this.host.context.emit({
			type: "queue_updated",
			...this.#counts(),
		} satisfies RpcForkQueueUpdatedFrame);
	}

	async #getQueue(command: RpcForkCommandBase): Promise<RpcResponse> {
		const data: RpcForkQueueSnapshot = {
			steering: this.#queue("steering")
				.filter(isUserAuthoredQueuedMessage)
				.map(message => this.#entryFor(message)),
			followUp: this.#queue("followUp")
				.filter(isUserAuthoredQueuedMessage)
				.map(message => this.#entryFor(message)),
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
		const current = this.#queue(queueName);
		const group = this.#userGroups(current).find(candidate => candidate.id === entryId);
		if (!group) {
			return this.host.context.error(
				command.id,
				"remove_queued",
				`Unknown queued message id: ${entryId}`,
				"unknown_queue_entry",
			);
		}
		const remaining = [...current];
		remaining.splice(group.start, group.end - group.start);
		this.#applyQueue(queueName, remaining);
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
		const current = this.#queue(queueName);
		const groups = this.#userGroups(current);
		const byId = new Map(groups.map(group => [group.id, current.slice(group.start, group.end)]));
		const wanted = ids as string[];
		if (
			wanted.length !== groups.length ||
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
		const reordered: AgentMessage[] = [];
		let offset = 0;
		for (let index = 0; index < groups.length; index++) {
			const group = groups[index];
			reordered.push(...current.slice(offset, group.start), ...byId.get(wanted[index])!);
			offset = group.end;
		}
		reordered.push(...current.slice(offset));
		this.#applyQueue(queueName, reordered);
		return this.host.context.success(command.id, "reorder_queue");
	}

	async #clearQueue(command: RpcForkCommandBase): Promise<RpcResponse> {
		const queueName = (command as { queue?: unknown }).queue;
		if (queueName === undefined) {
			this.#clearUserQueue("steering");
			this.#clearUserQueue("followUp");
		} else if (queueName === "steering" || queueName === "followUp") {
			this.#clearUserQueue(queueName);
		} else {
			return this.host.context.error(command.id, "clear_queue", `Invalid queue: ${String(queueName)}`);
		}
		return this.host.context.success(command.id, "clear_queue");
	}

	#userGroups(messages: readonly AgentMessage[]): Array<{ id: string; start: number; end: number }> {
		const groups: Array<{ id: string; start: number; end: number }> = [];
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index];
			if (!isUserAuthoredQueuedMessage(message)) continue;
			let start = index;
			while (start > 0 && isHiddenUserCompanion(messages[start - 1])) start--;
			groups.push({ id: this.#idFor(message), start, end: index + 1 });
		}
		return groups;
	}

	#clearUserQueue(queueName: RpcForkQueueName): void {
		const current = this.#queue(queueName);
		const groups = this.#userGroups(current);
		const remaining = [...current];
		for (let index = groups.length - 1; index >= 0; index--) {
			const group = groups[index];
			remaining.splice(group.start, group.end - group.start);
		}
		this.#applyQueue(queueName, remaining);
	}

	#applyQueue(queueName: RpcForkQueueName, messages: readonly AgentMessage[]): void {
		this.session.agent.replaceQueue(queueName, messages);
	}
}
