import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { ThinkingPreviewComponent } from "@oh-my-pi/pi-tui/chat/thinking-preview";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { sanitizeCarriageReturns } from "@oh-my-pi/pi-tui/render/render-utils";
import { getThemeByName, initTheme, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import {
	replaceTabs,
	resetHangulCompatibilityJamoWidthForTests,
	setHangulCompatibilityJamoWidth,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui/utils";
import * as tuiUtils from "@oh-my-pi/pi-tui/utils";

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	resetHangulCompatibilityJamoWidthForTests();
});
function bodyRows(rows: readonly string[], width: number): readonly string[] {
	if (width <= visibleWidth("│ ")) return rows;
	const guide = theme.fg("border", "│ ");
	return rows.slice(1).map(row => row.slice(guide.length));
}

function expectedTail(source: string, width: number): string[] {
	const prefixWidth = visibleWidth("│ ");
	if (width > prefixWidth) width -= prefixWidth;
	const clean = replaceTabs(sanitizeText(sanitizeCarriageReturns(source)));
	if (!clean || width < 1) return [];
	const compact: string[] = [];
	for (const line of clean.split("\n")) {
		if (/\S/.test(line)) compact.push(line);
		else if (compact.length === 0 || compact[compact.length - 1] !== "") compact.push("");
	}
	while (compact[compact.length - 1] === "") compact.pop();
	const rows = wrapTextWithAnsi(compact.join("\n"), width);
	while (rows.length > 0 && !/\S/.test(rows[rows.length - 1]!)) rows.pop();
	return rows.slice(-5).map(row => truncateToWidth(row, width, ""));
}

function context(cols: number): DescribeContext {
	return { cols, reduceMotion: true, dark: true, supports: () => true, feature: () => false };
}

