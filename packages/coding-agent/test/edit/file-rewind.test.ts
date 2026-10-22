import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { restoreFileCheckpoints, withFileMutationLocks } from "../../src/edit/file-rewind";

let cwd: string;
beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-file-rewind-"));
});
afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("exact filesystem checkpoints", () => {
	test("restores updates, creations and deletions without touching unrelated files", async () => {
		await fs.writeFile(path.join(cwd, "update"), "new\r\n");
		await fs.writeFile(path.join(cwd, "created"), "created");
		await fs.writeFile(path.join(cwd, "unrelated"), "leave alone");
		const result = await restoreFileCheckpoints(
			[
				{ path: "update", before: "old\r\n", after: "new\r\n" },
				{ path: "created", after: "created" },
				{ path: "deleted", before: "\uFEFForiginal\n" },
			],
			{ cwd },
		);
		expect(result.applied).toBe(true);
		expect(result.receipts.map(receipt => receipt.status)).toEqual(["restored", "restored", "restored"]);
		expect(await fs.readFile(path.join(cwd, "update"), "utf8")).toBe("old\r\n");
		expect(await fs.readFile(path.join(cwd, "deleted"), "utf8")).toBe("\uFEFForiginal\n");
		expect(
			await fs.access(path.join(cwd, "created")).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(await fs.readFile(path.join(cwd, "unrelated"), "utf8")).toBe("leave alone");
	});
	test("preflights the entire batch before changing any file", async () => {
		await fs.writeFile(path.join(cwd, "a"), "after");
		await fs.writeFile(path.join(cwd, "b"), "external");
		const result = await restoreFileCheckpoints(
			[
				{ path: "a", before: "before", after: "after" },
				{ path: "b", before: "before", after: "after" },
			],
			{ cwd },
		);
		expect(result.applied).toBe(false);
		expect(result.reason).toContain("content_mismatch");
		expect(await fs.readFile(path.join(cwd, "a"), "utf8")).toBe("after");
	});

	test("rejects redirected parent paths", async () => {
		await fs.mkdir(path.join(cwd, "real"));
		await fs.writeFile(path.join(cwd, "real", "a"), "after");
		await fs.symlink(path.join(cwd, "real"), path.join(cwd, "link"), "junction");
		const result = await restoreFileCheckpoints([{ path: "link/a", before: "before", after: "after" }], { cwd });
		expect(result.applied).toBe(false);
		expect(result.reason).toContain("unsafe_path");
		expect(await fs.readFile(path.join(cwd, "real", "a"), "utf8")).toBe("after");
	});

	test("reports the committed prefix on guard failure, without rolling it back", async () => {
		await fs.writeFile(path.join(cwd, "a"), "after");
		await fs.writeFile(path.join(cwd, "b"), "after");
		let guards = 0;
		const result = await restoreFileCheckpoints(
			[
				{ path: "a", before: "before", after: "after" },
				{ path: "b", before: "before", after: "after" },
			],
			{
				cwd,
				assertCurrent: () => {
					if (++guards === 3) throw new Error("stale revision");
				},
			},
		);
		expect(result.applied).toBe(false);
		expect(result.receipts.map(receipt => receipt.status)).toEqual(["restored", "rejected"]);
		expect(await fs.readFile(path.join(cwd, "a"), "utf8")).toBe("before");
		expect(await fs.readFile(path.join(cwd, "b"), "utf8")).toBe("after");
	});

	test("waits for cooperating path mutation then rejects its new content", async () => {
		const target = path.join(cwd, "a");
		await fs.writeFile(target, "after");
		const { promise: ready, resolve: entered } = Promise.withResolvers<void>();
		const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
		const writer = withFileMutationLocks([target], async () => {
			entered();
			await blocked;
			await fs.writeFile(target, "other session");
		});
		await ready;
		const rewind = restoreFileCheckpoints([{ path: target, before: "before", after: "after" }]);
		release();
		await writer;
		expect((await rewind).applied).toBe(false);
		expect(await fs.readFile(target, "utf8")).toBe("other session");
	});

	test("does not serialize disjoint paths and refuses missing checkpoints", async () => {
		const result = await withFileMutationLocks([path.join(cwd, "a")], () =>
			restoreFileCheckpoints([{ path: "b", before: "" }], { cwd }),
		);
		expect(result.applied).toBe(true);
		expect(await fs.readFile(path.join(cwd, "b"), "utf8")).toBe("");
		expect((await restoreFileCheckpoints([{ path: "unknown" }], { cwd })).reason).toContain("missing_checkpoint");
	});
});
