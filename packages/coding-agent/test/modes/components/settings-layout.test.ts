import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

import { getSettingsForTab, TAB_GROUPS, type SettingsDisplayEntry } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme, setTheme } from "@oh-my-pi/pi-tui/theme";
import { cfgRetryUsageAwareFallback } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";

beforeAll(async () => {
	await initTheme();
});

describe("settings layout", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("groups settings in declared order without dropping ungrouped or external sections", () => {
		const entry = (path: string, group?: string): SettingsDisplayEntry => ({
			path,
			type: "boolean",
			defaultValue: false,
			ui: { tab: "appearance", group, label: path, description: "" },
		});
		const firstEntries = TAB_GROUPS.appearance.map((group, index) => entry(`group-${index}-first`, group));
		const secondEntries = TAB_GROUPS.appearance.map((group, index) => entry(`group-${index}-second`, group));
		const entries: SettingsDisplayEntry[] = [
			entry("external-first", "external"),
			...firstEntries.reverse(),
			entry("ungrouped"),
			...secondEntries.reverse(),
			entry("external-second", "external"),
			{
				path: "other-tab",
				type: "boolean",
				defaultValue: false,
				ui: { tab: "model", group: TAB_GROUPS.model[0], label: "Other", description: "" },
			},
		];

		const defs = getSettingsForTab(entries, "appearance");
		expect(defs.map(def => def.path)).toEqual([
			"ungrouped",
			...TAB_GROUPS.appearance.flatMap((_, index) => [`group-${index}-first`, `group-${index}-second`]),
			"external-first",
			"external-second",
		]);
		expect(getSettingsForTab(entries, "model").map(def => def.path)).toEqual(["other-tab"]);
	});

	it("hides advisor dependent settings when advisor is disabled", () => {
		cfgAdvisorEnabled.set(Settings.instance, false);
		const advisorDependentPaths = ["advisor.syncBacklog", "advisor.immuneTurns"];
		const advisorDependentPathSet = new Set<string>(advisorDependentPaths);
		const defs = getSettingsForTab(createSettingsHost().entries, "model").filter(def =>
			advisorDependentPathSet.has(def.path),
		);

		expect(new Set(defs.map(def => def.path))).toEqual(advisorDependentPathSet);
		for (const def of defs) {
			expect(def.condition?.()).toBe(false);
		}

		cfgAdvisorEnabled.set(Settings.instance, true);

		for (const def of defs) {
			expect(def.condition?.()).toBe(true);
		}
	});

	it("shows usage reserve controls only while usage-aware fallback is enabled", () => {
		cfgRetryUsageAwareFallback.set(Settings.instance, false);
		const defs = getSettingsForTab(createSettingsHost().entries, "model").filter(def =>
			def.path.startsWith("retry.usage"),
		);
		expect(new Set(defs.map(def => def.path))).toEqual(
			new Set(["retry.usageAwareFallback", "retry.usageReservePct", "retry.usageReservePolicy"]),
		);
		expect(defs.find(def => def.path === "retry.usageAwareFallback")?.type).toBe("boolean");
		const reserveDefs = defs.filter(def => def.path !== "retry.usageAwareFallback");
		for (const def of reserveDefs) expect(def.condition?.()).toBe(false);
		cfgRetryUsageAwareFallback.set(Settings.instance, true);
		for (const def of reserveDefs) expect(def.condition?.()).toBe(true);
	});

	it("keeps each wrapped status preview line inside the settings panel", () => {
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark", "light"],
				providers: [],
				settings: createSettingsHost(),
				plugins: createPluginSettingsHost(process.cwd()),
			},
			{
				onChange: () => {},
				onCancel: () => {},
				getStatusLinePreview: () => "preview first line\npreview second line",
			},
		);
		const lines = selector.render(80).map(line => Bun.stripANSI(line));
		for (const text of ["preview first line", "preview second line"]) {
			const line = lines.find(candidate => candidate.includes(text));
			expect(line?.startsWith("│")).toBe(true);
			expect(line?.endsWith("│")).toBe(true);
			expect(line?.includes("\n")).toBe(false);
		}
	});

	it("applies the selected composer shape through the settings host", async () => {
		await setTheme("dark");
		const changes: Array<[string, unknown]> = [];
		const host = createSettingsHost();
		host.set("composer.shape", "box");
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark", "light"],
				providers: [],
				settings: host,
				plugins: createPluginSettingsHost(process.cwd()),
			},
			{
				onChange: (path, value) => changes.push([path, value]),
				onCancel: () => {},
			},
		);

		selector.handleNativeEvent({ type: "activate", key: "", item: "composer.shape" });
		// Cycle down to claude
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		expect(changes).toEqual([["composer.shape", "claude"]]);
		expect(host.get("composer.shape")).toBe("claude");
	});

	it("persists worktree option machine values from keyboard and native selection", () => {
		const host = createSettingsHost();
		host.set("session.worktreeScope", "repo");
		const changes: Array<[string, unknown]> = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["titanium", "light"],
				providers: [],
				settings: host,
				plugins: createPluginSettingsHost(process.cwd()),
			},
			{ onChange: (path, value) => changes.push([path, value]), onCancel: () => {} },
		);
		selector.handleNativeEvent({ type: "action", key: "", act: "page", value: "interaction", mods: [] });
		selector.handleNativeEvent({ type: "activate", key: "", item: "session.worktreeScope" });
		selector.handleInput("\x1b[A");
		selector.handleInput("\r");
		expect(host.get("session.worktreeScope")).toBe("directory");
		expect(changes).toEqual([["session.worktreeScope", "directory"]]);
		selector.handleNativeEvent({ type: "change", key: "", item: "session.worktreeScope", value: "repo" });
		expect(host.get("session.worktreeScope")).toBe("repo");
		expect(changes).toEqual([
			["session.worktreeScope", "directory"],
			["session.worktreeScope", "repo"],
		]);
	});
});
