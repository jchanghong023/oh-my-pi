import * as childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { embeddedAddon } from "./embedded-addon.js";
import {
	assertOfflineShmPath,
	ensureOfflineShmDirectory,
	getOfflineShmState,
	initializeOfflineShmEnvironment,
} from "./offline-root.js";
import { bindingsHaveReleaseIdentity, bindingsReleaseVersion, containsVersionStamp } from "./version-sentinel.js";

/**
 * Native addon loader for `@oh-my-pi/pi-natives`.
 *
 * Owns every step between "Node imports `native/index.js`" and "the right
 * `pi_natives.<platform>-<arch>*.node` is required, validated, and returned":
 * platform/variant detection, candidate-path resolution, on-disk staging from
 * `node_modules` (Windows update safety), embedded-addon extraction (Bun
 * standalone binaries), release-stamp validation, and the aggregated error
 * surface for diagnostic-friendly failures.
 *
 * `native/index.js` is reduced to one `loadNative()` call plus the generated
 * surface-area exports between `MARKER_START`/`MARKER_END` (rewritten by
 * `scripts/gen-enums.ts`); everything else lives here so the pure helpers stay
 * unit-testable without triggering the side-effectful module-load path.
 *
 * Background (issue #823): `bun build --compile --define PI_COMPILED=true`
 * substitutes the bare identifier `PI_COMPILED`, NOT `process.env.PI_COMPILED`,
 * so a runtime read of the env var returns `undefined`. Older CommonJS loader
 * code also saw the original build-host absolute path in `__filename`; ESM
 * `import.meta.url` is rewritten to the bunfs URL. The embedded-addon
 * presence (true iff the build pipeline ran `embed:native`, false in the
 * post-build `--reset` stub) is the authoritative compiled-mode signal.
 */

const SUPPORTED_PLATFORMS = [
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
	"win32-arm64",
];

/**
 * Streaming startup marker, enabled by `PI_DEBUG_STARTUP`. Local copy of the
 * pi-utils helper (this loader cannot depend on pi-utils). Synchronous on
 * purpose: extraction/dlopen hangs must still leave the `:start` marker.
 * @param {string} text
 */
function startupMarker(text) {
	if (!process.env.PI_DEBUG_STARTUP) return;
	try {
		fs.writeSync(2, `[startup] ${text}\n`);
	} catch {
		// stderr unavailable; markers are best-effort
	}
}

function getNativesDir() {
	if (getOfflineShmState()) {
		const profile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim();
		const relativeRoot = profile && profile !== "default" ? path.join("profiles", profile) : "";
		initializeOfflineShmEnvironment(relativeRoot);
		return ensureOfflineShmDirectory(path.join(relativeRoot, "natives"));
	}
	// Match pi-utils directory overrides without depending on pi-utils.
	for (const name of ["PI_NATIVES_DIR", "OMP_CONFIG_ROOT"]) {
		let dir = process.env[name]?.trim();
		if (!dir) continue;
		if (dir === "~") dir = os.homedir();
		else if (dir.startsWith("~/") || dir.startsWith("~\\")) dir = os.homedir() + dir.slice(1);
		if (path.isAbsolute(dir)) {
			return name === "PI_NATIVES_DIR" ? path.normalize(dir) : path.join(dir, "natives");
		}
	}
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && fs.existsSync(path.join(xdgDataHome, "omp"))) {
		return path.join(xdgDataHome, "omp", "natives");
	}
	return path.join(os.homedir(), ".omp", "natives");
}

function resolveLeafPackageDir(platformTag) {
	try {
		const require_ = createRequire(import.meta.url);
		return path.dirname(require_.resolve(`@oh-my-pi/pi-natives-${platformTag}/package.json`));
	} catch {
		return null;
	}
}

// =========================================================================
// Pure helpers — re-exported for unit tests in `packages/natives/test/`.
// =========================================================================

/**
 * @param {{
 *   embeddedAddon: { platformTag: string; version: string; files: unknown[] } | null | undefined;
 *   env: Record<string, string | undefined>;
 *   importMetaUrl: string | null | undefined;
 * }} input
 * @returns {boolean}
 */
export function detectCompiledBinary({ embeddedAddon, env, importMetaUrl }) {
	if (embeddedAddon) return true;
	if (env && env.PI_COMPILED) return true;
	if (typeof importMetaUrl === "string") {
		if (importMetaUrl.includes("$bunfs")) return true;
		if (importMetaUrl.includes("~BUN")) return true;
		if (importMetaUrl.includes("%7EBUN")) return true;
	}
	return false;
}
/**
 * @param {{ tag: string; arch: string; variant: "modern" | "baseline" | null | undefined }} input
 * @returns {string[]}
 */
export function getAddonFilenames({ tag, arch, variant }) {
	const defaultFilename = `pi_natives.${tag}.node`;
	if (arch !== "x64" || !variant) return [defaultFilename];
	const baselineFilename = `pi_natives.${tag}-baseline.node`;
	const modernFilename = `pi_natives.${tag}-modern.node`;
	if (variant === "modern") {
		return [modernFilename, baselineFilename, defaultFilename];
	}
	return [baselineFilename, defaultFilename];
}

