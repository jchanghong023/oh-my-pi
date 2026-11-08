import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type FileLockHandle, normalizePathForComparison, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import type {
	BrowserProjectMode,
	BrowserProjectPhase,
	WebGuiProject,
	WebGuiSessionInfo,
} from "../../../../vendor/zcode-frontend/preview/session-info";
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
	readonly readInfo?: () => WebGuiSessionInfo;
}

export interface BrowserProjectLease {
	readonly projectId: string;
	readonly root: string;
	readonly mode: BrowserProjectMode;
	activate(readInfo: () => WebGuiSessionInfo, options?: { allowLan?: boolean }): Promise<void>;
	markExiting(): Promise<void>;
	close(): Promise<void>;
}

interface OwnedBrowserProject {
	record: BrowserProjectRecord;
	readonly lock: FileLockHandle;
}

// Keep the native lock strongly reachable even if a caller drops its lease.
const projects = new Map<string, OwnedBrowserProject>();

function projectIdForRoot(root: string): string {
	return new Bun.CryptoHasher("sha256").update(normalizePathForComparison(root)).digest("hex");
}

function projectLockPath(root: string): string {
	return path.join(normalizePathForComparison(root), ".omp", "dev-workbench", "browser-mode");
}

/** One OS lease for the canonical project, regardless of mode, profile or native process. */
export async function acquireBrowserProject(cwd: string, mode: BrowserProjectMode): Promise<BrowserProjectLease> {
	const { root } = await DevWorkspace.resolve(cwd);
	return acquireResolvedProject(root, mode);
}

async function acquireResolvedProject(root: string, mode: BrowserProjectMode): Promise<BrowserProjectLease> {
	const projectId = projectIdForRoot(root);
	const relative = ".omp/dev-workbench/browser-mode";
	await assertSpecWritePath(root, relative);
	await fs.mkdir(path.dirname(projectLockPath(root)), { recursive: true });
	await assertSpecWritePath(root, relative);
	if (projects.has(projectId)) throw new Error(`项目已被 Dev 或 WebGUI 占用，请先退出原模式：${root}`);
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
			},
			lock,
		};
		projects.set(projectId, owner);
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
					readInfo,
					allowLan: options?.allowLan ?? mode === "webgui",
				};
			},
			async markExiting() {
				if (closed) return;
				owner.record = { ...owner.record, phase: "exiting" };
			},
			async close() {
				if (closed) return;
				owner.lock.release();
				projects.delete(projectId);
				closed = true;
			},
		};
	} catch (error) {
		lock.release();
		throw error;
	}
}

/** Only live owners in this OMP process are visible; the OS lock is not discovery. */
export function readBrowserProject(projectId: string): BrowserProjectRecord | null {
	return projects.get(projectId)?.record ?? null;
}

export function listBrowserProjects(): BrowserProjectRecord[] {
	return Array.from(projects.values(), owner => owner.record).sort((a, b) => a.root.localeCompare(b.root));
}

export function browserProjectSummary(record: BrowserProjectRecord): WebGuiProject {
	return {
		projectId: record.projectId,
		root: record.root,
		mode: record.mode,
		phase: record.phase,
	};
}
