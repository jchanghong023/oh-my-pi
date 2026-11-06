import { toolOutputText } from "@oh-my-pi/pi-tui/tools/output-preview";
import type { ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "./agent-session-events";
import type { LiveToolOutputSnapshot } from "./agent-session-handle";

/** Dispatch facts for the in-flight calls and the latest real Output, never transcript history. */
export class LiveToolOutputState {
	readonly #calls = new Map<string, LiveToolOutputSnapshot>();
	#dispatchOrder = 0;
	#latestOutputOrder = 0;

	clear(): void {
		this.#calls.clear();
		this.#dispatchOrder = 0;
		this.#latestOutputOrder = 0;
	}

	restore(snapshots: readonly LiveToolOutputSnapshot[]): void {
		this.clear();
		for (const snapshot of snapshots) {
			this.#calls.set(snapshot.toolCallId, snapshot);
			this.#dispatchOrder = Math.max(this.#dispatchOrder, snapshot.dispatchOrder);
			if (snapshot.result) this.#latestOutputOrder = Math.max(this.#latestOutputOrder, snapshot.dispatchOrder);
		}
	}

	snapshot(): readonly LiveToolOutputSnapshot[] {
		return [...this.#calls.values()];
	}

	observe(event: AgentSessionEvent, receivedAt: number, dispatchOrder?: number): void {
		if (event.type === "tool_execution_start") {
			if (this.#calls.has(event.toolCallId)) return;
			this.#calls.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
				dispatchOrder: (this.#dispatchOrder = dispatchOrder ?? this.#dispatchOrder + 1),
			});
			return;
		}
		if (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return;
		const call = this.#calls.get(event.toolCallId);
		if (!call) return;
		const result: ToolRenderResult<unknown> =
			event.type === "tool_execution_update" ? event.partialResult : event.result;
		const details = isRecord(result.details) ? result.details : undefined;
		const dispatch = isRecord(details?.xdev) ? details.xdev : undefined;
		const inner = isRecord(dispatch?.inner) ? dispatch.inner : details;
		const async = isRecord(inner?.async) ? inner.async : undefined;
		// An already received terminal frame is authoritative over a late startup receipt.
		if (call.terminalAt !== undefined && async?.state === "running") return;
		if (event.type === "tool_execution_update") call.args = event.args ?? call.args;
		if (
			async?.state === "completed" ||
			async?.state === "failed" ||
			async?.state === "cancelled" ||
			(event.type === "tool_execution_end" && async?.state !== "running")
		) {
			call.terminalAt ??= receivedAt;
		}
		if (toolOutputText(call.toolName, result).trim()) {
			call.result = result;
			this.#latestOutputOrder = call.dispatchOrder;
			// Older calls cannot reclaim the preview, even while they keep executing.
			for (const [id, previous] of this.#calls) {
				if (previous.dispatchOrder < this.#latestOutputOrder) this.#calls.delete(id);
			}
		} else if (call.result) {
			call.result = { ...result, content: call.result.content };
		} else if (call.terminalAt !== undefined) {
			this.#calls.delete(call.toolCallId);
		}
	}
}
