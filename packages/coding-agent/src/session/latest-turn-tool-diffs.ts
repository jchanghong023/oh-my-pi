import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { Operation } from "../tools/details/edit";
import type { ToolResult } from "../ui/tools/contract";
import { toolOutputSource } from "./live-tool-output-text";

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
	readonly #bashArgs = new Map<string, unknown>();

	get(sessionId: string): readonly TurnToolDiff[] {
		if (this.#sessionId !== sessionId) this.start(sessionId);
		return this.#turn;
	}

	start(sessionId: string): void {
		this.#sessionId = sessionId;
		this.#turn = [];
		this.#bashArgs.clear();
	}

	observe(sessionId: string, event: ToolExecutionEvent): void {
		const { toolName, toolCallId } = event;
		if (toolName !== "bash" && toolName !== "edit" && toolName !== "apply_patch" && toolName !== "write") return;
		if (this.#sessionId !== sessionId) this.start(sessionId);

		if (event.type !== "tool_execution_end") {
			if (toolName === "bash") {
				const args: unknown = event.args;
				// Progress carries the actual execution args; the start can precede an argument transform.
				if (
					event.type === "tool_execution_start" ||
					(this.#bashArgs.has(toolCallId) && isRecord(args) && typeof args.command === "string")
				) {
					this.#bashArgs.set(toolCallId, args);
				}
			}
			return;
		}

		const args = toolName === "bash" ? this.#bashArgs.get(toolCallId) : undefined;
		if (toolName === "bash") this.#bashArgs.delete(toolCallId);
		const result: ToolResult<unknown> | undefined = event.result;
		if (event.cancelled) return;
		const { name, details, dispatch, shellDetails } = toolOutputSource(toolName, result, args);
		if (!details || details.cancelled === true || (name === "write" && details.touchesNoFiles === true)) return;
		if (
			shellDetails?.cancelled ||
			shellDetails?.timedOut ||
			(shellDetails?.async && shellDetails.async.state !== "completed")
		) {
			return;
		}

		// Conflict writes report committed files separately from the call's failure.
		if (name === "write" && Array.isArray(details.conflictChanges)) {
			for (const file of details.conflictChanges) this.#append(toolCallId, file);
			return;
		}
		if (
			event.isError ||
			result?.isError ||
			details.isError === true ||
			(shellDetails &&
				(dispatch?.exitCode !== 0 || (shellDetails.exitCode !== undefined && shellDetails.exitCode !== 0)))
		) {
			return;
		}

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
