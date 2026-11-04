/**
 * Shared renderer for a horizontal row of colored "segments" styled after the
 * status line: each segment is colored by its track position from the theme's
 * own palette, the active one is filled as a powerline chip (its color as the
 * background, a luminance-matched label, flanked by triangle caps) and the
 * rest are plain colored labels joined by a thin separator.
 *
 * Used by the plan-mode model-tier slider ({@link HookSelectorComponent}) and
 * the ctrl+p role-cycle status so both surfaces read identically.
 */
import { type ThemeColor, theme } from "../theme/index";
import { BG_RESET, FG_RESET } from "../theme/color";
import type { NativeNode } from "../native/node";
import { node, row } from "../native/describe";
import { visibleWidth } from "../utils";
export interface TrackSegment {
	label: string;
}

/** Terminal-cell bounds of a rendered segment, relative to the track. */
export interface SegmentTrackRange {
	start: number;
	end: number;
}

/** Vivid theme colors for position-based segment coloring, in preference
 *  order. Themes alias many of these to the same value (titanium maps most of
 *  the syntax set onto its accent), so {@link resolveSegmentPalette} dedupes
 *  by resolved escape and hands position i the i-th distinct color. */
const SEGMENT_COLOR_CANDIDATES: ThemeColor[] = [
	"accent",
	"success",
	"warning",
	"error",
	"mdCode",
	"mdLink",
	"syntaxString",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxNumber",
	"syntaxOperator",
	"syntaxVariable",
];

/**
 * Resolve up to `count` theme colors that render distinctly under the active
 * theme, in candidate preference order. May return fewer than `count` when the
 * theme has fewer distinct hues (e.g. monochrome themes) — callers wrap with
 * modulo. Never returns an empty array: `accent` always resolves.
 */
export function resolveSegmentPalette(count: number): ThemeColor[] {
	const palette: ThemeColor[] = [];
	const seen = new Set<string>();
	for (const color of SEGMENT_COLOR_CANDIDATES) {
		const ansi = theme.getFgAnsi(color);
		if (seen.has(ansi)) continue;
		seen.add(ansi);
		palette.push(color);
		if (palette.length >= count) break;
	}
	return palette;
}

/**
 * Native {@link renderSegmentTrack}: a row of position-colored labels, the
 * active one roled `omp.track.active` so the terminal fills it as a chip in
 * its own color. No caps or separators travel; the terminal draws them.
 */
export function describeSegmentTrack(segments: readonly TrackSegment[], activeIndex: number): NativeNode {
	const palette = resolveSegmentPalette(segments.length);
	return row(
		segments.map((segment, index) =>
			node(
				"text",
				{
					spans: [{ t: segment.label, s: palette[index % palette.length] }],
					wrap: "none",
					role: index === activeIndex ? "omp.track.active" : "omp.track.item",
				},
				undefined,
				`${index}`,
			),
		),
		{ gap: "sm", align: "center", role: "omp.track" },
	);
}

/**
 * Render `segments` as a colored chip track with `activeIndex` filled. Returns
 * a single line of styled text with no surrounding caption or arrows — callers
 * frame it as they need.
 */
export function renderSegmentTrack(
	segments: TrackSegment[],
	activeIndex: number,
	ranges?: SegmentTrackRange[],
): string {
	// Powerline triangles point *into* the chip so the colored caps merge with
	// the filled body: left cap points left, right cap points right.
	const capLeft = theme.sep.powerlineRight;
	const capRight = theme.sep.powerlineLeft;
	const thinSep = theme.fg("statusLineSep", theme.sep.powerlineThin);
	const palette = resolveSegmentPalette(segments.length);
	if (ranges) ranges.length = 0;

	let track = "";
	let column = 0;
	segments.forEach((segment, i) => {
		if (i > 0) {
			// A thin separator reads cleanly only between two plain labels; the chip
			// caps already delimit the active segment, so pad around it instead.
			const separator = i === activeIndex || i - 1 === activeIndex ? "  " : ` ${thinSep} `;
			track += separator;
			if (ranges) column += visibleWidth(separator);
		}
		const color = palette[i % palette.length];
		const fg = theme.getFgAnsi(color);
		let rendered: string;
		if (i !== activeIndex) {
			rendered = `${fg}${segment.label}${FG_RESET}`;
		} else {
			const bg = fg.replace("\x1b[38;", "\x1b[48;");
			const label = `${bg}${theme.getContrastFgAnsi(color)}\x1b[1m ${segment.label} \x1b[22m${BG_RESET}`;
			rendered = `${fg}${capLeft}${label}${fg}${capRight}${FG_RESET}`;
		}
		track += rendered;
		if (ranges) {
			const start = column;
			column += visibleWidth(rendered);
			ranges.push({ start, end: column });
		}
	});
	return track;
}
