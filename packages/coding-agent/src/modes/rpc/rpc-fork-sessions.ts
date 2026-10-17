/**
 * Saved-session directory operations for the fork RPC surface
 * (rpc-ui-protocol.md): `list_sessions`, `rename_session`, and
 * `delete_session` over the same per-cwd session directory the TUI picker
 * reads. Each OMP process hosts exactly one live session; the session it
 * hosts renames through the live session API, every other saved session
 * through guarded file surgery while holding its ownership lease. Sessions
 * hosted by another process cannot be renamed or deleted; deletion of this
 * process's hosted session is also refused until its process closes.
 */
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import type { FileLockHandle } from "@oh-my-pi/pi-utils/file-lock";
import { logger, normalizePathForComparison } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import {
	invalidateSessionScan,
	listSessions,
	sessionDisplayName,
	type SessionInfo,
} from "../../session/session-listing";
import { parseSessionContent } from "../../session/session-loader";
import { recordSessionTitle } from "../../session/session-index";
import {
	overlayTitleSlotContent,
	parseTitleSlotFromContent,
	serializeTitleSlot,
} from "../../session/session-title-slot";
import {
	FileSessionStorage,
	tryAcquireSessionLease,
	type SessionDeletionDiagnostic,
	type SessionStorage,
	type SessionStorageStat,
} from "../../session/session-storage";
import type { RpcForkErrorCode, RpcRevision, RpcSessionSummary } from "./rpc-fork-types";

/** Typed failure surfaced by the session directory service. */
export class RpcSessionDirectoryError extends Error {
	readonly code: RpcForkErrorCode;

	constructor(code: RpcForkErrorCode, message: string) {
		super(message);
		this.name = "RpcSessionDirectoryError";
		this.code = code;
	}
}

function isoOrUndefined(value: Date | undefined): string | undefined {
	return value && Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
}

function revisionFor(storage: SessionStorage, sessionId: string, file: string | undefined): RpcRevision {
	const stat = file && storage.existsSync(file) ? storage.statSync(file) : undefined;
	return revisionFromSnapshot(sessionId, stat);
}

function revisionFromSnapshot(
	sessionId: string,
	stat: Pick<SessionStorageStat, "size" | "mtimeMs" | "ctimeMs"> | undefined,
): RpcRevision {
	return `session-${Bun.hash(JSON.stringify([sessionId, stat?.size, stat?.mtimeMs, stat?.ctimeMs])).toString(36)}`;
}

function summaryFromListed(entry: SessionInfo, current: boolean): RpcSessionSummary {
	return {
		sessionId: entry.id,
		...(entry.title ? { name: entry.title } : {}),
		sessionFile: entry.path,
		current,
		createdAt: isoOrUndefined(entry.created),
		modifiedAt: isoOrUndefined(entry.modified),
		messageCount: entry.messageCount,
		revision: revisionFromSnapshot(
			entry.id,
			entry.fileSnapshot ?? { size: entry.size, mtimeMs: entry.modified.getTime() },
		),
	};
}

/** Collaborators the directory service needs from the RPC host. */
export interface RpcSessionDirectoryDeps {
	/** Project root the directory is scoped to (the hosted session's cwd). */
	readonly cwd: string;
	/** Per-cwd session directory backing the listing. */
	readonly sessionDir: string;
	/** Storage used for file surgery; defaults to {@link FileSessionStorage}. */
	readonly storage?: SessionStorage;
	/** The one live session this process hosts, when it is persisted. */
	readonly getSession?: () => AgentSession | undefined;
}

interface SessionOperationDiagnostic {
	stage: string;
	committed: boolean | undefined;
	persisted?: boolean;
	session_count?: number;
	deletion?: SessionDeletionDiagnostic;
	partial?: boolean;
	progress: (stage: string, result: "started" | "completed", fields?: Record<string, unknown>) => void;
}

