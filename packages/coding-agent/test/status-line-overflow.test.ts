/**
 * Status-line segments under pressure: the session name's accent follows the
 * `sessionAccent` setting, the path segment shrinks with its `maxLength`
 * option, and a bar too narrow for every segment drops the model before the
 * working directory.
 */
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionStatusLine } from "@oh-my-pi/pi-coding-agent/modes/interactive/status-line";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/types";
import { printRows } from "@oh-my-pi/pi-coding-agent/ui/print-rows";
import type { StatusFacts, StatusPlacement } from "@oh-my-pi/pi-coding-agent/ui/status/facts";
import { sessionAccentSgr } from "@oh-my-pi/pi-coding-agent/ui/status/accent";
import { composerShape, type StatusAttachment } from "@oh-my-pi/pi-coding-agent/ui/styles/composer/shapes";
import "../src/ui/styles/composer";
import "../src/ui/styles/overlays/composer-shape-preview";
import { ensureTheme } from "@oh-my-pi/pi-coding-agent/ui/theme/service";
import { createRoot } from "@oh-my-pi/pi-tui";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { effectiveStatusSettings, segmentView } from "@oh-my-pi/pi-coding-agent/ui/status/segments";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { Composer } from "../src/ui/composer";
import { ComposerShapePreview } from "../src/ui/overlays/composer-shape-preview";
import { createStatusLine, shapePlacement } from "../src/ui/status/status-line";
import { segmentText, statusFacts, statusRows, statusSession, statusText } from "./helpers/session-status-line";

const theme = loadThemeSync("dark", { symbolPreset: "unicode" });
const savedTheme = currentTheme();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	ensureTheme();
	setCurrentTheme(theme);
});

afterAll(() => {
	resetSettingsForTest();
	setCurrentTheme(savedTheme);
});

describe("status line session accent", () => {
	/** Theme tokens the session-name segment paints its text with. */
	function nameTokens(sessionAccent: boolean): string[] {
		const view = segmentView(
			"session_name",
			statusFacts({ sessionName: "Named session" }),
			effectiveStatusSettings({ preset: "custom", sessionAccent }),
		);
		return (view?.look.pieces ?? []).flatMap(piece => ("t" in piece && piece.s ? [piece.s] : []));
	}

	it("paints the session name with the hash-derived session accent when enabled", () => {
		expect(nameTokens(true)).toContain("sessionAccent");
		const facts = statusFacts({ sessionName: "Named session" });
		const sgr = sessionAccentSgr(theme, facts.sessionName);
		expect(sgr).toBeDefined();
		expect(sgr).not.toBe(theme.fgSgr("accent"));
		const settings: StatusLineSettings = {
			preset: "custom",
			leftSegments: ["session_name"],
			rightSegments: [],
			sessionAccent: true,
		};
		expect(statusRows(settings, facts).join("\n")).toContain(`${sgr}Named session`);
	});

	it("paints the session name with the theme accent when disabled", () => {
		const tokens = nameTokens(false);
		expect(tokens).toContain("accent");
		expect(tokens).not.toContain("sessionAccent");
		const facts = statusFacts({ sessionName: "Named session" });
		const settings: StatusLineSettings = {
			preset: "custom",
			leftSegments: ["session_name"],
			rightSegments: [],
			sessionAccent: false,
		};
		expect(statusRows(settings, facts).join("\n")).toContain(`${theme.fgSgr("accent")}Named session`);
	});
});

describe("path segment truncation at varying maxLength", () => {
	const cwd = "/home/user/omp-overflow-very-long-directory-name-for-testing-abcdef/nested/leaf";
	const pathText = (maxLength: number) =>
		segmentText("path", statusFacts({ cwd, home: "/home/user" }), {
			preset: "custom",
			segmentOptions: {
				path: { maxLength, abbreviate: false, stripWorkPrefix: false },
			},
		}) ?? "";

	it("truncates path with ellipsis when maxLength is smaller than path", () => {
		expect(visibleWidth(pathText(10))).toBeLessThan(visibleWidth(pathText(200)));
		expect(pathText(10)).toContain("…");
	});

	it("reduces visible width monotonically as maxLength decreases", () => {
		const widths = [40, 20, 10, 4].map(maxLength => visibleWidth(pathText(maxLength)));
		for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]!);
	});

	it("still renders a visible segment at maxLength=4", () => {
		expect(visibleWidth(pathText(4))).toBeGreaterThan(0);
	});
});

