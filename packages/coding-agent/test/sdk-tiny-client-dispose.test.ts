import { describe, expect, it, vi } from "bun:test";
import type { Api, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/daemon/client";
import type { DaemonClient, DaemonTunnel, UnitSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type { TinyWorkerRequest, TinyWorkerResponse } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";
import { TempDir } from "@oh-my-pi/pi-utils";

const modelSpec: ModelSpec<Api> = {
	id: "tiny-client-dispose",
	name: "Tiny client dispose",
	api: "test-tiny-client-dispose",
	provider: "managed-primary",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 1024,
};
const model = buildModel(modelSpec);

const TINY_MODEL = "qwen3-1.7b";

/** Replaces the daemon transport, leaving the real InferConnection and Tiny client in use. */
function fakeInferDaemon() {
	const received = () => Promise.withResolvers<(text: string) => void>();
	let nextChat = received();
	const released: string[] = [];
	const closed: string[] = [];
	let opens = 0;
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const stub: Pick<DaemonClient, "open" | "attach" | "release" | "onReconnect"> = {
		async open(request) {
			expect(request.kind).toBe("infer");
			expect(request.key).toStartWith(`tiny:${TINY_MODEL}:onnx:`);
			const id = String(++opens);
			return { unit: { id } as UnitSnapshot, lease: id, created: true };
		},
		async attach(unit) {
			if (typeof unit !== "string") throw new Error("Expected an infer unit ID");
			let onData: Parameters<DaemonTunnel["start"]>[0];
			return {
				unit: { id: unit } as UnitSnapshot,
				send(line) {
					const request = JSON.parse(typeof line === "string" ? line : decoder.decode(line)) as TinyWorkerRequest;
					if (request.type === "chat") {
						nextChat.resolve(text => {
							if (closed.includes(unit)) return;
							const reply: TinyWorkerResponse = { type: "text", id: request.id, text };
							onData(encoder.encode(`${JSON.stringify(reply)}\n`));
						});
					}
					return true;
				},
				async drained() {},
				start(receive) {
					onData = receive;
				},
				close() {
					closed.push(unit);
				},
				ref() {},
				unref() {},
			};
		},
		async release(lease) {
			released.push(lease);
		},
		onReconnect: () => () => {},
	};
	return {
		stub: stub as DaemonClient,
		closed,
		released,
		async replyFor(completion: Promise<string | null>) {
			const reply = await Promise.race([nextChat.promise, completion]);
			if (typeof reply !== "function") throw new Error("Tiny completion settled before reaching the infer tunnel");
			nextChat = received();
			return reply;
		},
	};
}

const TEST_NAME = "keeps pending requests alive until the final SDK owner disposes";
const CHILD_ENV = "OMP_TEST_TINY_CLIENT_DISPOSE";

describe("tiny-model client shutdown on session dispose", () => {
	const starter = async (tempDir: TempDir, sessions: AgentSession[]) => {
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const start = async (
			settings: Settings,
			extra: Pick<CreateAgentSessionOptions, "parentTaskPrefix" | "taskDepth" | "agentId" | "bindProcessState"> = {},
		): Promise<AgentSession> => {
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				toolNames: [],
				enableMCP: false,
				enableLsp: false,
				...extra,
			});
			sessions.push(session);
			return session;
		};
		return { start, close: () => authStorage.close() };
	};

	it(
		TEST_NAME,
		async () => {
			// Every process-state owner must belong to this test, even in a batched run.
			if (process.env[CHILD_ENV] !== "1") {
				using root = TempDir.createSync("@pi-tiny-client-process-");
				const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", TEST_NAME], {
					env: {
						...process.env,
						[CHILD_ENV]: "1",
						OMP_CONFIG_ROOT: root.path(),
						PI_CODING_AGENT_DIR: root.join("agent"),
						PI_TINY_DEVICE: "cpu",
					},
					stdout: "pipe",
					stderr: "pipe",
					signal: AbortSignal.timeout(30_000),
				});
				const [exit, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(exit, stdout + stderr).toBe(0);
				expect(stdout + stderr).toMatch(/\b1 pass\b/);
				return;
			}

			using tempDir = TempDir.createSync("@pi-tiny-client-dispose-");
			const sessions: AgentSession[] = [];
			const { start, close } = await starter(tempDir, sessions);
			const transport = fakeInferDaemon();
			const client = tinyTitleClient;
			using mocks = new DisposableStack();
			try {
				const parentSettings = Settings.isolated({ "compaction.enabled": false, "memory.backend": "off" });
				const parent = await start(parentSettings);
				const peer = await start(await parentSettings.cloneForCwd(tempDir.path()), { agentId: "Peer" });
				const sub = await start(createSubagentSettings(parentSettings), {
					parentTaskPrefix: "0-Sub",
					taskDepth: 1,
					agentId: "0-Sub",
				});
				const helper = await start(await parentSettings.cloneForCwd(tempDir.path()), { bindProcessState: false });
				const daemon = vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(transport.stub);
				mocks.defer(() => daemon.mockRestore());

				// A subagent, helper, or non-final SDK owner finishing leaves shared work running.
				const first = client.complete(TINY_MODEL, "first");
				const replyFirst = await transport.replyFor(first);
				await sub.dispose();
				await helper.dispose();
				await parent.dispose();
				expect(transport.closed).toEqual([]);
				expect(transport.released).toEqual([]);
				replyFirst("kept");
				expect(await first).toBe("kept");

				// Only the final process-state owner cancels in-flight work and drops the lease.
				const second = client.complete(TINY_MODEL, "second");
				await transport.replyFor(second);
				await peer.dispose();
				expect(await second).toBeNull();
				expect(transport.closed).toEqual(["1"]);
				expect(transport.released).toEqual(["1"]);

				// Repeat disposes must not cancel requests on a subsequently opened tunnel.
				const third = client.complete(TINY_MODEL, "third");
				const replyThird = await transport.replyFor(third);
				await parent.dispose();
				await peer.dispose();
				expect(transport.closed).toEqual(["1"]);
				replyThird("after");
				expect(await third).toBe("after");
			} finally {
				try {
					for (const session of sessions) await session.dispose();
					await client.terminate();
				} finally {
					close();
				}
			}
		},
		35_000,
	);
});
