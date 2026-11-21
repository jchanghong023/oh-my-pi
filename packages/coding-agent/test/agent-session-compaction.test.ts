/**
 * E2E tests for AgentSession compaction behavior.
 *
 * These tests use real LLM calls (no mocking) to verify:
 * - Manual compaction works correctly
 * - Session persistence during compaction
 * - Compaction entry is saved to session file
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	CodeAgentTokenCache,
	getCodeAgentModels,
	streamCodeAgent,
} from "@oh-my-pi/pi-coding-agent/config/codeagent-provider";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type LocalAgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "./utilities";

describe.skipIf(!e2eApiKey("ASCEND_API_KEY"))("AgentSession compaction e2e", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;
	let events: LocalAgentSessionEvent[];
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

		const model = getBundledModel("ascend", "qwen3.8-flash-next")!;
		const agent = new Agent({
			getApiKey: () => e2eApiKey("ASCEND_API_KEY"),
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
		session.subscribeLocal(event => {
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
		vi.restoreAllMocks();
	});

	async function createTerminalSession(
		stopReason: "length" | "error",
		inputTokens: number,
		content: AssistantMessage["content"] = [{ type: "text", text: "Delivered partial result." }],
		maintenanceOutcome: "success" | "cancel" | "error" = "success",
		sessionDir?: string,
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
		const manager = sessionDir ? SessionManager.create(sessionDir, sessionDir) : SessionManager.inMemory();
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
			"compaction.methodOrder": ["soft"],
			"compaction.keepRecentTokens": 1,
			"compaction.thresholdTokens": 160000,
			"compaction.asyncEnabled": false,
			"compaction.supersedeReads": false,
			"compaction.dropUseless": false,
		});
		const maintenanceError = new Error("Summary generation failed.");
		// Short-circuit only summary generation at the existing extension boundary;
		// preparation, persisted history rewrite and continuation decisions stay real.
		const extensionRunner = {
			hasHandlers: (type: string) => type === "session_before_compact",
			emit: async (event: { type: string; preparation?: CompactionPreparation }) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				if (maintenanceOutcome === "cancel") return { cancel: true };
				if (maintenanceOutcome === "error") throw maintenanceError;
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
		const modelRegistry = new ModelRegistry(authStorage);
		// This synthetic provider is deliberately absent from the Linux catalog.
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			extensionRunner: extensionRunner as never,
		});
		const events: LocalAgentSessionEvent[] = [];
		session.subscribeLocal(event => {
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
		return { session, manager, events, maintenanceError, providerCalls: () => calls };
	}

	it.each(["success", "cancel", "error", "post-error"] as const)(
		"pairs manual compaction events and persists only committed summaries (%s)",
		async outcome => {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-compaction-identity-"));
			try {
				const { manager, events, maintenanceError } = await createTerminalSession(
					"length",
					100,
					undefined,
					outcome === "post-error" ? "success" : outcome,
					directory,
				);
				const terminalStates: { isCompacting: boolean; committedEntryId: string | undefined }[] = [];
				session!.subscribeLocal(event => {
					if (event.type === "manual_compaction_end") {
						terminalStates.push({
							isCompacting: session!.isCompacting,
							committedEntryId: manager.getBranch().findLast(entry => entry.type === "compaction")?.id,
						});
					}
				});
				if (outcome === "success") await session!.compact();
				else if (outcome === "post-error") {
					await expect(
						session!.compact(undefined, {
							onComplete: () => {
								throw maintenanceError;
							},
						}),
					).rejects.toBe(maintenanceError);
				} else if (outcome === "error") await expect(session!.compact()).rejects.toBe(maintenanceError);
				else await expect(session!.compact()).rejects.toBeInstanceOf(Error);
				await manager.flush();
				const sessionFile = manager.getSessionFile()!;
				await session!.dispose();
				session = undefined;
				const restored = await SessionManager.open(sessionFile);
				const entries = restored.getBranch().filter(entry => entry.type === "compaction");
				await restored.close();
				expect(events.filter(event => event.type === "manual_compaction_start")).toHaveLength(1);
				expect(events.filter(event => event.type === "manual_compaction_end")).toHaveLength(1);
				const start = events.find(event => event.type === "manual_compaction_start");
				const end = events.find(event => event.type === "manual_compaction_end");
				expect(start?.type).toBe("manual_compaction_start");
				expect(end?.type).toBe("manual_compaction_end");
				if (start?.type !== "manual_compaction_start" || end?.type !== "manual_compaction_end") {
					throw new Error("Missing manual compaction lifecycle");
				}
				expect(terminalStates).toEqual([
					{
						isCompacting: false,
						committedEntryId: entries[0]?.id,
					},
				]);
				expect(start.operationId).toBeTruthy();
				expect(end.operationId).toBe(start.operationId);
				if (outcome === "success" || outcome === "post-error") {
					expect(entries).toHaveLength(1);
					expect(entries[0]).toMatchObject({
						origin: "manual",
					});
					if (outcome === "post-error") {
						expect(end.result).toBeUndefined();
						expect(end.errorMessage).toBe(maintenanceError.message);
					}
				} else {
					expect(entries).toHaveLength(0);
					expect(end.result).toBeUndefined();
					expect(end.aborted).toBe(outcome === "cancel");
					expect(end.skipped).toBeUndefined();
				}
			} finally {
				await session?.dispose();
				session = undefined;
				removeSyncWithRetries(directory);
			}
		},
	);

	it("restores automatic compaction provenance without inventing legacy provenance", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-auto-compaction-identity-"));
		try {
			const fixture = await createTerminalSession("length", 190000, undefined, "success", directory);
			await fixture.session.prompt("current request");
			await fixture.session.waitForIdle();
			const live = fixture.manager.getBranch().findLast(entry => entry.type === "compaction");
			expect(live?.type).toBe("compaction");
			if (live?.type !== "compaction") throw new Error("Missing automatic compaction");
			expect(live.origin).toBe("auto");
			// Public append callers without provenance remain unknown, as do old journals.
			const legacyId = fixture.manager.appendCompaction("Legacy summary", undefined, live.firstKeptEntryId, 100);
			const sessionFile = fixture.manager.getSessionFile()!;
			await fixture.session.dispose();
			session = undefined;
			const restored = await SessionManager.open(sessionFile);
			const entries = restored.getBranch();
			await restored.close();
			expect(entries.find(entry => entry.id === live.id)).toMatchObject({
				origin: "auto",
			});
			const legacy = entries.find(entry => entry.id === legacyId);
			expect(legacy?.type).toBe("compaction");
			if (legacy?.type !== "compaction") throw new Error("Missing legacy compaction");
			expect(legacy.origin).toBeUndefined();
		} finally {
			await session?.dispose();
			session = undefined;
			removeSyncWithRetries(directory);
		}
	});

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
		const fixture = await createTerminalSession("length", 100, [
			{ type: "thinking", thinking: "Partial reasoning." },
		]);
		await fixture.session.prompt("current request");
		await fixture.session.waitForIdle();
		expect(
			fixture.events.some(
				event => event.type === "notice" && event.level === "warning" && event.message.includes("truncated"),
			),
		).toBe(true);
		expect(fixture.providerCalls()).toBe(1);
		expect(fixture.session.messages.findLast(message => message.role === "assistant")).toMatchObject({
			stopReason: "length",
		});
	});

	it("compacts exhausted CodeAgent context without discarding truncated output or continuing the goal", async () => {
		const fixture = await createTerminalSession("length", 190000);
		await fixture.session.prompt("current request");
		await fixture.session.waitForIdle();
		expect(
			fixture.events.some(
				event => event.type === "notice" && event.level === "warning" && event.message.includes("truncated"),
			),
		).toBe(true);
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
		// A failed turn is a durable transcript event, not provider replay context.
		// Consumers obtain the terminal result through the public result accessor.
		expect(fixture.session.getLastAssistantMessage()).toMatchObject({
			stopReason: "error",
			errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
			content: [{ type: "text", text: "Delivered partial result." }],
		});
		expect(
			fixture.manager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant"),
		).toMatchObject({
			type: "message",
			message: {
				stopReason: "error",
				errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
				content: [{ type: "text", text: "Delivered partial result." }],
			},
		});
		expect(
			fixture.session.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(fixture.providerCalls()).toBe(1);
		expect(fixture.events.filter(event => event.type === "agent_end")).toHaveLength(1);
	});

	it.each([
		["length", "cancel"],
		["length", "error"],
		["error", "cancel"],
		["error", "error"],
	] as const)(
		"retains CodeAgent %s output without goal continuation when maintenance ends with %s",
		async (stopReason, outcome) => {
			const fixture = await createTerminalSession(stopReason, 250000, undefined, outcome);
			await fixture.session.prompt("current request");
			await fixture.session.waitForIdle();
			expect(fixture.manager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(0);
			expect(fixture.session.messages.findLast(message => message.role === "assistant")).toMatchObject({
				stopReason,
				content: [{ type: "text", text: "Delivered partial result." }],
			});
			expect(fixture.providerCalls()).toBe(1);
			expect(fixture.events.filter(event => event.type === "agent_end")).toHaveLength(1);
			expect(fixture.events.some(event => event.type === "auto_compaction_end" && event.willRetry)).toBe(false);
			if (stopReason === "length") {
				expect(fixture.events.some(event => event.type === "notice" && event.message.includes("truncated"))).toBe(
					true,
				);
			}
		},
	);
});

describe("AgentSession explicit context exhaustion recovery", () => {
	it.each([
		["model_context_window_exceeded", false],
		["model_context_window_exceeded", true],
		["max_tokens", false],
		["max_tokens", true],
	] as const)("distinguishes %s from output truncation (delivered=%s)", async (stopType, delivered) => {
		const model = getBundledModel("ascend", "qwen3.8-flash-next")!;
		const usage = {
			input: 12,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 17,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "old request", timestamp: Date.now() - 2000 });
		manager.appendMessage({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: "Old completed work to summarize." }],
			stopReason: "stop",
			usage,
			timestamp: Date.now() - 1000,
		});
		const requests: string[] = [];
		const order: string[] = [];
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, tools: [], messages: manager.buildSessionContext().messages },
			streamFn: (_model, context) => {
				requests.push(JSON.stringify(context.messages));
				order.push("request");
				if (requests.length > 2) throw new Error("Unexpected recovery replay");
				const first = requests.length === 1;
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: first
						? delivered
							? [{ type: "text", text: "Partial result." }]
							: []
						: [{ type: "text", text: "Recovered result." }],
					stopReason: first ? "length" : "stop",
					stopDetails: first && stopType === "model_context_window_exceeded" ? { type: stopType } : undefined,
					usage,
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: first ? "length" : "stop", message });
				});
				return stream;
			},
		});
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime(model.provider, "test-key");
		const registry = new ModelRegistry(auth);
		vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			modelRegistry: registry,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": true,
				"compaction.methodOrder": ["soft"],
				"compaction.keepRecentTokens": 1,
				"compaction.thresholdTokens": 160000,
				"compaction.asyncEnabled": false,
				"compaction.supersedeReads": false,
				"compaction.dropUseless": false,
			}),
			extensionRunner: {
				hasHandlers: (type: string) => type === "session_before_compact",
				emit: async (event: { type: string; preparation?: CompactionPreparation }) => {
					if (event.type !== "session_before_compact" || !event.preparation) return undefined;
					order.push("compact");
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
			} as never,
		});
		try {
			await session.prompt("current original input");
			await session.waitForIdle();
			const compacted = stopType === "model_context_window_exceeded";
			expect(manager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(compacted ? 1 : 0);
			expect(order).toEqual(
				compacted ? ["request", "compact", "request"] : delivered ? ["request"] : ["request", "request"],
			);
			if (compacted || !delivered) {
				expect(requests[1]).toContain("current original input");
				expect(requests[1]).not.toContain("Partial result.");
				expect(requests[1]?.includes("Previous response hit the 5-token output limit")).toBe(!compacted);
			}
			if (compacted) {
				expect(requests[1]).toContain("Previous work summarized.");
				expect(requests[1]).not.toContain("Old completed work to summarize.");
			}
			expect(session.getLastAssistantMessage()?.content).toEqual([
				{ type: "text", text: !compacted && delivered ? "Partial result." : "Recovered result." },
			]);
		} finally {
			await session.dispose();
			auth.close();
			vi.restoreAllMocks();
		}
	});
});

describe("AgentSession compaction provider replay policy", () => {
	function isOpenAICompletionsModel(model: Model): model is Model<"openai-completions"> {
		return model.api === "openai-completions";
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		["codeagent", "compact", "http"],
		["codeagent", "compact", "stream"],
		["codeagent", "compact", "auth"],
		["codeagent", "handoff", "http"],
		["codeagent", "handoff", "stream"],
		["codeagent", "handoff", "auth"],
		["codeagent", "auto", "http"],
		["codeagent", "auto", "stream"],
		["codeagent", "auto", "auth"],
	] as const)("does not replay a failed %s %s after %s failure", async (provider, operation, failure) => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				if (failure === "http") return new Response("service unavailable", { status: 503 });
				if (failure === "auth") return new Response("unauthorized", { status: 401 });
				const partial = JSON.stringify({
					choices: [{ index: 0, delta: { content: "Partial summary." }, finish_reason: null }],
				});
				return new Response(`data: ${partial}\n\nevent: error\ndata: {"error":{"message":"timeout"}}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		const model = {
			...getCodeAgentModels()[0]!,
			provider,
			api: "openai-completions" as const,
			baseUrl: server.url.origin,
		};
		const fallback = { ...model, id: "fallback-summary", contextWindow: 300000 };
		const cache = new CodeAgentTokenCache(() => "synthetic-token");
		const auth = await AuthStorage.create(":memory:");
		const manager = SessionManager.inMemory();
		for (const [question, answer] of [
			["first question", "first answer"],
			["second question", "second answer"],
		]) {
			manager.appendMessage({ role: "user", content: question!, timestamp: Date.now() });
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: answer! }],
				api: model.api,
				provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 100,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 120,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
		}
		// Keep a user boundary so one summary is required, not parallel history/turn-prefix requests.
		manager.appendMessage({ role: "user", content: "pending request", timestamp: Date.now() });
		const registry = new ModelRegistry(auth);
		vi.spyOn(registry, "getAvailable").mockReturnValue([model, fallback]);
		vi.spyOn(registry, "getApiKey").mockResolvedValue("synthetic-token");
		const agent = new Agent({
			convertToLlm,
			initialState: { model, tools: [], messages: manager.buildSessionContext().messages },
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			modelRegistry: registry,
			settings: Settings.isolated({
				"compaction.methodOrder": operation === "auto" ? ["handoff", "soft"] : ["soft", "remote"],
				"compaction.remoteEndpoint": `${server.url.origin}/compact`,
				"compaction.keepRecentTokens": 1,
				"compaction.thresholdTokens": 160000,
				"compaction.asyncEnabled": false,
			}),
			sideStreamFn: (requestModel, context, options) => {
				if (!isOpenAICompletionsModel(requestModel)) {
					throw new Error(`Unexpected CodeAgent summary API: ${requestModel.api}`);
				}
				return streamCodeAgent(requestModel, context, { ...options, apiKey: undefined, fetch }, cache);
			},
		});
		try {
			if (operation === "auto") {
				const completion = Promise.withResolvers<void>();
				const events: LocalAgentSessionEvent[] = [];
				session.subscribeLocal(event => {
					events.push(event);
					if (event.type === "auto_compaction_end") completion.resolve();
				});
				const previous = agent.state.messages.findLast(message => message.role === "assistant") as AssistantMessage;
				const message: AssistantMessage = {
					...previous,
					usage: { ...previous.usage, input: 190000, totalTokens: 190020 },
					timestamp: Date.now(),
				};
				agent.emitExternalEvent({ type: "message_end", message });
				agent.emitExternalEvent({ type: "agent_end", messages: [message] });
				await completion.promise;
				await session.waitForIdle();
				expect(events.some(event => event.type === "auto_compaction_end" && event.errorMessage)).toBe(true);
			} else {
				await expect(
					operation === "compact" ? session.compact() : session.compact(undefined, { mode: "handoff" }),
				).rejects.toBeInstanceOf(Error);
			}
			expect(requests).toBe(1);
			expect(manager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(0);
		} finally {
			await session.dispose();
			auth.close();
			server.stop(true);
		}
	});
});
