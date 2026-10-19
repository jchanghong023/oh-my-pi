import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock, tryAcquirePersistentFileLock } from "../native/index.js";

test("FileLock binds release to one native owner", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-native-lock-"));
	const lockPath = path.join(root, "resource.lock");
	try {
		const first = FileLock.tryAcquire(lockPath);
		expect(first.acquired).toBe(true);

		const blocked = FileLock.tryAcquire(lockPath);
		expect(blocked.acquired).toBe(false);
		blocked.release();

		first.release();
		const successor = FileLock.tryAcquire(lockPath);
		expect(successor.acquired).toBe(true);

		first.release();
		const third = FileLock.tryAcquire(lockPath);
		expect(third.acquired).toBe(false);
		third.release();
		expect(successor.acquired).toBe(true);

		const usesInMemoryName = process.platform === "linux" || process.platform === "win32";
		expect(await Bun.file(lockPath).exists()).toBe(!usesInMemoryName);

		successor.release();
		const finalOwner = FileLock.tryAcquire(lockPath);
		expect(finalOwner.acquired).toBe(true);
		finalOwner.release();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "win32")("persistent locks reject unsupported platforms explicitly", async () => {
	await expect(tryAcquirePersistentFileLock(path.join(os.tmpdir(), "unsupported-persistent.lock"))).rejects.toThrow(
		"unsupported",
	);
});

test.skipIf(process.platform === "win32")(
	"persistent locks retain their inode and serialize concurrent local attempts",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-persistent-lock-"));
		const lockPath = path.join(root, "resource.lock");
		try {
			const attempts = await Promise.all(Array.from({ length: 8 }, () => tryAcquirePersistentFileLock(lockPath)));
			expect(attempts.filter(lock => lock.acquired)).toHaveLength(1);
			const before = await fs.stat(lockPath);
			expect(before.mode & 0o777).toBe(0o600);
			for (const lock of attempts.filter(lock => !lock.acquired)) await lock.release();
			const owner = attempts.find(lock => lock.acquired);
			if (!owner) throw new Error("No persistent lock owner");
			const contender = await tryAcquirePersistentFileLock(lockPath);
			expect(contender.acquired).toBe(false);
			await contender.release();
			// Closing a failed local attempt must not release the process's lock.
			const script = [
				`import { tryAcquirePersistentFileLock } from ${JSON.stringify(new URL("../native/index.js", import.meta.url).href)};`,
				`const lock = await tryAcquirePersistentFileLock(${JSON.stringify(lockPath)});`,
				"const acquired = lock.acquired; await lock.release(); process.exit(acquired ? 1 : 0);",
			].join("\n");
			const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
			expect(await child.exited).toBe(0);
			const workerPath = path.join(root, "contender.ts");
			await fs.writeFile(
				workerPath,
				script.replace("process.exit(acquired ? 1 : 0);", "postMessage(acquired); close();"),
			);
			const worker = new Worker(workerPath, { type: "module" });
			try {
				const { promise, resolve, reject } = Promise.withResolvers<boolean>();
				worker.onmessage = event => resolve(event.data);
				worker.onerror = event => reject(new Error(event.message));
				const workerAcquired = await promise;
				expect(workerAcquired).toBe(false);
			} finally {
				worker.terminate();
			}
			await owner.release();
			await owner.release();
			const successor = await tryAcquirePersistentFileLock(lockPath);
			expect(successor.acquired).toBe(true);
			await owner.release();
			const blocked = await tryAcquirePersistentFileLock(lockPath);
			expect(blocked.acquired).toBe(false);
			await blocked.release();
			await successor.release();
			const after = await fs.stat(lockPath);
			expect(after.ino).toBe(before.ino);
			expect(after.dev).toBe(before.dev);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"persistent locks reject symlink and nonprivate sidecars without changing them",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-persistent-unsafe-"));
		const lockPath = path.join(root, "resource.lock");
		const target = path.join(root, "target");
		try {
			await fs.writeFile(target, "untouched", { mode: 0o600 });
			await fs.symlink(target, lockPath);
			await expect(tryAcquirePersistentFileLock(lockPath)).rejects.toThrow();
			expect(await fs.readFile(target, "utf8")).toBe("untouched");
			expect((await fs.lstat(lockPath)).isSymbolicLink()).toBe(true);
			await fs.unlink(lockPath);
			await fs.writeFile(lockPath, "", { mode: 0o644 });
			await fs.chmod(lockPath, 0o644);
			await expect(tryAcquirePersistentFileLock(lockPath)).rejects.toThrow("0600");
			expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o644);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);
