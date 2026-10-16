import { sanitizeText } from "@oh-my-pi/pi-utils";
import { EMPTY_NODE, node } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import { sanitizeCarriageReturns } from "../render/render-utils";
import { ensureThemeSync, getThemeEpoch, theme } from "../theme";
import type { Component } from "../tui";
import { getWidthConfigEpoch, replaceTabs, truncateToWidth, wrapTextWithAnsi } from "../utils";

const MAX_ROWS = 5;
// A growing final word can move off the previous row when it becomes too long.
// Keep both rows mutable, including their original whitespace and graphemes.
const MUTABLE_ROWS = 2;
const EMPTY_ROWS: readonly string[] = [];
const UNSAFE_INCREMENT = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/;
// Track only raw suffixes whose normalization can change on append. This is
// boundary detection, not stripping: the shared sanitizer still owns ANSI/CR
// output, including incomplete sequences. String controls may contain ESC, so
// only BEL (OSC) or the complete ESC \ terminator settles their boundary.
const PENDING_NORMALIZATION =
	/\r+$|(?:\x1b\[|\x9b)[^@-~]*$|\x1b(?:\](?:(?!\x1b\\)[^\x07])*|[PX^_](?:(?!\x1b\\)[\s\S])*|[ -/]*)$/;

interface TailRow {
	readonly text: string;
	readonly start: number;
	readonly startsLine: boolean;
}

/** Wrap with the shared engine; retain only a bounded row/offset index. */
function wrapTail(source: string, width: number, continuedLine: boolean): TailRow[] {
	const tail: TailRow[] = [];
	let lineStart = 0;
	while (lineStart <= source.length) {
		const newline = source.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? source.length : newline;
		const line = source.slice(lineStart, lineEnd);
		const continued = lineStart === 0 && continuedLine;
		let rows = wrapTextWithAnsi(line, width);
		if (continued && rows.length === 1) {
			// The original long line took the wrapper's slow path, which trims
			// soft-row trailing spaces. A short suffix must not regain the
			// fits-without-wrapping fast path. A full row plus a discarded soft
			// separator restores that context using the shared engine itself.
			rows = wrapTextWithAnsi(`${"x".repeat(width)} ${line}`, width).slice(1);
		}
		let cursor = 0;
		let rowIndex = 0;
		for (const row of rows) {
			const firstRow = rowIndex++ === 0;
			const startsLine = firstRow && !continued;
			// An unfit first grapheme emits an empty row without consuming any
			// source. It belongs to the settled prefix when resuming mid-line.
			if (continued && firstRow && row.length === 0) continue;
			// Sanitized nonempty rows are contiguous source slices. Empty soft
			// rows have no unique source offset and cannot be resume boundaries.
			const start = startsLine || row.length === 0 ? cursor : line.indexOf(row, cursor);
			tail.push({ text: row, start: lineStart + start, startsLine });
			if (tail.length > MAX_ROWS + MUTABLE_ROWS) tail.shift();
			cursor = start + row.length;
		}
		if (newline < 0) break;
		lineStart = newline + 1;
	}
	return tail;
}

/** Ephemeral, plain-text tail of the active thinking block; never a transcript child. */
export class ThinkingPreviewComponent implements Component {
	// Keep the caller's immutable string, not a second full normalized history.
	#text = "";
	#tail: string | undefined;
	#continuedLine = false;
	#settled: readonly string[] = EMPTY_ROWS;
	#rows: readonly string[] = EMPTY_ROWS;
	#width: number | undefined;
	#widthEpoch = -1;
	#dirty = false;
	#normalizationStart: number | undefined;
	#painted: readonly string[] | undefined;
	#themeEpoch = -1;
	#native: NativeNode | undefined;

	setText(text: string): boolean {
		if (text === this.#text) return false;
		const previous = this.#text;
		const append = text.startsWith(previous);
		const delta = append ? text.slice(previous.length) : text;
		const lastCode = previous.charCodeAt(previous.length - 1);
		const splitSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
		const unsafe = UNSAFE_INCREMENT.test(delta);
		if (append && this.#tail !== undefined && this.#normalizationStart === undefined && !unsafe && !splitSurrogate) {
			this.#tail += replaceTabs(sanitizeText(delta));
		} else {
			// Revisions and control/escape streams are normalized as a whole so
			// split ANSI sequences, CRLF and UTF-16 pairs cannot leak fragments.
			this.#tail = undefined;
			this.#continuedLine = false;
			this.#settled = EMPTY_ROWS;
		}
		// Inspect only new input plus an unresolved raw suffix, never settled
		// history. Once its terminator arrives, the next clean append can reuse
		// the wrapped tail even if older text contained CRLF or ANSI.
		const normalizationStart = append ? (this.#normalizationStart ?? previous.length) : 0;
		const pending = PENDING_NORMALIZATION.exec(text.slice(normalizationStart));
		this.#normalizationStart = pending === null ? undefined : normalizationStart + pending.index;
		this.#text = text;
		this.#dirty = true;
		this.invalidate();
		return true;
	}

	clear(): boolean {
		return this.setText("");
	}

	invalidate(): void {
		this.#painted = undefined;
		this.#native = undefined;
	}

	render(width: number): readonly string[] {
		const cols = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (this.#text.length === 0 || cols === 0) return EMPTY_ROWS;
		ensureThemeSync();
		const widthEpoch = getWidthConfigEpoch();
		if (cols !== this.#width || widthEpoch !== this.#widthEpoch) {
			this.#tail = undefined;
			this.#continuedLine = false;
			this.#settled = EMPTY_ROWS;
			this.#dirty = true;
			this.#width = cols;
			this.#widthEpoch = widthEpoch;
		}
		if (this.#dirty) {
			const source = this.#tail ?? replaceTabs(sanitizeText(sanitizeCarriageReturns(this.#text)));
			const wrapped = wrapTail(source, cols, this.#continuedLine);
			let boundary = Math.max(0, wrapped.length - MUTABLE_ROWS);
			while (boundary > 0 && wrapped[boundary]?.text === "" && !wrapped[boundary]?.startsLine) boundary--;
			this.#settled = [...this.#settled, ...wrapped.slice(0, boundary).map(row => row.text)].slice(-MAX_ROWS);
			const resume = wrapped[boundary];
			this.#tail = source.slice(resume?.start ?? source.length);
			this.#continuedLine = resume !== undefined && !resume.startsLine;
			const rows = [...this.#settled, ...wrapped.slice(boundary).map(row => row.text)].slice(-MAX_ROWS);
			// The shared wrapper preserves an indivisible wide grapheme even at
			// width 1. Omit that unfit grapheme instead of letting a terminal wrap
			// it into an unaccounted sixth physical row.
			this.#rows = rows.some(row => /\S/.test(row)) ? rows.map(row => truncateToWidth(row, cols, "")) : EMPTY_ROWS;
			this.#dirty = false;
			this.invalidate();
		}
		const themeEpoch = getThemeEpoch();
		if (this.#painted === undefined || themeEpoch !== this.#themeEpoch) {
			this.#painted = this.#rows.map(row => theme.fg("thinkingText", row));
			this.#themeEpoch = themeEpoch;
			this.#native = undefined;
		}
		return this.#painted;
	}

	describe(cx?: DescribeContext): NativeNode {
		const cols = cx?.cols ?? this.#width ?? 0;
		const lines = this.render(cols);
		if (lines.length === 0) return EMPTY_NODE;
		// Already folded at the surface width: do not hand native Text the
		// complete reasoning body and let it wrap into more than five rows.
		this.#native ??= node("rows", { cols: this.#width ?? 0, lines });
		return this.#native;
	}
}
