/**
 * Saved-session directory operations for the fork RPC surface
 * (rpc-ui-protocol.md): `list_sessions`, `rename_session`, and
 * `delete_session` over the same per-cwd session directory the TUI picker
 * reads. Each OMP process hosts exactly one live session; the session it
 * hosts renames through the live session API, every other saved session
 * through guarded file surgery on its storage. Deletion of the hosted
 * session itself is refused — the client closes that session's process
 * first.
 */
import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { invalidateSessionScan, listSessions, type SessionInfo } from "../../session/session-listing";
import { parseSessionContent } from "../../session/session-loader";
import { overlayTitleSlotContent } from "../../session/session-title-slot";
import { FileSessionStorage, type SessionStorage } from "../../session/session-storage";
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
	return value ? value.toISOString() : undefined;
}

function revisionFor(storage: SessionStorage, sessionId: string, file: string | undefined): RpcRevision {
	const stat = file && storage.existsSync(file) ? storage.statSync(file) : undefined;
	return `session-${Bun.hash(JSON.stringify([sessionId, stat?.size, stat?.mtimeMs, stat?.ctimeMs])).toString(36)}`;
}

function summaryFromListed(entry: SessionInfo, revision: RpcRevision, current: boolean): RpcSessionSummary {
	return {
		sessionId: entry.id,
		...(entry.title ? { name: entry.title } : {}),
		sessionFile: entry.path,
		current,
		createdAt: isoOrUndefined(entry.created),
		modifiedAt: isoOrUndefined(entry.modified),
		messageCount: entry.messageCount,
		revision,
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
		const current = this.#currentSession();
		const currentId = current?.sessionManager.getSessionId();
		const entries = (await listSessions(this.#sessionDir, this.#storage)).filter(
			entry => normalizePathForComparison(entry.cwd) === normalizePathForComparison(this.#cwd),
		);
		return entries.map(entry =>
			summaryFromListed(entry, revisionFor(this.#storage, entry.id, entry.path), entry.id === currentId),
		);
	}

	/**
	 * Rename one saved session. The hosted session renames through its live
	 * session API (persisted by the session itself); every other entry through
	 * a guarded title-slot rewrite that refuses when the file changed since
	 * the client read it (`expectedRevision`).
	 */
	async rename(sessionId: string, name: string, expectedRevision?: RpcRevision): Promise<RpcSessionSummary> {
		const trimmed = name.trim();
		if (!trimmed) throw new RpcSessionDirectoryError("invalid_params", "Session name cannot be empty");

		const current = this.#currentSession();
		if (current && current.sessionManager.getSessionId() === sessionId) {
			if (current.isStreaming) {
				throw new RpcSessionDirectoryError("execution_failed", "Session is streaming; retry after the turn ends");
			}
			const applied = await current.setSessionName(trimmed, "user");
			if (!applied) throw new RpcSessionDirectoryError("invalid_params", "Session name cannot be empty");
			return this.#summaryFor(sessionId, true);
		}

		const entry = await this.#locateListed(sessionId);
		const observedRevision = revisionFor(this.#storage, sessionId, entry.path);
		this.#assertRevision(sessionId, entry.path, expectedRevision);
		const content = await this.#storage.readText(entry.path);
		this.#assertRevision(sessionId, entry.path, observedRevision);
		const header = parseSessionContent(content).entries.find(candidate => candidate.type === "session");
		if (
			header?.type !== "session" ||
			header.id !== sessionId ||
			normalizePathForComparison(header.cwd) !== normalizePathForComparison(this.#cwd)
		) {
			throw new RpcSessionDirectoryError("scope_not_allowed", "Session identity/project changed during rename");
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
				expectedSize: Buffer.byteLength(content, "utf-8"),
				commitGuard: () => {
					committed =
						revisionFor(this.#storage, sessionId, entry.path) === observedRevision &&
						this.#storage.readTextSync !== undefined &&
						this.#storage.readTextSync(entry.path) === content;
					return committed;
				},
			},
		);
		if (!committed) {
			throw new RpcSessionDirectoryError("revision_conflict", `Session ${sessionId} changed during rename`);
		}
		// The title slot keeps the file size unchanged and a temp-file rename can
		// carry the same coarse filesystem timestamp as the pre-rename scan, so
		// the listing cache would keep serving the pre-rename summary.
		invalidateSessionScan(entry.path, this.#storage);
		return this.#summaryFor(sessionId, false);
	}

	/**
	 * Delete one saved session with its artifacts. The session this process
	 * hosts must be closed (its process ended) first; deletion of every other
	 * saved entry is guarded by `expectedRevision` and re-checks the file
	 * identity at commit time.
	 */
	async delete(sessionId: string, expectedRevision?: RpcRevision): Promise<void> {
		const current = this.#currentSession();
		if (current && current.sessionManager.getSessionId() === sessionId) {
			throw new RpcSessionDirectoryError(
				"unsupported",
				"Close the session's process before deleting it (end the RPC connection, then delete)",
			);
		}
		const entry = await this.#locateListed(sessionId);
		this.#assertRevision(sessionId, entry.path, expectedRevision);
		const authorizedRevision = revisionFor(this.#storage, sessionId, entry.path);
		const remove = this.#storage.deleteSessionWithArtifactsIf;
		if (!remove) {
			throw new RpcSessionDirectoryError("unsupported", "Storage does not support guarded session deletion");
		}
		const deleted = await remove.call(this.#storage, entry.path, content => {
			const header = parseSessionContent(content).entries.find(candidate => candidate.type === "session");
			return (
				header?.type === "session" &&
				header.id === sessionId &&
				normalizePathForComparison(header.cwd) === normalizePathForComparison(this.#cwd) &&
				revisionFor(this.#storage, sessionId, entry.path) === authorizedRevision
			);
		});
		if (!deleted) {
			throw new RpcSessionDirectoryError("revision_conflict", `Session ${sessionId} changed before deletion`);
		}
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
		const entry = (await listSessions(this.#sessionDir, this.#storage)).find(candidate => candidate.id === sessionId);
		if (!entry) {
			throw new RpcSessionDirectoryError("not_found", `Session ${sessionId} not found in ${this.#sessionDir}`);
		}
		if (normalizePathForComparison(entry.cwd) !== normalizePathForComparison(this.#cwd)) {
			throw new RpcSessionDirectoryError("scope_not_allowed", `Session ${sessionId} belongs to another project`);
		}
		return entry;
	}

	async #summaryFor(sessionId: string, current: boolean): Promise<RpcSessionSummary> {
		const entry = await this.#locateListed(sessionId);
		return summaryFromListed(entry, revisionFor(this.#storage, sessionId, entry.path), current);
	}

	#assertRevision(sessionId: string, file: string | undefined, expected: RpcRevision | undefined): void {
		if (expected !== undefined && revisionFor(this.#storage, sessionId, file) !== expected) {
			throw new RpcSessionDirectoryError("revision_conflict", `Session ${sessionId} changed; read it again`);
		}
	}
}
