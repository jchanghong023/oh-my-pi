import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getSettingDef } from "@oh-my-pi/pi-coding-agent/config/settings-defs";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { cfgHindsightApiToken } from "@oh-my-pi/pi-coding-agent/hindsight/settings";
import { cfgMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/settings";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { mountSettingsWindow, settingsScreen } from "../../helpers/settings-window";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

function createSelector(onCancel: () => void = () => {}, columns = 120): TestTerminal {
	return mountSettingsWindow({ callbacks: { onCancel } }, { columns });
}

function settingLabel(path: string): string {
	const def = getSettingDef(createSettingsHost().entries, path);
	if (!def) throw new Error(`Missing setting: ${path}`);
	return def.label;
}

/** Switch to the memory page (after appearance/model/interaction/context). */
function focusMemoryTab(term: TestTerminal): void {
	for (let i = 0; i < 4; i++) term.press("right");
}

/** The `N match(es)` search banner row. */
function banner(term: TestTerminal): string {
	return (
		settingsScreen(term)
			.split("\n")
			.find(line => /\d+ match/.test(line)) ?? ""
	);
}

describe("settings memory page and search", () => {
	it("reveals condition-gated Hindsight rows the moment memory.backend changes via the submenu", () => {
		cfgMemoryBackend.set(settings, "off");
		const comp = createSelector(undefined, 70);
		focusMemoryTab(comp);
		const before = settingsScreen(comp);
		expect(before).toContain(settingLabel("memory.backend"));
		expect(before).not.toContain(settingLabel("hindsight.apiUrl"));
		expect(before).not.toContain(settingLabel("hindsight.apiToken"));

		// Memory Backend is the only visible row, so it is selected; Enter opens its menu on "off",
		// two steps down reach "hindsight".
		comp.press("enter");
		comp.press("down");
		comp.press("down");
		comp.press("enter");

		expect(cfgMemoryBackend.get(settings)).toBe("hindsight");
		const after = settingsScreen(comp);
		expect(after).toContain(settingLabel("memory.backend"));
		expect(after).toContain(settingLabel("hindsight.apiUrl"));
		expect(after).toContain(settingLabel("hindsight.apiToken"));
		expect(after).toContain(settingLabel("hindsight.autoRecall"));
		comp.dispose();
	});

	it("saves a pasted Hindsight API token from its settings row", () => {
		cfgMemoryBackend.set(settings, "hindsight");
		cfgHindsightApiToken.set(settings, "saved-secret-token");
		const comp = createSelector();

		comp.type(settingLabel("hindsight.apiToken"));
		const row = settingsScreen(comp);
		expect(row).toContain(settingLabel("hindsight.apiToken"));
		expect(row).toContain("••••••••");
		expect(row).not.toContain("saved-secret-token");

		comp.press("enter");
		expect(settingsScreen(comp)).not.toContain("saved-secret-token");
		comp.press("enter");
		expect(cfgHindsightApiToken.get(settings)).toBe("saved-secret-token");
		expect(settingsScreen(comp)).not.toContain("saved-secret-token");

		comp.press("enter");
		comp.press("ctrl+u");
		comp.paste("test-token-123");
		expect(settingsScreen(comp)).not.toContain("test-token-123");
		comp.press("enter");

		expect(cfgHindsightApiToken.get(settings)).toBe("test-token-123");
		expect(loadHindsightConfig(settings).hindsightApiToken).toBe("test-token-123");
		expect(settingsScreen(comp)).not.toContain("test-token-123");
		comp.dispose();
	});

	it("hides Hindsight rows again when the backend is switched back to off without leaving the tab", () => {
		cfgMemoryBackend.set(settings, "hindsight");
		const comp = createSelector(undefined, 70);
		focusMemoryTab(comp);
		expect(settingsScreen(comp)).toContain(settingLabel("hindsight.apiUrl"));

		// The Memory Backend menu opens on the current value ("hindsight"); two steps up reach "off".
		comp.press("enter");
		comp.press("up");
		comp.press("up");
		comp.press("enter");

		expect(cfgMemoryBackend.get(settings)).toBe("off");
		const after = settingsScreen(comp);
		expect(after).toContain(settingLabel("memory.backend"));
		expect(after).not.toContain(settingLabel("hindsight.apiUrl"));
		expect(after).not.toContain(settingLabel("hindsight.autoRecall"));
		comp.dispose();
	});

	it("clears the global settings search on Escape before closing the selector", () => {
		let cancelCount = 0;
		const comp = createSelector(() => {
			cancelCount++;
		});

		// Typing starts the cross-tab search: the banner shows the query and its matches.
		comp.type("b");
		expect(banner(comp)).toContain(" b ");

		// First Escape exits search mode without closing the panel.
		comp.press("escape");
		expect(cancelCount).toBe(0);
		expect(banner(comp)).toBe("");

		comp.press("escape");
		expect(cancelCount).toBe(1);
		comp.dispose();
	});

	it("puts the exact global settings search hit before incidental matches", () => {
		const comp = createSelector();
		const label = settingLabel("providers.fetch");
		comp.type(label);
		const cursor = currentTheme().symbols.symbol("nav.cursor") || ">";
		const selected = settingsScreen(comp)
			.split("\n")
			.find(line => line.includes(`${cursor} ${label}`));
		expect(selected).toBeDefined();
		comp.dispose();
	});

	it("supports editor hotkeys in the global search bar", () => {
		const comp = createSelector();

		// alt+backspace deletes the trailing word from the query.
		comp.type("image provider");
		comp.press("alt+backspace");
		expect(banner(comp)).toContain("image");
		expect(banner(comp)).not.toContain("provider");

		// Arrow keys move the cursor; typing inserts mid-query instead of appending.
		comp.press("ctrl+u"); // clears the query before the cursor
		comp.type("model");
		for (let i = 0; i < 5; i++) comp.press("left");
		comp.type("x");
		expect(banner(comp)).toContain("xmodel");
		comp.dispose();
	});

	it("delegates Escape to an open settings submenu before closing the selector", () => {
		let cancelCount = 0;
		cfgMemoryBackend.set(settings, "off");
		const comp = createSelector(() => {
			cancelCount++;
		});
		focusMemoryTab(comp);

		comp.press("enter");
		comp.press("escape");
		expect(cancelCount).toBe(0);
		expect(settingsScreen(comp)).toContain(settingLabel("memory.backend"));

		comp.press("escape");
		expect(cancelCount).toBe(1);
		comp.dispose();
	});
});
