import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { JCHTOOLS_API, streamJchToolsAgent } from "@oh-my-pi/pi-coding-agent/config/jchtools-provider";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildGoalAutoOrchestrateMessage } from "@oh-my-pi/pi-coding-agent/goals/request-context";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	cfgFeaturesUnexpectedStopDetection,
	cfgPrewalkEnabled,
	cfgRetryFallbackChains,
	cfgRetryMaxDelayMs,
	cfgRetryMaxRetries,
	cfgRetryUsageAwareFallback,
} from "@oh-my-pi/pi-coding-agent/session/settings";

interface ChatRequest {
	model: string;
	messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }>;
	stream: boolean;
	cwd: string;
	tools?: unknown;
}

function sse(delta: object, finishReason: string | null = null): string {
	return `data: ${JSON.stringify({ id: "local-session", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function completed(text: string): Response {
	return new Response(sse({ role: "assistant", content: text }) + sse({}, "stop") + "data: [DONE]\n\n", {
		headers: { "Content-Type": "text/event-stream" },
	});
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function transcriptContent(session: AgentSession) {
	return session.messages
		.filter(message => message.role === "user" || message.role === "assistant" || message.role === "toolResult")
		.map(message => ({
			role: message.role,
			content:
				typeof message.content === "string"
					? message.content
					: message.content.map(block => {
							if (block.type === "toolCall") {
								return { type: block.type, id: block.id, name: block.name, arguments: block.arguments };
							}
							if (block.type === "text") return { type: block.type, text: block.text };
							if (block.type === "thinking") return { type: block.type, thinking: block.thinking };
							return block;
						}),
			...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName } : {}),
		}));
}

async function fixture(
	handler?: (body: ChatRequest, request: Request) => Response | Promise<Response>,
	persistent = false,
	liveDiscovery = false,
	remoteId = "backend/agent",
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-jchtools-session-"));
	const cwd = path.join(root, "workspace");
	fs.mkdirSync(cwd);
	const requests: ChatRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname === "/v1/models") {
				return Response.json({ object: "list", data: [{ id: remoteId, object: "model" }] });
			}
			if (new URL(request.url).pathname !== "/v1/chat/completions")
				return new Response("not found", { status: 404 });
			const body = (await request.json()) as ChatRequest;
			requests.push(body);
			return handler ? await handler(body, request) : completed("backend reply");
		},
	});
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({
		"compaction.enabled": true,
		"retry.enabled": true,
		"retry.maxRetries": 3,
		"retry.baseDelayMs": 1,
		"retry.modelFallback": true,
		"retry.usageAwareFallback": true,
		"retry.fallbackChains": { default: ["session-local-test/normal"] },
		"features.unexpectedStopDetection": persistent ? "none" : "smart",
		"tools.speculativeExecution.enabled": true,
		"task.speculativeLaunch": true,
		"providers.cacheWarming": "idle",
		"secrets.enabled": false,
		"prewalk.enabled": true,
	});
	let discoveryAddress: string | null = server.url.origin;
	let instanceId = crypto.randomUUID();
	let pipePath: string | undefined;
	let pipeServer: Server | undefined;
	const pipeSockets = new Set<Socket>();
	if (liveDiscovery) {
		pipePath =
			process.platform === "win32"
				? `\\\\.\\pipe\\omp-jch-session-${crypto.randomUUID()}`
				: path.join(root, "discovery.sock");
		pipeServer = createServer(socket => {
			pipeSockets.add(socket);
			socket.on("close", () => pipeSockets.delete(socket));
			socket.on("error", () => {});
			let received = Buffer.alloc(0);
			socket.on("data", chunk => {
				received = Buffer.concat([received, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
				if (received.length < 4 || received.length < 4 + received.readUInt32LE()) return;
				const payload = Buffer.from(
					JSON.stringify({
						protocol: 1,
						pid: 42,
						result: {
							Ok: {
								protocol_version: 1,
								service_id: "jchtools-acp-http",
								instance_id: instanceId,
								phase: discoveryAddress ? "ready" : "stopped",
								base_url: discoveryAddress,
								execution_mode: "server_agent",
								capabilities: { text: true, streaming: true, client_tools: false, server_tools: true },
							},
						},
					}),
				);
				const length = Buffer.alloc(4);
				length.writeUInt32LE(payload.length);
				socket.end(Buffer.concat([length, payload]));
			});
		});
		const ready = Promise.withResolvers<void>();
		pipeServer.once("error", ready.reject);
		pipeServer.listen(pipePath, () => ready.resolve());
		await ready.promise;
	}
	const registry = new ModelRegistry(authStorage, path.join(root, "models.yml"), {
		settings,
		jchToolsDiscovery: pipePath ? { pipePath, env: {}, timeoutMs: 250, fetch } : undefined,
	});
	const common = {
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
	};
	if (liveDiscovery) {
		await registry.refreshLocalProviders();
	} else {
		registry.registerProvider("session-remote-test", {
			api: JCHTOOLS_API,
			baseUrl: server.url.origin,
			apiKey: "local-test-only",
			streamSimple: streamJchToolsAgent,
			models: [{ ...common, id: remoteId, name: "后端 Agent 执行（容量未知）", supportsTools: false }],
		});
	}
	registry.registerProvider("session-local-test", {
		api: "openai-completions",
		baseUrl: `${server.url.origin}/v1`,
		apiKey: "local-test-only",
		models: [{ ...common, id: "normal", name: "ordinary local HTTP test model", supportsTools: true }],
	});
	const remote = registry.find(liveDiscovery ? "jchtools" : "session-remote-test", remoteId);
	const ordinary = registry.find("session-local-test", "normal");
	if (!remote || !ordinary) throw new Error("Expected registered local HTTP models");
	let toolExecutions = 0;
	const sessions: AgentSession[] = [];
	const events: AgentSessionEvent[] = [];
	const manager = persistent ? SessionManager.create(cwd, path.join(root, "sessions")) : SessionManager.inMemory(cwd);
	const create = async (
		model?: Model,
		sessionManager = manager,
		extensions: ExtensionFactory[] = [],
		modelPattern?: string | string[],
	) => {
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(root, "agent"),
			authStorage,
			modelRegistry: registry,
			settings,
			model,
			modelPattern,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["frontend_probe"],
			restrictToolNames: extensions.length === 0,
			allowRestrictedCustomTools: true,
			customTools: [
				{
					name: "frontend_probe",
					label: "Frontend probe",
					description: "FRONTEND_TOOL_INSTRUCTION_SENTINEL",
					parameters: type({}),
					async execute() {
						toolExecutions++;
						return { content: [{ type: "text" as const, text: "frontend result" }] };
					},
				},
			],
			systemPrompt: "FRONTEND_SYSTEM_INSTRUCTION_SENTINEL",
			enableMCP: false,
			enableLsp: false,
			autoTitle: model?.api === JCHTOOLS_API,
			prewalk: model?.api === JCHTOOLS_API ? { target: ordinary } : undefined,
		});
		sessions.push(session);
		session.subscribe(event => events.push(event));
		return session;
	};
	cleanups.push(async () => {
		for (const session of sessions.reverse()) await session.dispose();
		authStorage.close();
		await server.stop(true);
		for (const socket of pipeSockets) socket.destroy();
		if (pipeServer) {
			const closed = Promise.withResolvers<void>();
			pipeServer.close(() => closed.resolve());
			await closed.promise;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});
	return {
		cwd,
		requests,
		remote,
		ordinary,
		create,
		events,
		manager,
		registry,
		settings,
		toolExecutions: () => toolExecutions,
		setDiscoveryAddress(baseUrl: string | null, restart = false) {
			discoveryAddress = baseUrl;
			if (restart) instanceId = crypto.randomUUID();
		},
	};
}

describe("JchTools SDK remote Agent session", () => {
	it("reuses backend session headers only within the same chat, branch and cwd", async () => {
		const headers: (string | null)[] = [];
		let next = 0;
		const f = await fixture((_body, request) => {
			const id = request.headers.get("X-JchTools-Session-ID");
			headers.push(id);
			const response = completed("backend reply");
			response.headers.set("X-JchTools-Session-ID", id ?? `backend-${++next}`);
			return response;
		}, true);
		const session = await f.create(f.remote);
		await session.prompt("first");
		const firstLeaf = f.manager.getLeafId()!;
		await session.prompt("second");
		expect(headers).toEqual([null, "backend-1"]);
		expect(f.requests[1].messages).toEqual([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "backend reply" },
			{ role: "user", content: "second" },
		]);
		await session.navigateTree(firstLeaf);
		await session.prompt("branch task");
		expect(headers.at(-1)).toBeNull();
		await session.prompt("branch followup");
		expect(headers.at(-1)).toBe("backend-2");
		await session.fork();
		await session.prompt("fork task");
		expect(headers.at(-1)).toBeNull();
		const otherCwd = path.join(path.dirname(f.cwd), "other-cwd");
		fs.mkdirSync(otherCwd);
		f.manager.setCwdWithoutRelocation(otherCwd);
		await session.prompt("changed cwd");
		expect(headers.at(-1)).toBeNull();
		await session.prompt("same changed cwd");
		expect(headers.at(-1)).toBe("backend-4");
		await session.newSession();
		await session.prompt("new chat");
		expect(headers.at(-1)).toBeNull();
		const independent = await f.create(f.remote, SessionManager.inMemory(otherCwd));
		await independent.prompt("independent chat");
		expect(headers.at(-1)).toBeNull();
	});

	it("surfaces an invalid backend session without retry or task replay", async () => {
		let count = 0;
		const headers: (string | null)[] = [];
		const f = await fixture((_body, request) => {
			headers.push(request.headers.get("X-JchTools-Session-ID"));
			if (++count === 1) {
				const response = completed("backend reply");
				response.headers.set("X-JchTools-Session-ID", "expired-backend");
				return response;
			}
			if (count === 2 || headers.at(-1) === "expired-backend") {
				return Response.json(
					{ error: { code: "session_unavailable", message: "此会话已失效，本轮未重放" } },
					{ status: 400, headers: { "X-JchTools-Session-ID": "untrusted-error-session" } },
				);
			}
			if (count === 4) {
				return Response.json({ error: { code: "invalid_request", message: "invalid input" } }, { status: 400 });
			}
			const response = completed("new backend reply");
			response.headers.set("X-JchTools-Session-ID", "new-backend");
			return response;
		});
		const session = await f.create(f.remote);
		await session.prompt("first");
		await session.prompt("side effect task");
		expect(count).toBe(2);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
		expect(session.getLastAssistantMessage()?.errorMessage).toContain("此会话已失效");
		await session.prompt("new caller task");
		expect(count).toBe(3);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		await session.prompt("invalid input");
		expect(count).toBe(4);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
		await session.prompt("next caller task");
		expect(count).toBe(5);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		expect(headers).toEqual([null, "expired-backend", null, "new-backend", "new-backend"]);
		expect(f.events.some(event => event.type === "auto_retry_start")).toBe(false);
	});

	it("keeps deferred builtin roles automatic while honoring an explicitly configured remote role", async () => {
		const f = await fixture(undefined, false, true, "claude-haiku-5-5");
		cfgDisabledProviders.override(
			f.settings,
			[...new Set(f.registry.getAll().map(model => model.provider))].filter(
				provider => provider !== "jchtools" && provider !== "session-local-test",
			),
		);
		cfgRetryFallbackChains.override(f.settings, {});
		cfgRetryUsageAwareFallback.override(f.settings, false);
		cfgFeaturesUnexpectedStopDetection.override(f.settings, "none");
		const automatic = await f.create(undefined, f.manager, [], ["@smol", "session-local-test/normal"]);
		expect(automatic.model?.provider).toBe("session-local-test");
		await automatic.prompt("ordinary fallback task");
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0].model).toBe("normal");
		expect(f.requests[0].tools).toBeDefined();
		f.settings.setModelRole("smol", "jchtools/claude-haiku-5-5");
		const explicit = await f.create(undefined, SessionManager.inMemory(f.cwd), [], "@smol");
		expect(explicit.model?.provider).toBe("jchtools");
		await explicit.prompt("explicit configured backend task");
		expect(f.requests).toHaveLength(2);
		expect(f.requests[1].model).toBe("claude-haiku-5-5");
		expect(f.requests[1].cwd).toBe(f.cwd);
		expect(f.requests[1].messages.filter(message => message.role !== "system")).toEqual([
			{ role: "user", content: "explicit configured backend task" },
		]);
	});

	it("sends only backend text instructions and cwd without frontend tools or automatic tasks", async () => {
		const f = await fixture();
		const session = await f.create(f.remote);
		expect(
			await session.prompt("perform my explicit task", { toolChoice: { type: "function", name: "frontend_probe" } }),
		).toBe(true);
		expect(f.requests).toHaveLength(1);
		const body = f.requests[0];
		expect(body.cwd).toBe(f.cwd);
		expect(body.model).toBe("backend/agent");
		expect(body.messages.at(-1)).toEqual({ role: "user", content: "perform my explicit task" });
		const wire = JSON.stringify(body);
		expect(body.messages.some(message => message.role === "system")).toBe(false);
		expect(wire).not.toContain("FRONTEND_SYSTEM_INSTRUCTION_SENTINEL");
		expect(wire).not.toContain("FRONTEND_TOOL_INSTRUCTION_SENTINEL");
		expect(wire).not.toContain("frontend_probe");
		expect(f.toolExecutions()).toBe(0);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		expect(session.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "backend reply" }]);
		expect(session.getPrewalkState()).toBeUndefined();
		expect(
			f.events.some(
				event =>
					event.type === "tool_execution_start" ||
					event.type === "auto_retry_start" ||
					event.type === "cache_warming_start",
			),
		).toBe(false);
		await expect(session.prompt("unsolicited", { synthetic: true })).rejects.toThrow("explicit user task");
		expect(f.requests).toHaveLength(1);
		expect(session.armPrewalk(f.ordinary)).toBe(false);
		expect(await session.restartPrewalk(f.remote, undefined, f.ordinary, undefined)).toBe("rejected");
		expect(session.setAdvisorEnabled(true)).toBe(false);
		expect(session.isAdvisorEnabled()).toBe(false);
		let captures = 0;
		await session.runAutolearnCapture(async () => {
			captures++;
		});
		expect(captures).toBe(0);
		expect(
			await session.sendCustomMessage(
				{ customType: "frontend-auto-note", content: "AUTOMATIC_FRONTEND_NOTICE_SENTINEL", display: false },
				{ triggerTurn: true },
			),
		).toBe(false);
		expect(f.requests).toHaveLength(1);
		await session.prompt("explicit second task");
		expect(f.requests).toHaveLength(2);
		expect(JSON.stringify(f.requests.at(-1))).not.toContain("AUTOMATIC_FRONTEND_NOTICE_SENTINEL");
		expect(
			session.messages.some(message => message.role === "custom" && message.customType === "frontend-auto-note"),
		).toBe(true);
		session.startCacheWarming(
			{ ...f.remote, promptCache: { short: 60_000 } },
			{
				systemPrompt: ["remote context"],
				messages: [{ role: "user", content: "explicit second task", timestamp: Date.now() }],
			},
			{ apiKey: "local-test-only", cacheRetention: "short" },
		);
		expect(session.cacheWarmingStatus?.state).toBe("inactive");
	});

	it("keeps concurrent session requests and backend replies associated with each task cwd", async () => {
		const arrivals = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture(async body => {
			const input = fs.readFileSync(path.join(body.cwd, "task-input.txt"), "utf8");
			fs.writeFileSync(path.join(body.cwd, "task-result.txt"), `processed ${input}`);
			if (f.requests.length === 2) arrivals.resolve();
			await release.promise;
			return completed(`processed ${input}`);
		});
		const firstCwd = path.join(path.dirname(f.cwd), "中文 workspace one");
		const secondCwd = path.join(path.dirname(f.cwd), "中文 workspace two");
		fs.mkdirSync(firstCwd);
		fs.mkdirSync(secondCwd);
		fs.writeFileSync(path.join(firstCwd, "task-input.txt"), "first workspace marker");
		fs.writeFileSync(path.join(secondCwd, "task-input.txt"), "second workspace marker");
		const first = await f.create(f.remote, SessionManager.inMemory(firstCwd));
		const second = await f.create(f.remote, SessionManager.inMemory(secondCwd));
		try {
			const firstPrompt = first.prompt("first task");
			const secondPrompt = second.prompt("second task");
			await arrivals.promise;
			release.resolve();
			await Promise.all([firstPrompt, secondPrompt]);
			expect(fs.readFileSync(path.join(firstCwd, "task-result.txt"), "utf8")).toBe(
				"processed first workspace marker",
			);
			expect(fs.readFileSync(path.join(secondCwd, "task-result.txt"), "utf8")).toBe(
				"processed second workspace marker",
			);
			expect(first.getLastAssistantMessage()?.content).toEqual([
				{ type: "text", text: "processed first workspace marker" },
			]);
			expect(second.getLastAssistantMessage()?.content).toEqual([
				{ type: "text", text: "processed second workspace marker" },
			]);
		} finally {
			release.resolve();
		}
	});

	it("uses the updated cwd for the next request from the same session", async () => {
		const f = await fixture(async body => {
			const input = fs.readFileSync(path.join(body.cwd, "task-input.txt"), "utf8");
			fs.writeFileSync(path.join(body.cwd, "task-result.txt"), `processed ${input}`);
			return completed(`processed ${input}`);
		});
		const session = await f.create(f.remote);
		const nextCwd = path.join(path.dirname(f.cwd), "changed 中文 workspace");
		fs.mkdirSync(nextCwd);
		fs.writeFileSync(path.join(f.cwd, "task-input.txt"), "original workspace marker");
		fs.writeFileSync(path.join(nextCwd, "task-input.txt"), "updated workspace marker");
		try {
			await session.prompt("first cwd task");
			expect(fs.readFileSync(path.join(f.cwd, "task-result.txt"), "utf8")).toBe(
				"processed original workspace marker",
			);
			expect(session.getLastAssistantMessage()?.content).toEqual([
				{ type: "text", text: "processed original workspace marker" },
			]);
			f.manager.setCwdWithoutRelocation(nextCwd);
			await session.prompt("second cwd task");
			expect(fs.readFileSync(path.join(nextCwd, "task-result.txt"), "utf8")).toBe(
				"processed updated workspace marker",
			);
			expect(fs.readFileSync(path.join(f.cwd, "task-result.txt"), "utf8")).toBe(
				"processed original workspace marker",
			);
			expect(session.getLastAssistantMessage()?.content).toEqual([
				{ type: "text", text: "processed updated workspace marker" },
			]);
			const missingCwd = path.join(path.dirname(f.cwd), "missing 中文 workspace");
			f.manager.setCwdWithoutRelocation(missingCwd);
			await session.prompt("task with missing cwd");
			expect(f.requests).toHaveLength(2);
			expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
			expect(session.getLastAssistantMessage()?.errorMessage).toContain("cwd");
			expect(fs.existsSync(missingCwd)).toBe(false);
		} finally {
			await session.abort();
		}
	});

	it("sends an explicit remote task with an active ordinary Goal without developer context or orchestration notices", async () => {
		const f = await fixture();
		const session = await f.create(f.remote);
		await session.goalRuntime.createGoal({ objective: "Keep the ordinary remote Goal active" });

		expect(await session.prompt("perform the explicit ordinary Goal task")).toBe(true);
		expect(f.requests).toHaveLength(1);
		const body = f.requests[0];
		expect(body.cwd).toBe(f.cwd);
		expect(body.messages.filter(message => message.role !== "system")).toEqual([
			{ role: "user", content: "perform the explicit ordinary Goal task" },
		]);
		expect(body.messages.some(message => message.role === "developer")).toBe(false);
		const wire = JSON.stringify(body);
		expect(wire).not.toContain("goal-mode-context");
		expect(wire).not.toContain("FRONTEND_SYSTEM_INSTRUCTION_SENTINEL");
		expect(wire).not.toContain("FRONTEND_TOOL_INSTRUCTION_SENTINEL");
		expect(wire).not.toContain("frontend_probe");
		expect(
			session.messages.some(message => message.role === "custom" && message.customType === "goal-mode-context"),
		).toBe(false);
		expect(
			f.manager
				.getBranch()
				.some(entry => entry.type === "custom_message" && entry.customType === "goal-mode-context"),
		).toBe(false);
		expect(
			session.messages.some(
				message => message.role === "custom" && message.customType === "goal-auto-orchestrate-context",
			),
		).toBe(false);
		expect(
			f.manager
				.getBranch()
				.some(entry => entry.type === "custom_message" && entry.customType === "goal-auto-orchestrate-context"),
		).toBe(false);
		expect(session.getGoalModeState()?.goal.status).toBe("active");
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		expect(session.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "backend reply" }]);
		expect(f.toolExecutions()).toBe(0);
	});

	for (const transition of ["create", "replace"] as const) {
		it(`persists and reuses a user-authority remote Goal notice after ${transition} without changing the request prefix`, async () => {
			const f = await fixture(undefined, true);
			const session = await f.create(f.remote);
			if (transition === "replace") {
				await session.goalRuntime.createGoal({ objective: "Original ordinary remote Goal" });
			}
			const objective =
				"REMOTE_COMPLETE_GOAL\n\n  Preserve internal whitespace and {{literal_goal_text}}.\nFinish every part.";
			const goal =
				transition === "create"
					? await session.goalRuntime.createGoal({ objective, autoOrchestrate: true })
					: await session.goalRuntime.replaceGoal({ objective, autoOrchestrate: true });
			const expected = buildGoalAutoOrchestrateMessage(goal, []);
			if (!expected) throw new Error("Expected user-authority remote Goal context");
			const notices = () =>
				session.messages.filter(
					message => message.role === "custom" && message.customType === "goal-auto-orchestrate-context",
				);
			const savedNotices = () =>
				f.manager
					.getBranch()
					.filter(
						entry => entry.type === "custom_message" && entry.customType === "goal-auto-orchestrate-context",
					);
			expect(f.requests).toHaveLength(0);
			expect(notices()).toHaveLength(0);
			expect(savedNotices()).toHaveLength(0);

			expect(
				await session.prompt("perform the first explicit automatic Goal task", {
					goalAutoOrchestrateInitialId: goal.goal.id,
				}),
			).toBe(true);
			expect(f.requests).toHaveLength(1);
			const first = f.requests[0];
			expect(first.messages.filter(message => message.role !== "system")).toEqual([
				{ role: "user", content: "perform the first explicit automatic Goal task" },
			]);
			expect(
				session.messages.some(message => message.role === "custom" && message.customType === "goal-mode-context"),
			).toBe(false);
			expect(
				f.manager
					.getBranch()
					.some(entry => entry.type === "custom_message" && entry.customType === "goal-mode-context"),
			).toBe(false);
			expect(notices()).toEqual([
				expect.objectContaining({
					content: expected.content,
					attribution: "user",
					details: { source: "goal-auto-orchestrate", goalId: goal.goal.id },
				}),
			]);
			expect(expected.content).toContain(goal.goal.objective);
			const persisted = savedNotices();
			expect(persisted).toEqual([
				expect.objectContaining({
					content: expected.content,
					attribution: "user",
					details: { source: "goal-auto-orchestrate", goalId: goal.goal.id },
				}),
			]);
			const firstHistory = [...session.messages];
			expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
			expect(session.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "backend reply" }]);

			expect(await session.prompt("perform the second explicit task")).toBe(true);
			expect(f.requests).toHaveLength(2);
			const second = f.requests[1];
			expect(second.messages).toEqual([
				...first.messages,
				{ role: "assistant", content: "backend reply" },
				{ role: "user", content: "perform the second explicit task" },
			]);
			expect(session.messages.slice(0, firstHistory.length)).toEqual(firstHistory);
			expect(notices()).toHaveLength(1);
			expect(savedNotices()).toEqual(persisted);
			expect(
				session.messages.some(message => message.role === "custom" && message.customType === "goal-mode-context"),
			).toBe(false);
			expect(
				f.manager
					.getBranch()
					.some(entry => entry.type === "custom_message" && entry.customType === "goal-mode-context"),
			).toBe(false);
			for (const body of f.requests) {
				expect(body.cwd).toBe(f.cwd);
				expect(body.messages.some(message => message.role === "developer")).toBe(false);
				const wire = JSON.stringify(body);
				expect(wire).not.toContain("goal-mode-context");
				expect(wire).not.toContain("FRONTEND_SYSTEM_INSTRUCTION_SENTINEL");
				expect(wire).not.toContain("FRONTEND_TOOL_INSTRUCTION_SENTINEL");
				expect(wire).not.toContain("frontend_probe");
			}
			expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
			expect(session.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "backend reply" }]);
			expect(f.toolExecutions()).toBe(0);
			await f.manager.ensureOnDisk();
			const file = session.sessionFile;
			if (!file) throw new Error("Expected persisted remote Goal session");
			const reopened = await SessionManager.open(file);
			expect(
				reopened
					.getBranch()
					.filter(
						entry => entry.type === "custom_message" && entry.customType === "goal-auto-orchestrate-context",
					),
			).toEqual(persisted);
			expect(
				reopened
					.getBranch()
					.some(entry => entry.type === "custom_message" && entry.customType === "goal-mode-context"),
			).toBe(false);
		});
	}

	it("rejects current media before vision description on prompt, steer and user skill admission", async () => {
		const f = await fixture();
		const session = await f.create(f.remote);
		const image = { type: "image" as const, data: "not-even-an-image", mimeType: "image/png" };
		await expect(session.prompt("inspect", { images: [image] })).rejects.toThrow("text only");
		await expect(session.steer("inspect", [image])).rejects.toThrow("text only");
		await expect(
			session.promptCustomMessage({
				customType: "skill",
				display: true,
				attribution: "user",
				content: [{ type: "text", text: "inspect" }, image],
			}),
		).rejects.toThrow("text only");
		expect(f.requests).toHaveLength(0);
		expect(session.messages).toHaveLength(0);
	});

	it("preserves ordinary tool history while switch-back and SDK resume isolate remote text epochs", async () => {
		let ordinaryCalls = 0;
		const f = await fixture(body => {
			if (body.model === "normal" && ordinaryCalls++ === 0) {
				return new Response(
					sse({
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "frontend-call",
								type: "function",
								function: { name: "frontend_probe", arguments: "{}" },
							},
						],
					}) +
						sse({}, "tool_calls") +
						"data: [DONE]\n\n",
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			return completed(body.model === "normal" ? "ordinary answer" : "remote answer");
		}, true);
		const session = await f.create(f.ordinary);
		await session.prompt("ordinary task");
		expect(f.toolExecutions()).toBe(1);
		const ordinaryHistory = transcriptContent(session);
		expect(ordinaryHistory.some(message => message.role === "toolResult")).toBe(true);
		await session.setModelTemporary(f.remote);
		await session.prompt("remote first");
		const firstRemote = f.requests.find(body => body.model === "backend/agent");
		expect(firstRemote?.messages.filter(message => message.role !== "system")).toEqual([
			{ role: "user", content: "ordinary task" },
			{ role: "assistant", content: "ordinary answer" },
			{ role: "user", content: "remote first" },
		]);
		expect(transcriptContent(session).slice(0, ordinaryHistory.length)).toEqual(ordinaryHistory);
		await session.setModelTemporary(f.ordinary);
		await session.prompt("ordinary second");
		const ordinaryWire = f.requests.at(-1);
		expect(ordinaryWire?.tools).toBeDefined();
		expect(ordinaryWire?.messages.some(message => message.role === "tool")).toBe(true);
		await session.setModelTemporary(f.remote);
		await session.prompt("remote second");
		expect(f.requests.at(-1)?.messages.filter(message => message.role !== "system")).toEqual([
			...firstRemote!.messages,
			{ role: "assistant", content: "remote answer" },
			{ role: "user", content: "ordinary second" },
			{ role: "assistant", content: "ordinary answer" },
			{ role: "user", content: "remote second" },
		]);
		await f.manager.ensureOnDisk();
		const file = session.sessionFile;
		if (!file) throw new Error("Expected persisted session file");
		const beforeResume = transcriptContent(session);
		await session.dispose();
		const resumed = await f.create(undefined, await SessionManager.open(file));
		expect(resumed.model?.api).toBe(JCHTOOLS_API);
		expect(transcriptContent(resumed)).toEqual(beforeResume);
		await resumed.prompt("remote resumed");
		expect(f.requests.at(-1)?.messages.filter(message => message.role !== "system")).toEqual([
			...firstRemote!.messages,
			{ role: "assistant", content: "remote answer" },
			{ role: "user", content: "ordinary second" },
			{ role: "assistant", content: "ordinary answer" },
			{ role: "user", content: "remote second" },
			{ role: "assistant", content: "remote answer" },
			{ role: "user", content: "remote resumed" },
		]);
		expect(f.toolExecutions()).toBe(1);
	});

	it("cuts an empty ordinary cancellation before conversion and preserves user-owned custom text", async () => {
		const ordinaryStarted = Promise.withResolvers<void>();
		const f = await fixture(body => {
			if (body.model !== "normal") return completed("remote answer");
			ordinaryStarted.resolve();
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(sse({ role: "assistant" })));
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		});
		const session = await f.create(f.ordinary);
		const running = session.prompt("CANCELLED_ORDINARY_TASK_SENTINEL");
		await ordinaryStarted.promise;
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await running;
		expect(session.getLastAssistantMessage()?.stopReason).toBe("aborted");
		expect(session.getLastAssistantMessage()?.content).toEqual([]);
		const ordinaryHistory = transcriptContent(session);
		await session.setModelTemporary(f.remote);
		await session.promptCustomMessage({
			customType: "explicit-user-task",
			content: "new backend custom task",
			display: true,
			attribution: "user",
		});
		expect(f.requests).toHaveLength(2);
		expect(f.requests.at(-1)?.messages.filter(message => message.role !== "system")).toEqual([
			{ role: "user", content: "CANCELLED_ORDINARY_TASK_SENTINEL" },
			{ role: "user", content: "new backend custom task" },
		]);
		expect(transcriptContent(session).slice(0, ordinaryHistory.length)).toEqual(ordinaryHistory);
		const remoteLeaf = f.manager.getLeafId();
		if (!remoteLeaf) throw new Error("Expected backend assistant entry");
		await session.prompt("abandoned backend branch");
		const navigated = await session.navigateTree(remoteLeaf);
		expect(navigated.cancelled).toBe(false);
		expect(
			navigated.sessionContext?.messages.some(
				message => message.role === "assistant" && message.api === f.ordinary.api,
			),
		).toBe(true);
		await session.prompt("explicit task after navigation");
		expect(f.requests).toHaveLength(4);
		expect(f.requests.at(-1)?.messages.filter(message => message.role !== "system")).toEqual([
			{ role: "user", content: "CANCELLED_ORDINARY_TASK_SENTINEL" },
			{ role: "user", content: "new backend custom task" },
			{ role: "assistant", content: "remote answer" },
			{ role: "user", content: "explicit task after navigation" },
		]);
		expect(f.toolExecutions()).toBe(0);
	});

	for (const stopReason of ["error", "aborted"] as const) {
		for (const withTreeHook of [false, true]) {
			it(`retains remote ${stopReason} text through tree navigation${withTreeHook ? " with an extension" : ""}`, async () => {
				let calls = 0;
				let treeHooks = 0;
				const f = await fixture(() => {
					if (calls++ > 0) return completed("successor reply");
					const partial = sse({ content: "retained backend partial" });
					return new Response(
						stopReason === "error"
							? partial
							: new ReadableStream<Uint8Array>({
									start(controller) {
										controller.enqueue(new TextEncoder().encode(partial));
									},
								}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				});
				const treeExtension: ExtensionFactory = pi => {
					pi.on("session_tree", async () => {
						treeHooks++;
					});
				};
				const session = await f.create(f.remote, f.manager, withTreeHook ? [treeExtension] : []);
				const textArrived = Promise.withResolvers<void>();
				session.subscribe(event => {
					if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
						textArrived.resolve();
				});
				const running = session.prompt("backend partial task");
				if (stopReason === "aborted") {
					await textArrived.promise;
					await session.abort();
				}
				await running;
				expect(session.getLastAssistantMessage()?.stopReason).toBe(stopReason);
				const target = f.manager.getLeafId();
				if (!target) throw new Error("Expected persisted backend failure");
				await session.prompt("abandoned branch task");
				expect(f.requests).toHaveLength(2);
				const navigated = await session.navigateTree(target);
				expect(navigated.cancelled).toBe(false);
				expect(treeHooks).toBe(withTreeHook ? 1 : 0);
				const partialAssistant = session.getLastAssistantMessage();
				expect(partialAssistant?.stopReason).toBe(stopReason);
				expect(partialAssistant?.content).toEqual([{ type: "text", text: "retained backend partial" }]);
				expect(navigated.sessionContext?.messages.at(-1)).toMatchObject({
					role: "assistant",
					stopReason,
					content: [{ type: "text", text: "retained backend partial" }],
				});
				expect(session.buildDisplaySessionContext().messages.at(-1)).toMatchObject({
					role: "assistant",
					stopReason,
					content: [{ type: "text", text: "retained backend partial" }],
				});
				expect(f.requests).toHaveLength(2);
				await session.prompt("explicit successor task");
				expect(f.requests).toHaveLength(3);
				expect(f.requests.at(-1)?.messages.filter(message => message.role !== "system")).toEqual([
					{ role: "user", content: "backend partial task" },
					{ role: "assistant", content: "retained backend partial" },
					{ role: "user", content: "explicit successor task" },
				]);
				expect(f.toolExecutions()).toBe(0);
			});
		}
	}

	it("sends one user text request for an idle deliberate synthetic continuation but refuses automatic continuation", async () => {
		const f = await fixture();
		const session = await f.create(f.remote);
		await expect(session.prompt("automatic continuation", { synthetic: true })).rejects.toThrow("explicit user task");
		await expect(session.followUp("automatic follow-up", undefined, { synthetic: true })).rejects.toThrow(
			"explicit user task",
		);
		expect(f.requests).toHaveLength(0);
		expect(await session.prompt("Continue.", { synthetic: true, userInitiated: true })).toBe(true);
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0].messages.filter(message => message.role !== "system")).toEqual([
			{ role: "user", content: "Continue." },
		]);
		expect(session.messages.find(message => message.role === "user")?.attribution).toBe("user");
		expect(f.toolExecutions()).toBe(0);
		expect(f.events.some(event => event.type === "auto_retry_start" || event.type === "retry_fallback_applied")).toBe(
			false,
		);
	});

	it("queues a deliberate synthetic continuation as user text while refusing an automatic queued prompt", async () => {
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const f = await fixture(() => {
			if (calls++ > 0) return completed("continued reply");
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(sse({ content: "initial reply" })));
						void release.promise.then(() => {
							controller.enqueue(new TextEncoder().encode(sse({}, "stop") + "data: [DONE]\n\n"));
							controller.close();
						});
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		});
		const session = await f.create(f.remote);
		const textArrived = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
				textArrived.resolve();
		});
		const running = session.prompt("initial user task");
		try {
			await textArrived.promise;
			await expect(
				session.prompt("automatic continuation", { synthetic: true, streamingBehavior: "followUp" }),
			).rejects.toThrow("explicit user task");
			expect(
				await session.prompt("Continue.", { synthetic: true, userInitiated: true, streamingBehavior: "followUp" }),
			).toBe(true);
			expect(f.requests).toHaveLength(1);
		} finally {
			release.resolve();
			await running;
		}
		expect(f.requests).toHaveLength(2);
		expect(f.requests[1].messages.filter(message => message.role !== "system")).toEqual([
			{ role: "user", content: "initial user task" },
			{ role: "assistant", content: "initial reply" },
			{ role: "user", content: "Continue." },
		]);
		expect(session.messages.filter(message => message.role === "user").map(message => message.attribution)).toEqual([
			"user",
			"user",
		]);
		expect(f.toolExecutions()).toBe(0);
	});

	it("preserves backend partial failure across SDK resume without replaying until an explicit new task", async () => {
		let calls = 0;
		const f = await fixture(
			() =>
				calls++ === 0
					? new Response(sse({ content: "persisted backend partial" }), {
							headers: { "Content-Type": "text/event-stream" },
						})
					: completed("explicit successor"),
			true,
		);
		const session = await f.create(f.remote);
		await session.prompt("first backend task");
		expect(f.requests).toHaveLength(1);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
		await f.manager.ensureOnDisk();
		const file = session.sessionFile;
		if (!file) throw new Error("Expected persisted partial session");
		await session.dispose();
		const resumed = await f.create(undefined, await SessionManager.open(file));
		expect(f.requests).toHaveLength(1);
		expect(
			resumed.messages.some(
				message =>
					message.role === "assistant" &&
					message.stopReason === "error" &&
					message.content.some(block => block.type === "text" && block.text === "persisted backend partial"),
			),
		).toBe(true);
		await resumed.prompt("explicit successor task");
		expect(f.requests).toHaveLength(2);
		expect(f.requests.at(-1)?.messages.filter(message => message.role !== "system")).toEqual([
			{ role: "user", content: "first backend task" },
			{ role: "assistant", content: "persisted backend partial" },
			{ role: "user", content: "explicit successor task" },
		]);
	});

	it("retains visible user tasks across an ordinary failure and SDK resume", async () => {
		const f = await fixture(
			body =>
				body.model === "normal" ? new Response("fatal bad request", { status: 400 }) : completed("remote answer"),
			true,
		);
		const session = await f.create(f.ordinary);
		await session.prompt("ORDINARY_FAILED_TASK_SENTINEL");
		await session.setModelTemporary(f.remote);
		await session.prompt("new remote task");
		await f.manager.ensureOnDisk();
		const file = session.sessionFile;
		if (!file) throw new Error("Expected persisted mixed session");
		await session.dispose();
		const resumed = await f.create(undefined, await SessionManager.open(file));
		await resumed.prompt("resumed remote task");
		expect(f.requests.at(-1)?.messages.filter(message => message.role !== "system")).toEqual([
			{ role: "user", content: "ORDINARY_FAILED_TASK_SENTINEL" },
			{ role: "user", content: "new remote task" },
			{ role: "assistant", content: "remote answer" },
			{ role: "user", content: "resumed remote task" },
		]);
	});

	for (const [status, reason] of [
		[429, "rate limit exceeded retry-after-ms=1"],
		[413, "request payload too large"],
		[408, "request body read timeout"],
		[502, "service unavailable"],
		[400, "MALFORMED_FUNCTION_CALL"],
	] as const) {
		it(`keeps HTTP ${status} terminal with exactly one request despite enabled retry/fallback/recovery`, async () => {
			const f = await fixture(() => new Response(JSON.stringify({ error: { message: reason } }), { status }));
			const session = await f.create(f.remote);
			await session.prompt("possibly side-effecting task");
			expect(f.requests).toHaveLength(1);
			expect(session.model?.api).toBe(JCHTOOLS_API);
			expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
			expect(session.getLastAssistantMessage()?.errorMessage).toContain(reason);
			expect(
				f.events.some(event => event.type === "auto_retry_start" || event.type === "retry_fallback_applied"),
			).toBe(false);
			expect(await session.retry()).toBe(false);
			expect(f.requests).toHaveLength(1);
			await session.prompt("explicit new task after failure");
			expect(f.requests).toHaveLength(2);
		});
	}

	it("retains ordinary retries but never automatically falls back into a backend Agent", async () => {
		const f = await fixture(
			() =>
				new Response("service unavailable", {
					status: 503,
					headers: { "retry-after-ms": "1" },
				}),
		);
		cfgRetryMaxRetries.override(f.settings, 1);
		cfgRetryMaxDelayMs.override(f.settings, 100);
		cfgRetryUsageAwareFallback.override(f.settings, false);
		cfgPrewalkEnabled.override(f.settings, false);
		cfgRetryFallbackChains.override(f.settings, { default: ["session-remote-test/backend/agent"] });
		f.settings.setModelRole("default", "session-local-test/normal");
		const session = await f.create(f.ordinary);
		await session.prompt("ordinary failing task");
		expect(f.requests.length).toBeGreaterThan(1);
		expect(f.requests.every(request => request.model === "normal")).toBe(true);
		expect(session.model?.provider).toBe("session-local-test");
		expect(f.events.some(event => event.type === "auto_retry_end" && !event.success)).toBe(true);
		expect(f.events.some(event => event.type === "auto_retry_start")).toBe(true);
	});

	it("does not reprompt a successful empty stop", async () => {
		const f = await fixture(() => completed(""));
		const session = await f.create(f.remote);
		await session.prompt("empty is terminal");
		expect(f.requests).toHaveLength(1);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
	});

	it("never sends an unexpected-stop classifier reprompt to the remote backend", async () => {
		const f = await fixture(() => completed("I will continue by inspecting the repository."));
		const session = await f.create(f.remote);
		await session.prompt("a backend task");
		expect(f.requests).toHaveLength(1);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(1);
	});

	it("refreshes selected real JchTools runtime coordinates on explicit tasks and rejects withdrawn availability", async () => {
		const f = await fixture(undefined, false, true);
		const session = await f.create(f.remote);
		await session.prompt("first service task");
		const secondRequests: ChatRequest[] = [];
		const second = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname === "/v1/models") {
					return Response.json({ data: [{ id: "backend/agent", object: "model" }] });
				}
				secondRequests.push((await request.json()) as ChatRequest);
				return completed("second service reply");
			},
		});
		cleanups.push(async () => {
			await second.stop(true);
		});
		f.setDiscoveryAddress(second.url.origin);
		await session.prompt("changed port task");
		expect(session.model?.id).toBe("backend/agent");
		expect(session.model?.baseUrl).toBe(second.url.origin);
		expect(secondRequests).toHaveLength(1);
		expect(f.requests).toHaveLength(1);
		f.setDiscoveryAddress(null);
		await expect(session.prompt("service unavailable task")).rejects.toThrow("unavailable");
		expect(secondRequests).toHaveLength(1);
		expect(f.requests).toHaveLength(1);
		f.setDiscoveryAddress(f.remote.baseUrl, true);
		await session.prompt("explicit task after restart");
		expect(f.requests).toHaveLength(2);
		expect(session.model?.id).toBe("backend/agent");
		expect(session.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "backend reply" }]);
	});

	for (const [name, tail] of [
		["backend error event", 'event: error\ndata: {"error":{"message":"backend failed"}}\n\n'],
		["truncated stream", ""],
		["malformed stream", "data: {not-json}\n\n"],
		[
			"unexpected frontend tool call",
			sse({
				tool_calls: [{ index: 0, id: "no-local-execution", function: { name: "frontend_probe", arguments: "{}" } }],
			}),
		],
	] as const) {
		it(`preserves partial text and never replays after ${name}`, async () => {
			const f = await fixture(
				() =>
					new Response(sse({ content: "already received" }) + tail, {
						headers: { "Content-Type": "text/event-stream" },
					}),
			);
			const session = await f.create(f.remote);
			await session.prompt("remote partial task");
			expect(f.requests).toHaveLength(1);
			expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
			expect(session.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "already received" }]);
			expect(f.toolExecutions()).toBe(0);
			expect(
				f.events.some(event => event.type === "tool_execution_start" || event.type === "auto_retry_start"),
			).toBe(false);
		});
	}

	it("links cancellation to in-flight HTTP while retaining partial text and never replaying", async () => {
		const cancelled = Promise.withResolvers<void>();
		const f = await fixture((_body, request) => {
			request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(sse({ content: "before cancellation" })));
					},
					cancel() {
						cancelled.resolve();
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		});
		const session = await f.create(f.remote);
		const textArrived = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
				textArrived.resolve();
		});
		const running = session.prompt("cancel side-effecting task");
		await textArrived.promise;
		await session.abort();
		await running;
		await cancelled.promise;
		expect(f.requests).toHaveLength(1);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("aborted");
		expect(session.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "before cancellation" }]);
		expect(f.toolExecutions()).toBe(0);
	});
});
