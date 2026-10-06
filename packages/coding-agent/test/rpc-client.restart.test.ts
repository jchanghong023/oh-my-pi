import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	MAX_RPC_FRAME_BYTES,
	MAX_RPC_REASSEMBLED_BYTES,
	RpcFrameEncoder,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { rejectionOf } from "./helpers/rejection";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Bun on Windows unreliably delivers child stdout: with a read already
// pending, a child's fast back-to-back frame writes can vanish entirely, so
// request/response round trips hang until the 20-30s timeouts fire. The whole
// lifecycle file spawns mock agents over that transport.
describe.skipIf(process.platform === "win32")("RpcClient lifecycle (issue #4079 B)", () => {
	test("auto-negotiates protocol v2 and reassembles an oversized response", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1" },
		});

		await client.start();
		const state = (await client.getState()) as unknown as { payload: string };
		expect(state.payload).toBe("😀".repeat(270_000));
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 },
		]);
	}, 20_000);

	test("normalizes omitted state fields and a runtime-invalid tokensPerSecond", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LEGACY_STATE: "1", MOCK_RPC_INVALID_TPS: "1" },
		});

		await client.start();
		const state = await client.getState();
		expect(state.fastModeEnabled).toBe(false);
		expect(state.fastModeActive).toBe(false);
		expect(state.tokensPerSecond).toBeNull();
	}, 20_000);

	test("preserves getMessages snapshot behavior while a v2 page walk is unavailable", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_PAGE_BUSY: "1" },
		});

		await client.start();
		expect(await rejectionOf(client.getMessagesPage())).toMatchObject({
			message: expect.stringContaining("Cannot page messages while the session is changing"),
		});
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
		]);
	}, 20_000);

	test("discards partial pages and falls back to get_messages when a cursor goes stale mid-walk", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_PAGE_STALE: "1" },
		});

		await client.start();
		// Direct page walks stay strict: the stale cursor is surfaced to the caller.
		const firstPage = await client.getMessagesPage();
		expect(firstPage.nextCursor).toBe("second-page");
		expect(await rejectionOf(client.getMessagesPage({ cursor: firstPage.nextCursor }))).toMatchObject({
			message: expect.stringContaining("RPC message cursor is stale"),
		});
		// The high-level drain discards the partial first page and takes the legacy snapshot.
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
		]);
	}, 20_000);

	test("start() succeeds a second time after stop() on the same instance", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
		});

		// First lifecycle: start + stop.
		await client.start();
		await client.stop();

		// Second start on the same instance must NOT reuse the aborted
		// controller from the previous stop(). Before the fix, this rejected
		// with "Agent process exited before ready" because the JSONL reader
		// short-circuited on the pre-aborted signal.
		await client.start();
		await client.stop();
	}, 20000);

	test("start() waits for a signal-ignoring worker to be reaped after stop()", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-stop-restart-");
		const pidFile = tempDir.join("pid");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_PID_FILE: pidFile,
				MOCK_RPC_IGNORE_SIGTERM: process.platform === "win32" ? "0" : "1",
			},
			terminationGraceMs: 10,
		});

		await client.start();
		const firstPid = Number(await Bun.file(pidFile).text());

		const stopped = client.stop();
		const restarted = client.start();
		await Promise.all([stopped, restarted]);

		const secondPid = Number(await Bun.file(pidFile).text());
		expect(secondPid).not.toBe(firstPid);
		expect(isProcessAlive(firstPid)).toBe(false);
		await client.stop();
	}, 20_000);

	test("start() may be retried after a failed start (child is cleaned up on failure)", async () => {
		const env: Record<string, string> = {
			MOCK_RPC_EXIT_BEFORE_READY: "17",
			MOCK_RPC_EXIT_STDERR: "fixture startup failed",
		};
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env,
			terminationGraceMs: 10,
		});

		expect(await rejectionOf(client.start())).toMatchObject({
			message: expect.stringContaining("fixture startup failed"),
		});

		// Before the fix, #process stayed set after the failed spawn so the
		// second start() rejected with "Client already started". A successful
		// retry proves both the child and the client lifecycle state were reset.
		delete env.MOCK_RPC_EXIT_BEFORE_READY;
		await client.start();
		await client.stop();
	}, 10_000);

	test("stop() rejects active requests instead of leaving them to time out", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_IGNORE_COMMANDS: "1" },
		});
		await client.start();

		const pending = client.getState();
		client.stop();

		await expect(pending).rejects.toThrow("Client stopped");
	});

	test("rejects pending requests and reaps the worker when stdout parsing fails", async () => {
		// This awaits the real child-process grace-to-hard-kill path; fake timers
		// cannot drive OS signal delivery or process reaping.
		using tempDir = TempDir.createSync("@omp-rpc-reader-failure-");
		const pidFile = tempDir.join("pid");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_PID_FILE: pidFile,
				MOCK_RPC_INVALID_OUTPUT: "1",
				MOCK_RPC_IGNORE_SIGTERM: process.platform === "win32" ? "0" : "1",
			},
			terminationGraceMs: 10,
		});

		let pid = 0;
		try {
			await client.start();
			pid = Number(await Bun.file(pidFile).text());

			expect(await rejectionOf(client.getState())).toMatchObject({
				message: expect.stringMatching(/Agent output reader failed/),
			});
			await expect(client.getState()).rejects.toThrow("Client not started");
			expect(isProcessAlive(pid)).toBe(false);
		} finally {
			if (pid > 0 && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
		}
	}, 10_000);

	test("reports exit code and stderr when a ready worker exits", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_EXIT_ON_COMMAND: "23",
				MOCK_RPC_EXIT_STDERR: "fixture worker failed",
			},
		});
		await client.start();

		expect(await rejectionOf(client.getState())).toMatchObject({
			message: expect.stringContaining("Agent process exited with code 23. Stderr: fixture worker failed"),
		});
	});

	test("rejects promptAndWait when a same-id error arrives after the success ack", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LATE_PROMPT_ERROR: "1" },
		});
		await client.start();
		expect(await rejectionOf(client.promptAndWait("deleted skill"))).toMatchObject({
			message: expect.stringContaining("skill file was deleted"),
		});
	});
});

