import { describe, expect, it } from "bun:test";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "../src/prompt/custom-editor";
import { defaultEditorTheme } from "./test-themes";

const draft = "first\n输入文本\nlast";
const plain = (line: string) => Bun.stripANSI(line.replaceAll(CURSOR_MARKER, ""));

function editorAtNonFinalLineEnd() {
	const editor = new CustomEditor(defaultEditorTheme);
	editor.focused = true;
	editor.setUseTerminalCursor(true);
	editor.setText(draft);
	editor.render(40);
	editor.handleInput("\x1b[A");
	editor.moveToLineEnd();
	expect(editor.getCursor()).toEqual({ line: 1, col: 4 });
	return editor;
}

describe("multiline IME-safe cursor eligibility", () => {
	// No actual preedit event is needed: the focused hardware cursor opens only its own tail.
	it("opens a nonfinal CJK row without touching its neighbors or source", () => {
		const editor = editorAtNonFinalLineEnd();
		const closed = editor.render(40);
		editor.setImeSafeCursorLayout(true);
		const opened = editor.render(40);
		const cursorRow = opened.findIndex(line => line.includes(CURSOR_MARKER));
		expect(cursorRow).toBeGreaterThan(0);
		expect(plain(opened[cursorRow]!)).toBe("|  输入文本");
		expect(plain(closed[cursorRow]!)).toEndWith("|");
		expect(opened.filter((_, index) => index !== cursorRow)).toEqual(
			closed.filter((_, index) => index !== cursorRow),
		);
		expect(editor.getText()).toBe(draft);
		expect(editor.getCursor()).toEqual({ line: 1, col: 4 });
	});

	// Each missing eligibility condition must retain the ordinary layout, not just avoid throwing.
	it.each(["disabled", "unfocused", "software cursor", "middle of line", "borderless", "visual selection"] as const)(
		"keeps normal layout when %s",
		condition => {
			const editor = editorAtNonFinalLineEnd();
			if (condition === "unfocused") editor.focused = false;
			if (condition === "software cursor") editor.setUseTerminalCursor(false);
			if (condition === "middle of line") editor.handleInput("\x1b[D");
			if (condition === "borderless") editor.setBorderVisible(false);
			if (condition === "visual selection") {
				editor.setVimMode(true);
				editor.handleInput("\x1b");
				editor.handleInput("V");
				expect(editor.vimMode).toBe("visual-line");
			}
			editor.setImeSafeCursorLayout(false);
			const normal = editor.render(40);
			editor.setImeSafeCursorLayout(condition !== "disabled");
			expect(editor.render(40)).toEqual(normal);
			expect(normal.map(plain).join("\n")).toContain("输入文本");
			expect(editor.getText()).toBe(draft);
		},
	);
});