/**
 * Decide whether the loader should mirror the package's `native/<filename>.node`
 * into the per-version cache directory (`~/.omp/natives/<version>/`) before loading.
 *
 * Windows-only safety net for `bun install -g` updates: when a previous `omp`
 * process is running, bun cannot overwrite the locked `.node` inside
 * `node_modules/@oh-my-pi/pi-natives/native/`, leaving an old binary next to a
 * newer `index.js` and producing `<sym> is not a function` crashes on the next
 * launch. Staging into the version-pinned cache:
 *   1. Gives every package version its own filesystem path, so concurrent omp
 *      processes never collide on the same file.
 *   2. Makes the running process keep its handle on the cache copy, freeing bun
 *      to overwrite the `node_modules` copy on subsequent updates.
 * Disabled on non-Windows (no file-lock problem), in workspace dev (`nativeDir`
 * is not inside a `node_modules` segment), and for compiled binaries (handled
 * by `maybeExtractEmbeddedAddon`).
 *
 * @param {{ platform: NodeJS.Platform | string; isCompiledBinary: boolean; nativeDir: string }} input
 * @returns {boolean}
 */
export function shouldStageNodeModulesAddon({ platform, isCompiledBinary, nativeDir }) {
	if (platform !== "win32") return false;
	if (isCompiledBinary) return false;
	// Check both separators independently of the host's `path.sep`: this helper
	// is shared by the loader (running on Windows with `\`) and the test suite
	// (typically running on POSIX hosts when CI executes the regression test).
	const normalizedNativeDir = nativeDir.toLowerCase();
	return normalizedNativeDir.includes("\\node_modules\\") || normalizedNativeDir.includes("/node_modules/");
}

/**
 * @param {{
 *   addonFilenames: string[];
 *   isCompiledBinary: boolean;
 *   stageFromNodeModules?: boolean;
 *   nativeDir: string;
 *   leafPackageDir?: string | null;
 *   execDir: string;
 *   versionedDir: string;
 *   userDataDir: string;
 * }} input
 * @returns {string[]}
 */
export function resolveLoaderCandidates({
	addonFilenames,
	isCompiledBinary,
	stageFromNodeModules = false,
	nativeDir,
	leafPackageDir = null,
	execDir,
	versionedDir,
	userDataDir,
}) {
	const baseReleaseCandidates = addonFilenames.flatMap(filename => [
		path.join(nativeDir, filename),
		path.join(execDir, filename),
	]);
	const leafCandidates = leafPackageDir ? addonFilenames.map(filename => path.join(leafPackageDir, filename)) : [];
	const compiledCandidates = addonFilenames.flatMap(filename => [
		path.join(versionedDir, filename),
		path.join(userDataDir, filename),
	]);
	const stagedCandidates = stageFromNodeModules ? addonFilenames.map(filename => path.join(versionedDir, filename)) : [];
	let releaseCandidates;
	if (isCompiledBinary) {
		releaseCandidates = [...compiledCandidates, ...baseReleaseCandidates];
	} else if (stageFromNodeModules) {
		releaseCandidates = [...stagedCandidates, ...leafCandidates, ...baseReleaseCandidates];
	} else {
		releaseCandidates = [...leafCandidates, ...baseReleaseCandidates];
	}
	return [...new Set(releaseCandidates)];
}

// =========================================================================

function parseReleaseVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isOlderReleaseVersion(candidate, current) {
	const candidateParts = parseReleaseVersion(candidate);
	const currentParts = parseReleaseVersion(current);
	if (!candidateParts || !currentParts) return false;
	for (let index = 0; index < candidateParts.length; index++) {
		if (candidateParts[index] !== currentParts[index]) {
			return candidateParts[index] < currentParts[index];
		}
	}
	return false;
}

// A concurrently starting older OMP binary creates or refreshes this directory
// before extracting its addon. Keep fresh directories long enough for that
// startup to finish; a later launch can reclaim them once they are genuinely
// stale.
const NATIVE_CACHE_CLEANUP_GRACE_MS = 10 * 60_000;

/**
 * Create a version cache directory and refresh its activity timestamp before
 * extraction or staging begins. Recursive mkdir does not update the mtime of
 * an existing directory, so the explicit touch is what protects interrupted
 * or partially populated caches from concurrent cleanup.
 *
 * @param {string} versionedDir
 */
export function prepareNativeVersionDir(versionedDir) {
	assertOfflineShmPath(versionedDir);
	const state = getOfflineShmState();
	if (state) ensureOfflineShmDirectory(path.relative(state.runtimeRoot, versionedDir));
	else fs.mkdirSync(versionedDir, { recursive: true });
	assertOfflineShmPath(versionedDir);
	const now = new Date();
	fs.utimesSync(versionedDir, now, now);
}

/**
 * Remove version-pinned native cache directories older than the loaded package.
 * Best-effort by design: permission errors and concurrent processes must not
 * abort startup after the native addon has already loaded successfully.
 *
 * @param {{ nativesDir: string; currentVersion: string }} input
 * @returns {string[]}
 */
export function cleanupStaleNativeVersions({ nativesDir, currentVersion }) {
	const removed = [];
	let entries;
	try {
		assertOfflineShmPath(nativesDir);
		entries = fs.readdirSync(nativesDir, { withFileTypes: true });
	} catch {
		return removed;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !isOlderReleaseVersion(entry.name, currentVersion)) continue;
		const targetPath = path.join(nativesDir, entry.name);
		try {
			assertOfflineShmPath(targetPath);
			const stat = fs.statSync(targetPath);
			if (Date.now() - stat.mtimeMs < NATIVE_CACHE_CLEANUP_GRACE_MS) continue;
			fs.rmSync(targetPath, { recursive: true, force: true });
			removed.push(targetPath);
		} catch {
			// Stale caches are opportunistic cleanup only.
		}
	}
	return removed;
}

