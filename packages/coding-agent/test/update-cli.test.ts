import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as pluginCli from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import * as updateCli from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import {
	compareUpdateVersions,
	installCnbBinary,
	parseCnbRelease,
	parseReportedVersion,
	sweepStaleUpdateArtifacts,
	warnOnPathConflict,
} from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import Update from "@oh-my-pi/pi-coding-agent/commands/update";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-test-")));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();

	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

describe("update command plugin dispatch", () => {
	it("routes -l to plugin upgrade instead of the app updater", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue({ kind: "current" });

		const command = new Update(["-l"], TEST_CONFIG);
		await command.run();

		expect(pluginSpy).toHaveBeenCalledWith({ action: "upgrade", args: [], flags: {} });
		expect(updateSpy).not.toHaveBeenCalled();
	});
});

describe("parseReportedVersion", () => {
	it("preserves prerelease and fork suffixes for exact version verification", () => {
		// Regression: dropping a suffix made the installed launcher look stale,
		// triggering a binary repair against an already-installed release.
		expect(parseReportedVersion("omp/18.0.6-canary.1")).toBe("18.0.6-canary.1");
		expect(parseReportedVersion("omp/18.0.6+fork.35")).toBe("18.0.6+fork.35");
		expect(parseReportedVersion("omp/18.0.5")).toBe("18.0.5");
		expect(parseReportedVersion("not a version")).toBeUndefined();
	});

	it("rejects version output from a different executable", () => {
		expect(parseReportedVersion("node/18.0.5")).toBeUndefined();
		expect(parseReportedVersion("codex/18.0.5")).toBeUndefined();
	});

	it("rejects malformed SemVer and trailing output", () => {
		expect(parseReportedVersion("omp/01.0.5")).toBeUndefined();
		expect(parseReportedVersion("omp/18.0.5-rc.01")).toBeUndefined();
		expect(parseReportedVersion("omp/18.0.5+fork..1")).toBeUndefined();
		expect(parseReportedVersion("omp/18.0.5\nextra")).toBeUndefined();
	});
});

describe("compareUpdateVersions", () => {
	it("honors upstream version and prerelease precedence before the fork counter", () => {
		expect(compareUpdateVersions("18.0.7+fork.1", "18.0.6+fork.999")).toBeGreaterThan(0);
		expect(compareUpdateVersions("18.0.7-rc.10", "18.0.7-rc.2+fork.999")).toBeGreaterThan(0);
		expect(compareUpdateVersions("18.0.7-rc.10+fork.999", "18.0.7")).toBeLessThan(0);
	});

	it("compares same-baseline fork counters as integers and treats absence as zero", () => {
		expect(compareUpdateVersions("18.6.2+fork.1", "18.6.2")).toBeGreaterThan(0);
		expect(compareUpdateVersions("18.6.2", "18.6.2+fork.1")).toBeLessThan(0);
		expect(compareUpdateVersions("18.6.2+fork.0", "18.6.2")).toBe(0);
		expect(compareUpdateVersions("18.6.2+other.123", "18.6.2")).toBe(0);
		expect(compareUpdateVersions("18.6.2+fork.9007199254740993", "18.6.2+fork.9007199254740992")).toBeGreaterThan(0);
	});
});

describe("parseCnbRelease", () => {
	const version = "18.0.9+fork.137";
	const binaryName = "omp-linux-x64";
	const asset = { name: binaryName, size: 42, hash_algo: "SHA-256", hash_value: "AB".repeat(32) };
	const release = {
		tag_name: "omp",
		name: `v${version}`,
		assets: [{ ...asset, name: "omp-windows-x64.exe" }, asset],
	};
	const expected = { version, size: 42, sha256: "ab".repeat(32) };

	it("selects the exact platform asset and normalizes the SHA-256 digest", () => {
		expect(parseCnbRelease(release, "omp", binaryName)).toEqual(expected);
	});

	it("accepts an annotated rolling title and an exact version tag", () => {
		expect(parseCnbRelease({ ...release, name: `Quarterly release [omp:v${version}]` }, "omp", binaryName)).toEqual(
			expected,
		);
		const tag = `v${version}`;
		expect(parseCnbRelease({ ...release, name: "Quarterly release", tag_name: tag }, tag, binaryName)).toEqual(
			expected,
		);
	});

	it.each([
		["a mismatched tag", { ...release, tag_name: "other" }],
		["a draft", { ...release, draft: true }],
		["a marked prerelease", { ...release, prerelease: true }],
		["a prerelease title", { ...release, name: "v18.0.9-rc.1" }],
		["an unversioned rolling release", { ...release, name: "omp" }],
		["a malformed SemVer", { ...release, name: "v18.00.9" }],
		["an invalid version annotation", { ...release, name: "Quarterly release [omp:v18.0.9+fork..1]" }],
		["no exact platform asset", { ...release, assets: [{ ...asset, name: `${binaryName}.zip` }] }],
		["duplicate platform assets", { ...release, assets: [asset, asset] }],
	] as const)("rejects %s", (_description, body) => {
		expect(() => parseCnbRelease(body, "omp", binaryName)).toThrow(/CNB/);
	});

	it("rejects conflicting title and tag versions", () => {
		const tag = "v18.0.9+fork.136";
		expect(() => parseCnbRelease({ ...release, tag_name: tag }, tag, binaryName)).toThrow(/version/i);
	});

	it.each([
		["missing digest", { hash_value: undefined }],
		["unsupported digest algorithm", { hash_algo: "sha512" }],
		["non-hex digest", { hash_value: "z".repeat(64) }],
		["short digest", { hash_value: "ab" }],
		["string size", { size: "42" }],
		["zero size", { size: 0 }],
		["fractional size", { size: 1.5 }],
		["unsafe integer size", { size: Number.MAX_SAFE_INTEGER + 1 }],
	] as const)("rejects %s", (_description, overrides) => {
		expect(() => parseCnbRelease({ ...release, assets: [{ ...asset, ...overrides }] }, "omp", binaryName)).toThrow(
			/SHA-256 digest or size/,
		);
	});
});

