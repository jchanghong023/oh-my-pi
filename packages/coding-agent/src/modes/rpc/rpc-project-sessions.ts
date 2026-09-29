/**
 * Fork RPC project-mode multi-session container (requirement R3, rpc-ui-protocol.md §5/§14.3).
 *
 * Owns every {@link AgentSession} instance hosted by one rpc-ui-project
 * process: creation (factory-injected so the host layer keeps prompt/tool/UI
 * wiring), idempotent resume by stable session id with concurrent-load
 * coalescing, the merged directory view (saved JSONL sessions + in-memory
 * instances), close/rename/delete with busy guards, and best-effort shutdown.
 * Every mutation bumps a monotonic revision and notifies `onChanged` so the
 * host layer can emit `sessions_changed`. Persistence flows through the
 * existing `session-listing` / `session-storage` modules; this file never
 * writes to the protocol channel (stdout).
 */
import * as path from "node:path";
import type { AgentSession } from "../../session/agent-session";
import { listSessions, type SessionInfo } from "../../session/session-listing";
import { FileSessionStorage } from "../../session/session-storage";
import {
	RpcRevisionSource,
	type RpcProjectErrorCode,
	type RpcProjectSessionRunState,
	type RpcProjectSessionSummary,
	type RpcRevision,
} from "./rpc-project-types";

/** Typed failure surfaced by the container; `code` maps to RpcProjectErrorCode (rpc-ui-protocol.md §14.1). */
export class RpcProjectSessionError extends Error {
	readonly code: RpcProjectErrorCode;

	constructor(code: RpcProjectErrorCode, message: string) {
		super(message);
		this.name = "RpcProjectSessionError";
		this.code = code;
	}
}

/**
 * Host-side companion of one loaded session: best-effort run-state probes plus
 * release of host-level resources (event subscriptions, pending requests).
 * Provided by the rpc host layer; the container only reads it.
 */
export interface RpcProjectSessionHostLike {
	/** Best-effort run state used by the directory and busy checks. */
	readonly isStreaming: boolean;
	hasPendingAsyncWork(): boolean;
	isWaitingInteraction(): boolean;
	/** Release host-level resources (event subscriptions, pending requests). Does NOT dispose the AgentSession. */
	dispose(reason: string): Promise<void> | void;
}

/** Bundle returned by the session factory: the fresh session plus its host-side attach points. */
export interface RpcProjectCreatedSession {
	readonly session: AgentSession;
	/** Per-session UI-context setter returned by createAgentSession. */
	readonly setToolUIContext: (uiContext: unknown, hasUI: boolean) => void;
	/** The session-scoped subagent event bus this session was created with. */
	readonly subagentEventBus?: import("../../utils/event-bus").EventBus;
	/** Attach the session host AFTER construction (set via setHost). */
	setHost(host: RpcProjectSessionHostLike): void;
}

/** Creates one fresh, empty AgentSession wired to this project (host layer provides the implementation). */
export type RpcProjectSessionFactory = () => Promise<RpcProjectCreatedSession>;

/** One hosted session instance: the loaded AgentSession plus container bookkeeping. */
export interface RpcProjectSessionRecord {
	readonly sessionId: string;
	readonly sessionGeneration: string;
	/** Set once the session host attaches (via the created bundle's setHost). */
	readonly host?: RpcProjectSessionHostLike;
	readonly session: AgentSession;
	readonly createdAt: string;
	state: "loading" | "loaded" | "closing";
	/** Transition guard: set while a close/delete is tearing this record down. */
	busy?: boolean;
}

export interface RpcProjectSessionContainerOptions {
	/** Project root (fixed for the process). */
	readonly cwd: string;
	/** Directory where session JSONL files live. */
	readonly sessionDir: string;
	readonly createSession: RpcProjectSessionFactory;
	/** Default `new FileSessionStorage()`. */
	readonly storage?: FileSessionStorage;
	/** Called whenever the directory revision changes (`sessions_changed`). */
	readonly onChanged?: (revision: RpcRevision) => void;
}

export interface RpcProjectSessionCreateOptions {
	readonly name?: string;
	/** Accepted but not applied here — model selection is the caller's business. */
	readonly model?: { readonly provider: string; readonly modelId: string };
}

