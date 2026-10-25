import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ThinkingPreviewComponent } from "@oh-my-pi/pi-tui/chat/thinking-preview";
import { Loader } from "@oh-my-pi/pi-tui/components/loader";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { EditorTopGap } from "@oh-my-pi/pi-tui/prompt/editor-top-gap";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { createStartupStatusLine } from "@oh-my-pi/pi-tui/status-line/startup";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	getKeybindings,
	setKeybindings,
	Text,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const ROWS = 40;
const COLUMNS = 100;
const TRANSCRIPT_ROWS = 60;
const TRANSCRIPT_PREFIX = "Settled transcript row ";

/** A settled assistant turn carrying one text block, typed so schema drift fails at compile time. */
function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

/** Below-transcript chrome that inflates on demand, mimicking a confirmation dialog or a tall multi-line editor swapped in above the input. */
class InlineWidget implements Component {
	rows = 0;
	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, i) => `Live widget row ${i}`);
	}
}

interface Harness {
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	transcript: TranscriptContainer;
	widget: InlineWidget;
	/** Turn-scoped chrome between transcript and editor (loader, todo/subagent HUDs). */
	hud: InlineWidget;
	editor: Container;
}

function makeHarness(
	columns = COLUMNS,
	rows = ROWS,
	transcriptRows = TRANSCRIPT_ROWS,
	shellHistory: readonly string[] = [],
): Harness {
	const terminal = new VirtualTerminal(columns, rows);
	if (shellHistory.length > 0) terminal.write(`${shellHistory.join("\r\n")}${"\r\n".repeat(rows + 1)}`);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	for (let i = 0; i < transcriptRows; i++) {
		const row = i;
		transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${row}`] });
	}
	const hud = new InlineWidget();
	const editor = new Container();
	const widget = new InlineWidget();
	editor.addChild(widget);
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, hud, editor], { transientChrome: [editor] });
	composer.start({ playWelcomeIntro: false });
	return { terminal, scheduler, composer, transcript, widget, hud, editor };
}

/** Settle, grow the inline chrome, settle, shrink it back, settle. */
async function cycleWidget(h: Harness): Promise<void> {
	await h.scheduler.settle(h.terminal);
	h.widget.rows = 24;
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
	h.widget.rows = 0;
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
}

/**
 * Longest run of blank rows above the row containing `bottom`. Transcript
 * blocks are separated by one blank row, so a longer run is a band of rows no
 * frame can fill.
 */
function blankBand(terminal: VirtualTerminal, bottom = "EDITOR"): number {
	const view = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	let run = 0;
	let longest = 0;
	for (const row of view.slice(
		0,
		view.findIndex(line => line.includes(bottom)),
	)) {
		run = row === "" ? run + 1 : 0;
		longest = Math.max(longest, run);
	}
	return longest;
}

/** Stream a 110-paragraph answer one paragraph per frame, then finalize it. */
async function streamFinalizedAnswer(h: Harness): Promise<void> {
	const message = new AssistantMessageComponent();
	h.transcript.addChild(message);
	const reply = (text: string): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	});
	const lines = Array.from({ length: 110 }, (_, i) => `line${i}`);
	for (let n = 1; n <= lines.length; n++) {
		message.updateContent(reply(lines.slice(0, n).join("\n\n")), { transient: true });
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
	}
	message.updateContent(reply(lines.join("\n\n")));
	message.markTranscriptBlockFinalized();
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
}

beforeAll(async () => {
	await initTheme();
});

describe("composer inline shrink (#11007)", () => {
	it("keeps compact prose complete while self-clearing chrome expands and collapses", async () => {
		const previous = { ...chatTranscriptDisplayPreferences };
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const h = makeHarness(60, 18, 0);
		h.composer.setRuntimeChildren([h.transcript, h.hud, h.editor], {
			selfClearingChrome: [h.hud],
			transientChrome: [h.editor],
		});
		const message = new AssistantMessageComponent();
		h.transcript.addChild(message);
		const paragraphs = Array.from({ length: 24 }, (_, i) => `PARA${String(i + 1).padStart(2, "0")}`);
		try {
			h.hud.rows = 3;
			for (let count = 1; count <= paragraphs.length; count++) {
				message.updateContent(reply(paragraphs.slice(0, count).join("\n\n")), { transient: true });
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
			}
			message.updateContent(
				reply(`${paragraphs.join("\n\n")}\n\n| Item | Value |\n| --- | --- |\n| active | table |`),
				{ transient: true },
			);
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			const prose = () => h.terminal.getScrollBuffer().flatMap(row => Bun.stripANSI(row).match(/PARA\d{2}/g) ?? []);
			expect(prose()).toEqual(paragraphs);
			h.hud.rows = 0;
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			expect(prose()).toEqual(paragraphs);
			h.hud.rows = 3;
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			expect(prose()).toEqual(paragraphs);
		} finally {
			h.composer.stop();
			setChatTranscriptDisplayPreferences(previous);
		}
	});

	it("keeps the final live table cell visible beside narrow activity, draft, and status chrome", async () => {
		const previous = { ...chatTranscriptDisplayPreferences };
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const terminal = new VirtualTerminal(100, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { quiet: true },
		});
		const status = createStartupStatusLine({
			settings: { leftSegments: [], rightSegments: [], showHookStatus: true },
			gitEnabled: false,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});
		for (let index = 0; index < 7; index++) status.setHookStatus(`status-${index}`, `STATUS ${index}`);
		composer.setStatusComponent(status);
		composer.editor.setText("draft-kept");
		const activity = new InlineWidget();
		activity.rows = 3;
		const transcript = new TranscriptContainer();
		const message = new AssistantMessageComponent(
			undefined,
			false,
			undefined,
			[],
			undefined,
			true,
			undefined,
			false,
			false,
			true,
		);
		transcript.addChild(message);
		composer.setRuntimeChildren([transcript, activity, composer.editor], {
			transientChrome: [composer.editor],
			selfClearingChrome: [activity],
		});
		composer.start({ playWelcomeIntro: false });
		const source =
			Array.from({ length: 24 }, (_, index) => `P${index} 正文不能丢失。`).join("\n\n") +
			"\n\n| 轮次 | 总耗时 | 非编译耗时／结果 | 备注 |\n| --- | ---: | --- | --- |\n" +
			Array.from(
				{ length: 5 },
				(_, index) => `| 第 ${index + 1} 轮 | 111.1 秒 | 11.1 秒，通过 | 静态检查预算耗尽ROW${index + 1} |`,
			).join("\n");
		let streamed = "";
		try {
			for (const line of source.split("\n")) {
				streamed += `${line}\n`;
				message.updateContent(reply(streamed), { transient: true });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
			}
			terminal.resize(24, 12);
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			const visible = terminal.getScrollBuffer().join("\n");
			expect(visible).toContain("W5");
			expect(composer.editor.getText()).toBe("draft-kept");
			expect(terminal.getViewport().some(row => row.includes("draft-kept"))).toBe(true);
		} finally {
			composer.stop();
			setChatTranscriptDisplayPreferences(previous);
		}
	});

	it("reserves compact transcript space beside narrow-screen placeholder and status decorations", async () => {
		const previous = { ...chatTranscriptDisplayPreferences };
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const terminal = new VirtualTerminal(24, 12);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { quiet: true },
		});
		const status = createStartupStatusLine({
			settings: { leftSegments: [], rightSegments: [], showHookStatus: true },
			gitEnabled: false,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});
		for (let i = 0; i < 7; i++) status.setHookStatus(`narrow-${i}`, `STATUS ${i}`);
		composer.setStatusComponent(status);
		composer.editor.placeholder = () => "Type a message, use slash commands, or ask a question about your project";
		const transcript = new TranscriptContainer();
		transcript.addChild(new Text("CURRENT BODY", 0, 0));
		composer.setRuntimeChildren([transcript, composer.editor], { transientChrome: [composer.editor] });
		composer.ui.setFocus(composer.editor);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			expect(terminal.getViewport().some(row => row.includes("CURRENT BODY"))).toBe(true);
			expect(composer.renderFrame({ columns: 24, rows: 12 }).viewport.some(row => row.includes(CURSOR_MARKER))).toBe(
				true,
			);
			const compactEditorRows = composer.editor.render(24).length;
			setChatTranscriptDisplayPreferences({ compactToolActivity: false });
			const detailedEditorRows = composer.editor.render(24).length;
			expect(detailedEditorRows).toBeGreaterThan(compactEditorRows);
			setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
			expect(composer.editor.render(24).length).toBe(detailedEditorRows);
			setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
			composer.editor.handleInput("draft");
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(terminal.getViewport().some(row => row.includes("draft"))).toBe(true);
			expect(terminal.getViewport().some(row => row.includes("CURRENT BODY"))).toBe(true);
			expect(composer.editor.getText()).toBe("draft");
		} finally {
			composer.stop();
			setChatTranscriptDisplayPreferences(previous);
		}
	});

	it("protects compact prose and draft from a huge self-clearing HUD before dropping thinking", async () => {
		const previous = { ...chatTranscriptDisplayPreferences };
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const terminal = new VirtualTerminal(24, 12);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { quiet: true },
		});
		const transcript = new TranscriptContainer();
		transcript.addChild(new Text("CURRENT BODY", 0, 0));
		const thinking = new ThinkingPreviewComponent();
		thinking.setText("first thought\nlatest thought");
		const hud = new InlineWidget();
		hud.rows = 80;
		composer.editor.setText("draft");
		composer.setRuntimeChildren([transcript, thinking, hud, composer.editor], {
			transientChrome: [composer.editor],
			selfClearingChrome: [thinking, hud],
		});
		composer.ui.setFocus(composer.editor);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			const view = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(view.some(row => row.includes("CURRENT BODY"))).toBe(true);
			expect(view.some(row => row.includes("draft"))).toBe(true);
			expect(view.filter(row => row.includes("thought"))).toHaveLength(2);
			expect(composer.renderFrame({ columns: 24, rows: 12 }).viewport.some(row => row.includes(CURSOR_MARKER))).toBe(
				true,
			);
			expect(composer.editor.getText()).toBe("draft");
			terminal.resize(24, 6);
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			const shortView = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(shortView.some(row => row.includes("CURRENT BODY"))).toBe(true);
			expect(shortView.some(row => row.includes("draft"))).toBe(true);
			expect(shortView.filter(row => row.includes("thought"))).toHaveLength(0);
			expect(composer.editor.getText()).toBe("draft");
		} finally {
			composer.stop();
			setChatTranscriptDisplayPreferences(previous);
		}
	});

	it("protects real compact assistant prose and draft from the actual working loader at 24x6", async () => {
		const previous = { ...chatTranscriptDisplayPreferences };
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const terminal = new VirtualTerminal(24, 6);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { quiet: true },
		});
		const transcript = new TranscriptContainer();
		const prose = new AssistantMessageComponent();
		prose.updateContent(reply("REAL ASSISTANT BODY"));
		transcript.addChild(prose);
		const thinking = new ThinkingPreviewComponent();
		thinking.setText("first thought\nlatest thought");
		const statusRoot = new (class extends Container {
			override render(width: number): readonly string[] {
				return ["Working status", ...super.render(width)];
			}
		})();
		const loader = new Loader(
			composer.ui,
			text => text,
			text => text,
			"Inspecting first local fixture",
			[" ⎋"],
		);
		statusRoot.addChild(loader);
		const status = createStartupStatusLine({
			settings: { leftSegments: [], rightSegments: [], showHookStatus: true },
			gitEnabled: false,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});
		status.setHookStatus("runtime-status", "Runtime status detail");
		composer.setStatusComponent(status);
		composer.editor.setText("draft");
		composer.setRuntimeChildren([transcript, thinking, statusRoot, composer.editor], {
			transientChrome: [composer.editor],
			selfClearingChrome: [thinking],
		});
		composer.ui.setFocus(composer.editor);
		composer.start({ playWelcomeIntro: false });
		try {
			for (const rows of [6, 12]) {
				terminal.resize(24, rows);
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				const view = terminal.getViewport().map(row => Bun.stripANSI(row));
				expect(view.some(row => row.includes("REAL ASSISTANT BODY"))).toBe(true);
				expect(view.some(row => row.includes("draft"))).toBe(true);
				expect(composer.renderFrame({ columns: 24, rows }).viewport.some(row => row.includes(CURSOR_MARKER))).toBe(
					true,
				);
				expect(composer.editor.getText()).toBe("draft");
			}
		} finally {
			loader.stop();
			composer.stop();
			setChatTranscriptDisplayPreferences(previous);
		}
	});

	it("keeps input and cursor inside the shared below-editor and status height budget after resizing", async () => {
		const terminal = new VirtualTerminal(24, 6);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const status = createStartupStatusLine({
			settings: { leftSegments: [], rightSegments: [], showHookStatus: true },
			gitEnabled: false,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});
		for (let i = 0; i < 3; i++) status.setHookStatus(`status-${i}`, `STATUS ${i}`);
		composer.setStatusComponent(status);
		composer.editor.setText("INPUT");
		const editorRoot = new Container();
		editorRoot.addChild(composer.editor);
		let widgetRows = 3;
		let widgetRenders = 0;
		const belowEditor = new Container();
		belowEditor.addChild({
			render: () => {
				widgetRenders++;
				return Array.from({ length: widgetRows }, (_, i) => `WIDGET ${i}`);
			},
		});
		composer.setRuntimeChildren([new TranscriptContainer(), editorRoot, belowEditor], {
			transientChrome: [editorRoot],
		});
		composer.ui.setFocus(composer.editor);
		composer.start({ playWelcomeIntro: false });
		try {
			for (const geometry of [
				{ rows: 6, widget: 3 },
				{ rows: 12, widget: 3 },
				{ rows: 6, widget: 9 },
				{ rows: 12, widget: 3 },
			]) {
				widgetRows = geometry.widget;
				terminal.resize(24, geometry.rows);
				composer.ui.requestRender();
				await scheduler.advance(terminal, 300);
				for (const resize of [false, true]) {
					const rendersBefore = widgetRenders;
					const size = { columns: 24, rows: geometry.rows };
					const viewport = resize ? composer.renderResizeFrame(size) : composer.renderFrame(size).viewport;
					expect(widgetRenders - rendersBefore).toBe(1);
					const cursorRow = viewport.findIndex(row => row.includes(CURSOR_MARKER));
					expect(cursorRow).toBeGreaterThanOrEqual(0);
					expect(cursorRow).toBeLessThan(geometry.rows);
					const input = viewport[cursorRow]!;
					expect(input).toContain("INPUT");
					expect(visibleWidth(input.slice(0, input.indexOf(CURSOR_MARKER)))).toBeLessThan(24);
					const widgets = Math.min(widgetRows, geometry.rows - composer.editor.renderedRows);
					const statuses = Math.min(3, geometry.rows - composer.editor.renderedRows - widgets);
					expect(viewport.filter(row => row.includes("WIDGET "))).toHaveLength(widgets);
					expect(viewport.filter(row => row.includes("STATUS "))).toHaveLength(statuses);
					// Status overflow and layout spacing may use spare rows; assert the budget, not a packed viewport.
					expect(viewport.length).toBeGreaterThanOrEqual(composer.editor.renderedRows + widgets + statuses);
					expect(viewport.length).toBeLessThanOrEqual(geometry.rows);
				}
				const visible = terminal.getViewport();
				const cursor = terminal.getCursor();
				expect(visible.some(row => row.includes("INPUT"))).toBe(true);
				expect(visible[cursor.row]).toContain("INPUT");
				expect(cursor.col).toBeLessThan(24);
				if (geometry.rows === 12) {
					expect(visible.filter(row => row.includes("WIDGET "))).toHaveLength(3);
					expect(visible.filter(row => row.includes("STATUS "))).toHaveLength(3);
				}
			}
		} finally {
			composer.stop();
			status.dispose();
		}
	});

	it("answers an ask at the reported 54x112 geometry without losing, duplicating or stranding rows", async () => {
		const h = makeHarness(112, 54);
		await h.scheduler.settle(h.terminal);
		let submitted = false;
		const dialog = new AskDialogComponent(
			[
				{
					id: "approve",
					question: "Approve this section and the complete design for writing the spec?",
					options: [{ label: "Approve" }, { label: "Revise" }],
				},
			],
			{
				onSubmit: () => {
					submitted = true;
					h.editor.clear();
					h.editor.addChild(new Text("EDITOR", 0, 0));
					h.composer.ui.requestRender();
				},
				onCancel: () => {},
				onPrompt: () => Promise.resolve(undefined),
			},
		);
		h.editor.clear();
		h.editor.addChild(dialog);
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const visibleRows = (): number[] =>
			h.terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
				.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		dialog.handleInput("\r");
		await h.scheduler.settle(h.terminal);
		expect(submitted).toBe(true);
		expect(visibleRows()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(53);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		dialog.dispose();
		h.composer.stop();
	});

	it("leaves a short transcript top-anchored after an inline panel closes", async () => {
		const h = makeHarness(COLUMNS, ROWS, 3);
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 6;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const row = (needle: string): number =>
			h.terminal.getViewport().findIndex(line => Bun.stripANSI(line).trimEnd().startsWith(needle));
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		expect(row("EDITOR")).toBeLessThan(ROWS - 1);
		h.composer.stop();
	});

	it("lets a reset to an empty transcript shrink in place instead of pinning to the bottom", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		// A new session: scrollback is cleared and nothing replays into it.
		h.composer.setRuntimeChildren([new TranscriptContainer(), h.hud, h.editor]);
		h.composer.ui.resetDisplay();
		await h.scheduler.settle(h.terminal);
		h.widget.rows = ROWS + 5;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 3;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(3);
		h.composer.stop();
	});

	it("refills the screen after an ask closes below a response taller than the screen", async () => {
		const terminal = new VirtualTerminal(COLUMNS, ROWS);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		// The response straddles the top edge: only its rows above the screen
		// may reach scrollback, or the panel would push on-screen history out
		// of reach and leave a band behind when it closes.
		transcript.addChild({ render: () => Array.from({ length: 80 }, (_, i) => `${TRANSCRIPT_PREFIX}${i}`) });
		transcript.addChild({ render: () => Array.from({ length: 11 }, (_, i) => `Tool row ${i}`) });
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, editor]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		const dialog = new AskDialogComponent(
			[{ id: "q", question: "Is it good?", options: [{ label: "Yes" }, { label: "No" }] }],
			{
				onSubmit: () => {
					editor.clear();
					editor.addChild(new Text("EDITOR", 0, 0));
					composer.ui.requestRender();
				},
				onCancel: () => {},
				onPrompt: () => Promise.resolve(undefined),
			},
		);
		editor.clear();
		editor.addChild(dialog);
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		dialog.handleInput("\r");
		await scheduler.settle(terminal);
		expect(terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		expect(blankBand(terminal)).toBeLessThanOrEqual(1);
		const indices = terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: 80 }, (_, i) => i));
		dialog.dispose();
		composer.stop();
	});

	it("brings rows an ask panel covered back on screen when the ask is hidden", async () => {
		// The default app bindings (Alt+H hides a pending ask).
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory());
		try {
			const h = makeHarness();
			await h.scheduler.settle(h.terminal);
			const dialog = new AskDialogComponent(
				[
					{
						id: "q",
						question: "Is it good?",
						options: ["A", "B", "C", "D"].map(label => ({ label, description: `${label} described` })),
					},
				],
				{ onSubmit: () => {}, onCancel: () => {}, onPrompt: () => Promise.resolve(undefined) },
				{ tui: h.composer.ui },
			);
			h.editor.clear();
			h.editor.addChild(dialog);
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			const expandedRows = dialog.render(COLUMNS).length;
			const coveredRows = h.terminal
				.getViewport()
				.filter(row => Bun.stripANSI(row).startsWith(TRANSCRIPT_PREFIX)).length;
			const reachable = (): number[] =>
				h.terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trimEnd())
					.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
					.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
			// Alt+H collapses the pending ask to one line: the rows it covered are
			// still live, so they refill the screen instead of leaving a band.
			dialog.handleInput("\x1bh");
			await h.scheduler.settle(h.terminal);
			expect(dialog.render(COLUMNS)).toHaveLength(1);
			expect(
				h.terminal.getViewport().filter(row => Bun.stripANSI(row).startsWith(TRANSCRIPT_PREFIX)).length,
			).toBeGreaterThan(coveredRows);
			expect(reachable()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
			// Showing it again covers them without writing anything twice.
			dialog.handleInput("\x1bh");
			await h.scheduler.settle(h.terminal);
			expect(dialog.render(COLUMNS)).toHaveLength(expandedRows);
			expect(h.terminal.getViewport().filter(row => Bun.stripANSI(row).startsWith(TRANSCRIPT_PREFIX)).length).toBe(
				coveredRows,
			);
			const shown = reachable();
			expect(new Set(shown).size).toBe(shown.length);
			dialog.dispose();
			h.composer.stop();
		} finally {
			setKeybindings(previous);
		}
	});

	it("keeps the editor pinned to the bottom after transient below-transcript chrome shrinks", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		const before = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(before.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);

		await cycleWidget(h);

		const after = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		// Regression: the editor used to strand ~24 blank rows below it after the
		// shrink because retired transcript rows never returned to the live tail.
		expect(after.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		const lastContent = after.reduce((last, row, i) => (row.length > 0 ? i : last), -1);
		expect(lastContent).toBe(ROWS - 1);

		h.composer.stop();
	});

	it("retires transcript rows contiguously with no duplication or gaps across the grow/shrink cycle", async () => {
		const h = makeHarness();
		await cycleWidget(h);

		// Every transcript row appears exactly once (native scrollback + live grid),
		// in order — the shrink must not drop rows into a gap or duplicate them.
		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));

		h.composer.stop();
	});

	it("preserves native shell history when a composer replay follows an append-mode resize", async () => {
		const shell = ["SHELL_BEFORE_APPEND_RESIZE"];
		const h = makeHarness(COLUMNS, ROWS, TRANSCRIPT_ROWS, shell);
		h.composer.ui.setResizeScrollback("append");
		h.composer.setHeaderExtras([new Text("APPEND_RESIZE_HEADER", 0, 0)], []);
		try {
			await h.scheduler.settle(h.terminal);
			expect(h.terminal.getScrollBuffer().join("\n")).toContain(shell[0]!);
			expect(h.terminal.getViewport().join("\n")).not.toContain("APPEND_RESIZE_HEADER");
			h.terminal.resize(COLUMNS - 10, ROWS);
			await h.scheduler.advance(h.terminal, 300);
			await h.scheduler.settle(h.terminal);
			const buffer = h.terminal.getScrollBuffer().join("\n");
			expect(buffer.split("\n").filter(row => row.includes(shell[0]!))).toHaveLength(1);
			expect(buffer).toContain("APPEND_RESIZE_HEADER");
			expect(h.terminal.getViewport().join("\n")).toContain(`${TRANSCRIPT_PREFIX}${TRANSCRIPT_ROWS - 1}`);
			expect(h.terminal.getViewport().join("\n")).toContain("EDITOR");
		} finally {
			h.composer.stop();
		}
	});

	it("with completeScrollback, retires displaced rows at once and never replays them when the chrome shrinks", async () => {
		const STREAMED = 20;
		const h = makeHarness();
		h.composer.setPreferences({ completeScrollback: true });
		const reachable = (): number[] =>
			h.terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
				.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 24;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		// Rows the grown chrome displaced are already in scrollback, not held live.
		expect(reachable()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));

		for (let i = TRANSCRIPT_ROWS; i < TRANSCRIPT_ROWS + STREAMED; i++) {
			const row = i;
			h.transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${row}`] });
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		// The shrink re-offers nothing: each row is reachable exactly once, in order.
		expect(reachable()).toEqual(Array.from({ length: TRANSCRIPT_ROWS + STREAMED }, (_, i) => i));
		// The input keeps the bottom row; the slack the retired rows left is the
		// band between the newest row and the input, which new output fills.
		const view = (): string[] => h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const newest = `${TRANSCRIPT_PREFIX}${TRANSCRIPT_ROWS + STREAMED - 1}`;
		const shrunk = view();
		expect(shrunk[ROWS - 1]).toBe("EDITOR");
		expect(shrunk.slice(shrunk.indexOf(newest) + 1, ROWS - 1).every(row => row === "")).toBe(true);
		h.transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${TRANSCRIPT_ROWS + STREAMED}`] });
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const filled = view();
		expect(filled[ROWS - 1]).toBe("EDITOR");
		expect(filled.indexOf(`${TRANSCRIPT_PREFIX}${TRANSCRIPT_ROWS + STREAMED}`)).toBe(filled.indexOf(newest) + 2);
		expect(reachable()).toEqual(Array.from({ length: TRANSCRIPT_ROWS + STREAMED + 1 }, (_, i) => i));

		h.composer.stop();
	});

	it("keeps the below-chrome baseline across a height resize while inline chrome is expanded", async () => {
		const shorter = ROWS - 10;
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// Expand, resize the terminal height *while still expanded*, then keep
		// rendering before shrinking. The retirement baseline must not adopt the
		// expanded peak at the resize, or the frames before the shrink retire
		// rows the shrink cannot reclaim and the editor is stranded again.
		h.widget.rows = 24;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		h.terminal.resize(COLUMNS, shorter);
		await h.scheduler.advance(h.terminal, 300);
		for (let frame = 0; frame < 5; frame++) {
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const after = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(after.findIndex(row => row.includes("EDITOR"))).toBe(shorter - 1);
		const lastContent = after.reduce((last, row, i) => (row.length > 0 ? i : last), -1);
		expect(lastContent).toBe(shorter - 1);

		h.composer.stop();
	});

	it("clips the live tail from the top instead of compacting it when the chrome grows a few rows", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// A persistent few-row growth (multi-line prompt, todo HUD, subagent badge)
		// lifts the chrome above the retirement baseline. The tail must scroll
		// off the top like native history would — not collapse into the
		// one-row-per-block emergency layout that drops every inter-block blank
		// and strands the freed rows below the editor.
		h.widget.rows = 3;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const editorRow = view.findIndex(row => row.includes("EDITOR"));
		expect(editorRow).toBe(ROWS - 1);
		const transcriptRows = view.slice(0, editorRow - 3);
		const separators = transcriptRows.filter(
			(row, i) => row === "" && transcriptRows[i - 1]?.startsWith(TRANSCRIPT_PREFIX),
		);
		expect(separators.length).toBeGreaterThan(0);
		expect(transcriptRows.at(-1)).toBe(`${TRANSCRIPT_PREFIX}${TRANSCRIPT_ROWS - 1}`);

		h.composer.stop();
	});

	it("refills the screen with live rows when turn-scoped chrome goes away", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		h.hud.rows = 6;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		// The turn ends: the todo/loader HUD closes. The rows it pushed aside
		// stayed live, so they return instead of leaving a band.
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		h.composer.stop();
	});

	it("leaves no band inside a streamed answer when the working loader goes away", async () => {
		const h = makeHarness(COLUMNS, 30);
		await h.scheduler.settle(h.terminal);
		const message = new AssistantMessageComponent();
		h.transcript.addChild(message);
		h.hud.rows = 2; // the working loader, up for the whole turn
		let text = "";
		for (let p = 0; p < 12; p++) {
			const words = Array.from({ length: 25 + (p % 4) * 10 }, (_, w) => `p${p}w${w}`).join(" ");
			for (const chunk of [words.slice(0, words.length / 2), words]) {
				message.updateContent(reply(`${text}${chunk}`), { transient: true });
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
			}
			text += `${words}\n\n`;
		}
		message.updateContent(reply(text.trim()));
		message.markTranscriptBlockFinalized();
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		// Streaming committed only rows that had left the screen, so the rows the
		// loader covered refill from the live tail instead of a blank band.
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		const words = h.terminal
			.getScrollBuffer()
			.join(" ")
			.split(/\s+/)
			.map(word => Bun.stripANSI(word))
			.filter(word => /^p\d+w\d+$/.test(word));
		expect(new Set(words).size).toBe(words.length);
		expect(words.length).toBe(text.split(/\s+/).filter(Boolean).length);
		h.composer.stop();
	});

	it("refills the screen when a tall HUD closes a frame after the answer finalizes", async () => {
		const rows = 30;
		const h = makeHarness(COLUMNS, rows, 0);
		await h.scheduler.settle(h.terminal);
		h.hud.rows = 23;
		await streamFinalizedAnswer(h);
		// The HUD outlives the finalizing paint by a frame, as a loader does when
		// the turn-end event trails the message-end event.
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.advance(h.terminal, 300);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		h.composer.stop();
	});

	it("keeps turn-scoped chrome out of the floor across a mid-run gap with no streaming block", async () => {
		const rows = 30;
		const h = makeHarness(COLUMNS, rows, 0);
		await h.scheduler.settle(h.terminal);
		h.composer.setRunActive(true);
		h.hud.rows = 23;
		await streamFinalizedAnswer(h);
		// A tool runs between assistant blocks for longer than the settle window.
		await h.scheduler.advance(h.terminal, 300);
		h.hud.rows = 0;
		h.composer.setRunActive(false);
		await h.scheduler.advance(h.terminal, 300);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		h.composer.stop();
	});

	it("keeps a draft left open after the run out of the floor", async () => {
		const rows = 30;
		const h = makeHarness(COLUMNS, rows, 0);
		h.composer.setRuntimeChildren([h.transcript, h.hud, h.editor], { transientChrome: [h.editor] });
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 15;
		await streamFinalizedAnswer(h);
		await h.scheduler.advance(h.terminal, 300);
		// Submitting or clearing the draft collapses the editor surface.
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		h.composer.stop();
	});

	for (const placement of ["above", "below"] as const) {
		it(`clears a settled extension widget ${placement} the editor without a seam band or erasing shell history`, async () => {
			const rows = 30;
			const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
			const h = makeHarness(COLUMNS, rows, 0, shell);
			const above = new Container();
			above.addChild(new EditorTopGap(() => false));
			const below = new Container();
			const widget = new InlineWidget();
			const root = placement === "above" ? above : below;
			root.addChild(widget);
			h.composer.setRuntimeChildren([h.transcript, above, h.editor, below]);
			await h.scheduler.settle(h.terminal);
			h.composer.setRunActive(true);
			widget.rows = 7;
			await streamFinalizedAnswer(h);
			h.composer.setRunActive(false);
			await h.scheduler.advance(h.terminal, 300);
			const history = (): string[] =>
				h.terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trim())
					.filter(row => /^(shell|line|next)\d+$/.test(row));
			const expected = [...shell, ...Array.from({ length: 110 }, (_, i) => `line${i}`)];
			expect(history()).toEqual(expected);
			expect(
				h.terminal
					.getViewport()
					.map(row => Bun.stripANSI(row).trim())
					.filter(row => row.startsWith("Live widget row ")),
			).toEqual(Array.from({ length: 7 }, (_, i) => `Live widget row ${i}`));

			root.removeChild(widget);
			h.composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			const editorRow = h.terminal.getViewport().findIndex(row => row.includes("EDITOR"));
			expect(editorRow).toBeLessThan(rows - 1);
			expect(editorRow).toBeGreaterThanOrEqual(0);
			expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
			expect(history()).toEqual(expected);
			for (let frame = 0; frame < 3; frame++) {
				h.composer.ui.requestRender();
				await h.scheduler.advance(h.terminal, 300);
				expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(editorRow);
				expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
				expect(history()).toEqual(expected);
			}

			// New output naturally fills the freed rows and restores bottom alignment.
			const next = Array.from({ length: 40 }, (_, i) => `next${i}`);
			h.composer.setRunActive(true);
			for (const row of next) h.transcript.addChild({ render: () => [row] });
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			h.composer.setRunActive(false);
			await h.scheduler.advance(h.terminal, 300);
			expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
			expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
			expect(history()).toEqual([...expected, ...next]);
			h.composer.stop();
		});

		for (const timing of ["before settlement", "after settlement"] as const) {
			it(`preserves every transcript and shell row when an extension widget ${placement} the editor appears ${timing}`, async () => {
				const rows = 30;
				const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
				const h = makeHarness(COLUMNS, rows, 0, shell);
				const persistent = new InlineWidget();
				const above = new Container();
				above.addChild(new EditorTopGap(() => false));
				const below = new Container();
				const root = placement === "above" ? above : below;
				h.composer.setRuntimeChildren([h.transcript, persistent, above, h.editor, below], {
					transientChrome: [h.editor],
				});
				try {
					await h.scheduler.settle(h.terminal);
					h.composer.setRunActive(true);
					persistent.rows = 3;
					await streamFinalizedAnswer(h);
					h.composer.setRunActive(false);
					await h.scheduler.settle(h.terminal);
					if (timing === "after settlement") await h.scheduler.advance(h.terminal, 300);

					// Extension agent_end work can install chrome after the final busy
					// paint, including after the first idle height has already settled.
					const widget = new InlineWidget();
					widget.rows = 7;
					root.addChild(widget);
					h.composer.ui.requestRender();
					await h.scheduler.advance(h.terminal, 300);
					const history = (): string[] =>
						h.terminal
							.getScrollBuffer()
							.map(row => Bun.stripANSI(row).trim())
							.filter(row => /^(shell|line)\d+$/.test(row));
					const expected = [...shell, ...Array.from({ length: 110 }, (_, i) => `line${i}`)];
					expect(history()).toEqual(expected);
					expect(
						h.terminal
							.getViewport()
							.map(row => Bun.stripANSI(row).trim())
							.filter(row => row.startsWith("Live widget row ")),
					).toEqual([
						...Array.from({ length: 3 }, (_, i) => `Live widget row ${i}`),
						...Array.from({ length: 7 }, (_, i) => `Live widget row ${i}`),
					]);

					root.removeChild(widget);
					h.composer.ui.requestRender();
					await h.scheduler.advance(h.terminal, 300);
					const editorRow = h.terminal.getViewport().findIndex(row => row.includes("EDITOR"));
					expect(editorRow).toBeGreaterThanOrEqual(0);
					expect(editorRow).toBeLessThan(rows - 1);
					expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
					expect(history()).toEqual(expected);
					h.composer.ui.requestRender();
					await h.scheduler.advance(h.terminal, 300);
					expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(editorRow);
					expect(history()).toEqual(expected);
				} finally {
					h.composer.stop();
				}
			});
		}
	}

	it("contracts a promoted persistent widget floor even while a tall transient draft masks the removal", async () => {
		const rows = 30;
		const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
		const h = makeHarness(COLUMNS, rows, 0, shell);
		const persistent = new InlineWidget();
		h.composer.setRuntimeChildren([h.transcript, persistent, h.editor], { transientChrome: [h.editor] });
		try {
			await h.scheduler.settle(h.terminal);
			h.composer.setRunActive(true);
			persistent.rows = 7;
			await streamFinalizedAnswer(h);
			h.composer.setRunActive(false);
			await h.scheduler.advance(h.terminal, 300);
			const history = (): string[] =>
				h.terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trim())
					.filter(row => /^(shell|line|next)\d+$/.test(row));
			const widgetRows = (): number =>
				h.terminal.getViewport().filter(row => Bun.stripANSI(row).trim().startsWith("Live widget row ")).length;
			const expected = [...shell, ...Array.from({ length: 110 }, (_, i) => `line${i}`)];
			// The persistent widget settled and was promoted into the retirement floor.
			expect(history()).toEqual(expected);
			expect(widgetRows()).toBe(7);

			// A tall multi-line draft expands the transient editor by 15 rows.
			h.widget.rows = 15;
			h.composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			expect(widgetRows()).toBe(22);

			// The persistent widget disappears while the draft stays expanded: the
			// total painted chrome is still taller than the old floor, so only the
			// transient-adjusted height reveals the contraction.
			persistent.rows = 0;
			h.composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			expect(widgetRows()).toBe(15);

			// Output finalized now must retire against the contracted floor, not the
			// stale 7-row one.
			const next = Array.from({ length: 40 }, (_, i) => `next${i}`);
			h.composer.setRunActive(true);
			for (const row of next) h.transcript.addChild({ render: () => [row] });
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			h.composer.setRunActive(false);
			await h.scheduler.advance(h.terminal, 300);
			expect(widgetRows()).toBe(15);

			// Closing the draft refills the freed rows from the transcript with no seam.
			h.widget.rows = 0;
			h.composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			expect(widgetRows()).toBe(0);
			expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
			expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
			const viewport = h.terminal.getViewport().map(row => Bun.stripANSI(row).trim());
			expect(viewport.filter(row => /^next\d+$/.test(row)).at(-1)).toBe("next39");
			expect(history()).toEqual([...expected, ...next]);
			h.composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
			expect(history()).toEqual([...expected, ...next]);
		} finally {
			h.composer.stop();
		}
	});

	it("does not bill a transient HUD already painted on the first frame into the floor", async () => {
		const rows = 30;
		const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
		const terminal = new VirtualTerminal(COLUMNS, rows);
		terminal.write(`${shell.join("\r\n")}${"\r\n".repeat(rows + 1)}`);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		const todos = new InlineWidget();
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		// A resumed session paints its restored todo HUD before the first frame.
		todos.rows = 8;
		composer.setRuntimeChildren([transcript, todos, editor], {
			transientChrome: [editor],
			selfClearingChrome: [todos],
		});
		composer.start({ playWelcomeIntro: false });
		const h = { terminal, scheduler, composer, transcript, editor };
		try {
			await h.scheduler.settle(h.terminal);
			composer.setRunActive(true);
			const answer = Array.from({ length: 110 }, (_, i) => `line${i}`);
			for (const row of answer) transcript.addChild({ render: () => [row] });
			composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			composer.setRunActive(false);
			await h.scheduler.advance(h.terminal, 300);

			// The todo HUD auto-clears: rows it covered must come back, not leave a band.
			todos.rows = 0;
			composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
			expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
			const history = h.terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trim())
				.filter(row => /^(shell|line)\d+$/.test(row));
			expect(history).toEqual([...shell, ...answer]);
		} finally {
			composer.stop();
		}
	});

	it("does not bill a startup draft replayed before runtime mount into the floor", async () => {
		const rows = 30;
		const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
		const terminal = new VirtualTerminal(COLUMNS, rows);
		terminal.write(`${shell.join("\r\n")}${"\r\n".repeat(rows + 1)}`);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		const editorRoot = new Container();
		composer.start({ playWelcomeIntro: false });
		try {
			// The bootstrap frame paints the empty editor before any keystroke replay.
			await scheduler.settle(terminal);
			// Buffered keystrokes replay into the editor before the runtime mounts.
			composer.editor.setText("draft1\ndraft2\ndraft3\ndraft4\ndraft5");
			const originalRender = composer.editor.render.bind(composer.editor);
			let editorRenders = 0;
			composer.editor.render = (width: number) => {
				editorRenders++;
				return originalRender(width);
			};
			composer.renderFrame({ columns: COLUMNS, rows });
			composer.editor.render = originalRender;
			// A pre-mount frame renders the editor once, not once for layout and again for row tracking.
			expect(editorRenders).toBe(1);
			editorRoot.addChild(composer.editor);
			composer.setRuntimeChildren([transcript, editorRoot], { transientChrome: [editorRoot] });
			await scheduler.settle(terminal);

			composer.setRunActive(true);
			const answer = Array.from({ length: 110 }, (_, i) => `line${i}`);
			for (const row of answer) transcript.addChild({ render: () => [row] });
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			composer.setRunActive(false);
			await scheduler.advance(terminal, 300);

			// Clearing (not submitting) the draft must hand its rows back, not leave a band.
			composer.editor.setText("EDITOR");
			composer.ui.requestRender();
			await scheduler.advance(terminal, 300);
			const view = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(view.some(row => row.includes("draft1"))).toBe(false);
			expect(view.findIndex(row => row.includes("EDITOR"))).toBeGreaterThanOrEqual(rows - 3);
			expect(blankBand(terminal)).toBeLessThanOrEqual(2);
			const history = terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trim())
				.filter(row => /^(shell|line)\d+$/.test(row));
			expect(history).toEqual([...shell, ...answer]);
		} finally {
			composer.stop();
		}
	});

	it("keeps the editor on the bottom row when a live block collapses under retired history", async () => {
		const h = makeHarness();
		const transcript = new TranscriptContainer();
		for (let i = 0; i < TRANSCRIPT_ROWS; i++) transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${i}`] });
		// A streaming tool preview that collapses to its short result.
		let toolRows = 12;
		transcript.addChild({ render: () => Array.from({ length: toolRows }, (_, i) => `Tool row ${i}`) });
		h.composer.setRuntimeChildren([transcript, h.hud, h.editor]);
		await h.scheduler.settle(h.terminal);
		toolRows = 4;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(view.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		expect(view.filter(row => row.startsWith("Tool row "))).toHaveLength(4);
		h.composer.stop();
	});

	it("parks a collapsing block's slack below the reply instead of banding its history", async () => {
		const rows = 50;
		const h = makeHarness(107, rows, 10);
		const card = new InlineWidget();
		card.rows = 25;
		h.transcript.addChild(card);
		const message = new AssistantMessageComponent();
		h.transcript.addChild(message);
		h.hud.rows = 2;
		await h.scheduler.settle(h.terminal);
		const table = [
			"| When | Where / unit | What he reports |",
			"|---|---|---|",
			`| 2024-08→ | **Kursk** | ${"Joined the Kursk counterattack after Ukraine's incursion; the unit retook territory; in Feb 2025 awarded a medal. ".repeat(3)} |`,
		].join("\n");
		const text = `**What the sources describe** — his own account, as printed in the interviews.\n\n${table}\n\n**Motivation.** Another paragraph of the reply, long enough to wrap at this width.\n`;
		for (let i = 1; i <= text.length; i += 24) {
			if (i / text.length > 0.7) card.rows = 1;
			message.updateContent(reply(text.slice(0, i)), { transient: true });
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		message.updateContent(reply(text));
		message.markTranscriptBlockFinalized();
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const bottom = view.findIndex(row => row.includes("└"));
		let run = 0;
		let longest = 0;
		for (const row of view.slice(0, bottom + 1)) {
			run = row === "" ? run + 1 : 0;
			longest = Math.max(longest, run);
		}
		// The reply rides directly under the retired history: the slack the collapse
		// opened must not sit above the live rows, where it reads as a hole punched
		// into the answer (and, carrying no cells, cannot be covered by any repaint).
		expect(view[0]).not.toBe("");
		expect(longest).toBeLessThanOrEqual(1);
		expect(view.findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
		h.composer.stop();
	});
});

