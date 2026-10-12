import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessageEvent, Context } from "@oh-my-pi/pi-ai/types";
import {
	CodeAgentTokenCache, getCodeAgentModels, initializeCodeAgentProvider, streamCodeAgent,
} from "../src/config/codeagent-provider";
import { isCompanyLaneActive, setCompanyOfflineEnabled } from "../src/config/company-provider";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
	`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const success = () => new Response(chunk({ content: "ok" }) + chunk({}, "stop") + "data: [DONE]\n\n", {
	headers: { "content-type": "text/event-stream" },
});
const stalledSse = (delta: Record<string, unknown>) => new Response(new ReadableStream<Uint8Array>({
	start(controller) {
		controller.enqueue(new TextEncoder().encode(chunk(delta)));
	},
}), { headers: { "content-type": "text/event-stream" } });

async function httpProbe(
	readToken: () => string | undefined,
	respond: (request: Request, count: number) => Response,
	calls = 1,
	options?: OpenAICompletionsOptions,
) {
	const headers: Headers[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		headers.push(request.headers);
		return respond(request, headers.length);
	} });
	const cache = new CodeAgentTokenCache(readToken);
	const model = { ...getCodeAgentModels()[0]!, baseUrl: server.url.origin };
	const results = [];
	const events: AssistantMessageEvent[][] = [];
	try {
		for (let index = 0; index < calls; index++) {
			const stream = streamCodeAgent(model, context, {
				fetch, apiKey: "synthetic-unwanted-key", headers: { Authorization: "Bearer synthetic-unwanted-key" },
				...options,
			}, cache);
			const observed: AssistantMessageEvent[] = [];
			for await (const event of stream) observed.push(event);
			events.push(observed);
			results.push(await stream.result());
		}
		return { headers, results, events, cache };
	} finally {
		server.stop(true);
	}
}

// 覆盖 fork.md「CodeAgent 内置模型」：真实 localhost HTTP/SSE 边界，不接触真实凭据。
describe("CodeAgent hot credential refresh", () => {

	test("successful requests use startup cache and x-auth-token only", async () => {
		let reads = 0;
		const probe = await httpProbe(() => { reads++; return "synthetic-A"; }, success, 2);
		expect(reads).toBe(1);
		expect(probe.results.map(result => result.stopReason)).toEqual(["stop", "stop"]);
		for (const headers of probe.headers) {
			expect(headers.get("x-auth-token")).toBe("synthetic-A");
			expect(headers.get("authorization")).toBeNull();
			expect(headers.get("x-api-key")).toBeNull();
		}
	});

	for (const status of [401, 503]) {
		test(`changed token retries once after HTTP ${status}`, async () => {
			let reads = 0;
			const probe = await httpProbe(() => ++reads === 1 ? "synthetic-A" : "synthetic-B",
				(_request, count) => count === 1 ? new Response("synthetic-private-error", { status }) : success());
			expect(reads).toBe(2);
			expect(probe.headers.map(headers => headers.get("x-auth-token"))).toEqual(["synthetic-A", "synthetic-B"]);
			expect(probe.results[0]!.stopReason).toBe("stop");
			expect(probe.events[0]!.filter(event => event.type === "start")).toHaveLength(1);
		});
	}

	test("unchanged token never enters generic HTTP or provider retries", async () => {
		let reads = 0;
		const probe = await httpProbe(() => { reads++; return "synthetic-A"; },
			() => new Response("synthetic-A private payload", { status: 503 }));
		expect(probe.headers).toHaveLength(1);
		expect(reads).toBe(2);
		expect(probe.results[0]!.stopReason).toBe("error");
		expect(probe.results[0]!.errorMessage).not.toContain("synthetic-A");
		expect(probe.results[0]!.errorMessage).not.toContain("private payload");
	});

	test("second failure refreshes cache but cannot replay again", async () => {
		let reads = 0;
		const probe = await httpProbe(() => ["synthetic-A", "synthetic-B", "synthetic-C"][reads++],
			(_request, count) => count <= 2 ? new Response("private", { status: 401 }) : success(), 2);
		expect(probe.headers.map(headers => headers.get("x-auth-token"))).toEqual(["synthetic-A", "synthetic-B", "synthetic-C"]);
		expect(probe.results.map(result => result.stopReason)).toEqual(["error", "stop"]);
	});

	for (const delta of [{ content: "partial" }, { reasoning_content: "partial" },
		{ tool_calls: [{ index: 0, id: "fixture-tool", type: "function", function: { name: "fixture", arguments: "{" } }] }]) {
		test(`partial ${Object.keys(delta)[0]} is not replayed and the next call uses refreshed cache`, async () => {
			let reads = 0;
			const probe = await httpProbe(() => ++reads === 1 ? "synthetic-A" : "synthetic-B",
				(_request, count) => count === 1 ? new Response(chunk(delta) +
					'data: {"error":{"message":"synthetic-A private SSE payload","code":401}}\n\n',
					{ headers: { "content-type": "text/event-stream" } }) : success(), 2);
			expect(probe.headers.map(headers => headers.get("x-auth-token"))).toEqual(["synthetic-A", "synthetic-B"]);
			expect(probe.results.map(result => result.stopReason)).toEqual(["error", "stop"]);
			expect(probe.results[0]!.content.length).toBeGreaterThan(0);
			expect(probe.results[0]!.errorMessage).not.toContain("private SSE payload");
		});
	}


	test("pre-output SSE errors may replay only with a changed token", async () => {
		let reads = 0;
		const probe = await httpProbe(() => ++reads === 1 ? "synthetic-A" : "synthetic-B",
			(_request, count) => count === 1
				? new Response('data: {"error":{"message":"private SSE error","code":401}}\n\n',
					{ headers: { "content-type": "text/event-stream" } })
				: success());
		expect(probe.headers.map(headers => headers.get("x-auth-token"))).toEqual(["synthetic-A", "synthetic-B"]);
		expect(probe.results[0]!.stopReason).toBe("stop");
	});

	test("transport failures are not internally retried with the old token", async () => {
		let reads = 0;
		let requests = 0;
		const tokens: (string | null)[] = [];
		const cache = new CodeAgentTokenCache(() => ++reads === 1 ? "synthetic-A" : "synthetic-B");
		const result = await streamCodeAgent(getCodeAgentModels()[0]!, context, {
			fetch: async (_input, init) => {
				tokens.push(new Headers(init?.headers).get("x-auth-token"));
				if (++requests === 1) throw new Error("ECONNRESET synthetic-A private");
				return success();
			},
		}, cache).result();
		expect(result.stopReason).toBe("stop");
		expect(tokens).toEqual(["synthetic-A", "synthetic-B"]);
		expect(reads).toBe(2);
	});

	test("a connection closing after text refreshes only the next request", async () => {
		let reads = 0;
		const probe = await httpProbe(() => ++reads === 1 ? "synthetic-A" : "synthetic-B",
			(_request, count) => count === 1
				? new Response(chunk({ content: "partial" }), { headers: { "content-type": "text/event-stream" } })
				: success(), 2);
		expect(probe.headers.map(headers => headers.get("x-auth-token"))).toEqual(["synthetic-A", "synthetic-B"]);
		expect(probe.results.map(result => result.stopReason)).toEqual(["error", "stop"]);
	});

	for (const [phase, delta] of [
		["first event", { role: "assistant" }],
		["idle", { content: "partial" }],
	] as const) {
		test(`${phase} HTTP/SSE timeout remains a safe timeout failure, not cancellation`, async () => {
			let reads = 0;
			const probe = await httpProbe(() => { reads++; return "synthetic-timeout-token"; },
				() => stalledSse(delta), 1, {
					streamFirstEventTimeoutMs: phase === "first event" ? 100 : 1000,
					streamIdleTimeoutMs: 100,
				});
			const result = probe.results[0]!;
			expect(result.stopReason).toBe("error");
			expect(AIError.is(result.errorId, AIError.Flag.Timeout)).toBe(true);
			expect(AIError.is(result.errorId, AIError.Flag.Abort)).toBe(false);
			expect(result.errorMessage).not.toContain("cancelled");
			expect(result.errorMessage).not.toContain("synthetic-timeout-token");
			expect(probe.headers).toHaveLength(1);
			expect(reads).toBe(2);
		});
	}

	test("caller cancellation of a real HTTP/SSE request is aborted without replay", async () => {
		let reads = 0;
		const controller = new AbortController();
		const probe = await httpProbe(() => ++reads === 1 ? "synthetic-cancel-A" : "synthetic-cancel-B",
			() => stalledSse({ role: "assistant" }), 1, {
				signal: controller.signal,
				streamFirstEventTimeoutMs: 1000,
				streamIdleTimeoutMs: 1000,
				onResponse: () => controller.abort(new Error("synthetic-cancel-A private cancellation")),
			});
		const result = probe.results[0]!;
		expect(result.stopReason).toBe("aborted");
		expect(AIError.is(result.errorId, AIError.Flag.Abort)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Timeout)).toBe(false);
		expect(result.errorMessage).not.toContain("synthetic-cancel-A");
		expect(result.errorMessage).not.toContain("private cancellation");
		expect(probe.headers).toHaveLength(1);
		expect(reads).toBe(2);
	});

	test("missing/failed registry reads preserve the cached token", () => {
		let reads = 0;
		const cache = new CodeAgentTokenCache(() => {
			if (reads++ === 0) return "synthetic-A";
			if (reads === 2) return undefined;
			throw new Error("private");
		});
		expect(cache.refresh()).toBe("synthetic-A");
		expect(cache.refresh()).toBe("synthetic-A");
	});

	test("cancelled requests never replay even if the registry changes", async () => {
		let requests = 0;
		let reads = 0;
		const controller = new AbortController();
		const cache = new CodeAgentTokenCache(() => ++reads === 1 ? "synthetic-A" : "synthetic-B");
		const stream = streamCodeAgent(getCodeAgentModels()[0]!, context, {
			signal: controller.signal, fetch: async () => {
				requests++;
				controller.abort();
				throw new Error("synthetic-A private cancellation");
			},
		}, cache);
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(requests).toBe(1);
		expect(cache.token).toBe("synthetic-B");
		expect(result.errorMessage).not.toContain("synthetic-A");
	});

	test("public streamSimple hot-refreshes the same model without invoking an auth resolver", async () => {
		let reads = 0;
		initializeCodeAgentProvider(new CodeAgentTokenCache(() => ++reads === 1 ? "synthetic-public-A" : "synthetic-public-B"));
		try {
			let resolvers = 0;
			let calls = 0;
			const tokens: (string | null)[] = [];
			const model = getCodeAgentModels()[0]!;
			for (let turn = 0; turn < 2; turn++) {
				const result = await streamSimple(model, context, {
					apiKey: async () => { resolvers++; return "synthetic-unwanted"; },
					fetch: async (_input, init) => {
						calls++;
						const headers = new Headers(init?.headers);
						tokens.push(headers.get("x-auth-token"));
						expect(headers.get("authorization")).toBeNull();
						return calls === 1 ? new Response("private", { status: 401 }) : success();
					},
				}).result();
				expect(result.stopReason).toBe("stop");
			}
			expect(tokens).toEqual(["synthetic-public-A", "synthetic-public-B", "synthetic-public-B"]);
			expect(resolvers).toBe(0);
			expect(reads).toBe(2);
		} finally {
			initializeCodeAgentProvider(new CodeAgentTokenCache(() => undefined));
		}
	});

	test("other OpenAI providers retain their own headers and do not read this cache", async () => {
		let calls = 0;
		const result = await streamOpenAICompletions({ ...getCodeAgentModels()[0]!, provider: "openai" }, context, {
			apiKey: "synthetic-openai", fetch: async (_input, init) => {
				calls++;
				const headers = new Headers(init?.headers);
				expect(headers.get("authorization")).toBe("Bearer synthetic-openai");
				expect(headers.get("x-auth-token")).toBeNull();
				return success();
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(calls).toBe(1);
	});

	for (const platform of new Set([process.platform, "win32", "linux"])) {
		test(`registry on ${platform} exposes CodeAgent only on Windows, never offline or disabled`, async () => {
			const home = fs.mkdtempSync(path.join(os.tmpdir(), "codeagent-registry-"));
			const offline = isCompanyLaneActive();
			const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
			if (!descriptor) throw new Error("process.platform descriptor is unavailable");
			const auth = createInMemoryAuthStorage();
			initializeCodeAgentProvider(new CodeAgentTokenCache(() => undefined));
			try {
				Object.defineProperty(process, "platform", { ...descriptor, value: platform });
				setCompanyOfflineEnabled(false);
				const modelId = getCodeAgentModels()[0]!.id;
				const registry = new ModelRegistry(auth, path.join(home, "models.yml"), { settings: Settings.isolated({}) });
				const assertVisible = (visible: boolean) => {
					expect(registry.getProviderModels("codeagent").some(model => model.id === modelId)).toBe(visible);
					expect(registry.getAll().some(model => model.provider === "codeagent")).toBe(visible);
					expect(registry.getAvailable().some(model => model.provider === "codeagent")).toBe(visible);
					expect(registry.find("codeagent", modelId) !== undefined).toBe(visible);
				};
				assertVisible(platform === "win32");
				await registry.refresh("offline");
				assertVisible(platform === "win32");
				const disabled = new ModelRegistry(auth, path.join(home, "models.yml"), {
					settings: Settings.isolated({ disabledProviders: ["codeagent"] }),
				});
				expect(disabled.getAvailable().some(model => model.provider === "codeagent")).toBe(false);
				expect(disabled.find("codeagent", modelId)).toBeUndefined();
				setCompanyOfflineEnabled(true);
				await registry.refresh("offline");
				assertVisible(false);
				const intranet = new ModelRegistry(auth, path.join(home, "models.yml"), { settings: Settings.isolated({}) });
				expect(intranet.getAll().some(model => model.provider === "codeagent")).toBe(false);
				expect(intranet.getAvailable().some(model => model.provider === "codeagent")).toBe(false);
				expect(intranet.find("codeagent", modelId)).toBeUndefined();
			} finally {
				Object.defineProperty(process, "platform", descriptor);
				setCompanyOfflineEnabled(offline);
				initializeCodeAgentProvider(new CodeAgentTokenCache(() => undefined));
				auth.close();
				fs.rmSync(home, { recursive: true, force: true });
			}
		});
	}
});