describe("installCnbBinary", () => {
	const version = "18.0.9+fork.137";
	const url = "https://objects.cnb.test/signed/omp";
	const old = "#!/bin/sh\nprintf '%s\\n' 'omp/18.0.9+fork.136'\n";
	const executable = (reported: string) =>
		`#!/bin/sh\nprintf '%s\\n' "$0" > "\${0%/*}/candidate-probe"\nprintf '%s\\n' 'omp/${reported}'\n`;
	const assetFor = (payload: string) => ({
		version,
		size: Buffer.byteLength(payload),
		sha256: Bun.SHA256.hash(payload, "hex"),
	});

	async function prepare(): Promise<{ dir: string; target: string }> {
		const dir = await makeTempDir();
		const target = path.join(dir, process.platform === "win32" ? "omp.exe" : "omp");
		await fs.writeFile(target, old, { mode: 0o755 });
		return { dir, target };
	}

	it.each(["size", "digest"] as const)("rejects a wrong %s before running or replacing the binary", async field => {
		const { dir, target } = await prepare();
		const payload = executable(version);
		const asset = assetFor(payload);
		if (field === "size") asset.size++;
		else asset.sha256 = "0".repeat(64);

		await expect(
			installCnbBinary(target, { url, asset, force: true, fetchImpl: async () => new Response(payload) }),
		).rejects.toThrow(new RegExp(`download ${field} mismatch`, "i"));

		expect(await Bun.file(target).text()).toBe(old);
		expect(await fs.readdir(dir)).toEqual([path.basename(target)]);
	});

	it.skipIf(process.platform === "win32")("rejects a wrong fork version without replacing the target", async () => {
		const { dir, target } = await prepare();
		const payload = executable("18.0.9+fork.138");
		await expect(
			installCnbBinary(target, {
				url,
				asset: assetFor(payload),
				force: true,
				fetchImpl: async () => new Response(payload),
			}),
		).rejects.toThrow(`expected ${version}`);

		const executed = (await Bun.file(path.join(dir, "candidate-probe")).text()).trim();
		expect(path.dirname(executed)).toBe(dir);
		expect(executed).not.toBe(target);
		expect(await Bun.file(target).text()).toBe(old);
		expect(await Bun.file(executed).exists()).toBe(false);
	});

	it.skipIf(process.platform === "win32")("installs the verified binary and reports download progress", async () => {
		const { dir, target } = await prepare();
		const payload = executable(version);
		const asset = assetFor(payload);
		const onProgress = vi.fn();
		const bytes = new TextEncoder().encode(payload);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.subarray(0, 20));
				controller.enqueue(bytes.subarray(20));
				controller.close();
			},
		});

		expect(
			await installCnbBinary(target, {
				url,
				asset,
				force: false,
				fetchImpl: async () => new Response(body),
				onProgress,
			}),
		).toBe(true);
		expect(onProgress.mock.calls).toEqual([
			[{ phase: "downloading", version, received: 20, total: asset.size }],
			[{ phase: "downloading", version, received: asset.size, total: asset.size }],
			[{ phase: "installing", version }],
		]);
		expect(await Bun.file(target).text()).toBe(payload);
		expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
		expect((await fs.readdir(dir)).sort()).toEqual(["candidate-probe", path.basename(target)].sort());
	});

	it.skipIf(process.platform === "win32")(
		"keeps a newer binary when an overlapping download finishes late",
		async () => {
			const { dir, target } = await prepare();
			const slow = new TextEncoder().encode(executable(version));
			const firstChunk = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const first = installCnbBinary(target, {
				url,
				asset: assetFor(executable(version)),
				force: true,
				fetchImpl: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							async start(controller) {
								controller.enqueue(slow.subarray(0, 20));
								await finish.promise;
								controller.enqueue(slow.subarray(20));
								controller.close();
							},
						}),
					),
				onProgress(progress) {
					if (progress.phase === "downloading") firstChunk.resolve();
				},
			});
			const newerVersion = "18.0.9+fork.138";
			const newer = executable(newerVersion);
			try {
				await Promise.race([firstChunk.promise, first]);
				expect(
					await installCnbBinary(target, {
						url,
						asset: { ...assetFor(newer), version: newerVersion },
						force: false,
						fetchImpl: async () => new Response(newer),
					}),
				).toBe(true);
			} finally {
				finish.resolve();
				await first.catch(() => {});
			}

			expect(await first).toBe(false);
			expect(await Bun.file(target).text()).toBe(newer);
			expect((await fs.readdir(dir)).sort()).toEqual(["candidate-probe", path.basename(target)].sort());
		},
	);
});

