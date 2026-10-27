/**
 * A live (function) working label — the background-job wait row — is re-read
 * on every tick and kept to one terminal row. Without the clamp a long list of
 * job ids wrapped the working row onto a second line at narrow widths.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayCompactToolActivity } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const COLUMNS = 40;

describe("InteractiveMode live working label", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let focusedSession: AgentSession;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-working-label-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		focusedSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		Object.defineProperty(mode.ui.terminal, "columns", { get: () => COLUMNS, configurable: true });
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		await focusedSession.dispose();
		authStorage.close();
		resetSettingsForTest();
		await tempDir.remove();
	});

	it("keeps a long live label on one row", () => {
		const jobs = ["bg_1", "bg_2", "bg_3", "bg_4", "bg_5", "bg_6"];
		mode.ensureLoadingAnimation();
		mode.setWorkingMessage(() => `Waiting for ${jobs.length} background jobs: ${jobs.join(", ")}`);

		const rows = mode.statusContainer
			.render(COLUMNS)
			.map(line => Bun.stripANSI(line).trimEnd())
			.filter(line => line.length > 0);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Waiting for 6 background jobs");
		expect(Bun.stringWidth(rows[0] ?? "")).toBeLessThanOrEqual(COLUMNS);
	});

	it("does not confuse ended thinking, generated arguments and executing tools", () => {
		const agent = session.agent;
		const message = createAssistantMessage("");
		message.content = [{ type: "thinking", thinking: "reasoning" }];
		agent.emitExternalEvent({ type: "agent_start" }, { stateOnly: true });
		mode.setWorkingMessage();
		const label = () => {
			mode.setWorkingMessage();
			return Bun.stripANSI(mode.statusContainer.render(COLUMNS).join("\n"));
		};
		agent.emitExternalEvent(
			{
				type: "message_update",
				message,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reasoning", partial: message },
			},
			{ stateOnly: true },
		);
		expect(label()).toContain("模型思考");
		agent.emitExternalEvent(
			{
				type: "message_update",
				message,
				assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "reasoning", partial: message },
			},
			{ stateOnly: true },
		);
		expect(label()).not.toContain("模型思考");
		message.content.push({ type: "toolCall", id: "call-1", name: "bash", arguments: {} });
		agent.emitExternalEvent({ type: "message_start", message }, { stateOnly: true });
		expect(label()).toContain("生成工具调用");
		expect(label()).not.toContain("工具执行中");
		agent.emitExternalEvent({ type: "message_end", message });
		agent.emitExternalEvent(
			{ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} },
			{ stateOnly: true },
		);
		expect(label()).toContain("工具执行中 · bash");
		agent.emitExternalEvent(
			{ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: {} },
			{ stateOnly: true },
		);
		expect(label()).toContain("等待模型响应");
		message.content = [{ type: "text", text: "answer" }];
		agent.emitExternalEvent({ type: "message_start", message }, { stateOnly: true });
		expect(label()).toContain("模型回复");
		agent.emitExternalEvent({ type: "agent_end", messages: [] }, { stateOnly: true });
	});

	it("uses only the viewed agent and leaves detailed labels unchanged", () => {
		session.agent.state.pendingToolCalls.add("parent-call");
		const message = createAssistantMessage("focused reply");
		focusedSession.agent.emitExternalEvent({ type: "message_start", message }, { stateOnly: true });
		Object.defineProperty(mode, "viewSession", { configurable: true, value: focusedSession });
		try {
			mode.setWorkingMessage();
			let rendered = Bun.stripANSI(mode.statusContainer.render(COLUMNS).join("\n"));
			expect(rendered).toContain("模型回复");
			expect(rendered).not.toContain("工具执行中");
			cfgDisplayCompactToolActivity.override(mode.settings, false);
			mode.setWorkingMessage("custom activity");
			rendered = Bun.stripANSI(mode.statusContainer.render(COLUMNS).join("\n"));
			expect(rendered).toContain("custom activity");
		} finally {
			cfgDisplayCompactToolActivity.override(mode.settings, true);
			delete (mode as unknown as { viewSession?: AgentSession }).viewSession;
			session.agent.state.pendingToolCalls.clear();
			focusedSession.agent.emitExternalEvent({ type: "message_end", message }, { stateOnly: true });
		}
	});
});
