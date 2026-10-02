/**
 * `/btw` side questions for RPC hosts: the `btw`, `btw_cancel` and
 * `get_btw_history` commands plus the `btw_delta` / `btw_record` frames.
 *
 * Mirrors the TUI `BtwController` without its panels: one side question runs
 * at a time against the main session, answers stream as frames, and every
 * turn is checkpointed into the session's BTW history sidecar, so the TUI and
 * RPC hosts read and continue the same topics.
 */
import { logger, toError } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { type BtwHistoryRecord, BtwHistoryStore, getBtwLatestTurn } from "../../session/btw-history";
import { beginBtwTurn, patchLatestBtwTurn, runBtwTurn } from "../../session/btw-turn";
import type { RpcBtwDeltaFrame, RpcBtwRecordFrame } from "./rpc-types";

type RpcBtwOutputFrame =
	| RpcBtwDeltaFrame
	| RpcBtwRecordFrame
	| { type: "notice"; level: "error"; message: string; source: "btw-history" };

export type RpcBtwSession = Pick<AgentSession, "model" | "runEphemeralTurn" | "sessionManager">;

interface RunningBtw {
	record: BtwHistoryRecord;
	question: string;
	store: BtwHistoryStore;
	abort: AbortController;
}

export class RpcBtwController {
	readonly #session: RpcBtwSession;
	readonly #output: (frame: RpcBtwOutputFrame) => void;
	#store: BtwHistoryStore | undefined;
	/** `sessionId \0 artifactsDir` the store was opened for. */
	#storeKey: string | undefined;
	#running: RunningBtw | undefined;
	/** A `btw` command is between validation and its first checkpoint. */
	#starting = false;

	constructor(session: RpcBtwSession, output: (frame: RpcBtwOutputFrame) => void) {
		this.#session = session;
		this.#output = output;
	}

	/** Start a side question (or a follow-up in topic `recordId`); resolves once it is checkpointed as running. */
	async ask(question: string, recordId?: string): Promise<BtwHistoryRecord> {
		const trimmed = typeof question === "string" ? question.trim() : "";
		if (!trimmed) throw new Error("btw requires a non-empty question");
		if (this.#starting || this.#running) throw new Error("A /btw question is still running; cancel it first");
		this.#starting = true;
		try {
			const manager = this.#session.sessionManager;
			await manager.ensureOnDisk();
			const store = await this.#openStore();
			const previous = recordId === undefined ? undefined : store.getRecords().find(r => r.id === recordId);
			if (recordId !== undefined && !previous) throw new Error(`Unknown /btw topic: ${recordId}`);
			if (previous && getBtwLatestTurn(previous).status === "running") {
				throw new Error(`/btw topic ${recordId} is still running`);
			}
			if (!this.#session.model) throw new Error("No active model available for /btw.");
			const { record, history, conversationKey } = beginBtwTurn(trimmed, manager.getLeafId(), previous);
			try {
				await store.upsert(record);
			} catch (error) {
				// A sticky store failure must not wedge every later question: reopen from disk next time.
				this.#closeStore();
				throw new Error(`Could not save /btw history: ${toError(error).message}`, { cause: error });
			}
			const running: RunningBtw = { record, question: trimmed, store, abort: new AbortController() };
			this.#running = running;
			this.#output({ type: "btw_record", record });
			void this.#run(running, history, conversationKey);
			return record;
		} finally {
			this.#starting = false;
		}
	}

	/** Cancel the running question (only if it is `recordId`, when given). */
	cancel(recordId?: string): boolean {
		const running = this.#running;
		if (!running || (recordId !== undefined && running.record.id !== recordId)) return false;
		this.#finish(running, { status: "cancelled", updatedAt: Date.now() });
		running.abort.abort();
		return true;
	}

	/** Newest first; a running topic carries its live partial answer. */
	async history(): Promise<readonly BtwHistoryRecord[]> {
		const store = await this.#openStore();
		const running = this.#running;
		if (!running || running.store !== store) return store.getRecords();
		return store.getRecords().map(record => (record.id === running.record.id ? running.record : record));
	}

	/**
	 * Before the session is replaced or the process exits: cancel the running question
	 * and wait for its checkpoint, so the session's history is complete.
	 */
	async close(): Promise<void> {
		this.cancel();
		const store = this.#store;
		this.#closeStore();
		await store?.flush().catch(error => logger.warn("BTW history flush failed", { error: String(error) }));
	}

	/**
	 * The current session's store with every queued checkpoint landed, so a just-finished
	 * turn reads as finished. A store whose write failed (already reported as a `notice`)
	 * is replaced by a fresh read from disk instead of failing every later call.
	 */
	async #openStore(): Promise<BtwHistoryStore> {
		const manager = this.#session.sessionManager;
		const artifactsDir = manager.getArtifactsDir() ?? undefined;
		const key = `${manager.getSessionId()}\0${artifactsDir ?? ""}`;
		if (this.#store && this.#storeKey === key) {
			const store = this.#store;
			try {
				await store.flush();
				return store;
			} catch {
				if (this.#store === store) this.#closeStore();
			}
		}
		// Replaced outside a host command (an extension switched sessions): the old
		// session's question must not keep streaming into this one's view.
		this.cancel();
		const store = await BtwHistoryStore.open(artifactsDir);
		this.#store = store;
		this.#storeKey = key;
		return store;
	}

	#closeStore(): void {
		this.#store = undefined;
		this.#storeKey = undefined;
	}

	async #run(
		running: RunningBtw,
		history: Parameters<typeof runBtwTurn>[1]["history"],
		conversationKey: string,
	): Promise<void> {
		try {
			const { replyText } = await runBtwTurn(this.#session, {
				question: running.question,
				history,
				conversationKey,
				signal: running.abort.signal,
				onTextDelta: delta => {
					if (this.#running !== running) return;
					const latest = getBtwLatestTurn(running.record);
					running.record = patchLatestBtwTurn(running.record, {
						answer: latest.answer + delta,
						updatedAt: Date.now(),
					});
					this.#output({ type: "btw_delta", recordId: running.record.id, delta });
				},
			});
			this.#finish(running, { answer: replyText, status: "complete", updatedAt: Date.now() });
		} catch (error) {
			this.#finish(running, { status: "error", error: toError(error).message, updatedAt: Date.now() });
		}
	}

	/** Record the turn's terminal state once; later outcomes of the same turn are ignored. */
	#finish(running: RunningBtw, patch: Parameters<typeof patchLatestBtwTurn>[1]): void {
		if (this.#running !== running) return;
		this.#running = undefined;
		running.record = patchLatestBtwTurn(running.record, patch);
		this.#output({ type: "btw_record", record: running.record });
		running.store.upsert(running.record).catch(error => {
			const message = `Could not save /btw history: ${toError(error).message}`;
			logger.error(message);
			this.#output({ type: "notice", level: "error", message, source: "btw-history" });
			if (this.#store === running.store) this.#closeStore();
		});
	}
}
