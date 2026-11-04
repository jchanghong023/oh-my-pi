import { afterEach, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { IrcBus } from "../src/irc/bus";
import { AgentRegistry } from "../src/registry/agent-registry";
import { AgentLifecycleManager } from "../src/registry/agent-lifecycle";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { WriteTool } from "../src/tools/write";
import type { ToolSession } from "../src/tools";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	IrcBus.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

it("retains real bus identity in write receipts through disk reload without inventing failed-send identity", async () => {
	using root = TempDir.createSync("@omp-irc-receipts-");
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	const registry = AgentRegistry.global();
	registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
	const received: IrcMessage[] = [];
	registry.register({
		id: "Peer",
		displayName: "Peer",
		kind: "sub",
		parentId: "Main",
		status: "running",
		session: {
			deliverIrcMessage: async (message: IrcMessage) => {
				received.push(message);
				return "injected";
			},
		} as unknown as AgentSession,
	});
	const writer = SessionManager.create(root.path(), root.join("sessions"));
	let restored: SessionManager | undefined;
	try {
		const session = {
			cwd: root.path(),
			hasUI: false,
			settings: Settings.isolated(),
			agentRegistry: registry,
			getSessionFile: () => writer.getSessionFile(),
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
		} as ToolSession;
		const tool = new WriteTool(session);
		for (const id of ["send-1", "send-2"]) {
			const result = await tool.execute(id, { path: "agent://Peer", content: "same message text" });
			const actual = received.at(-1)!;
			expect(result.details?.message?.receipts).toEqual([
				{ to: "Peer", outcome: "injected", id: actual.id, ts: actual.ts },
			]);
			expect(typeof actual.id).toBe("string");
			expect(actual.id.length).toBeGreaterThan(0);
			expect(Number.isFinite(actual.ts)).toBe(true);
			writer.appendMessage({
				role: "toolResult",
				toolName: "write",
				toolCallId: id,
				content: result.content,
				details: result.details,
				isError: false,
				timestamp: actual.ts,
			});
		}
		expect(received[0].id).not.toBe(received[1].id);
		const failed = await tool.execute("missing", { path: "agent://Missing", content: "same message text" });
		expect(failed.isError).toBe(true);
		const receipt = failed.details?.message?.receipts?.[0];
		expect(receipt).toMatchObject({ to: "Missing", outcome: "failed" });
		expect(receipt).not.toHaveProperty("id");
		expect(receipt).not.toHaveProperty("ts");
		await writer.ensureOnDisk();
		await writer.flush();
		const file = writer.getSessionFile();
		if (!file) throw new Error("Missing durable session");
		await writer.close();
		restored = await SessionManager.open(file);
		const messages = restored
			.getEntries()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(messages).toHaveLength(2);
		for (const [index, message] of messages.entries()) {
			expect(message.details).toMatchObject({
				message: { receipts: [{ id: received[index].id, ts: received[index].ts }] },
			});
		}
	} finally {
		await restored?.close();
		await writer.close();
	}
});
