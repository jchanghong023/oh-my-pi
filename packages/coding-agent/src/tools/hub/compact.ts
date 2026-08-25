import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import compactHubDescription from "../../prompts/tools/hub-compact.md" with { type: "text" };
import type { ToolSession } from "..";
import { HubTool, hubApproval } from "./index";
import { hubSchema } from "./schema";
import { type HubDetails, hubErrorResult } from "./types";

export const compactHubSchema = hubSchema
	.omit("op", "to", "message", "replyTo", "await", "from", "timeoutMs", "peek", "status", "limit")
	.and({
		op: type(
			"'send' | 'wait' | 'jobs' | 'cancel' | 'start' | 'ps' | 'logs' | 'stop' | 'restart' | 'describe'",
		).describe("hub operation"),
		"timeoutMs?": type("number").describe("wait (jobs): timeout in milliseconds (0 waits indefinitely)"),
	});

type CompactHubParams = typeof compactHubSchema.infer;

/** Model-facing Hub surface for job control and supervised processes. */
export class CompactHubTool implements AgentTool<typeof compactHubSchema, HubDetails> {
	readonly name = "hub";
	readonly approval = hubApproval;
	readonly label = "Hub";
	readonly summary = "Control background jobs and supervise long-running processes";
	readonly description = prompt.render(compactHubDescription);
	readonly parameters = compactHubSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly interruptible = (params: Partial<CompactHubParams>): boolean => {
		if (params.op === "wait") return true;
		return params.op === "logs" && params.follow === true;
	};
	readonly examples: readonly ToolExample<CompactHubParams>[] = [
		{ caption: "Wait for the first background job to settle", call: { op: "wait" } },
		{ caption: "Cancel a hung background job", call: { op: "cancel", ids: ["task_a1b2c3"] } },
		{ caption: "Snapshot every background job without waiting", call: { op: "jobs" } },
		{
			caption: "Start a dev server and wait for readiness",
			call: { op: "start", name: "web", application: "bun", args: ["run", "dev"], ready: { port: 5173 } },
		},
		{ caption: "Follow process output", call: { op: "logs", name: "web", follow: true, timeout: 30 } },
		{ caption: "Send input to a process", call: { op: "send", name: "debugger", text: "continue" } },
		{ caption: "Wait for a process to exit", call: { op: "wait", name: "web", for: "exit", timeout: 30 } },
	];

	readonly #delegate: HubTool;

	constructor(session: ToolSession) {
		this.#delegate = new HubTool(session, { peerMessagingVisible: false });
	}

	async execute(
		toolCallId: string,
		params: CompactHubParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<HubDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<HubDetails>> {
		if (params.op === "send" && !params.name?.trim()) {
			return hubErrorResult('`name` is required for op="send" in compact Hub mode.', { op: "send" });
		}
		return this.#delegate.execute(toolCallId, params, signal, onUpdate, context);
	}
}

export function createHubTool(session: ToolSession): HubTool | CompactHubTool {
	return session.settings.get("hub.mode") === "full" ? new HubTool(session) : new CompactHubTool(session);
}
