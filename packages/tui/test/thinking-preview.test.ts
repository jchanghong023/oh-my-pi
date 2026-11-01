import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

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
	setChatTranscriptDisplayPreferences({ compactToolActivity: compact, hideToolActivity: compact });
	const component = new AssistantMessageComponent(undefined, hide, undefined, [], undefined, true, undefined, false);
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
		}
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
	});

	it("projects cached live and historical thinking away in clean while retaining ordinary answer text", () => {
		const component = assistant(false);
		const content = message([
			{ type: "text", text: "Thinking is part of this ordinary answer." },
			{ type: "thinking", thinking: "private reasoning" },
		]);
		component.updateContent(content, { transient: true });
		expect(plain(component.render(80)).join("\n")).toContain("private reasoning");
		expect(JSON.stringify(component.describe())).toContain("private reasoning");

		setChatTranscriptDisplayPreferences({ hideToolActivity: true });
		for (const finalized of [false, true]) {
			if (finalized) component.markTranscriptBlockFinalized();
			const ansi = plain(component.render(80)).join("\n");
			const native = JSON.stringify(component.describe());
			expect(ansi).toContain("Thinking is part of this ordinary answer.");
			expect(native).toContain("Thinking is part of this ordinary answer.");
			expect(ansi).not.toContain("private reasoning");
			expect(native).not.toContain("private reasoning");
			expect(native).not.toContain("omp.thinking");
		}
		setChatTranscriptDisplayPreferences({ hideToolActivity: true, compactToolActivity: true });
		expect(plain(component.render(80)).join("\n")).not.toContain("private reasoning");
		expect(JSON.stringify(component.describe())).not.toContain("private reasoning");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
		expect(plain(component.render(80)).join("\n")).toContain("private reasoning");
		expect(JSON.stringify(component.describe())).toContain("private reasoning");
	});

	it("does not leave an ANSI pulse or expandable native node for hidden live thinking in clean", () => {
		const component = assistant(false, true);
		component.updateContent(thinking("private reasoning"), { transient: true });
		expect(plain(component.render(40)).join("\n")).toContain("Thinking");
		setChatTranscriptDisplayPreferences({ hideToolActivity: true });
		expectNoInlineThinking(component);
		component.updateContent(thinking("private reasoning continues"), { transient: true });
		expectNoInlineThinking(component);
		component.markTranscriptBlockFinalized();
		expectNoInlineThinking(component);
	});

	it("retains complete thinking only in detailed mode and never exposes the dock in clean mode", () => {
		const source = "first\n\nsecond\n\nthird";
		const detailed = assistant(false);
		detailed.updateContent(thinking(source), { transient: true });
		for (const word of ["first", "second", "third"]) {
			expect(plain(detailed.render(40)).join("\n")).toContain(word);
			expect(JSON.stringify(detailed.describe())).toContain(word);
		}
		const clean = assistant(false, true);
		setChatTranscriptDisplayPreferences({ hideToolActivity: true });
		clean.updateContent(thinking(source), { transient: true });
		expectNoInlineThinking(clean);
	});
});
