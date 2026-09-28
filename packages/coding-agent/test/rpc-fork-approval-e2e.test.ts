import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "./utilities";

// Requirement 4.1 acceptance E2E (rpc-ui-protocol.md): model-driven approval
// flow against the real `omp --mode rpc-ui` entry. Requires an Anthropic API
// key (skipped otherwise — the protocol-level behavior is covered by
// rpc-fork-permission.test.ts and rpc-fork-protocol.test.ts).

type RpcFrame = Record<string, unknown>;

interface ServerHandle {
	send: (frame: object) => void;
	next: (predicate?: (frame: RpcFrame) => boolean) => Promise<RpcFrame>;
	dispose: () => Promise<void>;
}

async function spawnRpcServer(cwd: string, agentDir: string): Promise<ServerHandle> {
	const child = Bun.spawn(
		[
			"bun",
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--mode",
			"rpc-ui",
			"--no-extensions",
			"--no-skills",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd,
			env: { ...Bun.env, PI_NO_TITLE: "1", PI_CODING_AGENT_DIR: agentDir } as unknown as Record<
				string,
				string | undefined
			>,
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
		for (let waited = 0; waited < 1200; waited++) {
			const index = queue.findIndex(match);
			if (index !== -1) return queue.splice(index, 1)[0]!;
			queue.length = 0;
			if (readerDone) throw new Error(`RPC stream ended early: ${await stderrPromise} ${String(readerError ?? "")}`);
			await Bun.sleep(100);
		}
		throw new Error("Timed out waiting for RPC frame");
	};
	return {
		send,
		next,
		dispose: async () => {
			try {
				child.stdin.end();
			} catch {}
			child.kill();
			await child.exited.catch(() => {});
			await pump.catch(() => {});
			await stderrPromise.catch(() => {});
		},
	};
}

async function negotiate(handler: ServerHandle): Promise<void> {
	await handler.next(frame => frame.type === "ready");
	handler.send({ id: "neg", type: "negotiate_protocol", protocolVersion: 3 });
	await expect(handler.next()).resolves.toMatchObject({ data: { protocolVersion: 3 } });
}

const isPermissionRequest = (frame: RpcFrame): boolean =>
	frame.type === "permission_request" && isRecord(frame) && typeof frame.id === "string";

describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("rpc-ui approval E2E (4.1, live server)", () => {
	test("always-ask bash call raises permission_request; allow_once completes the turn", async () => {
		await using cwdDir = await TempDir.create("rpc-approval-cwd-");
		await using agentDir = await TempDir.create("rpc-approval-agent-");
		const handler = await spawnRpcServer(path.resolve(cwdDir.path()), path.resolve(agentDir.path()));
		try {
			await negotiate(handler);
			handler.send({ id: "am", type: "set_approval_mode", mode: "always-ask" });
			await expect(handler.next()).resolves.toMatchObject({
				command: "set_approval_mode",
				success: true,
				data: { approvalMode: "always-ask" },
			});

			handler.send({
				id: "p1",
				type: "prompt",
				message: "Use the bash tool to run exactly this command: echo rpc-e2e-ok. Do not run anything else.",
			});
			const request = await handler.next(isPermissionRequest);
			expect(request.toolName).toBe("bash");
			expect(request.approvalMode).toBe("always-ask");
			expect(request.tier).toBe("exec");
			expect((request.input as { command?: string }).command).toContain("echo rpc-e2e-ok");

			handler.send({ type: "permission_response", id: request.id, option: "allow_once" });
			const result = await handler.next(frame => frame.type === "prompt_result" && frame.id === "p1");
			expect(result).toMatchObject({ status: "completed" });
		} finally {
			await handler.dispose();
		}
	}, 300_000);

	test("allow_always persists across process restart: no further permission_request", async () => {
		await using cwdDir = await TempDir.create("rpc-allow-always-cwd-");
		await using agentDir = await TempDir.create("rpc-allow-always-agent-");
		const absCwd = path.resolve(cwdDir.path());
		const absAgent = path.resolve(agentDir.path());
		const runBashTurn = async (expectPermission: boolean) => {
			const handler = await spawnRpcServer(absCwd, absAgent);
			try {
				await negotiate(handler);
				handler.send({ id: "am", type: "set_approval_mode", mode: "always-ask" });
				await handler.next();
				handler.send({
					id: "p1",
					type: "prompt",
					message:
						"Use the bash tool to run exactly this command: echo allow-always-check. Do not run anything else.",
				});
				if (expectPermission) {
					const request = await handler.next(isPermissionRequest);
					handler.send({ type: "permission_response", id: request.id, option: "allow_always" });
				} else {
					// The tool must run without any permission_request; wait past the
					// point where the request would have arrived by racing the turn.
					const race = await Promise.race([
						handler.next(isPermissionRequest).then(frame => ({ kind: "permission" as const, frame })),
						handler
							.next(frame => frame.type === "prompt_result" && frame.id === "p1")
							.then(frame => ({ kind: "result" as const, frame })),
					]);
					expect(race.kind).toBe("result");
					expect(race.frame).toMatchObject({ status: "completed" });
					return;
				}
				const result = await handler.next(frame => frame.type === "prompt_result" && frame.id === "p1");
				expect(result).toMatchObject({ status: "completed" });
			} finally {
				await handler.dispose();
			}
		};

		await runBashTurn(true);
		// Same process family: allow_always is persisted via tools.approval.bash.
		await runBashTurn(false);
		// Fresh process: persistence must survive the restart (config hot reload).
		await runBashTurn(false);
	}, 600_000);
});
