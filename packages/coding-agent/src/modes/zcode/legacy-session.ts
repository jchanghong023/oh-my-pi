import { createHash } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { collectSubSessions } from "../../session/sub-sessions";
import type { ZCodeSessionRecord } from "./sessions";
import type { ZCodeProjection } from "./projection";
import {
	LegacyProtocol as L,
	sessionDebugParamsSchema,
	sessionDebugSnapshotSchema,
	type ConversationRow,
	type ConversationSnapshot,
} from "./schema";

interface LegacySessionOptions {
	manager: { read(id: string): Promise<{ cwd: string; info?: { path: string }; messages: readonly AgentMessage[] }> };
	getProjection(id: string): ZCodeProjection | Promise<ZCodeProjection>;
	getRecord?(id: string): ZCodeSessionRecord | undefined;
	snapshot(id: string): Promise<L.ZCodeSessionStateSnapshot>;
	notify(method: "session/event", event: L.ZCodeSessionEvent): unknown;
	eventLimit?: number;
}
interface Entry {
	projection: ZCodeProjection;
	previous: ConversationSnapshot;
	seq: number;
	events: L.ZCodeSessionEvent[];
	deliveries: Set<L.ZCodeDeliveryKind>;
	unsubscribe: () => void;
	startedAt?: number;
	startTokens?: number;
	toolStarts: Map<string, number>;
}

/** Compatibility delivery only; execution, queue and journal stay with AgentSession. */
export class LegacySessionBridge {
	readonly #options: LegacySessionOptions;
	readonly #entries = new Map<string, Entry>();
	readonly #attempts = new Map<string, object>();
	#disposed = false;
	constructor(options: LegacySessionOptions) {
		this.#options = options;
	}

