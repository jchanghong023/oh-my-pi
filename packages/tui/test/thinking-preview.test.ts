import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { getMarkdownTheme, initTheme, theme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});

const components: AssistantMessageComponent[] = [];
let previousPreferences = { ...chatTranscriptDisplayPreferences };
beforeEach(() => {
	previousPreferences = { ...chatTranscriptDisplayPreferences };
});
afterEach(() => {
	for (const component of components) component.dispose();
	components.length = 0;
	setChatTranscriptDisplayPreferences(previousPreferences);
});

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function assistant(compact: boolean, hide = false): AssistantMessageComponent {
	setChatTranscriptDisplayPreferences({ hideToolActivity: false });
	const component = new AssistantMessageComponent(
		undefined,
		hide,
		undefined,
		[],
		undefined,
		true,
		undefined,
		false,
		compact,
	);
	components.push(component);
	return component;
}

const plain = (rows: readonly string[]) => rows.map(row => Bun.stripANSI(row));
const thinking = (source: string): AssistantMessage => message([{ type: "thinking", thinking: source }]);

function expectNoInlineThinking(component: AssistantMessageComponent): void {
	expect(plain(component.render(40))).toEqual([]);
	const native = JSON.stringify(component.describe());
	expect(native).not.toContain("omp.thinking");
	expect(native).not.toContain("Thinking");
	expect(native).not.toContain("reasoning");
}

describe("compact transient thinking preview", () => {
	it("keeps current and finalized thinking entirely outside ANSI and native transcripts", () => {
		for (const hide of [false, true]) {
			const component = assistant(true, hide);
			component.updateContent(thinking("private reasoning"), { transient: true });
			expectNoInlineThinking(component);
			component.markTranscriptBlockFinalized();
			expectNoInlineThinking(component);
			expect(component.renderCompactThinkingPreview(40)).toEqual([]);
		}
	});

	it("lays out formatted Markdown at the current width before selecting the latest two physical rows", () => {
		const source = "alpha **beta** gamma delta epsilon zeta eta theta iota kappa";
		const component = assistant(true);
		component.updateContent(thinking(source), { transient: true });
		const markdown = new Markdown(source, 1, 0, getMarkdownTheme(), {
			color: value => theme.fg("thinkingText", value),
			italic: true,
		});
		markdown.transientRenderCache = true;
		for (const width of [18, 32, 12]) {
			const rows = component.renderCompactThinkingPreview(width);
			expect(plain(rows)).toEqual(plain(markdown.render(width).slice(-2)));
			expect(rows[0]).toBe(theme.fg("dim", Bun.stripANSI(rows[0]!)));
			expect(rows[1]).toBe(theme.fg("thinkingText", Bun.stripANSI(rows[1]!)));
		}
	});

	it("reserves a blank second row for one line and keeps actual blank rows in the tail", () => {
		const component = assistant(true);
		component.updateContent(thinking("reasoning"), { transient: true });
		expect(plain(component.renderCompactThinkingPreview(40)).map(row => row.trim())).toEqual(["reasoning", ""]);
		component.updateContent(thinking("first\n\nlatest"), { transient: true });
		const rows = plain(component.renderCompactThinkingPreview(40));
		expect(rows).toHaveLength(2);
		expect(rows[0]!.trim()).toBe("");
		expect(rows[1]).toContain("latest");
	});

	it("does not treat thinking between answer blocks as a visible transcript boundary", () => {
		const component = assistant(true);
		component.updateContent(
			message([
				{ type: "text", text: "before" },
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "after" },
			]),
			{ transient: true },
		);
		const textOnly = assistant(true);
		textOnly.updateContent(
			message([
				{ type: "text", text: "before" },
				{ type: "text", text: "after" },
			]),
			{ transient: true },
		);
		expect(component.render(40)).toEqual(textOnly.render(40));
		expect(JSON.stringify(component.describe())).not.toContain("private reasoning");
		expect(component.renderCompactThinkingPreview(40)).toEqual([]);
	});

	it("clears on answer text, tool activity, empty content, and the non-transient final update", () => {
		const component = assistant(true);
		const transitions: AssistantMessage["content"][] = [
			[
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "answer" },
			],
			[
				{ type: "thinking", thinking: "reasoning" },
				{ type: "toolCall", id: "call", name: "read", arguments: {} },
			],
			[
				{ type: "toolCall", id: "call", name: "read", arguments: {} },
				{ type: "thinking", thinking: "reasoning" },
			],
			[{ type: "thinking", thinking: "   " }],
			[],
		];
		for (const content of transitions) {
			component.updateContent(thinking("reasoning"), { transient: true });
			expect(component.renderCompactThinkingPreview(40)).toHaveLength(2);
			component.updateContent(message(content), { transient: true });
			expect(component.renderCompactThinkingPreview(40)).toEqual([]);
		}
		component.updateContent(thinking("reasoning"), { transient: true });
		component.updateContent(thinking("reasoning"));
		expect(component.renderCompactThinkingPreview(40)).toEqual([]);
	});

	it("clears on cancellation, failure, hiding, and finalization without leaving an old tail for a later stream", () => {
		const component = assistant(true);
		for (const stopReason of ["aborted", "error"] as const) {
			component.updateContent({ ...thinking("reasoning"), stopReason }, { transient: true });
			expect(component.renderCompactThinkingPreview(40)).toEqual([]);
		}
		component.updateContent(thinking("old reasoning"), { transient: true });
		expect(component.renderCompactThinkingPreview(40)).toHaveLength(2);
		component.setHideThinkingBlock(true);
		expect(component.renderCompactThinkingPreview(40)).toEqual([]);
		component.updateContent(thinking("new reasoning"), { transient: true });
		component.setHideThinkingBlock(false);
		expect(plain(component.renderCompactThinkingPreview(40)).join("\n")).toContain("new reasoning");
		expect(plain(component.renderCompactThinkingPreview(40)).join("\n")).not.toContain("old reasoning");
		component.markTranscriptBlockFinalized();
		expect(component.renderCompactThinkingPreview(40)).toEqual([]);
	});

	it("retains complete thinking only in detailed mode and never exposes the dock in clean mode", () => {
		const source = "first\n\nsecond\n\nthird";
		const detailed = assistant(false);
		detailed.updateContent(thinking(source), { transient: true });
		for (const word of ["first", "second", "third"]) {
			expect(plain(detailed.render(40)).join("\n")).toContain(word);
			expect(JSON.stringify(detailed.describe())).toContain(word);
		}
		expect(detailed.renderCompactThinkingPreview(40)).toEqual([]);
		const clean = assistant(true, true);
		setChatTranscriptDisplayPreferences({ hideToolActivity: true });
		clean.updateContent(thinking(source), { transient: true });
		expect(clean.renderCompactThinkingPreview(40)).toEqual([]);
	});
});
