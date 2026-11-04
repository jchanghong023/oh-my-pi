import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { SessionManager } from "../src/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type Mode = "skipped" | "approval" | "executing" | "completed" | "non-interruptible";
async function resultsFor(mode: Mode) {
	const controller = new AbortController();
	const schema = type({ value: "string" });
	const executed: string[] = [];
	const tool: AgentTool<typeof schema> = {
		name: "runtime_probe",
		label: "Runtime probe",
		description: "Contract side effect",
		parameters: schema,
		concurrency: "exclusive",
		interruptible: mode !== "non-interruptible",
		async execute(_id, args) {
			executed.push(args.value);
			if (mode === "executing") {
				controller.abort("user cancellation");
				throw new Error("cancelled during tool execution");
			}
			return { content: [{ type: "text", text: `result:${args.value}` }], details: { exitCode: 7 } };
		},
	};
	const mock = createMockModel({
		responses: [
			{
				content: [
					{ type: "toolCall", id: "first", name: tool.name, arguments: { value: "first" } },
					...(mode === "skipped" || mode === "non-interruptible"
						? [{ type: "toolCall" as const, id: "second", name: tool.name, arguments: { value: "second" } }]
						: []),
				],
			},
			{ content: ["finished"] },
		],
	});
	let steeringTaken = false;
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: messages =>
			messages.filter(message => ["user", "assistant", "toolResult"].includes(message.role)) as Message[],
		interruptMode: "immediate",
		hasSteeringMessages: () =>
			(mode === "skipped" || mode === "non-interruptible") && executed.length > 0 && !steeringTaken,
		getSteeringMessages: async () => {
			if ((mode !== "skipped" && mode !== "non-interruptible") || steeringTaken || !executed.length) return [];
			steeringTaken = true;
			return [{ role: "user", content: "interrupt", timestamp: 2 }];
		},
		beforeToolCall: () => {
			if (mode === "approval") {
				controller.abort("cancelled while awaiting approval");
				throw new Error("approval cancelled");
			}
		},
		afterToolCall: () => {
			if (mode === "completed") controller.abort("late user cancellation");
		},
	};
	const stream = agentLoop(
		[{ role: "user", content: "start", timestamp: 1 }],
		{ systemPrompt: [""], messages: [], tools: [tool] },
		config,
		controller.signal,
		mock.stream,
	);
	for await (const _event of stream) {
		/* Drain the production loop's event stream. */
	}
	const messages = await stream.result();
	return {
		messages,
		executed,
		results: messages.filter((message): message is ToolResultMessage => message.role === "toolResult"),
	};
}

async function persistedResults(messages: AgentMessage[]) {
	using root = TempDir.createSync("@omp-runtime-cancellation-");
	const writer = SessionManager.create(root.path(), root.join("sessions"));
	let reopened: SessionManager | undefined;
	let forked: SessionManager | undefined;
	try {
		for (const message of messages) writer.appendMessage(message as Message);
		await writer.flush();
		const file = writer.getSessionFile();
		if (!file) throw new Error("Expected a persisted session");
		await writer.close();
		reopened = await SessionManager.open(file);
		forked = await SessionManager.forkFrom(file, root.path(), root.join("forks"), undefined, {
			suppressBreadcrumb: true,
			copyArtifacts: false,
		});
		const select = (manager: SessionManager) =>
			manager.buildSessionContext().messages.filter(message => message.role === "toolResult");
		return { reopened: select(reopened), forked: select(forked) };
	} finally {
		await forked?.close();
		await reopened?.close();
		await writer.close();
	}
}

describe("interrupted tool result cancellation survives durable consumers", () => {
	it.each(["skipped", "approval", "executing"] as const)(
		"persists cancelled=true and isError for %s tools",
		async mode => {
			const run = await resultsFor(mode);
			const cancelledId = mode === "skipped" ? "second" : "first";
			const cancelled = run.results.find(result => result.toolCallId === cancelledId);
			expect(cancelled).toMatchObject({ isError: true, cancelled: true });
			expect(run.executed).toEqual(mode === "approval" ? [] : ["first"]);
			const restored = await persistedResults(run.messages);
			for (const copy of [restored.reopened, restored.forked]) {
				expect(copy.find(result => result.toolCallId === cancelledId)).toEqual(cancelled);
			}
			if (mode === "skipped")
				expect(run.results[0]).toMatchObject({
					content: [{ type: "text", text: "result:first" }],
					details: { exitCode: 7 },
					isError: false,
				});
		},
	);

	it.each(["completed", "non-interruptible"] as const)(
		"retains real results for %s work despite later interruption",
		async mode => {
			const run = await resultsFor(mode);
			expect(run.executed).toEqual(mode === "completed" ? ["first"] : ["first", "second"]);
			expect(run.results).toHaveLength(run.executed.length);
			for (const result of run.results) {
				expect(result).not.toHaveProperty("cancelled");
				expect(result).toMatchObject({
					content: [{ type: "text", text: `result:${result.toolCallId}` }],
					details: { exitCode: 7 },
					isError: false,
				});
			}
			const restored = await persistedResults(run.messages);
			expect(restored.reopened).toEqual(run.results);
			expect(restored.forked).toEqual(run.results);
		},
	);
});
