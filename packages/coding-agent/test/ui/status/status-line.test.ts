/**
 * `composer/status-line` corpus: the standalone status bar in every preset
 * (default, minimal, compact, full, custom, no hooks, transparent) through
 * composer placements, extension statuses and live modes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot, isUiNode, jsx, signal } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { SymbolPreset } from "@oh-my-pi/pi-tui/theme/schema";
import { getSegmentGalleryEntries } from "../../../src/cli/gallery-fixtures/segments";
import type { StatusLineSegmentId } from "../../../src/config/status-line-schema";
import type { StatusLineSettings } from "../../../src/modes/view-model/status-line/types";
import type { StatusFacts, StatusPlacement } from "../../../src/ui/status/facts";
import { createStatusLine, statusSegs, StatusLine } from "../../../src/ui/status/status-line";
import "../../../src/ui/styles/status";
import { ensureTheme } from "../../../src/ui/theme/service";
import { stagedSuite } from "./corpus-suite";
import { corpusStatusFacts } from "./fixture";

const HOOK_A = "hook \x1b[31mred\x1b[0m\twith tab and a long long long long long long text";
const HOOK_B = "second 日本語";

describe("status segment gallery", () => {
	let restoreTheme: () => void;
	beforeEach(() => {
		const theme = currentTheme();
		restoreTheme = () => setCurrentTheme(theme);
		ensureTheme();
	});
	afterEach(() => restoreTheme());

	async function rows(id: StatusLineSegmentId, variant: number, preset: SymbolPreset): Promise<string[]> {
		setCurrentTheme(loadThemeSync("dark", { symbolPreset: preset }));
		const entry = getSegmentGalleryEntries().find(entry => entry.id === id);
		const sample = entry?.variants[variant];
		if (!sample) throw new Error(`Missing ${id} sample ${variant}`);
		return (await sample.render(100, false)).map(row => Bun.stripANSI(row).trim());
	}

	test("draws metered and subscription costs using the active preset", async () => {
		for (const preset of ["nerd", "unicode", "ascii"] as const) {
			const { symbols } = loadThemeSync("dark", { symbolPreset: preset });
			const advisor = symbols.icon("advisor");
			const advisorCost = preset === "ascii" ? `0.08 ${advisor}` : `${advisor} 0.08`;
			const subscription = symbols.icon("subscription");
			const subscriptionUnit = preset === "nerd" ? `${subscription} ` : "S";
			expect(await rows("cost", 0, preset)).toEqual([`$0.42 ★ 2 + ${advisorCost}`]);
			expect(await rows("cost", 1, preset)).toEqual([subscription]);
			expect(await rows("cost", 2, preset)).toEqual([`${subscriptionUnit}0.38 (+1.27)`]);
		}
	});

	test("leads with the preset's tree icon after a rewind", async () => {
		for (const preset of ["nerd", "unicode", "ascii"] as const) {
			const { symbols } = loadThemeSync("dark", { symbolPreset: preset });
			expect(await rows("tree", 0, preset)).toEqual([`${symbols.icon("worktree")} 3 ahead /tree`]);
		}
	});

	test("shows the selected child repository beside the workspace path", async () => {
		const { symbols } = loadThemeSync("dark", { symbolPreset: "nerd" });
		expect(await rows("path", 0, "nerd")).toEqual([`${symbols.icon("folder")} /workspace/oh-my-pi ↳ oh-my-pi`]);
	});

	test("shows extension statuses only in the isolated segment", async () => {
		const { symbols } = loadThemeSync("dark", { symbolPreset: "nerd" });
		expect(await rows("status", 0, "nerd")).toEqual([`Indexer ready${symbols.symbol("sep.dot")}Tests passing`]);
	});
});

test("the brand hides the profile when its segment opts out", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "nerd" }));
	const facts = { ...corpusStatusFacts(), profile: "work" };
	const base: StatusLineSettings = { preset: "custom", leftSegments: ["pi"], rightSegments: [] };
	createRoot(dispose => {
		try {
			const settings = signal(base);
			const { preview } = createStatusLine({
				settings,
				facts: () => facts,
				placement: () => ({ bar: "full", gap: false, autocomplete: false }),
			});
			const bar = preview(undefined);
			const brand = env.theme().symbols.icon("omp");
			expect(paintNode(env, bar, 40).rows.map(row => Bun.stripANSI(row).trim())).toEqual([`${brand}-work`]);
			settings.set({ ...base, segmentOptions: { pi: { showProfile: false } } });
			expect(paintNode(env, bar, 40).rows.map(row => Bun.stripANSI(row).trim())).toEqual([brand]);
		} finally {
			dispose();
		}
	});
});

test("keeps the configured Subagent segment on its own side alongside the jobs badge", () => {
	const settings: StatusLineSettings = { preset: "custom", leftSegments: ["session", "subagents"], rightSegments: [] };
	const facts = { ...corpusStatusFacts(), jobs: 1, subagents: 2 };
	expect(statusSegs(settings, facts).map(({ key, side }) => [key, side])).toEqual([
		["session", "left"],
		["subagents", "left"],
		["jobs", "right"],
	]);
});

stagedSuite("composer/status-line", corpusCase => {
	const inputs = corpusCase.inputs as { settings: StatusLineSettings };
	const facts = signal(corpusStatusFacts());
	const placement = signal<StatusPlacement>({ bar: "none", gap: false, autocomplete: false });
	const update = (patch: Partial<StatusFacts>) => facts.set({ ...facts(), ...patch });
	const place = (patch: Partial<StatusPlacement>) => placement.set({ ...placement(), ...patch });
	const steps: Record<string, () => void> = {
		"full bar": () => place({ bar: "full", gap: false }),
		"hook a": () => update({ hooks: [HOOK_A] }),
		"hook b": () => update({ hooks: [HOOK_A, HOOK_B] }),
		"top-rule chip, left bar, gap": () => place({ bar: "left", gap: true, topChipInset: 0 }),
		"plan mode": () => update({ plan: { enabled: true, paused: false } }),
		"plan paused": () => update({ plan: { enabled: true, paused: true } }),
		"autocomplete active": () => place({ autocomplete: true }),
		"autocomplete inactive": () => place({ autocomplete: false }),
		"subagents running": () => update({ subagents: 2 }),
		recording: () => update({ recording: true }),
		"autocompact off": () => update({ autoCompact: false }),
		"clear hooks": () => update({ hooks: [] }),
		"top-border attachment, no bar": () => place({ bar: "none", gap: false }),
	};
	return {
		tree: jsx(StatusLine, { settings: () => inputs.settings, facts, placement }),
		step(label) {
			const step = steps[label];
			if (!step) throw new Error(`status-line: unknown stage ${label}`);
			step();
		},
	};
});

test("shows the same optional profile tag in terminal and native status for idle, running and waiting turns", () => {
	createRoot(dispose => {
		try {
			const facts = signal<StatusFacts>({
				...corpusStatusFacts(),
				jobs: 0,
				profile: undefined,
				turnStartedAt: undefined,
			});
			const settings = signal<StatusLineSettings>({ preset: "custom", leftSegments: ["pi"], rightSegments: [] });
			const { panel } = createStatusLine({
				facts,
				settings,
				placement: () => ({ bar: "full", gap: false, autocomplete: false }),
			});
			if (!isUiNode(panel)) throw new Error("expected status panel");
			const pi = panel
				.children()[0]!
				.children()
				.find(node => node.key() === "pi")!;
			const env = staticEnvironment(PLAIN_THEME, { now: 92_000, reduceMotion: true });
			const terminal = () => Bun.stripANSI(paintNode(env, pi, 40).rows.join(""));
			const native = () => (pi.props() as { spans: { t: string }[] }).spans.map(span => span.t);
			expect(terminal()).toBe(PLAIN_THEME.symbols.icon("omp"));
			expect(native()).toEqual([]);

			facts.set({ ...facts(), profile: "work" });
			expect(native()).toEqual(["work"]);
			facts.set({ ...facts(), turnStartedAt: 0 });
			expect(terminal()).toBe(`${PLAIN_THEME.symbols.activityFrames[0]}-work 1m`);
			facts.set({ ...facts(), awaitingAnswer: true });
			const question = PLAIN_THEME.symbols.symbol("cmd.question") || "?";
			expect(terminal()).toBe(`${question}-work 1m`);
			expect(native()).toEqual(["work"]);

			settings.set({ ...settings(), segmentOptions: { pi: { showProfile: false } } });
			expect(native()).toEqual([]);
			expect(terminal()).toBe(`${question} 1m`);
			facts.set({ ...facts(), turnStartedAt: undefined, awaitingAnswer: false });
			expect(terminal()).toBe(PLAIN_THEME.symbols.icon("omp"));
		} finally {
			dispose();
		}
	});
});
