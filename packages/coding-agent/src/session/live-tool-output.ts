import { isRecord } from "@oh-my-pi/pi-utils";
import type { ToolResult } from "../ui/tools/contract";
import type { LocalAgentSessionEvent } from "./agent-session-events";
import type { LiveToolOutputPreview, LiveToolOutputProjection, LiveToolOutputSnapshot } from "./agent-session-handle";
import { mayBeCoveredByFileDiff, toolOutputText } from "./live-tool-output-text";

/**
 * Keep display source and lifecycle facts independent of which frame supplies the body.
 * In particular, an empty read's displayContent or Bash's output notices must not be
 * applied to an earlier valid body.
 */
function withOutputFacts(
	body: ToolResult<unknown>,
	previous: ToolResult<unknown> | undefined,
	incoming: ToolResult<unknown>,
	cancelled: boolean,
	isError: boolean | undefined,
): ToolResult<unknown> {
	const source = isRecord(body.details) ? body.details : undefined;
	const before = isRecord(previous?.details) ? previous.details : undefined;
	const update = isRecord(incoming.details) ? incoming.details : undefined;
	const commands = update?.toolCommands ?? before?.toolCommands;
	const previousJob = isRecord(before?.async) ? before.async : undefined;
	const nextJob = isRecord(update?.async) ? update.async : undefined;
	const bodyJob = isRecord(source?.async) ? source.async : undefined;
	const job =
		nextJob &&
		previousJob &&
		((nextJob.name === undefined && previousJob.name !== undefined) ||
			(nextJob.jobId === undefined && previousJob.jobId !== undefined) ||
			(nextJob.state === undefined && previousJob.state !== undefined))
			? { ...previousJob, ...nextJob }
			: (nextJob ?? previousJob);
	const wasCancelled = cancelled || update?.cancelled === true || before?.cancelled === true;
	const failed =
		incoming.isError === true || isError === true ? true : (isError ?? incoming.isError ?? previous?.isError);
	if (
		commands === source?.toolCommands &&
		job === bodyJob &&
		(!wasCancelled || source?.cancelled === true) &&
		failed === body.isError
	)
		return body;
	const details = {
		...source,
		...(commands ? { toolCommands: commands } : {}),
		...(job ? { async: job } : {}),
		...(wasCancelled ? { cancelled: true } : {}),
	};
	return {
		...body,
		isError: failed,
		details,
	};
}

/** Dispatch facts for in-flight calls and retained Output candidates, never transcript history. */
export class LiveToolOutputState {
	readonly #calls = new Map<string, LiveToolOutputSnapshot>();
	// Dispatch order, starting at the newest source that cannot be hidden by a file Diff.
	readonly #previews: LiveToolOutputPreview[] = [];
	#floor = 0;
	#dispatchOrder = 0;
	#runActive = false;

	clear(): void {
		this.#calls.clear();
		this.#dispatchOrder = 0;
		this.#floor = 0;
		this.#previews.length = 0;
	}

