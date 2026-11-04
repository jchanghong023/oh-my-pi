import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { matchesInstalledFile } from "../packages/natives/scripts/installed-file";

let root: string;
let source: string;
let target: string;
const oldTime = new Date("2000-01-01T00:00:00.000Z");

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-installed-file-"));
	source = path.join(root, "candidate.node");
	target = path.join(root, "installed.node");
	await fs.writeFile(source, "candidate native bytes");
	await fs.copyFile(source, target);
	await fs.chmod(target, 0o644);
	await fs.utimes(target, oldTime, oldTime);
});
afterEach(async () => {
	// Release the read-only attribute on Windows as well as POSIX permissions.
	await fs.chmod(target, 0o644).catch(() => {});
	await fs.rm(root, { recursive: true, force: true });
});

describe("shared native installed-file comparison", () => {
	it("preserves identical writable bytes, inode and mtime regardless of source timestamps", async () => {
		const before = await fs.stat(target, { bigint: true });
		await fs.utimes(source, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
		expect(await matchesInstalledFile(source, target)).toBe(true);
		const after = await fs.stat(target, { bigint: true });
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeNs).toBe(before.mtimeNs);
		expect(await fs.readFile(target)).toEqual(await fs.readFile(source));
	});

	it("rejects changed bytes with equal size and timestamps without modifying the installed file", async () => {
		await fs.writeFile(target, "installed native bytes");
		await fs.utimes(source, oldTime, oldTime);
		await fs.utimes(target, oldTime, oldTime);
		const before = await fs.stat(target, { bigint: true });
		expect((await fs.stat(source)).size).toBe(Number(before.size));
		expect(await matchesInstalledFile(source, target)).toBe(false);
		const after = await fs.stat(target, { bigint: true });
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeNs).toBe(before.mtimeNs);
		expect(await fs.readFile(target, "utf8")).toBe("installed native bytes");
	});

	it("leaves an identical non-owner-writable target untouched for atomic replacement", async () => {
		await fs.chmod(target, 0o444);
		const before = await fs.stat(target, { bigint: true });
		expect(before.mode & 0o200n).toBe(0n);
		expect(await matchesInstalledFile(source, target)).toBe(false);
		const after = await fs.stat(target, { bigint: true });
		expect(after.mode).toBe(before.mode);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeNs).toBe(before.mtimeNs);
		expect(await fs.readFile(target)).toEqual(await fs.readFile(source));
	});

	it("repairs POSIX permissions on identical writable bytes without replacing the inode or mtime", async () => {
		await fs.chmod(target, 0o755);
		const before = await fs.stat(target, { bigint: true });
		expect(await matchesInstalledFile(source, target)).toBe(true);
		const after = await fs.stat(target, { bigint: true });
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeNs).toBe(before.mtimeNs);
		if (process.platform !== "win32") expect(after.mode & 0o7777n).toBe(0o644n);
		expect(await fs.readFile(target)).toEqual(await fs.readFile(source));
	});

	it("rejects absent files and directory targets instead of treating them as an unchanged installation", async () => {
		expect(await matchesInstalledFile(source, path.join(root, "missing.node"))).toBe(false);
		expect(await matchesInstalledFile(path.join(root, "missing-source.node"), target)).toBe(false);
		const directory = path.join(root, "directory.node");
		await fs.mkdir(directory);
		await fs.writeFile(path.join(directory, "keep"), "unrelated contents");
		expect(await matchesInstalledFile(source, directory)).toBe(false);
		expect(await fs.readFile(path.join(directory, "keep"), "utf8")).toBe("unrelated contents");
	});

	it("does not accept a POSIX symlink target or turn permission-repair failures into an unchanged install", async () => {
		if (process.platform === "win32") {
			// Windows symlinks need separate privileges and has no POSIX repair step;
			// keep exercising its real unchanged-file branch rather than adding a skip.
			expect(await matchesInstalledFile(source, target)).toBe(true);
			expect(await fs.readFile(target)).toEqual(await fs.readFile(source));
		} else {
			const linked = path.join(root, "linked.node");
			await fs.symlink(source, linked);
			expect(await matchesInstalledFile(source, linked)).toBe(false);
			expect(await fs.readlink(linked)).toBe(source);
			await fs.chmod(target, 0o755);
			const before = await fs.stat(target, { bigint: true });
			const chmod = spyOn(fs, "chmod").mockRejectedValue(
				Object.assign(new Error("fixture cannot repair permissions"), { code: "EPERM" }),
			);
			try {
				expect(await matchesInstalledFile(source, target)).toBe(false);
			} finally {
				chmod.mockRestore();
			}
			const after = await fs.stat(target, { bigint: true });
			expect(after.ino).toBe(before.ino);
			expect(after.mtimeNs).toBe(before.mtimeNs);
			expect(after.mode).toBe(before.mode);
		}
	});
});
