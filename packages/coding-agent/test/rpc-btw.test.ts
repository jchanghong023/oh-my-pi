import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { BtwHistoryRecord } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/** Settle a request before `expect` sees it (see rpc-goal.test.ts). */
async function rejectionOf(request: Promise<unknown>): Promise<Error> {
	return await request.then(
		() => new Error("expected the request to fail"),
		(error: unknown) => error as Error,
	);
}

describe("RPC /btw", () => {
	let client: RpcClient | undefined;
	let directory: string | undefined;

	afterEach(async () => {
		await client?.stop();
		client = undefined;
		if (directory) await removeWithRetries(directory);
		directory = undefined;
	});

	async function start() {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-btw-"));
		const rpc = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "btw-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		client = rpc;
		const deltas: string[] = [];
		const records: BtwHistoryRecord[] = [];
		const waiters: Array<() => void> = [];
		const wake = () => {
			for (const resolve of waiters.splice(0)) resolve();
		};
		rpc.onBtwDelta(frame => {
			deltas.push(frame.delta);
			wake();
		});
		rpc.onBtwRecord(record => {
			records.push(record);
			wake();
		});
		/** Resolves once `ready` returns a value; re-checked after every btw frame. */
		const until = async <T>(ready: () => T | undefined): Promise<T> => {
			for (;;) {
				const value = ready();
				if (value !== undefined) return value;
				const { promise, resolve } = Promise.withResolvers<void>();
				waiters.push(resolve);
				await promise;
			}
		};
		/** Consumes the first `btw_record` frame for `id` whose latest turn left `running`. */
		const settled = async (id: string): Promise<BtwHistoryRecord> => {
			const done = await until(() =>
				records.find(record => record.id === id && (record.followUps?.at(-1) ?? record).status !== "running"),
			);
			records.splice(records.indexOf(done), 1);
			return done;
		};
		await rpc.start();
		return { rpc, deltas, until, settled };
	}

	test("streams a side answer into history without touching the transcript", async () => {
		const { rpc, deltas, settled } = await start();
		const started = await rpc.btw("  what is 2+2?  ");
		expect(started).toMatchObject({ question: "what is 2+2?", status: "running", answer: "" });

		const done = await settled(started.id);
		expect(done).toMatchObject({ status: "complete", answer: "Answer with 0 context messages." });
		expect(deltas.join("")).toBe("Answer with 0 context messages.");

		expect(await rpc.getBtwHistory()).toEqual([done]);
		expect((await rpc.getState()).messageCount).toBe(0);
	}, 30_000);

	test("a follow-up replays the topic's earlier turn as context", async () => {
		const { rpc, settled } = await start();
		const first = await rpc.btw("first");
		await settled(first.id);

		const followUp = await rpc.btw("second", first.id);
		expect(followUp.id).toBe(first.id);
		const done = await settled(first.id);
		expect(done.followUps).toHaveLength(1);
		expect(done.followUps![0]).toMatchObject({
			question: "second",
			status: "complete",
			answer: "Answer with 2 context messages.",
		});
		expect(await rpc.getBtwHistory()).toHaveLength(1);
	}, 30_000);

	test("one side question runs at a time and can be cancelled", async () => {
		const { rpc, deltas, until, settled } = await start();
		const slow = await rpc.btw("slow one");
		await until(() => deltas[0]);
		expect((await rejectionOf(rpc.btw("another"))).message).toContain("still running");
		// The live partial answer is visible to a late reader.
		expect((await rpc.getBtwHistory())[0]).toMatchObject({ status: "running", answer: "Thinking" });

		expect(await rpc.cancelBtw("some-other-id")).toBe(false);
		expect(await rpc.cancelBtw(slow.id)).toBe(true);
		expect(await settled(slow.id)).toMatchObject({ status: "cancelled", answer: "Thinking" });
		expect(await rpc.cancelBtw()).toBe(false);
		expect(deltas).toEqual(["Thinking"]);

		// The slot is free again; a cancelled topic accepts follow-ups.
		await rpc.btw("follow after cancel", slow.id);
		expect((await settled(slow.id)).followUps?.[0]?.status).toBe("complete");
	}, 30_000);

	test("a failed turn is recorded with its error", async () => {
		const { rpc, settled } = await start();
		const failing = await rpc.btw("please fail");
		expect(await settled(failing.id)).toMatchObject({ status: "error", error: "provider exploded" });
		expect((await rpc.getBtwHistory())[0]?.status).toBe("error");
	}, 30_000);

	test("rejects blank questions and unknown topics", async () => {
		const { rpc } = await start();
		expect((await rejectionOf(rpc.btw("   "))).message).toContain("question");
		expect((await rejectionOf(rpc.btw("hi", "missing"))).message).toContain("missing");
	}, 30_000);

	test("a session change cancels the running question; history stays with its session", async () => {
		const { rpc, deltas, until, settled } = await start();
		const original = (await rpc.getState()).sessionFile!;
		const slow = await rpc.btw("slow before switching");
		await until(() => deltas[0]);

		expect((await rpc.newSession()).cancelled).toBe(false);
		expect(await settled(slow.id)).toMatchObject({ status: "cancelled" });
		expect(await rpc.getBtwHistory()).toEqual([]);

		expect((await rpc.switchSession(original)).cancelled).toBe(false);
		const history = await rpc.getBtwHistory();
		expect(history.map(record => [record.id, record.status])).toEqual([[slow.id, "cancelled"]]);
	}, 30_000);
});
