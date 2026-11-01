import { afterEach, beforeAll, expect, it, vi } from "bun:test";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Text } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
it("makes an oversized startup changelog available in scrollback after the intro without input", async () => {
	const terminal = new VirtualTerminal(100, 30);
	vi.useFakeTimers();
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { spellingTypoDetection: false, spellingAutocomplete: "off", spellingAutocorrect: false },
	});
	const entries = Array.from({ length: 60 }, (_, i) => `Changelog entry ${i}`);
	composer.setHeaderExtras([], [new Text(entries.join("\n"), 0, 0)]);
	composer.setRuntimeChildren([new TranscriptContainer(), new Text("EDITOR", 0, 0)]);
	composer.start();
	try {
		await scheduler.settle(terminal);
		// Complete the intro with no key or unrelated render to rescue its
		// completion frame.
		now = 3200;
		vi.advanceTimersByTime(33);
		await scheduler.settle(terminal);
		const rows = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
		expect(rows.filter(row => row.startsWith("Changelog entry "))).toEqual(entries);
		expect(terminal.getViewport().at(-1)?.trimEnd()).toBe("EDITOR");
	} finally {
		composer.stop();
	}
});

it("retires the welcome before growing chrome displaces a live reply", async () => {
	const terminal = new VirtualTerminal(100, 28);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { completeScrollback: false },
	});
	composer.setHeaderExtras([], [new Text("WELCOME_MARKER", 0, 0)]);
	const transcript = new TranscriptContainer();
	const active = { render: () => ["ACTIVE_CONTENT"], isTranscriptBlockFinalized: () => false };
	transcript.addChild(active);
	let chromeRows = 0;
	const chrome = { render: () => Array.from({ length: chromeRows }, (_, index) => `HUD_${index}`) };
	composer.setRuntimeChildren([transcript, chrome, new Text("EDITOR", 0, 0)], {
		selfClearingChrome: [chrome],
	});
	composer.start({ playWelcomeIntro: false });
	try {
		await scheduler.settle(terminal);
		chromeRows = 24;
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		const screen = terminal.getViewport().join("\n");
		expect(screen).toContain("ACTIVE_CONTENT");
		expect(screen).toContain("EDITOR");
		expect(
			terminal
				.getScrollBuffer()
				.join("\n")
				.match(/WELCOME_MARKER/g),
		).toHaveLength(1);
	} finally {
		composer.stop();
	}
});
