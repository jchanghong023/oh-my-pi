import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { embeddedAddonFiles } from "../scripts/embed-native";
import packageJson from "../package.json" with { type: "json" };
import { type EmbeddedAddon, extractEmbeddedAddons } from "../native/loader-state.js";

describe("native addon embedding", () => {
	for (const [label, contents] of [
		["a longer release stamp that starts with the expected version", `binaryPI_NATIVES_VERSION_STAMP:18.1.10\0\0`],
		["a longer legacy sentinel export that starts with the expected version", "binary__piNativesV18_1_10\0"],
		["an unstamped addon", `binaryPI_NATIVES_VERSION_STAMP:${"\0".repeat(39)}`],
	] as const) {
		it(`rejects ${label}`, async () => {
			const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
			try {
				await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), contents);

				await expect(
					embeddedAddonFiles({ platform: "win32", arch: "arm64", nativeDir, version: "18.1.1" }),
				).rejects.toThrow("does not carry the @oh-my-pi/pi-natives@18.1.1 version stamp");
			} finally {
				await fs.rm(nativeDir, { recursive: true, force: true });
			}
		});
	}

	it("embeds identical addon bytes identically", async () => {
		const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		try {
			const stamp = "PI_NATIVES_VERSION_STAMP:18.1.1\0";
			await Bun.write(path.join(nativeDir, "pi_natives.linux-x64-modern.node"), `modern ${stamp}`.repeat(64));
			await Bun.write(path.join(nativeDir, "pi_natives.linux-x64-baseline.node"), `baseline ${stamp}`.repeat(64));
			const first = await embeddedAddonFiles({ platform: "linux", arch: "x64", nativeDir, version: "18.1.1" });
			// Distinct mtimes must not leak into the embedded bytes.
			await fs.utimes(path.join(nativeDir, "pi_natives.linux-x64-modern.node"), 1, 1);
			const second = await embeddedAddonFiles({ platform: "linux", arch: "x64", nativeDir, version: "18.1.1" });

			expect(Object.keys(first).map(key => path.basename(key))).toEqual([
				"pi_natives.linux-x64-modern.node.zst",
				"pi_natives.linux-x64-baseline.node.zst",
				"embedded-addon.js",
			]);
			expect(second).toEqual(first);
		} finally {
			await fs.rm(nativeDir, { recursive: true, force: true });
		}
	});

	it("emits a manifest whose zstd frames the loader extracts back to the addon", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		const nativeDir = path.join(root, "native");
		const outDir = path.join(root, "out");
		const cacheDir = path.join(root, "cache");
		// A pre-stamp addon whose legacy sentinel matches the version (the loader accepts it).
		const addon = "binary__piNativesV18_1_1\0";
		try {
			await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), addon);
			await fs.mkdir(cacheDir);
			const files = await embeddedAddonFiles({ platform: "win32", arch: "arm64", nativeDir, version: "18.1.1" });
			for (const filePath in files) {
				await Bun.write(path.join(outDir, path.basename(filePath)), files[filePath]);
			}

			// Dynamic: the manifest under test is generated into a per-test temp dir.
			const { embeddedAddon }: { embeddedAddon: EmbeddedAddon } = await import(
				path.join(outDir, "embedded-addon.js")
			);
			expect(embeddedAddon.platformTag).toBe("win32-arm64");
			expect(embeddedAddon.version).toBe("18.1.1");
			const cacheFilename = embeddedAddon.files[0].filename;
			expect(cacheFilename).toMatch(/^pi_natives\.win32-arm64\.[a-f0-9]{64}\.node$/);
			expect(embeddedAddon.files).toEqual([
				{
					variant: "default",
					filename: cacheFilename,
					size: addon.length,
					zstdPath: path.join(await fs.realpath(outDir), "pi_natives.win32-arm64.node.zst"),
				},
			]);
			const cachedAddon = path.join(cacheDir, cacheFilename);
			expect(extractEmbeddedAddons({ files: embeddedAddon.files, targetDir: cacheDir })).toEqual([cachedAddon]);
			expect(await Bun.file(cachedAddon).text()).toBe(addon);
			const beforeReuse = await fs.stat(cachedAddon);
			expect(extractEmbeddedAddons({ files: embeddedAddon.files, targetDir: cacheDir })).toEqual([]);
			expect((await fs.stat(cachedAddon)).mtimeMs).toBe(beforeReuse.mtimeMs);

			// Same package version and size, different Rust bytes: keep the old
			// session's file open while the next build populates the same cache.
			const nextAddon = addon.replace("binary", "newbin");
			await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), nextAddon);
			const nextFiles = await embeddedAddonFiles({
				platform: "win32",
				arch: "arm64",
				nativeDir,
				version: "18.1.1",
			});
			const nextOutDir = path.join(root, "next");
			for (const filePath in nextFiles) {
				await Bun.write(path.join(nextOutDir, path.basename(filePath)), nextFiles[filePath]);
			}
			// The second manifest is generated at runtime in a distinct temp directory.
			const { embeddedAddon: nextEmbedded }: { embeddedAddon: EmbeddedAddon } = await import(
				path.join(nextOutDir, "embedded-addon.js")
			);
			const nextCachedAddon = path.join(cacheDir, nextEmbedded.files[0].filename);
			expect(nextEmbedded.files[0].size).toBe(embeddedAddon.files[0].size);
			expect(nextCachedAddon).not.toBe(cachedAddon);
			const oldSession = await fs.open(cachedAddon, "r");
			try {
				expect(extractEmbeddedAddons({ files: nextEmbedded.files, targetDir: cacheDir })).toEqual([
					nextCachedAddon,
				]);
				expect(await oldSession.readFile("utf8")).toBe(addon);
				expect(await Bun.file(nextCachedAddon).text()).toBe(nextAddon);
				expect(extractEmbeddedAddons({ files: nextEmbedded.files, targetDir: cacheDir })).toEqual([]);
			} finally {
				await oldSession.close();
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "linux")(
		"loads embedded addons from shm or executable memory and reuses images across workers",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-memfd-"));
			const manifestDir = path.resolve(import.meta.dir, "../native");
			const entry = path.join(root, "entry.ts");
			const worker = path.join(root, "worker.ts");
			const loaderImport = JSON.stringify(path.join(manifestDir, "loader-state.js"));
			const offlineImport = JSON.stringify(path.join(manifestDir, "offline-root.js"));
			const persistentRoot = path.join(root, "persistent");
			try {
				const files = await embeddedAddonFiles({ platform: process.platform, arch: process.arch });
				await Bun.write(
					worker,
					`import { loadNative, nativeAddonStatus } from ${loaderImport};
const bindings = loadNative();
postMessage({ width: bindings.visibleWidth("abc"), status: nativeAddonStatus() });
`,
				);
				await Bun.write(
					entry,
					`import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { loadNative, nativeAddonStatus } from ${loaderImport};
import { getOfflineShmState } from ${offlineImport};
function images() {
	return fs.readdirSync("/proc/self/fd").flatMap(fd => {
		try {
			const name = fs.readlinkSync("/proc/self/fd/" + fd);
			return name.startsWith("/memfd:omp-native-") ? [name] : [];
		} catch (error) {
			if (error.code === "ENOENT") return [];
			throw error;
		}
	}).sort();
}
const before = images();
const bindings = loadNative();
const status = nativeAddonStatus();
let fileBacked;
try {
	const ordinaryBindings = createRequire(import.meta.url)(status.path);
	fileBacked = { ok: true, width: ordinaryBindings.visibleWidth("abc") };
} catch (error) {
	fileBacked = { ok: false, error: error.message };
}
const mappings = fs.readFileSync("/proc/self/maps", "utf8").split("\\n");
const executableMemory = mappings.some(line => line.includes("memfd:omp-native-") && /^\\S+\\s+\\S*x/.test(line));
const executableFile = mappings.some(line => line.includes(status.path) && /^\\S+\\s+\\S*x/.test(line));
const shmMount = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\\n")
	.map(line => line.split(" ")).find(fields => fields[4] === "/dev/shm");
const shmNoexec = shmMount?.[5].split(",").includes("noexec") ?? false;
const own = {
	before, images: images(), status, width: bindings.visibleWidth("abc"),
	fileBacked, executableMemory, executableFile, shmNoexec,
};
if (process.argv.includes("--child")) {
	console.log(JSON.stringify(own));
} else {
	try {
		const workers = [];
		for (let index = 0; index < 3; index++) {
			const worker = new Worker(new URL("./worker.ts", import.meta.url));
			try {
				const { promise, resolve, reject } = Promise.withResolvers();
				worker.onmessage = event => resolve(event.data);
				worker.onerror = reject;
				workers.push({ result: await promise, images: images() });
			} finally {
				await worker.terminate();
			}
		}
		const child = Bun.spawn([process.execPath, "--child"], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		if (exitCode !== 0) throw new Error(stderr);
		console.log(JSON.stringify({ own, workers, child: JSON.parse(stdout) }));
	} finally {
		const state = getOfflineShmState();
		fs.rmSync(path.dirname(state.runtimeRoot), { recursive: true, force: true });
	}
}
`,
				);
				const binary = path.join(root, "probe");
				const build = await Bun.build({
					entrypoints: [entry, worker],
					root: path.resolve(import.meta.dir, "../../.."),
					target: "bun",
					format: "esm",
					files,
					compile: { outfile: binary, autoloadBunfig: false, autoloadDotenv: false },
				});
				expect(build.success).toBe(true);
				const child = Bun.spawn([binary], {
					env: {
						...process.env,
						OMP_OFFLINE: "1",
						OMP_CONFIG_ROOT: persistentRoot,
						OMP_PROFILE: "default",
						PI_PROFILE: "default",
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
				const result = JSON.parse(stdout);
				expect(result.own.before).toEqual([]);
				if (result.own.shmNoexec) expect(result.own.fileBacked.ok).toBe(false);
				if (result.own.fileBacked.ok) {
					expect(result.own.fileBacked.width).toBe(3);
					expect(result.own.images).toEqual([]);
					expect(result.own.executableFile).toBe(true);
					expect(result.own.executableMemory).toBe(false);
				} else {
					expect(result.own.fileBacked.error).toBeString();
					expect(result.own.images).toHaveLength(1);
					expect(result.own.executableMemory).toBe(true);
					expect(result.own.executableFile).toBe(false);
				}
				expect(result.own.width).toBe(3);
				expect(result.own.status.stale).toBe(false);
				expect(result.own.status.path).toStartWith("/dev/shm/");
				expect(result.own.status.path).toMatch(/\.[a-f0-9]{64}\.node$/);
				for (const workerResult of result.workers) {
					expect(workerResult.images).toEqual(result.own.images);
					expect(workerResult.result).toEqual({ width: 3, status: result.own.status });
				}
				expect(result.child.before).toEqual([]);
				expect(result.child.images).toEqual(result.own.images);
				expect(result.child.status).toEqual(result.own.status);
				expect(result.child.width).toBe(3);
				expect(result.child.fileBacked.ok).toBe(result.own.fileBacked.ok);
				expect(result.child.executableMemory).toBe(result.own.executableMemory);
				expect(result.child.executableFile).toBe(result.own.executableFile);
				await expect(fs.stat(persistentRoot)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.arch !== "x64")("extracts only the selected addon until the loader tries a fallback", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-first-run-"));
		const nativeDir = path.join(root, "native");
		const manifestDir = path.join(import.meta.dir, "../native");
		const tag = `${process.platform}-${process.arch}`;
		try {
			for (const variant of ["modern", "baseline"]) {
				await Bun.write(
					path.join(nativeDir, `pi_natives.${tag}-${variant}.node`),
					`fake ${variant} PI_NATIVES_VERSION_STAMP:${packageJson.version}\0`,
				);
			}
			const embedded = await embeddedAddonFiles({
				platform: process.platform,
				arch: process.arch,
				nativeDir,
				version: packageJson.version,
			});
			const files: Record<string, string | Uint8Array> = {};
			for (const file in embedded) files[path.join(manifestDir, path.basename(file))] = embedded[file];

			const entry = path.join(root, "entry.ts");
			await Bun.write(
				entry,
				`import * as fs from "node:fs";
import * as path from "node:path";
import { loadNative, initLoaderContext, prepareNativeVersionDir, extractEmbeddedAddons } from ${JSON.stringify(path.join(manifestDir, "loader-state.js"))};
import { embeddedAddon } from ${JSON.stringify(path.join(manifestDir, "embedded-addon.js"))};
import { getOfflineShmState } from ${JSON.stringify(path.join(manifestDir, "offline-root.js"))};
try {
	if (process.argv.includes("--tamper")) {
		const ctx = initLoaderContext();
		prepareNativeVersionDir(ctx.versionedDir);
		extractEmbeddedAddons({ files: embeddedAddon.files, targetDir: ctx.versionedDir });
		for (const file of embeddedAddon.files) {
			const target = path.join(ctx.versionedDir, file.filename);
			const content = fs.readFileSync(target);
			content[0] ^= 1;
			fs.writeFileSync(target, content);
		}
	}
	loadNative();
} catch (error) {
	process.stdout.write(JSON.stringify({ error: error.message }));
} finally {
	const state = getOfflineShmState();
	if (state) fs.rmSync(path.dirname(state.runtimeRoot), { recursive: true, force: true });
}
`,
			);
			const binary = path.join(root, process.platform === "win32" ? "probe.exe" : "probe");
			const build = await Bun.build({
				entrypoints: [entry],
				root: path.resolve(import.meta.dir, "../../.."),
				target: "bun",
				format: "esm",
				files,
				compile: { outfile: binary, autoloadBunfig: false, autoloadDotenv: false },
			});
			expect(build.success).toBe(true);

			for (const variant of ["baseline", "modern"]) {
				const cache = path.join(root, variant);
				const child = Bun.spawn([binary], {
					env: { ...process.env, PI_NATIVES_DIR: cache, PI_NATIVE_VARIANT: variant },
					stdout: "ignore",
					stderr: "ignore",
				});
				expect(await child.exited).toBe(0);
				const extracted = (await fs.readdir(path.join(cache, packageJson.version)))
					.filter(filename => filename.endsWith(".node"))
					.sort();
				expect(
					extracted.map<string>(filename =>
						filename.startsWith(`pi_natives.${tag}-modern.`) ? "modern" : "baseline",
					),
				).toEqual((variant === "modern" ? ["modern", "baseline"] : ["baseline"]).sort());
				for (const filename of extracted) {
					expect(filename).toMatch(new RegExp(`^pi_natives\\.${tag}-(modern|baseline)\\.[a-f0-9]{64}\\.node$`));
				}

				// A failed extraction must not load an older, version-only cache,
				// including when the modern variant falls back to baseline.
				const blockedCache = path.join(root, `${variant}-blocked`);
				const blockedVersionDir = path.join(blockedCache, packageJson.version);
				await fs.mkdir(blockedVersionDir, { recursive: true });
				for (const filename of extracted) await fs.mkdir(path.join(blockedVersionDir, filename));
				for (const oldVariant of ["modern", "baseline"]) {
					await Bun.write(
						path.join(blockedVersionDir, `pi_natives.${tag}-${oldVariant}.node`),
						`OLD! PI_NATIVES_VERSION_STAMP:${packageJson.version}\0`,
					);
				}
				const blocked = Bun.spawn([binary], {
					env: {
						...process.env,
						PI_NATIVES_DIR: blockedCache,
						PI_NATIVE_VARIANT: variant,
						PI_DEBUG_STARTUP: "1",
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(blocked.stdout).text(),
					new Response(blocked.stderr).text(),
					blocked.exited,
				]);
				expect(exitCode).toBe(0);
				const { error }: { error: string } = JSON.parse(stdout);
				expect(error).toContain("embedded addon extraction");
				expect(stderr).not.toContain("native:require:");
				for (const oldVariant of ["modern", "baseline"]) {
					const oldCachePath = path.join(blockedVersionDir, `pi_natives.${tag}-${oldVariant}.node`);
					expect(error).not.toContain(oldCachePath);
					expect(await Bun.file(oldCachePath).text()).toBe(
						`OLD! PI_NATIVES_VERSION_STAMP:${packageJson.version}\0`,
					);
				}
			}
			if (process.platform === "linux") {
				for (const tamper of [false, true]) {
					const child = Bun.spawn([binary, ...(tamper ? ["--tamper"] : [])], {
						env: {
							...process.env,
							OMP_OFFLINE: "1",
							OMP_CONFIG_ROOT: path.join(root, tamper ? "offline-tampered" : "offline-invalid"),
							OMP_PROFILE: "default",
							PI_PROFILE: "default",
							PI_NATIVE_VARIANT: "baseline",
						},
						stdout: "pipe",
						stderr: "pipe",
					});
					const [stdout, stderr, exitCode] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
					const { error }: { error: string } = JSON.parse(stdout);
					if (tamper) {
						expect(error).toContain("Embedded addon content identity mismatch:");
						expect(error).not.toContain("File-backed offline native load failed:");
						expect(error).not.toContain("Executable-memory fallback failed:");
					} else {
						expect(error).toContain("File-backed offline native load failed:");
						expect(error).toContain("Executable-memory fallback failed:");
						expect(error).toContain("Linux 3.17+ (or a compatible backport)");
						expect(error).toContain("glibc libc.so.6, procfs");
					}
				}
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