function createForkTransport(options?: { negotiatedVersion?: number; negotiationError?: boolean }) {
	const encoder = new RpcFrameEncoder();
	const exited = Promise.withResolvers<number>();
	const sent: Array<Record<string, unknown>> = [];
	let output: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	const emit = (frame: object) => {
		for (const line of encoder.encodeFrames(frame)) output.enqueue(new TextEncoder().encode(line));
	};
	const process: RpcAgentProcess = {
		stdin: {
			write(data) {
				const command = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
				sent.push(command);
				if (command.type === "negotiate_protocol") {
					if (options?.negotiationError) {
						emit({
							id: command.id,
							type: "response",
							success: false,
							command: "error",
							error: "fork not supported",
							code: "unsupported",
						});
					} else {
						emit({
							id: command.id,
							type: "response",
							success: true,
							command: command.type,
							data: { protocolVersion: options?.negotiatedVersion ?? 3 },
						});
						encoder.setProtocolVersion(2);
					}
				} else if (command.type === "set_approval_mode") {
					emit({
						id: command.id,
						type: "response",
						success: true,
						command: command.type,
						data: { payload: "😀".repeat(270_000) },
					});
				} else {
					emit({
						id: command.id,
						type: "response",
						success: false,
						error: "raw command was denied",
						code: "permission_denied",
					});
				}
			},
		},
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				output = controller;
				emit({
					type: "ready",
					supportedProtocolVersions: [1, 3],
					maxFrameBytes: MAX_RPC_FRAME_BYTES,
					maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
				});
			},
		}),
		peekStderr: () => "",
		kill() {
			if (closed) return;
			closed = true;
			output.close();
			exited.resolve(0);
		},
		exited: exited.promise,
	};
	return { client: new RpcClient({ spawn: () => process }), sent };
}

describe("RpcClient fork response transport", () => {
	test("v3-only negotiation enables chunk decoding and response-correlated raw commands", async () => {
		const { client, sent } = createForkTransport();
		try {
			await client.start();
			await expect(client.requestFork("set_approval_mode")).rejects.toThrow("has not been negotiated");
			expect(() => client.sendForkFrame({ type: "ask_pause" })).toThrow("has not been negotiated");
			await client.negotiateProtocolV3();
			expect(sent[0]).toMatchObject({ type: "negotiate_protocol", protocolVersion: 3 });
			expect(await client.requestFork<{ payload: string }>("set_approval_mode")).toEqual({
				payload: "😀".repeat(270_000),
			});
			await expect(
				client.requestFork("set_settings", { scope: "user", key: "theme.dark", value: "titanium" }),
			).rejects.toMatchObject({
				command: "set_settings",
				code: "permission_denied",
				message: "raw command was denied",
			});
		} finally {
			await client.stop();
		}
	});

	test.each([{ negotiatedVersion: 2 }, { negotiationError: true }])(
		"invalid v3 acknowledgements never open the fork gate (%o)",
		async options => {
			const { client } = createForkTransport(options);
			try {
				await client.start();
				await expect(client.negotiateProtocolV3()).rejects.toMatchObject({
					command: "negotiate_protocol",
					...(options.negotiationError ? { code: "unsupported", message: "fork not supported" } : {}),
				});
				expect(client.forkNegotiated).toBe(false);
				await expect(client.requestFork("set_approval_mode")).rejects.toThrow("has not been negotiated");
				expect(() => client.sendForkFrame({ type: "ask_pause" })).toThrow("has not been negotiated");
			} finally {
				await client.stop();
			}
		},
	);
});