// Side-effectful loader. Everything below runs only when `loadNative()` is
// called from `native/index.js` — tests that only import the pure helpers
// above pay nothing for variant detection, subprocess spawns, or fs probes.
// =========================================================================

/**
 * Hidden env key for the resolved x64 variant. Once any context (main thread,
 * worker, subprocess) finishes variant detection, the result is written here
 * so every Bun worker and child process spawned afterwards inherits the same
 * verdict and skips re-detection. See `selectCpuVariant` for the lookup order.
 */
const VARIANT_CACHE_ENV_KEY = "__PI_NATIVE_VARIANT_CACHE";

/**
 * Spawn `command` with `args` and capture stdout. Prefers `Bun.spawnSync`
 * because Bun's `child_process.spawnSync` shim has been observed to return
 * non-zero / null in worker threads on macOS even when the same binary works
 * fine from the parent — the failure mode behind issue #3238, where the worker
 * silently falls back to the "baseline" variant. Falls back to the Node shim
 * for non-Bun embeds.
 */
function runCommand(command, args) {
	if (typeof Bun !== "undefined" && typeof Bun.spawnSync === "function") {
		try {
			const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
			if (result.exitCode === 0) {
				return result.stdout.toString("utf-8").trim();
			}
		} catch {
			// fall through to childProcess
		}
	}
	try {
		const result = childProcess.spawnSync(command, args, { encoding: "utf-8" });
		if (result.error) return null;
		if (result.status !== 0) return null;
		return (result.stdout || "").trim();
	} catch {
		return null;
	}
}

function getVariantOverride() {
	const value = process.env.PI_NATIVE_VARIANT;
	if (!value) return null;
	if (value === "modern" || value === "baseline") return value;
	return null;
}

function detectAvx2Support() {
	if (process.arch !== "x64") {
		return false;
	}

	if (process.platform === "linux") {
		try {
			const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
			return /\bavx2\b/i.test(cpuInfo);
		} catch {
			return false;
		}
	}

	if (process.platform === "darwin") {
		// Try the absolute path before bare `sysctl`: PATH may not include
		// `/usr/sbin` in worker/embedded spawn contexts (issue #3238).
		for (const sysctlBin of ["/usr/sbin/sysctl", "sysctl"]) {
			const leaf7 = runCommand(sysctlBin, ["-n", "machdep.cpu.leaf7_features"]);
			if (leaf7 && /\bAVX2\b/i.test(leaf7)) return true;
			const features = runCommand(sysctlBin, ["-n", "machdep.cpu.features"]);
			if (features && /\bAVX2\b/i.test(features)) return true;
		}
		return false;
	}

	if (process.platform === "win32") {
		// Under Bun, ask the kernel: PF_AVX2_INSTRUCTIONS_AVAILABLE == 40. Exact,
		// and ~0.5 ms against ~270 ms for the PowerShell spawn it replaces on the
		// startup path.
		if (typeof Bun !== "undefined") {
			try {
				const { dlopen, FFIType } = createRequire(import.meta.url)("bun:ffi");
				const kernel32 = dlopen("kernel32.dll", {
					IsProcessorFeaturePresent: { args: [FFIType.u32], returns: FFIType.i32 },
				});
				try {
					return kernel32.symbols.IsProcessorFeaturePresent(40) !== 0;
				} finally {
					kernel32.close();
				}
			} catch {
				// No FFI (embedder policy, unusual host): fall through to the shell probe.
			}
		}
		// Node embeds have no `bun:ffi`. `[System.Runtime.Intrinsics.X86.Avx2]`
		// exists only on .NET Core, so `pwsh` (PowerShell 7) answers correctly
		// while a stock `powershell.exe` (Windows PowerShell 5.1, .NET Framework)
		// raises TypeNotFound and pins such hosts to the baseline addon.
		for (const shell of ["pwsh.exe", "powershell.exe"]) {
			const output = runCommand(shell, [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"[System.Runtime.Intrinsics.X86.Avx2]::IsSupported",
			]);
			if (output && output.toLowerCase() === "true") return true;
			if (output && output.toLowerCase() === "false") return false;
		}
		return false;
	}

	return false;
}

/**
 * Pure variant-selection helper, exposed for unit tests. Resolution order:
 *
 *   1. `override` (user-facing `PI_NATIVE_VARIANT` env var). Always wins.
 *   2. The private `__PI_NATIVE_VARIANT_CACHE` env var, populated by the first
 *      context that detected at runtime. Lets child workers / subprocesses
 *      inherit the main thread's verdict instead of re-spawning `sysctl` etc.
 *      from a worker context where the spawn may fail (issue #3238).
 *   3. `detectAvx2()` — the slow path, called at most once per process.
 *
 * Non-x64 architectures return `{ variant: null }` and never set the cache.
 * When detection runs, the result is surfaced as `cacheEnvKey`/`cacheEnvValue`
 * so the caller can write `process.env` (the pure helper itself stays
 * side-effect-free, which keeps it easy to test).
 *
 * @param {{
 *   arch: string;
 *   override: "modern" | "baseline" | null | undefined;
 *   env: Record<string, string | undefined>;
 *   detectAvx2: () => boolean;
 * }} input
 * @returns {{
 *   variant: "modern" | "baseline" | null;
 *   source: "non-x64" | "override" | "cache" | "detect";
 *   cacheEnvKey?: string;
 *   cacheEnvValue?: string;
 * }}
 */
