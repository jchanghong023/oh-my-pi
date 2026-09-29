/**
 * Fork RPC project-mode durable subagent catalog and narrow control entry
 * (requirement R5, rpc-ui-protocol.md §8.2/§14.8).
 *
 * Merges two sources into one per-session directory: live snapshots from the
 * existing RpcSubagentRegistry (owner-scoped by the host bus) and the durable
 * artifacts tree SessionManager keeps beside every session JSONL
 * (`<session>.jsonl` → `<session>/` sibling directory holding each subagent's
 * `<id>.jsonl` transcript and nested `<id>/<id>.<child>.jsonl` trees — the
 * exact layout `registerPersistedSubagentsFromDir` walks). After a restart the
 * catalog is re-derived from disk, never from in-memory RPC maps alone.
 *
 * Listing never reads full transcripts: only a ≤64-record prefix metadata pass
 * plus file-existence facts. `messages` reads bounded byte windows on complete
 * record boundaries only — a record larger than `maxBytes` is reported as
 * `recordTooLarge`, never truncated into corrupt JSON — and transcript paths
 * are resolved exclusively through the live registry or this session's own
 * artifacts tree; callers cannot pass arbitrary paths.
 *
 * `control` reuses existing services only: `stop` goes through the injected
 * cancel hook or the registry-driven abort monitor the task executor already
 * subscribes to (`setStatus(id, "aborted")` → `monitor.requestAbort`), and
 * `send_message` goes through the injected IRC send. No second control logic
 * is created. This file never writes to the protocol channel (stdout).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isAdvisorTranscriptName } from "../../advisor/transcript-recorder";
import { AgentRegistry, getAgentTombstonePath, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries, visitEntriesFromFileStream } from "../../session/session-loader";
import type {
	RpcProjectControlSubagentResult,
	RpcProjectErrorCode,
	RpcProjectGetSubagentsResult,
	RpcProjectSubagentMessagesResult,
	RpcProjectSubagentStatus,
	RpcProjectSubagentSummary,
	RpcRevision,
} from "./rpc-project-types";
import { RpcRevisionSource } from "./rpc-project-types";
import type { RpcSubagentSnapshot } from "./rpc-types";

const JSONL_SUFFIX = ".jsonl";
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_BYTES_CAP = 1024 * 1024;
/** Prefix records inspected per transcript while listing (mirrors persisted-agents). */
const METADATA_MAX_RECORDS = 64;
/** Bounded transcript-metadata concurrency (mirrors registerPersistedSubagents). */
const METADATA_READ_CONCURRENCY = 4;
const OVERSIZED_RECORD_SCAN_STEP = 256 * 1024;
const OVERSIZED_RECORD_SCAN_CAP = 8 * 1024 * 1024;

const RUNNING_ACTIONS: readonly ("send_message" | "stop")[] = ["send_message", "stop"];
const PARKED_ACTIONS: readonly ("send_message" | "stop")[] = ["send_message"];

/** Typed failure surfaced by the catalog; `code` maps to RpcProjectErrorCode (rpc-ui-protocol.md §14.1). */
export class RpcProjectSubagentError extends Error {
	readonly code: RpcProjectErrorCode;

	constructor(code: RpcProjectErrorCode, message: string) {
		super(message);
		this.name = "RpcProjectSubagentError";
		this.code = code;
	}
}

export interface RpcProjectSubagentDirectoryDeps {
	/** Map sessionId → that session's main sessionFile (loaded or persisted). */
	readonly resolveSessionFile: (sessionId: string) => string | undefined;
	/** Live running subagent snapshots (RpcSubagentRegistry.getSubagents() — owner-scoped by the bus). */
	readonly liveSnapshots: (sessionId: string) => readonly RpcSubagentSnapshot[];
	/** Cancel a running subagent (stop action). Implementations abort the run; return false when not stoppable. */
	readonly cancelSubagent?: (sessionId: string, subagentId: string) => Promise<boolean>;
	/** IRC send used by control_subagent send_message. */
	readonly sendIrcMessage?: (message: {
		from: string;
		to: string;
		body: string;
	}) => Promise<{ to: string; outcome: string; error?: string }>;
	/** Project session dir, used to validate registry refs belong to this project before sending. */
	readonly projectSessionDir?: string;
}

