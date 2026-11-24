/**
 * A live (function) working label — the background-job wait row — is re-read
 * on every tick and kept to one terminal row. Without the clamp a long list of
 * job ids wrapped the working row onto a second line at narrow widths.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgHideThinkingBlock, cfgProseOnlyThinking } from "@oh-my-pi/pi-coding-agent/session/settings";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { StatusHud } from "../src/ui/dock";
import { createModeTerminal, type ModeTerminal, renderRows } from "./helpers/mode-terminal";

const COLUMNS = 40;

describe("InteractiveMode live working label", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: ModeTerminal;

	beforeAll(async () => {
		initTheme();
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
			settings: Settings.isolated({ "display.mode": "detailed" }),
			modelRegistry,
		});
		terminal = createModeTerminal();
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, terminal.frame);
	});

	afterAll(async () => {
		mode.stop();
		await mode.shell.stop();
		terminal.dispose();
		await session.dispose();
		authStorage.close();
		resetSettingsForTest();
		await tempDir.remove();
	});

	it("keeps a long live label on one row", () => {
		const jobs = ["bg_1", "bg_2", "bg_3", "bg_4", "bg_5", "bg_6"];
		mode.ensureWorkingRow();
		mode.setWorkingMessage(() => `Waiting for ${jobs.length} background jobs: ${jobs.join(", ")}`);

		const rows = renderRows(() => StatusHud({ model: mode.hud.status }), COLUMNS)
			.map(line => line.trimEnd())
			.filter(line => line.length > 0);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Waiting for 6 background jobs");
		expect(Bun.stringWidth(rows[0] ?? "")).toBeLessThanOrEqual(COLUMNS);
	});

	it("projects live model activity through the compact dock without duplicating the working row", async () => {
		const settings = Settings.isolated();
		cfgDisplayMode.set(settings, "compact");
		const unbind = bindEffects(settings);
		const current = new AgentSession({
			agent: new Agent({ initialState: { model: session.model!, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: session.modelRegistry,
		});
		const term = createModeTerminal({ columns: 100, rows: 29, settings });
		const live = new InteractiveMode(current, "test", undefined, undefined, undefined, undefined, term.frame);
		const roles = () =>
			JSON.stringify(
				live.shell.surface.dock().map(node => describeTree(node, staticEnvironment(currentTheme()), 100)),
			);
		const drain = () => live.eventController.runSerialized(async () => {});
		const marker = "LIVE_THOUGHT_MARKER";
		const rawThought = `Early reasoning\n${marker}\n\`\`\`ts\nconst INTERNAL_CODE_MARKER = 1;\n\`\`\``;
		const empty: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [],
			stopReason: "stop",
			timestamp: 1,
		};
		const thinkingStart: AssistantMessage = { ...empty, content: [{ type: "thinking", thinking: "" }] };
		const thinking: AssistantMessage = { ...empty, content: [{ type: "thinking", thinking: rawThought }] };
		try {
			await live.init({ suppressWelcomeIntro: true });
			current.agent.state.isStreaming = true;
			current.agent.emitExternalEvent({ type: "agent_start" });
			current.agent.emitExternalEvent({ type: "turn_start" });
			await drain();
			await term.waitFor(rows => rows.some(line => line.includes("等待响应")));
			expect(roles()).toContain('"omp.compact.activity"');
			expect(roles()).not.toContain('"omp.working"');

			current.agent.emitExternalEvent({ type: "message_start", message: empty });
			current.agent.emitExternalEvent({
				type: "message_update",
				message: thinkingStart,
				assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: thinkingStart },
			});
			current.agent.emitExternalEvent({
				type: "message_update",
				message: thinking,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: rawThought, partial: thinking },
			});
			await drain();
			await term.waitFor(rows => rows.some(line => line.includes("正在思考") && line.includes(marker)));
			expect(term.screen().filter(line => line.includes(marker))).toHaveLength(1);
			expect(term.scrollback().join("\n")).not.toContain(marker);
			expect(roles()).not.toContain('"omp.working"');
			expect(term.screen().join("\n")).not.toContain("INTERNAL_CODE_MARKER");
			cfgProseOnlyThinking.set(settings, false);
			await term.waitFor(rows => rows.some(line => line.includes("正在思考") && line.includes("```")));
			expect(term.screen().join("\n")).not.toContain(marker);
			cfgProseOnlyThinking.set(settings, true);
			await term.waitFor(rows => rows.some(line => line.includes(marker)));

			term.press("alt+p");
			await term.waitFor(
				rows => rows.some(line => line.includes("正在思考")) && !rows.some(line => line.includes(marker)),
			);
			expect(cfgHideThinkingBlock.get(settings)).toBe(true);
			term.press("alt+p");
			await term.waitFor(rows => rows.some(line => line.includes(marker)));
			expect(cfgHideThinkingBlock.get(settings)).toBe(false);
			expect(thinking.content).toEqual([{ type: "thinking", thinking: rawThought }]);

			current.agent.emitExternalEvent({
				type: "message_update",
				message: thinking,
				assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: rawThought, partial: thinking },
			});
			await drain();
			await term.waitFor(
				rows => rows.some(line => line.includes("等待响应")) && !rows.some(line => line.includes(marker)),
			);

			live.setWorkingMessage("custom activity");
			await term.waitFor(rows => rows.some(line => line.includes("custom activity")));
			expect(roles()).toContain('"omp.working"');
			live.setWorkingMessage();

			for (const presentation of ["clean", "detailed", "compact"] as const) {
				cfgDisplayMode.set(settings, presentation);
				await Promise.resolve();
				expect(roles().includes('"omp.compact.activity"')).toBe(presentation === "compact");
				expect(roles().includes('"omp.working"')).toBe(presentation !== "compact");
			}
		} finally {
			live.stop();
			await live.shell.stop();
			term.dispose();
			unbind();
			current.agent.state.isStreaming = false;
			await current.dispose();
		}
	});
});