export function selectCpuVariant({ arch, override, env, detectAvx2 }) {
	if (arch !== "x64") return { variant: null, source: "non-x64" };
	if (override === "modern" || override === "baseline") {
		return { variant: override, source: "override" };
	}
	const cached = env[VARIANT_CACHE_ENV_KEY];
	if (cached === "modern" || cached === "baseline") {
		return { variant: cached, source: "cache" };
	}
	const variant = detectAvx2() ? "modern" : "baseline";
	return {
		variant,
		source: "detect",
		cacheEnvKey: VARIANT_CACHE_ENV_KEY,
		cacheEnvValue: variant,
	};
}

function resolveCpuVariant(override) {
	const result = selectCpuVariant({
		arch: process.arch,
		override,
		env: process.env,
		detectAvx2: detectAvx2Support,
	});
	if (result.cacheEnvKey) {
		process.env[result.cacheEnvKey] = result.cacheEnvValue;
	}
	return result.variant;
}

function selectEmbeddedAddonFile(selectedVariant) {
	if (!embeddedAddon) return null;
	const defaultFile = embeddedAddon.files.find(file => file.variant === "default") || null;
	if (process.arch !== "x64") return defaultFile || embeddedAddon.files[0] || null;
	if (selectedVariant === "modern") {
		return (
			embeddedAddon.files.find(file => file.variant === "modern") ||
			embeddedAddon.files.find(file => file.variant === "baseline") ||
			null
		);
	}
	return embeddedAddon.files.find(file => file.variant === "baseline") || null;
}

function isSafeEmbeddedAddonFilename(filename) {
	return filename.length > 0 && path.basename(filename) === filename && !filename.includes("/") && !filename.includes("\\");
}

function isEmbeddedAddonFileCurrent(targetPath, file) {
	try {
		assertOfflineShmPath(targetPath);
		const stat = fs.statSync(targetPath);
		if (!stat.isFile()) return false;
		return stat.size === file.size;
	} catch (err) {
		if (err && err.code === "ENOENT") return false;
		throw err;
	}
}

function writeEmbeddedAddonFile(targetPath, content) {
	const offline = !!getOfflineShmState();
	const tempPath = `${targetPath}.tmp.${process.pid}.${offline ? randomUUID() : Date.now()}`;
	try {
		assertOfflineShmPath(tempPath);
		fs.writeFileSync(tempPath, content, { mode: offline ? 0o700 : 0o755, flag: offline ? "wx" : "w" });
		assertOfflineShmPath(targetPath);
		fs.renameSync(tempPath, targetPath);
	} catch (err) {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// Best-effort cleanup only.
		}
		throw err;
	}
}

export function extractEmbeddedAddons({ files, targetDir }) {
	assertOfflineShmPath(targetDir);
	for (const file of files) {
		if (!isSafeEmbeddedAddonFilename(file.filename)) {
			throw new Error(`Unsafe embedded addon filename: ${file.filename}`);
		}
	}
	const writtenPaths = [];
	for (const file of files) {
		const targetPath = path.join(targetDir, file.filename);
		assertOfflineShmPath(targetPath);
		if (isEmbeddedAddonFileCurrent(targetPath, file)) continue;
		const content = Bun.zstdDecompressSync(fs.readFileSync(file.zstdPath));
		if (content.length !== file.size) {
			throw new Error(`Embedded addon size mismatch for ${file.filename}: expected ${file.size}, got ${content.length}`);
		}
		writeEmbeddedAddonFile(targetPath, content);
		writtenPaths.push(targetPath);
	}
	return writtenPaths;
}

function maybeExtractEmbeddedAddon(ctx, errors, file = selectEmbeddedAddonFile(ctx.selectedVariant)) {
	if (!ctx.isCompiledBinary || !embeddedAddon) return null;
	if (embeddedAddon.platformTag !== ctx.platformTag || embeddedAddon.version !== ctx.packageVersion) return null;
	if (!file) return null;
	const targetPath = path.join(ctx.versionedDir, file.filename);

	startupMarker("native:extractEmbeddedAddon:start");
	try {
		prepareNativeVersionDir(ctx.versionedDir);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push(`embedded addon dir: ${message}`);
		return null;
	}

	try {
		extractEmbeddedAddons({ files: [file], targetDir: ctx.versionedDir });
		return targetPath;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push(`embedded addon extraction (${file.filename}): ${message}`);
		return null;
	}
}

/**
 * Mirror `leafPackageDir ?? nativeDir` addon binaries to
 * `versionedDir/<filename>.node` on Windows installs so the running process
 * cache path, never on the `node_modules` copy that bun must overwrite on
 * update. No-op on non-Windows, in workspace dev, and for compiled binaries —
 * see `shouldStageNodeModulesAddon` for the gating rules.
 */
function maybeStageNodeModulesAddon(ctx, errors) {
	if (!ctx.stageFromNodeModules) return null;

	let stagedPath = null;
	for (const filename of ctx.addonFilenames) {
		const sourcePath = path.join(ctx.leafPackageDir ?? ctx.nativeDir, filename);
		const targetPath = path.join(ctx.versionedDir, filename);

		if (fs.existsSync(targetPath)) {
			stagedPath = stagedPath || targetPath;
			continue;
		}
		if (!fs.existsSync(sourcePath)) continue;

		try {
			prepareNativeVersionDir(ctx.versionedDir);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`staged addon dir: ${message}`);
			continue;
		}

		try {
			// `copyFileSync` is atomic on Windows (CopyFileW) and avoids holding
			// two large buffers in JS for the read/write dance.
			fs.copyFileSync(sourcePath, targetPath);
			stagedPath = stagedPath || targetPath;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`staged addon copy (${filename}): ${message}`);
		}
	}
	return stagedPath;
}

