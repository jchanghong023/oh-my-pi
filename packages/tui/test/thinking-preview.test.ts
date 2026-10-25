import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { clipThinkingRows } from "@oh-my-pi/pi-tui/chat/thinking-preview";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { getMarkdownTheme, initTheme, theme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "test",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop", timestamp: 0,
	};
}

function assistant(compact: boolean, hide = false): AssistantMessageComponent {
	return new AssistantMessageComponent(undefined, hide, undefined, [], undefined, true, undefined, false, compact);
}

const plain = (rows: readonly string[]) => rows.map(row => Bun.stripANSI(row));

describe("inline thinking row clipping", () => {
	it("clips physical rows without rewrapping or dropping blank rows", () => {
		expect(plain(clipThinkingRows(["old", "", "latest"], true))).toEqual(["", "latest"]);
	});

	it("paints only the active latest row with thinkingText", () => {
		expect(clipThinkingRows(["old", "previous", "latest"], true)).toEqual([
			theme.fg("dim", "previous"), theme.fg("thinkingText", "latest"),
		]);
		expect(clipThinkingRows(["previous", "latest"], false)).toEqual([
			theme.fg("dim", "previous"), theme.fg("dim", "latest"),
		]);
	});

	it("reserves a second blank row for a single row and nothing for absent thinking", () => {
		expect(plain(clipThinkingRows(["one"], true))).toEqual(["one", ""]);
		expect(clipThinkingRows([], true)).toEqual([]);
	});

	it("clips the real Markdown layout at each width", () => {
		const source = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
		const component = assistant(true);
		component.updateContent(message([{ type: "thinking", thinking: source }]), { transient: true });
		const markdown = new Markdown(source, 1, 0, getMarkdownTheme(), {
			color: value => theme.fg("thinkingText", value), italic: true,
		});
		markdown.transientRenderCache = true;
		for (const width of [18, 32, 12]) {
			expect(plain(component.render(width))).toEqual(plain(clipThinkingRows(markdown.render(width), true)));
		}
		component.dispose();
	});

	it("keeps thinking between preceding and following assistant prose", () => {
		const component = assistant(true);
		component.updateContent(message([
			{ type: "text", text: "before" },
			{ type: "thinking", thinking: "first\n\nsecond\n\nthird" },
			{ type: "text", text: "after" },
		]), { transient: true });
		const rendered = plain(component.render(40)).join("\n");
		expect(rendered.indexOf("before")).toBeLessThan(rendered.indexOf("third"));
		expect(rendered.indexOf("third")).toBeLessThan(rendered.indexOf("after"));
		expect(rendered).not.toContain("first");
		component.dispose();
	});

	it("detailed keeps full upstream thinking and hidden thinking stays hidden", () => {
		const content: AssistantMessage["content"] = [{ type: "thinking", thinking: "first\n\nsecond\n\nthird" }];
		const detailed = assistant(false);
		detailed.updateContent(message(content), { transient: true });
		expect(plain(detailed.render(40)).join("\n")).toContain("first");
		const hidden = assistant(true, true);
		hidden.updateContent(message(content), { transient: true });
		expect(plain(hidden.render(40)).join("\n")).not.toContain("third");
		hidden.markTranscriptBlockFinalized();
		expect(plain(hidden.render(40)).join("\n")).not.toContain("Thinking");
		detailed.dispose();
		hidden.dispose();
	});

	it("does not retain an old thinking tail when content changes to answer text", () => {
		const component = assistant(true);
		component.updateContent(message([{ type: "thinking", thinking: "private reasoning" }]), { transient: true });
		component.render(40);
		component.updateContent(message([{ type: "text", text: "answer" }]), { transient: true });
		const rendered = plain(component.render(40)).join("\n");
		expect(rendered).toContain("answer");
		expect(rendered).not.toContain("private reasoning");
		component.dispose();
	});
});
