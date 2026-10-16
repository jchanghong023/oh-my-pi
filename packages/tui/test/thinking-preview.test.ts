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

function expectedTail(source: string, width: number): string[] {
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
	it("shows the newest five physical rows without a title or Markdown processing", () => {
		const preview = new ThinkingPreviewComponent();
		const source = "retired first\nretired second\n**literal**\n`literal`\n# literal\nlatest one\nlatest two";
		expect(preview.setText(source)).toBe(true);
		const rows = preview.render(40);
		expect(rows.map(row => Bun.stripANSI(row))).toEqual([
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
		expect(preview.render(40).map(row => Bun.stripANSI(row))).toEqual(["new owner"]);
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
		expect(preview.render(80).map(row => Bun.stripANSI(row))).toEqual([
			"second",
			"third",
			"latest",
			"",
			"    next",
		]);
		source += "\n\n \n\nlast\n\n";
		preview.setText(source);
		expect(preview.render(80).map(row => Bun.stripANSI(row))).toEqual(["latest", "", "    next", "", "last"]);
		expect(preview.render(9).map(row => Bun.stripANSI(row))).toEqual(expectedTail(source, 9));
		preview.setText(" \n\t\n\n  ");
		expect(preview.render(80)).toEqual([]);
	});

	it("moves the newest-line emphasis with streamed content on both surfaces and theme changes", async () => {
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
				expect(preview.render(80)).toEqual(before);
				expect(preview.describe(context(80))).toMatchObject({ k: "rows", p: { lines: before } });
				preview.setText("first\nlatest\n\n\nnext");
				const after = [
					theme.fg("thinkingText", "first"),
					theme.fg("thinkingText", "latest"),
					theme.fg("thinkingText", ""),
					theme.fg("text", "next"),
				];
				expect(preview.render(80)).toEqual(after);
				expect(preview.describe(context(80))).toMatchObject({ k: "rows", p: { lines: after } });
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
					expect(rows.map(row => Bun.stripANSI(row))).toEqual(expectedTail(prefix, width));
					expect(rows.length).toBeLessThanOrEqual(5);
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
			expect(lines.map(row => Bun.stripANSI(row))).toEqual(expectedTail(source, 1));
			expect(lines.length).toBeLessThanOrEqual(5);
		}
	});

	it("matches terminal sanitization across split ANSI and control input", () => {
		const source = "old\n\x1b[31m中文 colored\x1b[0m\t🙂\r\nlatest\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		const preview = new ThinkingPreviewComponent();
		for (let end = 1; end <= source.length; end++) {
			const prefix = source.slice(0, end);
			preview.setText(prefix);
			expect(preview.render(9).map(row => Bun.stripANSI(row))).toEqual(expectedTail(prefix, 9));
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
					expect(rows.map(row => Bun.stripANSI(row))).toEqual(expectedTail(prefix, width));
				}
				// A revision must discard an unresolved escape from the old body.
				preview.setText(`${source}\x1b]8;;unfinished`);
				preview.render(width);
				preview.setText("replacement\r\n🙂tail");
				preview.render(width);
				preview.setText("replacement\r\n🙂tail appended");
				expect(preview.render(width).map(row => Bun.stripANSI(row))).toEqual(
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
						expect(rows.map(row => Bun.stripANSI(row))).toEqual(expectedTail(source, width));
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
			expect(preview.render(width).map(row => Bun.stripANSI(row))).toEqual(expectedTail(source, width));
			source += " appended words";
			preview.setText(source);
			expect(preview.render(width).map(row => Bun.stripANSI(row))).toEqual(expectedTail(source, width));
		}
		preview.setText("replacement\nonly two rows");
		expect(preview.render(80).map(row => Bun.stripANSI(row))).toEqual(["replacement", "only two rows"]);
		expect(preview.render(0)).toEqual([]);
		expect(preview.render(80).map(row => Bun.stripANSI(row))).toEqual(["replacement", "only two rows"]);
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
			expect(lines.map(row => Bun.stripANSI(row))).toEqual(expectedTail(source, cols));
			expect(lines.length).toBeLessThanOrEqual(5);
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
			expect(preview.render(8).map(row => Bun.stripANSI(row))).toEqual(expectedTail(source, 8));
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
			expect(after).toEqual(
				rows.map((row, index) => theme.fg(index === rows.length - 1 ? "text" : "thinkingText", row)),
			);
			preview.invalidate();
			expect(preview.render(8)).toEqual(after);
		} finally {
			setThemeInstance(original);
		}
	});
});
