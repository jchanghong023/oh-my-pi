/**
 * 缺陷 G02 回归(队列自动 drain 没有计算待输入预算并提前压缩):
 *
 * 文本完成的 turn(willContinue=false)若待消费队列非空,agent loop 马上会在
 * yield 边界自动 drain 队列输入作为下一个 prompt。queued 输入的 pending token
 * 必须与直接 prompt 一样计入待输入预算:超阈值先 auto compact,再消费队列
 * 首条。直接 prompt 路径由 runPrePromptCompactionIfNeeded 覆盖,这里钉住队列
 * 路径的同一边界。
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession queued drain pending-budget compaction (G02)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await tempDir?.remove();
		vi.restoreAllMocks();
	});

	async function createSession(responses: MockHandler[], tool?: AgentTool): Promise<void> {
		tempDir = TempDir.createSync("@pi-queued-drain-compaction-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const mock = createMockModel({
			responses,
			contextWindow: 128_000,
			maxTokens: 8_000,
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([mock]);

		// short-circuit 压缩,避免压缩摘要本身再打一次 mock provider。
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => ({',
				"\t\tcompaction: {",
				'\t\t\tsummary: "compacted",',
				"\t\t\tshortSummary: undefined,",
				"\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\tdetails: {},",
				"\t\t},",
				"\t}));",
				"}",
			].join("\n"),
		);
		const loaded = await loadExtensions([extensionPath], tempDir.path());

		const sessionManager = SessionManager.inMemory(tempDir.path());
		const extensionRunner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		// Seed a minimal branch so prepareCompaction() returns a preparation.
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test"], tools: tool ? [tool] : [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdTokens": 30_000,
				"compaction.midTurnEnabled": true,
				"compaction.autoContinue": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
			modelRegistry,
			extensionRunner,
			toolRegistry: tool ? new Map([[tool.name, tool]]) : undefined,
		});
	}

	it("compacts before auto-draining a queued follow-up whose pending tokens cross the threshold", async () => {
		const queuedPrompt = `queued follow-up ${"p".repeat(20_000)}`;
		let compactionBeforeSecondCall = false;
		let secondCallHasQueuedPrompt = false;
		let secondCallHasCompactionSummary = false;
		let secondModelCall = false;

		await createSession([
			() => {
				// 第一个 provider 调用:模拟运行中排队的普通输入(source sendText),
				// 随后文本完成 —— usage 29900+12=29912,单独低于 30000 阈值。
				session.agent.followUp({ role: "user", content: queuedPrompt, timestamp: Date.now() });
				return { content: ["first done"], usage: { input: 29_900, output: 12 } };
			},
			context => {
				secondModelCall = true;
				compactionBeforeSecondCall = session.sessionManager.getBranch().some(entry => entry.type === "compaction");
				for (const message of context.messages) {
					const text = JSON.stringify(
						"content" in message ? message.content : ((message as { text?: string }).text ?? ""),
					);
					if (text.includes("queued follow-up")) secondCallHasQueuedPrompt = true;
					if (text.includes("compacted")) secondCallHasCompactionSummary = true;
				}
				return { content: ["second done"], usage: { input: 100, output: 5 } };
			},
		]);

		await session.prompt("kick off");

		// 队列输入确实被消费(不是队列卡住)。
		expect(secondModelCall).toBe(true);
		expect(secondCallHasQueuedPrompt).toBe(true);
		// 队列待输入预算把 29912 推过 30000 阈值:压缩必须发生在消费队列首条之前。
		expect(compactionBeforeSecondCall).toBe(true);
		expect(secondCallHasCompactionSummary).toBe(true);
	});

	// The local-history arm must still win when provider usage under-reports stored text.
	it("budgets queued input on top of the larger local estimate and preserves FIFO consumption", async () => {
		const first = `first queued ${"q".repeat(20_000)}`;
		const second = "second queued";
		const consumed: string[] = [];
		await createSession([
			() => {
				session.agent.followUp({ role: "user", content: first, timestamp: Date.now() });
				session.agent.followUp({ role: "user", content: second, timestamp: Date.now() });
				return { content: ["h".repeat(112_000)], usage: { input: 100, output: 12 } };
			},
			context => {
				expect(session.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
				const latest = context.messages.findLast(message => message.role === "user");
				consumed.push(JSON.stringify(latest?.content));
				return { content: ["first delivered"], usage: { input: 100, output: 5 } };
			},
			context => {
				const latest = context.messages.findLast(message => message.role === "user");
				consumed.push(JSON.stringify(latest?.content));
				return { content: ["second delivered"], usage: { input: 100, output: 5 } };
			},
		]);

		await session.prompt("kick off");

		expect(consumed).toHaveLength(2);
		expect(consumed[0]).toContain("first queued");
		expect(consumed[0]).not.toContain("second queued");
		expect(consumed[1]).toContain("second queued");
		expect(session.agent.peekFollowUpQueue()).toEqual([]);
	});

	it("compacts before draining steering at a stop boundary", async () => {
		const queuedPrompt = `queued steering ${"s".repeat(20_000)}`;
		let calls = 0;
		await createSession([
			() => {
				calls++;
				session.agent.steer({ role: "user", content: queuedPrompt, timestamp: Date.now() });
				return { content: ["first done"], usage: { input: 29_900, output: 12 } };
			},
			context => {
				calls++;
				expect(session.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
				expect(JSON.stringify(context.messages)).toContain("queued steering");
				expect(JSON.stringify(context.messages)).toContain("compacted");
				return { content: ["second done"], usage: { input: 100, output: 5 } };
			},
		]);

		await session.prompt("kick off");

		expect(calls).toBe(2);
		expect(session.agent.peekSteeringQueue()).toEqual([]);
	});

	it("does not compact for a queued follow-up left behind by a terminal yield", async () => {
		const queued = { role: "user" as const, content: "queued input ".repeat(16_000), timestamp: Date.now() };
		const yieldTool: AgentTool = {
			name: "yield",
			label: "Yield",
			description: "Completes this run",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text", text: "Result submitted." }] }),
		};
		let calls = 0;
		await createSession(
			[
				() => {
					calls++;
					session.agent.followUp(queued);
					return {
						content: [{ type: "toolCall", id: "terminal-yield", name: "yield", arguments: {} }],
						usage: { input: 29_900, output: 12 },
					};
				},
			],
			yieldTool,
		);
		let maintenanceStarts = 0;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") maintenanceStarts++;
		});

		await session.prompt("kick off");

		expect(calls).toBe(1);
		expect(session.agent.peekFollowUpQueue()).toEqual([queued]);
		expect(maintenanceStarts).toBe(0);
		const branch = session.sessionManager.getBranch();
		expect(branch.some(entry => entry.type === "compaction")).toBe(false);
		expect(branch).toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({ role: "toolResult", toolCallId: "terminal-yield", isError: false }),
			}),
		);
	});

	it("does not compact a below-threshold stop boundary when the queue is empty", async () => {
		let compactionEntries = 0;
		await createSession([
			() => ({ content: ["first done"], usage: { input: 29_900, output: 12 } }),
			() => {
				compactionEntries = session.sessionManager.getBranch().filter(entry => entry.type === "compaction").length;
				return { content: ["second done"], usage: { input: 100, output: 5 } };
			},
		]);

		await session.prompt("kick off");
		// 同一 usage,但两次都是直接 prompt 路径且单次都低于阈值,不应产生压缩。
		await session.prompt("second direct prompt");
		expect(compactionEntries).toBe(0);
		expect(session.sessionManager.getBranch().filter(entry => entry.type === "compaction")).toEqual([]);
	});
});
