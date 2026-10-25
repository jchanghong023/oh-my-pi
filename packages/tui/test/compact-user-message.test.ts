import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { SkillMessageComponent } from "@oh-my-pi/pi-tui/chat/skill-message";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { setTranscriptActionHandler, type TranscriptAction } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import { createUserMessageDetails, showUserMessageDetails } from "@oh-my-pi/pi-tui/overlays/user-message-details";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => {
	setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
	setTranscriptActionHandler(undefined);
});
const source = (count: number) =>
	Array.from({ length: count }, (_, i) => `row-${i.toString().padStart(2, "0")}  `).join("\n");
const plain = (rows: readonly string[]) => rows.map(row => Bun.stripANSI(row));
function fullRows(text: string, width: number): readonly string[] {
	setChatTranscriptDisplayPreferences({ compactToolActivity: false });
	const rows = new UserMessageComponent(text).render(width);
	setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
	return rows;
}

describe("compact sent user message", () => {
	it("leaves exactly ten physical rows intact, including padding", () => {
		const text = source(8);
		const full = fullRows(text, 80);
		expect(full).toHaveLength(10);
		expect(new UserMessageComponent(text).render(80)).toEqual(full);
	});
	it("slices rendered ANSI head five and tail four with one counted omission row", () => {
		const text = source(24);
		const full = fullRows(text, 80);
		const rows = new UserMessageComponent(text).render(80);
		expect(rows).toHaveLength(10);
		expect(rows.slice(0, 5)).toEqual(full.slice(0, 5));
		expect(rows.slice(6)).toEqual(full.slice(-4));
		expect(Bun.stripANSI(rows[5]!)).toContain(`已省略 ${full.length - 9} 行`);
	});
	it("reflows before slicing on resize, without reparsing partial fences or tables", () => {
		const text = `\`\`\`ts\n${source(20)}\n\`\`\`\n\n| A | B |\n| --- | --- |\n| long long long long | tail |`;
		const bubble = new UserMessageComponent(text);
		for (const width of [60, 12, 3, 60]) {
			const full = fullRows(text, width);
			const rows = bubble.render(width);
			expect(rows).toHaveLength(10);
			expect(plain(rows.slice(0, 5))).toEqual(plain(full.slice(0, 5)));
			expect(plain(rows.slice(6))).toEqual(plain(full.slice(-4)));
			expect(visibleWidth(rows[5]!)).toBeLessThanOrEqual(width);
		}
	});
	it("invalidates folding on display switches and excludes synthetic and explicit full views", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const text = source(25);
		const bubble = new UserMessageComponent(text);
		expect(bubble.render(80)).toHaveLength(10);
		setChatTranscriptDisplayPreferences({ hideToolActivity: true });
		expect(bubble.render(80).length).toBeGreaterThan(10);
		setChatTranscriptDisplayPreferences({ hideToolActivity: false, compactToolActivity: false });
		expect(bubble.render(80).length).toBeGreaterThan(10);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		expect(bubble.render(80)).toHaveLength(10);
		expect(new UserMessageComponent(text, { synthetic: true }).render(80).length).toBeGreaterThan(10);
		expect(new UserMessageComponent(text, { compactPreview: false }).render(80).length).toBeGreaterThan(10);
	});
	it("keeps the actual inline Skill summary unchanged in compact mode", () => {
		const skill = new SkillMessageComponent({
			role: "custom",
			customType: "skill-prompt",
			content: "Loaded skill instructions",
			display: true,
			attribution: "user",
			timestamp: 0,
			details: { name: "review", path: "/tmp/SKILL.md", lineCount: 20, prompt: `${source(20)}\n/skill:review` },
		});
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		const full = skill.render(80);
		expect(full.length).toBeGreaterThan(10);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		expect(skill.render(80)).toEqual(full);
	});
	it("copies and opens original source rather than transformed attachment chips", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const text = `[Image #1, 100x200]\n${source(20)}`;
		const bubble = new UserMessageComponent(text);
		bubble.render(80);
		const native = bubble.describe();
		const toolbar = native.c?.find(child => "k" in child && child.p?.role === "omp.user.tools");
		const view =
			toolbar && "k" in toolbar ? toolbar.c?.find(child => "k" in child && child.key === "view-message") : undefined;
		expect(view).toMatchObject({ k: "row", p: { role: "omp.btn", actions: { click: "view-message" } } });
		bubble.handleNativeEvent({ type: "action", key: "copy", mods: [], act: "copy-message" });
		bubble.handleNativeEvent({ type: "action", key: "view", mods: [], act: "view-message" });
		expect(actions).toEqual([
			{ act: "copy", text },
			{ act: "view-message", text },
		]);
	});
	it("keeps hidden middle accessible in an independently scrolling full report and closes on Esc", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		let closed = false;
		const panel = createUserMessageDetails(
			source(40),
			() => {
				closed = true;
			},
			() => 12,
		);
		panel.holdFocus();
		const top = plain(panel.render(80)).join("\n");
		expect(top).toContain("row-00");
		panel.handleInput("\x1b[F");
		const bottom = plain(panel.render(80)).join("\n");
		expect(bottom).toContain("row-39");
		expect(bottom).not.toContain("已省略");
		panel.handleInput("\x1b");
		expect(closed).toBe(true);
	});
	it("restores editor focus and untouched draft/chat after the full report closes", () => {
		const composer = new Composer({
			terminal: new VirtualTerminal(80, 24),
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		composer.editor.setText("unfinished draft");
		composer.ui.setFocus(composer.editor);
		const chat = new UserMessageComponent(source(30));
		composer.ui.addChild(chat);
		const before = [...composer.ui.children];
		showUserMessageDetails(composer.ui, source(30));
		expect(composer.ui.getFocused()).not.toBe(composer.editor);
		composer.ui.getFocused()?.handleInput?.("\x1b");
		expect(composer.ui.getFocused()).toBe(composer.editor);
		expect(composer.editor.getText()).toBe("unfinished draft");
		expect(composer.ui.children).toEqual(before);
		expect(composer.ui.hasOverlay()).toBe(false);
	});
});
