import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	getSettingsForTab,
	TAB_GROUPS,
	type SettingsDisplayEntry,
} from "@oh-my-pi/pi-coding-agent/config/settings-defs";
import { bubbleEvent } from "@oh-my-pi/pi-tui/dispatch";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { settingsScreen, setupSettingsWindow } from "../../helpers/settings-window";
import { cfgRetryUsageAwareFallback } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../../../src/ui/styles/overlays/composer-shape-preview";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

describe("settings layout", () => {
	const mountSettingsWindow = setupSettingsWindow();

	it("groups settings in declared order without dropping ungrouped or external sections", () => {
		const entry = (path: string, group?: string): SettingsDisplayEntry => ({
			path,
			type: "boolean",
			defaultValue: false,
			ui: { tab: "appearance", group, label: path, description: "" },
		});
		const groups = TAB_GROUPS.appearance;
		const entries = [
			entry("external-first", "external"),
			...groups.map((group, index) => entry(`group-${index}-first`, group)).reverse(),
			entry("ungrouped"),
			...groups.map((group, index) => entry(`group-${index}-second`, group)).reverse(),
			entry("external-second", "external"),
			{ ...entry("other-tab"), ui: { tab: "model", label: "Other", description: "" } },
		] satisfies SettingsDisplayEntry[];
		expect(getSettingsForTab(entries, "appearance").map(def => def.path)).toEqual([
			"ungrouped",
			...groups.flatMap((_, index) => [`group-${index}-first`, `group-${index}-second`]),
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
		const reserve = defs.filter(def => def.path !== "retry.usageAwareFallback");
		for (const def of reserve) expect(def.condition?.()).toBe(false);
		cfgRetryUsageAwareFallback.set(Settings.instance, true);
		for (const def of reserve) expect(def.condition?.()).toBe(true);
	});

	it("keeps both status preview rows inside the settings frame", () => {
		const previews = ["preview first line", "preview second line"];
		const term = mountSettingsWindow(
			{ callbacks: { describeStatusLinePreview: () => previews.map(text => jsx("text", { text })) } },
			{ columns: 80 },
		);
		const lines = settingsScreen(term).split("\n");
		for (const text of previews) {
			const line = lines.find(candidate => candidate.includes(text));
			expect(line?.startsWith("│")).toBe(true);
			expect(line?.endsWith("│")).toBe(true);
			expect(visibleWidth(line!)).toBe(80);
		}
	});

	it("offers composer shapes and persists the selected machine value", () => {
		const host = createSettingsHost();
		host.set("composer.shape", "box");
		const changes: Array<[string, unknown]> = [];
		const term = mountSettingsWindow({
			context: { settings: host },
			callbacks: { onChange: (path, value) => changes.push([path, value]) },
		});
		term.type("Composer Shape");
		term.press("enter");
		const rendered = settingsScreen(term);
		expect(rendered).toContain("Composer Shape");
		expect(rendered).toContain("Rounded Box");
		expect(rendered).toContain("Claude Code");
		term.press("down");
		term.press("enter");
		expect(changes).toEqual([["composer.shape", "claude"]]);
		expect(host.get("composer.shape")).toBe("claude");
	});

	it("persists worktree machine values from keyboard and native selection", () => {
		const host = createSettingsHost();
		host.set("session.worktreeScope", "repo");
		const changes: Array<[string, unknown]> = [];
		const term = mountSettingsWindow({
			context: { settings: host },
			callbacks: { onChange: (path, value) => changes.push([path, value]) },
		});
		const path = "session.worktreeScope";
		const root = term.surface.layer()[0]!;
		bubbleEvent([root], { type: "action", key: "", act: "page", value: "interaction", mods: [] });
		bubbleEvent([root], { type: "action", key: "", act: "edit", value: path, mods: [] });
		term.press("up");
		term.press("enter");
		expect(host.get(path)).toBe("directory");
		expect(changes).toEqual([[path, "directory"]]);
		bubbleEvent([root], { type: "change", key: "", item: path, value: "repo" });
		expect(host.get(path)).toBe("repo");
		expect(changes).toEqual([
			[path, "directory"],
			[path, "repo"],
		]);
	});
});
