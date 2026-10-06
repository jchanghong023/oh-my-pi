import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

type RpcFrame = Record<string, unknown>;

async function withProjectRpcServer<T>(
	cwd: string,
	run: (send: (frame: object) => void, next: (id: string) => Promise<RpcFrame>) => Promise<T>,
): Promise<T> {
	const child = Bun.spawn(
		[
			"bun",
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--mode",
			"rpc-ui",
			"--rpc-project",
			"--no-extensions",
			"--no-skills",
			"--no-tools",
			"--session-dir",
			path.join(cwd, "sessions"),
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd,
			env: {
				...Bun.env,
				PI_NO_TITLE: "1",
				PI_CODING_AGENT_DIR: path.join(cwd, "agent"),
				ANTHROPIC_API_KEY: "test-key",
			} as unknown as Record<string, string | undefined>,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderr = new Response(child.stderr).text();
	const queue: RpcFrame[] = [];
	const waiters: {
		id: string;
		resolve: (frame: RpcFrame) => void;
		reject: (error: Error) => void;
	}[] = [];
	let readerDone = false;
	let readerError: unknown;
	const publish = (frame: RpcFrame) => {
		const index = waiters.findIndex(
			waiter =>
				(waiter.id === "ready" && frame.type === "ready") ||
				(waiter.id !== "ready" && frame.type === "response" && frame.id === waiter.id),
		);
		if (index === -1) {
			queue.push(frame);
			return;
		}
		waiters.splice(index, 1)[0]!.resolve(frame);
	};
	const lines = readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>);
	const pump = (async () => {
		try {
			for await (const line of lines) {
				if (isRecord(line)) publish(line);
			}
		} catch (error) {
			readerError = error;
		} finally {
			readerDone = true;
			if (waiters.length > 0) {
				const message = `RPC stream ended early: ${await stderr} ${String(readerError ?? "")}`;
				for (const waiter of waiters.splice(0)) waiter.reject(new Error(message));
			}
		}
	})();
	const send = (frame: object) => child.stdin.write(`${JSON.stringify(frame)}\n`);
	const next = (id: string): Promise<RpcFrame> => {
		const index = queue.findIndex(
			frame =>
				(id === "ready" && frame.type === "ready") ||
				(id !== "ready" && frame.type === "response" && frame.id === id),
		);
		if (index !== -1) return Promise.resolve(queue.splice(index, 1)[0]!);
		if (readerDone) return Promise.reject(new Error(`RPC stream ended before ${id}: ${String(readerError ?? "")}`));
		const { promise, resolve, reject } = Promise.withResolvers<RpcFrame>();
		waiters.push({ id, resolve, reject });
		return promise;
	};
	try {
		const ready = await next("ready");
		expect(ready.type).toBe("ready");
		return await run(send, next);
	} finally {
		try {
			child.stdin.end();
		} catch {}
		child.kill();
		await child.exited.catch(() => {});
		await pump.catch(() => {});
		await stderr.catch(() => {});
	}
}

describe("RPC attachment boundary", () => {
	test("does not read server-local paths from unsupported attachment fields", async () => {
		await using temp = await TempDir.create("rpc-no-attachment-proxy-");
		const cwd = path.resolve(temp.path());
		await withProjectRpcServer(cwd, async (send, next) => {
			send({ id: "negotiate", type: "negotiate_protocol", protocolVersion: 3 });
			expect(await next("negotiate")).toMatchObject({ success: true, data: { protocolVersion: 3 } });

			send({ id: "create", type: "create_session" });
			const created = await next("create");
			expect(created.success).toBe(true);
			const session = created.data as { sessionId: string; sessionGeneration: string };

			// An unsupported extra field must not become a local file-read proxy. An
			// empty ordinary prompt remains local and does not invoke a model.
			send({
				id: "empty-prompt",
				type: "prompt",
				sessionId: session.sessionId,
				sessionGeneration: session.sessionGeneration,
				message: "",
				attachments: [{ kind: "file", path: path.join(cwd, "must-not-be-read.txt") }],
			});
			expect(await next("empty-prompt")).toMatchObject({
				success: true,
				command: "prompt",
				data: { agentInvoked: false },
			});
		});
	}, 60_000);
});
