/**
 * Fork RPC project-mode multi-session container (rpc-ui-protocol.md).
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
import { logger, normalizePathForComparison } from "@oh-my-pi/pi-utils";
import type { EventBus } from "../../utils/event-bus";
import type { AgentSession } from "../../session/agent-session";
import type { MCPManager } from "../../mcp";
import { invalidateSessionScan, listSessions, type SessionInfo } from "../../session/session-listing";
import { parseSessionContent } from "../../session/session-loader";
import { overlayTitleSlotContent } from "../../session/session-title-slot";
import { FileSessionStorage } from "../../session/session-storage";
import {
	RpcRevisionSource,
	type RpcProjectErrorCode,
	type RpcProjectSessionRunState,
	type RpcProjectSessionSummary,
	type RpcRevision,
} from "./rpc-project-types";

/** Typed failure surfaced by the container; `code` maps to RpcProjectErrorCode (rpc-ui-protocol.md). */
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
	readonly subagentEventBus?: EventBus;
	/** Actual session-owned MCP discovery/lifecycle manager, when MCP is enabled. */
	readonly mcpManager?: MCPManager;
	/** Attach the session host AFTER construction (set via setHost). */
	setHost?(host: RpcProjectSessionHostLike): void;
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
	/** Opaque continuation bound to this project's filtered directory snapshot. */
	readonly cursor?: string;
	/** Page size; default 50, valid range 1..200 (out of range → invalid_params). */
	readonly limit?: number;
	readonly loadState?: "loaded" | "not_loaded";
}

