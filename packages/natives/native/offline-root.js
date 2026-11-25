import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export const DEFAULT_CONFIG_DIR_NAME = ".omp";

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

export function normalizeProfileName(profile) {
	const normalized = profile?.trim();
	if (!normalized || normalized === "default") return undefined;
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		!PROFILE_NAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized)
	) {
		throw new Error(
			`Invalid OMP profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
				`cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name ` +
				`(CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an extension).`,
		);
	}
	return normalized;
}

function isFullyQualifiedDir(dir) {
	// On Windows, isAbsolute also accepts a path rooted on the current drive.
	// Only a drive-qualified path or complete UNC share has a longer root.
	return path.isAbsolute(dir) && (process.platform !== "win32" || path.parse(dir).root.length > 1);
}

function expandDirectory(value) {
	let dir = value?.trim();
	if (!dir) return undefined;
	if (dir === "~") dir = os.homedir();
	else if (dir.startsWith("~/") || dir.startsWith("~\\")) dir = os.homedir() + dir.slice(1);
	return dir;
}

export function resolveAbsoluteDir(value) {
	const dir = expandDirectory(value);
	return dir && isFullyQualifiedDir(dir) ? path.normalize(dir) : undefined;
}

export function resolveNativesDirOverride() {
	// Preserve the historical acceptance of a current-drive root on Windows.
	const dir = expandDirectory(process.env.PI_NATIVES_DIR);
	return dir && path.isAbsolute(dir) ? path.normalize(dir) : undefined;
}

/** Select an already migrated XDG root, independently for each profile. */
export function resolveXdgRoot(value, profile) {
	if (!value) return undefined;
	try {
		const root = profile ? path.join(value, "omp", "profiles", profile) : path.join(value, "omp");
		return fs.existsSync(root) ? root : undefined;
	} catch {
		return undefined;
	}
}

function normalizePersistentRoot(root) {
	const normalized = path.normalize(root);
	return normalized.length > path.parse(normalized).root.length && normalized.endsWith(path.sep)
		? normalized.slice(0, -1)
		: normalized;
}

/** Resolve the original data root lexically: never stat or realpath a persistent path. */
export function resolvePersistentRoot(env = process.env) {
	const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
	const home = env === process.env ? os.homedir() : (env[homeKey] || os.userInfo().homedir);
	let override = env.OMP_CONFIG_ROOT?.trim();
	if (override === "~") override = home;
	else if (override?.startsWith("~/") || override?.startsWith("~\\")) override = home + override.slice(1);
	if (override && isFullyQualifiedDir(override)) return normalizePersistentRoot(override);
	return normalizePersistentRoot(path.join(home, env.PI_CONFIG_DIR || DEFAULT_CONFIG_DIR_NAME));
}

/** The per-user shm layout, even when the offline cache is not selected. */
export function resolveLinuxPrivateCacheRoot() {
	return process.platform === "linux" ? path.join("/dev/shm", `omp-${process.getuid()}`) : undefined;
}

/** Identify a native directory in the per-user shared-memory layout. */
export function getPrivateNativeCacheUid(directory, privateCacheRoot) {
	if (!privateCacheRoot) return undefined;
	const normalizedDir = path.resolve(directory);
	const parentDir = path.dirname(normalizedDir);
	if (
		path.basename(normalizedDir) === "natives" &&
		(parentDir === privateCacheRoot || path.dirname(parentDir) === path.join(privateCacheRoot, "profiles"))
	) {
		return process.geteuid();
	}
	return undefined;
}

/** Resolve the optional cache root, keeping named profiles in their usual layout. */
export function resolveCacheRoot(profile) {
	let root = resolveAbsoluteDir(process.env.OMP_CACHE_DIR);
	if (root && process.platform === "linux") root = path.join(root, String(process.getuid()));
	else if (!root && process.platform === "linux" && /^(1|true|yes|on)$/i.test(process.env.OMP_OFFLINE?.trim() ?? "")) {
		root = resolveLinuxPrivateCacheRoot();
	}
	return root && profile ? path.join(root, "profiles", profile) : root;
}

export class UnsafeLinuxCacheError extends Error {
	constructor(entryPath, expected, kind = "offline native") {
		super(`Unsafe Linux ${kind} cache path ${entryPath}: expected ${expected}`);
	}
}

export function lstatIfPresent(entryPath) {
	return fs.lstatSync(entryPath, { throwIfNoEntry: false });
}

export function isPrivateCacheDirectory(stat, uid) {
	return stat?.isDirectory() && stat.uid === uid && (stat.mode & 0o022) === 0;
}

function getCacheDirectory(entryPath, create) {
	let stat = lstatIfPresent(entryPath);
	if (!stat && create) {
		try {
			fs.mkdirSync(entryPath, { mode: 0o700 });
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
		}
		// Validate the actual directory, including a concurrent mkdir winner.
		stat = lstatIfPresent(entryPath);
	}
	return stat;
}

/** Create and verify every component below an already trusted parent. */
export function preparePrivateCacheDirectory(trustedParent, targetDir, uid, { create = true, kind } = {}) {
	const relative = path.relative(trustedParent, targetDir);
	if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
		throw new UnsafeLinuxCacheError(targetDir, `a directory below ${trustedParent}`, kind);
	}
	let entryPath = trustedParent;
	let stat;
	for (const component of relative.split(path.sep)) {
		entryPath = path.join(entryPath, component);
		stat = getCacheDirectory(entryPath, create);
		if (!stat && !create) return undefined;
		if (!isPrivateCacheDirectory(stat, uid)) {
			throw new UnsafeLinuxCacheError(
				entryPath,
				`a real directory owned by uid ${uid} without group/other write access`,
				kind,
			);
		}
	}
	return stat;
}

/** Verify the system shared-memory root before entering a per-user cache. */
export function prepareLinuxPrivateCacheDirectory(targetDir, uid, options = {}) {
	const { kind } = options;
	const sharedRoot = "/dev/shm";
	for (const ancestor of ["/", "/dev"]) {
		if (!isPrivateCacheDirectory(lstatIfPresent(ancestor), 0)) {
			throw new UnsafeLinuxCacheError(ancestor, "a real root-owned directory without group/other write access", kind);
		}
	}
	const shared = lstatIfPresent(sharedRoot);
	if (!shared) return undefined;
	// Sticky /dev/shm prevents other accounts from replacing our UID-owned entry.
	if (!shared.isDirectory() || shared.uid !== 0 || ((shared.mode & 0o022) !== 0 && (shared.mode & 0o1000) === 0)) {
		throw new UnsafeLinuxCacheError(sharedRoot, "a real root-owned directory, sticky if group/other writable", kind);
	}
	return preparePrivateCacheDirectory(sharedRoot, targetDir, uid, options);
}