// ld.so caches /proc/self/fd/N by pathname, so a successful image must keep its
// descriptor until process exit. Sealed, content-addressed memfds are shared
// across worker realms via procfs, not a realm-local map or inherited env fd.
// CLOEXEC makes subprocesses establish their own images. The map only caches
// this realm's N-API exports; the kernel owns the process-lifetime descriptors.
const memoryAddons = new Map();
const MEMFD_SEALS = 0x01 | 0x02 | 0x04 | 0x08;

function openMemfdLibc() {
	const { dlopen, FFIType } = createRequire(import.meta.url)("bun:ffi");
	return dlopen("libc.so.6", {
		// syscall exists on old glibc too; memfd_create's wrapper needs 2.27.
		syscall: { args: [FFIType.i64_fast, FFIType.ptr, FFIType.u32], returns: FFIType.i64_fast },
		__errno_location: { args: [], returns: FFIType.ptr },
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	});
}

function createExecutableMemfd(libc, name) {
	const syscallNumber = { x64: 319, arm64: 279 }[process.arch];
	if (!syscallNumber || typeof Bun === "undefined") {
		throw new Error("Offline native memory loading requires Bun on Linux x64 or arm64");
	}
	const { ptr, read } = createRequire(import.meta.url)("bun:ffi");
	const cName = Buffer.from(`${name}\0`);
	// MFD_CLOEXEC | MFD_ALLOW_SEALING | MFD_EXEC. Linux before 6.3 rejects
	// MFD_EXEC; retry only EINVAL with the original executable-memfd API.
	let fd = Number(libc.symbols.syscall(syscallNumber, ptr(cName), 0x01 | 0x02 | 0x10));
	if (fd < 0 && read.i32(libc.symbols.__errno_location()) === 22) {
		fd = Number(libc.symbols.syscall(syscallNumber, ptr(cName), 0x01 | 0x02));
	}
	if (fd < 0) {
		const errno = read.i32(libc.symbols.__errno_location());
		throw new Error(
			`memfd_create failed (errno ${errno}); offline native loading requires Linux 3.17+ ` +
				"(or a compatible backport), procfs, and permission to create executable memfds",
		);
	}
	return fd;
}

function findExecutableMemfd(libc, name, size) {
	for (const entry of fs.readdirSync("/proc/self/fd")) {
		if (!/^\d+$/.test(entry)) continue;
		const fd = Number(entry);
		try {
			if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== `/memfd:${name} (deleted)`) continue;
			const stat = fs.fstatSync(fd);
			const seals = libc.symbols.fcntl(fd, 1034, 0);
			if (
				stat.isFile() &&
				stat.uid === process.getuid() &&
				stat.size === size &&
				seals >= 0 &&
				(seals & MEMFD_SEALS) === MEMFD_SEALS
			) return fd;
		} catch (error) {
			if (error?.code !== "ENOENT" && error?.code !== "EBADF") throw error;
		}
	}
	return undefined;
}

// Executable shm needs no memfd/FFI support. Only a rejected ordinary load
// enters the executable-memory path; guards and content identity fail closed.
function loadOfflineAddon(candidate, require_) {
	assertOfflineShmPath(candidate);
	const source = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		if (!fs.fstatSync(source).isFile()) throw new Error(`Not a native addon file: ${candidate}`);
		const expectedHash = /\.([a-f0-9]{64})\.node$/.exec(path.basename(candidate))?.[1];
		if (expectedHash && createHash("sha256").update(fs.readFileSync(source)).digest("hex") !== expectedHash) {
			throw new Error(`Embedded addon content identity mismatch: ${candidate}`);
		}
	} finally {
		fs.closeSync(source);
	}
	try {
		return require_(candidate);
	} catch (fileError) {
		try {
			return loadOfflineAddonFromMemory(candidate);
		} catch (memoryError) {
			const fileMessage = fileError instanceof Error ? fileError.message : String(fileError);
			const memoryMessage = memoryError instanceof Error ? memoryError.message : String(memoryError);
			throw new AggregateError(
				[fileError, memoryError],
				`File-backed offline native load failed: ${fileMessage}\n` +
					`Executable-memory fallback failed: ${memoryMessage}\n` +
					"The fallback requires Bun on Linux x64 or arm64, Linux 3.17+ (or a compatible backport), " +
					"glibc libc.so.6, procfs, and permission to create, seal and load executable memfds.",
			);
		}
	}
}

function loadOfflineAddonFromMemory(candidate) {
	assertOfflineShmPath(candidate);
	const cached = memoryAddons.get(candidate);
	if (cached) return cached;
	const libc = openMemfdLibc();
	let lock;
	let source;
	let ownedFd;
	try {
		// Independent open descriptions serialize all worker realms before the
		// process-wide scan/create step. This lock is entirely on private shm.
		const directory = path.dirname(candidate);
		assertOfflineShmPath(directory);
		lock = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		if (libc.symbols.flock(lock, 2) !== 0) throw new Error("Cannot lock offline native image creation");
		assertOfflineShmPath(candidate);
		source = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const stat = fs.fstatSync(source);
		if (!stat.isFile()) throw new Error(`Not a native addon file: ${candidate}`);
		const expectedHash = /\.([a-f0-9]{64})\.node$/.exec(path.basename(candidate))?.[1];
		let content;
		const hash = expectedHash ?? createHash("sha256").update((content = fs.readFileSync(source))).digest("hex");
		const name = `omp-native-${hash}`;
		let fd = findExecutableMemfd(libc, name, stat.size);
		if (fd === undefined) {
			content ??= fs.readFileSync(source);
			if (expectedHash && createHash("sha256").update(content).digest("hex") !== expectedHash) {
				throw new Error(`Embedded addon content identity mismatch: ${candidate}`);
			}
			fd = ownedFd = createExecutableMemfd(libc, name);
			fs.fchmodSync(fd, 0o700);
			fs.writeFileSync(fd, content);
			if (libc.symbols.fcntl(fd, 1033, MEMFD_SEALS) !== 0) {
				throw new Error("Cannot seal offline native image");
			}
		}
		const module = { exports: {} };
		process.dlopen(module, `/proc/self/fd/${fd}`);
		ownedFd = undefined; // A successful image belongs to the process, not this worker.
		memoryAddons.set(candidate, module.exports);
		return module.exports;
	} finally {
		if (ownedFd !== undefined) fs.closeSync(ownedFd);
		if (source !== undefined) fs.closeSync(source);
		if (lock !== undefined) fs.closeSync(lock);
		libc.close();
	}
}