describe("overflow: path survives before model", () => {
	it("drops the model segment before the cwd path when both cannot fit", () => {
		const settings: StatusLineSettings = {
			preset: "custom",
			leftSegments: ["pi", "model", "path"],
			rightSegments: [],
			separator: "none",
			sessionAccent: false,
			transparent: true,
			segmentOptions: {
				model: { showThinkingLevel: false },
				path: { abbreviate: false, maxLength: 32, stripWorkPrefix: false },
			},
		};
		const modelName = `MODEL_SHOULD_DROP_${"x".repeat(24)}`;
		const facts = statusFacts({
			model: { id: modelName, name: modelName, thinking: false },
			cwd: "/tmp/root/cwdxyz",
			home: "/home/user",
		});

		expect(statusText(settings, facts, 160)).toContain(modelName);
		const narrow = Bun.stripANSI(topRows(settings, facts, 40)[0]!);
		expect(narrow).toContain("xyz");
		expect(narrow).not.toContain("MODEL_SHOULD_DROP");
	});
});

const standalone: StatusPlacement = { bar: "full", gap: false, autocomplete: false };

function topRows(
	settings: StatusLineSettings,
	facts: StatusFacts,
	width: number,
	attachment: StatusAttachment = "top-border",
): string[] {
	return printRows(
		() =>
			createStatusLine({ settings: () => settings, facts: () => facts, placement: () => standalone }).preview(
				attachment,
			),
		width,
	);
}

const firstBar: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["pi", "model"],
	rightSegments: [],
	separator: "powerline-thin",
	sessionAccent: false,
};