describe("composer compact chrome budget", () => {
	function statusRows(terminal: VirtualTerminal): string[] {
		return terminal
			.getViewport()
			.filter(row => Bun.stripANSI(row).includes("Live widget row"))
			.map(row => Bun.stripANSI(row));
	}

	async function renderStatus(rows: number, optIn: boolean): Promise<{ visible: string[]; stop: () => void }> {
		const terminal = new VirtualTerminal(60, 12);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		const status = new (class extends InlineWidget {
			isCompactBudgetedChrome(): boolean {
				return optIn;
			}
		})();
		status.rows = rows;
		composer.setRuntimeChildren([transcript, status, editor], { transientChrome: [editor] });
		composer.start({ playWelcomeIntro: false });
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		return { visible: statusRows(terminal), stop: () => composer.stop() };
	}

	it("trims opted-in status chrome to the short-screen budget", async () => {
		const previous = { ...chatTranscriptDisplayPreferences };
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const status = await renderStatus(8, true);
		try {
			// 12 rows keep 4 for prose and 3 for input, so five status rows fit.
			expect(status.visible).toHaveLength(5);
		} finally {
			status.stop();
			setChatTranscriptDisplayPreferences(previous);
		}
	});

	it("renders status chrome that did not opt in in full", async () => {
		const previous = { ...chatTranscriptDisplayPreferences };
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const status = await renderStatus(8, false);
		try {
			expect(status.visible).toHaveLength(8);
		} finally {
			status.stop();
			setChatTranscriptDisplayPreferences(previous);
		}
	});
});
