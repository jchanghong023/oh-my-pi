import { describe, expect, it } from "bun:test";
import type { AgentUserMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../../src/config/settings";
import { cfgMemoryBackend } from "../../src/memory-backend/settings";
import { adoptZCodeMemoryPreference, ZCodeConversationTelemetry } from "../../src/modes/zcode/memory-telemetry";
import { ZCodeProjection } from "../../src/modes/zcode/projection";
import {
	conversationTelemetryFactSchema,
	type ConversationTelemetryFact,
} from "../../src/modes/zcode/schema/vendor/zcode-protocol-v4/telemetry";

function assistant(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Actual response" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		usage: {
			input: 10,
			output: 4,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: 16,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 100,
	};
}

describe("ZCode creation-time native memory", () => {
	it("disables only the owned instance and freezes adopted metadata", () => {
		const enabled = Settings.isolated({ "memory.backend": "mnemopi" });
		const disabled = Settings.isolated({ "memory.backend": "mnemopi" });
		const adopted = adoptZCodeMemoryPreference(disabled, false);
		expect(adopted).toEqual({ memoryEnabled: false, backend: "off" });
		expect(cfgMemoryBackend.get(disabled)).toBe("off");
		expect(cfgMemoryBackend.get(enabled)).toBe("mnemopi");
		cfgMemoryBackend.override(disabled, "local");
		expect(adopted.memoryEnabled).toBe(false);
		expect(Object.isFrozen(adopted)).toBe(true);
	});
	it("enables local only when native selection is off, retaining selected backends", () => {
		for (const backend of ["off", "local", "hindsight", "mnemopi", "sharpshooter"] as const) {
			const settings = Settings.isolated({ "memory.backend": backend });
			const adopted = adoptZCodeMemoryPreference(settings, true);
			expect(adopted).toEqual({ memoryEnabled: true, backend: backend === "off" ? "local" : backend });
			expect(cfgMemoryBackend.get(settings)).toBe(adopted.backend);
		}
	});
	it("preserves native effective selection when Host has no preference", () => {
		expect(adoptZCodeMemoryPreference(Settings.isolated())).toEqual({ memoryEnabled: false, backend: "off" });
		expect(adoptZCodeMemoryPreference(Settings.isolated({ "memory.backend": "local" }))).toEqual({
			memoryEnabled: true,
			backend: "local",
		});
	});
});