describe("status-line brand and spacing", () => {
	it("transitions dim to accent and back over 450ms while swapping the glyph immediately", () => {
		const settings = { ...firstBar, leftSegments: ["pi"] } satisfies StatusLineSettings;
		const edge = 1_000_000;
		const dim = theme.fgSgr("dim");
		const accent = theme.fgSgr("accent");
		const icon = theme.symbols.icon("omp");
		const line = new SessionStatusLine(statusSession());
		line.previewSettings(settings);
		const paint = (now: number) => {
			setSystemTime(now);
			return printRows(
				() =>
					createStatusLine({
						settings: () => line.settings(),
						facts: () => line.facts(),
						placement: () => standalone,
					}).panel,
				80,
				{ now, motion: true },
			)[0]!;
		};

		try {
			expect(paint(edge)).toContain(`${dim}${icon}`);
			line.markActivityStart();
			const early = paint(edge + 10);
			expect(early).toContain(" 0s");
			expect(early).not.toContain(icon);
			expect(early).toContain(dim);
			expect(early).not.toContain(accent);
			const mid = paint(edge + 225);
			expect(mid).toMatch(/\x1b\[38;2;/);
			expect(mid).not.toContain(dim);
			expect(mid).not.toContain(accent);
			expect(paint(edge + 450)).toContain(accent);

			setSystemTime(edge + 500);
			line.markActivityEnd();
			expect(paint(edge + 510)).toContain(`${accent}${icon}`);
			const fadeOut = paint(edge + 725);
			expect(fadeOut).toContain(icon);
			expect(fadeOut).toMatch(/\x1b\[38;2;/);
			expect(fadeOut).not.toContain(dim);
			expect(fadeOut).not.toContain(accent);
			expect(paint(edge + 950)).toContain(`${dim}${icon}`);
		} finally {
			line.dispose();
			setSystemTime();
		}
	});

	it.each([false, true])("keeps exactly one space on each side of the first separator (working=%s)", working => {
		const now = Date.now();
		const facts = statusFacts({
			model: { id: "model", name: "Test Model", thinking: false },
			...(working ? { turnStartedAt: now } : {}),
		});
		const row = statusText(firstBar, facts, 80);
		const dot = theme.symbols.symbol("sep.dot").trim() || "·";
		const index = row.indexOf(dot);
		expect(index).toBeGreaterThan(0);
		expect(row.slice(0, index).match(/ *$/)?.[0]).toBe(" ");
		expect(row.slice(index + dot.length).match(/^ */)?.[0]).toBe(" ");
	});
});

describe("status-line transparency", () => {
	it("paints the theme fill and caps only when transparent is disabled", () => {
		const facts = statusFacts({ sessionName: "transparent test" });
		const settings = {
			...firstBar,
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
		} satisfies StatusLineSettings;
		const opaque = topRows({ ...settings, transparent: false }, facts, 80)[0]!;
		const transparent = topRows({ ...settings, transparent: true }, facts, 80)[0]!;
		const fill = theme.bg("statusLineBg", "\0").split("\0")[0]!;
		expect(fill).toMatch(/\x1b\[48;/);
		expect(opaque).toContain(fill);
		expect(transparent).not.toMatch(/\x1b\[48;/);
		expect(transparent).toContain("\x1b[49m");
		for (const key of ["sep.powerlineLeft", "sep.powerlineRight"]) {
			const cap = theme.symbols.symbol(key);
			expect(opaque).toContain(cap);
			expect(transparent).not.toContain(cap);
		}
	});
});

describe("overflow: embedded context fallback", () => {
	const settings: StatusLineSettings = { ...firstBar, leftSegments: ["pi", "context_pct"], contextLine: "embedded" };
	for (const percent of [3, null, 120]) {
		it(`keeps usage and 128K together at the right edge for ${percent}`, () => {
			const facts = statusFacts({ context: { tokens: ((percent ?? 0) / 100) * 128_000, window: 128_000, percent } });
			for (const width of [26, 80]) {
				const rows = topRows(settings, facts, width);
				const top = Bun.stripANSI(rows[0]!);
				expect(top.endsWith("128K  ")).toBe(true);
				expect(visibleWidth(top)).toBe(width);
				expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
				if (percent === null) expect(top).not.toContain("%");
				else expect(top).toContain(`ctx ${percent}% · 128K`);
				if (percent === 120) expect(rows[0]).toContain(`${theme.fgSgr("error")}120%`);
			}
		});
	}

	it("returns freed gauge space to the path after a model moves to overflow", () => {
		const options = { abbreviate: false, maxLength: 40, stripWorkPrefix: false };
		const facts = statusFacts({
			cwd: "/work/directory-with-a-long-leaf-name",
			model: { id: "model", name: `MODEL_OVERFLOW_${"x".repeat(90)}`, thinking: false },
			context: { tokens: 0, window: 128_000, percent: 0 },
		});
		const custom: StatusLineSettings = {
			...settings,
			transparent: true,
			separator: "none",
			leftSegments: ["pi", "model", "path", "context_pct"],
			segmentOptions: { path: options, model: { showThinkingLevel: false } },
		};
		const path = segmentText("path", facts, custom)!;
		const [wide, ...spill] = topRows(custom, facts, 80).map(Bun.stripANSI);
		expect(wide).toContain(path);
		expect(wide).not.toContain("MODEL_OVERFLOW");
		expect(wide?.endsWith("128K  ")).toBe(true);
		expect(spill.join("\n")).toContain("MODEL_OVERFLOW");
		const [narrow] = topRows(custom, facts, 40).map(Bun.stripANSI);
		expect(narrow).not.toContain(path);
		expect(narrow).toContain("…");
		expect(narrow).toContain("leaf-name");
		expect(narrow?.endsWith("128K  ")).toBe(true);
		expect(visibleWidth(narrow!)).toBe(40);
		expect(narrow).not.toContain(theme.symbols.box.horizontal.repeat(2));
	});

	it("keeps percent visible in the row or its overflow when embedded labels cannot fit", () => {
		const facts = statusFacts({ context: { tokens: 0, window: 128_000, percent: 0 } });
		const rows = topRows({ ...settings, leftSegments: ["pi", "context_pct", "context_total"] }, facts, 8);
		expect(Bun.stripANSI(rows.join("\n"))).toContain("0%");
		expect(rows.every(row => visibleWidth(row) <= 8)).toBe(true);
	});
});

function shapeRows(shape: string, settings: StatusLineSettings, facts: StatusFacts, width: number): string[] {
	return printRows(() => {
		const status = createStatusLine({ settings: () => settings, facts: () => facts, placement: () => standalone });
		return ComposerShapePreview({ shape: () => shape, status: status.chrome });
	}, width);
}

function composerRows(shape: string, settings: StatusLineSettings, facts: StatusFacts, width: number): string[] {
	return printRows(() => {
		const status = createStatusLine({
			settings: () => settings,
			facts: () => facts,
			placement: () => shapePlacement(composerShape(shape), false),
		});
		const composer = new Composer({ shape });
		composer.setStatus(status.chrome.composerStatus);
		return [composer.node, status.panel];
	}, width);
}

describe("overflow: wrapped rows", () => {
	it("aligns all box overflow rows to the editor inset and fits CJK and emoji by cell width", () => {
		const settings: StatusLineSettings = {
			...firstBar,
			leftSegments: ["pi"],
			rightSegments: ["session_name", "model", "path"],
		};
		const facts = statusFacts({
			sessionName: "会话名-セッション-🙂",
			model: { id: "model", name: "列".repeat(60), thinking: false },
			cwd: "/repo/宽字符目录名",
		});
		const width = 28;
		const shape = composerShape("box");
		const inset = shape.sideWidth(shape.paddingX);
		const [, ...spill] = topRows(settings, facts, width - inset * 2);
		expect(spill.length).toBeGreaterThan(1);
		const rows = composerRows("box", settings, facts, width);
		for (const row of spill.map(Bun.stripANSI)) {
			expect(rows.map(Bun.stripANSI)).toContain(" ".repeat(inset) + row);
		}
		const joined = Bun.stripANSI(rows.join("\n"));
		expect(joined).toContain("列列列列");
		expect(joined).toContain("宽字符目录名");
		expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
	});

	it("reopens foreground text before and after a wrapped group's separator", () => {
		const settings: StatusLineSettings = {
			...firstBar,
			leftSegments: ["model"],
			rightSegments: ["time", "hostname"],
		};
		const width = 24;
		const iconWidth = visibleWidth(`${theme.symbols.icon("model")} `);
		const capWidth = visibleWidth(theme.symbols.symbol("sep.powerlineLeft"));
		const name = "m".repeat(width - iconWidth - capWidth - 2);
		const facts = statusFacts({ model: { id: "model", name, thinking: false }, hostname: "host" });
		const [main, ...spill] = topRows(settings, facts, width);
		expect(Bun.stripANSI(main!)).toContain(name);
		expect(spill).toHaveLength(1);
		const foreground = theme.fgSgr("text");
		expect(spill[0]?.trimStart().startsWith(foreground)).toBe(true);
		expect(spill[0]).toContain(`${theme.fg("statusLineSep", "·")}${foreground}`);
		expect(spill[0]?.trimEnd().endsWith("\x1b[39m")).toBe(true);
	});

	it("preserves full-preset markers exactly once across standalone and preview rows on resize", () => {
		const settings: StatusLineSettings = { preset: "full", separator: "slash", sessionAccent: false };
		const facts = statusFacts({
			model: { id: "model", name: "model-marker", thinking: false },
			sessionName: "session-marker",
			context: { tokens: 0, window: 128_000, percent: 0 },
		});
		for (const width of [240, 24, 240]) {
			const rows = statusRows(settings, facts, width);
			expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
			if (width === 24) expect(rows.length).toBeGreaterThan(2);
			else expect(rows).toHaveLength(1);
			const standaloneText = Bun.stripANSI(rows.join("\n"));
			for (const marker of ["model-marker", "0%", "session-marker"]) {
				expect(standaloneText.split(marker)).toHaveLength(2);
			}
		}
		const preview = shapeRows("box", settings, facts, 24);
		expect(preview.every(row => visibleWidth(row) <= 24)).toBe(true);
		for (const marker of ["model-marker", "session-marker"]) {
			expect(Bun.stripANSI(preview.join("\n")).split(marker)).toHaveLength(2);
		}
	});

	it("moves a Unicode model from the Claude rule chip into bottom overflow at the two-cell budget", () => {
		const model = "模型🙂e\u0301-claude-width-dock";
		const settings: StatusLineSettings = {
			...firstBar,
			leftSegments: ["session_name"],
			rightSegments: ["model"],
			transparent: true,
		};
		const facts = statusFacts({ sessionName: "LEFT", model: { id: "model", name: model, thinking: false } });
		const width = visibleWidth(topRows(settings, facts, 80, "top-rule-chip")[0]!) + 2;
		for (const columns of [width, width - 1, width]) {
			const rows = composerRows("claude", settings, facts, columns);
			const preview = shapeRows("claude", settings, facts, columns);
			expect([...rows, ...preview].every(row => visibleWidth(row) <= columns)).toBe(true);
			for (const frame of [rows, preview]) {
				const plain = frame.map(Bun.stripANSI);
				expect(plain.join("\n").split(model)).toHaveLength(2);
				expect(plain.join("\n").split("LEFT")).toHaveLength(2);
				const chip = plain.find(row => row.includes(theme.symbols.box.horizontal));
				if (columns === width) expect(chip).toContain(model);
				else expect(chip).not.toContain(model);
			}
		}
	});
});

describe("overflow: live composer screen budget", () => {
	for (const preset of ["full", "custom"] as const) {
		for (const shape of ["box", "pi", "claude"] as const) {
			it.each([false, true])(`keeps the cursor input row in short ${preset}/${shape} screens (live=%s)`, running => {
				createRoot(dispose => {
					const model = `MODEL_MARKER_${"列🙂".repeat(80)}`;
					const settings: StatusLineSettings = {
						preset,
						separator: "slash",
						sessionAccent: false,
						leftSegments: ["pi", "model", "path", "context_pct", "context_total", "time", "hostname"],
						rightSegments: ["session_name", "cost"],
					};
					const startup = statusFacts({ model: { id: "model", name: model, thinking: false } });
					const live = running
						? new SessionStatusLine(
								statusSession({
									model: { id: "model", name: model, input: ["text"], contextWindow: 128_000 },
									sessionManager: { getSessionName: () => "SESSION_MARKER" },
								}),
							)
						: undefined;
					live?.previewSettings(settings);
					live?.markActivityStart();
					const facts = () => live?.facts() ?? startup;
					const placement = () => shapePlacement(composerShape(shape), false);
					const status = createStatusLine({ settings: () => live?.settings() ?? settings, facts, placement });
					const composer = new Composer({ shape, text: "older\n输入🙂line\nnewer", caret: "terminal" });
					composer.setCursor("older\n输入🙂line".length);
					composer.setStatus(status.chrome.composerStatus);
					const term = createTestTerminal(
						() => ({
							main: running ? jsx("text", { text: "Running response" }) : undefined,
							dock: [composer.node, status.panel],
						}),
						{ columns: 24, rows: 8, theme },
					);
					try {
						term.focus(composer.field);
						for (const rows of [1, 2, 3, 5, 8, 60]) {
							term.resize(24, rows);
							term.render();
							const frame = term.rows();
							expect(frame.length).toBeLessThanOrEqual(rows);
							expect(frame.every(row => visibleWidth(row) <= 24)).toBe(true);
							const cursor = term.cursor();
							expect(cursor).not.toBeNull();
							expect(Bun.stripANSI(frame[cursor!.row]!)).toContain("输入🙂line");
						}
						term.resize(600, 60);
						const wide = Bun.stripANSI(term.rows().join("\n"));
						expect(wide).toContain(model);
						expect(wide).toContain("输入🙂line");
						if (running) {
							expect(wide).toContain("SESSION_MARKER");
							term.resize(24, 1);
							expect(Bun.stripANSI(shapeRows(shape, settings, facts(), 600).join("\n"))).toContain(
								"SESSION_MARKER",
							);
						}
					} finally {
						term.dispose();
						live?.dispose();
						dispose();
					}
				});
			});
		}
	}
});