/**
 * Before release identities existed, published native addons still shared
 * this stable core ABI. Let those on-disk addons bridge a package-version bump
 * when they expose the signature; keep every identified addon and a current
 * on-disk file paired with resident old exports on the strict path below.
 */
function isCompatiblePreSentinelNativeAddon(bindings, diskHasExpectedStamp) {
	if (diskHasExpectedStamp) return false;
	if (bindingsHaveReleaseIdentity(bindings)) return false;
	return (
		typeof bindings.countTokens === "function" &&
		typeof bindings.executeShell === "function" &&
		typeof bindings.visibleWidth === "function" &&
		typeof bindings.DesktopSession === "function" &&
		typeof bindings.DesktopSession.prototype?.capture === "function" &&
		typeof bindings.DesktopSession.prototype?.execute === "function" &&
		typeof bindings.DesktopSession.prototype?.close === "function"
	);
}

export function validateLoadedBindings(ctx, bindings, candidate) {
	// In workspace dev (running out of `packages/natives/native/` rather than a
	// `node_modules` install or a compiled bundle) the local `.node` only gains
	// the new release stamp after `bun --cwd=packages/natives run build`. Skip
	// validation there so a stale post-pull dev tree boots while the rebuild
	// completes; install and compiled-binary paths still validate. The mismatch
	// is not swallowed silently: `native/index.js` exports `missingNativeExport`
	// for every symbol the stale addon predates, so the first call through one
	// reports the addon, both releases, and the rebuild command.
	if (ctx.isWorkspaceLoad) return;
	const residentVersion = bindingsReleaseVersion(bindings);
	if (residentVersion === ctx.packageVersion) return;

	// The bindings report another release (or none). Distinguish two failure
	// modes by what the file on disk carries:
	//   - disk stale: the `.node` on disk predates this loader (its own build);
	//     reinstalling re-syncs the file.
	//   - process stale: an in-place upgrade landed a new release on disk while
	//     this process still holds the previous addon generation resident in the
	//     dynamic-loader's native-module cache. `require` returns those old
	//     exports, which report the PRIOR release — disk is already consistent,
	//     so reinstall is a no-op and only restarting the process re-syncs.
	// Resident exports alone cannot tell these apart: `require` returns the
	// same exports in both cases. The restart diagnosis is valid only when the
	// selected file itself carries the current stamp; otherwise a restart would
	// simply reload stale disk.
	let diskHasExpectedStamp = false;
	try {
		diskHasExpectedStamp = containsVersionStamp(fs.readFileSync(candidate), ctx.packageVersion);
	} catch {
		// The successful require above normally guarantees readability. If the
		// file disappears concurrently, retain the safe reinstall diagnosis.
	}
	if (isCompatiblePreSentinelNativeAddon(bindings, diskHasExpectedStamp)) return;
	if (residentVersion && diskHasExpectedStamp) {
		throw new Error(
			`Loaded ${candidate}, which reports @oh-my-pi/pi-natives@${residentVersion}, but this loader is ` +
				`@${ctx.packageVersion}. omp was upgraded to ${ctx.packageVersion} while this session was running; ` +
				`the ${residentVersion} addon is still resident in this process. Disk is already consistent — ` +
				`restart omp to pick up ${ctx.packageVersion} (reinstalling changes nothing).`,
		);
	}
	throw new Error(
		`Loaded ${candidate} but it reports ${residentVersion ? `@oh-my-pi/pi-natives@${residentVersion}` : "no release version"}, ` +
			`not the @${ctx.packageVersion} this loader expects. The .node file on disk is from a different ` +
			"release than this loader — reinstall to re-sync.",
	);
}

/**
 * Identity of the addon `loadNative()` returned, in the shape the
 * missing-export diagnostic reports. Null until a load succeeds.
 * @type {{ path: string; version: string | null; packageVersion: string; stale: boolean } | null}
 */
let loadedAddon = null;

/**
 * Describe a loaded addon so a symbol it predates can name the file, the
 * release the file came from, and the release this tree expects.
 * @param {Record<string, unknown>} bindings
 * @param {string} candidate
 * @param {{ packageVersion: string }} ctx
 */
function describeLoadedAddon(bindings, candidate, ctx) {
	const version = bindingsReleaseVersion(bindings);
	return {
		path: candidate,
		version,
		packageVersion: ctx.packageVersion,
		stale: version !== ctx.packageVersion,
	};
}

