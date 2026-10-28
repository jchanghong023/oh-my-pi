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

export function resolveAbsoluteDir(value) {
	let dir = value?.trim();
	if (!dir) return undefined;
	if (dir === "~") dir = os.homedir();
	else if (dir.startsWith("~/") || dir.startsWith("~\\")) dir = os.homedir() + dir.slice(1);
	return path.isAbsolute(dir) ? path.normalize(dir) : undefined;
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
	if (override && path.isAbsolute(override)) return normalizePersistentRoot(override);
	return normalizePersistentRoot(path.join(home, env.PI_CONFIG_DIR || DEFAULT_CONFIG_DIR_NAME));
}
