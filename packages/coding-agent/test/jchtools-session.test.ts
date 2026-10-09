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
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
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
		expect(Object.keys(f.requests[1]).sort()).toEqual(["messages", "model", "stream"]);
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
		expect(Object.keys(body).sort()).toEqual(["messages", "model", "stream"]);
		expect(body.model).toBe("backend/agent");
		expect(body.messages.at(-1)).toEqual({ role: "user", content: "perform my explicit task" });
		const wire = JSON.stringify(body);
		expect(body.messages.find(message => message.role === "system")?.content).toContain(f.cwd);
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
			{ role: "user", content: "new backend custom task" },
		]);
		expect(JSON.stringify(f.requests.at(-1))).not.toContain("CANCELLED_ORDINARY_TASK_SENTINEL");
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

	it("keeps a resumed ordinary failed-task epoch out of later backend prompts", async () => {
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
		expect(JSON.stringify(f.requests.at(-1))).not.toContain("ORDINARY_FAILED_TASK_SENTINEL");
		expect(f.requests.at(-1)?.messages.filter(message => message.role !== "system")).toEqual([
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