describe("ThinkingPreviewComponent", () => {
	it("keeps the newest five physical body rows literal and clears them with their owner", () => {
		const preview = new ThinkingPreviewComponent();
		const source = "retired first\nretired second\n**literal**\n`literal`\n# literal\nlatest one\nlatest two";
		expect(preview.setText(source)).toBe(true);
		const rows = preview.render(40);
		expect(bodyRows(rows, 40).map(row => Bun.stripANSI(row))).toEqual([
			"**literal**",
			"`literal`",
			"# literal",
			"latest one",
			"latest two",
		]);
		expect(preview.render(40)).toBe(rows);
		expect(preview.setText(source)).toBe(false);
		expect(preview.clear()).toBe(true);
		expect(preview.render(40)).toEqual([]);
		expect(preview.describe(context(40))).toMatchObject({ k: "col", p: { hidden: true } });
		expect(preview.clear()).toBe(false);
		preview.setText("new owner");
		expect(bodyRows(preview.render(40), 40).map(row => Bun.stripANSI(row))).toEqual(["new owner"]);
	});

	it("keeps content visible through trailing blank runs and preserves indentation when prose resumes", () => {
		const preview = new ThinkingPreviewComponent();
		let source = "older\nfirst\nsecond\nthird\nlatest";
		preview.setText(source);
		const initial = preview.render(80);
		for (const delta of ["\n", "\n  \n\t\n", "\n".repeat(1000), "    "]) {
			source += delta;
			preview.setText(source);
			expect(preview.render(80).map(row => Bun.stripANSI(row))).toEqual(initial.map(row => Bun.stripANSI(row)));
		}
		source += "next";
		preview.setText(source);
		expect(bodyRows(preview.render(80), 80).map(row => Bun.stripANSI(row))).toEqual([
			"second",
			"third",
			"latest",
			"",
			"    next",
		]);
		source += "\n\n \n\nlast\n\n";
		preview.setText(source);
		expect(bodyRows(preview.render(80), 80).map(row => Bun.stripANSI(row))).toEqual([
			"latest",
			"",
			"    next",
			"",
			"last",
		]);
		expect(bodyRows(preview.render(9), 9).map(row => Bun.stripANSI(row))).toEqual(expectedTail(source, 9));
		preview.setText(" \n\t\n\n  ");
		expect(preview.render(80)).toEqual([]);
	});

	it("moves the newest-line emphasis with streamed content and theme changes", async () => {
		const dark = await getThemeByName("dark");
		const light = await getThemeByName("light");
		if (!dark || !light) throw new Error("built-in themes must be available");
		const original = theme;
		const preview = new ThinkingPreviewComponent();
		try {
			for (const selected of [dark, light]) {
				setThemeInstance(selected);
				preview.setText("first\nlatest\n\n\n");
				const before = [theme.fg("thinkingText", "first"), theme.fg("text", "latest")];
				expect(bodyRows(preview.render(80), 80)).toEqual(before);
				preview.setText("first\nlatest\n\n\nnext");
				const after = [
					theme.fg("thinkingText", "first"),
					theme.fg("thinkingText", "latest"),
					theme.fg("thinkingText", ""),
					theme.fg("text", "next"),
				];
				expect(bodyRows(preview.render(80), 80)).toEqual(after);
			}
		} finally {
			setThemeInstance(original);
		}
	});

	it("matches full shared wrapping through growing words, blank lines, tabs and graphemes", () => {
		const sources = [
			"ordinary words become unusuallylongwithoutanyspaces and end\n\nnext\nlast",
			"0123456789".repeat(80),
			"中文推理🙂中文👨‍👩‍👧‍👦 e\u0301\t答案 \n".repeat(6),
			"leading   spaces        growingword\n\n\ntrailing spaces      next",
			"a 🇨🇳🇺🇸 👩🏽‍💻 ⚠️ 0️⃣ end".repeat(5),
		];
		for (const width of [1, 2, 3, 7, 19, 80]) {
			for (const source of sources) {
				const preview = new ThinkingPreviewComponent();
				for (let end = 1; end <= source.length; end++) {
					const prefix = source.slice(0, end);
					preview.setText(prefix);
					const rows = preview.render(width);
					expect(bodyRows(rows, width).map(row => Bun.stripANSI(row))).toEqual(expectedTail(prefix, width));
					expect(bodyRows(rows, width).length).toBeLessThanOrEqual(5);
					for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("preserves resume context across coalesced native paints and new logical lines", () => {
		const preview = new ThinkingPreviewComponent();
		// These pairs arrive without an intervening paint; the first changes
		// the initial grapheme's width before any prefix can be frozen.
		const batches = [
			["⚠", "\uFE0F"],
			["中", "文"],
			[" ", "🙂"],
			["\n", "\n"],
			["  ", "界"],
			["界", "\n"],
			["e", "\u0301"],
			[" long", "erword"],
		];
		let source = "";
		for (const [first, second] of batches) {
			source += first;
			preview.setText(source);
			source += second;
			preview.setText(source);
			const described = preview.describe(context(1));
			expect(described.k).toBe("rows");
			if (described.k !== "rows") throw new Error("preview must describe physical rows");
			const lines = described.p?.lines ?? [];
			expect(bodyRows(lines, 1).map(row => Bun.stripANSI(row))).toEqual(expectedTail(source, 1));
			expect(bodyRows(lines, 1).length).toBeLessThanOrEqual(5);
		}
	});

	it("matches terminal sanitization across split ANSI and control input", () => {
		const source = "old\n\x1b[31m中文 colored\x1b[0m\t🙂\r\nlatest\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		const preview = new ThinkingPreviewComponent();
		for (let end = 1; end <= source.length; end++) {
			const prefix = source.slice(0, end);
			preview.setText(prefix);
			expect(bodyRows(preview.render(9), 9).map(row => Bun.stripANSI(row))).toEqual(expectedTail(prefix, 9));
		}
		preview.setText("\x1b[31m\x1b[0m");
		expect(preview.render(9)).toEqual([]);
	});

	it("keeps split control boundaries equivalent to full normalization after incremental work resumes", () => {
		const sources = [
			"before\r\r\nclean words\x1b[38;2;10;20;30mcolored\x1b[0m\nlast",
			"before\x1b]8;;https://example.com\x07linked\x1b]8;;\x07 clean\x1b[31mred\x1b[0m",
			"before\x1b]8;;https://example.com\x1b\\linked\x1b]8;;\x1b\\ clean\r\nlast",
			"before\x1bPpayload\x1b\\ clean\x1b(Btext 🙂e\u0301",
		];
		for (const source of sources) {
			for (const width of [1, 9]) {
				const preview = new ThinkingPreviewComponent();
				for (let end = 1; end <= source.length; end++) {
					const prefix = source.slice(0, end);
					preview.setText(prefix);
					const described = preview.describe(context(width));
					const rows = described.k === "rows" ? (described.p?.lines ?? []) : [];
					expect(bodyRows(rows, width).map(row => Bun.stripANSI(row))).toEqual(expectedTail(prefix, width));
				}
				// A revision must discard an unresolved escape from the old body.
				preview.setText(`${source}\x1b]8;;unfinished`);
				preview.render(width);
				preview.setText("replacement\r\n🙂tail");
				preview.render(width);
				preview.setText("replacement\r\n🙂tail appended");
				expect(bodyRows(preview.render(width), width).map(row => Bun.stripANSI(row))).toEqual(
					expectedTail("replacement\r\n🙂tail appended", width),
				);
			}
		}
	});

	it("bounds clean-append wrapping by the mutable tail after completed controls, not history size", () => {
		const width = 24;
		const wrap = spyOn(tuiUtils, "wrapTextWithAnsi");
		try {
			for (const historyRows of [30, 3000]) {
				for (const control of [
					"\r\n",
					"\x1b[31mcolored\x1b[0m",
					"\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
					"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
				]) {
					const preview = new ThinkingPreviewComponent();
					let source = `${"retired row\n".repeat(historyRows)}latest`;
					preview.setText(source);
					preview.render(width);
					// Include recovery from a control split over separate paints.
					for (const char of control) {
						source += char;
						preview.setText(source);
						preview.render(width);
					}
					for (let append = 0; append < 12; append++) {
						source += " next\nrow";
						preview.setText(source);
						wrap.mockClear();
						const rows = preview.render(width);
						const work = wrap.mock.calls.reduce((total, [text]) => total + text.length + 1, 0);
						// Count both input and calls so even old empty rows cost work;
						// the generous surface-relative bound does not pin call counts.
						expect(work).toBeGreaterThan(0);
						expect(work).toBeLessThan(width * 16);
						expect(bodyRows(rows, width).map(row => Bun.stripANSI(row))).toEqual(expectedTail(source, width));
					}
				}
			}
		} finally {
			wrap.mockRestore();
		}
	});

	it("reflows the original body after resize and replaces, rather than appends, revisions", () => {
		const preview = new ThinkingPreviewComponent();
		let source = "old line\n".repeat(15) + "latest " + "单长行🙂".repeat(40);
		preview.setText(source);
		for (const width of [12, 1, 2, 70, 200, 9]) {
			expect(bodyRows(preview.render(width), width).map(row => Bun.stripANSI(row))).toEqual(
				expectedTail(source, width),
			);
			source += " appended words";
			preview.setText(source);
			expect(bodyRows(preview.render(width), width).map(row => Bun.stripANSI(row))).toEqual(
				expectedTail(source, width),
			);
		}
		preview.setText("replacement\nonly two rows");
		expect(bodyRows(preview.render(80), 80).map(row => Bun.stripANSI(row))).toEqual(["replacement", "only two rows"]);
		expect(preview.render(0)).toEqual([]);
		expect(bodyRows(preview.render(80), 80).map(row => Bun.stripANSI(row))).toEqual(["replacement", "only two rows"]);
	});

	it("describes already-wrapped rows at the native surface width, never the full body", () => {
		const preview = new ThinkingPreviewComponent();
		const source = "obsolete history\n".repeat(20) + "newest tail " + "界🙂word ".repeat(25);
		preview.setText(source);
		for (const cols of [80, 8, 1, 37]) {
			const cx = context(cols);
			const described = preview.describe(cx);
			expect(described.k).toBe("rows");
			if (described.k !== "rows") throw new Error("preview must describe physical rows");
			expect(described.p?.cols).toBe(cols);
			const lines = described.p?.lines ?? [];
			expect(bodyRows(lines, cols).map(row => Bun.stripANSI(row))).toEqual(expectedTail(source, cols));
			expect(bodyRows(lines, cols).length).toBeLessThanOrEqual(5);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
			expect(preview.describe(cx)).toBe(described);
		}
		preview.clear();
		expect(preview.describe(context(8))).toMatchObject({ k: "col", p: { hidden: true } });
	});

	it("reflows on width-config epochs and repaints theme epochs without losing the newest tail", async () => {
		const preview = new ThinkingPreviewComponent();
		const source = "head\n".repeat(8) + "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ";
		preview.setText(source);
		for (const width of [1, 2, 1] as const) {
			setHangulCompatibilityJamoWidth(width);
			expect(bodyRows(preview.render(8), 8).map(row => Bun.stripANSI(row))).toEqual(expectedTail(source, 8));
		}
		const dark = await getThemeByName("dark");
		const light = await getThemeByName("light");
		if (!dark || !light) throw new Error("built-in themes must be available");
		const original = theme;
		try {
			setThemeInstance(dark);
			const before = preview.render(8);
			setThemeInstance(light);
			const after = preview.render(8);
			expect(after).not.toBe(before);
			const rows = expectedTail(source, 8);
			expect(bodyRows(after, 8)).toEqual(
				rows.map((row, index) => theme.fg(index === rows.length - 1 ? "text" : "thinkingText", row)),
			);
			preview.invalidate();
			expect(preview.render(8)).toEqual(after);
		} finally {
			setThemeInstance(original);
		}
	});

	it("collapses the finished tail to one dim stub row that width and themes repaint", async () => {
		const preview = new ThinkingPreviewComponent();
		preview.setText("stale line\nmiddle\nlatest tail text");
		expect(bodyRows(preview.render(40), 40).map(row => Bun.stripANSI(row))).toEqual([
			"stale line",
			"middle",
			"latest tail text",
		]);
		expect(preview.collapse()).toBe(true);
		expect(preview.render(40)).toEqual([theme.fg("thinkingText", "… latest tail text")]);
		// Collapsing again changes nothing; blank-only tails have nothing to retain.
		expect(preview.collapse()).toBe(false);
		// The stub truncates to the current width without refolding live rows.
		expect(preview.render(10).map(row => Bun.stripANSI(row))).toEqual([
			truncateToWidth("… latest tail text", 10, ""),
		]);
		// A live setText retires the stub, even for identical text.
		expect(preview.setText("stale line\nmiddle\nlatest tail text")).toBe(true);
		expect(bodyRows(preview.render(40), 40).map(row => Bun.stripANSI(row))).toEqual([
			"stale line",
			"middle",
			"latest tail text",
		]);
		const dark = await getThemeByName("dark");
		const light = await getThemeByName("light");
		if (!dark || !light) throw new Error("built-in themes must be available");
		const original = theme;
		try {
			preview.collapse();
			setThemeInstance(dark);
			const before = preview.render(40);
			setThemeInstance(light);
			expect(preview.render(40)).not.toBe(before);
			expect(preview.render(40)).toEqual([theme.fg("thinkingText", "… latest tail text")]);
			const described = preview.describe(context(40));
			expect(described.k).toBe("rows");
			if (described.k === "rows") {
				expect(described.p?.lines).toEqual([theme.fg("thinkingText", "… latest tail text")]);
			}
		} finally {
			setThemeInstance(original);
		}
		// Clearing wipes the stub entirely; a collapsed empty preview stays empty.
		expect(preview.clear()).toBe(true);
		expect(preview.render(40)).toEqual([]);
		expect(preview.collapse()).toBe(false);
		expect(preview.render(40)).toEqual([]);
	});

	it("clamps the live tail to three rows on short terminals and restores five when it grows", () => {
		const preview = new ThinkingPreviewComponent();
		let height = 40;
		preview.setHeightSource(() => height);
		const source = "one\ntwo\nthree\nfour\nfive\nsix\nseven";
		preview.setText(source);
		expect(bodyRows(preview.render(20), 20).map(row => Bun.stripANSI(row))).toEqual([
			"three",
			"four",
			"five",
			"six",
			"seven",
		]);
		height = 19;
		expect(bodyRows(preview.render(20), 20).map(row => Bun.stripANSI(row))).toEqual(["five", "six", "seven"]);
		// Streaming continues under the clamp; growth keeps only the newest three.
		preview.setText(`${source}\neight`);
		expect(bodyRows(preview.render(20), 20).map(row => Bun.stripANSI(row))).toEqual(["six", "seven", "eight"]);
		height = 20;
		expect(bodyRows(preview.render(20), 20).map(row => Bun.stripANSI(row))).toEqual([
			"four",
			"five",
			"six",
			"seven",
			"eight",
		]);
		// The stub is always a single row regardless of the height budget.
		height = 12;
		preview.collapse();
		expect(preview.render(20).map(row => Bun.stripANSI(row))).toEqual(["… eight"]);
	});
});
