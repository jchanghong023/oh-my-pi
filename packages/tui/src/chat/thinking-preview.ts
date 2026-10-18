import { sanitizeText } from "@oh-my-pi/pi-utils";
import { EMPTY_NODE, node } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import { sanitizeCarriageReturns } from "../render/render-utils";
import { ensureThemeSync, getThemeEpoch, theme } from "../theme";
import type { Component } from "../tui";
import { getWidthConfigEpoch, replaceTabs, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";

const MAX_ROWS = 5;
/** Short terminals clamp the live tail so it cannot dominate the viewport. */
const SHORT_TERMINAL_ROW_LIMIT = 20;
const SHORT_TERMINAL_MAX_ROWS = 3;
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
function wrapTail(source: string, width: number, continuedLine: boolean, maxRows: number): TailRow[] {
	const tail: TailRow[] = [];
	let lineStart = 0;
	while (lineStart <= source.length) {
		const newline = source.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? source.length : newline;
		const line = source.slice(lineStart, lineEnd);
		const continued = lineStart === 0 && continuedLine;
		const blank = !/\S/.test(line);
		let rows = blank ? [line] : wrapTextWithAnsi(line, width);
		if (continued && !blank && rows.length === 1) {
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
			if (tail.length > maxRows + MUTABLE_ROWS) tail.shift();
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
	#maxRows = MAX_ROWS;
	#heightSource: (() => number) | undefined;
	#dirty = false;
	#normalizationStart: number | undefined;
	#painted: readonly string[] | undefined;
	#themeEpoch = -1;
	#native: NativeNode | undefined;
	/** Last non-blank line of a finished tail, shown as a single dim stub row. */
	#stubLine: string | undefined;

	/** Feed the terminal height so short terminals clamp the live tail to three rows. */
	setHeightSource(source: (() => number) | undefined): void {
		this.#heightSource = source;
	}

	#liveMaxRows(): number {
		const height = this.#heightSource?.();
		return height !== undefined && Number.isFinite(height) && height > 0 && height < SHORT_TERMINAL_ROW_LIMIT
			? SHORT_TERMINAL_MAX_ROWS
			: MAX_ROWS;
	}

	setText(text: string): boolean {
		if (text === this.#text) {
			// Re-attaching the same live content retires a stub from an
			// earlier collapse; unchanged live text stays cached.
			if (this.#stubLine === undefined) return false;
			this.#stubLine = undefined;
			this.#dirty = true;
			this.invalidate();
			return true;
		}
		this.#stubLine = undefined;
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

	/**
	 * Collapse the finished tail to one dim stub row bridging tool runs within
	 * the turn. The next {@link setText} goes live again; `clear` wipes fully.
	 */
	collapse(): boolean {
		if (this.#text.length === 0 || this.#stubLine !== undefined) return false;
		const normalized = replaceTabs(sanitizeText(sanitizeCarriageReturns(this.#text)));
		let stubLine: string | undefined;
		for (const line of normalized.split("\n")) {
			if (/\S/.test(line)) stubLine = line;
		}
		if (stubLine === undefined) return false;
		this.#stubLine = stubLine;
		this.invalidate();
		return true;
	}

	invalidate(): void {
		this.#painted = undefined;
		this.#native = undefined;
	}

	render(width: number): readonly string[] {
		const cols = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (cols === 0) return EMPTY_ROWS;
		ensureThemeSync();
		const widthEpoch = getWidthConfigEpoch();
		if (this.#stubLine !== undefined) {
			if (cols !== this.#width || widthEpoch !== this.#widthEpoch) {
				// Rows folded at the old width are stale once the stub retires.
				this.#tail = undefined;
				this.#continuedLine = false;
				this.#settled = EMPTY_ROWS;
				this.#dirty = true;
				this.#width = cols;
				this.#widthEpoch = widthEpoch;
				this.invalidate();
			}
			const stubEpoch = getThemeEpoch();
			if (this.#painted === undefined || stubEpoch !== this.#themeEpoch) {
				// Settled context stays muted instead of competing with live prose.
				const prefix = "  … ";
				let stub = truncateToWidth(`${prefix}${this.#stubLine}`, cols, "");
				if (!/\S/.test(stub.slice(prefix.length))) {
					stub = truncateToWidth(`… ${this.#stubLine}`, cols, "");
				}
				this.#painted = [theme.fg("dim", stub)];
				this.#themeEpoch = stubEpoch;
				this.#native = undefined;
			}
			return this.#painted;
		}
		if (this.#text.length === 0) return EMPTY_ROWS;
		const prefixWidth = visibleWidth("  │ ");
		const prefix = cols > prefixWidth ? "  │ " : "";
		const contentWidth = cols - (prefix ? prefixWidth : 0);
		const maxRows = this.#liveMaxRows();
		if (cols !== this.#width || widthEpoch !== this.#widthEpoch || maxRows !== this.#maxRows) {
			this.#tail = undefined;
			this.#continuedLine = false;
			this.#settled = EMPTY_ROWS;
			this.#dirty = true;
			this.#width = cols;
			this.#widthEpoch = widthEpoch;
			this.#maxRows = maxRows;
		}
		if (this.#dirty) {
			// Compact completed blank lines only; retain the final partial line's
			// whitespace so later text keeps its original indentation.
			const source = (this.#tail ?? replaceTabs(sanitizeText(sanitizeCarriageReturns(this.#text)))).replace(
				/(^|\n)(?:[^\S\n]*\n)+/g,
				"$1\n",
			);
			const wrapped = wrapTail(source, contentWidth, this.#continuedLine, maxRows);
			let boundary = Math.max(0, wrapped.length - MUTABLE_ROWS);
			while (boundary > 0 && wrapped[boundary]?.text === "" && !wrapped[boundary]?.startsLine) boundary--;
			this.#settled = [...this.#settled, ...wrapped.slice(0, boundary).map(row => row.text)].slice(-maxRows);
			const resume = wrapped[boundary];
			this.#tail = source.slice(resume?.start ?? source.length);
			this.#continuedLine = resume !== undefined && !resume.startsLine;
			const rows = [...this.#settled, ...wrapped.slice(boundary).map(row => row.text)];
			while (rows.length > 0 && !/\S/.test(rows[rows.length - 1]!)) rows.pop();
			// The shared wrapper preserves an indivisible wide grapheme even at
			// width 1. Omit that unfit grapheme instead of letting a terminal wrap
			// it into a row beyond the body limit.
			this.#rows =
				rows.length > 0 ? rows.slice(-maxRows).map(row => truncateToWidth(row, contentWidth, "")) : EMPTY_ROWS;
			this.#dirty = false;
			this.invalidate();
		}
		const themeEpoch = getThemeEpoch();
		if (this.#painted === undefined || themeEpoch !== this.#themeEpoch) {
			const latest = this.#rows.findLastIndex(row => /\S/.test(row));
			const guide = prefix ? theme.fg("borderMuted", prefix) : "";
			const liveGuide = prefix ? theme.fg("accent", prefix) : "";
			const painted = this.#rows.map(
				(row, index) => (index === latest ? liveGuide : guide) + theme.fg(index === latest ? "text" : "dim", row),
			);
			if (prefix && painted.length > 0) {
				const heading =
					theme.fg("borderMuted", cols >= 10 ? "  ╭─ " : "  ") + theme.fg("accent", theme.bold("思考"));
				painted.unshift(truncateToWidth(heading, cols, ""));
			}
			this.#painted = painted;
			this.#themeEpoch = themeEpoch;
			this.#native = undefined;
		}
		return this.#painted;
	}

	describe(cx?: DescribeContext): NativeNode {
		const cols = cx?.cols ?? this.#width ?? 0;
		const lines = this.render(cols);
		if (lines.length === 0) return EMPTY_NODE;
		// Already folded and decorated at the surface width; native must not
		// wrap the full reasoning body or count the header against its row limit.
		this.#native ??= node("rows", { cols: this.#width ?? 0, lines });
		return this.#native;
	}
}