describe("native live execution telemetry", () => {
	it("projects actual streams/tools/usage and only terminal agent_end with canonical identity", () => {
		const facts: ConversationTelemetryFact[] = [];
		const telemetry = new ZCodeConversationTelemetry({
			sessionId: "native-session",
			memoryEnabled: true,
			identity: () => ({ sourceCommandId: "command-1", turnId: "canonical-turn-1" }),
			emit: fact => facts.push(conversationTelemetryFactSchema.parse(fact)),
		});
		const message = assistant();
		telemetry.consume({ type: "agent_start" });
		telemetry.consume({ type: "turn_start" });
		telemetry.consume({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Actual", partial: message },
		});
		telemetry.consume({
			type: "tool_execution_start",
			toolCallId: "learn-1",
			toolName: "learn",
			args: { content: "lesson" },
		});
		telemetry.consume({
			type: "tool_execution_end",
			toolCallId: "learn-1",
			toolName: "learn",
			result: { content: [] },
		});
		telemetry.consume({ type: "message_end", message });
		telemetry.consume({ type: "turn_end", message, toolResults: [] });
		telemetry.consume({ type: "agent_end", messages: [message], isTerminal: false });
		expect(facts.some(fact => fact.kind === "turn.terminal")).toBe(false);
		telemetry.consume({ type: "agent_start" });
		telemetry.consume({ type: "agent_end", messages: [message], isTerminal: true });
		expect(facts.map(fact => fact.kind)).toEqual([
			"turn.started",
			"stream.chunk",
			"tool.lifecycle",
			"tool.lifecycle",
			"usage.delta",
			"turn.terminal",
		]);
		expect(facts.at(-1)).toMatchObject({ status: "success", tokenCount: 16, toolCallCount: 1 });
		expect(
			facts.every(
				fact => fact.memoryEnabled && fact.sourceCommandId === "command-1" && fact.turnId === "canonical-turn-1",
			),
		).toBe(true);
		expect(new Set(facts.map(fact => fact.eventId)).size).toBe(facts.length);
		telemetry.consume({ type: "agent_end", messages: [message] });
		expect(facts.filter(fact => fact.kind === "turn.terminal")).toHaveLength(1);
	});
	it("preserves admitted automation attribution so Host-dispatched turns seed the telemetry lifecycle", () => {
		for (const [sourceCommandId, expected] of [
			["automation-1:manual:run-1", { automationId: "automation-1", taskTrigger: "manual" }],
			[
				"automation-1:1700000000000",
				{ automationId: "automation-1", taskTrigger: "schedule", scheduledAt: 1700000000000 },
			],
			["another-automation:manual:run-1", { automationId: "automation-1" }],
			["automation-1:manual:", { automationId: "automation-1" }],
			["automation-1:not-a-time", { automationId: "automation-1" }],
		] as const) {
			const facts: ConversationTelemetryFact[] = [];
			const input: AgentUserMessage = {
				role: "user",
				content: "Actual automation prompt",
				timestamp: 100,
				inputId: sourceCommandId,
				sourceCommand: {
					sessionId: "automation-session",
					commandId: sourceCommandId,
					fingerprint: "admitted",
					automationId: "automation-1",
				},
			};
			const projection = new ZCodeProjection({ sessionId: "automation-session", cwd: "/work", messages: [input] });
			const turnId = projection.telemetryIdentity()?.turnId;
			expect(turnId).toBeTruthy();
			const telemetry = new ZCodeConversationTelemetry({
				sessionId: "automation-session",
				memoryEnabled: false,
				identity: () => projection.telemetryIdentity(),
				emit: fact => facts.push(conversationTelemetryFactSchema.parse(fact)),
			});
			const message = assistant();
			telemetry.consume({ type: "agent_start" });
			telemetry.consume({ type: "turn_start" });
			expect(facts).toEqual([]);
			telemetry.consume({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Actual", partial: message },
			});
			telemetry.consume({ type: "message_end", message });
			telemetry.consume({ type: "agent_end", messages: [message], isTerminal: true });
			expect(facts[0]).toMatchObject({
				kind: "turn.started",
				sessionId: "automation-session",
				sourceCommandId,
				turnId,
				executionKind: "agent",
				...expected,
			});
			expect(facts[0] && Object.hasOwn(facts[0], "taskTrigger")).toBe("taskTrigger" in expected);
			expect(facts[0] && Object.hasOwn(facts[0], "scheduledAt")).toBe("scheduledAt" in expected);
			expect(facts.map(fact => fact.kind)).toEqual(["turn.started", "stream.chunk", "usage.delta", "turn.terminal"]);
			expect(facts.at(-1)).toMatchObject({
				kind: "turn.terminal",
				sourceCommandId,
				status: "success",
				tokenCount: 16,
			});
			projection.dispose();
		}
	});
	it("does not replay cold messages or fabricate completion from empty lifecycle", () => {
		const facts: ConversationTelemetryFact[] = [];
		const telemetry = new ZCodeConversationTelemetry({
			sessionId: "cold",
			memoryEnabled: false,
			identity: () => undefined,
			emit: fact => facts.push(fact),
		});
		telemetry.consume({ type: "message_end", message: assistant() });
		telemetry.consume({ type: "agent_end", messages: [assistant()] });
		telemetry.consume({ type: "agent_start" });
		telemetry.consume({ type: "agent_end", messages: [] });
		expect(facts).toEqual([]);
	});
	it("reports native cancellation and closes without synthesizing more facts", () => {
		const facts: ConversationTelemetryFact[] = [];
		const telemetry = new ZCodeConversationTelemetry({
			sessionId: "cancelled",
			memoryEnabled: false,
			identity: () => ({ sourceCommandId: "command", turnId: "turn" }),
			emit: fact => facts.push(conversationTelemetryFactSchema.parse(fact)),
		});
		telemetry.consume({ type: "agent_start" });
		telemetry.consume({ type: "session_abort" });
		telemetry.consume({ type: "agent_end", messages: [] });
		expect(facts.at(-1)).toMatchObject({ kind: "turn.terminal", status: "interrupted", memoryEnabled: false });
		telemetry.close();
		telemetry.consume({ type: "agent_start" });
		expect(facts).toHaveLength(2);
	});
});
