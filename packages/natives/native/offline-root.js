import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_CONFIG_DIR_NAME = ".omp";

/** Resolve the original data root lexically: never stat or realpath a persistent path. */
export function resolvePersistentRoot(env = process.env) {
	const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
	const home = env === process.env ? os.homedir() : (env[homeKey] || os.userInfo().homedir);
	let override = env.OMP_CONFIG_ROOT?.trim();
	if (override === "~") override = home;
	else if (override?.startsWith("~/") || override?.startsWith("~\\")) override = home + override.slice(1);
	if (override && path.isAbsolute(override)) return path.normalize(override);
	return path.join(home, env.PI_CONFIG_DIR || DEFAULT_CONFIG_DIR_NAME);
}
/** No initialization, backup discovery, or persistent-root IO occurs at module load. */
export function getOfflineShmState(env = process.env) {
	if (process.platform !== "linux" || !/^(?:1|true|yes|on)$/i.test(env.OMP_OFFLINE?.trim() ?? "")) {
		return undefined;
	}
	const persistentRoot = resolvePersistentRoot(env);
	const uid = process.getuid();
	const domainId = createHash("sha256").update(JSON.stringify([os.hostname(), uid, persistentRoot])).digest("hex");
	const runtimeRoot = path.join("/dev/shm", `omp-${uid}-${domainId}`, path.basename(persistentRoot) || "root");
	const state = { persistentRoot, runtimeRoot, domainId };
	ensureRuntimeDirectory(state, "");
	return state;
}

function assertPrivateDirectory(directory, uid) {
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
		throw new Error(`Unsafe offline shm directory: ${directory}; expected an owned, private directory (0700)`);
	}
	fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}

function ensureRuntimeDirectory(state, relative) {
	const destination = path.resolve(state.runtimeRoot, relative);
	const within = path.relative(state.runtimeRoot, destination);
	if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
		throw new Error("Offline shm directory must remain inside the runtime root");
	}
	try {
		const shm = fs.lstatSync("/dev/shm");
		if (!shm.isDirectory() || shm.isSymbolicLink()) throw new Error("/dev/shm is not a real directory");
		fs.accessSync("/dev/shm", fs.constants.W_OK | fs.constants.X_OK);
		let directory = "/dev/shm";
		for (const component of path.relative(directory, destination).split(path.sep)) {
			directory = path.join(directory, component);
			try {
				fs.mkdirSync(directory, { mode: 0o700 });
			} catch (error) {
				if (error?.code !== "EEXIST") throw error;
			}
			assertPrivateDirectory(directory, process.getuid());
		}
		return destination;
	} catch (error) {
		throw new Error(`Cannot initialize offline shm directory ${destination}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

/** Create/validate only local, private runtime directories; never follow a pre-existing symlink. */
export function ensureOfflineShmDirectory(relative = "") {
	const state = getOfflineShmState();
	return state ? ensureRuntimeDirectory(state, relative) : undefined;
}

/** Reject restored links without following them or probing anything outside the local runtime domain. */
export function assertOfflineShmPath(destination, env = process.env) {
	const state = getOfflineShmState(env);
	if (!state) return;
	const within = path.relative(state.runtimeRoot, path.resolve(destination));
	if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
		throw new Error("Offline shm path must remain inside the runtime root");
	}
	let current = state.runtimeRoot;
	const components = within ? within.split(path.sep) : [];
	for (let index = 0; index < components.length; index++) {
		current = path.join(current, components[index]);
		let stat;
		try {
			stat = fs.lstatSync(current);
		} catch (error) {
			if (error?.code === "ENOENT") return;
			throw error;
		}
		if (stat.isSymbolicLink()) {
			throw new Error(`Unsafe offline shm path: ${current}; symbolic links are not allowed`);
		}
		if (index < components.length - 1 && !stat.isDirectory()) {
			throw new Error(`Unsafe offline shm path: ${current}; expected a directory`);
		}
	}
}

/** Set inherited OS-temporary defaults without ever rewriting OMP_CONFIG_ROOT. */
export function initializeOfflineShmEnvironment(relativeRoot = "") {
	const directory = ensureOfflineShmDirectory(path.join(relativeRoot, "tmp"));
	if (directory) {
		process.env.TMPDIR = directory;
		process.env.TMP = directory;
		process.env.TEMP = directory;
	}
	return directory;
}
