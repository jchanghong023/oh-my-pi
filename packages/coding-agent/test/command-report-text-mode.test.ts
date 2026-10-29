import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const ROWS = 32;

function screen(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

describe("text-mode command reports on a real terminal core", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-command-report-");
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
		term = new VirtualTerminal(120, ROWS);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function mountTranscript(rows: number): Promise<string> {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		for (let i = 0; i < rows; i++) mode.chatContainer.addChild(new Text(`TRANSCRIPT ${i}`, 0, 0));
		mode.ui.requestRender();
		const last = `TRANSCRIPT ${rows - 1}`;
		await term.waitForRender(() => screen(term).includes(last));
		return last;
	}

	async function prepareCommand(command: string): Promise<void> {
		term.sendInput(command);
		await term.waitForRender(() => screen(term).some(row => row.includes(command)));
		if (mode.editor.isShowingAutocomplete()) {
			term.sendInput("\x1b");
			await term.waitForRender(() => !mode.editor.isShowingAutocomplete());
		}
	}

	async function runCommand(command: string, shown: string, last: string): Promise<number> {
		await prepareCommand(command);
		const lastRow = screen(term).indexOf(last);
		expect(lastRow).toBeGreaterThanOrEqual(0);
		term.sendInput("\r");
		await term.waitForRender(() => screen(term).some(row => row.includes(shown)));
		return lastRow;
	}

	it.each([5, 40])(
		"opens `/changelog full` as a scrollable full-screen page and Esc returns to the untouched screen (%i transcript rows)",
		async rows => {
			const last = await mountTranscript(rows);
			await prepareCommand("/changelog full");
			// Capture the normal buffer at the actual alternate-screen boundary,
			// after typing and completion have had their own opportunity to reflow it.
			let beforeOverlay: string[] | undefined;
			let restoredScreen: string[] | undefined;
			const write = term.write.bind(term);
			term.write = data => {
				if (data.includes("\x1b[?1049h")) beforeOverlay = screen(term);
				write(data);
				if (data.includes("\x1b[?1049l")) restoredScreen = screen(term);
			};
			term.sendInput("\r");
			await term.waitForRender(() => screen(term).some(row => row.includes("Full Changelog")));
			expect(screen(term).some(row => row.includes(last))).toBe(false);
			const page = screen(term).join("\n");
			term.sendInput("\x1b[6~");
			await term.waitForRender(() => screen(term).join("\n") !== page);
			expect(screen(term).some(row => row.includes("Full Changelog"))).toBe(true);

			term.sendInput("\x1b");
			await term.waitForRender(() => !screen(term).some(row => row.includes("Full Changelog")));
			expect(beforeOverlay).toBeDefined();
			expect(restoredScreen).toEqual(beforeOverlay);
			expect(beforeOverlay!.indexOf(last)).toBeGreaterThanOrEqual(0);
			expect(screen(term).indexOf(last)).toBe(beforeOverlay!.indexOf(last));
			// Nothing of the page reached the main screen, and no transcript row was duplicated.
			const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			expect(buffer.filter(row => row === last)).toHaveLength(1);
			expect(buffer.some(row => row.includes("Full Changelog"))).toBe(false);
		},
	);

	it("shows a report that fits above the editor like /btw and Esc takes it away", async () => {
		const last = await mountTranscript(40);
		const lastRow = await runCommand("/tools", "Available Tools", last);
		// Inline: the transcript stays on the main screen, only covered from below.
		expect(screen(term).some(row => row.startsWith("TRANSCRIPT"))).toBe(true);

		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes("Available Tools")));
		expect(screen(term).indexOf(last)).toBe(lastRow);
	});

	it.each([
		["/mcp help", "MCP Server Management"],
		["/mcp list", "MCP Servers"],
		["/ssh help", "SSH Host Management"],
		["/ssh list", "SSH Hosts"],
	])("`%s` reports outside the transcript and Esc takes it away", async (command, title) => {
		const last = await mountTranscript(40);
		const blocks = mode.chatContainer.children.length;
		const lastRow = await runCommand(command, title, last);
		expect(mode.chatContainer.children).toHaveLength(blocks);

		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes(title)));
		expect(screen(term).indexOf(last)).toBe(lastRow);
		const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row));
		expect(buffer.some(row => row.includes(title))).toBe(false);
	});
});
