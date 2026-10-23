import { createHash, randomUUID } from "node:crypto";
import type { SessionEntry } from "../../session/session-entries";
import type { SessionManager } from "../../session/session-manager";
import type { SessionInfo } from "../../session/session-listing";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../../session/messages";
import type { AgentStorage } from "../../session/agent-storage";
import { extractCommandEvidence, ZCodeCommandIndex, type CommandEvidence, type CommandJournal } from "./command-index";
import type { CommandAck, CommandEnvelope, CommandKey, CommandResult } from "./schema";

const RECEIPT_TYPE = "zcode_command_result";
const PRODUCED_TYPE = "zcode_produced_session";

interface LedgerManager {
	get(id: string): { session: { sessionManager: SessionManager; isStreaming: boolean } } | undefined;
	list(): Promise<readonly Pick<SessionInfo, "id" | "path">[]>;
	readCommandEntries(info: Pick<SessionInfo, "id" | "path">): Promise<readonly SessionEntry[] | undefined>;
	listCommandJournals?(): Promise<readonly string[]>;
	commandIndexStorage?(): Promise<AgentStorage>;
	withCommandJournalRead?<T>(file: string, read: () => Promise<T>): Promise<T | undefined>;
}
interface Fact {
	version: 1;
	key: CommandKey;
	fingerprint: string;
	epoch: string;
	ack: CommandAck;
	/** A copied parent receipt in a fork is not a receipt authored by that child. */
	journalSessionId: string;
	/** Runtime identity used when only admission/promotion survived, without a full ACK. */
	inputId?: string;
}
interface InputFact {
	inputId: string;
	state: "admitted" | "promoted" | "cancelled" | "discarded" | "failed";
	sourceCommand?: { sessionId: string | null; commandId: string; fingerprint: string; epoch?: string };
	reason?: string;
}
interface CachedDecision {
	fingerprint: string;
	decision: Promise<CommandAck>;
	settled: boolean;
	ack?: CommandAck;
	journal?: Pick<SessionInfo, "id" | "path">;
}

function keyOf(key: CommandKey): string {
	return JSON.stringify([key.sessionId, key.commandId]);
}
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.filter(key => object[key] !== undefined)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonical(object[key])}`)
		.join(",")}}`;
}
function inputId(ack: CommandAck): string | undefined {
	const result = ack.result;
	if (result?.type === "inputAccepted") return result.inputId;
	if (
		result?.type === "createSession" ||
		result?.type === "createSelectionSideSession" ||
		result?.type === "forkAssistant"
	)
		return result.input?.inputId;
	return undefined;
}