export interface RpcProjectSubagentListOptions {
	/** Filter to live rows ("running") or durable rows ("finished"); omitted merges both. */
	readonly status?: "running" | "finished";
	/** Numeric offset into the merged, sorted directory (default 0). */
	readonly cursor?: number;
	/** Page size; default 50, valid range 1..200 (out of range → invalid_params). */
	readonly limit?: number;
}

export interface RpcProjectSubagentMessagesOptions {
	/** Byte offset to resume from (default 0; must land on or before a record boundary the host returned). */
	readonly fromByte?: number;
	/** Read window; default 256 KiB, clamped to 1 MiB (non-positive/non-integer → invalid_params). */
	readonly maxBytes?: number;
}

/**
 * Sibling artifacts directory of a session JSONL file (`<session>.jsonl` →
 * `<session>`), mirroring session-manager's module-private
 * `artifactsDirectoryFor` convention (that helper is not exported).
 */
export function artifactsDirForSessionFile(sessionFile: string): string {
	return sessionFile.endsWith(JSONL_SUFFIX) ? sessionFile.slice(0, -JSONL_SUFFIX.length) : sessionFile;
}

function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function subagentErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Whether `filePath` resolves strictly inside `dir` (separator-aware prefix, not raw text). */
function isInsideDir(filePath: string, dir: string): boolean {
	return path.resolve(filePath).startsWith(`${path.resolve(dir)}${path.sep}`);
}

function normalizeListLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_PAGE_LIMIT;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
		throw new RpcProjectSubagentError("invalid_params", `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
	}
	return limit;
}

function normalizeListCursor(cursor: number | undefined): number {
	if (cursor === undefined) return 0;
	if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
		throw new RpcProjectSubagentError("invalid_params", "cursor must be a non-negative integer offset");
	}
	return cursor;
}

function normalizeFromByte(fromByte: number | undefined): number {
	if (fromByte === undefined) return 0;
	if (typeof fromByte !== "number" || !Number.isInteger(fromByte) || fromByte < 0) {
		throw new RpcProjectSubagentError("invalid_params", "fromByte must be a non-negative integer");
	}
	return fromByte;
}

function normalizeMaxBytes(maxBytes: number | undefined): number {
	if (maxBytes === undefined) return DEFAULT_MAX_BYTES;
	if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1) {
		throw new RpcProjectSubagentError("invalid_params", "maxBytes must be a positive integer");
	}
	return Math.min(maxBytes, MAX_BYTES_CAP);
}

function timestampOf(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** One-line, length-capped task summary for a durable row (best-effort display text). */
function summarizePersistedTask(task: string): string | undefined {
	const withoutPreamble = task.replace(/^Complete the assignment below,\s*thoroughly:\s*/i, "");
	const summary = withoutPreamble.split(/\r?\n/).join(" ").replace(/\s+/g, " ").trim();
	return summary ? summary.slice(0, 1_000) : undefined;
}

/** Prefix-derived facts about one persisted subagent transcript (reads ≤64 records). */
interface DurableSubagentMetadata {
	/** When the transcript's session/session_init record was created, when the head carries a timestamp. */
	readonly createdAt?: number;
	/** Summarized task from session_init, when present. */
	readonly activity?: string;
	/** Bundled agent identity recorded by session_init, when present. */
	readonly agent?: string;
	/** True when the head holds neither session_init nor any conversation record. */
	readonly incomplete: boolean;
	/** False when the transcript head could not be read at all (vanished or unreadable). */
	readonly readable: boolean;
}

/**
 * Read only the small transcript prefix the catalog needs — a private, trimmed
 * mirror of persisted-agents' module-private `readPersistedAgentMetadata`
 * (which is not exported). Filesystem faults degrade to an unreadable row
 * instead of failing the whole directory page.
 */
async function readDurableSubagentMetadata(transcriptPath: string): Promise<DurableSubagentMetadata> {
	let createdAt: number | undefined;
	let activity: string | undefined;
	let agent: string | undefined;
	let hasSessionInit = false;
	let hasConversation = false;
	try {
		await visitEntriesFromFileStream(
			transcriptPath,
			entry => {
				const record = entry as unknown as Record<string, unknown>;
				if (record.type === "session") {
					createdAt ??= timestampOf(record.timestamp);
					return;
				}
				if (record.type === "message" || record.type === "custom_message") {
					hasConversation = true;
					return;
				}
				if (record.type !== "session_init") return;
				hasSessionInit = true;
				createdAt ??= timestampOf(record.timestamp);
				if (typeof record.task === "string") activity = summarizePersistedTask(record.task);
				if (typeof record.agent === "string") agent = record.agent;
				// session_init precedes the conversation — stop the stream here.
				return false;
			},
			{ maxRecords: METADATA_MAX_RECORDS },
		);
	} catch {
		return { incomplete: true, readable: false };
	}
	return {
		...(createdAt !== undefined ? { createdAt } : {}),
		...(activity !== undefined ? { activity } : {}),
		...(agent !== undefined ? { agent } : {}),
		incomplete: !hasSessionInit && !hasConversation,
		readable: true,
	};
}

/** One transcript file discovered in a session's artifacts tree. */
interface SubagentTranscriptRecord {
	/** Durable id: transcript basename minus `.jsonl` (nested children are `<parent>.<child>`). */
	readonly id: string;
	readonly transcriptPath: string;
}

/**
 * Walk a session's artifacts tree for persisted subagent transcripts using the
 * same conventions as `registerPersistedSubagentsFromDir`: every `*.jsonl`
 * directly inside a directory is one agent transcript (id = basename stem),
 * `__advisor*` observability transcripts and `.bak` backups are skipped, and a
 * subdirectory is descended only when it is named after a transcript stem
 * found beside it (nested children live in `<id>/<id>.<child>.jsonl`).
 */
async function scanSubagentTranscripts(dir: string): Promise<SubagentTranscriptRecord[]> {
	const records: SubagentTranscriptRecord[] = [];
	await scanSubagentTranscriptsInto(dir, records);
	return records;
}

async function scanSubagentTranscriptsInto(dir: string, records: SubagentTranscriptRecord[]): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return;
		throw error;
	}
	const childDirectories = new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name));
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(JSONL_SUFFIX) || entry.name.includes(".bak")) continue;
		if (isAdvisorTranscriptName(entry.name)) continue;
		const id = entry.name.slice(0, -JSONL_SUFFIX.length);
		records.push({ id, transcriptPath: path.join(dir, entry.name) });
		// A transcript stem is not proof of a child directory; only descend a
		// directory named after a transcript beside it (upstream's rule).
		if (childDirectories.has(id)) {
			await scanSubagentTranscriptsInto(path.join(dir, id), records);
		}
	}
}

/** A finished row plus the timestamp used for newest-first ordering. */
interface FinishedSubagentRow {
	readonly summary: RpcProjectSubagentSummary;
	readonly createdAt: number;
}

/**
 * Build one durable summary row. Terminal-status rule — durable facts only;
 * `"failed"` cannot be distinguished cheaply from disk and is never claimed by
 * this catalog:
 *   - tombstone (`<id>.jsonl.tombstone`)     → "aborted" (explicit kill marker)
 *   - registry ref on this exact transcript  → "aborted"/"parked" (live-process fact)
 *   - header-only head (`incomplete`)        → "interrupted" (nothing ever ran)
 *   - `<id>.md` output artifact exists       → "completed" (executor wrote the result)
 *   - anything else                          → "interrupted" — a run that crashed
 *     without leaving a completion fact is reported interrupted per §14.8,
 *     never silently completed.
 */
async function buildFinishedSubagentRow(record: SubagentTranscriptRecord): Promise<FinishedSubagentRow> {
	let stat: fs.Stats | undefined;
	try {
		stat = await fs.promises.stat(record.transcriptPath);
	} catch {
		stat = undefined;
	}
	const metadata = stat ? await readDurableSubagentMetadata(record.transcriptPath) : undefined;
	const [tombstoned, hasOutput] = await Promise.all([
		Bun.file(getAgentTombstonePath(record.transcriptPath)).exists(),
		Bun.file(`${record.transcriptPath.slice(0, -JSONL_SUFFIX.length)}.md`).exists(),
	]);
	const ref = AgentRegistry.global().get(record.id);
	// Registry corroboration only when the live ref points at exactly this transcript.
	const registryStatus = ref?.kind === "sub" && ref.sessionFile === record.transcriptPath ? ref.status : undefined;
	let status: RpcProjectSubagentStatus;
	if (tombstoned) status = "aborted";
	else if (registryStatus === "aborted") status = "aborted";
	else if (registryStatus === "parked") status = "parked";
	else if (!metadata || metadata.incomplete) status = "interrupted";
	else if (hasOutput) status = "completed";
	else status = "interrupted";
	const summary: RpcProjectSubagentSummary = {
		subagentId: record.id,
		name: metadata?.agent ?? record.id,
		...(metadata?.activity !== undefined ? { description: metadata.activity } : {}),
		status,
		recordReadable: metadata?.readable === true,
		sessionFile: record.transcriptPath,
		...(stat !== undefined ? { lastUpdate: new Date(stat.mtimeMs).toISOString() } : {}),
		// Parked rows can still receive IRC sends (the bus revives them); other
		// terminal rows expose nothing — no revival through this API.
		availableActions: status === "parked" ? PARKED_ACTIONS : [],
	};
	return { summary, createdAt: metadata?.createdAt ?? stat?.birthtimeMs ?? stat?.mtimeMs ?? 0 };
}

async function buildFinishedSubagentRows(
	records: readonly SubagentTranscriptRecord[],
	liveIds: ReadonlySet<string>,
): Promise<FinishedSubagentRow[]> {
	const rows: FinishedSubagentRow[] = [];
	let next = 0;
	const workers = Array.from({ length: Math.min(METADATA_READ_CONCURRENCY, records.length) }, async () => {
		for (;;) {
			const record = records[next++];
			if (!record) return;
			// A live snapshot with the same id wins over the durable row.
			if (liveIds.has(record.id)) continue;
			rows.push(await buildFinishedSubagentRow(record));
		}
	});
	await Promise.all(workers);
	return rows.sort((a, b) => b.createdAt - a.createdAt || a.summary.subagentId.localeCompare(b.summary.subagentId));
}

function runningSummaryOf(snapshot: RpcSubagentSnapshot): RpcProjectSubagentSummary {
	return {
		subagentId: snapshot.id,
		name: snapshot.agent,
		agentSource: snapshot.agentSource,
		...(snapshot.description !== undefined ? { description: snapshot.description } : {}),
		...(snapshot.task !== undefined ? { task: snapshot.task } : {}),
		// The live registry only retains non-terminal snapshots, so every live row is running.
		status: "running",
		recordReadable: snapshot.sessionFile !== undefined,
		...(snapshot.sessionFile !== undefined ? { sessionFile: snapshot.sessionFile } : {}),
		...(snapshot.parentToolCallId !== undefined ? { parentToolCallId: snapshot.parentToolCallId } : {}),
		index: snapshot.index,
		lastUpdate: new Date(snapshot.lastUpdate).toISOString(),
		availableActions: RUNNING_ACTIONS,
	};
}

/**
 * Measure the first record starting at `startByte` when it already overflows
 * the caller's window: scan forward in bounded steps for the terminating
 * newline so `recordTooLarge.byteLength` reports the record's real size. The
 * scan is capped; a record with no newline inside the cap reports the scanned
 * span (still a truthful lower bound larger than any sane window).
 */
async function measureOversizedRecord(file: Bun.BunFile, startByte: number, size: number): Promise<number> {
	let offset = startByte;
	for (;;) {
		const end = Math.min(size, offset + OVERSIZED_RECORD_SCAN_STEP);
		const text = await file.slice(offset, end).text();
		const newline = text.indexOf("\n");
		if (newline >= 0) return offset + Buffer.byteLength(text.slice(0, newline + 1), "utf8") - startByte;
		if (end >= size) return size - startByte;
		if (end - startByte >= OVERSIZED_RECORD_SCAN_CAP) return end - startByte;
		offset = end;
	}
}

/**
 * Per-session subagent history catalog + transcript reader + narrow control
 * entry for RPC project mode (rpc-ui-protocol.md §14.8). All filesystem reads
 * are scoped to a resolved session's own artifacts tree; the catalog is
 * read-only apart from `control`, which delegates to existing abort/IRC
 * services.
 */
export class RpcProjectSubagentDirectory {
	readonly #deps: RpcProjectSubagentDirectoryDeps;
	readonly #revision = new RpcRevisionSource("sub-r0");
	/** Last observed merged catalog shape per session; a change bumps the shared revision. */
	readonly #catalogKeys = new Map<string, string>();

	constructor(deps: RpcProjectSubagentDirectoryDeps) {
		this.#deps = deps;
	}

	get revision(): RpcRevision {
		return this.#revision.current;
	}

	#resolveSessionFile(sessionId: string): string {
		const sessionFile = this.#deps.resolveSessionFile(sessionId);
		if (!sessionFile) throw new RpcProjectSubagentError("not_found", `Unknown session: ${sessionId}`);
		return sessionFile;
	}

	/**
	 * Merged subagent directory for one session: live rows first (by spawn
	 * index), then durable rows newest-first. Durable rows come from the
	 * session's artifacts tree; a live snapshot with the same id wins. The
	 * revision is bumped whenever a scan observes a changed catalog shape.
	 */
	async list(sessionId: string, options: RpcProjectSubagentListOptions = {}): Promise<RpcProjectGetSubagentsResult> {
		const limit = normalizeListLimit(options.limit);
		const offset = normalizeListCursor(options.cursor);
		const sessionFile = this.#resolveSessionFile(sessionId);
		const live = [...this.#deps.liveSnapshots(sessionId)].sort(
			(a, b) => a.index - b.index || a.id.localeCompare(b.id),
		);
		const liveIds = new Set(live.map(snapshot => snapshot.id));
		const runningRows: RpcProjectSubagentSummary[] =
			options.status === "finished" ? [] : live.map(snapshot => runningSummaryOf(snapshot));
		let finishedRows: FinishedSubagentRow[] = [];
		if (options.status !== "running") {
			const records = await scanSubagentTranscripts(artifactsDirForSessionFile(sessionFile));
			finishedRows = await buildFinishedSubagentRows(records, liveIds);
			// Revision maintenance needs the merged shape, so only scans (which see
			// both halves) refresh it; the running-only fast path leaves it untouched.
			const catalogKey = [
				live.map(snapshot => `${snapshot.id}:running`).join("|"),
				finishedRows.map(row => `${row.summary.subagentId}:${row.summary.status}`).join("|"),
			].join(";");
			if (this.#catalogKeys.get(sessionId) !== catalogKey) {
				this.#catalogKeys.set(sessionId, catalogKey);
				this.#revision.bump();
			}
		}
		const items = [...runningRows, ...finishedRows.map(row => row.summary)];
		const page = items.slice(offset, offset + limit);
		const nextOffset = offset + limit;
		return {
			items: page,
			revision: this.#revision.current,
			...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {}),
		};
	}

	/** Resolve a subagent id to its transcript: live snapshot first, then this session's artifacts tree. */
	async #resolveTranscriptPath(sessionId: string, subagentId: string, sessionFile: string): Promise<string> {
		const live = this.#deps.liveSnapshots(sessionId).find(snapshot => snapshot.id === subagentId);
		if (live?.sessionFile) return live.sessionFile;
		const records = await scanSubagentTranscripts(artifactsDirForSessionFile(sessionFile));
		const record = records.find(candidate => candidate.id === subagentId);
		if (!record) throw new RpcProjectSubagentError("not_found", `Unknown subagent: ${subagentId}`);
		return record.transcriptPath;
	}

	/**
	 * Read one subagent transcript as complete JSONL records inside a bounded
	 * byte window (§14.8: never truncate into corrupt JSON). `fromByte` past EOF
	 * resets to 0 with `reset: true`. A record larger than `maxBytes` yields
	 * `recordTooLarge` with the cursor unchanged so the caller can raise the
	 * window; the file's final unterminated record is completed at EOF (the
	 * stream loader's LF-append remedy) so the cursor can always advance.
	 */
	async messages(
		sessionId: string,
		subagentId: string,
		options: RpcProjectSubagentMessagesOptions = {},
	): Promise<RpcProjectSubagentMessagesResult> {
		const requestedFromByte = normalizeFromByte(options.fromByte);
		const maxBytes = normalizeMaxBytes(options.maxBytes);
		const sessionFile = this.#resolveSessionFile(sessionId);
		const transcriptPath = await this.#resolveTranscriptPath(sessionId, subagentId, sessionFile);
		let size: number;
		try {
			({ size } = await fs.promises.stat(transcriptPath));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") {
				throw new RpcProjectSubagentError("not_found", `Subagent transcript unavailable: ${subagentId}`);
			}
			throw error;
		}
		let fromByte = requestedFromByte;
		let reset = false;
		if (fromByte > size) {
			fromByte = 0;
			reset = true;
		}
		if (fromByte >= size) {
			return {
				subagentId,
				sessionFile: transcriptPath,
				fromByte,
				nextByte: fromByte,
				reset,
				hasMore: false,
				entries: [],
				messages: [],
			};
		}
		const file = Bun.file(transcriptPath);
		const chunk = await file.slice(fromByte, fromByte + maxBytes).text();
		const lastNewline = chunk.lastIndexOf("\n");
		if (lastNewline >= 0) {
			const completeText = chunk.slice(0, lastNewline + 1);
			const entries = parseSessionEntries(completeText);
			const nextByte = fromByte + Buffer.byteLength(completeText, "utf8");
			return {
				subagentId,
				sessionFile: transcriptPath,
				fromByte,
				nextByte,
				reset,
				hasMore: nextByte < size,
				entries,
				messages: entries.filter(isSessionMessageEntry).map(entry => entry.message),
			};
		}
		if (fromByte + Buffer.byteLength(chunk, "utf8") >= size) {
			// EOF: the final record simply lacks its trailing newline. Terminate it
			// (the stream loader's LF-append remedy) so the parser completes it and
			// the cursor advances to EOF instead of re-reading this window forever.
			const byteLength = Buffer.byteLength(chunk, "utf8");
			const entries = chunk.length > 0 ? parseSessionEntries(`${chunk}\n`) : [];
			return {
				subagentId,
				sessionFile: transcriptPath,
				fromByte,
				nextByte: fromByte + byteLength,
				reset,
				hasMore: false,
				entries,
				messages: entries.filter(isSessionMessageEntry).map(entry => entry.message),
			};
		}
		// The window's first record extends beyond maxBytes: never truncate into
		// corrupt JSON — report the record's size and keep the cursor unchanged.
		const byteLength = await measureOversizedRecord(file, fromByte, size);
		return {
			subagentId,
			sessionFile: transcriptPath,
			fromByte,
			nextByte: fromByte,
			reset,
			hasMore: true,
			entries: [],
			messages: [],
			recordTooLarge: { byteLength },
		};
	}

	/**
	 * Narrow control entry (§14.8): `stop` aborts a running subagent via the
	 * injected cancel hook or the registry-driven executor abort monitor;
	 * `send_message` delivers one host-authored message through the IRC bus
	 * (sender identity is fixed server-side — the GUI never impersonates an
	 * agent). Delivery is not processing; a `woken`/`revived` outcome may start
	 * a model turn.
	 */
	async control(
		sessionId: string,
		subagentId: string,
		action: "send_message" | "stop",
		message?: string,
	): Promise<RpcProjectControlSubagentResult> {
		if (action === "stop") return this.#stop(sessionId, subagentId);
		if (action === "send_message") return this.#sendMessage(sessionId, subagentId, message);
		throw new RpcProjectSubagentError("invalid_params", `Unsupported control action: ${String(action)}`);
	}

	async #stop(sessionId: string, subagentId: string): Promise<RpcProjectControlSubagentResult> {
		if (!this.#deps.liveSnapshots(sessionId).some(snapshot => snapshot.id === subagentId)) {
			throw new RpcProjectSubagentError("not_found", `Only running subagents are stoppable: ${subagentId}`);
		}
		if (this.#deps.cancelSubagent) {
			let accepted: boolean;
			try {
				accepted = await this.#deps.cancelSubagent(sessionId, subagentId);
			} catch (error) {
				throw new RpcProjectSubagentError("execution_failed", subagentErrorText(error));
			}
			if (!accepted) throw new RpcProjectSubagentError("execution_failed", `Agent not stoppable: ${subagentId}`);
			return { subagentId, action: "stop", status: "stopping", detail: "abort requested" };
		}
		// Registry-driven fallback: the task executor subscribes each run to
		// `status_changed` → `aborted` and calls `monitor.requestAbort("signal")`
		// (task/executor.ts), so flipping the registry status IS the existing
		// abort path — no second control logic is created here.
		const ref = AgentRegistry.global().get(subagentId);
		if (!ref) throw new RpcProjectSubagentError("unsupported", "No stop path configured for this subagent");
		if (
			this.#deps.projectSessionDir &&
			ref.sessionFile &&
			!isInsideDir(ref.sessionFile, this.#deps.projectSessionDir)
		) {
			throw new RpcProjectSubagentError(
				"scope_not_allowed",
				`Agent "${subagentId}" does not belong to this project`,
			);
		}
		let accepted: boolean;
		try {
			accepted = AgentRegistry.global().setStatus(subagentId, "aborted");
		} catch (error) {
			throw new RpcProjectSubagentError("execution_failed", subagentErrorText(error));
		}
		if (!accepted) throw new RpcProjectSubagentError("execution_failed", `Agent not stoppable: ${subagentId}`);
		return { subagentId, action: "stop", status: "stopping", detail: "abort requested via agent registry" };
	}

	async #sendMessage(
		sessionId: string,
		subagentId: string,
		message?: string,
	): Promise<RpcProjectControlSubagentResult> {
		if (typeof message !== "string" || message.length === 0) {
			throw new RpcProjectSubagentError("invalid_params", "send_message requires a non-empty message");
		}
		this.#resolveSessionFile(sessionId);
		const send = this.#deps.sendIrcMessage;
		if (!send) throw new RpcProjectSubagentError("unsupported", "send_message is not configured on this host");
		// Ownership: a registry ref pointing outside this project's session dir is
		// a cross-project/cross-session target and is rejected outright.
		const ref = AgentRegistry.global().get(subagentId);
		if (
			ref?.sessionFile &&
			this.#deps.projectSessionDir &&
			!isInsideDir(ref.sessionFile, this.#deps.projectSessionDir)
		) {
			throw new RpcProjectSubagentError(
				"scope_not_allowed",
				`Agent "${subagentId}" does not belong to this project`,
			);
		}
		let receipt: { to: string; outcome: string; error?: string };
		try {
			receipt = await send({ from: MAIN_AGENT_ID, to: subagentId, body: message });
		} catch (error) {
			throw new RpcProjectSubagentError("execution_failed", subagentErrorText(error));
		}
		if (receipt.outcome === "failed") {
			throw new RpcProjectSubagentError("execution_failed", receipt.error ?? `Delivery to "${subagentId}" failed`);
		}
		return {
			subagentId,
			action: "send_message",
			status: "sent",
			// Delivery ≠ processing (§14.8): the receipt reports how the message
			// reached the recipient, not what they did with it.
			detail: `outcome: ${receipt.outcome} (delivered; processing not implied)`,
			receipts: [{ to: receipt.to, outcome: receipt.outcome, ...(receipt.error ? { error: receipt.error } : {}) }],
		};
	}
}
