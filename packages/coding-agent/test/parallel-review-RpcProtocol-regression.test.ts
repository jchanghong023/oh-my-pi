import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

// Exercise the real RPC/session boundary; only provider output is scripted.
const fixture = `
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
const cwd = process.env.RPC_REVIEW_CWD;
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const registry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const manager = SessionManager.inMemory(cwd);
const runtime = new ExtensionRuntime();
let session;
const extension = await loadExtensionFromFactory(pi => {
  pi.on("input", async (event, ctx) => {
    if (event.text === "block-input") await ctx.ui.confirm("Hold input", "Wait for cancellation");
    if (event.text === "switch-during-input") await session.newSession();
  });
}, cwd, new EventBus(), runtime, "rpc-review");
const runner = new ExtensionRunner([extension], runtime, cwd, manager, registry);
const mock = createMockModel({ handler: { content: ["ok"] } });
const agent = new Agent({
  getApiKey: () => "test-key",
  initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5"), tools: [] },
  streamFn: mock.stream,
});
session = new AgentSession({
  agent, sessionManager: manager, modelRegistry: registry, extensionRunner: runner,
  providerSessionId: "pinned-provider-session",
  settings: Settings.isolated({ "compaction.enabled": false }),
});
await runRpcMode(session);
`;

async function startServer(cwd: string) {
	const child = Bun.spawn([process.execPath, "--eval", fixture], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		env: { ...Bun.env, RPC_REVIEW_CWD: cwd, PI_CODING_AGENT_DIR: cwd, PI_NO_TITLE: "1" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const frames: Record<string, unknown>[] = [];
	const waiters = new Set<() => void>();
	let ended = false;
	const stderr = new Response(child.stderr).text();
	const pump = (async () => {
		try {
			for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
				if (isRecord(frame)) frames.push(frame);
				for (const wake of waiters) wake();
			}
		} finally {
			ended = true;
			for (const wake of waiters) wake();
		}
	})();
	const next = async (predicate: (frame: Record<string, unknown>) => boolean) => {
		for (;;) {
			const frame = frames.find(predicate);
			if (frame) return frame;
			if (ended) throw new Error(`RPC fixture ended: ${await stderr}`);
			const pending = Promise.withResolvers<void>();
			waiters.add(pending.resolve);
			try {
				await pending.promise;
			} finally {
				waiters.delete(pending.resolve);
			}
		}
	};
	const send = (frame: object) => child.stdin.write(`${JSON.stringify(frame)}\n`);
	const close = async () => {
		child.stdin.end();
		await child.exited;
		await pump;
	};
	return { child, frames, next, send, close, stderr };
}

describe("RPC ordered admission cancellation", () => {
	test("EOF cancels a waiting input hook and queued prompts without starting a model turn", async () => {
		await using root = await TempDir.create("rpc-review-eof-");
		const server = await startServer(root.absolute());
		try {
			await server.next(frame => frame.type === "ready");
			server.send({ id: "blocked", type: "prompt", message: "block-input" });
			await server.next(frame => frame.type === "extension_ui_request" && frame.method === "confirm");
			server.send({ id: "queued", type: "prompt", message: "must not execute after EOF" });
			await server.close();
			expect(await server.stderr).not.toContain("error:");
			expect(server.child.exitCode).toBe(0);
			expect(server.frames.some(frame => frame.type === "agent_start")).toBe(false);
			for (const id of ["blocked", "queued"]) {
				expect(server.frames.find(frame => frame.type === "response" && frame.id === id)).toMatchObject({
					success: true,
				});
			}
		} finally {
			if (server.child.exitCode === null) server.child.kill();
			await server.child.exited;
		}
	}, 30_000);

	test("a transcript switch during input preparation drops stale text even with a pinned provider session id", async () => {
		await using root = await TempDir.create("rpc-review-generation-");
		const server = await startServer(root.absolute());
		try {
			await server.next(frame => frame.type === "ready");
			server.send({ id: "switching", type: "prompt", message: "switch-during-input" });
			await server.next(frame => frame.type === "response" && frame.id === "switching");
			server.send({ id: "messages", type: "get_messages" });
			const response = await server.next(frame => frame.type === "response" && frame.id === "messages");
			expect(response).toMatchObject({ success: true, data: { messages: [] } });
			expect(server.frames.some(frame => frame.type === "agent_start")).toBe(false);
			await server.close();
			expect(server.child.exitCode).toBe(0);
		} finally {
			if (server.child.exitCode === null) server.child.kill();
			await server.child.exited;
		}
	}, 30_000);
});
