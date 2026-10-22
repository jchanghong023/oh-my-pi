import { describe, expect, test } from "bun:test";
import type { AgentMessage, AgentUserMessage } from "@oh-my-pi/pi-agent-core";
import type { ZCodeSessionRecord } from "../../src/modes/zcode/sessions";
import { LegacySessionBridge } from "../../src/modes/zcode/legacy-session";
import { ZCodeProjection } from "../../src/modes/zcode/projection";
import { LegacyProtocol as L, sessionDebugSnapshotSchema } from "../../src/modes/zcode/schema";

function fixture(limit = 32, messages: AgentMessage[] = []) {
	const projection = new ZCodeProjection({ sessionId: "a", cwd: process.cwd(), messages });
	const delivered: L.ZCodeSessionEvent[] = [];
	const bridge = new LegacySessionBridge({
		manager: { read: async () => ({ cwd: process.cwd(), messages }) },
		getProjection: async id => {
			if (id !== "a") throw new Error("missing");
			return projection;
		},
		snapshot: async () => {
			throw new Error("snapshot not requested");
		},
		notify: (_method, event) => {
			delivered.push(event);
		},
		eventLimit: limit,
	});
	bridge.attach(undefined, projection);
	return { projection, bridge, delivered };
}

describe("legacy sessions share canonical projection", () => {
	test("delivery kinds retain stable identity, sequence, title and terminal events", async () => {
		const { bridge, projection, delivered } = fixture();
		await bridge.subscribe({ sessionId: "a", deliveryKind: "desktop-continuous" });
		await bridge.subscribe({ sessionId: "a", deliveryKind: "web-remote-replayable" });
		projection.applyEvent({ type: "agent_start" });
		projection.setState({ meta: { title: "Observed title", titleSource: "custom" } });
		projection.applyEvent({ type: "agent_end", messages: [] });
		const replay = await bridge.events({ sessionId: "a" });
		expect(replay.events.some(event => event.type === "session.titleUpdated")).toBe(true);
		expect(replay.events.some(event => event.type === "turn.completed")).toBe(true);
		expect(
			delivered.filter(event => event.deliveryKind === "desktop-continuous").map(event => event.eventId),
		).toEqual(replay.events.map(event => event.eventId));
		for (const event of delivered) expect(L.zcodeSessionEventSchema.safeParse(event).success).toBe(true);
		bridge.dispose();
		projection.dispose();
	});

	test("bounded replay rejects missing cursor, retry replaces listener, close rejects late events", async () => {
		const { bridge, projection, delivered } = fixture(2);
		await bridge.subscribe({ sessionId: "a", deliveryKind: "desktop-continuous" });
		await bridge.subscribe({ sessionId: "a", deliveryKind: "desktop-continuous" });
		for (let i = 0; i < 4; i++) projection.setState({ meta: { title: `title ${i}`, titleSource: "custom" } });
		expect(delivered.filter(event => event.type === "session.titleUpdated")).toHaveLength(4);
		await expect(bridge.events({ sessionId: "a", afterSeq: 1 })).rejects.toThrow("cursor");
		bridge.disposeSession("a");
		const count = delivered.length;
		projection.setState({ meta: { title: "late", titleSource: "custom" } });
		expect(delivered).toHaveLength(count);
		bridge.dispose();
		projection.dispose();
	});

	test("tool lifecycle uses the canonical tool and response identities", async () => {
		const { bridge, projection, delivered } = fixture();
		await bridge.subscribe({ sessionId: "a", deliveryKind: "desktop-continuous" });
		projection.applyEvent({
			type: "message_start",
			message: {
				role: "assistant",
				timestamp: 123,
				api: "openai-completions",
				provider: "local",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo test" } }],
			},
		});
		projection.applyEvent({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "bash",
			args: { command: "echo test" },
		});
		projection.applyEvent({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "test" }] },
			isError: false,
		});
		const toolEvents = delivered.filter(event => event.type === "tool.updated");
		expect(toolEvents.length).toBeGreaterThan(1);
		for (const event of toolEvents) expect(L.zcodeSessionEventSchema.safeParse(event).success).toBe(true);
		expect(
			toolEvents.some(event => {
				const payload = event.payload;
				return typeof payload === "object" && payload !== null && "kind" in payload && payload.kind === "result";
			}),
		).toBe(true);
		const row = projection.rows().find(row => row.kind === "toolCall");
		expect(row?.kind === "toolCall" && row.toolCallId).toBe("tool-1");
		bridge.unsubscribe({ sessionId: "a", deliveryKind: "desktop-continuous" });
		const count = delivered.length;
		projection.setState({ meta: { title: "unsubscribed", titleSource: "custom" } });
		expect(delivered).toHaveLength(count);
		bridge.dispose();
		projection.dispose();
	});

	test("history keeps reasoning, tools, custom output, attachments and canonical IDs", async () => {
		const input: AgentUserMessage = {
			role: "user",
			timestamp: 100,
			inputId: "input-1",
			content: "read",
			attachments: [{ ref: "attachment:one", fileName: "a.txt", mime: "text/plain", bytes: 3 }],
		};
		const messages: AgentMessage[] = [
			input,
			{
				role: "assistant",
				timestamp: 101,
				api: "openai-completions",
				model: "mock",
				provider: "local",
				content: [
					{ type: "thinking", thinking: "reason" },
					{ type: "toolCall", id: "tool", name: "read", arguments: { path: "a.txt" } },
				],
				usage: {
					input: 10,
					output: 2,
					cacheRead: 3,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "tool",
				toolName: "read",
				timestamp: 102,
				content: [{ type: "text", text: "abc" }],
				isError: false,
			},
			{ role: "custom", customType: "command", timestamp: 103, display: true, content: "command output" },
		];
		const { bridge, projection } = fixture(32, messages);
		const history = await bridge.messages("a");
		expect(history.flatMap(message => message.parts).map(part => part.type)).toEqual([
			"text",
			"file",
			"reasoning",
			"tool",
			"text",
		]);
		expect(history[0].info.messageId).toBe("a:input-1:input");
		const reasoningRow = projection.rows().find(row => row.kind === "reasoning");
		if (!reasoningRow?.entityId) throw new Error("Missing canonical reasoning identity");
		expect(history[1].parts[0].partId).toBe(reasoningRow.entityId);
		const debug = await bridge.debug({ sessionId: "a" });
		expect(debug.rounds[0].usage.cachedInputTokens).toBe(3);
		expect(debug.rounds[0].generationDurationMs).toBeNull();
		bridge.dispose();
		projection.dispose();
	});

	test("ordinary agent directory paginates ended facts without activating children", async () => {
		const projection = new ZCodeProjection({ sessionId: "a", cwd: process.cwd() });
		const registry = {
			list: () =>
				["one", "two"].map((id, index) => ({
					id,
					kind: "sub",
					parentId: "Main",
					status: "idle",
					session: { sessionId: id },
					displayName: id,
					createdAt: index + 1,
					lifecycle: { acceptedAt: 4, terminalAt: 4 },
				})),
		};
		const bridge = new LegacySessionBridge({
			manager: {
				read: async () => ({
					cwd: process.cwd(),
					messages: [],
					info: { path: `${process.cwd()}/nonexistent-legacy-fixture/main.jsonl` },
				}),
			},
			getRecord: () => ({ registry }) as unknown as ZCodeSessionRecord,
			getProjection: () => projection,
			snapshot: async () => {
				throw new Error("not requested");
			},
			notify: () => {},
		});
		const first = await bridge.subagents({ sessionId: "a", endedLimit: 1 });
		expect(first.ended.total).toBe(2);
		expect(first.ended.items).toHaveLength(1);
		const next = await bridge.subagents({ sessionId: "a", endedLimit: 1, endedCursor: first.ended.nextCursor });
		expect(next.ended.items[0].childSessionId).not.toBe(first.ended.items[0].childSessionId);
		expect(next.running).toEqual([]);
		bridge.dispose();
		projection.dispose();
	});

	test("debug reports unknown timings and absent network observations honestly", async () => {
		const { bridge, projection } = fixture();
		const debug = await bridge.debug({ sessionId: "a" });
		expect(sessionDebugSnapshotSchema.safeParse(debug).success).toBe(true);
		expect(debug).toEqual({ sessionId: "a", rounds: [], networkEntries: [], cache: null });
		bridge.dispose();
		projection.dispose();
	});
});