/**
 * The addon behind this process's `@oh-my-pi/pi-natives` exports.
 * @returns {{ path: string; version: string | null; packageVersion: string; stale: boolean } | null}
 */
export function nativeAddonStatus() {
	return loadedAddon;
}

/**
 * Stand-in for an export the loaded addon does not provide.
 *
 * A workspace tree tolerates a release mismatch on purpose: a checkout that
 * pulled a new release keeps running until `bun run build:native` finishes
 * (see `validateLoadedBindings`), and PR CI loads release addons under a newer
 * checkout the same way. Such an addon has no value for any symbol added after
 * its build, so a bare `undefined` export surfaced as `<symbol> is not a
 * function` — every `write` call in a tree that pulled the read-projection
 * guard, for one — with nothing naming the stale addon.
 *
 * Only a stale addon gets the stub. On a current addon an absent export is not
 * version drift but a symbol this build does not implement, and callers probe
 * for exactly that (`typeof native.x === "function"`); they must keep seeing
 * `undefined`.
 * @param {string} symbolName
 * @param {ReturnType<typeof nativeAddonStatus>} [addon]
 * @returns {((...args: unknown[]) => never) | undefined}
 */
export function missingNativeExport(symbolName, addon = loadedAddon) {
	if (!addon?.stale) return undefined;
	return () => {
		throw new Error(missingNativeExportMessage(symbolName, addon));
	};
}

/**
 * Actionable text for {@link missingNativeExport}. `addon` is injectable so the
 * wording can be pinned without a stale `.node` on disk.
 * @param {string} symbolName
 * @param {ReturnType<typeof nativeAddonStatus>} [addon]
 * @returns {string}
 */
export function missingNativeExportMessage(symbolName, addon = loadedAddon) {
	const rebuild = "rebuild it with `bun run build:native`";
	if (!addon) return `@oh-my-pi/pi-natives does not export \`${symbolName}\`; ${rebuild}.`;
	if (!addon.stale) {
		return `@oh-my-pi/pi-natives export \`${symbolName}\` is missing from ${addon.path}; ${rebuild}.`;
	}
	const loaded = addon.version
		? `the @oh-my-pi/pi-natives@${addon.version} addon`
		: "an addon without a release stamp";
	return (
		`@oh-my-pi/pi-natives export \`${symbolName}\` is missing: ${addon.path} is ${loaded}, not ` +
		`@${addon.packageVersion} — ${rebuild}.`
	);
}

/**
 * Install the addon's bounded Tokio runtime now that `dlopen` has returned and
 * the dynamic-loader lock is released. The Rust `#[module_init]` deliberately
 * does NOT build the runtime — spawning worker threads under the loader lock
 * deadlocks on some hosts — so it exposes `__ompInstallTokioRuntime` for the
 * loader to call once, before any async native runs. Best-effort: older addons
 * predating this export simply fall back to napi-rs's default runtime.
 */
function installNativeTokioRuntime(bindings) {
	const install = bindings.__ompInstallTokioRuntime;
	if (typeof install !== "function") return;
	try {
		install();
		startupMarker("native:tokioRuntime:installed");
	} catch (err) {
		startupMarker(`native:tokioRuntime:failed:${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Point the addon at `<nativesDir>/grammars`, where the agent downloads the
 * tree-sitter grammars that load as WebAssembly on demand (pi-utils
 * `getNativeGrammarsDir()` resolves the same path). Version cleanup never
 * touches it: only release-version directories are removed. Older addons
 * predating the export link every grammar and need no directory.
 */
function configureGrammarDir(bindings, nativesDir) {
	const setGrammarDir = bindings.__ompSetGrammarDir;
	if (typeof setGrammarDir === "function") setGrammarDir(path.join(nativesDir, "grammars"));
}


function buildHelpMessage(ctx) {
	if (ctx.isCompiledBinary && embeddedAddon) {
		const expectedPaths = embeddedAddon.files
			.map(file => `  ${path.join(ctx.versionedDir, file.filename)}`)
			.join("\n");
		return (
			`The compiled binary should extract its content-addressed addons:\n${expectedPaths}\n\n` +
			"Check that the native cache is writable, then re-run or reinstall this binary. " +
			"An addon from another build cannot replace its embedded addons."
		);
	}
	if (ctx.isCompiledBinary) {
		const expectedPaths = ctx.addonFilenames.map(filename => `  ${path.join(ctx.versionedDir, filename)}`).join("\n");
		const downloadHints = ctx.addonFilenames
			.map(filename => {
				const downloadUrl = `https://github.com/can1357/oh-my-pi/releases/latest/download/${filename}`;
				const targetPath = path.join(ctx.versionedDir, filename);
				return `  curl -fsSL "${downloadUrl}" -o "${targetPath}"`;
			})
			.join("\n");
		return (
			`The compiled binary should extract one of:\n${expectedPaths}\n\n` +
			`If missing, delete ${ctx.versionedDir} and re-run, or download manually:\n${downloadHints}`
		);
	}
	return (
		"If installed via npm/bun, try reinstalling: bun install @oh-my-pi/pi-natives\n" +
		"If developing locally, build with: bun --cwd=packages/natives run build\n" +
		"Explicit targets: bun scripts/bazel-natives.ts <target> --dest packages/natives/native"
	);
}

/**
 * Initialize the loader context: resolves every path, variant, and policy
 * decision once so the inner load loop stays a pure require/validate pipeline.
 * Called from `loadNative()` rather than at module scope so importing pure
 * helpers from this file doesn't trigger AVX2 detection or filesystem probes.
 */