/** Durable result facts in OMP journals, never a pending execution queue or separate store. */
export class ZCodeCommandLedger {
	readonly #epoch = randomUUID();
	readonly #decisions = new Map<string, CachedDecision>();
	readonly #settledLimit: number;
	readonly #index?: ZCodeCommandIndex;
	constructor(
		readonly manager: LedgerManager,
		options: { settledLimit?: number } = {},
	) {
		this.#settledLimit = Math.max(1, options.settledLimit ?? 256);
		if (manager.listCommandJournals && manager.commandIndexStorage) {
			this.#index = new ZCodeCommandIndex({
				listCommandJournals: () => manager.listCommandJournals!(),
				commandIndexStorage: () => manager.commandIndexStorage!(),
				withCommandJournalRead: (file, read) =>
					manager.withCommandJournalRead ? manager.withCommandJournalRead(file, read) : read(),
			});
		}
	}

	/** Explicit ready-after backfill; constructing SDK/test ledgers never scans history. */
	async warmIndex(signal?: AbortSignal): Promise<void> {
		await this.#index?.warm(signal);
	}

	identity(envelope: CommandEnvelope): {
		sessionId: string | null;
		commandId: string;
		fingerprint: string;
		epoch: string;
	} {
		return {
			sessionId: envelope.sessionId,
			commandId: envelope.commandId,
			epoch: this.#epoch,
			fingerprint: createHash("sha256")
				.update(
					canonical({
						type: envelope.type,
						payload: envelope.payload,
						baseRevision: envelope.baseRevision,
						baseLogEpoch: envelope.baseLogEpoch,
					}),
				)
				.digest("hex"),
		};
	}

	async execute(envelope: CommandEnvelope, decide: () => Promise<CommandAck>): Promise<CommandAck> {
		const identity = this.identity(envelope);
		const key = keyOf(identity);
		const existing = this.#decisions.get(key);
		if (existing) {
			this.#assertFingerprint(existing.fingerprint, identity.fingerprint);
			this.#touch(key, existing);
			const result = await this.#cachedResult(identity, existing);
			if (!result) throw new Error("Command result journal no longer exists");
			return { ...result, status: "duplicate" };
		}
		// Install the in-flight reservation synchronously, before any journal read or side effect.
		const cached: CachedDecision = {
			fingerprint: identity.fingerprint,
			settled: false,
			decision: Promise.resolve().then(async () => {
				const persisted = await this.#find(identity, undefined, cached);
				if (persisted) {
					// A durable identity mismatch rejects before admission, so this incoming
					// reservation must not poison retries of the original durable command.
					if (persisted.fingerprint !== identity.fingerprint) this.#decisions.delete(key);
					this.#assertFingerprint(persisted.fingerprint, identity.fingerprint);
					return { ...persisted.ack, status: "duplicate" as const };
				}
				const ack = await decide();
				const destination =
					ack.result?.type === "createSession" ||
					ack.result?.type === "createSelectionSideSession" ||
					ack.result?.type === "forkAssistant"
						? ack.result.sessionId
						: envelope.sessionId;
				if (destination && this.manager.get(destination))
					await this.#persist(destination, RECEIPT_TYPE, {
						version: 1,
						key: { sessionId: envelope.sessionId, commandId: envelope.commandId },
						fingerprint: identity.fingerprint,
						epoch: this.#epoch,
						ack,
						journalSessionId: destination,
					});
				else if (ack.status === "accepted" && envelope.type !== "deleteSession")
					throw new Error("Accepted command has no writable result journal");
				return ack;
			}),
		};
		this.#decisions.set(key, cached);
		try {
			const ack = await cached.decision;
			cached.ack = ack;
			cached.settled = true;
			this.#trim();
			return ack;
		} catch (error) {
			// An interrupted durable write may follow a real effect. Keep the failed live reservation;
			// never turn a transport/persistence error into permission to execute the effect again.
			throw error;
		}
	}

	/** Call immediately after creation/fork, before any first-input effect or final ACK. */
	async recordProduced(
		envelope: CommandEnvelope,
		producedSessionId: string,
		result: CommandResult,
		revision: number,
	): Promise<void> {
		const identity = this.identity(envelope);
		await this.#persist(producedSessionId, PRODUCED_TYPE, {
			version: 1,
			key: { sessionId: identity.sessionId, commandId: identity.commandId },
			fingerprint: identity.fingerprint,
			epoch: this.#epoch,
			journalSessionId: producedSessionId,
			ack: { commandId: envelope.commandId, status: "accepted", revisionAtDecision: revision, result },
		});
	}

	async query(
		keys: readonly CommandKey[],
	): Promise<{ results: { key: CommandKey; result: CommandAck | "unknown" }[] }> {
		const cachedDecisions = keys.map(key => this.#decisions.get(keyOf(key)));
		const missingKeys = keys.filter((_, index) => !cachedDecisions[index]);
		let journals: Promise<readonly CommandJournal[]> | undefined;
		const results = await Promise.all(
			keys.map(async (key, index) => {
				const cached = cachedDecisions[index];
				if (cached) {
					this.#touch(keyOf(key), cached);
					return { key, result: (await this.#cachedResult(key, cached)) ?? ("unknown" as const) };
				}
				// 仅持久回源共享一次发现；缓存命中不能被无关 journal 的损坏或删除阻断。
				const fact = await this.#find(key, await (journals ??= this.#readJournals(missingKeys)));
				return { key, result: fact?.ack ?? ("unknown" as const) };
			}),
		);
		this.#trim();
		return { results };
	}
	async #cachedResult(key: CommandKey, cached: CachedDecision): Promise<CommandAck | undefined> {
		if (!cached.settled) return cached.decision;
		const ack = await cached.decision;
		const destination =
			ack.result?.type === "createSession" ||
			ack.result?.type === "createSelectionSideSession" ||
			ack.result?.type === "forkAssistant"
				? ack.result.sessionId
				: key.sessionId;
		const live = destination ? this.manager.get(destination) : undefined;
		if (!destination || !inputId(ack)) return ack;
		// 冷 owner 的缓存仍须核对输入终态，但只读取执行时确认的目标，不能重新枚举无关 journal。
		const entries = live
			? live.session.sessionManager.getEntries()
			: cached.journal
				? await this.manager.readCommandEntries(cached.journal)
				: undefined;
		if (!entries) return undefined;
		return this.#reconcile(
			{ version: 1, key, fingerprint: cached.fingerprint, epoch: this.#epoch, journalSessionId: destination, ack },
			extractCommandEvidence(entries),
		).ack;
	}

	async #persist(id: string, customType: string, fact: Fact): Promise<void> {
		const manager = this.manager.get(id)?.session.sessionManager;
		if (!manager) throw new Error(`No active journal for command result: ${id}`);
		const file = manager.getSessionFile();
		const cached = this.#decisions.get(keyOf(fact.key));
		// 在持久化前记录真实 owner/path，产出 child 或写入中断后的 reservation 都复用同一目标。
		if (file && cached) cached.journal = { id, path: file };
		await manager.appendEntriesAtomically(() => manager.appendCustomEntry(customType, fact));
		const persistedFile = manager.getSessionFile();
		if (persistedFile && cached) cached.journal = { id, path: persistedFile };
		if (persistedFile) this.#index?.invalidate(persistedFile);
	}

	async #readJournals(keys: readonly CommandKey[]): Promise<readonly CommandJournal[]> {
		if (this.#index)
			return this.#index.read(keys, journals =>
				// 完整回执可在 fork 产出的 child；只有每个回源 key 都已证明，才忽略无关文件读取失败。
				keys.every(key =>
					journals.some(journal =>
						journal.entries.some(entry => {
							if (entry.type !== "custom" || entry.customType !== RECEIPT_TYPE) return false;
							const fact = entry.data as Fact | undefined;
							return (
								fact?.version === 1 && fact.journalSessionId === journal.id && keyOf(fact.key) === keyOf(key)
							);
						}),
					),
				),
			);
		// In-memory/test adapters retain their explicit source contract, rather than silently
		// bypassing production persistence based on filesystem or environment heuristics.
		const sessions = await this.manager.list();
		const journals: CommandJournal[] = [];
		for (const info of sessions) {
			const entries = await this.manager.readCommandEntries(info);
			if (entries) journals.push({ ...info, entries: extractCommandEvidence(entries) });
		}
		return journals;
	}

	async #find(
		key: CommandKey,
		snapshot?: readonly CommandJournal[],
		cached?: CachedDecision,
	): Promise<Fact | undefined> {
		// Existing-only journal reads: no resume(), runtime construction, or ownership acquisition.
		const sessions = snapshot ?? (await this.#readJournals([key]));
		const ordered = key.sessionId
			? [
					...sessions.filter(info => info.id === key.sessionId),
					...sessions.filter(info => info.id !== key.sessionId),
				]
			: sessions;
		let produced: Fact | undefined;
		let admission: Fact | undefined;
		let producedJournal: CommandJournal | undefined;
		let admissionJournal: CommandJournal | undefined;
		for (const info of ordered) {
			const entries = info.entries;
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				if (entry.type === "message" && "sourceCommand" in entry.message && "inputId" in entry.message) {
					const source = entry.message.sourceCommand as InputFact["sourceCommand"];
					if (
						source &&
						source.sessionId === info.id &&
						keyOf(source) === keyOf(key) &&
						typeof entry.message.inputId === "string" &&
						!admission
					) {
						admission = this.#reconcile(
							{
								version: 1,
								key,
								fingerprint: source.fingerprint,
								epoch: source.epoch ?? "",
								journalSessionId: info.id,
								inputId: entry.message.inputId,
								ack: { commandId: key.commandId, status: "accepted", revisionAtDecision: 0 },
							},
							entries,
						);
						admissionJournal = info;
					}
				}
				if (entry.type === "custom" && entry.customType === "session_input") {
					const input = entry.data as InputFact | undefined;
					const source = input?.sourceCommand;
					if (input && source && source.sessionId === info.id && keyOf(source) === keyOf(key) && !admission) {
						admission = this.#reconcile(
							{
								version: 1,
								key,
								fingerprint: source.fingerprint,
								epoch: source.epoch ?? "",
								journalSessionId: info.id,
								inputId: input.inputId,
								ack: { commandId: key.commandId, status: "accepted", revisionAtDecision: 0 },
							},
							entries,
						);
						admissionJournal = info;
					}
				}
				if (entry.type !== "custom" || (entry.customType !== RECEIPT_TYPE && entry.customType !== PRODUCED_TYPE))
					continue;
				const fact = entry.data as Fact | undefined;
				if (fact?.version !== 1 || fact.journalSessionId !== info.id || keyOf(fact.key) !== keyOf(key)) continue;
				const reconciled = this.#reconcile(fact, entries);
				if (entry.customType === RECEIPT_TYPE) {
					if (cached) cached.journal = { id: info.id, path: info.path };
					return reconciled;
				}
				if (!produced) {
					produced = reconciled;
					producedJournal = info;
				}
			}
		}
		const journal = producedJournal ?? admissionJournal;
		if (cached && journal) cached.journal = { id: journal.id, path: journal.path };
		return produced ?? admission;
	}

	#reconcile(fact: Fact, entries: readonly CommandEvidence[]): Fact {
		const id = fact.inputId ?? inputId(fact.ack);
		if (!id || fact.ack.status !== "accepted") return fact;
		const lifecycle = [...entries]
			.reverse()
			.find(
				entry =>
					entry.type === "custom" &&
					entry.customType === "session_input" &&
					(entry.data as InputFact | undefined)?.inputId === id,
			);
		const state = lifecycle?.type === "custom" ? (lifecycle.data as InputFact).state : undefined;
		if (state === "cancelled" || state === "discarded" || state === "failed") {
			return {
				...fact,
				ack: {
					...fact.ack,
					status: "failed",
					reasonCode: state === "discarded" ? "session_resumed" : `input.${state}`,
					message: `Input ${state}`,
				},
			};
		}
		if (fact.epoch === this.#epoch) return fact;
		// Tan 派发已经完成输入副作用，不生成 promoted user row；必须核对精确命令身份和原生派发。
		const dispatched = entries.some(entry => {
			if (entry.type !== "custom" || entry.customType !== "zcode_tan_admission") return false;
			const input = entry.data as (InputFact & { jobId?: string }) | undefined;
			const source = input?.sourceCommand;
			if (
				input?.inputId !== id ||
				!input.jobId ||
				source?.sessionId !== fact.key.sessionId ||
				source?.commandId !== fact.key.commandId ||
				source?.fingerprint !== fact.fingerprint ||
				source?.epoch !== fact.epoch
			)
				return false;
			return entries.some(candidate => {
				if (candidate.type !== "custom_message" || candidate.customType !== BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE)
					return false;
				const details: unknown = candidate.details;
				return !!details && typeof details === "object" && "jobId" in details && details.jobId === input.jobId;
			});
		});
		if (state === "admitted" && dispatched) return fact;
		const promoted = entries.some(
			entry => entry.type === "message" && "inputId" in entry.message && entry.message.inputId === id,
		);
		if (promoted) return fact;
		return {
			...fact,
			ack: {
				...fact.ack,
				status: "failed",
				reasonCode: "session_resumed",
				message: "Input discarded on restart before promotion (session_resumed)",
			},
		};
	}

	#assertFingerprint(existing: string, incoming: string): void {
		if (existing !== incoming)
			throw Object.assign(new Error("Command identity reused with different payload"), { code: -32602 });
	}
	#touch(key: string, cached: CachedDecision): void {
		this.#decisions.delete(key);
		this.#decisions.set(key, cached);
	}
	#trim(): void {
		const counts = new Map<string, number>();
		for (const [key, value] of [...this.#decisions].reverse()) {
			if (!value.settled) continue;
			const [sessionId] = JSON.parse(key) as [string | null];
			const bucket = sessionId ?? "";
			const id = value.ack && inputId(value.ack);
			// Runtime-live input receipts remain pinned, independent of settled LRU capacity.
			const destination =
				value.ack?.result?.type === "createSession" ||
				value.ack?.result?.type === "createSelectionSideSession" ||
				value.ack?.result?.type === "forkAssistant"
					? value.ack.result.sessionId
					: sessionId;
			const live = destination ? this.manager.get(destination) : undefined;
			if (id && live) {
				if (live.session.isStreaming) continue;
				const entries = live.session.sessionManager.getEntries();
				const terminal =
					entries.some(
						entry => entry.type === "message" && "inputId" in entry.message && entry.message.inputId === id,
					) ||
					entries.some(
						entry =>
							entry.type === "custom" &&
							entry.customType === "session_input" &&
							(entry.data as InputFact | undefined)?.inputId === id &&
							(entry.data as InputFact).state !== "admitted",
					);
				if (!terminal) continue;
			}
			const count = (counts.get(bucket) ?? 0) + 1;
			counts.set(bucket, count);
			if (count > this.#settledLimit) this.#decisions.delete(key);
		}
	}
}
