/**
 * Status-line settings and the live state the bar shows beside them: how a
 * preset and the user's options combine, the facts the app pushes (badges,
 * tree cost, modes, extension statuses), and that git is only probed while
 * git integration is on and a git-backed segment is visible.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgGitEnabled } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { STATUS_LINE_PRESETS } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/presets";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/types";
import { effectiveStatusSettings } from "@oh-my-pi/pi-coding-agent/ui/status/segments";
import { composerShape } from "@oh-my-pi/pi-coding-agent/ui/styles/composer/shapes";
import { printRows } from "@oh-my-pi/pi-coding-agent/ui/print-rows";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { createStatusLine, shapePlacement } from "../src/ui/status/status-line";
import { disposeStatusLines, flushStatus, lineText, statusLine, statusSession } from "./helpers/session-status-line";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	disposeStatusLines();
	cfgGitEnabled.clearOverride(Settings.instance);
});

function makeLine(settings: Partial<StatusLineSettings>) {
	const model = {
		id: "test-model",
		name: "Test Model",
		provider: "test",
		contextWindow: 100_000,
		input: ["text"],
	};
	return statusLine(
		statusSession({
			model,
			state: { messages: [], model },
			sessionManager: { getSessionName: () => "Cache Session" },
		}),
		settings,
	);
}

describe("effective status-line settings", () => {
	it("preserves preset option siblings while user segment options win", () => {
		const effective = effectiveStatusSettings({
			preset: "default",
			segmentOptions: { path: { maxLength: 7 }, git: { showUntracked: false } },
		});
		expect(effective.segmentOptions.path).toEqual({
			abbreviate: true,
			maxLength: 7,
			stripWorkPrefix: true,
		});
		expect(effective.segmentOptions.git?.showBranch).toBe(true);
		expect(effective.segmentOptions.git?.showStaged).toBe(true);
		expect(effective.segmentOptions.git?.showUnstaged).toBe(true);
		expect(effective.segmentOptions.git?.showUntracked).toBe(false);
	});

	it("uses custom segment arrays only for the custom preset", () => {
		expect(
			effectiveStatusSettings({
				preset: "default",
				leftSegments: ["session_name"],
			}).leftSegments,
		).toEqual(STATUS_LINE_PRESETS.default.leftSegments);
		const custom = effectiveStatusSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: [],
		});
		expect(custom.leftSegments).toEqual([]);
		expect(custom.rightSegments).toEqual([]);
	});

	it("falls back to the custom preset's segments when the arrays are unconfigured", () => {
		const effective = effectiveStatusSettings({ preset: "custom" });
		expect(effective.leftSegments).toEqual(STATUS_LINE_PRESETS.custom.leftSegments);
		expect(effective.rightSegments).toEqual(STATUS_LINE_PRESETS.custom.rightSegments);

		const text = lineText(makeLine({ preset: "custom", sessionAccent: false }), 120);
		expect(text).toContain("Test Model");
		expect(text).toContain("Cache Session");
	});

	it("does not mutate shared preset segment options", () => {
		const before = structuredClone(STATUS_LINE_PRESETS.default.segmentOptions);
		const line = makeLine({
			preset: "default",
			sessionAccent: false,
			segmentOptions: { path: { maxLength: 3 } },
		});
		lineText(line, 12);
		lineText(line, 200);
		expect(STATUS_LINE_PRESETS.default.segmentOptions).toEqual(before);
	});
});

describe("status-line live state", () => {
	it("reports running-subagent changes by count, ignoring reordered ids", () => {
		const line = makeLine({
			preset: "custom",
			leftSegments: [],
			rightSegments: [],
		});
		expect(line.setRunningSubagents([])).toBe(false);
		expect(line.setRunningSubagents(["sub-1", "sub-2"])).toBe(true);
		expect(line.facts().subagents).toBe(2);
		expect(line.setRunningSubagents(["sub-2", "sub-1"])).toBe(false);
		expect(line.setRunningSubagents(["sub-2"])).toBe(true);
		expect(line.facts().subagents).toBe(1);
	});

	it("adds the subagent tree's cost to the cost segment", () => {
		const line = makeLine({
			preset: "custom",
			leftSegments: ["cost"],
			rightSegments: [],
		});
		expect(lineText(line)).not.toContain("(+0.50)");
		line.setModes({ subagentTreeCost: 0.5 });
		expect(lineText(line)).toContain("(+0.50)");
	});

	it("shows plan mode as soon as it is set", () => {
		const line = makeLine({
			preset: "custom",
			leftSegments: ["mode"],
			rightSegments: [],
		});
		expect(lineText(line)).not.toContain("Plan");
		line.setModes({ plan: { enabled: true, paused: false } });
		expect(lineText(line)).toContain("Plan");
	});

	it("lists extension statuses in key order without their hyperlinks, and drops cleared ones", () => {
		const line = makeLine({
			preset: "custom",
			leftSegments: ["pi", "status", "model"],
			rightSegments: [],
			separator: "powerline-thin",
			showHookStatus: false,
			sessionAccent: false,
			segmentOptions: { model: { showThinkingLevel: false } },
		});
		line.setHookStatus("z-tests", "Tests passing");
		line.setHookStatus("a-indexer", "\x1b]8;;https://example.com\x07Indexer ready\x1b]8;;\x07");

		expect(line.facts().hooks.map(hook => Bun.stripANSI(hook))).toEqual(["Indexer ready", "Tests passing"]);
		const text = lineText(line, 120);
		expect(text).not.toContain("https://example.com");
		expect(text.indexOf("Indexer ready")).toBeGreaterThanOrEqual(0);
		expect(text.indexOf("Indexer ready")).toBeLessThan(text.indexOf("Tests passing"));
		expect(text.indexOf("Tests passing")).toBeLessThan(text.indexOf("Test Model"));

		line.setHookStatus("a-indexer", undefined);
		line.setHookStatus("z-tests", undefined);
		const cleared = lineText(line, 120);
		expect(cleared).not.toContain("Indexer ready");
		expect(cleared).not.toContain("Tests passing");
	});

	it("skips git probes when git integration is disabled", async () => {
		const repoSpy = spyOn(vcs, "repo");
		const displaySpy = spyOn(vcs, "repoForDisplay");
		try {
			cfgGitEnabled.override(Settings.instance, false);
			lineText(
				makeLine({
					preset: "custom",
					leftSegments: ["git", "pr"],
					rightSegments: [],
				}),
			);
			await flushStatus();
			expect(repoSpy).not.toHaveBeenCalled();
			expect(displaySpy).not.toHaveBeenCalled();
		} finally {
			repoSpy.mockRestore();
			displaySpy.mockRestore();
		}
	});

	it("skips git probes when no git-backed segment is visible", async () => {
		const repoSpy = spyOn(vcs, "repo");
		const displaySpy = spyOn(vcs, "repoForDisplay");
		try {
			lineText(
				makeLine({
					preset: "custom",
					leftSegments: ["pi"],
					rightSegments: ["session_name"],
				}),
			);
			await flushStatus();
			expect(repoSpy).not.toHaveBeenCalled();
			expect(displaySpy).not.toHaveBeenCalled();
		} finally {
			repoSpy.mockRestore();
			displaySpy.mockRestore();
		}
	});

	function hookRows(line: ReturnType<typeof makeLine>, width: number): string[] {
		return printRows(
			() =>
				createStatusLine({
					settings: () => line.settings(),
					facts: () => line.facts(),
					placement: () => shapePlacement(composerShape("band"), false),
				}).panel,
			width,
		);
	}

	it("renders every keyed hook on a deterministic, independently truncated line", () => {
		const line = makeLine({ showHookStatus: true });
		line.setHookStatus("project-time", "$0.04 (dev)");
		line.setHookStatus("ponytail", "Ponytail");
		expect(hookRows(line, 8).map(Bun.stripANSI)).toEqual(["Ponytail", "$0.04 (…"]);
	});

	it("keeps SGR styling from extension hooks and truncates without style bleed", () => {
		const line = makeLine({ showHookStatus: true });
		line.setHookStatus("demo", "\x1b[32mgreen\x1b[39m \x1b[31mred\x1b[39m");
		expect(hookRows(line, 80)).toEqual(["\x1b[32mgreen\x1b[39m \x1b[31mred\x1b[39m\x1b[0m"]);
		const [row] = hookRows(line, 6);
		expect(Bun.stripANSI(row!)).toBe("green…");
		expect(row).toContain("\x1b[32mgreen");
		expect(row?.endsWith("\x1b[0m…")).toBe(true);
	});

	it("strips OSC hyperlinks but retains styling in hook rows", () => {
		const line = makeLine({ showHookStatus: true });
		line.setHookStatus("link", "\x1b[1m\x1b]8;;https://example.com\x07docs\x1b]8;;\x07\x1b[22m");
		expect(hookRows(line, 80)).toEqual(["\x1b[1mdocs\x1b[22m\x1b[0m"]);
	});
});
