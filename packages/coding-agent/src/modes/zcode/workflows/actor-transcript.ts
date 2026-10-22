import { createHash } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionManager } from "../../../session/session-manager.js";
import { WorkflowError, type ActorSessionSeed } from "./vendor/dynamic-workflow/index.js";

export interface TranscriptLogger {
	info?(message: string, fields?: Record<string, unknown>): void;
	warn?(message: string, fields?: Record<string, unknown>): void;
}

/** All three readers (cache, boundary accounting and seeding) use native hydrated messages. */
export interface ActorTranscriptStore {
	messages(input: { sessionID: string }): Promise<readonly AgentMessage[]>;
}
export function makeActorTranscriptStore(reader: {
	read(sessionId: string): Promise<{ messages: readonly AgentMessage[] }>;
}): ActorTranscriptStore {
	return { messages: async ({ sessionID }) => (await reader.read(sessionID)).messages };
}
export async function countActorTranscript(store: ActorTranscriptStore, sessionId: string): Promise<number> {
	return (await store.messages({ sessionID: sessionId })).length;
}

const SEED_ENTRY = "zcode.workflow.actor-seed";
const digest = (message: AgentMessage) => createHash("sha256").update(JSON.stringify(message)).digest("hex");
type SeedMarker = { sourceSessionId: string; index: number; digest: string };
function isMarker(value: unknown): value is SeedMarker {
	if (typeof value !== "object" || value === null) return false;
	const marker = value as Partial<SeedMarker>;
	return (
		typeof marker.sourceSessionId === "string" &&
		Number.isSafeInteger(marker.index) &&
		typeof marker.digest === "string"
	);
}

/**
 * Native adaptation of the pinned workflow-actor-transcript.ts seed invariants.
 * Native entries allocate their own IDs; a durable, non-message marker pairs each copied
 * entry with its source ordinal instead of importing Core message/part IDs or storage.
 * A partial prefix can be completed, but any target-owned message permanently closes seeding.
 * Call before hosting/hydrating the actor, never after its first ask.
 */
export async function seedActorTranscript(input: {
	logger?: TranscriptLogger;
	seed: ActorSessionSeed;
	store: ActorTranscriptStore;
	target: Pick<SessionManager, "getBranch" | "appendCustomEntry" | "appendMessage" | "ensureOnDisk" | "flush">;
	targetSessionId: string;
}): Promise<number | undefined> {
	const { seed, store, target, logger, targetSessionId } = input;
	if (!Number.isSafeInteger(seed.messageCount) || seed.messageCount < 0) {
		throw new WorkflowError("DriverError", "Invalid actor transcript seed boundary");
	}
	let copied = 0;
	let pending: SeedMarker | undefined;
	for (const entry of target.getBranch()) {
		if (entry.type === "custom" && entry.customType === SEED_ENTRY && isMarker(entry.data)) {
			pending = entry.data;
			continue;
		}
		if (
			entry.type === "custom_message" ||
			entry.type === "compaction" ||
			entry.type === "branch_summary" ||
			entry.type === "reset_boundary"
		) {
			return undefined;
		}
		if (entry.type !== "message") continue;
		if (
			!pending ||
			pending.sourceSessionId !== seed.sourceSessionId ||
			pending.index !== copied ||
			pending.digest !== digest(entry.message)
		) {
			logger?.warn?.("Dynamic workflow actor session already has its own history; seeding skipped", {
				sessionId: targetSessionId,
				messageCount: seed.messageCount,
			});
			return undefined;
		}
		copied++;
		pending = undefined;
	}
	if (copied >= seed.messageCount) return undefined;
	const source = await store.messages({ sessionID: seed.sourceSessionId });
	if (source.length < seed.messageCount) {
		throw new WorkflowError(
			"DriverError",
			`Cannot seed the subagent transcript: source session ${seed.sourceSessionId} has only ${source.length} messages, but the boundary requires the first ${seed.messageCount}.`,
			{
				mismatch: { expected: String(seed.messageCount), got: String(source.length) },
			},
		);
	}
	for (let index = copied; index < seed.messageCount; index++) {
		const message = source[index]!;
		target.appendCustomEntry(SEED_ENTRY, {
			sourceSessionId: seed.sourceSessionId,
			index,
			digest: digest(message),
		} satisfies SeedMarker);
		// Clone by value: tool call IDs and result IDs stay paired within the native transcript.
		target.appendMessage(structuredClone(message) as Parameters<SessionManager["appendMessage"]>[0]);
	}
	await target.ensureOnDisk();
	await target.flush();
	return seed.messageCount;
}
