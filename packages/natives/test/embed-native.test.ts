import { describe, expect, it, spyOn } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectHostAvx2Support, resolveLocalHostAddon } from "../../../scripts/host-detect";
import {
	type EmbeddedAddon,
	type EmbeddedAddonFile,
	cleanupStaleNativeVersions,
	embeddedAddonPath,
	extractEmbeddedAddons,
	loadNative,
} from "../native/loader-state.js";
import { resolveLinuxPrivateCacheRoot } from "../native/offline-root.js";
import packageJson from "../package.json" with { type: "json" };
import { embeddedAddonFiles } from "../scripts/embed-native";

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
			expect(embeddedAddon.files).toEqual([
				{
					variant: "default",
					filename: "pi_natives.win32-arm64.node",
					size: addon.length,
					hash: Bun.hash.xxHash64(addon).toString(16).padStart(16, "0"),
					zstdPath: path.join(await fs.realpath(outDir), "pi_natives.win32-arm64.node.zst"),
				},
			]);
			const cachedAddon = embeddedAddonPath(cacheDir, embeddedAddon.files[0]);
			expect(extractEmbeddedAddons({ files: embeddedAddon.files, targetDir: cacheDir })).toEqual([cachedAddon]);
			expect(await Bun.file(cachedAddon).text()).toBe(addon);
			const beforeReuse = await fs.stat(cachedAddon);
			expect(extractEmbeddedAddons({ files: embeddedAddon.files, targetDir: cacheDir })).toEqual([]);
			expect((await fs.stat(cachedAddon)).mtimeMs).toBe(beforeReuse.mtimeMs);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "linux")("extracts and reaps only trusted offline cache directories", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-private-"));
		const offlineCacheUid = process.getuid!();
		const targetDir = path.join(root, "1.0.0");
		const unsafeVersionDir = path.join(root, "1.0.1");
		const bytes = "native addon";
		const file: EmbeddedAddonFile = {
			variant: "default",
			filename: "pi_natives.linux-arm64.node",
			size: bytes.length,
			hash: Bun.hash.xxHash64(bytes).toString(16).padStart(16, "0"),
			zstdPath: path.join(root, "addon.zst"),
		};
		const target = embeddedAddonPath(targetDir, file);
		const unsafeDir = path.dirname(embeddedAddonPath(unsafeVersionDir, file));
		try {
			await fs.mkdir(targetDir, { mode: 0o700 });
			await fs.mkdir(unsafeVersionDir, { mode: 0o700 });
			await Bun.write(file.zstdPath, Bun.zstdCompressSync(new TextEncoder().encode(bytes)));
			expect(extractEmbeddedAddons({ files: [file], targetDir, offlineCacheUid })).toEqual([target]);
			expect((await fs.stat(path.dirname(target))).mode & 0o777).toBe(0o700);
			expect((await fs.stat(target)).mode & 0o777).toBe(0o700);

			await fs.symlink(path.dirname(target), unsafeDir, "dir");
			expect(() => extractEmbeddedAddons({ files: [file], targetDir: unsafeVersionDir, offlineCacheUid })).toThrow(
				"Unsafe Linux offline native cache path",
			);
			await fs.unlink(unsafeDir);
			await fs.mkdir(unsafeDir);
			await fs.chmod(unsafeDir, 0o777);
			await fs.utimes(targetDir, 0, 0);
			await fs.utimes(unsafeVersionDir, 0, 0);
			expect(cleanupStaleNativeVersions({ nativesDir: root, currentVersion: "2.0.0", offlineCacheUid })).toEqual([
				targetDir,
			]);
			expect(await fs.readdir(root)).not.toContain(path.basename(targetDir));
			expect((await fs.stat(unsafeDir)).isDirectory()).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "win32")(
		"replaces a mapped addon while its existing process keeps using it",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-locked-"));
			try {
				const { filename } = resolveLocalHostAddon({
					platform: process.platform,
					arch: process.arch,
					avx2: detectHostAvx2Support(),
				});
				const source = path.join(import.meta.dir, "../native", filename);
				// Keep a valid PE image but stage an undersized copy at its expected cache path.
				const replacement = Buffer.concat([await fs.readFile(source), Buffer.from([0])]);
				const hash = Bun.hash.xxHash64(replacement).toString(16).padStart(16, "0");
				const zstdPath = path.join(root, "replacement.zst");
				const target = embeddedAddonPath(root, {
					variant: "default",
					filename,
					size: replacement.length,
					hash,
					zstdPath,
				});
				await fs.mkdir(path.dirname(target));
				await fs.copyFile(source, target);
				await Bun.write(zstdPath, Bun.zstdCompressSync(replacement, { level: 1 }));
				const child = Bun.spawn(
					[
						process.execPath,
						path.join(import.meta.dir, "fixtures/locked-addon-extraction.ts"),
						target,
						zstdPath,
						String(replacement.length),
						hash,
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
				expect(JSON.parse(stdout)).toEqual({
					written: [target],
					script: "echo still-running",
					replacementScript: "echo replacement-loaded",
				});
				expect(await fs.readFile(target)).toEqual(replacement);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"probes outside a failed private version cache but rejects unsafe paths",
		() => {
			const privateRoot = resolveLinuxPrivateCacheRoot();
			if (privateRoot === undefined) throw new Error("Expected a Linux private cache root");
			const cache = path.join(privateRoot, "natives");
			const versionDir = path.join(cache, packageJson.version);
			const { filename } = resolveLocalHostAddon({ platform: "linux", arch: process.arch, avx2: false });
			const fallback = path.join(path.dirname(process.execPath), filename);
			const env = { PI_NATIVES_DIR: cache, PI_COMPILED: "1", PI_NATIVE_VARIANT: "baseline" };
			const savedEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
			const realLstat = fsSync.lstatSync;
			const realMkdir = fsSync.mkdirSync;
			const uid = process.geteuid!();
			const directory = (owner: number, mode: number) => ({ uid: owner, mode, isDirectory: () => true });
			let outcome: "EROFS" | "ENOSPC" | "unsafe" = "EROFS";
			// No writes beneath the host's /dev/shm: supply trusted parents and a
			// precise fault at the version directory (or an unsafe existing directory).
			const lstat = spyOn(fsSync, "lstatSync").mockImplementation(((target, options) => {
				if (target === "/" || target === "/dev") return directory(0, 0o755);
				if (target === "/dev/shm") return directory(0, 0o1777);
				if (target === privateRoot || target === cache) return directory(uid, 0o700);
				if (target === versionDir) return outcome === "unsafe" ? directory(uid, 0o777) : undefined;
				if (typeof target === "string" && target.startsWith(`${privateRoot}${path.sep}`)) return undefined;
				return realLstat(target, options);
			}) as typeof fsSync.lstatSync);
			const mkdir = spyOn(fsSync, "mkdirSync").mockImplementation(((target, options) => {
				if (target === versionDir) throw Object.assign(new Error(outcome), { code: outcome });
				if (
					typeof target === "string" &&
					(target === privateRoot || target.startsWith(`${privateRoot}${path.sep}`))
				) {
					throw new Error(`Unexpected private cache mkdir: ${target}`);
				}
				return realMkdir(target, options);
			}) as typeof fsSync.mkdirSync);
			const dlopen = spyOn(process, "dlopen").mockImplementation(() => {
				throw new Error("fixture records candidate probing without loading a host addon");
			});
			try {
				Object.assign(process.env, env);
				for (outcome of ["EROFS", "ENOSPC"] as const) {
					expect(loadNative).toThrow(`native addon cache (${versionDir}): ${outcome}`);
					expect(mkdir.mock.calls).toEqual([[versionDir, { mode: 0o700 }]]);
					expect(dlopen).toHaveBeenCalledWith(expect.anything(), fallback);
					expect(dlopen.mock.calls.some(([, candidate]) => path.dirname(candidate) === versionDir)).toBe(false);
					mkdir.mockClear();
					dlopen.mockClear();
				}
				outcome = "unsafe";
				expect(loadNative).toThrow(`Unsafe Linux offline native cache path ${versionDir}`);
				expect(mkdir).not.toHaveBeenCalled();
				expect(dlopen).not.toHaveBeenCalled();
			} finally {
				dlopen.mockRestore();
				mkdir.mockRestore();
				lstat.mockRestore();
				for (const [key, value] of Object.entries(savedEnv)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		},
	);

	it.skipIf(process.arch !== "x64" || process.platform === "win32")(
		"extracts only the selected addon until the loader tries a fallback",
		async () => {
			const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "pi-natives-first-run-"));
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
					`import { loadNative } from ${JSON.stringify(path.join(manifestDir, "loader-state.js"))};
try {
	loadNative();
} catch (error) {
	process.stdout.write(JSON.stringify({ error: error.message }));
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
						env: {
							...process.env,
							HOME: path.join(root, "home"),
							PI_NATIVES_DIR: cache,
							PI_NATIVE_VARIANT: variant,
						},
						stdout: "pipe",
						stderr: "ignore",
					});
					const [output, childExitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
					expect(childExitCode).toBe(0);
					const failure: { error: string } = JSON.parse(output);
					const versionDir = path.join(cache, packageJson.version);
					const extracted = (await fs.readdir(versionDir, { recursive: true })).filter(file =>
						file.endsWith(".node"),
					);
					expect(extracted.every(file => /^embedded-[0-9a-f]{16}$/.test(path.dirname(file)))).toBe(true);
					expect(extracted.map(file => path.basename(file)).sort()).toEqual(
						(variant === "modern"
							? [`pi_natives.${tag}-modern.node`, `pi_natives.${tag}-baseline.node`]
							: [`pi_natives.${tag}-baseline.node`]
						).sort(),
					);
					const selected = extracted.find(file => path.basename(file) === `pi_natives.${tag}-${variant}.node`)!;
					const cachedCandidate = path.join(versionDir, selected);
					// Keep the first loader failure, without retrying a partially loaded image.
					expect(failure.error.split("\n").filter(line => line.startsWith(`- ${cachedCandidate}:`))).toHaveLength(
						1,
					);

					// Extraction failure must still try the normal compiled-binary candidates.
					const blockedCache = path.join(root, `${variant}-blocked`);
					const blockedVersionDir = path.join(blockedCache, packageJson.version);
					await fs.mkdir(blockedCache, { recursive: true });
					await Bun.write(blockedVersionDir, "not a directory");
					const blocked = Bun.spawn([binary], {
						env: {
							...process.env,
							HOME: path.join(root, "home"),
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
					const filename = `pi_natives.${tag}-${variant}.node`;
					const fallback = path.join(path.dirname(binary), filename);
					expect(error).toContain(`- embedded addon extraction (${filename}):`);
					expect(stderr).toContain(`native:require:${filename}`);
					expect(error.split("\n").some(line => line.startsWith(`- ${fallback}:`))).toBe(true);
				}
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);
});