export class RpcSessionDirectoryService {
	readonly #cwd: string;
	readonly #sessionDir: string;
	readonly #storage: SessionStorage;
	readonly #getSession: () => AgentSession | undefined;

	constructor(deps: RpcSessionDirectoryDeps) {
		this.#cwd = deps.cwd;
		this.#sessionDir = deps.sessionDir;
		this.#storage = deps.storage ?? new FileSessionStorage();
		this.#getSession = deps.getSession ?? (() => undefined);
	}

	/** Directory listing scoped to this project, newest first; the hosted session is flagged `current`. */
	async list(): Promise<RpcSessionSummary[]> {
		return this.#diagnose("list", undefined, async diagnostic => {
			const current = this.#currentSession();
			const currentId = current?.sessionManager.getSessionId();
			diagnostic.progress("read", "started");
			const entries = (await listSessions(this.#sessionDir, this.#storage)).filter(
				entry => normalizePathForComparison(entry.cwd) === normalizePathForComparison(this.#cwd),
			);
			diagnostic.progress("read", "completed", { session_count: entries.length });
			diagnostic.progress("revision", "started");
			const summaries = entries.map(entry => summaryFromListed(entry, entry.id === currentId));
			diagnostic.session_count = summaries.length;
			diagnostic.progress("revision", "completed");
			return summaries;
		});
	}

