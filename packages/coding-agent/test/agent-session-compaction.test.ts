/**
 * E2E tests for AgentSession compaction behavior.
 *
 * These tests use real LLM calls (no mocking) to verify:
 * - Manual compaction works correctly
 * - Session persistence during compaction
 * - Compaction entry is saved to session file
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getCodeAgentModels } from "@oh-my-pi/pi-coding-agent/config/codeagent-provider";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "./utilities";

describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("AgentSession compaction e2e", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;
	let events: AgentSessionEvent[];
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		// Create temp directory for session files
		tempDir = path.join(os.tmpdir(), `omp-compaction-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		// Track events
		events = [];
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	async function createSession(inMemory = false) {
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tools = await createTools(toolSession);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => e2eApiKey("ANTHROPIC_API_KEY"),
			initialState: {
				model,
				systemPrompt: ["You are a helpful assistant. Be concise."],
				tools,
			},
		});

		sessionManager = inMemory ? SessionManager.inMemory() : SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1 });
		authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		// Subscribe to track events
		session.subscribe(event => {
			events.push(event);
		});

		return session;
	}

	it("should trigger manual compaction via compact()", async () => {
		await createSession();

		// Send a few prompts to build up history
		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		// Manually compact
		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.tokensBefore).toBeGreaterThan(0);

		// Verify messages were compacted (should have summary + recent)
		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		// First message should be the summary (a user message with summary content)
		const firstMsg = messages[0];
		expect(firstMsg.role).toBe("compactionSummary");
	}, 120000);

	it("should persist compaction to session file", async () => {
		await createSession();

		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		await session.prompt("Say goodbye");
		await session.agent.waitForIdle();

		// Compact
		await session.compact();

		// Load entries from session manager
		const entries = sessionManager.getEntries();

		// Should have a compaction entry
		const compactionEntries = entries.filter(e => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);

		const compaction = compactionEntries[0];
		expect(compaction.type).toBe("compaction");
		if (compaction.type === "compaction") {
			expect(compaction.summary.length).toBeGreaterThan(0);
			expect(typeof compaction.firstKeptEntryId).toBe("string");
			expect(compaction.tokensBefore).toBeGreaterThan(0);
		}
	}, 120000);

	it("should work with --no-session mode (in-memory only)", async () => {
		await createSession(true); // in-memory mode

		// Send prompts
		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		// Compact should work even without file persistence
		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);

		// In-memory entries should have the compaction
		const entries = sessionManager.getEntries();
		const compactionEntries = entries.filter(e => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);
	}, 120000);

	it("should emit correct events during auto-compaction", async () => {
		await createSession();

		// Build some history
		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		// Manually trigger compaction and check events
		await session.compact();

		// Check that no auto_compaction events were emitted for manual compaction
		const autoCompactionEvents = events.filter(
			e => e.type === "auto_compaction_start" || e.type === "auto_compaction_end",
		);
		// Manual compaction doesn't emit auto_compaction events
		expect(autoCompactionEvents.length).toBe(0);
	}, 120000);
});

describe("AgentSession CodeAgent terminal context maintenance", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
	});

	async function createTerminalSession(
		stopReason: "length" | "error",
		inputTokens: number,
		content: AssistantMessage["content"] = [{ type: "text", text: "Delivered partial result." }],
	) {
		const model = getCodeAgentModels()[0]!;
		const message: AssistantMessage = {
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason,
			...(stopReason === "error" ? { errorMessage: "prompt is too long: 250000 tokens > 200000 maximum" } : {}),
			usage: {
				input: inputTokens,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: inputTokens + 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "previous request", timestamp: message.timestamp - 2000 });
		manager.appendMessage({
			...message,
			content: [{ type: "text", text: "Previous completed work." }],
			stopReason: "stop",
			errorMessage: undefined,
			usage: { ...message.usage, input: 100, totalTokens: 120 },
			timestamp: message.timestamp - 1000,
		});
		let calls = 0;
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			streamFn: () => {
				calls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					if (stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: "length", message });
				});
				return stream;
			},
			initialState: { model, tools: [], messages: manager.buildSessionContext().messages },
		});
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("codeagent", "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.autoContinue": true,
			"compaction.methodOrder": ["context-full"],
			"compaction.keepRecentTokens": 1,
			"compaction.thresholdTokens": 160000,
			"compaction.asyncEnabled": false,
			"compaction.supersedeReads": false,
			"compaction.dropUseless": false,
		});
		// Short-circuit only summary generation at the existing extension boundary;
		// preparation, persisted history rewrite and continuation decisions stay real.
		const extensionRunner = {
			hasHandlers: (type: string) => type === "session_before_compact",
			emit: async (event: { type: string; preparation?: CompactionPreparation }) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				return {
					compaction: {
						summary: "Previous work summarized.",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			},
			emitBeforeAgentStart: async () => undefined,
		};
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			extensionRunner: extensionRunner as never,
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
		});
		// An active goal makes a successful maintenance pass eligible to continue;
		// terminal CodeAgent output must not turn that into another provider request.
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "codeagent-terminal",
				objective: "finish the current request",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		return { session, manager, events, providerCalls: () => calls };
	}

	it("warns about CodeAgent truncation below threshold and retains delivered output", async () => {
		const fixture = await createTerminalSession("length", 100);
		await fixture.session.prompt("current request");
		await fixture.session.waitForIdle();
		expect(fixture.events.filter(event => event.type === "notice" && event.level === "warning")).toEqual([
			expect.objectContaining({ source: "compaction", message: expect.stringContaining("truncated") }),
		]);
		expect(fixture.events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(fixture.session.messages.findLast(message => message.role === "assistant")).toMatchObject({
			role: "assistant",
			stopReason: "length",
			content: [{ type: "text", text: "Delivered partial result." }],
		});
		expect(fixture.providerCalls()).toBe(1);
	});

	it("warns about thinking-only CodeAgent length stops without replaying the request", async () => {
		const fixture = await createTerminalSession("length", 100, [{ type: "thinking", thinking: "Partial reasoning." }]);
		await fixture.session.prompt("current request");
		await fixture.session.waitForIdle();
		expect(fixture.events.some(event => event.type === "notice" && event.level === "warning" && event.message.includes("truncated"))).toBe(true);
		expect(fixture.providerCalls()).toBe(1);
		expect(fixture.session.messages.findLast(message => message.role === "assistant")).toMatchObject({ stopReason: "length" });
	});

	it("compacts exhausted CodeAgent context without discarding truncated output or continuing the goal", async () => {
		const fixture = await createTerminalSession("length", 190000);
		await fixture.session.prompt("current request");
		await fixture.session.waitForIdle();
		expect(fixture.events.some(event => event.type === "notice" && event.level === "warning" && event.message.includes("truncated"))).toBe(true);
		expect(fixture.manager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(fixture.session.messages.some(message => message.role === "compactionSummary")).toBe(true);
		expect(fixture.session.messages.findLast(message => message.role === "assistant")).toMatchObject({
			stopReason: "length",
			content: [{ type: "text", text: "Delivered partial result." }],
		});
		expect(fixture.providerCalls()).toBe(1);
		expect(fixture.events.filter(event => event.type === "agent_end")).toHaveLength(1);
	});

	it("maintains CodeAgent overflow context without replaying the failed request", async () => {
		const fixture = await createTerminalSession("error", 250000);
		await fixture.session.prompt("current request");
		await fixture.session.waitForIdle();
		expect(fixture.manager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(fixture.session.messages.findLast(message => message.role === "assistant")).toMatchObject({
			stopReason: "error",
			content: [{ type: "text", text: "Delivered partial result." }],
		});
		expect(fixture.providerCalls()).toBe(1);
		expect(fixture.events.filter(event => event.type === "agent_end")).toHaveLength(1);
	});
});
