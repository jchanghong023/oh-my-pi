import { toolOutputSource, toolOutputText } from "@oh-my-pi/pi-tui/tools/output-preview";
import type { ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "./agent-session-events";
import type { LiveToolOutputSnapshot } from "./agent-session-handle";

/**
 * Keep display source and lifecycle facts independent of which frame supplies the body.
 * In particular, an empty read's displayContent or Bash's output notices must not be
 * applied to an earlier valid body.
 */
function withOutputFacts(
	toolName: string,
	body: ToolRenderResult<unknown>,
	previous: ToolRenderResult<unknown> | undefined,
	incoming: ToolRenderResult<unknown>,
	cancelled: boolean,
	isError: boolean | undefined,
): ToolRenderResult<unknown> {
	const source = toolOutputSource(toolName, body);
	const before = toolOutputSource(toolName, previous);
	const update = toolOutputSource(toolName, incoming);
	const dispatch = update.dispatch || before.dispatch;
	const previousJob = isRecord(before.details?.async) ? before.details.async : undefined;
	const nextJob = isRecord(update.details?.async) ? update.details.async : undefined;
	const bodyJob = isRecord(source.details?.async) ? source.details.async : undefined;
	const job =
		nextJob &&
		previousJob &&
		((nextJob.name === undefined && previousJob.name !== undefined) ||
			(nextJob.jobId === undefined && previousJob.jobId !== undefined) ||
			(nextJob.state === undefined && previousJob.state !== undefined))
			? { ...previousJob, ...nextJob }
			: (nextJob ?? previousJob);
	const wasCancelled = cancelled || update.details?.cancelled === true || before.details?.cancelled === true;
	const failed =
		incoming.isError === true || isError === true ? true : (isError ?? incoming.isError ?? previous?.isError);
	if (
		dispatch === source.dispatch &&
		!(dispatch && dispatch.args === undefined && before.dispatch?.args !== undefined) &&
		job === bodyJob &&
		(!wasCancelled || source.details?.cancelled === true) &&
		failed === body.isError
	)
		return body;
	const details = {
		...source.details,
		...(job ? { async: job } : {}),
		...(wasCancelled ? { cancelled: true } : {}),
	};
	return {
		...body,
		isError: failed,
		details: dispatch
			? { xdev: { ...before.dispatch, ...dispatch, args: dispatch.args ?? before.dispatch?.args, inner: details } }
			: details,
	};
}

/** Dispatch facts for the in-flight calls and the latest real Output, never transcript history. */
export class LiveToolOutputState {
	readonly #calls = new Map<string, LiveToolOutputSnapshot>();
	#dispatchOrder = 0;
	#latestOutputOrder = 0;
	#runActive = false;

	clear(): void {
		this.#calls.clear();
		this.#dispatchOrder = 0;
		this.#latestOutputOrder = 0;
	}

	setRunActive(active: boolean, at: number): void {
		if (active === this.#runActive) return;
		this.#runActive = active;
		for (const call of this.#calls.values()) {
			if (call.terminalAt === undefined) continue;
			if (active) {
				// Keep a still-visible source during a new run, but never revive an expired one.
				if (call.expiresAt !== undefined && call.expiresAt > at) call.expiresAt = undefined;
			} else if (call.expiresAt === undefined) {
				call.expiresAt = Math.max(call.terminalAt, at) + 3000;
			}
		}
	}

	restore(snapshots: readonly LiveToolOutputSnapshot[], runActive: boolean): void {
		this.clear();
		this.#runActive = runActive;
		for (const snapshot of snapshots) {
			this.#calls.set(snapshot.toolCallId, snapshot);
			this.#dispatchOrder = Math.max(this.#dispatchOrder, snapshot.dispatchOrder);
			if (snapshot.result && toolOutputText(snapshot.toolName, snapshot.result, snapshot.args)) {
				this.#latestOutputOrder = Math.max(this.#latestOutputOrder, snapshot.dispatchOrder);
			}
		}
		this.#prune();
	}

	snapshot(): readonly LiveToolOutputSnapshot[] {
		return [...this.#calls.values()];
	}

	observe(event: AgentSessionEvent, receivedAt: number, dispatchOrder?: number): void {
		if (event.type === "tool_execution_start") {
			const order = dispatchOrder ?? this.#dispatchOrder + 1;
			if (this.#calls.has(event.toolCallId) || order < this.#latestOutputOrder) return;
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
		const result: ToolRenderResult<unknown> =
			event.type === "tool_execution_update" ? event.partialResult : event.result;
		const { details } = toolOutputSource(call.toolName, result);
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
		const hadOutput = call.dispatchOrder === this.#latestOutputOrder;
		// A startup receipt may contain an older buffered preview. It can seed a body,
		// but must not backdate actual progress already received from the same job.
		const candidate =
			isStartupReceipt && hadOutput
				? undefined
				: withOutputFacts(call.toolName, result, previous, result, cancelled, isError);
		if (candidate && toolOutputText(call.toolName, candidate, args)) {
			call.args = args;
			call.result = candidate;
			this.#latestOutputOrder = call.dispatchOrder;
			this.#prune();
		} else if (call.terminalAt !== undefined && !hadOutput) {
			this.#calls.delete(call.toolCallId);
		} else {
			// A no-output receipt can have source facts used by later frames, or a terminal
			// result can annotate an earlier valid frame without changing that frame's content.
			call.args ??= args;
			call.result = withOutputFacts(
				call.toolName,
				previous ?? { content: [] },
				previous,
				result,
				cancelled,
				isError,
			);
		}
	}

	#prune(): void {
		// Older calls cannot reclaim the preview, even while they keep executing.
		for (const [id, call] of this.#calls) {
			if (call.dispatchOrder < this.#latestOutputOrder) this.#calls.delete(id);
		}
	}
}