export interface RpcProjectSessionListResult {
	readonly sessions: RpcProjectSessionSummary[];
	readonly revision: RpcRevision;
	readonly nextCursor?: string;
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
	if (host.isWaitingInteraction()) return "waiting_interaction";
	if (host.isStreaming || host.hasPendingAsyncWork()) return "streaming";
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

function listCursor(cursor: string | undefined): { revision: string; filter: string; offset: number } | undefined {
	if (cursor === undefined) return undefined;
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
		if (
			typeof value.revision === "string" &&
			typeof value.filter === "string" &&
			typeof value.offset === "number" &&
			Number.isSafeInteger(value.offset) &&
			value.offset >= 0
		) {
			return { revision: value.revision, filter: value.filter, offset: value.offset };
		}
	} catch {}
	throw new RpcProjectSessionError("invalid_params", "Invalid session directory cursor");
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
	readonly #resuming = new Map<
		string,
		Promise<{ record: RpcProjectSessionRecord; created: RpcProjectCreatedSession }>
	>();
	readonly #revisions = new RpcRevisionSource();
	#generationCounter = 0;
	#disposed = false;
	#catalogKey: string | undefined;

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
		this.#catalogKey = undefined;
		const revision = this.#revisions.bump();
		try {
			this.#options.onChanged?.(revision);
		} catch (err) {
			logger.error("RPC sessions changed listener failed", { error: String(err) });
		}
		return revision;
	}
	notifyChanged(): void {
		this.#bump();
	}

	#resourceRevision(sessionId: string, file: string | undefined): RpcRevision {
		const stat = file && this.#storage.existsSync(file) ? this.#storage.statSync(file) : undefined;
		return `session-${Bun.hash(JSON.stringify([sessionId, stat?.size, stat?.mtimeMs, stat?.ctimeMs])).toString(36)}`;
	}

	#assertResourceRevision(sessionId: string, file: string | undefined, expected: RpcRevision | undefined): void {
		if (expected !== undefined && this.#resourceRevision(sessionId, file) !== expected) {
			throw new RpcProjectSessionError("revision_conflict", `Session ${sessionId} changed; read it again`);
		}
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
				attach?.call(created, host);
				(record as WritableRecordHost).host = host;
			};
		} catch (err) {
			throw new RpcProjectSessionError("execution_failed", `Failed to attach session host: ${errorText(err)}`);
		}
	}

	async #disposeSessionQuietly(session: AgentSession, context: string): Promise<void> {
		try {
			await session.dispose();
		} catch (err) {
			logger.error("RPC session rollback disposal failed", { context, error: String(err) });
		}
	}

	/** Locate a saved session by stable id in the session directory; throws not_found. */
	async #locateListed(sessionId: string): Promise<SessionInfo> {
		const entries = await listSessions(this.#options.sessionDir, this.#storage);
		const entry = entries.find(candidate => candidate.id === sessionId);
		if (entry && normalizePathForComparison(entry.cwd) !== normalizePathForComparison(this.#options.cwd)) {
			throw new RpcProjectSessionError("scope_not_allowed", `Session ${sessionId} belongs to another project`);
		}
		if (!entry) {
			throw new RpcProjectSessionError("not_found", `Session ${sessionId} not found in ${this.#options.sessionDir}`);
		}
		return entry;
	}

	/** Identity check: a record whose session lost its stable id/cwd is latched "closing" and refuses teardown. */
	#assertStableIdentity(record: RpcProjectSessionRecord): void {
		if (
			record.session.sessionManager.getSessionId() !== record.sessionId ||
			normalizePathForComparison(record.session.sessionManager.getCwd()) !==
				normalizePathForComparison(this.#options.cwd)
		) {
			record.state = "closing";
			this.#bump();
			throw new RpcProjectSessionError(
				"stale_session",
				`Session ${record.sessionId} no longer owns its original identity`,
			);
		}
	}

	/**
	 * Teardown gate: no concurrent double close/delete, and running work
	 * rejects unless cancelled. A record left in "closing" by a FAILED teardown
	 * attempt (idle, not busy) may re-enter close/delete: every release step is
	 * idempotent (`RpcSessionHost.dispose` latches, `session.dispose` retains
	 * shutdown preparation and retries the final close), and this retry
	 * channel is what keeps a cleanup failure from bricking the session with a
	 * permanent busy (rpc-ui-protocol.md).
	 * Only "loading" records and in-flight (`busy`) teardowns are refused here;
	 * identity-latched "closing" records still throw at {@link #assertStableIdentity}.
	 */
	#assertTeardownAllowed(record: RpcProjectSessionRecord, cancelRunning: boolean): void {
		this.#assertStableIdentity(record);
		if (record.state === "loading") {
			throw new RpcProjectSessionError("busy", `Session ${record.sessionId} is ${record.state}`);
		}
		if (record.busy) {
			throw new RpcProjectSessionError(
				"busy",
				`A close or delete is already in progress for session ${record.sessionId}`,
			);
		}
		const host = record.host;
		if (!cancelRunning && host && (host.isStreaming || host.hasPendingAsyncWork() || host.isWaitingInteraction())) {
			const running = host.isWaitingInteraction()
				? "waiting for interaction"
				: host.isStreaming
					? "streaming"
					: "finishing pending async work";
			throw new RpcProjectSessionError(
				"busy",
				`Session ${record.sessionId} is ${running}; retry with cancelRunning`,
			);
		}
	}

	/**
	 * Release all resources even when one cleanup step fails; never report a failed close as unloaded.
	 * A failed attempt leaves the record idle in "closing" (the truthful remaining
	 * state) so close/delete can retry the teardown instead of dead-ending on busy.
	 */
	async #closeRecord(
		record: RpcProjectSessionRecord,
		options: { cancelRunning: boolean; reason: string; force?: boolean },
	): Promise<void> {
		if (!options.force) this.#assertStableIdentity(record);
		record.busy = true;
		record.state = "closing";
		const errors: unknown[] = [];
		const release = async (operation: () => Promise<void> | void): Promise<void> => {
			try {
				await operation();
				if (!options.force) this.#assertStableIdentity(record);
			} catch (error) {
				errors.push(error);
			}
		};
		try {
			// Fail host waits before abort: the active turn can be waiting for them.
			await release(() => record.host?.dispose(options.reason));
			if (options.cancelRunning) await release(() => record.session.abort());
			await release(() => record.session.dispose());
		} finally {
			record.busy = false;
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, `Session ${record.sessionId} cleanup failed`);
		this.#records.delete(record.sessionId);
	}

	/**
	 * Create a new session in this project: factory-built instance, persisted
	 * immediately (`ensureOnDisk`), optionally named. `model` is intentionally
	 * not applied here — model selection is the caller's business.
	 */
	async create(options: RpcProjectSessionCreateOptions = {}): Promise<RpcProjectSessionRecord> {
		if (options.name !== undefined && !options.name.trim()) {
			throw new RpcProjectSessionError("invalid_params", "Session name cannot be empty");
		}
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
		if (this.#disposed) {
			await created.session.dispose();
			throw new RpcProjectSessionError("busy", "Project is disposing");
		}
		if (options.name !== undefined && !options.name.trim()) {
			await created.session.dispose();
			throw new RpcProjectSessionError("invalid_params", "Session name cannot be empty");
		}
		created.session.sessionManager.requireStableSessionIdentity();
		const record: RpcProjectSessionRecord = {
			sessionId: created.session.sessionId,
			sessionGeneration: this.#nextGeneration(),
			session: created.session,
			createdAt: new Date().toISOString(),
			state: "loading",
		};
		if (this.#records.has(record.sessionId)) {
			if (this.#records.get(record.sessionId)?.session !== created.session) {
				await this.#disposeSessionQuietly(created.session, "duplicate create rollback");
			}
			throw new RpcProjectSessionError("stale_session", `Session ${record.sessionId} is already loaded`);
		}
		this.#records.set(record.sessionId, record);
		try {
			this.#wireHostAttachment(created, record);
			try {
				await created.session.sessionManager.ensureOnDisk();
			} catch (err) {
				throw new RpcProjectSessionError("persistence_failed", `Failed to persist new session: ${errorText(err)}`);
			}
			this.#assertStableIdentity(record);
			if (options.name !== undefined) {
				const applied = await created.session.setSessionName(options.name, "user");
				if (!applied) {
					throw new RpcProjectSessionError("invalid_params", "Session name cannot be empty");
				}
			}
			this.#assertStableIdentity(record);
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
	 * to attach the session host. Concurrent callers share the same created handle.
	 */
	async resumeWithFactory(
		sessionId: string,
		factory: () => Promise<RpcProjectCreatedSession>,
	): Promise<{ record: RpcProjectSessionRecord; created?: RpcProjectCreatedSession }> {
		const pending = this.#resuming.get(sessionId);
		if (pending) return pending;
		const existing = this.#records.get(sessionId);
		if (existing) {
			if (existing.state !== "loaded" || existing.busy)
				throw new RpcProjectSessionError("busy", "Session lifecycle transition is in progress");
			this.#assertStableIdentity(existing);
			return { record: existing };
		}
		if (this.#disposed) throw new RpcProjectSessionError("busy", "Project is disposing");
		const load = this.#resumeOnce(sessionId, factory);
		this.#resuming.set(sessionId, load);
		try {
			return await load;
		} finally {
			this.#resuming.delete(sessionId);
		}
	}

	async #resumeOnce(
		sessionId: string,
		factory: () => Promise<RpcProjectCreatedSession>,
	): Promise<{ record: RpcProjectSessionRecord; created: RpcProjectCreatedSession }> {
		const entry = await this.#locateListed(sessionId);
		const created = await factory();
		created.session.sessionManager.requireStableSessionIdentity();
		if (this.#disposed) {
			await created.session.dispose();
			throw new RpcProjectSessionError("busy", "Project is disposing");
		}
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
		try {
			this.#wireHostAttachment(created, record);
			const alreadyLoaded =
				created.session.sessionId === sessionId &&
				created.session.sessionFile !== undefined &&
				normalizePathForComparison(created.session.sessionFile) === normalizePathForComparison(entry.path);
			const switched = alreadyLoaded || (await created.session.switchSession(entry.path));
			if (!switched) {
				throw new RpcProjectSessionError("execution_failed", `Resume of session ${sessionId} was cancelled`);
			}
			created.session.sessionManager.requireStableSessionIdentity();
			this.#assertStableIdentity(record);
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
		return { record, created };
	}

	/**
	 * Merged directory view: saved sessions from disk (not_loaded) overlaid
	 * with in-memory records (live loadState/runState/generation), deduped by
	 * session id (in-memory wins), sorted newest-modified first, then
	 * offset-paginated with a numeric cursor.
	 */
	async list(options: RpcProjectSessionListOptions = {}): Promise<RpcProjectSessionListResult> {
		const limit = normalizeListLimit(options.limit);
		const cursor = listCursor(options.cursor);
		const filter = `${normalizePathForComparison(this.#options.cwd)}:${options.loadState ?? "all"}`;
		let revision = this.revision;
		const listed = (await listSessions(this.#options.sessionDir, this.#storage)).filter(
			entry => entry.cwd && normalizePathForComparison(entry.cwd) === normalizePathForComparison(this.#options.cwd),
		);
		const byId = new Map<string, RpcProjectSessionSummary>();
		for (const entry of listed)
			byId.set(entry.id, summaryFromListed(entry, this.#resourceRevision(entry.id, entry.path)));
		for (const record of this.#records.values()) {
			const base = byId.get(record.sessionId);
			byId.set(
				record.sessionId,
				base
					? mergeListedWithRecord(
							base,
							record,
							this.#resourceRevision(record.sessionId, record.session.sessionFile),
						)
					: this.buildSummary(record),
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
		const catalogKey = JSON.stringify(sessions);
		if (this.#catalogKey !== undefined && this.#catalogKey !== catalogKey) revision = this.#bump();
		this.#catalogKey = catalogKey;
		const snapshotRevision = `sessions-${Bun.hash(catalogKey).toString(36)}`;
		if (cursor && (cursor.revision !== snapshotRevision || cursor.filter !== filter)) {
			throw new RpcProjectSessionError("stale_cursor", "Session directory changed; start a new page");
		}
		const offset = cursor?.offset ?? 0;
		const page = sessions.slice(offset, offset + limit);
		const nextOffset = offset + page.length;
		return {
			sessions: page,
			revision,
			...(nextOffset < sessions.length
				? {
						nextCursor: Buffer.from(
							JSON.stringify({ revision: snapshotRevision, filter, offset: nextOffset }),
						).toString("base64url"),
					}
				: {}),
		};
	}

	/** Record by session id, any state; undefined when unknown. */
	get(sessionId: string): RpcProjectSessionRecord | undefined {
		return this.#records.get(sessionId);
	}

	/** Directory summary of a hosted record at the current revision. */
	buildSummary(record: RpcProjectSessionRecord): RpcProjectSessionSummary {
		this.#assertStableIdentity(record);
		return buildSessionSummary(record, this.#resourceRevision(record.sessionId, record.session.sessionFile));
	}

	/** Every hosted record (any state), snapshot copy. */
	listRecords(): readonly RpcProjectSessionRecord[] {
		return Array.from(this.#records.values());
	}

	/** Session file for a stable id: live record first, then a directory scan; undefined when unknown. */
	async findSessionFileById(sessionId: string): Promise<string | undefined> {
		const loaded = this.#records.get(sessionId);
		if (
			loaded?.session.sessionFile &&
			loaded.session.sessionManager.getSessionId() === sessionId &&
			normalizePathForComparison(loaded.session.sessionManager.getCwd()) ===
				normalizePathForComparison(this.#options.cwd)
		)
			return loaded.session.sessionFile;
		try {
			return (await this.#locateListed(sessionId)).path;
		} catch (error) {
			if (error instanceof RpcProjectSessionError && error.code === "not_found") return undefined;
			throw error;
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
	 * with busy unless `cancelRunning`; a concurrent double close rejects with
	 * busy, while a close whose cleanup FAILED keeps the record retryable (it
	 * stays "closing" until a retry finishes the teardown). On success the
	 * record is gone and the revision has bumped.
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

	/** Rename one resource with a per-session revision, without loading saved history. */
	async rename(
		sessionId: string,
		name: string,
		expectedRevision?: RpcRevision,
	): Promise<RpcProjectSessionRenameResult> {
		const trimmed = typeof name === "string" ? name.trim() : "";
		if (!trimmed) {
			throw new RpcProjectSessionError("invalid_params", "Session name cannot be empty");
		}
		const targetFile = await this.findSessionFileById(sessionId);
		if (!targetFile) throw new RpcProjectSessionError("not_found", `Session ${sessionId} not found`);
		this.#assertResourceRevision(sessionId, targetFile, expectedRevision);
		const record = this.#records.get(sessionId);
		if (record && (record.state !== "loaded" || record.busy))
			throw new RpcProjectSessionError("busy", "Session lifecycle transition is in progress");
		if (record) {
			this.#assertStableIdentity(record);
			record.busy = true;
			let applied: boolean;
			try {
				applied = await record.session.setSessionName(trimmed, "user");
				this.#assertStableIdentity(record);
			} finally {
				record.busy = false;
			}
			if (!applied) {
				throw new RpcProjectSessionError("invalid_params", "Session name cannot be empty");
			}
			const revision = this.#bump();
			return { summary: this.buildSummary(record), revision };
		}
		const entry = await this.#locateListed(sessionId);
		const observedRevision = this.#resourceRevision(sessionId, entry.path);
		this.#assertResourceRevision(sessionId, entry.path, expectedRevision);
		const content = await this.#storage.readText(entry.path);
		this.#assertResourceRevision(sessionId, entry.path, observedRevision);
		const header = parseSessionContent(content).entries.find(entry => entry.type === "session");
		if (
			header?.type !== "session" ||
			header.id !== sessionId ||
			normalizePathForComparison(header.cwd) !== normalizePathForComparison(this.#options.cwd)
		) {
			throw new RpcProjectSessionError("scope_not_allowed", "Session identity/project changed during rename");
		}
		let committed = true;
		await this.#storage.writeTextAtomic(
			entry.path,
			overlayTitleSlotContent(content, {
				title: trimmed,
				source: "user",
				updatedAt: new Date().toISOString(),
			}),
			{
				expectedSize: Buffer.byteLength(content, "utf8"),
				commitGuard: () => {
					committed =
						this.#resourceRevision(sessionId, entry.path) === observedRevision &&
						this.#storage.readTextSync(entry.path) === content;
					return committed;
				},
			},
		);
		if (!committed)
			throw new RpcProjectSessionError("revision_conflict", `Session ${sessionId} changed during rename`);
		// The title slot keeps the file size unchanged and a temp-file rename can
		// carry the same coarse filesystem timestamp as the pre-rename scan, so
		// the listing cache would keep serving the pre-rename summary.
		invalidateSessionScan(entry.path, this.#storage);
		const revision = this.#bump();
		const updated = await this.#locateListed(sessionId);
		return { summary: summaryFromListed(updated, this.#resourceRevision(sessionId, updated.path)), revision };
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
		const targetFile = await this.findSessionFileById(sessionId);
		if (!targetFile) throw new RpcProjectSessionError("not_found", `Session ${sessionId} not found`);
		this.#assertResourceRevision(sessionId, targetFile, options.expectedRevision);
		const authorizedRevision = this.#resourceRevision(sessionId, targetFile);
		const record = this.#records.get(sessionId);
		if (record) {
			this.#assertTeardownAllowed(record, options.cancelRunning === true);
			await this.close(sessionId, { cancelRunning: options.cancelRunning === true });
			await this.#deletePersisted(sessionId, targetFile);
			return { revision: this.#bump() };
		}
		await this.#deletePersisted(sessionId, targetFile, authorizedRevision);
		return { revision: this.#bump() };
	}

	async #deletePersisted(sessionId: string, target: string, authorizedRevision?: RpcRevision): Promise<void> {
		const remove = this.#storage.deleteSessionWithArtifactsIf;
		if (!remove) throw new RpcProjectSessionError("unsupported", "Storage does not support guarded session deletion");
		const revision = authorizedRevision ?? this.#resourceRevision(sessionId, target);
		const deleted = await remove.call(this.#storage, target, content => {
			const header = parseSessionContent(content).entries.find(entry => entry.type === "session");
			return (
				header?.type === "session" &&
				header.id === sessionId &&
				normalizePathForComparison(header.cwd) === normalizePathForComparison(this.#options.cwd) &&
				this.#resourceRevision(sessionId, target) === revision
			);
		});
		if (!deleted)
			throw new RpcProjectSessionError("revision_conflict", `Session ${sessionId} changed before deletion`);
	}

	/** Best-effort shutdown: close every hosted record with cancellation, swallowing individual failures. */
	async disposeAll(reason: string): Promise<void> {
		this.#disposed = true;
		await Promise.allSettled(this.#resuming.values());
		let closed = 0;
		for (const record of Array.from(this.#records.values())) {
			try {
				await this.#closeRecord(record, { cancelRunning: true, reason, force: true });
				closed++;
			} catch (err) {
				logger.error("RPC project session disposal failed", { sessionId: record.sessionId, error: String(err) });
			}
		}
		if (closed > 0) this.#bump();
	}
}
