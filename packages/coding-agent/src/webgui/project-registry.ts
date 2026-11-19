import { lstatSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type FileLockHandle, normalizePathForComparison, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import type {
	BrowserProjectPhase,
	WebGuiProject,
	WebGuiSessionInfo,
} from "../../../../vendor/zcode-frontend/preview/session-info";
import type { AgentSession } from "../session/agent-session";

export interface BrowserProjectRecord {
	readonly projectId: string;
	readonly root: string;
	readonly mode: "webgui";
	readonly phase: BrowserProjectPhase;
	readonly ownerId: string;
	readonly pid: number;
	readonly allowLan: boolean;
	readonly createdAt?: number;
	readonly updatedAt?: number;
	readonly readInfo?: () => WebGuiSessionInfo;
	readonly nativeSession?: AgentSession;
	/** Independent roots admitted by this project owner; the optional default is not an executor singleton. */
	readonly nativeSessions?: ReadonlySet<AgentSession>;
	/** Already-admitted native mutations must settle before the binding releases its lease. */
	readonly pendingModelSelections?: Set<Promise<void>>;
}

export interface BrowserProjectLease {
	readonly projectId: string;
	readonly root: string;
	readonly mode: "webgui";
	activate(
		readInfo: () => WebGuiSessionInfo,
		options?: { allowLan?: boolean; nativeSession?: AgentSession },
	): Promise<void>;
	markExiting(): Promise<void>;
	close(): Promise<void>;
}

interface OwnedBrowserProject {
	record: BrowserProjectRecord;
	readonly lock: FileLockHandle;
	readonly leases: Set<symbol>;
}

// Keep the native lock strongly reachable even if a caller drops its lease.
const projects = new Map<string, OwnedBrowserProject>();

/** Reject aliases both at the lock identifier and at the native flock sidecar. */
function checkLockPath(ompDirectory: string, lockDirectory: string, lockPath: string): boolean {
	for (const directory of [ompDirectory, lockDirectory]) {
		const entry = lstatSync(directory, { throwIfNoEntry: false });
		if (!entry) return false;
		if (!entry.isDirectory()) throw new Error(`WebGUI lock directory must be an unlinked directory: ${directory}`);
	}
	for (const file of [lockPath, `${lockPath}.lock`]) {
		const entry = lstatSync(file, { throwIfNoEntry: false });
		if (entry && (!entry.isFile() || entry.nlink !== 1))
			throw new Error(`WebGUI lock path must be an unlinked regular file: ${file}`);
	}
	return true;
}

export async function resolveBrowserProjectRoot(cwd: string): Promise<string> {
	const entered = await fs.realpath(cwd);
	const gitRoot = vcs.git(entered)?.info().repoRoot;
	return gitRoot && gitRoot !== entered ? fs.realpath(gitRoot) : entered;
}

/** One WebGUI OS lease for the canonical project, regardless of profile or native process. */
export async function acquireBrowserProject(
	cwd: string,
	options?: { reuseWebGuiOwner?: boolean },
): Promise<BrowserProjectLease> {
	const root = await resolveBrowserProjectRoot(cwd);
	const normalizedRoot = normalizePathForComparison(root);
	const projectId = new Bun.CryptoHasher("sha256").update(normalizedRoot).digest("hex");
	const ompDirectory = path.join(normalizedRoot, ".omp");
	const lockDirectory = path.join(ompDirectory, "webgui");
	const lockPath = path.join(lockDirectory, "browser-mode");
	if (!checkLockPath(ompDirectory, lockDirectory, lockPath)) {
		await fs.mkdir(lockDirectory, { recursive: true });
		if (!checkLockPath(ompDirectory, lockDirectory, lockPath))
			throw new Error(`WebGUI lock directory disappeared: ${lockDirectory}`);
	}
	const existing = projects.get(projectId);
	if (existing) {
		if (options?.reuseWebGuiOwner && existing.record.phase === "active") return retainProjectLease(existing);
		throw new Error(`项目已被 WebGUI 占用，请先退出 WebGUI：${root}`);
	}
	const lock = tryAcquireFileLock(lockPath);
	if (!lock) throw new Error(`项目已被 WebGUI 占用，请先退出 WebGUI：${root}`);
	try {
		const owner: OwnedBrowserProject = {
			record: {
				projectId,
				root,
				mode: "webgui",
				phase: "entering",
				ownerId: crypto.randomUUID(),
				pid: process.pid,
				allowLan: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				nativeSessions: new Set(),
				pendingModelSelections: new Set(),
			},
			lock,
			leases: new Set(),
		};
		projects.set(projectId, owner);
		return retainProjectLease(owner);
	} catch (error) {
		lock.release();
		throw error;
	}
}

function retainProjectLease(owner: OwnedBrowserProject): BrowserProjectLease {
	const { projectId, root, mode } = owner.record;
	const token = Symbol("browser-project-lease");
	owner.leases.add(token);
	let closed = false;
	return {
		projectId,
		root,
		mode,
		async activate(readInfo, options) {
			if (closed) throw new Error("Project ownership has been released");
			if (owner.record.phase === "exiting") throw new Error("Project ownership is exiting");
			owner.record = {
				...owner.record,
				phase: "active",
				updatedAt: Date.now(),
				readInfo: owner.record.readInfo ?? readInfo,
				allowLan: options?.allowLan ?? true,
				nativeSession: owner.record.nativeSession ?? options?.nativeSession,
				nativeSessions: new Set([
					...(owner.record.nativeSessions ?? []),
					...(options?.nativeSession ? [options.nativeSession] : []),
				]),
			};
		},
		async markExiting() {
			if (!closed) owner.record = { ...owner.record, phase: "exiting" };
		},
		async close() {
			if (closed) return;
			if (owner.leases.size === 1) {
				owner.lock.release();
				projects.delete(projectId);
			}
			owner.leases.delete(token);
			closed = true;
		},
	};
}

/** Only live owners in this OMP process are visible; the OS lock is not discovery. */
export function readBrowserProject(projectId: string): BrowserProjectRecord | null {
	return projects.get(projectId)?.record ?? null;
}

export function listBrowserProjects(): BrowserProjectRecord[] {
	return Array.from(projects.values(), owner => owner.record).sort((a, b) => a.root.localeCompare(b.root));
}

/** Quiesce the live generation without releasing its lock or dropping resident cleanup handles. */
export function markBrowserProjectExiting(projectId: string, ownerId: string): void {
	const owner = projects.get(projectId);
	if (owner?.record.ownerId === ownerId) owner.record = { ...owner.record, phase: "exiting" };
}

/** Attach only to the generation that admitted SDK startup. */
export function attachBrowserProjectSession(projectId: string, ownerId: string, session: AgentSession): void {
	const owner = projects.get(projectId);
	if (!owner || owner.record.ownerId !== ownerId || owner.record.phase !== "active")
		throw new Error("The WebGUI project owner is no longer active");
	const sessions = new Set(owner.record.nativeSessions);
	sessions.add(session);
	owner.record = {
		...owner.record,
		nativeSessions: sessions,
		nativeSession: owner.record.nativeSession ?? session,
	};
}

export function detachBrowserProjectSession(projectId: string, ownerId: string, session: AgentSession): void {
	const owner = projects.get(projectId);
	if (!owner || owner.record.ownerId !== ownerId) return;
	const sessions = new Set(owner.record.nativeSessions);
	sessions.delete(session);
	owner.record = {
		...owner.record,
		nativeSessions: sessions,
		nativeSession:
			owner.record.nativeSession === session ? sessions.values().next().value : owner.record.nativeSession,
	};
}

export function browserProjectSummary(record: BrowserProjectRecord): WebGuiProject {
	return {
		projectId: record.projectId,
		root: record.root,
		mode: record.mode,
		phase: record.phase,
	};
}