/**
 * @param {{ nativeDir?: string; platform?: NodeJS.Platform | string; isCompiledBinary?: boolean; leafPackageDir?: string | null }} [overrides]
 */
export function initLoaderContext(overrides = {}) {
	const platform = overrides.platform ?? process.platform;
	const platformTag = `${platform}-${process.arch}`;
	const packageVersion = packageJson.version;
	const nativeDir = overrides.nativeDir ?? path.join(import.meta.dir, "..", "native");
	const execDir = path.dirname(process.execPath);
	const nativesDir = getNativesDir();
	const versionedDir = path.join(nativesDir, packageVersion);
	const offlineState = getOfflineShmState();
	const userDataDir = offlineState
		? nativesDir
		: platform === "win32"
			? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "omp")
			: path.join(os.homedir(), ".local", "bin");

	const isCompiledBinary =
		overrides.isCompiledBinary ??
		detectCompiledBinary({
			embeddedAddon,
			env: process.env,
			importMetaUrl: import.meta.url,
		});
	const normalizedNativeDir = platform === "win32" ? nativeDir.toLowerCase() : nativeDir;
	const isWorkspaceLoad =
		!isCompiledBinary &&
		!normalizedNativeDir.includes("\\node_modules\\") &&
		!normalizedNativeDir.includes("/node_modules/");
	const leafPackageDir =
		isCompiledBinary || isWorkspaceLoad
			? null
			: overrides.leafPackageDir === undefined
				? resolveLeafPackageDir(platformTag)
				: overrides.leafPackageDir;
	const stageFromNodeModules = shouldStageNodeModulesAddon({
		platform,
		isCompiledBinary,
		nativeDir: normalizedNativeDir,
	});

	const selectedVariant = resolveCpuVariant(getVariantOverride());
	const addonFilenames = getAddonFilenames({ tag: platformTag, arch: process.arch, variant: selectedVariant });
	const addonLabel = selectedVariant ? `${platformTag} (${selectedVariant})` : platformTag;

	const candidates = resolveLoaderCandidates({
		addonFilenames,
		isCompiledBinary,
		stageFromNodeModules,
		nativeDir,
		leafPackageDir,
		execDir,
		versionedDir,
		userDataDir,
	});

	// Release validation compares `__piNativesBuildVersion()` — the version the
	// build pipeline stamps into the addon after linking
	// (`scripts/stamp-native-version.ts`) — with `package.json#version`, so a
	// `.node` from a different release is rejected at load time instead of
	// surfacing later as a silent `<sym> is not a function` crash from a
	// Windows locked-file update.

	return {
		platformTag,
		packageVersion,
		nativeDir,
		leafPackageDir,
		versionedDir,
		isCompiledBinary,
		stageFromNodeModules,
		selectedVariant,
		addonFilenames,
		addonLabel,
		candidates,
		isWorkspaceLoad,
		nativesDir,
	};
}

export function loadNative() {
	startupMarker("native:loadNative:start");
	const ctx = initLoaderContext();
	const require_ = createRequire(import.meta.url);

	const errors = [];
	// An embedded build may only load its own content-addressed files. Legacy
	// version-only caches and adjacent addons can belong to a different fork
	// build with the same package version, even when extraction fails.
	const embeddedFiles =
		ctx.isCompiledBinary && embeddedAddon
			? [
					selectEmbeddedAddonFile(ctx.selectedVariant),
					...(ctx.selectedVariant === "modern"
						? [embeddedAddon.files.find(file => file.variant === "baseline")]
						: []),
				].filter((file, index, files) => file && files.indexOf(file) === index)
			: null;
	const stagedCandidate = embeddedFiles ? null : maybeStageNodeModulesAddon(ctx, errors);
	const runtimeCandidates = embeddedFiles
		? embeddedFiles.map(file => path.join(ctx.versionedDir, file.filename))
		: stagedCandidate
			? [stagedCandidate, ...ctx.candidates]
			: ctx.candidates;

	for (const [index, candidate] of runtimeCandidates.entries()) {
		if (embeddedFiles && !maybeExtractEmbeddedAddon(ctx, errors, embeddedFiles[index])) continue;
		try {
			startupMarker(`native:require:${path.basename(candidate)}`);
			const withinNatives = path.relative(ctx.nativesDir, candidate);
			const isRuntimeAddon =
				getOfflineShmState() &&
				withinNatives !== ".." &&
				!withinNatives.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(withinNatives);
			if (isRuntimeAddon) assertOfflineShmPath(candidate);
			const bindings = isRuntimeAddon ? loadOfflineAddon(candidate, require_) : require_(candidate);
			validateLoadedBindings(ctx, bindings, candidate);
			installNativeTokioRuntime(bindings);
			configureGrammarDir(bindings, ctx.nativesDir);
			loadedAddon = describeLoadedAddon(bindings, candidate, ctx);
	        cleanupStaleNativeVersions({ nativesDir: ctx.nativesDir, currentVersion: ctx.packageVersion });
			startupMarker("native:loadNative:done");
			return bindings;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${candidate}: ${message}`);
		}
	}

	if (!SUPPORTED_PLATFORMS.includes(ctx.platformTag)) {
		throw new Error(
			`Unsupported platform: ${ctx.platformTag}\n` +
				`Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}\n` +
				"If you need support for this platform, please open an issue.",
		);
	}
	const details = errors.map(error => `- ${error}`).join("\n");
	throw new Error(
		`Failed to load pi_natives native addon for ${ctx.addonLabel}.\n\nTried:\n${details}\n\n${buildHelpMessage(ctx)}`,
	);
}
