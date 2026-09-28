/**
 * Fork-extension session-state completion (requirement 5.8, rpc-ui-protocol.md).
 *
 * `submit_feedback` appends a lightweight local record (config-root jsonl, no
 * upstream reporting — this fork has none). Hook telemetry (`hook_executed`
 * frames) is emitted through {@link RpcForkHookTelemetry}, which classifies an
 * extension path into the user/workspace/plugin source buckets and forwards
 * per-handler duration/outcome from the extension runner.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { GoalModeState } from "../../goals/state";
import type { AgentSession } from "../../session/agent-session";
import type { RpcForkHost } from "./rpc-fork-host";
import type { RpcForkCommandBase, RpcForkHookExecutedFrame } from "./rpc-fork-types";
import type { RpcResponse } from "./rpc-types";

export interface RpcForkFeedbackRecord {
	timestamp: string;
	sessionId: string;
	messageId: string;
	rating: "up" | "down";
	comment?: string;
}

/** Static helpers for v3 additions to stock responses (`get_state.goal`). */
export class RpcForkStateController {
	static goalSnapshot(
		session: AgentSession,
	): { goal: { goal: Goal; state: GoalModeState; iteration: number } } | undefined {
		const mode = session.getGoalModeState();
		if (!mode) return undefined;
		return { goal: { goal: mode.goal, state: mode, iteration: mode.goal.iteration ?? 0 } };
	}
}

export class RpcForkFeedbackController {
	readonly #file: string;

	constructor(
		private readonly host: RpcForkHost,
		private readonly session: AgentSession,
		options?: { agentDir?: string },
	) {
		this.#file = path.join(options?.agentDir ?? getAgentDir(), "feedback.jsonl");
		host.registerCommand("submit_feedback", command => this.#submitFeedback(command));
	}

	/** Query surface: the jsonl file itself (`<configRoot>/agent/feedback.jsonl`). */
	get feedbackFile(): string {
		return this.#file;
	}

	async #submitFeedback(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { messageId, rating, comment } = command as { messageId?: unknown; rating?: unknown; comment?: unknown };
		if (typeof messageId !== "string" || !messageId) {
			return this.host.context.error(command.id, "submit_feedback", "messageId is required");
		}
		if (rating !== "up" && rating !== "down") {
			return this.host.context.error(command.id, "submit_feedback", `Invalid rating: ${String(rating)}`);
		}
		if (comment !== undefined && typeof comment !== "string") {
			return this.host.context.error(command.id, "submit_feedback", "comment must be a string");
		}
		const record: RpcForkFeedbackRecord = {
			timestamp: new Date().toISOString(),
			sessionId: this.session.sessionId,
			messageId,
			rating,
			...(typeof comment === "string" && comment.trim() ? { comment: comment.trim() } : {}),
		};
		const file = this.#file;
		try {
			await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf-8");
		} catch (error) {
			return this.host.context.error(
				command.id,
				"submit_feedback",
				`Failed to store feedback: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return this.host.context.success(command.id, "submit_feedback", { stored: true, file });
	}
}

export type RpcForkHookSource = RpcForkHookExecutedFrame["source"];

/**
 * Emits `hook_executed` frames from extension-runner telemetry. The runner
 * reports path-relative facts; this class classifies the extension source
 * (user config dir → "user", session cwd subtree → "workspace", else
 * "plugin") and stamps wire frames. Inactive until v3 is negotiated, so the
 * runner carries no per-frame cost for v1/v2 clients.
 */
export class RpcForkHookTelemetry {
	constructor(
		private readonly host: RpcForkHost,
		private readonly session: AgentSession,
	) {}

	/** Listener installed on the extension runner via `setHookExecutedListener`. */
	onHookExecuted(info: {
		extensionPath: string;
		event: string;
		durationMs: number;
		status: "ok" | "timeout" | "error" | "aborted";
		reason?: string;
	}): void {
		if (!this.host.isActive) return;
		const frame: RpcForkHookExecutedFrame = {
			type: "hook_executed",
			hookId: path.basename(info.extensionPath),
			event: info.event,
			source: RpcForkHookTelemetry.classifySource(info.extensionPath, this.session.sessionManager.getCwd()),
			durationMs: Math.max(0, Math.round(info.durationMs)),
			status: info.status,
			...(info.reason ? { reason: info.reason } : {}),
		};
		this.host.context.emit(frame);
	}

	static classifySource(extensionPath: string, cwd: string): RpcForkHookSource {
		const normalized = path.normalize(extensionPath).toLowerCase();
		const agentDir = path.normalize(getAgentDir()).toLowerCase();
		if (normalized.startsWith(agentDir + path.sep) || normalized === agentDir) return "user";
		const projectDir = path.normalize(cwd).toLowerCase();
		if (normalized.startsWith(projectDir + path.sep) || normalized === projectDir) return "workspace";
		return "plugin";
	}
}