export interface RpcProjectSessionListOptions {
	/** Numeric offset into the merged, sorted directory (default 0). */
	readonly cursor?: number;
	/** Page size; default 50, valid range 1..200 (out of range → invalid_params). */
	readonly limit?: number;
	readonly loadState?: "loaded" | "not_loaded";
}

export interface RpcProjectSessionListResult {
	readonly sessions: RpcProjectSessionSummary[];
	readonly revision: RpcRevision;
	readonly nextCursor?: number;
}

export interface RpcProjectSessionCloseResult {
	readonly state: "unloaded";
	readonly revision: RpcRevision;
}

export interface RpcProjectSessionRenameResult {
	readonly summary: RpcProjectSessionSummary;
	readonly revision: RpcRevision;
}

export interface RpcProjectSessionDeleteResult {
	readonly revision: RpcRevision;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isoOrUndefined(date: Date | undefined): string | undefined {
	if (!date || Number.isNaN(date.getTime())) return undefined;
	return date.toISOString();
}

/** Best-effort run state of a hosted record; only the attached host can report interaction waits. */
function deriveRunState(record: RpcProjectSessionRecord): RpcProjectSessionRunState {
	if (record.state === "closing") return "closing";
	const host = record.host;
	if (!host) return "idle";
	if (host.isStreaming) return "streaming";
	if (host.isWaitingInteraction()) return "waiting_interaction";
	return "idle";
}

/** Live fields any hosted record projects over a base summary (wire order preserved). */
function liveRecordFields(
	record: RpcProjectSessionRecord,
): Pick<RpcProjectSessionSummary, "name" | "sessionFile" | "loadState" | "runState" | "sessionGeneration"> {
	const session = record.session;
	return {
		...(session.sessionName ? { name: session.sessionName } : {}),
		...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
		loadState: record.state,
		runState: deriveRunState(record),
		sessionGeneration: record.sessionGeneration,
	};
}

/** Summary built from an in-memory record (no disk scan); `revision` is required by the wire type. */
export function buildSessionSummary(record: RpcProjectSessionRecord, revision: RpcRevision): RpcProjectSessionSummary {
	return {
		sessionId: record.sessionId,
		...liveRecordFields(record),
		createdAt: record.createdAt,
		revision,
	};
}

/** Summary of a saved-but-not-loaded session from a directory scan. */
export function summaryFromListed(entry: SessionInfo, revision: RpcRevision): RpcProjectSessionSummary {
	return {
		sessionId: entry.id,
		...(entry.title ? { name: entry.title } : {}),
		sessionFile: entry.path,
		loadState: "not_loaded",
		createdAt: isoOrUndefined(entry.created),
		modifiedAt: isoOrUndefined(entry.modified),
		messageCount: entry.messageCount,
		revision,
	};
}

/** Overlay the in-memory record's live fields onto its listed (disk) summary. */
function mergeListedWithRecord(
	base: RpcProjectSessionSummary,
	record: RpcProjectSessionRecord,
	revision: RpcRevision,
): RpcProjectSessionSummary {
	return {
		...base,
		...liveRecordFields(record),
		revision,
	};
}

function summarySortMs(summary: RpcProjectSessionSummary): number {
	const modified = summary.modifiedAt !== undefined ? Date.parse(summary.modifiedAt) : Number.NaN;
	if (Number.isFinite(modified)) return modified;
	const created = summary.createdAt !== undefined ? Date.parse(summary.createdAt) : Number.NaN;
	return Number.isFinite(created) ? created : 0;
}

function normalizeListLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIST_LIMIT;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
		throw new RpcProjectSessionError("invalid_params", `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
	}
	return limit;
}

function normalizeListCursor(cursor: number | undefined): number {
	if (cursor === undefined) return 0;
	if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
		throw new RpcProjectSessionError("invalid_params", "cursor must be a non-negative integer offset");
	}
	return cursor;
}

/** Internal mutable view of a record's host slot (readonly on the public interface). */
type WritableRecordHost = { host?: RpcProjectSessionHostLike };

/**
 * Multi-session container for project mode: directory + lifecycle of every
 * hosted AgentSession, keyed by stable session id. All mutating methods bump
 * the revision and invoke `onChanged`; none of them touch the RPC channel.
 */
export class RpcProjectSessionContainer {
	readonly #options: RpcProjectSessionContainerOptions;
	readonly #storage: FileSessionStorage;
	readonly #records = new Map<string, RpcProjectSessionRecord>();
	/** Concurrent resume coalescing (requirement O04): one load per session id. */
	readonly #resuming = new Map<string, Promise<RpcProjectSessionRecord>>();
	readonly #revisions = new RpcRevisionSource();
	#generationCounter = 0;

	constructor(options: RpcProjectSessionContainerOptions) {
		this.#options = options;
		this.#storage = options.storage ?? new FileSessionStorage();
	}

	/** Current directory revision; changes on every container mutation. */
	get revision(): RpcRevision {
		return this.#revisions.current;
	}

	/** Bump the revision and notify the host (`sessions_changed`), isolating listener failures. */
	#bump(): RpcRevision {
		const revision = this.#revisions.bump();
		try {
			this.#options.onChanged?.(revision);
		} catch (err) {
			console.error("[rpc-project-sessions] sessions-changed listener failed", err);
		}
		return revision;
	}

	#nextGeneration(): string {
		return `${++this.#generationCounter}-${Date.now().toString(36)}`;
	}

	/**
	 * Intercept the created bundle's `setHost` so a later host attachment also
	 * lands on the record's host slot (used by close/busy checks and runState).
	 */
	#wireHostAttachment(created: RpcProjectCreatedSession, record: RpcProjectSessionRecord): void {
		try {
			const attach = created.setHost;
			created.setHost = (host: RpcProjectSessionHostLike): void => {
				attach.call(created, host);
				(record as WritableRecordHost).host = host;
			};
		} catch (err) {
			console.error(`[rpc-project-sessions] failed to intercept setHost for session ${record.sessionId}`, err);
		}
	}