	attach(_record: ZCodeSessionRecord | undefined, projection: ZCodeProjection): void {
		const state = projection.snapshot();
		const existing = this.#entries.get(state.sessionId);
		if (existing?.projection === projection) return;
		existing?.unsubscribe();
		const entry: Entry = {
			projection,
			previous: state,
			seq: existing?.seq ?? 0,
			events: existing?.events ?? [],
			deliveries: existing?.deliveries ?? new Set(),
			unsubscribe: () => {},
			toolStarts: new Map(),
		};
		this.#entries.set(state.sessionId, entry);
		entry.unsubscribe = projection.subscribe(() => {
			if (this.#disposed || this.#entries.get(state.sessionId) !== entry) return;
			this.#project(entry);
		});
	}

	eventSeq(id: string): number {
		return this.#entries.get(id)?.seq ?? 0;
	}
	async #entry(id: string): Promise<Entry> {
		if (this.#disposed) throw new Error("Legacy session bridge closed");
		const existing = this.#entries.get(id);
		if (existing) return existing;
		const projection = await this.#options.getProjection(id);
		if (this.#disposed) throw new Error("Legacy session bridge closed");
		// Resolving a cold history projection never resumes or claims a runtime.
		if (!this.#entries.has(id)) this.attach(undefined, projection);
		return this.#entries.get(id)!;
	}

	async subscribe(raw: unknown) {
		const params = L.zcodeSessionSubscribeParamsSchema.parse(raw);
		const key = `${params.sessionId}\0${params.deliveryKind}`;
		const attempt = {};
		this.#attempts.set(key, attempt);
		try {
			const entry = await this.#entry(params.sessionId);
			const snapshot = params.includeSnapshot ? await this.#options.snapshot(params.sessionId) : undefined;
			if (this.#attempts.get(key) !== attempt || this.#entries.get(params.sessionId) !== entry)
				throw new Error("Legacy subscription superseded");
			const events = this.#replay(entry, params.afterSeq).map(event => ({
				...event,
				deliveryKind: params.deliveryKind,
			}));
			entry.deliveries.add(params.deliveryKind);
			return L.zcodeSessionSubscribeResultSchema.parse({
				sessionId: params.sessionId,
				eventSeq: entry.seq,
				events,
				...(snapshot
					? {
							snapshot: {
								...snapshot,
								runtime: { ...snapshot.runtime, eventSeq: entry.seq, deliveryKind: params.deliveryKind },
							},
						}
					: {}),
			});
		} finally {
			if (this.#attempts.get(key) === attempt) this.#attempts.delete(key);
		}
	}

	unsubscribe(raw: unknown): { sessionId: string } {
		const { sessionId, deliveryKind } = L.zcodeSessionSubscribeParamsSchema.parse(raw);
		this.#attempts.delete(`${sessionId}\0${deliveryKind}`);
		this.#entries.get(sessionId)?.deliveries.delete(deliveryKind);
		return { sessionId };
	}

	async events(raw: unknown) {
		const params = L.zcodeSessionEventsParamsSchema.parse(raw);
		const entry = await this.#entry(params.sessionId);
		return L.zcodeSessionEventsResultSchema.parse({
			events: this.#replay(entry, params.afterSeq).slice(0, Math.min(params.limit ?? 1000, 1000)),
		});
	}
	#replay(entry: Entry, afterSeq?: number): L.ZCodeSessionEvent[] {
		if (afterSeq !== undefined && (afterSeq > entry.seq || afterSeq < (entry.events[0]?.seq ?? entry.seq + 1) - 1))
			throw new Error("Legacy event cursor expired; request a fresh snapshot");
		return entry.events.filter(event => event.seq > (afterSeq ?? 0));
	}

	async subagents(raw: unknown): Promise<L.ZCodeSessionSubagentsResult> {
		const params = L.zcodeSessionSubagentsParamsSchema.parse(raw);
		const read = await this.#options.manager.read(params.sessionId);
		if (!read.info?.path) throw new Error("Subagent journal directory is unavailable");
		const persisted = await collectSubSessions(read.info.path, key => {
			throw new Error(`Subagent history is unreadable: ${key}`);
		});
		const native = await this.#options.manager.nativeChild(params.sessionId);
		const owner = this.#options.getRecord?.(params.sessionId) ?? native?.root;
		const parentId = native?.agentId ?? owner?.registry.list().find(ref => ref.session === owner?.session)?.id ?? "Main";
		const refs =
			owner?.registry.list().filter(ref => ref.kind === "sub" && (ref.parentId ?? "Main") === parentId) ?? [];
		const running: L.ZCodeSessionRunningSubagent[] = [];
		const ended = new Map<string, L.ZCodeSessionEndedSubagent>();
		for (const child of Object.values(persisted).filter(child => child.parent === null)) {
			if (!child.header?.id || child.malformedRecords) throw new Error("Subagent history identity is invalid");
			const ref = refs.find(ref => ref.id === child.agentId);
			if (ref?.status === "running") continue;
			const assistant = child.entries.findLast(
				entry => entry.type === "message" && entry.message.role === "assistant",
			);
			const last =
				assistant?.type === "message" && assistant.message.role === "assistant" ? assistant.message : undefined;
			ended.set(child.header.id, {
				childSessionId: child.header.id,
				agentId: child.agentId,
				subagentType: ref?.history?.agent ?? "task",
				title: ref?.displayName ?? child.agentId,
				summary: ref?.activity,
				startedAt: new Date(child.header.timestamp).getTime(),
				endedAt: ref?.lifecycle?.terminalAt,
				status:
					child.aborted || ref?.status === "aborted" || last?.stopReason === "aborted"
						? "cancelled"
						: last?.stopReason === "error"
							? "failed"
							: ref?.lifecycle?.acceptedAt || last?.stopReason === "stop"
								? "success"
								: "lost",
			});
		}
		for (const ref of refs) {
			const childSessionId =
				ref.session?.sessionId ??
				Object.values(persisted).find(child => child.parent === null && child.agentId === ref.id)?.header?.id;
			if (!childSessionId) throw new Error(`Subagent ${ref.id} has no authoritative session identity`);
			const base = {
				childSessionId,
				agentId: ref.id,
				subagentType: ref.history?.agent ?? "task",
				title: ref.displayName,
				summary: ref.activity,
				startedAt: ref.createdAt,
			};
			if (ref.status === "running") running.push({ ...base, status: "running" });
			else if (!ended.has(childSessionId))
				ended.set(childSessionId, {
					...base,
					status: ref.status === "aborted" ? "cancelled" : ref.lifecycle?.acceptedAt ? "success" : "lost",
					endedAt: ref.lifecycle?.terminalAt,
				});
		}
		const items = [...ended.values()].sort((a, b) => a.childSessionId.localeCompare(b.childSessionId));
		const fingerprint = createHash("sha256").update(JSON.stringify(items)).digest("hex");
		let offset = 0;
		if (params.endedCursor) {
			const cursor = JSON.parse(Buffer.from(params.endedCursor, "base64url").toString("utf8")) as {
				fingerprint: string;
				offset: number;
			};
			if (
				cursor.fingerprint !== fingerprint ||
				!Number.isSafeInteger(cursor.offset) ||
				cursor.offset < 0 ||
				cursor.offset > items.length
			)
				throw new Error("Subagent cursor expired");
			offset = cursor.offset;
		}
		const nextOffset = offset + params.endedLimit;
		return L.zcodeSessionSubagentsResultSchema.parse({
			revision: (await this.#options.getProjection(params.sessionId)).snapshot().subagents?.revision ?? 0,
			childSessionIds: [
				...new Set([...running.map(child => child.childSessionId), ...items.map(child => child.childSessionId)]),
			],
			running,
			ended: {
				total: items.length,
				items: items.slice(offset, nextOffset),
				...(nextOffset < items.length
					? { nextCursor: Buffer.from(JSON.stringify({ fingerprint, offset: nextOffset })).toString("base64url") }
					: {}),
			},
		});
	}

	async messages(sessionId: string): Promise<L.ZCodeSessionStateSnapshot["messages"]> {
		const read = await this.#options.manager.read(sessionId);
		const projection = await this.#options.getProjection(sessionId);
		const rows = projection.rows();
		const results = new Map(
			read.messages.filter(message => message.role === "toolResult").map(message => [message.toolCallId, message]),
		);
		let parentMessageId = `${sessionId}:root`;
		const messages: L.ZCodeSessionStateSnapshot["messages"] = [];
		for (const [index, message] of read.messages.entries()) {
			if (message.role !== "user" && message.role !== "assistant" && message.role !== "custom") continue;
			const inputId = (message as AgentMessage & { inputId?: string }).inputId;
			const entity = `${sessionId}:${inputId ?? `${message.role}:${message.timestamp ?? 0}:${index}`}`;
			const messageId =
				message.role === "assistant"
					? `${entity}:response`
					: message.role === "user"
						? `${entity}:input`
						: `${entity}:custom`;
			const base = { messageId, sessionId, agent: "Main", time: { created: message.timestamp } };
			const info =
				message.role === "assistant"
					? {
							...base,
							role: "assistant",
							parentMessageId,
							path: { cwd: read.cwd, root: read.cwd },
							model: { providerId: message.provider, modelId: message.model },
							cost: message.usage.cost.total,
							tokens: {
								input: message.usage.input,
								output: message.usage.output,
								reasoning: 0,
								cache: { read: message.usage.cacheRead, write: message.usage.cacheWrite },
							},
							finish: message.stopReason,
						}
					: {
							...base,
							role: "user",
							...(message.role === "custom"
								? {
										synthetic: true,
										semantics: {
											origin: "system",
											kind: "timeline_event",
											uiVisibility: "visible",
											providerVisibility: "hidden",
											transcriptVisibility: "visible",
											source: message.customType,
										},
									}
								: {}),
						};
			const parts: unknown[] = [];
			for (const row of rows) {
				if (!row.entityId?.startsWith(`${entity}:`)) continue;
				const partBase = { messageId, sessionId, partId: row.entityId };
				if (row.kind === "userInput" || row.kind === "assistantText" || row.kind === "reasoning")
					parts.push({ ...partBase, type: row.kind === "reasoning" ? "reasoning" : "text", text: row.text });
				if (row.kind === "userInput")
					for (const [attachmentIndex, attachment] of (row.attachments ?? []).entries())
						parts.push({
							...partBase,
							partId: `${row.entityId}:attachment:${attachmentIndex}`,
							type: "file",
							mime: attachment.mime,
							filename: attachment.fileName,
							url: attachment.ref,
						});
				if (row.kind !== "toolCall") continue;
				const result = results.get(row.toolCallId);
				const input = row.input && typeof row.input === "object" && !Array.isArray(row.input) ? row.input : {};
				const startedAt = row.createdAt;
				const completedAt = result?.timestamp;
				if (completedAt === undefined && ["success", "error", "cancelled"].includes(row.status)) {
					// A historical interrupted call may have no tool-result timestamp. Do not invent one
					// merely to satisfy the legacy terminal tool shape's mandatory clock fields.
					parts.push({
						...partBase,
						type: "text",
						text: row.output?.text ?? row.error?.message ?? row.status,
						metadata: { toolCallId: row.toolCallId, toolName: row.toolName, canonicalStatus: row.status },
					});
					continue;
				}
				const state =
					row.status === "success" && completedAt !== undefined
						? {
								status: "completed",
								input,
								output: row.output?.text ?? "",
								title: row.toolName,
								metadata: row.output?.display ? { display: row.output.display } : {},
								startedAt,
								completedAt,
							}
						: (row.status === "error" || row.status === "cancelled") && completedAt !== undefined
							? {
									status: "error",
									input,
									error: row.error?.message ?? row.output?.text ?? row.status,
									startedAt,
									completedAt,
								}
							: row.status === "inputStreaming" || row.status === "pendingApproval"
								? { status: "pending", input, raw: row.inputText ?? "" }
								: {
										status: "running",
										input,
										title: row.toolName,
										metadata: { canonicalStatus: row.status },
										startedAt,
									};
				parts.push({ ...partBase, type: "tool", callId: row.toolCallId, tool: row.toolName, state });
			}
			if (!parts.length && message.role === "custom")
				parts.push({
					messageId,
					sessionId,
					partId: `${entity}:custom`,
					type: "text",
					text:
						typeof message.content === "string"
							? message.content
							: message.content
									.filter(block => block.type === "text")
									.map(block => block.text)
									.join("\n"),
				});
			messages.push(L.zcodeSessionMessagesResultSchema.parse({ messages: [{ info, parts }] }).messages[0]);
			if (message.role === "user") parentMessageId = messageId;
		}
		return messages;
	}

	async debug(raw: unknown) {
		const { sessionId } = sessionDebugParamsSchema.parse(raw);
		const { messages } = await this.#options.manager.read(sessionId);
		const rounds = messages.flatMap((message, index) => {
			if (message.role !== "assistant") return [];
			const inputId = (message as AgentMessage & { inputId?: string }).inputId;
			const requestId = `${sessionId}:${inputId ?? `assistant:${message.timestamp ?? 0}:${index}`}:response`;
			const usage = message.usage;
			const input = usage.input + usage.cacheRead + usage.cacheWrite;
			return [
				{
					eventKey: requestId,
					requestId,
					requestIndex: index,
					recordedAt: message.timestamp,
					usage: {
						inputTokens: usage.input,
						outputTokens: usage.output,
						totalTokens: input + usage.output,
						cachedInputTokens: usage.cacheRead,
						cachedWriteInputTokens: usage.cacheWrite,
					},
					hitRate: input > 0 ? usage.cacheRead / input : null,
					generationDurationMs: null,
					tokensPerSecond: null,
				},
			];
		});
		const totalInputTokens = rounds.reduce(
			(sum, round) =>
				sum +
				(round.usage.inputTokens ?? 0) +
				(round.usage.cachedInputTokens ?? 0) +
				(round.usage.cachedWriteInputTokens ?? 0),
			0,
		);
		const totalCacheReadTokens = rounds.reduce((sum, round) => sum + (round.usage.cachedInputTokens ?? 0), 0);
		return sessionDebugSnapshotSchema.parse({
			sessionId,
			rounds: rounds.slice(-200),
			networkEntries: [],
			cache: rounds.length
				? {
						hitRateRequestCount: rounds.filter(round => round.hitRate !== null).length,
						totalInputTokens,
						totalCacheReadTokens,
						hitRate: totalInputTokens > 0 ? totalCacheReadTokens / totalInputTokens : null,
					}
				: null,
		});
	}

	#emit(entry: Entry, type: L.ZCodeSessionEvent["type"], payload?: unknown, turnId?: string): void {
		const seq = ++entry.seq;
		const event = L.zcodeSessionEventSchema.parse({
			eventId: `${entry.previous.logEpoch}:legacy:${seq}`,
			sessionId: entry.previous.sessionId,
			seq,
			timestamp: Date.now(),
			type,
			...(payload === undefined ? {} : { payload }),
			...(turnId ? { turnId } : {}),
		});
		entry.events.push(event);
		const limit = Math.max(1, this.#options.eventLimit ?? 2000);
		if (entry.events.length > limit) entry.events.splice(0, entry.events.length - limit);
		for (const deliveryKind of entry.deliveries) this.#options.notify("session/event", { ...event, deliveryKind });
	}

	#project(entry: Entry): void {
		const next = entry.projection.snapshot();
		const previous = entry.previous;
		if (previous.logEpoch !== next.logEpoch) {
			// Legacy has no epoch cursor: retain monotonic sequence, invalidate removed history explicitly.
			this.#emit(entry, "rewind.triggered", { logEpoch: next.logEpoch });
		}
		if (next.meta.title !== previous.meta.title || next.meta.titleSource !== previous.meta.titleSource)
			this.#emit(entry, "session.titleUpdated", {
				title: next.meta.title,
				previousTitle: previous.meta.title,
				source: next.meta.titleSource,
			});
		const priorRows = new Map(previous.rows.window.map(row => [row.entityId, row]));
		for (const row of next.rows.window) {
			const old = priorRows.get(row.entityId);
			if (JSON.stringify(old) === JSON.stringify(row)) continue;
			this.#row(entry, row, old);
		}
		for (const row of previous.rows.window)
			if (!next.rows.window.some(candidate => candidate.entityId === row.entityId))
				this.#emit(entry, "message.removed", { messageId: row.entityId, reason: "branch_changed" }, row.turnId);
		if (next.control.phase === "running" && previous.control.phase !== "running") {
			entry.startedAt = Date.now();
			entry.startTokens = next.usage.cumulative.inputTokens + next.usage.cumulative.outputTokens;
		}
		if (
			previous.control.phase === "running" &&
			["completedSuccess", "completedInterrupted", "error"].includes(next.control.phase)
		) {
			// Required duration/usage payload is omitted if no observed start exists; schema permits absent payload.
			const turn = next.rows.window.findLast(row => row.kind === "turnHeader")?.turnId;
			if (next.control.lastError)
				this.#emit(
					entry,
					"turn.failed",
					{
						error: {
							type: "runtime",
							code: next.control.lastError.code,
							message: next.control.lastError.message,
						},
						turnPhase: next.control.phase,
					},
					turn,
				);
			else
				this.#emit(
					entry,
					"turn.completed",
					entry.startedAt === undefined || entry.startTokens === undefined
						? undefined
						: {
								response: next.rows.window
									.filter(row => row.turnId === turn && row.kind === "assistantText")
									.map(row => (row.kind === "assistantText" ? row.text : ""))
									.join("\n"),
								tokenCount: Math.max(
									0,
									next.usage.cumulative.inputTokens + next.usage.cumulative.outputTokens - entry.startTokens,
								),
								toolCallCount: next.rows.window.filter(row => row.turnId === turn && row.kind === "toolCall")
									.length,
								duration: Date.now() - entry.startedAt,
								resultType: next.control.phase === "completedInterrupted" ? "cancelled" : "success",
							},
					turn,
				);
			entry.startedAt = undefined;
			entry.startTokens = undefined;
		}
		this.#emit(entry, "session.updated", {
			phase: next.control.phase,
			sessionEnded: next.control.sessionEnded,
			revision: next.revision,
		});
		entry.previous = next;
	}

	#row(entry: Entry, row: ConversationRow, old?: ConversationRow): void {
		if (row.kind === "userInput" && !old)
			this.#emit(
				entry,
				"turn.started",
				{
					input: row.text,
					inputId: row.sourceCommandId,
					turnNumber: entry.projection.rows().filter(candidate => candidate.kind === "turnHeader").length,
				},
				row.turnId,
			);
		if (row.kind === "assistantText" || row.kind === "reasoning" || row.kind === "userInput") {
			this.#emit(entry, "message.upserted", { content: row.text, type: row.kind }, row.turnId);
			if (row.kind !== "userInput")
				this.#emit(
					entry,
					"model.streaming",
					{
						kind: row.kind === "reasoning" ? "reasoning_delta" : "text_delta",
						assistantMessageId: "assistantResponseId" in row ? row.assistantResponseId : row.entityId,
						partId: row.entityId,
						delta:
							old && "text" in old && row.text.startsWith(old.text) ? row.text.slice(old.text.length) : row.text,
						done: row.state !== "streaming",
					},
					row.turnId,
				);
		}
		if (row.kind !== "toolCall") return;
		const base = { toolCallId: row.toolCallId, toolName: row.toolName };
		if (!old || old.kind !== "toolCall") {
			if (row.status !== "success" && row.status !== "error" && row.status !== "cancelled")
				entry.toolStarts.set(row.toolCallId, Date.now());
			this.#emit(
				entry,
				"tool.updated",
				{ ...base, kind: "scheduled", input: row.input, assistantMessageId: row.assistantResponseId },
				row.turnId,
			);
		}
		if (row.status === "running" && (old?.kind !== "toolCall" || old.status !== "running"))
			this.#emit(entry, "tool.updated", { ...base, kind: "started", startedAt: Date.now() }, row.turnId);
		if (row.status === "error")
			this.#emit(
				entry,
				"tool.updated",
				{
					...base,
					kind: "error",
					error: { type: "tool", message: row.error?.message ?? row.output?.text ?? "Tool failed" },
				},
				row.turnId,
			);
		else if (row.status === "success") {
			const startedAt = entry.toolStarts.get(row.toolCallId);
			this.#emit(
				entry,
				"tool.updated",
				startedAt === undefined
					? { ...base, kind: "raw", payload: { status: row.status, output: row.output } }
					: {
							...base,
							kind: "result",
							result: { text: row.output?.text, display: row.output?.display },
							duration: Date.now() - startedAt,
						},
				row.turnId,
			);
		} else if (row.status === "cancelled")
			this.#emit(
				entry,
				"tool.updated",
				{ ...base, kind: "raw", payload: { status: "cancelled", output: row.output } },
				row.turnId,
			);
		else if (row.output?.text !== (old?.kind === "toolCall" ? old.output?.text : undefined))
			this.#emit(entry, "tool.updated", { ...base, kind: "progress", stdoutTail: row.output?.text }, row.turnId);
	}

	disposeSession(id: string): void {
		const entry = this.#entries.get(id);
		if (entry) {
			this.#emit(entry, "session.closed", { reason: "closed" });
			entry.unsubscribe();
			this.#entries.delete(id);
		}
		for (const key of this.#attempts.keys()) if (key.startsWith(`${id}\0`)) this.#attempts.delete(key);
	}
	dispose(): void {
		this.#disposed = true;
		for (const id of this.#entries.keys()) this.disposeSession(id);
		this.#attempts.clear();
	}
}
