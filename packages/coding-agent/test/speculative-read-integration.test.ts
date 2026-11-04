import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentMessage, agentLoop } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSpeculativeToolExecutionConfig } from "@oh-my-pi/pi-coding-agent/speculation/host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { withExecutionModelContext } from "@oh-my-pi/pi-coding-agent/session/execution-model";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

function createSession(cwd: string, enabled = true): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"images.autoResize": false,
			"tools.speculativeExecution.enabled": enabled,
			"task.speculativeLaunch": false,
		}),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("enabled speculative local reads", () => {
	it.each([true, false])(
		"honors speculative execution=%s for a recovery request and commits one normal result",
		async enabled => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-read-"));
			temporaryDirectories.push(directory);
			await fs.writeFile(path.join(directory, "note.txt"), "content");
			const session = createSession(directory, enabled);
			const tool = new ReadTool(session);
			const finalized = tool.speculation.finalized;
			if (!finalized) throw new Error("read tool has no finalized speculation policy");
			const execute = finalized.execute;
			const started = Promise.withResolvers<void>();
			let providerDone = false;
			let startedBeforeProviderDone = false;
			finalized.execute = async (context, signal) => {
				startedBeforeProviderDone = !providerDone;
				started.resolve();
				return await execute(context, signal);
			};
			const config = createSpeculativeToolExecutionConfig(session.settings, session, { hasHandlers: () => false });
			const mock = createMockModel({ responses: [] });
			let turn = 0;
			const streamFn = (_model: unknown, _context: Context) => {
				const response = new AssistantMessageEventStream();
				void (async () => {
					if (turn++ === 0) {
						const toolCall = {
							type: "toolCall" as const,
							id: "read-1",
							name: "read",
							arguments: { path: "note.txt" },
						};
						const partial = assistant([toolCall], "toolUse");
						response.push({ type: "start", partial });
						response.push({ type: "toolcall_start", contentIndex: 0, partial });
						response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
						if (enabled) await started.promise;
						providerDone = true;
						response.push({ type: "done", reason: "toolUse", message: partial });
						return;
					}
					const partial = assistant([{ type: "text", text: "done" }], "stop");
					response.push({ type: "start", partial });
					response.push({ type: "done", reason: "stop", message: partial });
				})();
				return response;
			};

			const messages = await withExecutionModelContext(
				{ model: mock.model, recoverModelRequest: async () => undefined },
				() =>
					agentLoop(
						[{ role: "user", content: "Read the note", timestamp: Date.now() }],
						{ systemPrompt: [""], messages: [], tools: [tool] },
						{
							model: mock.model,
							convertToLlm: identityConverter,
							speculativeToolExecution: config,
						},
						undefined,
						streamFn,
					).result(),
			);

			expect(startedBeforeProviderDone).toBe(enabled);
			const results = messages.filter(message => message.role === "toolResult");
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({
				toolCallId: "read-1",
				toolName: "read",
				isError: false,
				content: [expect.objectContaining({ type: "text", text: expect.stringContaining("content") })],
			});
		},
	);

	// Recovery requests retain the upstream abort/discard boundary even after a real speculative read.
	it("discards a recovery request's speculative read when the request is cancelled", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-recovery-abort-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "cancelled content must not commit");
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const finalized = tool.speculation.finalized;
		if (!finalized) throw new Error("Expected finalized read speculation");
		const execute = finalized.execute;
		const physicalRead = Promise.withResolvers<void>();
		let executionSignal: AbortSignal | undefined;
		finalized.execute = async (context, signal) => {
			await execute(context, signal);
			executionSignal = signal;
			const cancelled = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
			physicalRead.resolve();
			await cancelled.promise;
			signal.throwIfAborted();
			throw new Error("Cancelled physical read must not return a successful outcome");
		};
		const config = createSpeculativeToolExecutionConfig(session.settings, session, { hasHandlers: () => false });
		if (!config.host) throw new Error("Expected speculative host");
		const commit = spyOn(config.host, "commit");
		const discard = spyOn(config.host, "discard");
		const controller = new AbortController();
		const mock = createMockModel({ responses: [] });
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const toolCall = {
					type: "toolCall" as const,
					id: "read-abort",
					name: "read",
					arguments: { path: "note.txt" },
				};
				const partial = assistant([toolCall], "toolUse");
				stream.push({ type: "start", partial });
				stream.push({ type: "toolcall_start", contentIndex: 0, partial });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
				await physicalRead.promise;
				controller.abort(new Error("recovery request cancelled"));
				stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } });
			})();
			return stream;
		};
		try {
			const messages = await withExecutionModelContext(
				{ model: mock.model, recoverModelRequest: async () => undefined },
				() =>
					agentLoop(
						[{ role: "user", content: "read the note", timestamp: Date.now() }],
						{ systemPrompt: [""], messages: [], tools: [tool] },
						{ model: mock.model, convertToLlm: identityConverter, speculativeToolExecution: config },
						controller.signal,
						streamFn,
					).result(),
			);

			expect(executionSignal?.aborted).toBe(true);
			expect(commit).not.toHaveBeenCalled();
			expect(discard).toHaveBeenCalled();
			expect(messages.filter(message => message.role === "toolResult" && !message.isError)).toEqual([]);
		} finally {
			controller.abort();
			discard.mockRestore();
			commit.mockRestore();
		}
	});
});
