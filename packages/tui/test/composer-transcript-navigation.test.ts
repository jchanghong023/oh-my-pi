import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../src/chat/assistant-message";
import { chatTranscriptDisplayPreferences, setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { TranscriptContainer } from "../src/chrome/transcript-container";
import { Composer } from "../src/prompt/composer";
import { KeybindingsManager } from "../src/app-keybindings";
import { getKeybindings, setKeybindings } from "../src/keybindings";
import { initTheme } from "../src/theme";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});
const originalPreferences = { ...chatTranscriptDisplayPreferences };
const originalKeys = getKeybindings();
afterEach(() => {
	setChatTranscriptDisplayPreferences(originalPreferences);
	setKeybindings(originalKeys);
});

function reply(count: number): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text:
					"| Item | Value |\n| --- | --- |\n" +
					Array.from({ length: count }, (_, i) => `| NAV_${String(i).padStart(3, "0")} | value |`).join("\n"),
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function setup(mode: "clean" | "compact" | "detailed") {
	setKeybindings(KeybindingsManager.inMemory());
	setChatTranscriptDisplayPreferences({
		compactToolActivity: mode === "compact",
		hideToolActivity: mode !== "detailed",
	});
	const terminal = new VirtualTerminal(80, 18);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		preferences: { quiet: true },
		tuiOptions: { renderScheduler: scheduler },
	});
	const transcript = new TranscriptContainer();
	const message = new AssistantMessageComponent();
	message.updateContent(reply(40), { transient: true });
	transcript.addChild(message);
	composer.setRuntimeChildren([transcript, composer.editor], { transientChrome: [composer.editor] });
	composer.ui.setFocus(composer.editor);
	composer.start({ playWelcomeIntro: false });
	const paint = async () => {
		composer.ui.requestRender();
		await scheduler.settle(terminal);
	};
	const markers = () =>
		Array.from(
			terminal
				.getViewport()
				.join("\n")
				.matchAll(/NAV_\d{3}/g),
			match => match[0],
		);
	return { terminal, scheduler, composer, transcript, message, paint, markers };
}

describe("shared unarchived transcript navigation", () => {
	// Exercise the host's real key routing, not a replacement compact viewport.
	it.each(["clean", "compact", "detailed"] as const)(
		"keeps a browsed table anchored across streaming and resize, then resumes following (%s)",
		async mode => {
			const h = setup(mode);
			try {
				await h.paint();
				expect(h.markers()).toContain("NAV_039");
				h.terminal.sendInput("\x1b[5~");
				await h.paint();
				expect(h.transcript.isViewportScrolled).toBe(true);
				const browsed = h.markers();
				expect(browsed.length).toBeGreaterThan(0);
				expect(browsed).not.toContain("NAV_039");
				h.message.updateContent(reply(50), { transient: true });
				await h.paint();
				expect(h.transcript.isViewportScrolled).toBe(true);
				expect(h.markers()[0]).toBe(browsed[0]);
				h.terminal.resize(100, 22);
				await h.scheduler.advance(h.terminal, 300);
				expect(h.transcript.isViewportScrolled).toBe(true);
				expect(h.markers()[0]).toBe(browsed[0]);
				for (let page = 0; page < 20 && h.transcript.isViewportScrolled; page++) {
					h.terminal.sendInput("\x1b[6~");
					await h.paint();
				}
				expect(h.transcript.isViewportScrolled).toBe(false);
				expect(h.markers()).toContain("NAV_049");
				h.terminal.sendInput("\x1b[5~");
				await h.paint();
				expect(h.transcript.isViewportScrolled).toBe(true);
				h.terminal.sendInput("\x1b");
				await h.paint();
				expect(h.transcript.isViewportScrolled).toBe(false);
				expect(h.composer.editor.getText()).toBe("");
				expect(h.markers()).toContain("NAV_049");
				h.terminal.sendInput("\x1b[5~");
				await h.paint();
				h.terminal.sendInput("draft");
				await h.paint();
				expect(h.transcript.isViewportScrolled).toBe(false);
				expect(h.composer.editor.getText()).toBe("draft");
				h.message.updateContent(reply(50));
				h.message.markTranscriptBlockFinalized();
				await h.paint();
				const all = Array.from(
					h.terminal
						.getScrollBuffer()
						.join("\n")
						.matchAll(/NAV_\d{3}/g),
					match => match[0],
				);
				expect(all).toEqual(Array.from({ length: 50 }, (_, i) => `NAV_${String(i).padStart(3, "0")}`));
			} finally {
				h.composer.stop();
				h.message.dispose();
			}
		},
	);

	it("does not steal paging from a draft, an overlay, or another focused component", async () => {
		const h = setup("compact");
		const received: string[] = [];
		const other = { render: () => ["focused control"], handleInput: (data: string) => received.push(data) };
		try {
			await h.paint();
			h.composer.editor.setText("unsubmitted");
			h.terminal.sendInput("\x1b[5~");
			await h.paint();
			expect(h.transcript.isViewportScrolled).toBe(false);
			expect(h.composer.editor.getText()).toBe("unsubmitted");
			h.composer.editor.setText("");
			const overlay = h.composer.ui.showOverlay(other);
			h.composer.ui.setFocus(other);
			h.terminal.sendInput("\x1b[5~");
			await h.paint();
			expect(received).toEqual(["\x1b[5~"]);
			expect(h.transcript.isViewportScrolled).toBe(false);
			overlay.hide();
			h.composer.ui.setFocus(other);
			h.terminal.sendInput("\x1b[6~");
			expect(received).toEqual(["\x1b[5~", "\x1b[6~"]);
			expect(h.transcript.isViewportScrolled).toBe(false);
			h.composer.ui.setFocus(h.composer.editor);
			h.composer.startLinkHints(() => {});
			expect(h.composer.linkHintsActive).toBe(true);
			h.terminal.sendInput("\x1b[5~");
			expect(h.transcript.isViewportScrolled).toBe(false);
			h.composer.cancelLinkHints();
		} finally {
			h.composer.stop();
			h.message.dispose();
		}
	});

	it("routes chat-wheel browsing without treating a wheel over the input as transcript navigation", async () => {
		const h = setup("compact");
		try {
			await h.paint();
			const chatRow = h.composer.ui.getMutableViewport().top + 2;
			h.terminal.sendInput(`\x1b[<64;2;${chatRow}M`);
			await h.paint();
			expect(h.transcript.isViewportScrolled).toBe(true);
			h.terminal.sendInput("\x1b");
			await h.paint();
			expect(h.transcript.isViewportScrolled).toBe(false);
			const inputRow = h.terminal.getCursor().row + 1;
			h.terminal.sendInput(`\x1b[<64;2;${inputRow}M`);
			await h.paint();
			expect(h.transcript.isViewportScrolled).toBe(false);
			expect(h.composer.editor.getText()).toBe("");
		} finally {
			h.composer.stop();
			h.message.dispose();
		}
	});
});
