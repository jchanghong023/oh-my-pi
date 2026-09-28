/**
 * Fork-extension session listing (requirement 4.2, rpc-ui-protocol.md).
 *
 * Exposes the session enum + task-list operations over RPC: `list_sessions`
 * (workspace or all-workspace scope with offset pagination), pin/unpin via the
 * global pins store, rename (active sessions ride the stock
 * `setSessionName("user")` path, others rewrite the stored title slot), and
 * delete with artifacts (refusing the active session). All storage flows
 * through the existing `session-listing` / `session-pins` /
 * `session-storage` modules; `sessions_changed` is a best-effort nudge emitted
 * after fork-side mutations.
 */
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { listAllSessions, listSessions, type SessionInfo } from "../../session/session-listing";
import { loadPinnedSessionIds, toggleSessionPin } from "../../session/session-pins";
import { FileSessionStorage } from "../../session/session-storage";
import type { AgentSession } from "../../session/agent-session";
import type { RpcForkHost } from "./rpc-fork-host";
import type { RpcForkCommandBase } from "./rpc-fork-types";
import type { RpcResponse } from "./rpc-types";

/** Server → client: list contents may have changed; clients re-pull (best effort). */
export interface RpcForkSessionsChangedFrame {
	type: "sessions_changed";
}

export interface RpcForkSessionSummary {
	sessionId: string;
	sessionFile: string;
	title?: string;
	cwd: string;
	created: string;
	modified: string;
	messageCount: number;
	assistantTurns?: number;
	status?: SessionInfo["status"];
	pinned: boolean;
}

export interface RpcForkSessionList {
	sessions: RpcForkSessionSummary[];
	nextCursor?: string;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const MAX_CURSOR_CHARS = 256;

interface ListCursor {
	version: 1;
	offset: number;
}

function encodeListCursor(cursor: ListCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64url");
}

function decodeListCursor(value: string | undefined): ListCursor {
	if (value === undefined || value === "") return { version: 1, offset: 0 };
	if (value.length > MAX_CURSOR_CHARS) throw new Error("RPC session list cursor is stale or invalid");
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf-8"));
	} catch {
		throw new Error("RPC session list cursor is stale or invalid");
	}
	if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.offset !== "number" || parsed.offset < 0) {
		throw new Error("RPC session list cursor is stale or invalid");
	}
	return { version: 1, offset: parsed.offset };
}

function toSummary(info: SessionInfo, pinned: ReadonlySet<string>): RpcForkSessionSummary {
	return {
		sessionId: info.id,
		sessionFile: info.path,
		...(info.title ? { title: info.title } : {}),
		cwd: info.cwd,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
		...(info.assistantTurns !== undefined ? { assistantTurns: info.assistantTurns } : {}),
		...(info.status ? { status: info.status } : {}),
		pinned: pinned.has(info.id),
	};
}

function withError(code: string, message: string): Error {
	const error = new Error(message);
	(error as Error & { code?: string }).code = code;
	return error;
}

export class RpcForkSessionController {
	readonly #storage = new FileSessionStorage();
	readonly #agentDir: string | undefined;

	constructor(
		private readonly host: RpcForkHost,
		private readonly session: AgentSession,
		options?: { agentDir?: string },
	) {
		this.#agentDir = options?.agentDir;
		host.registerCommand("list_sessions", command => this.#listSessions(command));
		host.registerCommand("pin_session", command => this.#setPinned(command, true));
		host.registerCommand("unpin_session", command => this.#setPinned(command, false));
		host.registerCommand("rename_session", command => this.#renameSession(command));
		host.registerCommand("delete_session", command => this.#deleteSession(command));
	}

	/** Bypass-frame nudge: re-pull the session list. */
	emitSessionsChanged(): void {
		this.host.context.emit({ type: "sessions_changed" } satisfies RpcForkSessionsChangedFrame);
	}

	async #listSessions(command: RpcForkCommandBase): Promise<RpcResponse> {
		const {
			scope,
			cursor: rawCursor,
			limit,
		} = command as {
			scope?: unknown;
			cursor?: unknown;
			limit?: unknown;
		};
		if (scope !== "cwd" && scope !== "all") {
			return this.host.context.error(command.id, "list_sessions", `Invalid scope: ${String(scope)}`);
		}
		const cappedLimit = Math.min(
			Math.max(limit === undefined ? DEFAULT_LIST_LIMIT : Number(limit), 1),
			MAX_LIST_LIMIT,
		);
		let infos: SessionInfo[];
		if (scope === "all") {
			infos = await listAllSessions(this.#storage);
		} else {
			const sessionFile = this.session.sessionFile;
			if (!sessionFile) {
				return this.host.context.error(command.id, "list_sessions", "cwd scope requires session persistence");
			}
			infos = await listSessions(path.dirname(sessionFile), this.#storage);
		}
		const pinned = await loadPinnedSessionIds(this.#agentDir);
		const offset = decodeListCursor(typeof rawCursor === "string" ? rawCursor : undefined).offset;
		const page = infos.slice(offset, offset + cappedLimit);
		const nextOffset = offset + page.length;
		const data: RpcForkSessionList = {
			sessions: page.map(info => toSummary(info, pinned)),
			...(nextOffset < infos.length ? { nextCursor: encodeListCursor({ version: 1, offset: nextOffset }) } : {}),
		};
		return this.host.context.success(command.id, "list_sessions", data);
	}

	async #setPinned(command: RpcForkCommandBase, pin: boolean): Promise<RpcResponse> {
		const sessionId = (command as { sessionId?: unknown }).sessionId;
		if (typeof sessionId !== "string" || !sessionId) {
			return this.host.context.error(command.id, command.type, "sessionId is required");
		}
		const pinned = await loadPinnedSessionIds(this.#agentDir);
		if (pinned.has(sessionId) !== pin) {
			await toggleSessionPin(sessionId, this.#agentDir);
		}
		return this.host.context.success(command.id, command.type, { pinned: pin });
	}

	async #renameSession(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { sessionFile, name } = command as { sessionFile?: unknown; name?: unknown };
		if (typeof sessionFile !== "string" || !sessionFile) {
			return this.host.context.error(command.id, "rename_session", "sessionFile is required");
		}
		if (typeof name !== "string" || !name.trim()) {
			return this.host.context.error(command.id, "rename_session", "Session name cannot be empty");
		}
		const active = this.session.sessionFile && path.resolve(sessionFile) === path.resolve(this.session.sessionFile);
		if (active) {
			const applied = await this.session.setSessionName(name.trim(), "user");
			if (!applied) {
				return this.host.context.error(command.id, "rename_session", "Session name cannot be empty");
			}
		} else {
			await this.#storage.updateSessionTitle(sessionFile, {
				title: name.trim(),
				source: "user",
				updatedAt: new Date().toISOString(),
			});
		}
		this.emitSessionsChanged();
		return this.host.context.success(command.id, "rename_session");
	}

	async #deleteSession(command: RpcForkCommandBase): Promise<RpcResponse> {
		const sessionFile = (command as { sessionFile?: unknown }).sessionFile;
		if (typeof sessionFile !== "string" || !sessionFile) {
			return this.host.context.error(command.id, "delete_session", "sessionFile is required");
		}
		if (this.session.sessionFile && path.resolve(sessionFile) === path.resolve(this.session.sessionFile)) {
			return this.host.context.error(
				command.id,
				"delete_session",
				"Cannot delete the active session",
				"active_session",
			);
		}
		await this.#storage.deleteSessionWithArtifacts(sessionFile);
		this.emitSessionsChanged();
		return this.host.context.success(command.id, "delete_session");
	}
}
