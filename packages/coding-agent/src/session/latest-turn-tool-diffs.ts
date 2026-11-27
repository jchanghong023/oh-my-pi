import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { BashToolDetails } from "../tools/details/bash";
import type { Operation } from "../tools/details/edit";
import type { ToolResult } from "../ui/tools/contract";

export interface TurnToolDiff {
	readonly toolCallId: string;
	/** Result path, which is the destination for a rename. */
	readonly path: string;
	readonly diff: string;
	readonly firstChangedLine?: number;
	readonly op?: Operation;
	readonly sourcePath?: string;
	readonly move?: string;
}

type ToolExecutionEvent = Extract<
	AgentEvent,
	{ type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
>;

/** Only native diff metadata from completed tool results, never streamed previews or history. */
export class LatestTurnToolDiffs {
	#sessionId = "";
	#turn: TurnToolDiff[] = [];
	readonly #pendingBash = new Set<string>();

	get(sessionId: string): readonly TurnToolDiff[] {
		if (this.#sessionId !== sessionId) this.start(sessionId);
		return this.#turn;
	}

	start(sessionId: string): void {
		this.#sessionId = sessionId;
		this.#turn = [];
		this.#pendingBash.clear();
	}

	observe(sessionId: string, event: ToolExecutionEvent): void {
		const { toolName, toolCallId } = event;
		if (toolName !== "bash" && toolName !== "edit" && toolName !== "apply_patch" && toolName !== "write") return;
		if (this.#sessionId !== sessionId) this.start(sessionId);

		if (event.type === "tool_execution_start") {
			if (toolName === "bash") this.#pendingBash.add(toolCallId);
			return;
		}
		if (toolName === "bash") {
			const result: ToolResult<unknown> | undefined =
				event.type === "tool_execution_end" ? event.result : event.partialResult;
			const shell = result?.details as BashToolDetails | undefined;
			if (event.type === "tool_execution_update") {
				if (!shell?.async || shell.async.state === "running" || !this.#pendingBash.delete(toolCallId)) return;
			} else if (event.cancelled || event.isError || shell?.async?.state !== "running") {
				this.#pendingBash.delete(toolCallId);
				if (event.cancelled || event.isError) return;
			}
			if (
				!shell?.toolCommands ||
				result?.isError ||
				shell.cancelled ||
				shell.timedOut ||
				(shell.exitCode !== undefined && shell.exitCode !== 0) ||
				(shell.async && shell.async.state !== "completed")
			) {
				return;
			}
			for (const { tool, mode, exitCode, inner } of shell.toolCommands) {
				if (mode === "execute" && exitCode === 0 && isRecord(inner)) this.#appendResult(toolCallId, tool, inner);
			}
			return;
		}

		if (event.type !== "tool_execution_end" || event.cancelled) return;
		const result: ToolResult<unknown> | undefined = event.result;
		const details = result?.details;
		if (!isRecord(details) || details.cancelled === true || details.touchesNoFiles === true) return;

		// Conflict writes report committed files separately from the call's failure.
		if (toolName === "write" && Array.isArray(details.conflictChanges)) {
			for (const file of details.conflictChanges) this.#append(toolCallId, file);
			return;
		}
		if (event.isError || result?.isError) return;
		this.#appendResult(toolCallId, toolName, details);
	}

	#appendResult(toolCallId: string, name: string, details: Record<string, unknown>): void {
		if (details.cancelled === true || details.isError === true || details.touchesNoFiles === true) return;
		if (name === "write") {
			this.#append(toolCallId, details, details.resolvedPath);
		} else if (name === "edit" || name === "apply_patch") {
			if (Array.isArray(details.perFileResults)) {
				for (const file of details.perFileResults) this.#append(toolCallId, file);
			} else {
				this.#append(toolCallId, details);
			}
		}
	}

	#append(toolCallId: string, file: unknown, resolvedPath?: unknown): void {
		if (!isRecord(file) || file.isError === true || file.cancelled === true) return;
		const path = typeof file.path === "string" ? file.path : resolvedPath;
		const { diff, firstChangedLine, op, sourcePath, move } = file;
		if (typeof path !== "string" || !path || typeof diff !== "string") return;
		const rename = typeof move === "string" && move ? move : undefined;
		if (!diff && op !== "delete" && !rename) return;
		this.#turn.push({
			toolCallId,
			path,
			diff,
			firstChangedLine: typeof firstChangedLine === "number" ? firstChangedLine : undefined,
			op: op === "create" || op === "delete" || op === "update" ? op : undefined,
			sourcePath: typeof sourcePath === "string" ? sourcePath : undefined,
			move: rename,
		});
	}
}