	setRunActive(active: boolean, at: number): void {
		if (active === this.#runActive) return;
		this.#runActive = active;
		// Expired candidates before every still-live call cannot be a visible fallback.
		let keepFrom = active ? this.#previews.at(-1)?.call.dispatchOrder : undefined;
		for (const call of this.#calls.values()) {
			if (keepFrom !== undefined && (call.expiresAt === undefined || call.expiresAt > at)) {
				keepFrom = Math.min(keepFrom, call.dispatchOrder);
			}
			if (call.terminalAt === undefined) continue;
			if (active) {
				// Keep a still-visible source during a new run, but never revive an expired one.
				if (call.expiresAt !== undefined && call.expiresAt > at) call.expiresAt = undefined;
			} else if (call.expiresAt === undefined) {
				call.expiresAt = Math.max(call.terminalAt, at) + 3000;
			}
		}
		const order = keepFrom;
		if (order !== undefined && order > this.#floor) {
			const index = this.#previews.findIndex(preview => preview.call.dispatchOrder >= order);
			this.#prune(order, index);
		}
	}

	restore(snapshots: readonly LiveToolOutputSnapshot[], runActive: boolean): void {
		this.clear();
		this.#runActive = runActive;
		for (const snapshot of snapshots.toSorted((a, b) => a.dispatchOrder - b.dispatchOrder)) {
			this.#calls.set(snapshot.toolCallId, snapshot);
			this.#dispatchOrder = Math.max(this.#dispatchOrder, snapshot.dispatchOrder);
			if (!snapshot.result) continue;
			const text = toolOutputText(snapshot.toolName, snapshot.result, snapshot.args);
			if (text) this.#remember(snapshot, text, -1);
		}
	}

	preview(project?: LiveToolOutputProjection): LiveToolOutputPreview | undefined {
		for (let i = this.#previews.length - 1; i >= 0; i--) {
			const preview = this.#previews[i]!;
			const text = project ? project(preview) : preview.text;
			// Eligibility precedes expiry: an eligible but expired source still blocks older Output.
			if (text) return text === preview.text ? preview : { call: preview.call, text };
		}
		return undefined;
	}

	get(toolCallId: string): LiveToolOutputSnapshot | undefined {
		return this.#calls.get(toolCallId);
	}

	snapshot(): readonly LiveToolOutputSnapshot[] {
		return [...this.#calls.values()];
	}

	observe(event: LocalAgentSessionEvent, receivedAt: number, dispatchOrder?: number): void {
		if (event.type === "agent_start") {
			for (const id of event.resumedToolCallIds ?? []) {
				const call = this.#calls.get(id);
				if (!call) continue;
				this.#calls.delete(id);
				const index = this.#previews.findIndex(preview => preview.call === call);
				if (index !== -1) this.#previews.splice(index, 1);
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			const order = dispatchOrder ?? this.#dispatchOrder + 1;
			if (this.#calls.has(event.toolCallId) || order < this.#floor) return;
			this.#dispatchOrder = Math.max(this.#dispatchOrder, order);
			this.#calls.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
				dispatchOrder: order,
			});
			return;
		}
		if (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return;
		const call = this.#calls.get(event.toolCallId);
		// The first overall terminal result is authoritative over late progress and startup receipts.
		if (!call || call.terminalAt !== undefined) return;
		const result: ToolResult<unknown> = event.type === "tool_execution_update" ? event.partialResult : event.result;
		const details = isRecord(result.details) ? result.details : undefined;
		const async = isRecord(details?.async) ? details.async : undefined;
		const updateArgs = event.type === "tool_execution_update" ? event.args : undefined;
		const args =
			updateArgs != null && (!isRecord(updateArgs) || Object.keys(updateArgs).length > 0) ? updateArgs : call.args;
		const cancelled = event.type === "tool_execution_end" && event.cancelled === true;
		const isStartupReceipt = event.type === "tool_execution_end" && async?.state === "running" && !cancelled;
		if (
			async?.state === "completed" ||
			async?.state === "failed" ||
			async?.state === "cancelled" ||
			(event.type === "tool_execution_end" && !isStartupReceipt)
		) {
			call.terminalAt = receivedAt;
			if (!this.#runActive) call.expiresAt = receivedAt + 3000;
		}
		const isError = event.type === "tool_execution_end" ? event.isError : undefined;
		const previous = call.result;
		const previewIndex = previous ? this.#previews.findLastIndex(preview => preview.call === call) : -1;
		const hadOutput = previewIndex !== -1;
		// A startup receipt may contain an older buffered preview. It can seed a body,
		// but must not backdate actual progress already received from the same job.
		const candidate =
			isStartupReceipt && hadOutput ? undefined : withOutputFacts(result, previous, result, cancelled, isError);
		const text = candidate && toolOutputText(call.toolName, candidate, args);
		if (candidate && text) {
			call.args = args;
			call.result = candidate;
			this.#remember(call, text, previewIndex);
		} else if (call.terminalAt !== undefined && !hadOutput) {
			this.#calls.delete(call.toolCallId);
		} else {
			// Keep the earlier body, but incorporate lifecycle and dispatch facts. Those
			// facts can change which parts of the body qualify as displayable output.
			call.args ??= args;
			const merged = withOutputFacts(previous ?? { content: [] }, previous, result, cancelled, isError);
			call.result = merged;
			if (hadOutput) {
				const text =
					merged === previous
						? this.#previews[previewIndex]!.text
						: toolOutputText(call.toolName, merged, call.args);
				this.#remember(call, text, previewIndex);
			}
		}
	}

	#remember(call: LiveToolOutputSnapshot, text: string, index: number): void {
		const previews = this.#previews;
		if (index === -1) {
			index = previews.findLastIndex(preview => preview.call.dispatchOrder < call.dispatchOrder) + 1;
			previews.splice(index, 0, { call, text });
		} else if (previews[index]!.text !== text) {
			previews[index] = { call, text };
		}
		// File results are provisional until the view knows which lines the Diff covers.
		// Other results supersede older sources permanently, including after expiry.
		if (!text || call.dispatchOrder <= this.#floor || mayBeCoveredByFileDiff(call)) return;
		this.#prune(call.dispatchOrder, index);
	}

	#prune(order: number, previewCount: number): void {
		this.#floor = order;
		if (previewCount > 0) this.#previews.splice(0, previewCount);
		for (const [id, older] of this.#calls) {
			if (older.dispatchOrder < this.#floor) this.#calls.delete(id);
		}
	}
}
