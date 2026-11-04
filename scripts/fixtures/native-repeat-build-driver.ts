#!/usr/bin/env bun
/**
 * Manual, serial consumer of the real build:native installation path.
 * Run from any directory: bun scripts/fixtures/native-repeat-build-driver.ts
 * Do not run alongside another native build or a gate using these artifacts.
 * No compiler/filesystem stubs, temporary evidence files, or cache resets.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectHostAvx2Support, resolveLocalHostAddon } from "../host-detect";

const repoRoot = path.resolve(import.meta.dir, "../..");
const nativeDir = path.join(repoRoot, "packages/natives/native");
const addon = resolveLocalHostAddon({
	platform: process.platform,
	arch: process.arch,
	avx2: detectHostAvx2Support(),
});
const installedPaths = [path.join(nativeDir, addon.filename), path.join(nativeDir, "index.d.ts")];
const sentinelSeconds = Date.parse("2000-01-01T00:00:00.000Z") / 1000;

interface Snapshot {
	file: string;
	bytes: Buffer;
	atimeSeconds: number;
	mtimeSeconds: number;
	sentinelMtimeNs?: bigint;
}

async function build(label: "baseline" | "repeat"): Promise<void> {
	console.log(`[native-repeat-build] ${label}: starting real build:native`);
	const child = Bun.spawn([process.execPath, "run", "build:native"], {
		cwd: repoRoot,
		env: { ...process.env, RUSTUP_AUTO_INSTALL: "0", CROSS_TARGET: "" },
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
	});
	assert.equal(await child.exited, 0, `${label} build:native failed; repeated-install contract was not established`);
}

const snapshots: Snapshot[] = [];
const failures: unknown[] = [];
try {
	await build("baseline");
	for (const file of installedPaths) {
		const metadata = await fs.lstat(file, { bigint: true });
		assert.ok(metadata.isFile(), `Baseline installation is not a regular file: ${file}`);
		assert.ok((metadata.mode & 0o200n) !== 0n, `Baseline installation is not writable: ${file}`);
		// Capture times before reading, since reading may also update atime.
		const snapshot: Snapshot = {
			file,
			bytes: Buffer.alloc(0),
			atimeSeconds: Number(metadata.atimeNs) / 1e9,
			mtimeSeconds: Number(metadata.mtimeNs) / 1e9,
		};
		snapshots.push(snapshot);
		snapshot.bytes = await fs.readFile(file);
		assert.ok(snapshot.bytes.length > 0, `Baseline installation is empty: ${file}`);
	}
	for (const snapshot of snapshots) {
		await fs.utimes(snapshot.file, snapshot.atimeSeconds, sentinelSeconds);
		// Compare against the filesystem's stored value, not assumed time precision.
		snapshot.sentinelMtimeNs = (await fs.stat(snapshot.file, { bigint: true })).mtimeNs;
		assert.notEqual(snapshot.sentinelMtimeNs, undefined);
	}
	await build("repeat");
	for (const snapshot of snapshots) {
		try {
			const actual = await fs.readFile(snapshot.file);
			const metadata = await fs.lstat(snapshot.file, { bigint: true });
			const sameBytes = actual.equals(snapshot.bytes);
			console.log(
				JSON.stringify({
					contract: "native-repeat-build",
					file: path.relative(repoRoot, snapshot.file),
					bytesUnchanged: sameBytes,
					expectedMtimeNs: String(snapshot.sentinelMtimeNs),
					actualMtimeNs: String(metadata.mtimeNs),
					...(!sameBytes
						? {
								beforeSha256: Bun.SHA256.hash(snapshot.bytes, "hex"),
								afterSha256: Bun.SHA256.hash(actual, "hex"),
							}
						: {}),
				}),
			);
			assert.ok(
				sameBytes,
				`PRECONDITION FAILED: real repeated build changed bytes of ${snapshot.file}; cannot claim unchanged-artifact mtime preservation`,
			);
			assert.ok(metadata.isFile(), `Repeated installation is not a regular file: ${snapshot.file}`);
			assert.equal(
				metadata.mtimeNs,
				snapshot.sentinelMtimeNs,
				`UNCHANGED ARTIFACT REPLACED: ${snapshot.file} did not retain its mtime`,
			);
		} catch (error) {
			failures.push(error);
		}
	}
} catch (error) {
	failures.push(error);
} finally {
	// Restore only metadata this driver deliberately changed. Never restore bytes,
	// remove recovery inputs, or delete native/target caches after a failed build.
	// Evidence is kept in memory only, so there are no driver-owned files to clean.
	for (const snapshot of snapshots) {
		try {
			await fs.utimes(snapshot.file, snapshot.atimeSeconds, snapshot.mtimeSeconds);
		} catch (error) {
			failures.push(new Error(`Could not restore timestamp metadata for ${snapshot.file}`, { cause: error }));
		}
	}
}
if (failures.length) throw new AggregateError(failures, "Real repeated native installation contract failed");
console.log(
	"[native-repeat-build] PASS: both real artifacts retained identical bytes and mtime; timestamp metadata restored",
);
