import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

const sourceId = "embedded-turns-test";

function message(content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		api: "mock",
		provider: "mock",
		model: "mock-model",
		content,
		stopReason,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function withRouter(
	provider: (context: Context) => { result: AssistantMessage; bare?: boolean },
	run: (request: (path: string, body: unknown) => Promise<Response>) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-embedded-turns-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("mock", "test-key");
	const model = createMockModel();
	registerCustomApi(
		"mock",
		(_model, context) => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const { result, bare } = provider(context);
				if (bare) {
					stream.end(result);
				} else {
					stream.push({ type: "start", partial: result });
					for (const [contentIndex, block] of result.content.entries()) {
						if (block.type !== "toolCall") continue;
						stream.push({ type: "toolcall_start", contentIndex, partial: result });
						stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: result });
					}
					stream.push({ type: "done", reason: result.stopReason as "stop" | "toolUse", message: result });
				}
			});
			return stream;
		},
		sourceId,
	);
	const router = createAuthGatewayRouter({ storage, resolveModel: () => model, preserveAssistantToolTurns: true });
	try {
		await run((route, body) =>
			router.route(
				new Request(`http://localhost${route}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
				"test",
			),
		);
	} finally {
		router.close();
		storage.close();
		unregisterCustomApis(sourceId);
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function history(seed: string, ids: string[]) {
	return [
		{ role: "user", content: seed },
		...ids.flatMap(id => [
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id, type: "function", function: { name: "lookup", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: id, content: "result" },
		]),
	];
}

function signatures(context: Context): Array<string | undefined> {
	return context.messages.flatMap(msg =>
		msg.role === "assistant"
			? msg.content.flatMap(part => (part.type === "toolCall" ? [part.thoughtSignature] : []))
			: [],
	);
}

describe("embedded gateway tool turns", () => {
	it("replays every native turn across repeated tool round trips", async () => {
		const observed: Array<Array<string | undefined>> = [];
		let count = 0;
		await withRouter(
			context => {
				observed.push(signatures(context));
				const id = `call_${++count}`;
				return {
					result: message(
						[{ type: "toolCall", id, name: "lookup", arguments: {}, thoughtSignature: `native_${id}` }],
						"toolUse",
					),
				};
			},
			async request => {
				for (const ids of [[], ["call_1"], ["call_1", "call_2"]]) {
					const response = await request("/v1/chat/completions", {
						model: "mock-model",
						messages: history("hello", ids),
						stream: ids.length === 0,
					});
					expect(response.status).toBe(200);
					const body = await response.text();
					if (ids.length === 0) expect(body).toContain("[DONE]");
				}
				expect(observed).toEqual([[], ["native_call_1"], ["native_call_1", "native_call_2"]]);
			},
		);
	});

	it("evicts older payloads while retaining recent conversations", async () => {
		let last: Array<string | undefined> = [];
		const signature = "x".repeat(600_000);
		await withRouter(
			context => {
				last = signatures(context);
				const seed = context.messages[0];
				if (seed?.role !== "user" || typeof seed.content !== "string") throw new Error("expected seed");
				return {
					result: message(
						[{ type: "toolCall", id: seed.content, name: "lookup", arguments: {}, thoughtSignature: signature }],
						"toolUse",
					),
				};
			},
			async request => {
				for (let i = 0; i < 16; i++) {
					const response = await request("/v1/chat/completions", {
						model: "mock-model",
						messages: history(`call_${i}`, []),
					});
					expect(response.status).toBe(200);
					await response.text();
				}
				let response = await request("/v1/chat/completions", {
					model: "mock-model",
					messages: history("call_15", ["call_15"]),
				});
				expect(response.status).toBe(200);
				await response.text();
				expect(last).toEqual([signature]);
				response = await request("/v1/chat/completions", {
					model: "mock-model",
					messages: history("call_0", ["call_0"]),
				});
				expect(response.status).toBe(200);
				await response.text();
				expect(last).toEqual([undefined]);
			},
		);
	});

	it("completes a Responses stream whose provider ends with only a result", async () => {
		await withRouter(
			() => ({ result: message([{ type: "text", text: "finished" }], "stop"), bare: true }),
			async request => {
				const response = await request("/v1/responses", { model: "mock-model", input: "hello", stream: true });
				expect(response.status).toBe(200);
				const body = await response.text();
				expect(body).toContain("event: response.completed");
				expect(body).toContain("finished");
				expect(body).not.toContain("event: response.failed");
			},
		);
	});
});