	/**
	 * Rename one saved session. The hosted session renames through its live
	 * session API (persisted by the session itself); every other entry through
	 * a guarded title-slot rewrite that refuses while another process holds
	 * the ownership lease or the file changed since the client read it
	 * (`expectedRevision`).
	 */
	async rename(sessionId: string, name: string, expectedRevision?: RpcRevision): Promise<RpcSessionSummary> {
		return this.#diagnose("rename", sessionId, async diagnostic => {
			const trimmed = name.trim();
			if (!trimmed) throw new RpcSessionDirectoryError("invalid_params", "Session name cannot be empty");

			const current = this.#currentSession();
			if (current && current.sessionManager.getSessionId() === sessionId) {
				if (expectedRevision !== undefined) {
					let sessionFile: string | undefined;
					const sessionManager = current.sessionManager;
					if ("getSessionFile" in sessionManager && typeof sessionManager.getSessionFile === "function") {
						const candidate = sessionManager.getSessionFile();
						if (typeof candidate === "string") sessionFile = candidate;
					}
					diagnostic.progress("read", "started");
					sessionFile ??= (await this.#findListed(sessionId))?.path;
					diagnostic.progress("read", "completed");
					diagnostic.progress("revision", "started");
					this.#assertRevision(sessionId, sessionFile, expectedRevision);
					diagnostic.progress("revision", "completed");
				}
				diagnostic.stage = "live_guard";
				if (current.isStreaming) {
					throw new RpcSessionDirectoryError(
						"execution_failed",
						"Session is streaming; retry after the turn ends",
					);
				}
				// The live API may change memory before its persistence promise settles.
				diagnostic.committed = undefined;
				diagnostic.persisted = undefined;
				diagnostic.progress("save", "started", { current: true });
				const applied = await current.setSessionName(trimmed, "user");
				if (!applied) {
					diagnostic.committed = false;
					diagnostic.persisted = false;
					throw new RpcSessionDirectoryError("invalid_params", "Session name cannot be empty");
				}
				diagnostic.committed = true;
				diagnostic.progress("save", "completed", { current: true });
				// A session that has not flushed to disk yet is absent from the
				// directory; report its in-memory state rather than failing the
				// rename that already succeeded.
				diagnostic.progress("reload", "started");
				const listed = await this.#findListed(sessionId);
				diagnostic.persisted = listed !== undefined;
				if (!listed) {
					const summary = {
						sessionId,
						name: current.sessionManager.getSessionName() ?? trimmed,
						current: true,
						revision: revisionFor(this.#storage, sessionId, undefined),
					};
					diagnostic.progress("reload", "completed", { listed: false });
					return summary;
				}
				const summary = summaryFromListed(listed, true);
				diagnostic.progress("reload", "completed", { listed: true });
				return summary;
			}

			diagnostic.progress("read", "started");
			const entry = await this.#locateListed(sessionId);
			diagnostic.progress("read", "completed");
			diagnostic.progress("revision", "started");
			const observedRevision = revisionFor(this.#storage, sessionId, entry.path);
			this.#assertRevision(sessionId, entry.path, expectedRevision);
			diagnostic.progress("revision", "completed");
			let content: string;
			diagnostic.progress("read", "started");
			try {
				content = await this.#storage.readText(entry.path);
			} catch (error) {
				if (isEnoent(error)) {
					throw new RpcSessionDirectoryError(
						"not_found",
						`Session ${sessionId} was removed from ${this.#sessionDir}`,
					);
				}
				throw error;
			}
			diagnostic.progress("read", "completed");
			diagnostic.progress("revision", "started");
			this.#assertRevision(sessionId, entry.path, observedRevision);
			diagnostic.progress("revision", "completed");
			diagnostic.stage = "identity_guard";
			const header = parseSessionContent(content).entries.find(candidate => candidate.type === "session");
			if (
				header?.type !== "session" ||
				header.id !== sessionId ||
				normalizePathForComparison(header.cwd) !== normalizePathForComparison(this.#cwd)
			) {
				throw new RpcSessionDirectoryError("scope_not_allowed", "Session identity/project changed during rename");
			}
			let lease: FileLockHandle | null;
			const leaseStarted = performance.now();
			diagnostic.progress("lease", "started");
			try {
				lease = tryAcquireSessionLease(sessionId);
			} catch (error) {
				// As for deletion, an unprobeable ownership lease is treated as held.
				logger.warn("RPC session lease probe failed", {
					component: "rpc_sessions",
					event: "session_rename_stage",
					stage: "lease",
					result: "unprobeable",
					committed: false,
					persisted: false,
					commit_status: "not_committed",
					elapsed_ms: performance.now() - leaseStarted,
					...logger.diagnosticError(error),
				});
				lease = null;
			}
			if (!lease) {
				throw new RpcSessionDirectoryError(
					"execution_failed",
					"Session is open in another process; close it there before renaming",
				);
			}
			let committed = true;
			try {
				diagnostic.progress("lease", "completed", { acquired: true });
				// Files written before the title-slot format keep their session header in
				// the first 256 bytes; an in-place slot overlay would destroy it. Mirror
				// SessionManager's own guard (`#hasTitleSlot`): only slot-bearing files
				// take the same-size overlay, legacy bodies are rewritten with the slot
				// prepended so the file only grows and every original byte survives.
				const hasTitleSlot = parseTitleSlotFromContent(content) !== undefined;
				const titleUpdate = {
					title: trimmed,
					source: "user" as const,
					updatedAt: new Date().toISOString(),
				};
				const updatedContent = hasTitleSlot
					? overlayTitleSlotContent(content, titleUpdate)
					: serializeTitleSlot(titleUpdate) + content;
				// Storage does not expose a commit receipt when its promise rejects.
				diagnostic.committed = undefined;
				diagnostic.persisted = undefined;
				diagnostic.progress("atomic_write", "started", { title_slot: hasTitleSlot });
				await this.#storage.writeTextAtomic(entry.path, updatedContent, {
					// The legacy rewrite grows the file by one slot; its safety rests on
					// the revision + full-content guard alone (expectedSize would have to
					// match the post-write size, which the backend cannot pre-state).
					expectedSize: hasTitleSlot ? Buffer.byteLength(content, "utf-8") : undefined,
					commitGuard: () => {
						diagnostic.progress("commit_guard", "started");
						committed =
							revisionFor(this.#storage, sessionId, entry.path) === observedRevision &&
							this.#storage.readTextSync !== undefined &&
							this.#storage.readTextSync(entry.path) === content;
						if (!committed) {
							diagnostic.committed = false;
							diagnostic.persisted = false;
						}
						diagnostic.progress("commit_guard", "completed", { accepted: committed });
						diagnostic.stage = "atomic_write";
						return committed;
					},
				});
			} finally {
				const previousStage = diagnostic.stage;
				diagnostic.progress("lease_release", "started");
				lease.release();
				diagnostic.progress("lease_release", "completed");
				diagnostic.stage = previousStage;
			}
			if (!committed) {
				diagnostic.stage = "commit_guard";
				throw new RpcSessionDirectoryError("revision_conflict", `Session ${sessionId} changed during rename`);
			}
			diagnostic.committed = true;
			diagnostic.persisted = true;
			diagnostic.progress("atomic_write", "completed");
			// The title slot keeps the file size unchanged and a temp-file rename can
			// carry the same coarse filesystem timestamp as the pre-rename scan, so
			// the listing cache would keep serving the pre-rename summary.
			diagnostic.progress("reload", "started");
			invalidateSessionScan(entry.path, this.#storage);
			const summary = await this.#summaryFor(sessionId, false);
			if (this.#storage instanceof FileSessionStorage) {
				recordSessionTitle(sessionId, sessionDisplayName({ ...entry, title: summary.name }));
			}
			diagnostic.progress("reload", "completed");
			return summary;
		});
	}

	/**
	 * Delete one saved session with its artifacts. The session this process
	 * hosts must be closed (its process ended) first; a session hosted by
	 * another process is refused through its ownership lease (held from
	 * `claimSession` until that process exits — deleting under it would strand
	 * the writer on POSIX or fail lockless on Windows). Every deletion is
	 * guarded by `expectedRevision` and re-checks the file identity at commit
	 * time.
	 */
	async delete(sessionId: string, expectedRevision?: RpcRevision): Promise<void> {
		return this.#diagnose("delete", sessionId, async diagnostic => {
			const current = this.#currentSession();
			diagnostic.stage = "current_guard";
			if (current && current.sessionManager.getSessionId() === sessionId) {
				throw new RpcSessionDirectoryError(
					"unsupported",
					"Close the session's process before deleting it (end the RPC connection, then delete)",
				);
			}
			diagnostic.progress("read", "started");
			const entry = await this.#locateListed(sessionId);
			diagnostic.progress("read", "completed");
			diagnostic.progress("revision", "started");
			this.#assertRevision(sessionId, entry.path, expectedRevision);
			// Keep the caller's authorized revision even if another writer changes the file after the check.
			const authorizedRevision = expectedRevision ?? revisionFor(this.#storage, sessionId, entry.path);
			diagnostic.progress("revision", "completed");
			diagnostic.stage = "storage_guard";
			const remove = this.#storage.deleteSessionWithArtifactsIf;
			if (!remove) {
				throw new RpcSessionDirectoryError("unsupported", "Storage does not support guarded session deletion");
			}
			let lease: FileLockHandle | null;
			const leaseStarted = performance.now();
			diagnostic.progress("lease", "started");
			try {
				lease = tryAcquireSessionLease(sessionId);
			} catch (error) {
				// An unprobeable lease is treated as held, mirroring claimSession's
				// conservative liveness reading.
				logger.warn("RPC session lease probe failed", {
					component: "rpc_sessions",
					event: "session_delete_stage",
					stage: "lease",
					result: "unprobeable",
					committed: false,
					persisted: false,
					commit_status: "not_committed",
					elapsed_ms: performance.now() - leaseStarted,
					...logger.diagnosticError(error),
				});
				lease = null;
			}
			if (!lease) {
				throw new RpcSessionDirectoryError(
					"unsupported",
					"Session is open in another process; close it there before deleting",
				);
			}
			diagnostic.progress("lease", "completed", { acquired: true });
			let deleted: boolean;
			const deletion: SessionDeletionDiagnostic = {
				stage: "unreported",
				primaryDeleted: false,
				backupFailureCount: 0,
				artifactsRemoved: false,
			};
			// Custom storage may ignore the optional receipt; its commit state
			// remains unknown on failure unless it reports deletion progress.
			diagnostic.committed = undefined;
			diagnostic.persisted = undefined;
			diagnostic.progress("primary_delete", "started");
			try {
				deleted = await remove.call(
					this.#storage,
					entry.path,
					content => {
						diagnostic.progress("commit_guard", "started");
						const header = parseSessionContent(content).entries.find(candidate => candidate.type === "session");
						const accepted =
							header?.type === "session" &&
							header.id === sessionId &&
							normalizePathForComparison(header.cwd) === normalizePathForComparison(this.#cwd) &&
							revisionFor(this.#storage, sessionId, entry.path) === authorizedRevision;
						if (!accepted) {
							diagnostic.committed = false;
							diagnostic.persisted = false;
						}
						diagnostic.progress("commit_guard", "completed", { accepted });
						diagnostic.stage = "primary_delete";
						return accepted;
					},
					deletion,
				);
				diagnostic.committed = deleted;
				diagnostic.persisted = deleted;
				diagnostic.progress("delete", "completed", { deleted });
			} catch (error) {
				if (isEnoent(error)) {
					throw new RpcSessionDirectoryError(
						"not_found",
						`Session ${sessionId} was removed from ${this.#sessionDir}`,
					);
				}
				throw error;
			} finally {
				// The initial receipt is not evidence: legacy/custom storage can
				// return true without updating it. Never infer cleanup from that.
				if (deletion.stage !== "unreported") {
					diagnostic.deletion = deletion;
					diagnostic.stage = deletion.stage;
					diagnostic.committed = deletion.primaryDeleted;
					diagnostic.persisted = deletion.primaryDeleted;
					diagnostic.partial =
						deletion.primaryDeleted && (deletion.backupFailureCount > 0 || !deletion.artifactsRemoved);
				}
				// Keep the original failure stage unless releasing the lease itself fails.
				const previousStage = diagnostic.stage;
				diagnostic.progress("lease_release", "started");
				lease.release();
				diagnostic.progress("lease_release", "completed");
				diagnostic.stage = previousStage;
			}
			if (!deleted) {
				diagnostic.stage = "commit_guard";
				throw new RpcSessionDirectoryError("revision_conflict", `Session ${sessionId} changed before deletion`);
			}
		});
	}

	async #diagnose<T>(
		operation: "list" | "rename" | "delete",
		sessionId: string | undefined,
		run: (diagnostic: SessionOperationDiagnostic) => Promise<T>,
	): Promise<T> {
		return logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `rpc-session-${crypto.randomUUID()}`,
				...(typeof sessionId === "string"
					? {
							session_id: /^[\w.:-]{1,128}$/.test(sessionId)
								? sessionId
								: `hash-${Bun.hash(sessionId).toString(36)}`,
						}
					: {}),
			},
			async () => {
				const started = performance.now();
				const diagnostic: SessionOperationDiagnostic = {
					stage: "validate",
					committed: false,
					persisted: operation === "list" ? undefined : false,
					progress: (stage, result, fields) => {
						diagnostic.stage = stage;
						logger.info("RPC session operation stage", {
							...fields,
							component: "rpc_sessions",
							event: `session_${operation}_stage`,
							stage,
							result,
							committed: diagnostic.committed,
							commit_status:
								diagnostic.committed === undefined
									? "unknown"
									: diagnostic.committed
										? "committed"
										: "not_committed",
							persisted: diagnostic.persisted,
							elapsed_ms: performance.now() - started,
						});
					},
				};
				logger.info("RPC session operation started", {
					component: "rpc_sessions",
					event: `session_${operation}`,
					stage: diagnostic.stage,
					result: "started",
					committed: false,
					commit_status: "not_committed",
					persisted: diagnostic.persisted,
					elapsed_ms: 0,
				});
				try {
					const value = await run(diagnostic);
					const fields = {
						component: "rpc_sessions",
						event: `session_${operation}`,
						stage: diagnostic.stage,
						result: diagnostic.partial ? "partial" : "completed",
						committed: diagnostic.committed,
						commit_status:
							diagnostic.committed === undefined
								? "unknown"
								: diagnostic.committed
									? "committed"
									: "not_committed",
						persisted: diagnostic.persisted,
						session_count: diagnostic.session_count,
						primary_deleted: diagnostic.deletion?.primaryDeleted,
						backup_failure_count: diagnostic.deletion?.backupFailureCount,
						artifacts_removed: diagnostic.deletion?.artifactsRemoved,
						partial: diagnostic.partial,
						elapsed_ms: performance.now() - started,
					};
					if (diagnostic.partial) logger.warn("RPC session operation partially completed", fields);
					else logger.info("RPC session operation completed", fields);
					return value;
				} catch (error) {
					const expected = error instanceof RpcSessionDirectoryError;
					const fields = {
						component: "rpc_sessions",
						event: `session_${operation}`,
						stage: diagnostic.stage,
						result: expected && diagnostic.committed === false ? "refused" : "failed",
						committed: diagnostic.committed,
						commit_status:
							diagnostic.committed === undefined
								? "unknown"
								: diagnostic.committed
									? "committed"
									: "not_committed",
						persisted: diagnostic.persisted,
						primary_deleted: diagnostic.deletion?.primaryDeleted,
						backup_failure_count: diagnostic.deletion?.backupFailureCount,
						artifacts_removed: diagnostic.deletion?.artifactsRemoved,
						partial: diagnostic.partial,
						elapsed_ms: performance.now() - started,
						...(expected ? { rpc_error_code: error.code } : {}),
						...logger.diagnosticError(error),
					};
					if (expected) logger.info("RPC session operation refused or unavailable", fields);
					else logger.error("RPC session operation failed", fields);
					throw error;
				}
			},
		);
	}

