import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type FileLockHandle, normalizePathForComparison, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import type {
	BrowserProjectMode,
	BrowserProjectPhase,
	WebGuiProject,
	WebGuiSessionInfo,
} from "../../../../vendor/zcode-frontend/preview/session-info";
import type { AgentSession } from "../session/agent-session";
import { assertSpecWritePath } from "../spec-driven/artifacts";
import { DevWorkspace } from "../spec-driven/workspace";

export interface BrowserProjectRecord {
	readonly projectId: string;
	readonly root: string;
	readonly mode: BrowserProjectMode;
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
	readonly mode: BrowserProjectMode;
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

function projectIdForRoot(root: string): string {
	return new Bun.CryptoHasher("sha256").update(normalizePathForComparison(root)).digest("hex");
}

function projectLockPath(root: string): string {
	return path.join(normalizePathForComparison(root), ".omp", "dev-workbench", "browser-mode");
}

export async function resolveBrowserProjectRoot(cwd: string): Promise<string> {
	return (await DevWorkspace.resolve(cwd)).root;
}

/** One OS lease for the canonical project, regardless of mode, profile or native process. */
export async function acquireBrowserProject(
	cwd: string,
	mode: BrowserProjectMode,
	options?: { reuseWebGuiOwner?: boolean },
): Promise<BrowserProjectLease> {
	const root = await resolveBrowserProjectRoot(cwd);
	return acquireResolvedProject(root, mode, options?.reuseWebGuiOwner === true);
}

async function acquireResolvedProject(
	root: string,
	mode: BrowserProjectMode,
	reuseWebGuiOwner: boolean,
): Promise<BrowserProjectLease> {
	const projectId = projectIdForRoot(root);
	const relative = ".omp/dev-workbench/browser-mode";
	await assertSpecWritePath(root, relative);
	await fs.mkdir(path.dirname(projectLockPath(root)), { recursive: true });
	await assertSpecWritePath(root, relative);
	const existing = projects.get(projectId);
	if (existing) {
		if (
			reuseWebGuiOwner &&
			mode === "webgui" &&
			existing.record.mode === "webgui" &&
			existing.record.phase === "active"
		)
			return retainProjectLease(existing);
		throw new Error(`项目已被 Dev 或 WebGUI 占用，请先退出原模式：${root}`);
	}
	const lock = tryAcquireFileLock(projectLockPath(root));
	if (!lock) throw new Error(`项目已被 Dev 或 WebGUI 占用，请先退出原模式：${root}`);
	try {
		const owner: OwnedBrowserProject = {
			record: {
				projectId,
				root,
				mode,
				phase: "entering",
				ownerId: crypto.randomUUID(),
				pid: process.pid,
				allowLan: mode === "webgui",
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
			if (owner.record.mode !== mode) throw new Error("Project ownership has transferred to another native mode");
			if (owner.record.phase === "exiting") throw new Error("Project ownership is exiting");
			owner.record = {
				...owner.record,
				phase: "active",
				updatedAt: Date.now(),
				readInfo: owner.record.readInfo ?? readInfo,
				allowLan: options?.allowLan ?? mode === "webgui",
				nativeSession: owner.record.nativeSession ?? options?.nativeSession,
				nativeSessions: new Set([
					...(owner.record.nativeSessions ?? []),
					...(options?.nativeSession ? [options.nativeSession] : []),
				]),
			};
		},
		async markExiting() {
			if (!closed && owner.record.mode === mode) owner.record = { ...owner.record, phase: "exiting" };
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

/** A settled native mode handoff retains the exact OS lock; there is no release/reacquire race. */
export function transferBrowserProjectToDev(projectId: string, ownerId: string): BrowserProjectLease {
	const owner = projects.get(projectId);
	if (!owner || owner.record.ownerId !== ownerId || owner.record.mode !== "webgui" || owner.record.phase !== "exiting")
		throw new Error("The WebGUI project has not settled for Dev handoff");
	owner.record = {
		...owner.record,
		mode: "dev",
		phase: "entering",
		updatedAt: Date.now(),
		readInfo: undefined,
		nativeSession: undefined,
		nativeSessions: new Set(),
	};
	return retainProjectLease(owner);
}

/** Attach only to the generation that admitted SDK startup. */
export function attachBrowserProjectSession(projectId: string, ownerId: string, session: AgentSession): void {
	const owner = projects.get(projectId);
	if (!owner || owner.record.ownerId !== ownerId || owner.record.mode !== "webgui" || owner.record.phase !== "active")
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
