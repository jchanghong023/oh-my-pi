import { beforeAll, describe, expect, test } from "bun:test";
import { KeybindingsManager } from "../src/app-keybindings";
import { getKeybindings, setKeybindings } from "../src/keybindings";
import { CustomEditor } from "../src/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

describe("fork editor shortcut dispatch", () => {
	test("plan, thinking visibility, thinking effort and temporary model chords remain independent", () => {
		const previous = getKeybindings();
		const manager = new KeybindingsManager();
		setKeybindings(manager);
		try {
			const editor = new CustomEditor(getEditorTheme());
			const actions: string[] = [];
			editor.onCycleThinkingLevel = () => actions.push("effort");
			editor.onSelectModelTemporary = () => actions.push("model");
			for (const key of manager.getKeys("app.plan.toggle"))
				editor.setCustomKeyHandler(key, () => actions.push("plan"));
			for (const key of manager.getKeys("app.thinking.toggle"))
				editor.setCustomKeyHandler(key, () => actions.push("visibility"));
			editor.setText("unfinished task");
			editor.handleInput("\x1b[Z");
			editor.handleInput("\x1bp");
			editor.handleInput("\x1b[1;2P");
			editor.handleInput("\x14");
			expect(actions).toEqual(["plan", "visibility", "effort", "model"]);
			expect(editor.getText()).toBe("unfinished task");
		} finally {
			setKeybindings(previous);
		}
	});

	test("explicit overrides replace editor shortcuts and an empty binding disables them", () => {
		const previous = getKeybindings();
		const manager = new KeybindingsManager({ "app.thinking.cycle": "f2", "app.model.selectTemporary": [] });
		setKeybindings(manager);
		try {
			const editor = new CustomEditor(getEditorTheme());
			const actions: string[] = [];
			editor.onCycleThinkingLevel = () => actions.push("effort");
			editor.onSelectModelTemporary = () => actions.push("model");
			editor.setActionKeys("app.thinking.cycle", manager.getKeys("app.thinking.cycle"));
			editor.setActionKeys("app.model.selectTemporary", manager.getKeys("app.model.selectTemporary"));
			editor.handleInput("\x1b[1;2P");
			editor.handleInput("\x14");
			expect(actions).toEqual([]);
			editor.handleInput("\x1bOQ");
			expect(actions).toEqual(["effort"]);
		} finally {
			setKeybindings(previous);
		}
	});
});
