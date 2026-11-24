/**
 * `composer/status-line` corpus: the standalone status bar in every preset
 * (default, minimal, compact, full, custom, no hooks, transparent) through
 * composer placements, extension statuses and live modes.
 */
import { expect, test } from "bun:test";
import { createRoot, isUiNode, jsx, signal } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import type { StatusLineSettings } from "../../../src/modes/view-model/status-line/types";
import type { StatusFacts, StatusPlacement } from "../../../src/ui/status/facts";
import { createStatusLine, StatusLine } from "../../../src/ui/status/status-line";
import "../../../src/ui/styles/status";
import { stagedSuite } from "./corpus-suite";
import { corpusStatusFacts } from "./fixture";

const HOOK_A = "hook \x1b[31mred\x1b[0m\twith tab and a long long long long long long text";
const HOOK_B = "second 日本語";

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
		"top-rule chip, left bar, gap": () => place({ bar: "left", gap: true }),
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
			expect(terminal()).toBe(`${PLAIN_THEME.symbols.icon("omp")}-work`);
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
