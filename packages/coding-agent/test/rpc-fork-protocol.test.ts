import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";
import {
	dispatchRpcControlFrame,
	type RpcInputFrameDeps,
	type PendingExtensionRequest,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcForkHost, type RpcForkContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-host";
import {
	isNegotiableRpcProtocolVersion,
	RPC_FORK_PROTOCOL_VERSION,
	RPC_SUPPORTED_PROTOCOL_VERSIONS,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-types";
import type { RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

describe("fork protocol constants (4.0)", () => {
	test("ready frame announces [1, 2, 3]", () => {
		expect(RPC_SUPPORTED_PROTOCOL_VERSIONS).toEqual([1, 2, 3]);
		expect(RPC_FORK_PROTOCOL_VERSION).toBe(3);
	});

	test("negotiable versions are 2 and 3 only", () => {
		expect(isNegotiableRpcProtocolVersion(2)).toBe(true);
		expect(isNegotiableRpcProtocolVersion(3)).toBe(true);
		expect(isNegotiableRpcProtocolVersion(1)).toBe(false);
		expect(isNegotiableRpcProtocolVersion(4)).toBe(false);
		expect(isNegotiableRpcProtocolVersion(0)).toBe(false);
	});
});

const makeForkContext = (overrides?: Partial<RpcForkContext>): RpcForkContext => ({
	emit: () => {},
	success: (id, command, data) => ({ id, type: "response", command, success: true, data }) as RpcResponse,
	error: (id, command, message) => ({ id, type: "response", command, success: false, error: message }) as RpcResponse,
	...overrides,
});

describe("RpcForkHost gating (4.0)", () => {
	test("inactive host gates commands and frames but still disposes captured resources", async () => {
		const host = new RpcForkHost(makeForkContext());
		let commandRan = false;
		let disposerReason: string | undefined;
		host.registerCommand("fork_probe", () => {
			commandRan = true;
			return { type: "response", command: "fork_probe", success: true } as RpcResponse;
		});
		host.registerDisposer(reason => {
			disposerReason = reason;
		});

		expect(host.isActive).toBe(false);
		await expect(host.handleCommand({ type: "fork_probe" })).resolves.toBeUndefined();
		expect(host.handleControlFrame({ type: "permission_response", id: "x" })).toBe(false);
		host.dispose("client gone");
		expect(commandRan).toBe(false);
		expect(disposerReason).toBe("client gone");
	});

	test("activated host dispatches registered commands and consumes frames", async () => {
		const ctx = makeForkContext();
		const activeHost = new RpcForkHost(ctx);
		activeHost.registerCommand("fork_probe", command => {
			return activeHost.context.success(command.id, "fork_probe", { echoed: command.type });
		});
		let frameConsumed = false;
		activeHost.registerFrameHandler(parsed => {
			frameConsumed = isRecord(parsed) && parsed.type === "permission_response";
			return frameConsumed;
		});
		const disposals: string[] = [];
		activeHost.registerDisposer(reason => disposals.push(reason));

		activeHost.activate();
		expect(activeHost.isActive).toBe(true);

		const response = await activeHost.handleCommand({ id: "r1", type: "fork_probe" });
		expect(response).toMatchObject({ command: "fork_probe", success: true, data: { echoed: "fork_probe" } });
		await expect(activeHost.handleCommand({ type: "fork_unknown" })).resolves.toBeUndefined();
		expect(activeHost.handleControlFrame({ type: "permission_response", id: "p1" })).toBe(true);
		expect(frameConsumed).toBe(true);
		expect(activeHost.handleControlFrame({ type: "ask_response", id: "a1" })).toBe(false);

		activeHost.dispose("client gone");
		expect(disposals).toEqual(["client gone"]);
	});
});

const makeDeps = (options?: {
	pendingExtensionRequests?: Map<string, PendingExtensionRequest>;
	onForkControlFrame?: (parsed: unknown) => boolean;
}) => {
	const outputs: object[] = [];
	const handled: Array<{ type: string }> = [];
	const deps: RpcInputFrameDeps = {
		handleCommand: async command => {
			handled.push({ type: command.type });
			return {
				id: command.id,
				type: "response",
				command: command.type,
				success: false,
				error: `Unknown command: ${command.type}`,
			} as RpcResponse;
		},
		output: obj => outputs.push(obj),
		errorResponse: (id, command, message) => ({ id, type: "response", command, success: false, error: message }),
		pendingExtensionRequests: options?.pendingExtensionRequests ?? new Map<string, PendingExtensionRequest>(),
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
		onForkControlFrame: options?.onForkControlFrame,
	};
	return { deps, outputs, handled };
};

describe("fork bypass frame routing (4.0)", () => {
	test("fork control frames overtake the command queue when the host consumes them", () => {
		const host = new RpcForkHost(makeForkContext());
		host.registerFrameHandler(parsed => isRecord(parsed) && parsed.type === "permission_response");
		host.activate();
		const { deps, handled } = makeDeps({ onForkControlFrame: parsed => host.handleControlFrame(parsed) });

		expect(dispatchRpcControlFrame({ type: "permission_response", id: "p1", option: "allow_once" }, deps)).toBe(true);
		expect(handled).toEqual([]);
	});

	test("unconsumed fork frames fall through to stock unknown-command behavior", async () => {
		const host = new RpcForkHost(makeForkContext());
		host.registerFrameHandler(parsed => isRecord(parsed) && parsed.type === "permission_response");
		host.activate();
		const { deps, outputs, handled } = makeDeps({ onForkControlFrame: parsed => host.handleControlFrame(parsed) });

		expect(dispatchRpcControlFrame({ type: "ask_pause", targetId: "a1" }, deps)).toBe(false);
		const { dispatchRpcInputFrame } = await import("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode");
		await dispatchRpcInputFrame({ type: "ask_pause", targetId: "a1" }, deps);
		expect(handled).toEqual([{ type: "ask_pause" }]);
		expect(outputs[0]).toMatchObject({ command: "ask_pause", success: false });
	});

	test("without a fork host the frame keeps stock behavior (v2 degradation)", () => {
		const { deps, handled } = makeDeps();
		expect(dispatchRpcControlFrame({ type: "permission_response", id: "p1", option: "allow_once" }, deps)).toBe(
			false,
		);
		expect(handled).toEqual([]);
	});
});

// ============================================================================
// Live-server E2E (real public entry: omp --mode rpc-ui)
// ============================================================================

type RpcFrame = Record<string, unknown>;

async function withForkRpcServer<T>(
	run: (
		send: (frame: object) => void,
		next: (predicate?: (frame: RpcFrame) => boolean) => Promise<RpcFrame>,
	) => Promise<T>,
): Promise<T> {
	const child = Bun.spawn(
		[
			"bun",
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--mode",
			"rpc-ui",
			"--no-extensions",
			"--no-skills",
			"--no-tools",
			"--no-session",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: path.join(import.meta.dir, ".."),
			env: { ...Bun.env, PI_NO_TITLE: "1" } as unknown as Record<string, string | undefined>,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderrPromise = new Response(child.stderr).text();
	const queue: RpcFrame[] = [];
	let readerDone = false;
	let readerError: unknown;
	const lines = readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>);
	const pump = (async () => {
		try {
			for await (const line of lines) {
				if (isRecord(line)) queue.push(line);
			}
		} catch (error) {
			readerError = error;
		} finally {
			readerDone = true;
		}
	})();
	const send = (frame: object): void => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
	};
	const next = async (predicate?: (frame: RpcFrame) => boolean): Promise<RpcFrame> => {
		const match = predicate ?? (frame => frame.type === "response");
		for (let waited = 0; waited < 300; waited++) {
			const responseIndex = queue.findIndex(match);
			if (responseIndex !== -1) return queue.splice(responseIndex, 1)[0]!;
			queue.length = 0;
			if (readerDone) throw new Error(`RPC stream ended early: ${await stderrPromise} ${String(readerError ?? "")}`);
			await Bun.sleep(100);
		}
		throw new Error("Timed out waiting for RPC frame");
	};
	try {
		await child.stdin.flush?.();
		return await run(send, next);
	} finally {
		try {
			child.stdin.end();
		} catch {}
		child.kill();
		await child.exited.catch(() => {});
		await pump.catch(() => {});
		await stderrPromise.catch(() => {});
	}
}

describe("fork protocol negotiation (live rpc-ui server)", () => {
	test("ready announces [1,2,3]; v3 negotiation succeeds and gates the fork surface", async () => {
		await withForkRpcServer(async (send, next) => {
			const ready = await next(frame => frame.type === "ready");
			expect(ready.supportedProtocolVersions).toEqual([1, 2, 3]);
			expect(ready.protocolVersion).toBe(1);

			send({ id: "neg-v3", type: "negotiate_protocol", protocolVersion: 3 });
			const v3 = await next();
			expect(v3).toMatchObject({ id: "neg-v3", command: "negotiate_protocol", success: true });
			expect((v3.data as { protocolVersion: number }).protocolVersion).toBe(3);

			// Unknown commands still report the stock error after v3 negotiation.
			send({ id: "u1", type: "fork_no_such_command" });
			const unknown = await next();
			expect(unknown).toMatchObject({
				id: "u1",
				command: "fork_no_such_command",
				success: false,
				error: "Unknown command: fork_no_such_command",
			});

			// An unimplemented fork command would take the same path; a stock
			// command keeps working after negotiation.
			send({ id: "st1", type: "get_state" });
			const state = await next();
			expect(state).toMatchObject({ id: "st1", command: "get_state", success: true });
		});
	}, 60_000);

	test("v2 clients keep stock behavior: negotiate 2 works, invalid versions rejected", async () => {
		await withForkRpcServer(async (send, next) => {
			await next(frame => frame.type === "ready");

			send({ id: "neg-v2", type: "negotiate_protocol", protocolVersion: 2 });
			const v2 = await next();
			expect(v2).toMatchObject({ id: "neg-v2", command: "negotiate_protocol", success: true });
			expect((v2.data as { protocolVersion: number }).protocolVersion).toBe(2);

			send({ id: "neg-bad", type: "negotiate_protocol", protocolVersion: 9 });
			const bad = await next();
			expect(bad).toMatchObject({
				id: "neg-bad",
				command: "negotiate_protocol",
				success: false,
				error: "Unsupported RPC protocol version: 9",
			});

			// A fork bypass frame sent by a v2 client is not consumed: it lands
			// on the stock unknown-command path.
			send({ type: "permission_response", id: "p9", option: "allow_once" });
			send({ id: "probe-after-bypass", type: "get_state" });
			const bypass = await next();
			expect(bypass).toMatchObject({ command: "permission_response", success: false });
			const state = await next();
			expect(state).toMatchObject({ id: "probe-after-bypass", command: "get_state", success: true });
		});
	}, 60_000);
});
