import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { jsx } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { attachTerminal, createInteractiveModeContext, renderTranscript } from "./helpers/interactive-mode-context";
import { createModeTerminal } from "./helpers/mode-terminal";

const compacted = "Session compacted 2 times";
const status = "Workspace status updated";

function boundary(rows: readonly string[]): number | undefined {
	const clean = rows.map(row => Bun.stripANSI(row));
	const first = clean.flatMap((row, index) => (row.includes(compacted) ? [index] : []));
	const second = clean.flatMap((row, index) => (row.includes(status) ? [index] : []));
	if (first.length === 0 || second.length === 0) return undefined;
	expect(first).toHaveLength(1);
	expect(second).toHaveLength(1);
	expect(first[0]!).toBeLessThan(second[0]!);
	const between = clean.slice(first[0]! + 1, second[0]!);
	expect(between.every(row => !row.trim())).toBe(true);
	return between.length;
}

async function interactiveFixture() {
	const cwd = TempDir.createSync("omp-compact-spacing-");
	const settings = await Settings.init({ inMemory: true, cwd: cwd.path() });
	cfgDisplayMode.set(settings, "compact");
	initTheme();
	const model = createMockModel();
	const auth = createInMemoryAuthStorage();
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(cwd.path()),
		settings,
		modelRegistry: new ModelRegistry(auth),
	});
	const term = createModeTerminal({ columns: 100, rows: 28, settings });
	const mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, term.frame);
	return {
		mode,
		term,
		session,
		async init() {
			await mode.init({ suppressWelcomeIntro: true });
			await mode.renderInitialMessages();
		},
		async [Symbol.asyncDispose]() {
			mode.stop();
			await mode.shell.stop();
			term.dispose();
			await session.dispose();
			auth.close();
			cwd.removeSync();
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("compact transcript spacing", () => {
	it("preserves the semantic status boundary through pressure and retirement", () => {
		initTheme();
		const ctx = createInteractiveModeContext({ hideToolActivity: true });
		const helpers = new UiHelpers(ctx);
		ctx.present(() => jsx("text", { text: "Earlier transcript" }));
		helpers.showStatus(compacted, { collapse: false });
		helpers.showStatus(status, { collapse: false });
		const expected = boundary(renderTranscript(ctx, 100));
		expect(expected).toBeDefined();
		const term = attachTerminal(ctx, { columns: 100, rows: 28 });
		try {
			expect(boundary(term.screen())).toBe(expected);
			for (const rows of [24, 16, 12, 8]) {
				term.resize(100, rows);
				const projected = boundary(term.screen());
				if (projected !== undefined) expect(projected).toBe(expected!);
			}
			term.resize(100, 28);
			for (let i = 0; i < 36; i++) ctx.present(() => jsx("text", { text: `Later transcript ${i}` }));
			term.render();
			expect(boundary(term.history())).toBe(expected);
		} finally {
			term.dispose();
		}
	});

	it("releases only temporary Output, keeps the draft anchored and never archives preview rows", async () => {
		await using h = await interactiveFixture();
		const text = "TEMPORARY_OUTPUT_ONLY";
		const timing: { expiresAt?: number } = {};
		vi.spyOn(h.session, "getLiveToolOutputPreview").mockImplementation(() => ({
			call: {
				toolName: "bash",
				toolCallId: "temporary",
				dispatchOrder: 1,
				args: { command: "echo preview" },
				result: { content: [{ type: "text", text }] },
				terminalAt: timing.expiresAt === undefined ? undefined : timing.expiresAt - 3_000,
				expiresAt: timing.expiresAt,
			},
			text,
		}));
		await h.init();
		h.mode.composer.setText("INPUT_PRIORITY");
		await h.term.waitFor(screen => screen.join("\n").includes(text));
		for (const rows of [12, 8, 6]) {
			h.term.resize(100, rows);
			await h.term.waitFor(screen => screen.join("\n").includes("INPUT_PRIORITY"));
			expect(h.mode.compactToolOutputPreview.render(100).length).toBeLessThanOrEqual(6);
		}
		h.term.resize(100, 28);
		await h.term.waitFor(screen => screen.join("\n").includes(text));
		timing.expiresAt = Date.now() - 1;
		await executeBuiltinSlashCommand("/display clean", { ctx: h.mode, draftDetached: true });
		await executeBuiltinSlashCommand("/display compact", { ctx: h.mode, draftDetached: true });
		await h.term.waitFor(screen => {
			const viewport = screen.join("\n");
			return viewport.includes("INPUT_PRIORITY") && !viewport.includes(text);
		});
		expect(h.mode.compactToolOutputPreview.render(100)).toEqual([]);
		expect(h.mode.compactThinkingPreview.render(100)).toHaveLength(3);
		expect(h.term.scrollback().join("\n")).not.toContain(text);
	});
});
