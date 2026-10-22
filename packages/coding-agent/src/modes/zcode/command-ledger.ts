import { createHash, randomUUID } from "node:crypto";
import type { SessionEntry } from "../../session/session-entries";
import type { SessionManager } from "../../session/session-manager";
import type { CommandAck, CommandEnvelope, CommandKey, CommandResult } from "./schema";

const RECEIPT_TYPE = "zcode_command_result";
const PRODUCED_TYPE = "zcode_produced_session";

interface LedgerManager {
	get(id: string): { session: { sessionManager: SessionManager; isStreaming: boolean } } | undefined;
	list(): Promise<readonly { id: string }[]>;
	readCommandEntries(id: string): Promise<readonly SessionEntry[] | undefined>;
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
	constructor(
		readonly manager: LedgerManager,
		options: { settledLimit?: number } = {},
	) {
		this.#settledLimit = Math.max(1, options.settledLimit ?? 256);
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
			return { ...(await this.#cachedResult(identity, existing)), status: "duplicate" };
		}
		// Install the in-flight reservation synchronously, before any journal read or side effect.
		const cached: CachedDecision = {
			fingerprint: identity.fingerprint,
			settled: false,
			decision: Promise.resolve().then(async () => {
				const persisted = await this.#find(identity);
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
		const results = await Promise.all(
			keys.map(async key => {
				const cached = this.#decisions.get(keyOf(key));
				if (cached) {
					this.#touch(keyOf(key), cached);
					return { key, result: await this.#cachedResult(key, cached) };
				}
				const fact = await this.#find(key);
				return { key, result: fact?.ack ?? ("unknown" as const) };
			}),
		);
		this.#trim();
		return { results };
	}
	async #cachedResult(key: CommandKey, cached: CachedDecision): Promise<CommandAck> {
		const ack = await cached.decision;
		const destination =
			ack.result?.type === "createSession" ||
			ack.result?.type === "createSelectionSideSession" ||
			ack.result?.type === "forkAssistant"
				? ack.result.sessionId
				: key.sessionId;
		const live = destination ? this.manager.get(destination) : undefined;
		if (!live || !destination || !inputId(ack)) return ack;
		return this.#reconcile(
			{ version: 1, key, fingerprint: cached.fingerprint, epoch: this.#epoch, journalSessionId: destination, ack },
			live.session.sessionManager.getEntries(),
		).ack;
	}

	async #persist(id: string, customType: string, fact: Fact): Promise<void> {
		const manager = this.manager.get(id)?.session.sessionManager;
		if (!manager) throw new Error(`No active journal for command result: ${id}`);
		await manager.appendEntriesAtomically(() => manager.appendCustomEntry(customType, fact));
	}

	async #find(key: CommandKey): Promise<Fact | undefined> {
		// Existing-only journal reads: no resume(), runtime construction, or ownership acquisition.
		const sessions = await this.manager.list();
		const ordered = key.sessionId
			? [
					...sessions.filter(info => info.id === key.sessionId),
					...sessions.filter(info => info.id !== key.sessionId),
				]
			: sessions;
		let produced: Fact | undefined;
		let admission: Fact | undefined;
		for (const info of ordered) {
			const entries = await this.manager.readCommandEntries(info.id);
			if (!entries) continue; // The session owner deleted this journal after the list snapshot.
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
					}
				}
				if (entry.type !== "custom" || (entry.customType !== RECEIPT_TYPE && entry.customType !== PRODUCED_TYPE))
					continue;
				const fact = entry.data as Fact | undefined;
				if (fact?.version !== 1 || fact.journalSessionId !== info.id || keyOf(fact.key) !== keyOf(key)) continue;
				const reconciled = this.#reconcile(fact, entries);
				if (entry.customType === RECEIPT_TYPE) return reconciled;
				produced ??= reconciled;
			}
		}
		return produced ?? admission;
	}

	#reconcile(fact: Fact, entries: readonly SessionEntry[]): Fact {
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
