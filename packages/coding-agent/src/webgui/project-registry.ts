import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type FileLockHandle,
	getGlobalDaemonRuntimeDir,
	isEnoent,
	isFileLockHeld,
	isRecord,
	normalizePathForComparison,
	tryAcquireFileLock,
	withFileLock,
} from "@oh-my-pi/pi-utils";
import {
	WEBGUI_SESSION_INFO_PATH,
	type BrowserProjectMode,
	type BrowserProjectPhase,
	type WebGuiProject,
	type WebGuiSessionInfo,
} from "../../../../vendor/zcode-frontend/preview/session-info";
import { assertSpecWritePath } from "../spec-driven/artifacts";
import { DevWorkspace } from "../spec-driven/workspace";
import { writeFileAtomically } from "../utils/atomic-file";

export interface BrowserProjectRecord {
	projectId: string;
	root: string;
	mode: BrowserProjectMode;
	phase: BrowserProjectPhase;
	ownerId: string;
	pid: number;
	infoUrl: string;
	devUrl: string | null;
	allowLan: boolean;
}

export interface BrowserProjectLease {
	readonly projectId: string;
	readonly root: string;
	readonly mode: BrowserProjectMode;
	activate(readInfo: () => WebGuiSessionInfo, devUrl?: string, allowLan?: boolean): Promise<void>;
	markExiting(): Promise<void>;
	close(): Promise<void>;
}

export function webGuiRuntimeDir(): string {
	return getGlobalDaemonRuntimeDir("webgui");
}

/** Serialize a new project publication with the shared owner's empty-project shutdown decision. */
export async function withBrowserProjectAdmission<T>(operation: () => Promise<T>): Promise<T> {
	await fs.mkdir(webGuiRuntimeDir(), { recursive: true, mode: 0o700 });
	return withFileLock(path.join(webGuiRuntimeDir(), "project-admission"), operation);
}

function projectRecordsDir(): string {
	return path.join(webGuiRuntimeDir(), "projects");
}

function projectIdForRoot(root: string): string {
	return new Bun.CryptoHasher("sha256").update(normalizePathForComparison(root)).digest("hex");
}

function projectLockPath(root: string): string {
	return path.join(normalizePathForComparison(root), ".omp", "dev-workbench", "browser-mode");
}

/** One OS lease for the canonical project, regardless of mode, profile or native process. */
export async function acquireBrowserProject(cwd: string, mode: BrowserProjectMode): Promise<BrowserProjectLease> {
	const { root } = await DevWorkspace.resolve(cwd);
	return withBrowserProjectAdmission(() => acquireResolvedProject(root, mode));
}

async function acquireResolvedProject(root: string, mode: BrowserProjectMode): Promise<BrowserProjectLease> {
	const projectId = projectIdForRoot(root);
	const relative = ".omp/dev-workbench/browser-mode";
	await assertSpecWritePath(root, relative);
	await fs.mkdir(path.dirname(projectLockPath(root)), { recursive: true });
	await assertSpecWritePath(root, relative);
	const lease: FileLockHandle | null = tryAcquireFileLock(projectLockPath(root));
	if (!lease) throw new Error(`项目已被 Dev 或 WebGUI 占用，请先退出原模式：${root}`);
	let server: Bun.Server<undefined> | undefined;
	try {
		const ownerId = crypto.randomUUID();
		const infoPath = `/${ownerId}${WEBGUI_SESSION_INFO_PATH}`;
		let readInfo: (() => WebGuiSessionInfo) | undefined;
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const headers = { "Cache-Control": "no-store" };
				if (new URL(request.url).pathname !== infoPath) return new Response(null, { status: 404, headers });
				if (request.method !== "GET")
					return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
				if (!readInfo) return new Response(null, { status: 503, headers });
				return Response.json(readInfo(), { headers });
			},
			error() {
				return new Response(null, { status: 500, headers: { "Cache-Control": "no-store" } });
			},
		});
		const infoServer = server;
		let record: BrowserProjectRecord = {
			projectId, root, mode, phase: "entering", ownerId, pid: process.pid,
			infoUrl: `http://127.0.0.1:${infoServer.port}${infoPath}`,
			devUrl: null, allowLan: mode === "webgui",
		};
		await fs.mkdir(projectRecordsDir(), { recursive: true, mode: 0o700 });
		const recordPath = path.join(projectRecordsDir(), `${projectId}.json`);
		const save = () => writeFileAtomically(recordPath, `${JSON.stringify(record)}\n`);
		await save();
		let closed = false;
		let closing: Promise<void> | undefined;
		return {
			projectId, root, mode,
			async activate(source, devUrl, allowLan = mode === "webgui") {
				if (closed) throw new Error("Project ownership has been released");
				if (mode === "dev" && !devUrl) throw new Error("Dev project requires its native workbench URL");
				readInfo = source;
				record = { ...record, phase: "active", devUrl: devUrl ?? null, allowLan };
				await save();
			},
			async markExiting() {
				if (closed) return;
				record = { ...record, phase: "exiting" };
				await save();
			},
			close() {
				if (closed) return Promise.resolve();
				if (!closing) {
					closing = (async () => {
						await infoServer.stop(true);
						await fs.rm(recordPath, { force: true });
						lease.release();
						closed = true;
					})();
					void closing.catch(() => { closing = undefined; });
				}
				return closing;
			},
		};
	} catch (error) {
		await server?.stop(true);
		lease.release();
		throw error;
	}
}

/** A stale discovery file cannot hold a project or revive a dead owner. */
export async function readBrowserProject(projectId: string): Promise<BrowserProjectRecord | null> {
	if (!/^[a-f0-9]{64}$/.test(projectId)) return null;
	let value: unknown;
	try {
		value = await Bun.file(path.join(projectRecordsDir(), `${projectId}.json`)).json();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	if (
		!isRecord(value) || value.projectId !== projectId || typeof value.root !== "string" ||
		!path.isAbsolute(value.root) || projectIdForRoot(value.root) !== projectId ||
		(value.mode !== "dev" && value.mode !== "webgui") ||
		(value.phase !== "entering" && value.phase !== "active" && value.phase !== "exiting") ||
		typeof value.ownerId !== "string" || typeof value.pid !== "number" ||
		typeof value.infoUrl !== "string" || (value.devUrl !== null && typeof value.devUrl !== "string") ||
		typeof value.allowLan !== "boolean"
	) throw new Error(`Invalid browser project registration: ${projectId}`);
	if (!isFileLockHeld(projectLockPath(value.root))) return null;
	return value as unknown as BrowserProjectRecord;
}

export async function listBrowserProjects(): Promise<BrowserProjectRecord[]> {
	let names: string[];
	try {
		names = await fs.readdir(projectRecordsDir());
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const records = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))
		.map(name => readBrowserProject(name.slice(0, -5))));
	return records.filter((record): record is BrowserProjectRecord => record !== null)
		.sort((a, b) => a.root.localeCompare(b.root));
}

export function browserProjectSummary(record: BrowserProjectRecord): WebGuiProject {
	return {
		projectId: record.projectId, root: record.root, mode: record.mode, phase: record.phase,
	};
}