describe("update-cli PATH conflict warning", () => {
	it("warns when the PATH-resolved omp differs from the update target", () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation(message => {
			logs.push(String(message));
		});

		warnOnPathConflict("/usr/local/bin/omp", "/usr/bin/omp");

		expect(logs.some(line => line.includes("Warning") && line.includes("/usr/bin/omp"))).toBe(true);
		expect(logs.some(line => line.includes("/usr/local/bin/omp"))).toBe(true);
	});

	it("stays silent when the PATH-resolved omp is the update target", () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation(message => {
			logs.push(String(message));
		});

		warnOnPathConflict("/usr/local/bin/omp", "/usr/local/bin/omp");

		expect(logs).toEqual([]);
	});

	it("is silent when no omp is found on PATH", () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation(message => {
			logs.push(String(message));
		});

		warnOnPathConflict("/usr/local/bin/omp", undefined);

		expect(logs).toEqual([]);
	});
});

describe("update-cli stale update artifact sweep", () => {
	it("reclaims timestamped and legacy backups and orphaned temps while sparing in-progress temps and unrelated files", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		await Bun.write(targetPath, "current binary");
		await Bun.write(`${targetPath}.bak`, "legacy backup");
		await Bun.write(`${targetPath}.1700000000000.4242.bak`, "timestamped backup");
		await Bun.write(`${targetPath}.1800000000000.99.bak`, "another backup");
		// Orphaned temp files from a hard-killed download: reaped once older than
		// the download window. Legacy fixed name and timestamped name both count.
		const stale = new Date(Date.now() - 60 * 60 * 1000);
		await Bun.write(`${targetPath}.new`, "legacy temp");
		await fs.utimes(`${targetPath}.new`, stale, stale);
		await Bun.write(`${targetPath}.1700000000000.4242.new`, "timestamped temp");
		await fs.utimes(`${targetPath}.1700000000000.4242.new`, stale, stale);
		await Bun.write(`${targetPath}.1700000000000.4242.new.exe`, "timestamped Windows temp");
		await fs.utimes(`${targetPath}.1700000000000.4242.new.exe`, stale, stale);
		await Bun.write(`${targetPath}.1700000000000.4242.0.patch`, "orphaned patch");
		await fs.utimes(`${targetPath}.1700000000000.4242.0.patch`, stale, stale);
		// Must survive: a fresh temp or patch still belongs to a concurrent,
		// in-progress download (unique per attempt), plus foreign basenames,
		// non-numeric middle segments, and a bare `.patch` (never ours).
		await Bun.write(`${targetPath}.9999999999999.7.new`, "in-progress temp");
		await Bun.write(`${targetPath}.9999999999999.7.0.patch`, "in-progress patch");
		await Bun.write(`${targetPath}.patch`, "the user's patch");
		await fs.utimes(`${targetPath}.patch`, stale, stale);
		await Bun.write(path.join(dir, "notes.bak"), "keep me");
		await Bun.write(`${targetPath}.config.bak`, "keep me too");
		await Bun.write(`${targetPath}.config.new`, "keep me three");

		await sweepStaleUpdateArtifacts(targetPath);

		expect(await Bun.file(targetPath).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1800000000000.99.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.new`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.new`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.new.exe`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.0.patch`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.9999999999999.7.new`).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.9999999999999.7.0.patch`).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.patch`).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "notes.bak")).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.bak`).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.new`).exists()).toBe(true);
	});
});