	#currentSession(): AgentSession | undefined {
		const session = this.#getSession();
		if (!session || session.isDisposed) return undefined;
		if (normalizePathForComparison(session.sessionManager.getCwd()) !== normalizePathForComparison(this.#cwd)) {
			return undefined;
		}
		return session;
	}

	/** Locate a saved session by stable id in the session directory; throws not_found. */
	async #locateListed(sessionId: string): Promise<SessionInfo> {
		const entry = await this.#findListed(sessionId);
		if (!entry) {
			throw new RpcSessionDirectoryError("not_found", `Session ${sessionId} not found in ${this.#sessionDir}`);
		}
		return entry;
	}

	/** Like {@link #locateListed} but returns undefined instead of throwing not_found. */
	async #findListed(sessionId: string): Promise<SessionInfo | undefined> {
		const entry = (await listSessions(this.#sessionDir, this.#storage)).find(candidate => candidate.id === sessionId);
		if (!entry) return undefined;
		if (normalizePathForComparison(entry.cwd) !== normalizePathForComparison(this.#cwd)) {
			throw new RpcSessionDirectoryError("scope_not_allowed", `Session ${sessionId} belongs to another project`);
		}
		return entry;
	}

	async #summaryFor(sessionId: string, current: boolean): Promise<RpcSessionSummary> {
		const entry = await this.#locateListed(sessionId);
		return summaryFromListed(entry, current);
	}

	#assertRevision(sessionId: string, file: string | undefined, expected: RpcRevision | undefined): void {
		if (expected !== undefined && revisionFor(this.#storage, sessionId, file) !== expected) {
			throw new RpcSessionDirectoryError("revision_conflict", `Session ${sessionId} changed; read it again`);
		}
	}
}
