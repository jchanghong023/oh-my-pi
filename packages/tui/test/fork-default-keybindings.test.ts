import { describe, expect, test } from "bun:test";
import { KEYBINDINGS } from "../src/app-keybindings";
import { DEFAULT_ACTION_KEYS } from "../src/prompt/custom-editor";

// Fork contract (docs-zh-CN/fork.md「快捷键与状态栏」): the four default
// keybindings the fork swaps. The defaults live in hand-maintained tables that
// an upstream rewrite can silently drift; these assertions pin both the app
// table and the editor-surface mirror.
describe("fork default keybindings", () => {
	test("shift+tab toggles plan mode", () => {
		expect(KEYBINDINGS["app.plan.toggle"].defaultKeys).toBe("shift+tab");
	});

	test("ctrl+t selects a temporary model", () => {
		expect(KEYBINDINGS["app.model.selectTemporary"].defaultKeys).toBe("ctrl+t");
	});

	test("alt+p toggles thinking blocks", () => {
		expect(KEYBINDINGS["app.thinking.toggle"].defaultKeys).toBe("alt+p");
	});

	test("shift+f1 cycles thinking level", () => {
		expect(KEYBINDINGS["app.thinking.cycle"].defaultKeys).toBe("shift+f1");
	});

	test("the editor mirror carries the fork values for the editor-surface keys", () => {
		expect(DEFAULT_ACTION_KEYS["app.thinking.cycle"]).toEqual(["shift+f1"]);
		expect(DEFAULT_ACTION_KEYS["app.model.selectTemporary"]).toEqual(["ctrl+t"]);
		// The mirror is hand-maintained next to KEYBINDINGS; keep both tables
		// locked to the same values so an update to one cannot forget the other.
		expect(DEFAULT_ACTION_KEYS["app.thinking.cycle"]).toEqual([KEYBINDINGS["app.thinking.cycle"].defaultKeys]);
		expect(DEFAULT_ACTION_KEYS["app.model.selectTemporary"]).toEqual([
			KEYBINDINGS["app.model.selectTemporary"].defaultKeys,
		]);
	});
});
