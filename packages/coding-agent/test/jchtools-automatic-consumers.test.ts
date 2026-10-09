import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import { createServer, type Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import {
	getCompletionHandle,
	releaseCompletionHandles,
	runEvalCompletion,
} from "@oh-my-pi/pi-coding-agent/eval/completion-bridge";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	cfgRetryEnabled,
	cfgRetryFallbackChains,
	cfgRetryMaxRetries,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	releaseCompletionHandles("Main");
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
	withOrdinary = false,
	options: {
		respond?: (pathname: string, model: string) => Response | undefined;
		ordinaryIds?: string[];
	} = {},
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-automatic-consumers-"));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const requests: Array<{ path: string; model: string }> = [];
	const modelId = "claude-haiku-5-5";
	const http = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/v1/models") {
				return Response.json({ object: "list", data: [{ id: modelId, object: "model" }] });
			}
			const body = (await request.json()) as { model: string };
			requests.push({ path: pathname, model: body.model });
			const response = options.respond?.(pathname, body.model);
			if (response) return response;
			const chunk = (delta: object, finishReason: string | null = null) =>
				`data: ${JSON.stringify({ id: "consumer-reply", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
			return new Response(
				chunk({ role: "assistant", content: "name: generated-agent\ndescription: local test agent" }) +
					chunk({}, "stop") +
					"data: [DONE]\n\n",
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	cleanups.push(() => http.stop(true));
	const pipePath =
		process.platform === "win32"
			? `\\\\.\\pipe\\omp-automatic-consumers-${crypto.randomUUID()}`
			: path.join(root, "control.sock");
	const sockets = new Set<Socket>();
	const pipe = createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let received = Buffer.alloc(0);
		let handled = false;
		socket.on("data", chunk => {
			received = Buffer.concat([received, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
			if (handled || received.length < 4 || received.length < 4 + received.readUInt32LE()) return;
			handled = true;
			const payload = Buffer.from(
				JSON.stringify({
					protocol: 1,
					pid: 42,
					result: {
						Ok: {
							protocol_version: 1,
							service_id: "jchtools-acp-http",
							instance_id: "12345678-1234-4234-8234-123456789abc",
							phase: "ready",
							base_url: http.url.origin,
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
	pipe.once("error", ready.reject);
	pipe.listen(pipePath, () => ready.resolve());
	await ready.promise;
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(resolve => pipe.close(() => resolve()));
	});
	const authStorage = await AuthStorage.create(":memory:");
	cleanups.push(() => authStorage.close());
	const settings = Settings.isolated({
		"prewalk.enabled": true,
		"retry.enabled": false,
		"compaction.enabled": false,
		"secrets.enabled": false,
		"providers.cacheWarming": "off",
	});
	const registry = new ModelRegistry(authStorage, path.join(root, "models.yml"), {
		settings,
		jchToolsDiscovery: { pipePath, env: {}, timeoutMs: 250, fetch },
	});
	if (withOrdinary) {
		registry.registerProvider("consumer-local-test", {
			api: "openai-completions",
			baseUrl: `${http.url.origin}/ordinary`,
			apiKey: "local-test-only",
			models: (options.ordinaryIds ?? [modelId]).map(id => ({
				id,
				name: id,
				reasoning: false,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32768,
				maxTokens: 4096,
			})),
		});
	}
	await registry.refreshLocalProviders();
	const remote = registry.find("jchtools", modelId);
	const ordinary = registry.find("consumer-local-test", modelId);
	if (!remote || (withOrdinary && !ordinary)) throw new Error("expected consumer fixture models");
	const available: Model[] = [
		remote,
		...(withOrdinary
			? (options.ordinaryIds ?? [modelId]).map(id => {
					const model = registry.find("consumer-local-test", id);
					if (!model) throw new Error(`expected ordinary fixture model ${id}`);
					return model;
				})
			: []),
	];
	// Isolate ambient credentials without bypassing role matching or the public consumers.
	vi.spyOn(registry, "getAvailable").mockImplementation(() => available);
	vi.spyOn(registry, "getAll").mockImplementation(() => available);
	vi.spyOn(registry, "refresh").mockImplementation(async () => {
		await registry.refreshLocalProviders();
	});
	const hub = (active?: string, fallback?: string) =>
		createAgentsHubDeps(
			root,
			settings,
			registry,
			() => ({ explicit: [], mode: "explicit-only", configured: [], configuredLevel: "user" }),
			active,
			fallback,
		);
	const toolSession = {
		cwd: root,
		settings,
		modelRegistry: registry,
		getActiveModelString: () => undefined,
	} as unknown as ToolSession;
	return { root, settings, registry, remote, ordinary, requests, hub, toolSession };
}

async function completion(session: ToolSession, schema?: Record<string, unknown>) {
	const handle = await runEvalCompletion(
		{ prompt: "generate a short description", model: "smol", ...(schema ? { schema } : {}) },
		{ session },
	);
	const entry = getCompletionHandle(handle.id);
	if (!entry) throw new Error("expected completion handle");
	await entry.promise;
	if (entry.error) throw new Error(entry.error);
	return entry.result;
}

describe("automatic roles in text consumers", () => {
	test("remote-only automatic prewalk, plan-yolo, hub and eval never choose the backend", async () => {
		const f = await fixture();
		for (const args of [[], ["--prewalk-into", "@smol:off"]]) {
			const options = await buildSessionOptions(
				parseArgs(args),
				[],
				SessionManager.inMemory(),
				f.registry,
				f.settings,
			);
			expect(options.prewalk).toBeUndefined();
		}
		await expect(
			buildSessionOptions(parseArgs(["--plan-yolo"]), [], SessionManager.inMemory(), f.registry, f.settings),
		).rejects.toThrow();
		await expect(f.hub("@smol").generateAgent("a helpful agent", () => {})).rejects.toThrow();
		await expect(f.hub().generateAgent("a helpful agent", () => {})).rejects.toThrow();
		await expect(completion(f.toolSession)).rejects.toThrow();
		expect(f.requests).toEqual([]);
	});

	test("ordinary candidates still work when a same-id backend is available first", async () => {
		const f = await fixture(true);
		const options = await buildSessionOptions(
			parseArgs(["--plan-yolo"]),
			[],
			SessionManager.inMemory(),
			f.registry,
			f.settings,
		);
		expect(options.prewalk?.target.provider).toBe("consumer-local-test");
		expect(options.planYolo?.target.provider).toBe("consumer-local-test");
		expect(await f.hub("@smol").generateAgent("a helpful agent", () => {})).toContain("generated-agent");
		expect(await f.hub().generateAgent("a helpful agent", () => {})).toContain("generated-agent");
		expect((await completion(f.toolSession))?.details.model).toBe(`consumer-local-test/${f.ordinary?.id}`);
		expect(f.requests.length).toBe(3);
		expect(f.requests.every(request => request.path.startsWith("/ordinary/"))).toBe(true);
	});

	test.each(["default", "smol"])("explicit remote %s role stays usable across all consumers", async role => {
		const f = await fixture();
		f.settings.setModelRole(role, `jchtools/${f.remote.id}:off`);
		const options = await buildSessionOptions(
			parseArgs(["--plan-yolo"]),
			[],
			SessionManager.inMemory(),
			f.registry,
			f.settings,
		);
		expect(options.prewalk?.target.provider).toBe("jchtools");
		expect(options.prewalk?.thinkingLevel).toBe("off");
		expect(options.planYolo?.target.provider).toBe("jchtools");
		expect(await f.hub("@smol").generateAgent("a helpful agent", () => {})).toContain("generated-agent");
		expect((await completion(f.toolSession))?.details.model).toBe(`jchtools/${f.remote.id}`);
		expect(f.requests.length).toBe(2);
		expect(f.requests.every(request => request.path === "/v1/chat/completions")).toBe(true);
	});

	test.each(["http", "sse"])("explicit remote completion %s failures never retry or fall back", async failure => {
		const f = await fixture(true, {
			respond: pathname => {
				if (pathname !== "/v1/chat/completions") return undefined;
				return failure === "http"
					? Response.json({ error: { message: "remote completion failed" } }, { status: 500 })
					: new Response('data: {"error":{"message":"remote completion failed"}}\n\n', {
							headers: { "Content-Type": "text/event-stream" },
						});
			},
		});
		const ordinary = f.ordinary;
		if (!ordinary) throw new Error("expected ordinary completion fallback model");
		const remote = `jchtools/${f.remote.id}`;
		f.settings.setModelRole("smol", `${remote}:off`);
		cfgRetryEnabled.set(f.settings, true);
		cfgRetryMaxRetries.set(f.settings, 4);
		cfgRetryFallbackChains.set(f.settings, {
			smol: [`${remote}:low`, `consumer-local-test/${ordinary.id}`],
		});

		await expect(completion(f.toolSession)).rejects.toThrow("remote completion failed");
		expect(f.requests).toEqual([{ path: "/v1/chat/completions", model: f.remote.id }]);
	});

	test("a failed remote candidate reached after an ordinary failure stops the remaining chain", async () => {
		const f = await fixture(true, {
			ordinaryIds: ["claude-haiku-5-5", "fallback"],
			respond: (pathname, model) => {
				if (pathname === "/v1/chat/completions") {
					return Response.json({ error: { message: "remote fallback failed" } }, { status: 500 });
				}
				if (model !== "fallback") {
					return Response.json({ error: { message: "ordinary primary failed" } }, { status: 500 });
				}
				return undefined;
			},
		});
		const ordinary = f.ordinary;
		if (!ordinary) throw new Error("expected ordinary completion primary model");
		const remote = `jchtools/${f.remote.id}`;
		const fallback = "consumer-local-test/fallback";
		f.settings.setModelRole("smol", `consumer-local-test/${ordinary.id}:off`);
		cfgRetryEnabled.set(f.settings, true);
		cfgRetryMaxRetries.set(f.settings, 4);
		cfgRetryFallbackChains.set(f.settings, { smol: [remote, fallback], [remote]: [fallback] });

		await expect(completion(f.toolSession)).rejects.toThrow("remote fallback failed");
		expect(f.requests).toEqual([
			{ path: "/ordinary/chat/completions", model: ordinary.id },
			{ path: "/v1/chat/completions", model: f.remote.id },
		]);
	});

	test.each(["credential-error", "missing-credential", "schema"])(
		"remote completion %s failures do not issue a fallback request",
		async failure => {
			const f = await fixture(true);
			const ordinary = f.ordinary;
			if (!ordinary) throw new Error("expected ordinary completion fallback model");
			f.settings.setModelRole("smol", `jchtools/${f.remote.id}:off`);
			cfgRetryEnabled.set(f.settings, true);
			cfgRetryFallbackChains.set(f.settings, { smol: [`consumer-local-test/${ordinary.id}`] });
			if (failure !== "schema") {
				const getApiKey = f.registry.getApiKey.bind(f.registry);
				vi.spyOn(f.registry, "getApiKey").mockImplementation(async (model, ...args) => {
					if (model.api === f.remote.api) {
						if (failure === "credential-error") throw new Error("remote credential failed");
						return undefined;
					}
					return getApiKey(model, ...args);
				});
			}

			const error =
				failure === "schema"
					? "frontend tools and tool choice are unsupported"
					: failure === "credential-error"
						? "remote credential failed"
						: "has no API key for jchtools/";
			await expect(completion(f.toolSession, failure === "schema" ? { type: "object" } : undefined)).rejects.toThrow(
				error,
			);
			expect(f.requests).toEqual([]);
		},
	);

	test("explicit prewalk aliases keep an automatic pre-override default instead of the remote CLI pick", async () => {
		const f = await fixture();
		f.settings.setModelRole("default", "@smol:off");
		for (const target of ["default", "@default", "@smol"]) {
			f.settings.setModelRole("default", "@smol:off");
			const options = await buildSessionOptions(
				parseArgs(["--model", `jchtools/${f.remote.id}`, "--prewalk-into", target]),
				[],
				SessionManager.inMemory(),
				f.registry,
				f.settings,
			);
			expect(options.model?.provider).toBe("jchtools");
			expect(options.prewalk).toBeUndefined();
		}
		expect(f.requests).toEqual([]);
	});

	test.each(["active", "fallback"])("hub preserves an explicit remote %s selection", async source => {
		const f = await fixture();
		const selector = `jchtools/${f.remote.id}`;
		const hub = source === "active" ? f.hub(selector) : f.hub(undefined, selector);
		expect(await hub.generateAgent("a helpful agent", () => {})).toContain("generated-agent");
		expect(f.requests).toEqual([{ path: "/v1/chat/completions", model: f.remote.id }]);
	});
});
