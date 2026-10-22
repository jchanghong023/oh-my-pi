import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Settings } from "../../config/settings";
import { cfgMemoryBackend } from "../../memory-backend/settings";
import type { MemoryBackendId } from "../../memory-backend/types";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import type { ConversationTelemetryFact } from "./schema/vendor/zcode-protocol-v4/telemetry";

export interface ZCodeAdoptedMemory {
	readonly memoryEnabled: boolean;
	readonly backend: MemoryBackendId;
}

/** Apply only to the session-owned Settings, before constructing its native runtime. */
export function adoptZCodeMemoryPreference(settings: Settings, memoryEnabled?: boolean): ZCodeAdoptedMemory {
	const selected = cfgMemoryBackend.get(settings);
	const backend = memoryEnabled === false ? "off" : memoryEnabled === true && selected === "off" ? "local" : selected;
	cfgMemoryBackend.override(settings, backend);
	return Object.freeze({ memoryEnabled: backend !== "off", backend });
}

export interface ZCodeTelemetryIdentity {
	sourceCommandId: string;
	turnId: string;
	automationId?: string;
}

type FactPayload = ConversationTelemetryFact extends infer Fact
	? Fact extends ConversationTelemetryFact
		? Omit<
				Fact,
				| "version"
				| "eventId"
				| "eventSeq"
				| "occurredAt"
				| "sessionId"
				| "sourceCommandId"
				| "turnId"
				| "memoryEnabled"
			>
		: never
	: never;

export interface ZCodeConversationTelemetryOptions {
	sessionId: string;
	memoryEnabled: boolean;
	identity: () => ZCodeTelemetryIdentity | undefined;
	emit: (fact: ConversationTelemetryFact) => void;
}

/** Live-only projection. Canonical execution identity remains owned by the session/projection. */
export class ZCodeConversationTelemetry {
	readonly #options: ZCodeConversationTelemetryOptions;
	readonly #epoch = randomUUID();
	#seq = 0;
	#running = false;
	#closed = false;
	#active:
		| (ZCodeTelemetryIdentity & { startedAt: number; tools: number; tokens: number; firstChunk: boolean })
		| undefined;
	#lastAssistant: AssistantMessage | undefined;
	#interrupted = false;
	#tools = new Map<string, number>();
	#usageMessages = new Set<AssistantMessage>();

	constructor(options: ZCodeConversationTelemetryOptions) {
		this.#options = options;
	}
	consume(event: AgentSessionEvent): void {
		if (this.#closed) return;
		if (event.type === "agent_start") {
			this.#running = true;
			return;
		}
		if (event.type === "session_abort") this.#interrupted = true;
		if (!this.#running) return;
		// Native turn_start precedes delivery of the user message. Wait until the
		// projection has observed that message instead of binding the prior input.
		if (event.type === "turn_start") return;
		const identity = this.#options.identity();
		if (!this.#active && identity) {
			this.#active = { ...identity, startedAt: Date.now(), tools: 0, tokens: 0, firstChunk: true };
			const automationId = identity.automationId;
			// Host run IDs use automationId:scheduledAt or automationId:manual:uuid.
			// Match the canonical parser: never infer a trigger for unrelated input.
			const separator = identity.sourceCommandId.indexOf(":");
			const runSuffix =
				automationId && separator > 0 && identity.sourceCommandId.slice(0, separator) === automationId
					? identity.sourceCommandId.slice(separator + 1)
					: undefined;
			const manual = runSuffix?.startsWith("manual:") && runSuffix.length > "manual:".length;
			const scheduledAt = runSuffix === undefined ? undefined : Number(runSuffix);
			// ZCodeBackgroundTurnAttribution 的 automation 变体要求 automationId 必填,
			// 条件展开会被推成可选而失配;显式分支构造保证联合可判别。
			const triggerFields = manual
				? { taskTrigger: "manual" as const }
				: scheduledAt !== undefined && Number.isSafeInteger(scheduledAt) && scheduledAt > 0
					? { taskTrigger: "schedule" as const, scheduledAt }
					: {};
			const turnStarted = automationId
				? { kind: "turn.started" as const, executionKind: "agent" as const, automationId, ...triggerFields }
				: { kind: "turn.started" as const, executionKind: "agent" as const, ...triggerFields };
			this.#publish(turnStarted);
		}
		if (!this.#active) return;
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta" || update.type === "thinking_delta") {
				this.#publish({
					kind: "stream.chunk",
					channel: update.type === "text_delta" ? "text" : "thought",
					chunkLength: update.delta.length,
					firstChunk: this.#active.firstChunk,
				});
				this.#active.firstChunk = false;
			}
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message as AssistantMessage;
			this.#lastAssistant = message;
			if (!this.#usageMessages.has(message)) {
				this.#usageMessages.add(message);
				const usage = message.usage;
				this.#active.tokens += usage.totalTokens;
				this.#publish({
					kind: "usage.delta",
					providerId: message.provider,
					modelId: message.model,
					inputTokens: usage.input,
					outputTokens: usage.output,
					totalTokens: usage.totalTokens,
					reasoningTokens: usage.reasoningTokens ?? 0,
					cacheReadTokens: usage.cacheRead,
					cacheWriteTokens: usage.cacheWrite,
				});
			}
		}
		if (event.type === "tool_execution_start") {
			this.#tools.set(event.toolCallId, Date.now());
			this.#active.tools++;
			this.#publish({
				kind: "tool.lifecycle",
				phase: "started",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
			});
		}
		if (event.type === "tool_execution_update" || event.type === "tool_stream_update")
			this.#publish({
				kind: "tool.lifecycle",
				phase: "progress",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
			});
		if (event.type === "tool_execution_end") {
			const startedAt = this.#tools.get(event.toolCallId);
			this.#tools.delete(event.toolCallId);
			this.#publish({
				kind: "tool.lifecycle",
				phase: event.isError ? "failed" : "completed",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }),
			});
		}
		// A native assistant turn_end may be followed by tools, retries, or async work.
		if (event.type !== "agent_end" || event.isTerminal === false) return;
		const last = event.messages.findLast(message => message.role === "assistant") as AssistantMessage | undefined;
		const assistant = last ?? this.#lastAssistant;
		// An empty end is not evidence of a successful model completion.
		if (assistant || this.#interrupted)
			this.#publish({
				kind: "turn.terminal",
				status:
					this.#interrupted || assistant?.stopReason === "aborted"
						? "interrupted"
						: assistant?.stopReason === "error"
							? "failed"
							: "success",
				durationMs: Date.now() - this.#active.startedAt,
				tokenCount: this.#active.tokens,
				toolCallCount: this.#active.tools,
				...(assistant?.errorMessage ? { errorMessage: assistant.errorMessage } : {}),
			});
		this.#active = undefined;
		this.#lastAssistant = undefined;
		this.#running = false;
		this.#interrupted = false;
		this.#tools.clear();
		this.#usageMessages.clear();
	}

	#publish(payload: FactPayload): void {
		if (!this.#active) return;
		const eventSeq = ++this.#seq;
		this.#options.emit({
			...payload,
			version: 1,
			eventId: `${this.#epoch}:${eventSeq}`,
			eventSeq,
			occurredAt: Date.now(),
			sessionId: this.#options.sessionId,
			sourceCommandId: this.#active.sourceCommandId,
			turnId: this.#active.turnId,
			memoryEnabled: this.#options.memoryEnabled,
		} as ConversationTelemetryFact);
	}

	close(): void {
		this.#closed = true;
		this.#active = undefined;
		this.#tools.clear();
		this.#usageMessages.clear();
	}
}