	async #disposeSessionQuietly(session: AgentSession, context: string): Promise<void> {
		try {
			await session.dispose();
		} catch (err) {
			console.error(`[rpc-project-sessions] session dispose failed during ${context}`, err);
		}
	}

	/** Locate a saved session by stable id in the session directory; throws not_found. */
	async #locateListed(sessionId: string): Promise<SessionInfo> {
		const entries = await listSessions(this.#options.sessionDir, this.#storage);
		const entry = entries.find(candidate => candidate.id === sessionId);
		if (!entry) {
			throw new RpcProjectSessionError("not_found", `Session ${sessionId} not found in ${this.#options.sessionDir}`);
		}
		return entry;
	}

	/** Teardown gate: no double close/delete, and running work rejects unless cancelled. */
	#assertTeardownAllowed(record: RpcProjectSessionRecord, cancelRunning: boolean): void {
		if (record.busy) {
			throw new RpcProjectSessionError(
				"busy",
				`A close or delete is already in progress for session ${record.sessionId}`,
			);
		}
		const host = record.host;
		if (!cancelRunning && host && (host.isStreaming || host.hasPendingAsyncWork())) {
			const running = host.isStreaming ? "streaming" : "finishing pending async work";
			throw new RpcProjectSessionError(
				"busy",
				`Session ${record.sessionId} is ${running}; retry with cancelRunning`,
			);
		}
	}

	/**
	 * Tear one record down (abort first when cancelling, then host release, then
	 * session dispose) and remove it from the directory. Callers enforce the
	 * busy gate. On failure the record is restored (not removed) and rethrown.
	 */
	async #closeRecord(
		record: RpcProjectSessionRecord,
		options: { cancelRunning: boolean; reason: string },
	): Promise<void> {
		const previousState = record.state;
		record.busy = true;
		try {
			if (options.cancelRunning) {
				try {
					await record.session.abort();
				} catch {
					// Best-effort cancel: teardown proceeds regardless.
				}
			}
			record.state = "closing";
			await record.host?.dispose(options.reason);
			await record.session.dispose();
		} catch (err) {
			record.state = previousState;
			throw err;
		} finally {
			record.busy = false;
		}
		this.#records.delete(record.sessionId);
	}

	/**
	 * Create a new session in this project: factory-built instance, persisted
	 * immediately (`ensureOnDisk`), optionally named. `model` is intentionally
	 * not applied here — model selection is the caller's business.
	 */
	async create(options: RpcProjectSessionCreateOptions = {}): Promise<RpcProjectSessionRecord> {
		return this.adoptCreated(await this.#options.createSession(), options);
	}

	/**
	 * Adopt an externally-created session bundle into the container (the host
	 * layer creates the bundle so it can also build the session host from the
	 * same `created` handle). Same persistence/naming semantics as
	 * {@link create}.
	 */
	async adoptCreated(
		created: RpcProjectCreatedSession,
		options: RpcProjectSessionCreateOptions = {},
	): Promise<RpcProjectSessionRecord> {
		if (options.name !== undefined && !options.name.trim()) {
			throw new RpcProjectSessionError("invalid_params", "Session name cannot be empty");
		}
		const record: RpcProjectSessionRecord = {
			sessionId: created.session.sessionId,
			sessionGeneration: this.#nextGeneration(),
			session: created.session,
			createdAt: new Date().toISOString(),
			state: "loading",
		};
		this.#records.set(record.sessionId, record);
		this.#wireHostAttachment(created, record);
		try {
			try {
				await created.session.sessionManager.ensureOnDisk();
			} catch (err) {
				throw new RpcProjectSessionError("persistence_failed", `Failed to persist new session: ${errorText(err)}`);
			}
			if (options.name !== undefined) {
				const applied = await created.session.setSessionName(options.name, "user");
				if (!applied) {
					throw new RpcProjectSessionError("invalid_params", "Session name cannot be empty");
				}
			}
		} catch (err) {
			this.#records.delete(record.sessionId);
			await this.#disposeSessionQuietly(created.session, "create rollback");
			throw err;
		}
		record.state = "loaded";
		this.#bump();
		return record;
	}

	/**
	 * Load a persisted session by stable id. Idempotent: a known record is
	 * returned as-is; concurrent resumes of the same id coalesce onto one load
	 * (requirement O04). A vanished session file maps to not_found; any other
	 * load failure disposes the fresh instance and maps to execution_failed.
	 */
	async resume(sessionId: string): Promise<RpcProjectSessionRecord> {
		const { record } = await this.resumeWithFactory(sessionId, () => this.#options.createSession());
		return record;
	}

	/**
	 * Like {@link resume}, but the host layer supplies the factory call so the
	 * returned `created` handle (UI-context setter, subagent bus) can be used
	 * to attach the session host. The coalescing promise resolves `{ record }`
	 * without `created` for callers that found the instance already loading.
	 */
	async resumeWithFactory(
		sessionId: string,
		factory: () => Promise<RpcProjectCreatedSession>,
	): Promise<{ record: RpcProjectSessionRecord; created?: RpcProjectCreatedSession }> {
		const existing = this.#records.get(sessionId);
		if (existing) return { record: existing };
		const pending = this.#resuming.get(sessionId);
		if (pending) return { record: await pending };
		const load = this.#resumeOnce(sessionId, factory);
		this.#resuming.set(sessionId, load);
		try {
			const record = await load;
			return { record, created: this.#lastCreated.get(sessionId) };
		} finally {
			this.#resuming.delete(sessionId);
			this.#lastCreated.delete(sessionId);
		}
	}

	/** created bundles produced by #resumeOnce, keyed by session id for the coalesced caller. */
	readonly #lastCreated = new Map<string, RpcProjectCreatedSession>();

	async #resumeOnce(
		sessionId: string,
		factory: () => Promise<RpcProjectCreatedSession>,
	): Promise<RpcProjectSessionRecord> {
		const known = this.#records.get(sessionId);
		if (known) return known;
		const entry = await this.#locateListed(sessionId);
		const created = await factory();
		this.#lastCreated.set(sessionId, created);
		// The record carries the TARGET stable id; switchSession makes the fresh
		// instance adopt it (and its history) from the saved file.
		const record: RpcProjectSessionRecord = {
			sessionId,
			sessionGeneration: this.#nextGeneration(),
			session: created.session,
			createdAt: new Date().toISOString(),
			state: "loading",
		};
		this.#records.set(sessionId, record);
		this.#wireHostAttachment(created, record);
		try {
			const switched = await created.session.switchSession(entry.path);
			if (!switched) {
				throw new RpcProjectSessionError("execution_failed", `Resume of session ${sessionId} was cancelled`);
			}
		} catch (err) {
			this.#records.delete(sessionId);
			await this.#disposeSessionQuietly(created.session, "resume rollback");
			if (err instanceof RpcProjectSessionError) throw err;
			let fileExists = false;
			try {
				fileExists = await this.#storage.exists(entry.path);
			} catch {
				fileExists = false;
			}
			if (!fileExists) {
				throw new RpcProjectSessionError("not_found", `Session file for ${sessionId} is missing: ${entry.path}`);
			}
			throw new RpcProjectSessionError("execution_failed", `Failed to load session ${sessionId}: ${errorText(err)}`);
		}
		record.state = "loaded";
		this.#bump();
		return record;
	}

	/**
	 * Merged directory view: saved sessions from disk (not_loaded) overlaid
	 * with in-memory records (live loadState/runState/generation), deduped by
	 * session id (in-memory wins), sorted newest-modified first, then
	 * offset-paginated with a numeric cursor.
	 */
	async list(options: RpcProjectSessionListOptions = {}): Promise<RpcProjectSessionListResult> {
		const limit = normalizeListLimit(options.limit);
		const offset = normalizeListCursor(options.cursor);
		const revision = this.revision;
		const listed = await listSessions(this.#options.sessionDir, this.#storage);
		const byId = new Map<string, RpcProjectSessionSummary>();
		for (const entry of listed) byId.set(entry.id, summaryFromListed(entry, revision));
		for (const record of this.#records.values()) {
			const base = byId.get(record.sessionId);
			byId.set(
				record.sessionId,
				base ? mergeListedWithRecord(base, record, revision) : buildSessionSummary(record, revision),
			);
		}
		let sessions = Array.from(byId.values());
		sessions.sort((a, b) => {
			const delta = summarySortMs(b) - summarySortMs(a);
			if (delta !== 0) return delta;
			return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
		});
		if (options.loadState !== undefined) {
			const loadState = options.loadState;
			sessions = sessions.filter(summary => summary.loadState === loadState);
		}
		const page = sessions.slice(offset, offset + limit);
		const nextOffset = offset + page.length;
		return {
			sessions: page,
			revision,
			...(nextOffset < sessions.length ? { nextCursor: nextOffset } : {}),
		};
	}

	/** Record by session id, any state; undefined when unknown. */
	get(sessionId: string): RpcProjectSessionRecord | undefined {
		return this.#records.get(sessionId);
	}

	/** Directory summary of a hosted record at the current revision. */
	buildSummary(record: RpcProjectSessionRecord): RpcProjectSessionSummary {
		return buildSessionSummary(record, this.revision);
	}

	/** Every hosted record (any state), snapshot copy. */
	listRecords(): readonly RpcProjectSessionRecord[] {
		return Array.from(this.#records.values());
	}

	/** Session file for a stable id: live record first, then a directory scan; undefined when unknown. */
	async findSessionFileById(sessionId: string): Promise<string | undefined> {
		const loaded = this.#records.get(sessionId);
		if (loaded?.session.sessionFile) return loaded.session.sessionFile;
		try {
			return (await this.#locateListed(sessionId)).path;
		} catch {
			return undefined;
		}
	}

	/** Fully-loaded record by session id; undefined for loading/closing/unknown records. */
	getLoaded(sessionId: string): RpcProjectSessionRecord | undefined {
		const record = this.#records.get(sessionId);
		return record?.state === "loaded" ? record : undefined;
	}

	/** Record whose live session file matches `sessionFile` (path-resolved comparison). */
	findRecordBySessionFile(sessionFile: string): RpcProjectSessionRecord | undefined {
		const target = path.resolve(sessionFile);
		for (const record of this.#records.values()) {
			const file = record.session.sessionFile;
			if (file !== undefined && path.resolve(file) === target) return record;
		}
		return undefined;
	}

	/**
	 * Unload one session instance (history stays on disk). Running work rejects
	 * with busy unless `cancelRunning`; a double close rejects with busy. On
	 * success the record is gone and the revision has bumped.
	 */
	async close(sessionId: string, options: { cancelRunning?: boolean } = {}): Promise<RpcProjectSessionCloseResult> {
		const record = this.#records.get(sessionId);
		if (!record) {
			throw new RpcProjectSessionError("not_found", `Session ${sessionId} is not loaded`);
		}
		this.#assertTeardownAllowed(record, options.cancelRunning === true);
		await this.#closeRecord(record, { cancelRunning: options.cancelRunning === true, reason: "session_closed" });
		const revision = this.#bump();
		return { state: "unloaded", revision };
	}

	/**
	 * Rename by stable id, loaded or not. `expectedRevision` (when given) is
	 * compared against the current container revision; mismatch →
	 * revision_conflict. Loaded sessions ride `setSessionName("user")`; saved
	 * ones get an in-place title-slot rewrite.
	 */
	async rename(
		sessionId: string,
		name: string,
		expectedRevision?: RpcRevision,
	): Promise<RpcProjectSessionRenameResult> {
		const trimmed = typeof name === "string" ? name.trim() : "";
		if (!trimmed) {
			throw new RpcProjectSessionError("invalid_params", "Session name cannot be empty");
		}
		if (expectedRevision !== undefined && expectedRevision !== this.revision) {
			throw new RpcProjectSessionError(
				"revision_conflict",
				`Expected revision ${expectedRevision} but directory is at ${this.revision}`,
			);
		}
		const record = this.#records.get(sessionId);
		if (record) {
			const applied = await record.session.setSessionName(trimmed, "user");
			if (!applied) {
				throw new RpcProjectSessionError("invalid_params", "Session name cannot be empty");
			}
			const revision = this.#bump();
			return { summary: buildSessionSummary(record, revision), revision };
		}
		const entry = await this.#locateListed(sessionId);
		await this.#storage.updateSessionTitle(entry.path, {
			title: trimmed,
			source: "user",
			updatedAt: new Date().toISOString(),
		});
		const revision = this.#bump();
		return { summary: { ...summaryFromListed(entry, revision), name: trimmed }, revision };
	}

	/**
	 * Delete a session and its artifacts. Loaded instances are closed first
	 * (same busy rules as close: running work rejects unless cancelRunning);
	 * the session file is resolved from the live record, falling back to a
	 * directory scan. Unknown ids reject with not_found.
	 */
	async delete(
		sessionId: string,
		options: { cancelRunning?: boolean; expectedRevision?: RpcRevision } = {},
	): Promise<RpcProjectSessionDeleteResult> {
		if (options.expectedRevision !== undefined && options.expectedRevision !== this.revision) {
			throw new RpcProjectSessionError(
				"revision_conflict",
				`Expected revision ${options.expectedRevision} but directory is at ${this.revision}`,
			);
		}
		const record = this.#records.get(sessionId);
		if (record) {
			this.#assertTeardownAllowed(record, options.cancelRunning === true);
			const sessionFile = record.session.sessionFile;
			await this.close(sessionId, { cancelRunning: true });
			let target = sessionFile;
			if (!target) {
				const listed = await this.#locateListed(sessionId).catch(() => undefined);
				target = listed?.path;
			}
			if (target) {
				await this.#storage.deleteSessionWithArtifacts(target);
			}
			return { revision: this.#bump() };
		}
		const entry = await this.#locateListed(sessionId);
		await this.#storage.deleteSessionWithArtifacts(entry.path);
		return { revision: this.#bump() };
	}

	/** Best-effort shutdown: close every hosted record with cancellation, swallowing individual failures. */
	async disposeAll(reason: string): Promise<void> {
		let closed = 0;
		for (const record of Array.from(this.#records.values())) {
			try {
				await this.#closeRecord(record, { cancelRunning: true, reason });
				closed++;
			} catch (err) {
				console.error(`[rpc-project-sessions] disposeAll failed for session ${record.sessionId}`, err);
			}
		}
		if (closed > 0) this.#bump();
	}
}
