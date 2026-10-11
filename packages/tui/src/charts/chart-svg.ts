/**
 * Draws a {@link ChartSpec} as a standalone SVG document colored only with
 * figure tokens — `var(--fg)`, `var(--muted)`, `var(--border)`,
 * `var(--accent)`, `var(--surface)`, `var(--c1)`…`var(--c6)` — on a
 * transparent background — the token vocabulary of assistant ```svg figures —
 * so the host resolves them against the live theme (`prepareSvg`) for both
 * the rasterized terminal image and the native TSP blob.
 *
 * Styled after Apple's charts and Tern's UI: a UI sans (Geist where Tern
 * provides it), muted labels, hairline gridlines that recede behind the
 * marks, bars and cells with rounded corners, smooth lines over a soft area
 * fill, dot legends. 13-unit labels land near the terminal's own glyph size
 * at 16 user units per row; bolded table cells draw at full strength while
 * their neighbours recede. Grouped categories ({@link ChartSpec.groups}) name
 * each group once beside its members, the groups parted by a gap. A few
 * outliers far above the rest break a bar axis instead of flattening it
 * ({@link outlierTier}); reference rows ({@link ChartSpec.reference}) draw a
 * dashed rule through their group.
 *
 * Every chart opens with a header ({@link drawHeader}): the semibold title a
 * planner set ({@link ChartSpec.title}, the one fact worth stating), a muted
 * note on how the data is encoded, and the series key right-aligned on the
 * title's line when it fits. Marks size to
 * the row count ({@link barMetrics}); strong heat cells and share segments
 * print their figures in a theme-adaptive dark {@link ink}. Reusable
 * annotation primitives — {@link band}, {@link referenceRule},
 * {@link callout} — draw the {@link ChartSpec.annotations} a planner lays on.
 *
 * Meaning layers on top: each contest's best value carries a `best` tag (an
 * outline in a heatmap), moves of a measure with a polarity read in `success`
 * or `error` (transitions, factors, signed deltas), and status cells badge
 * their row's name with a colored dot keyed under the chart.
 */
import {
	type ChartAnnotation,
	type ChartGroup,
	type ChartPoint,
	type ChartSeries,
	type ChartSpec,
	intervalMiddle,
	isConditionPair,
	type Polarity,
	percentText,
} from "./chart-plan";
import { cellStatus, type Dimension, type Status } from "./table-data";

const WIDTH = 720;
const PAD = 12;
const LABEL_SIZE = 13;
const TICK_SIZE = 11;
/** Mean advance per em of the UI sans, for character budgets; {@link measure} estimates real widths. */
const ADVANCE = 0.55;
const FONT =
	"Geist, -apple-system, system-ui, 'SF Pro Text', 'Helvetica Neue', Inter, 'Segoe UI', Roboto, 'Noto Sans', 'DejaVu Sans', Arial, sans-serif";
/** Series colors in draw order. */
const SERIES = ["c1", "c2", "c3", "c4", "c5", "c6"] as const;
/** Corner radius of bars, tracks and cells. */
const RADIUS = 3;
/** Opacity of gridlines over the border color: hairlines behind the marks. */
const GRID_OPACITY = 0.5;
/** Ratio between line series' peaks from which they stop sharing an axis. */
const SPLIT_SPREAD = 8;
/** Most categories whose every sample draws as a dot on its line. */
const MAX_DOTS = 16;
/** Spread (max/min of positive values) from which an axis turns logarithmic. */
const LOG_SPREAD = 100;
/** Spread from which dots and intervals take a log axis: they mark positions, not lengths from zero, so a decade warrants one. */
const SPAN_LOG = 10;
/** Most decades a positional log axis ticks at 1, 2 and 5 times each power of ten. */
const FINE_DECADES = 2.5;
/** Typical ratio between two interval series of one unit from which they are different quantities, banded apart. */
const BAND_SPREAD = 30;
/** Log-axis ticks for durations from a second up, in seconds: clock steps (`30s`, `5m`, `2h`), not powers of ten. */
const CLOCK_TICKS = [
	1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 18_000, 43_200, 86_400, 172_800, 604_800, 1_209_600,
	2_592_000,
];
/**
 * Smallest jump from the rest to an outlier tier that breaks the axis (one
 * model at 60× the others); below it a linear axis still leaves the rest a
 * readable eighth of its length, and keeps the outlier's size visible.
 */
const TIER_GAP = 8;
/** Fewest values below an outlier tier that make breaking the axis worth it. */
const MIN_BELOW_TIER = 3;
/** Most of the values an outlier tier may hold; more is a second cluster, not outliers. */
const MAX_TIER_SHARE = 1 / 3;
/** Share of a broken axis' length the values below the break get. */
const CUT_AT = 0.7;
/** Width of the gap parting a broken axis' segments, in user units. */
const CUT_GAP = 10;
const MAX_LABEL_CHARS = 28;
/** Longest group name in a label column; its members beside it keep {@link MAX_LABEL_CHARS}. */
const MAX_GROUP_CHARS = 20;
/** Vertical space parting consecutive groups of category rows. */
const GROUP_GAP = 8;
/** Semibold text sets this much wider than {@link measure} estimates for regular text. */
const SEMIBOLD_WIDTH = 1.06;
/** Opacity of marks beside an emphasized one. */
const RECEDE = 0.4;
/** Categories beyond which grouped bars pack tighter ({@link barMetrics}). */
const DENSE_ROWS = 12;
/** Share of a stacked bar's whole its parts may miss by rounding before the rest draws as a track. */
const MIN_REST = 0.01;
/** Opacity of a range bar's span past its low end, relative to the bar. */
const RANGE_OPACITY = 0.35;
/** Most panels across one band of small multiples drawn as panels. */
const PANELS_ACROSS = 3;
/** Factors a change axis rounds its ends out to; past the last, whole powers of ten. */
const FACTOR_STOPS = [1.25, 1.5, 2, 3, 5, 10];
/** Height of the title line. */
const TITLE_LINE = 18;
/** Space between the header and the plot under it. */
const HEADER_GAP = 10;
/** Height of one wrapped legend line. */
const LEGEND_LINE = 18;
/** Heat level (0–1) from which a cell is strong enough to print its figure in {@link ink}. */
const INK_LEVEL = 0.58;
/** Fill opacity of the faintest heat cell; the strongest is opaque. */
const HEAT_FLOOR = 0.09;
/** Mask id behind {@link ink}; its definition is the same in every chart, so charts inlined in one page agree on it. */
const INK_MASK = "chart-ink";
/** Longest callout text. */
const MAX_CALLOUT_CHARS = 28;
/** Longest legend name. */
const MAX_LEGEND_CHARS = 32;
/** Longest name a line carries at its end instead of a legend. */
const MAX_DIRECT_LABEL = 130;
/** Width the status badge before a category name takes. */
const STATUS_WIDTH = 14;
/** Badge color of each status. */
const STATUS_COLORS: Record<Status, string> = { good: "success", bad: "error", warn: "warning", pending: "muted" };
/** Room a {@link bestTag} takes after its value. */
const BEST_WIDTH = 34;
/** Factor within which a move reads as no change, toned neither way. */
const STILL = 1.03;

/**
 * A drawn layer: its SVG elements and the height they span from `top`, with
 * the key and encoding notes the header shows for it.
 */
interface Layer {
	readonly height: number;
	readonly body: string;
	/** Series keys the header draws beside the title (or under it when they do not fit). */
	readonly legend?: readonly LegendItem[];
	/** A heat scale key the header draws instead of a legend. */
	readonly ramp?: RampKey;
	/** How the chart encodes its data where that is not obvious (`log scale`); the derived subtitle. */
	readonly notes?: readonly string[];
}

/** A legend entry: a name beside a filled dot of `color`, or a hollow ring for a transition's start. */
interface LegendItem {
	readonly name: string;
	readonly color: string;
	readonly ring?: boolean;
	/** The dot's opacity, matching a fainter mark (a second part in one outcome color); opaque by default. */
	readonly opacity?: number;
}

/** A heat scale key: the faintest and strongest cells' figures either side of a strip of swatches. */
interface RampKey {
	readonly color: string;
	readonly low: string;
	readonly high: string;
}

/** Map a value to a coordinate, with tick values for the axis. */
interface Scale {
	at(value: number): number;
	readonly ticks: readonly number[];
	readonly log: boolean;
	/** A broken axis: values above `below` jump the gap from `start` to `end` onto a second, zoomed segment. */
	readonly cut?: Cut;
}

/** Where a broken axis parts its segments: the first ends at `start` (value `below`), the second begins at `end`. */
interface Cut {
	readonly below: number;
	readonly start: number;
	readonly end: number;
}

/** A few values standing far above the rest: the rest's largest and the tier's smallest and largest. */
interface Tier {
	readonly rest: number;
	readonly low: number;
	readonly high: number;
}

/** A drawn chart: the SVG document and its size in user units. */
export interface ChartSvg {
	readonly svg: string;
	readonly width: number;
	readonly height: number;
}

/** The SVG document for `spec`. */
export function renderChartSvg(spec: ChartSpec): ChartSvg {
	const layer = drawChart(spec);
	const header = drawHeader(spec, layer);
	const head = matrixHead(spec);
	const top = PAD + header.height + head.height;
	let height = top + layer.height;
	// The badges' key: one dot per status shown, then the column they come from.
	let key = "";
	if (spec.statusName && spec.status?.some(Boolean)) {
		const shown = (["good", "warn", "bad", "pending"] as const).filter(state => spec.status!.includes(state));
		const y = height + 14;
		key = shown.map((state, at) => dot(PAD + 4 + at * 12, y, 4, STATUS_COLORS[state])).join("");
		key += text(PAD + shown.length * 12 + 4, y, clip(spec.statusName, 60), { size: TICK_SIZE, fill: "muted" });
		height += 20;
	}
	let caption = "";
	if (spec.caption) {
		caption = text(PAD, height + 14, clip(spec.caption, Math.floor((WIDTH - 2 * PAD) / (TICK_SIZE * ADVANCE))), {
			size: TICK_SIZE,
			fill: "muted",
		});
		height += 20;
	}
	height = Math.ceil(height + PAD);
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="${FONT}" font-size="${LABEL_SIZE}">`,
		layer.body.includes(`url(#${INK_MASK})`) ? INK_DEFS : "",
		`<g transform="translate(0 ${PAD})">${header.body}</g>`,
		head.body && `<g transform="translate(0 ${num(PAD + header.height)})">${head.body}</g>`,
		`<g transform="translate(0 ${num(top)})">${layer.body}</g>`,
		key,
		caption,
		"</svg>",
	].join("");
	return { svg, width: WIDTH, height };
}

/** One-line description of the chart, for screen readers and terminals that show the alt text. */
export function chartAlt(spec: ChartSpec): string {
	const names = spec.series.map(entry => entry.name).join(spec.kind === "stacked" ? " + " : ", ");
	const kind =
		spec.kind === "multiples"
			? "small multiples"
			: spec.normalized
				? "100% stacked"
				: spec.kind === "dots"
					? "dot"
					: spec.kind;
	const versus = spec.baseline
		? ` vs ${spec.baseline}`
		: spec.whole
			? ` = ${spec.whole.name}`
			: spec.kind === "waterfall" && spec.total
				? ` to ${spec.total.name}`
				: "";
	const lead = spec.title ? `${spec.title}. ` : "";
	return `${lead}${kind} chart of ${names}${versus}${spec.axis ? ` by ${spec.axis}` : ""}`;
}

/**
 * The header over a chart: the title when the plan states one, its muted
 * encoding note, and the layer's key right-aligned on the same line — or
 * wrapped under it when the line has no room. Nothing at all for a chart
 * with neither title, note nor key.
 */
function drawHeader(spec: ChartSpec, layer: Layer): Layer {
	const span = WIDTH - 2 * PAD;
	const items = layer.legend ?? [];
	const keyWidth = layer.ramp ? rampWidth(layer.ramp) : items.length ? legendWidth(items) : 0;
	const subtitle = spec.subtitle ?? (layer.notes ?? []).join(" · ");
	const fullTitle = spec.title ?? "";
	if (!fullTitle && !subtitle && keyWidth === 0) return { height: 0, body: "" };
	const subtitleWidth = subtitle ? 12 + measure(subtitle, TICK_SIZE) : 0;
	const inline =
		keyWidth === 0 || !fullTitle || measure(fullTitle, LABEL_SIZE) * SEMIBOLD_WIDTH + 24 + keyWidth <= span;
	const room = inline && keyWidth ? span - keyWidth - 24 : span;
	const title = fullTitle ? fitText(fullTitle, room, LABEL_SIZE * SEMIBOLD_WIDTH) : "";
	// Without a title the note leads the line.
	const titleWidth = title ? measure(title, LABEL_SIZE) * SEMIBOLD_WIDTH + 12 : 0;
	const parts = [text(PAD, 8, title, { fill: "fg", weight: 600 })];
	// The note takes what the title leaves, and only when enough is left to say something.
	if (subtitle && room - titleWidth >= Math.min(subtitleWidth, 60))
		parts.push(
			text(PAD + titleWidth, 8, fitText(subtitle, room - titleWidth, TICK_SIZE), {
				size: TICK_SIZE,
				fill: "muted",
			}),
		);
	let height = TITLE_LINE;
	if (layer.ramp) {
		const y = inline ? 8 : TITLE_LINE + 8;
		parts.push(drawRamp(layer.ramp, inline ? WIDTH - PAD - keyWidth : PAD, y));
		if (!inline) height += LEGEND_LINE;
	} else if (items.length) {
		if (inline) {
			parts.push(drawLegend(items, WIDTH - PAD - keyWidth, WIDTH - PAD, 8).body);
		} else {
			const legend = drawLegend(items, PAD, WIDTH - PAD, TITLE_LINE + 8);
			parts.push(legend.body);
			height = legend.height;
		}
	}
	return { height: height + HEADER_GAP, body: parts.join("") };
}

function drawChart(spec: ChartSpec): Layer {
	switch (spec.kind) {
		case "line":
			return drawLine(spec);
		case "heatmap":
			return drawGrid(spec, "heat");
		case "multiples":
			// Many panels of a few colorable categories wrap into bands; otherwise one column per panel.
			return spec.series.length > PANELS_ACROSS && spec.categories.length <= SERIES.length
				? drawPanels(spec)
				: drawGrid(spec, "bars");
		case "change":
			return drawChange(spec);
		case "share":
			return drawShare(spec);
		case "scatter":
			return drawScatter(spec);
		case "stacked":
			return drawStacked(spec);
		case "waterfall":
			return drawWaterfall(spec);
		case "timeline":
			return drawTimeline(spec);
		case "dots":
			return drawDots(spec);
		case "range":
			return drawRange(spec);
		default:
			return drawBars(spec);
	}
}

// ── Horizontal bars: bar, grouped, paired, diverging, progress ───────────────

/**
 * Row and bar heights for `count` categories: few rows get thick, airy bars,
 * many get thin ones so the chart stays a glance. Grouped bars stack one thin
 * bar per series in each row.
 */
function barMetrics(count: number, grouped: number): { row: number; bar: number; step: number } {
	if (grouped > 1) {
		// Past {@link DENSE_ROWS} categories grouped bars pack tighter, so a long table stays a glance tall.
		if (count > DENSE_ROWS) return { row: grouped * 9 + 6, bar: 7, step: 9 };
		const bar = count <= 6 ? 10 : 8;
		return { row: grouped * (bar + 2) + 10, bar, step: bar + 2 };
	}
	const bar = count <= 5 ? 18 : count <= 10 ? 16 : count <= 20 ? 14 : 11;
	return { row: bar + (count <= 10 ? 10 : 8), bar, step: 0 };
}

function drawBars(spec: ChartSpec): Layer {
	const { kind, categories, series } = spec;
	// Progress fills a 0–100% track per bar; grouped and multi-track progress stack thin bars per category.
	const tracks = kind === "progress";
	const grouped = kind === "grouped" || (tracks && series.length > 1);
	const paired = kind === "paired";
	const single = series.length === 1;
	const diverging = kind === "diverging" && single;
	const values = tracks
		? [0, 100]
		: series.flatMap(entry =>
				entry.points.flatMap(point =>
					!point ? [] : point.upper === undefined ? [point.value] : [point.value, point.upper],
				),
			);
	const labelWidth = labelColumnWidth(spec);
	// Single bars beside a reference row print their change from it (`49.5k · −52%`).
	const referenced = kind === "bar" && spec.reference ? spec.reference : [];
	const versus = (at: number) => {
		const index = referenced.find(index => groupSpan(spec, index).join() === groupSpan(spec, at).join());
		const [base, point] = [series[0]!.points[index ?? -1], series[0]!.points[at]];
		return index === undefined || index === at || !base || !point || base.value <= 0
			? ""
			: factorText({ ...point, value: point.value / base.value });
	};
	const valueText = (at: number) =>
		paired
			? [pointText(series[0]!, at), pointText(series[1]!, at)].filter(Boolean).join(spec.transition ? " → " : " · ")
			: single
				? [pointText(series[0]!, at), versus(at)].filter(Boolean).join(" · ")
				: "";
	const widest = (labels: readonly string[], size: number) =>
		Math.max(0, ...labels.map(label => measure(label, size)));
	const callouts = calloutTexts(spec);
	const calloutWidth = callouts.size ? widest([...callouts.values()], TICK_SIZE) * SEMIBOLD_WIDTH + 24 : 0;
	// A diverging bar's figure sits past its end, away from zero: negative figures need room left of the plot.
	const signed = (negative: boolean) =>
		widest(
			categories.map((_, at) => {
				const point = series[0]!.points[at];
				return point && point.value < 0 === negative ? valueText(at) : "";
			}),
			TICK_SIZE,
		);
	const leftRoom = diverging && values.some(value => value < 0) ? signed(true) + 8 : 0;
	// A best tag follows its figure: room for it where a series (or the row leaders) holds one.
	const tagged =
		series.some(entry => entry.best !== undefined) || spec.leaders?.some(lead => lead !== undefined) ? BEST_WIDTH : 0;
	const valueWidth =
		(diverging
			? signed(false) + 8
			: grouped
				? widest(
						series.flatMap(entry => entry.points.map(point => clip(point?.text ?? "", 12))),
						10,
					) + 6
				: Math.min(
						180,
						widest(
							categories.map((_, at) => valueText(at)),
							TICK_SIZE,
						) + 8,
					)) + (paired ? 0 : tagged);
	const left = PAD + labelWidth + 10 + leftRoom;
	const right = WIDTH - PAD - valueWidth - calloutWidth;
	// A dumbbell's connector or a track cannot cross a gap; bars can.
	const scale = valueScale(values, left, right, { zero: true, breakable: kind === "bar" || kind === "grouped" });
	const { row: rowHeight, bar: barHeight, step } = barMetrics(categories.length, grouped ? series.length : 1);

	const parts: string[] = [];
	const references = referenceMarks(spec);
	const top = references.length ? 16 : 0;
	const tops = rowTops(spec, top, rowHeight);
	const gridTop = top;
	const gridBottom = tops.at(-1)!;
	const strong = strongCategories(spec);
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	parts.push(drawValueAxis(scale, series[0]!, gridTop, gridBottom));
	parts.push(categoryLabels(spec, tops, rowHeight, strong));
	// Reference rules run under the marks and their figures; their labels sit above the plot.
	parts.push(referenceLines(references, scale, left, right, gridTop, gridBottom));

	const zero = scale.log ? left : scale.at(0);
	const reference = referenced.length ? referenceRules(spec, series[0]!, tops, rowHeight, scale.at) : undefined;
	const emphasized = series.some(entry => entry.points.some(point => point?.emphasis));
	categories.forEach((_, at) => {
		const rowTop = tops[at]!;
		const middle = rowTop + rowHeight / 2;
		if (paired) {
			const [a, b] = [series[0]!.points[at], series[1]!.points[at]];
			const radius = barHeight >= 14 ? 5 : 4;
			// A range (`5.7–9.6 ms`) draws as a capsule over its span; the connector joins the spans' middles.
			const center = (point: ChartPoint) => (scale.at(point.value) + scale.at(point.upper ?? point.value)) / 2;
			// A transition its measure's polarity calls better or worse takes that color at its end.
			const tone =
				spec.transition && a && b && a.value > 0
					? moveTone(series[1]!.polarity ?? series[0]!.polarity, b.value / a.value)
					: undefined;
			if (a && b) {
				const [from, to] = [center(a), center(b)];
				const width = num(Math.max(0.5, Math.abs(to - from)));
				parts.push(
					!spec.transition
						? line(from, middle, to, middle, "border", 2.5)
						: tone
							? `<rect x="${num(Math.min(from, to))}" y="${num(middle - 1.5)}" width="${width}" height="3" rx="1.5" fill="${token(tone)}" fill-opacity="0.45"/>`
							: `<rect x="${num(Math.min(from, to))}" y="${num(middle - 1.5)}" width="${width}" height="3" rx="1.5" fill="url(#pair-${to >= from ? "up" : "down"})"/>`,
				);
			}
			// A transition that went nowhere rings its end dot, so the start still shows.
			const still = a && b && Math.abs(center(a) - center(b)) < radius;
			if (a && !(spec.transition && still))
				parts.push(
					spec.transition
						? mark(scale, a, middle, radius, "muted", 1, true)
						: mark(scale, a, middle, radius, SERIES[0], 1),
				);
			if (b) parts.push(mark(scale, b, middle, radius, spec.transition ? (tone ?? SERIES[0]) : SERIES[1], 1));
			if (a && spec.transition && still) parts.push(ring(center(a), middle, radius + 2.5, "muted"));
			const strongPair = a?.emphasis || b?.emphasis;
			const from = pointText(series[0]!, at);
			const to = pointText(series[1]!, at);
			if (spec.transition && from && to) {
				const head = `${from} → `;
				parts.push(text(right + 8, middle, head, { size: TICK_SIZE, fill: "muted" }));
				parts.push(
					text(right + 8 + measure(head, TICK_SIZE), middle, to, {
						size: TICK_SIZE,
						fill: tone ?? "fg",
						weight: strongPair || tone ? 600 : undefined,
					}),
				);
			} else {
				parts.push(text(right + 8, middle, valueText(at), { size: TICK_SIZE, fill: strongPair ? "fg" : "muted" }));
			}
			return;
		}
		series.forEach((entry, index) => {
			const point = entry.points[at];
			const y = grouped ? rowTop + 5 + index * step : middle - barHeight / 2;
			const context = emphasized && !point?.emphasis;
			// One series' context bars go gray so the bolded ones carry the color alone; several keep their hues.
			// Signed changes of a measure with a polarity read as gains or losses.
			const gain = diverging && point ? moveTone(entry.polarity, point.value < 0 ? 0.5 : 2) : undefined;
			const fill =
				single && context
					? "muted"
					: (gain ?? (diverging && point && point.value < 0 ? SERIES[1] : SERIES[index % SERIES.length]!));
			const opacity = context ? (single ? 0.55 : RECEDE) : 1;
			if (tracks) parts.push(rect(left, y, scale.at(100) - left, barHeight, "border", 0.35));
			if (!point) {
				const note = entry.notes[at];
				if (note) parts.push(noteText(left + 4, y + barHeight / 2, clip(note, 24)));
				return;
			}
			const end = scale.at(point.value);
			if (scale.log) {
				parts.push(line(left, y + barHeight / 2, end, y + barHeight / 2, fill, 2, 0.4 * opacity));
				parts.push(mark(scale, point, y + barHeight / 2, Math.min(6, barHeight / 2.6), fill, opacity));
			} else if (scale.cut && point.value > scale.cut.below) {
				parts.push(cutBar(scale.cut, zero, end, y, barHeight, fill, opacity));
			} else {
				parts.push(rect(Math.min(zero, end), y, Math.max(1, Math.abs(end - zero)), barHeight, fill, opacity));
				// A range's span past its low end, faint: at least the bar, possibly up to its end.
				if (point.upper !== undefined && point.upper > point.value)
					parts.push(rect(end, y, scale.at(point.upper) - end, barHeight, fill, RANGE_OPACITY * opacity));
			}
			if (grouped) {
				const labelX = tracks
					? scale.at(100) + 4
					: Math.max(end, point.upper === undefined ? end : scale.at(point.upper)) + 4;
				const label = clip(point.text, 12);
				const size = step < 10 ? 9 : 10;
				const best = entry.best === at || spec.leaders?.[at] === index;
				parts.push(
					text(labelX, y + barHeight / 2, label, {
						size,
						fill: point.emphasis || best ? "fg" : "muted",
						weight: point.emphasis || best ? 600 : undefined,
					}),
				);
				if (best) parts.push(bestTag(labelX + measure(label, size) * SEMIBOLD_WIDTH + 4, y + barHeight / 2, size));
			}
		});
		if (single) {
			const point = series[0]!.points[at];
			if (!point) return;
			const end = Math.max(scale.at(point.value), point.upper === undefined ? 0 : scale.at(point.upper));
			const label = valueText(at);
			const best = series[0]!.best === at;
			const style = {
				size: TICK_SIZE,
				fill: point.emphasis || best ? "fg" : "muted",
				weight: point.emphasis || best ? 600 : undefined,
			} as const;
			if (diverging && point.value < 0)
				parts.push(text(scale.at(point.value) - 6, middle, label, { ...style, anchor: "end" }));
			else {
				// Clear the dot a log axis draws instead of a bar, and the group's reference rule.
				const x = tracks ? right + 8 : Math.max(end, zero, reference?.at[at] ?? zero) + (scale.log ? 10 : 6);
				parts.push(text(x, middle, label, style));
				if (best) parts.push(bestTag(x + measure(label, TICK_SIZE) * SEMIBOLD_WIDTH + 6, middle, TICK_SIZE));
			}
		}
	});
	if (diverging && !scale.log) parts.push(line(zero, gridTop - 2, zero, gridBottom + 2, "muted", 1));
	if (reference) parts.push(reference.body);
	for (const [at, note] of callouts) {
		const middle = tops[at]! + rowHeight / 2;
		const point = series[0]!.points[at];
		const reach = paired
			? right + 8 + measure(valueText(at), TICK_SIZE)
			: point && single && !tracks
				? Math.max(scale.at(point.value), zero, reference?.at[at] ?? zero) +
					(scale.log ? 10 : 6) +
					measure(valueText(at), TICK_SIZE)
				: right + 8 + (single ? measure(valueText(at), TICK_SIZE) : 0);
		parts.push(callout(reach + 6, middle, WIDTH - PAD - calloutWidth + 18, note));
	}
	const legend: LegendItem[] =
		single && !paired
			? []
			: paired && spec.transition
				? [
						{ name: series[0]!.name, color: "muted", ring: true },
						{ name: series[1]!.name, color: SERIES[0] },
					]
				: series.map((entry, at) => ({ name: entry.name, color: SERIES[at % SERIES.length]! }));
	const defs = paired && spec.transition ? PAIR_DEFS : "";
	return {
		height: gridBottom + 20,
		body: defs + parts.join(""),
		legend,
		notes: scale.log && !tracks ? ["log scale"] : scale.cut ? ["broken axis"] : [],
	};
}

/**
 * A value as a dot, or a range (`upper` set) as a capsule spanning it, at
 * `radius` thickness on `scale`; `hollow` outlines it instead (a transition's start).
 */
function mark(
	scale: Scale,
	point: ChartPoint,
	y: number,
	radius: number,
	fill: string,
	opacity: number,
	hollow = false,
): string {
	const from = scale.at(point.value);
	const to = point.upper === undefined ? from : scale.at(point.upper);
	if (Math.abs(to - from) < 1)
		return hollow ? ring(from, y, radius - 0.75, fill) : dot(from, y, radius, fill, opacity);
	const x = Math.min(from, to) - radius;
	const width = Math.abs(to - from) + 2 * radius;
	if (!hollow) return rect(x, y - radius, width, 2 * radius, fill, opacity, radius);
	const inset = 0.875;
	return `<rect x="${num(x + inset)}" y="${num(y - radius + inset)}" width="${num(width - 2 * inset)}" height="${num(2 * radius - 2 * inset)}" rx="${num(radius - inset)}" fill="none" stroke="${token(fill)}" stroke-width="1.75"/>`;
}

// ── Dots and intervals on a positional axis ──────────────────────────────────

/**
 * A Cleveland dot plot: one row per category, one dot per series in its color
 * on a shared axis (logarithmic once values span {@link SPAN_LOG}×), a faint
 * line from the row's smallest value to its largest, ranges as capsules. Each
 * dot's figure sits above it (else below) where it clears its neighbours; the
 * best value of a contest wears a `success` ring.
 */
function drawDots(spec: ChartSpec): Layer {
	const { categories, series } = spec;
	const references = referenceMarks(spec);
	const values = series.flatMap(entry =>
		entry.points.flatMap(point => (point ? [point.value, point.upper ?? point.value] : [])),
	);
	const left = PAD + labelColumnWidth(spec) + 10;
	// Against a baseline column the dots are its factors, figured as moves (`+4%`, `1.3× less`).
	const figureOf = (point: ChartPoint) => (spec.baseline ? factorText(point) : clip(point.text, 12));
	// Figures centre on their dots: half the widest past the plot's last tick.
	const figures = series.flatMap(entry => entry.points.map(point => (point ? figureOf(point) : "")));
	const right = WIDTH - PAD - Math.max(8, ...figures.map(figure => measure(figure, 10) / 2));
	const scale = spanScale(
		values,
		left,
		right,
		references.map(mark => mark.value),
		series[0]!.dim,
	);
	const rowHeight = categories.length <= 10 ? 36 : categories.length <= 16 ? 28 : 20;
	// Below 28 units a row has no room for figures over its dots: the axis reads them.
	const labelled = rowHeight >= 28;
	const top = references.length ? 16 : 0;
	const tops = rowTops(spec, top, rowHeight);
	const bottom = tops.at(-1)!;
	const parts: string[] = [];
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	parts.push(drawValueAxis(scale, series[0]!, top, bottom));
	parts.push(categoryLabels(spec, tops, rowHeight, strongCategories(spec)));
	parts.push(referenceLines(references, scale, left, right, top, bottom));
	const emphasized = series.some(entry => entry.points.some(point => point?.emphasis));
	const radius = rowHeight >= 28 ? 5 : 4;
	categories.forEach((_, at) => {
		// Dots sit low in a labelled row: their figures take the space above first.
		const y = tops[at]! + rowHeight / 2 + (labelled ? 2 : 0);
		const present = series.flatMap((entry, index) => {
			const point = entry.points[at];
			return point ? [{ entry, index, point }] : [];
		});
		if (present.length === 0) {
			const note = series.map(entry => entry.notes[at]).find(Boolean);
			if (note) parts.push(noteText(left + 4, y, clip(note, 24)));
			return;
		}
		const xs = present.flatMap(({ point }) => [scale.at(point.value), scale.at(point.upper ?? point.value)]);
		const [low, high] = [Math.min(...xs), Math.max(...xs)];
		if (high - low >= 1) parts.push(line(low, y, high, y, "muted", 2, 0.35));
		const best = (index: number, entry: ChartSeries) => entry.best === at || spec.leaders?.[at] === index;
		// Ranges in a row stagger a little, so one capsule never hides another lying over it.
		const stagger = present.length > 1 && present.some(({ point }) => point.upper !== undefined) ? 4 : 0;
		const spread = (stagger * (present.length - 1)) / 2;
		present.forEach(({ entry, index, point }, slot) => {
			const context = emphasized && !point.emphasis;
			const dotY = y - spread + slot * stagger;
			parts.push(mark(scale, point, dotY, radius, SERIES[index % SERIES.length]!, context ? RECEDE : 1));
			if (best(index, entry)) {
				const [from, to] = [scale.at(point.value), scale.at(point.upper ?? point.value)];
				parts.push(
					from === to
						? ring(from, dotY, radius + 3, "success")
						: mark(scale, point, dotY, radius + 3, "success", 1, true),
				);
			}
		});
		if (!labelled) return;
		// Figures: the best and bolded first, then the row's extremes, then the rest, each above its dot or below it.
		const rank = ({ entry, index, point }: (typeof present)[number]) =>
			best(index, entry) || point.emphasis ? 0 : point.value === highest || point.value === lowest ? 1 : 2;
		const highest = Math.max(...present.map(({ point }) => point.value));
		const lowest = Math.min(...present.map(({ point }) => point.value));
		const taken: { from: number; to: number; level: number }[] = [];
		for (const item of present.toSorted((a, b) => rank(a) - rank(b))) {
			const label = figureOf(item.point);
			const x = (scale.at(item.point.value) + scale.at(item.point.upper ?? item.point.value)) / 2;
			const half = measure(label, 10) / 2 + 2;
			const from = Math.max(left - 6, Math.min(x - half, WIDTH - PAD - 2 * half));
			const level = [-1, 1].find(level =>
				taken.every(box => box.level !== level || box.to <= from || box.from >= from + 2 * half),
			);
			if (level === undefined) continue;
			taken.push({ from, to: from + 2 * half, level });
			const strong = rank(item) === 0;
			const tone = spec.baseline
				? moveTone(item.entry.polarity ?? spec.categoryPolarity?.[at], item.point.value)
				: undefined;
			parts.push(
				text(from + half, y + level * (radius + 7 + spread), label, {
					size: 10,
					fill: tone ?? (strong ? "fg" : "muted"),
					weight: strong ? 600 : undefined,
					anchor: "middle",
				}),
			);
		}
	});
	return {
		height: bottom + 20,
		body: parts.join(""),
		legend: series.map((entry, at) => ({ name: entry.name, color: SERIES[at % SERIES.length]! })),
		notes: [...(spec.baseline ? ["factor"] : []), ...(scale.log ? ["log scale"] : [])],
	};
}

/**
 * Floating intervals from each value's low end to its high end (`5.7–9.6 ms`),
 * not from zero; single values draw as dots on the same row. Series of one
 * unit share a band (one thin interval each per category, a pair's midpoint
 * factor at the row's end); each other unit gets a band and axis of its own
 * (`reason tokens`, `cost`). The first series' {@link ChartSpec.estimate}
 * draws as a tick inside its interval; reference annotations as dashed rules
 * on their series' band. Axes are logarithmic once values span {@link SPAN_LOG}×.
 */
function drawRange(spec: ChartSpec): Layer {
	const { categories, series, estimate } = spec;
	const references = referenceMarks(spec);
	// Bands by unit, in order of first appearance; a series typically {@link BAND_SPREAD}× another of its
	// unit (`prefix` tokens beside `turns`) is another quantity, on a band of its own.
	const typical = (a: ChartSeries, b: ChartSeries) => {
		const ratios = categories
			.map((_, at) => {
				const [x, y] = [a.points[at], b.points[at]];
				return x && y && intervalMiddle(x) > 0 ? intervalMiddle(y) / intervalMiddle(x) : Number.NaN;
			})
			.filter(Number.isFinite)
			.sort((p, q) => p - q);
		return ratios[ratios.length >> 1] ?? 1;
	};
	const bands: number[][] = [];
	series.forEach((entry, index) => {
		const band = bands.find(members => {
			const lead = series[members[0]!]!;
			const ratio = typical(lead, entry);
			return lead.dim === entry.dim && lead.unit === entry.unit && ratio < BAND_SPREAD && ratio > 1 / BAND_SPREAD;
		});
		if (band) band.push(index);
		else bands.push([index]);
	});
	const titled = bands.length > 1;
	// The pair of a two-series band: its factor between midpoints closes each row.
	const transition = spec.transition === true;
	// A transition's start (the first series) recedes in muted; the lead color passes to its end.
	const color = (index: number) =>
		transition ? (index === 0 ? "muted" : SERIES[(index - 1) % SERIES.length]!) : SERIES[index % SERIES.length]!;
	const figure = (index: number, at: number) => {
		const own = pointText(series[index]!, at);
		const central = index === 0 && estimate?.points[at] ? estimate.points[at]!.text : "";
		return [central, own].filter(Boolean).join(" · ");
	};
	const figureWidth = Math.max(
		0,
		...series.flatMap((_, index) => categories.map((_, at) => measure(figure(index, at), TICK_SIZE))),
	);
	// A two-series band compares by a factor when it is a transition, or one quantity under two
	// conditions (`Typical | Max Size`, one-word rivals like `xutf | std`); `~Rate | Est. cost` share a
	// unit, not a quantity.
	const paired = (members: readonly number[]) => {
		if (members.length !== 2) return false;
		const [first, second] = members.map(index => series[index]!.name.trim()) as [string, string];
		return (
			(transition && members[0] === 0) || isConditionPair(first, second) || (!/\s/.test(first) && !/\s/.test(second))
		);
	};
	// A lone series beside reference rows (`Current: 2000px PNG`) reads as factors of them, as single bars do.
	const referenced = (spec.reference?.length ?? 0) > 0 && bands.some(members => members.length === 1);
	const factorWidth = bands.some(paired) || referenced ? 84 : 0;
	const left = PAD + labelColumnWidth(spec) + 10;
	const right = WIDTH - PAD - figureWidth - 8 - factorWidth;
	const strong = strongCategories(spec);
	// A bolded estimate (`**≈ $6,700**`) singles its row out as a bolded interval would.
	const bold = (index: number, at: number) =>
		Boolean(series[index]!.points[at]?.emphasis || (index === 0 && estimate?.points[at]?.emphasis));
	const emphasized = series.some((_, index) => categories.some((_, at) => bold(index, at)));
	const parts: string[] = [];
	const notes: string[] = [];
	let y = 0;
	for (const members of bands) {
		const entries = members.map(index => series[index]!);
		const marks = references.filter(mark => members.includes(mark.series ?? 0));
		const values = [
			...entries.flatMap(entry =>
				entry.points.flatMap(point => (point ? [point.value, point.upper ?? point.value] : [])),
			),
			...(members.includes(0) && estimate ? estimate.points.flatMap(point => (point ? [point.value] : [])) : []),
		];
		const scale = spanScale(
			values,
			left,
			right,
			marks.map(mark => mark.value),
			entries[0]!.dim,
		);
		if (scale.log && !notes.includes("log scale")) notes.push("log scale");
		if (titled) {
			parts.push(
				text(PAD, y + 8, clip(entries.map(entry => entry.name).join(" · "), 60), { fill: "fg", weight: 600 }),
			);
			y += TITLE_LINE + 4;
		}
		if (marks.length) y += 16;
		const { row: rowHeight, bar, step } = barMetrics(categories.length, members.length);
		const tops = rowTops(spec, y, rowHeight);
		const bottom = tops.at(-1)!;
		for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
		parts.push(drawValueAxis(scale, entries[0]!, y, bottom));
		parts.push(categoryLabels(spec, tops, rowHeight, strong));
		parts.push(referenceLines(marks, scale, left, right, y, bottom));
		// A pair's factor, first to second by midpoints (peers read it as a ratio, a transition as a move);
		// a lone series' factor of its group's reference row.
		const lone = members.length === 1 ? series[members[0]!]! : undefined;
		const base = (at: number) =>
			lone && spec.reference?.find(index => groupSpan(spec, index).join() === groupSpan(spec, at).join());
		const pair = paired(members);
		const factors = categories.map((_, at) => {
			const ref = base(at);
			const [a, b] = pair
				? members.map(index => series[index]!.points[at])
				: [ref === undefined || ref === at ? undefined : lone?.points[ref], lone?.points[at]];
			if (!a || !b || intervalMiddle(a) <= 0 || intervalMiddle(b) <= 0) return undefined;
			return intervalMiddle(b) / intervalMiddle(a);
		});
		const moves = (transition && members[0] === 0) || lone !== undefined;
		const known = factors.filter((factor): factor is number => factor !== undefined);
		const oneWay = known.length > 0 && (known.every(factor => factor >= 1) || known.every(factor => factor < 1));
		if (pair && !moves && oneWay) {
			const [a, b] = members.map(index => series[index]!.name);
			notes.push(known[0]! >= 1 ? `${b} ÷ ${a}` : `${a} ÷ ${b}`);
		}
		// The reference row's middle as a dashed rule through its group.
		for (const index of lone ? (spec.reference ?? []) : []) {
			const point = lone?.points[index];
			if (!point) continue;
			const [first, last] = groupSpan(spec, index);
			const x = scale.at(intervalMiddle(point));
			parts.push(referenceRule(x, tops[first]! + 2, x, tops[last]! + rowHeight - 2));
		}
		categories.forEach((_, at) => {
			const rowTop = tops[at]!;
			const middle = rowTop + rowHeight / 2;
			members.forEach((index, slot) => {
				const entry = series[index]!;
				const point = entry.points[at];
				const centre = members.length > 1 ? rowTop + 5 + slot * step + bar / 2 : middle;
				if (!point) {
					const note = entry.notes[at];
					if (note) parts.push(noteText(left + 4, centre, clip(note, 24)));
					return;
				}
				const context = emphasized && !bold(index, at);
				const fill = color(index);
				const opacity = context ? RECEDE : transition && index === 0 ? 0.6 : 1;
				const [from, to] = [scale.at(point.value), scale.at(point.upper ?? point.value)];
				// A single value (or an interval thinner than a dot) is a point on the row.
				if (to - from < bar) parts.push(dot((from + to) / 2, centre, Math.min(bar / 2, 6), fill, opacity));
				else parts.push(rect(from, centre - bar / 2, to - from, bar, fill, opacity));
				const central = index === 0 ? estimate?.points[at] : undefined;
				if (central) {
					const x = scale.at(central.value);
					parts.push(line(x, centre - bar / 2 - 3, x, centre + bar / 2 + 3, "fg", 2));
				}
				const end = Math.max(to, from + bar / 2) + 6;
				const own = pointText(entry, at);
				const head = central ? `${central.text} · ` : "";
				const size = members.length > 1 && step < 12 ? 10 : TICK_SIZE;
				if (head) parts.push(text(end, centre, head, { size, fill: "fg", weight: 600 }));
				parts.push(
					text(end + (head ? measure(head, size) * SEMIBOLD_WIDTH : 0), centre, own, {
						size,
						fill: point.emphasis ? "fg" : "muted",
						weight: point.emphasis ? 600 : undefined,
					}),
				);
			});
			const factor = factors[at];
			if (factor === undefined) return;
			const polarity = series[members[1] ?? members[0]!]!.polarity ?? series[members[0]!]!.polarity;
			const tone = moves ? moveTone(polarity, factor) : undefined;
			const said = moves
				? factorText({ value: factor, text: "", emphasis: false })
				: `${compactFactor(factor >= 1 ? factor : 1 / factor)}×`;
			// Peers leading by turns: a dot in the larger one's color before its factor.
			if (!moves && !oneWay)
				parts.push(
					dot(
						WIDTH - PAD - measure(said, TICK_SIZE) * SEMIBOLD_WIDTH - 8,
						middle,
						3.5,
						color(members[factor >= 1 ? 1 : 0]!),
					),
				);
			parts.push(
				text(WIDTH - PAD, middle, clip(said, 14), {
					size: TICK_SIZE,
					fill: tone ?? "fg",
					weight: 600,
					anchor: "end",
				}),
			);
		});
		y = bottom + 20 + (titled ? 12 : 0);
	}
	// Colors need a key once several series share a band, or an estimate tick stands beside the intervals.
	const legend: LegendItem[] =
		(series.length < 2 && !estimate) || (titled && bands.every(members => members.length === 1))
			? []
			: series.map((entry, index) => ({ name: entry.name, color: color(index) }));
	if (estimate) legend.unshift({ name: estimate.name, color: "fg" });
	return { height: y - (titled ? 12 : 0), body: parts.join(""), legend, notes };
}

/** The reference annotations of `spec` (a stated budget, price or 1×). */
function referenceMarks(spec: ChartSpec): Extract<ChartAnnotation, { kind: "reference" }>[] {
	return (spec.annotations ?? []).filter(
		(mark): mark is Extract<ChartAnnotation, { kind: "reference" }> => mark.kind === "reference",
	);
}

/** Dashed {@link referenceRule}s at `marks` across `top`…`bottom`, each labelled above the plot. */
function referenceLines(
	marks: readonly Extract<ChartAnnotation, { kind: "reference" }>[],
	scale: Scale,
	left: number,
	right: number,
	top: number,
	bottom: number,
): string {
	const parts: string[] = [];
	for (const mark of marks) {
		const x = scale.at(mark.value);
		if (x < left - 0.5 || x > right + 0.5) continue;
		parts.push(referenceRule(x, top - 2, x, bottom));
		const label = clip(mark.label, MAX_CALLOUT_CHARS);
		const half = measure(label, 10) / 2;
		parts.push(
			text(Math.min(Math.max(x, left + half), right - half), top - 9, label, {
				size: 10,
				fill: "fg",
				anchor: "middle",
			}),
		);
	}
	return parts.join("");
}

// ── Stacked parts of a whole ─────────────────────────────────────────────────

/**
 * Each category's parts as touching segments of one bar, in series order and
 * colors, its whole (else the parts' sum) written past its end. A whole the
 * parts fall short of draws the rest as a faint track. Groups whose bars
 * differ {@link SPLIT_SPREAD}× or more in size split into bands, each on its
 * own axis, so one model sixty times the others does not flatten them to
 * slivers; ungrouped rows share one axis. A {@link ChartSpec.normalized} chart
 * draws each bar as its category's mix on one 0–100% axis, segments wide
 * enough printing their percent; outcome parts take their status colors
 * ({@link ChartSpec.tones}).
 */
function drawStacked(spec: ChartSpec): Layer {
	const { categories, series, whole, normalized } = spec;
	const colors = series.map((_, at) => partColor(spec, at));
	const shades = series.map((_, at) => partOpacity(spec, at));
	const sums = categories.map((_, at) => series.reduce((sum, entry) => sum + (entry.points[at]?.value ?? 0), 0));
	// A whole the parts reach within rounding (`48.2k` of `48.3k`) leaves no rest worth a track.
	const ends = sums.map((sum, at) => {
		const total = whole?.points[at]?.value ?? 0;
		return total > sum * (1 + MIN_REST) ? total : sum;
	});
	const totals = sums.map(
		(sum, at) => (whole && pointText(whole, at)) || formatValue(sum, series[0]!.dim, series[0]!.unit),
	);
	const rested = ends.some((end, at) => end > sums[at]!);
	const left = PAD + labelColumnWidth(spec) + 10;
	const right = WIDTH - PAD - Math.min(120, Math.max(...totals.map(label => measure(label, TICK_SIZE)))) - 8;
	const { row: rowHeight, bar: barHeight } = barMetrics(categories.length, 1);
	const strong = strongCategories(spec);
	const emphasized = series.some(entry => entry.points.some(point => point?.emphasis));
	const bands = stackBands(spec, normalized ? ends.map(end => (end > 0 ? 100 : 0)) : ends);
	const parts: string[] = [];
	let top = 0;
	for (const stack of bands) {
		const [first, last] = stack.rows;
		const view: ChartSpec = {
			...spec,
			categories: categories.slice(first, last),
			groups: spec.groups?.slice(stack.groups[0], stack.groups[1]),
		};
		const tops = rowTops(view, top, rowHeight);
		const bottom = tops.at(-1)!;
		const scale = valueScale(normalized ? [0, 100] : [0, ...ends.slice(first, last)], left, right, { zero: true });
		// Category indices into this band's rows.
		const local = (set: Iterable<number>) =>
			new Set([...set].flatMap(at => (at >= first && at < last ? [at - first] : [])));
		for (const at of local(highlighted(spec))) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
		parts.push(
			drawValueAxis(scale, normalized ? { ...series[0]!, dim: "percent", unit: "" } : series[0]!, top, bottom),
		);
		parts.push(categoryLabels(view, tops, rowHeight, local(strong)));
		for (let at = first; at < last; at++) {
			const y = tops[at - first]! + (rowHeight - barHeight) / 2;
			const end = ends[at]!;
			// A mix places each part at its percent of the row's total.
			const place = (value: number) => scale.at(normalized ? (100 * value) / end : value);
			// A row holding none of the parts (cells in another unit, status words) draws nothing but its note.
			if (end === 0) {
				const note = series.map(entry => entry.notes[at]).find(Boolean);
				if (note) parts.push(noteText(left + 4, y + barHeight / 2, clip(note, 24)));
				continue;
			}
			let sum = 0;
			series.forEach((entry, index) => {
				const point = entry.points[at];
				if (!point || point.value <= 0) return;
				const from = place(sum);
				sum += point.value;
				// Segments part with a sliver of the surface behind them.
				const width = Math.max(1, place(sum) - from - 1.5);
				const opacity = (emphasized && !point.emphasis ? RECEDE : 1) * shades[index]!;
				parts.push(rect(from, y, width, barHeight, colors[index]!, opacity));
				// A mix prints each part's percent inside it, in ink to read on the solid color (plain text
				// on a faint one); a part filling the whole bar says so by its length alone.
				const share = percentText((100 * point.value) / end);
				const style = { size: TICK_SIZE, fill: "fg", anchor: "middle", weight: 600 } as const;
				if (normalized && point.value < end && measure(share, TICK_SIZE) * SEMIBOLD_WIDTH + 10 <= width)
					parts.push((opacity >= INK_LEVEL ? ink : text)(from + width / 2, y + barHeight / 2, share, style));
			});
			if (end > sums[at]!) parts.push(rect(place(sum), y, place(end) - place(sum), barHeight, "border", 0.5));
			const bold = whole?.points[at]?.emphasis;
			parts.push(
				text(place(end) + 6, y + barHeight / 2, totals[at]!, {
					size: TICK_SIZE,
					fill: bold ? "fg" : "muted",
					weight: bold ? 600 : undefined,
				}),
			);
		}
		top = bottom + 26;
	}
	const legend: LegendItem[] = series.map((entry, at) => ({
		name: entry.name,
		color: colors[at]!,
		opacity: shades[at],
	}));
	if (rested && whole) legend.push({ name: `rest of ${whole.name}`, color: "border" });
	return {
		height: top - 6,
		body: parts.join(""),
		legend,
		notes: normalized ? ["% of row total"] : bands.length > 1 ? ["groups on own scales"] : [],
	};
}

/**
 * Fill of part `at` of a whole: its outcome's status color where the parts
 * are toned ({@link ChartSpec.tones}), `muted` for a part among them naming
 * no outcome (series hues follow the theme accent, so any could pass for a
 * status), else its series color.
 */
function partColor(spec: ChartSpec, at: number): string {
	const { tones } = spec;
	if (!tones) return SERIES[at % SERIES.length]!;
	const tone = tones[at];
	return tone ? STATUS_COLORS[tone] : "muted";
}

/** Opacity step of each further part sharing one outcome color (`fail`, then `error`), so they stay apart. */
const TONE_STEP = 0.4;

/** Opacity of part `at` of a toned whole: full for the first of its color, a {@link TONE_STEP} fainter for each later one. */
function partOpacity(spec: ChartSpec, at: number): number {
	const { tones } = spec;
	if (!tones) return 1;
	const repeats = tones.slice(0, at).filter(tone => tone === tones[at]).length;
	return Math.max(1 - TONE_STEP * repeats, 0.35);
}

/** A run of categories on one axis: its rows and the groups covering them, each as a `[from, to)` index range. */
interface StackBand {
	readonly rows: readonly [number, number];
	readonly groups: readonly [number, number];
}

/**
 * Consecutive groups gathered while their bar ends stay within
 * {@link SPLIT_SPREAD}× of each other; more than three bands (sizes
 * alternating group by group) fall back to one shared axis, as do ungrouped
 * rows, whose bands would part rows the reader expects side by side.
 */
function stackBands(spec: ChartSpec, ends: readonly number[]): StackBand[] {
	const runs = spec.groups?.map(group => group.members.length) ?? [ends.length];
	const bands: { rows: [number, number]; groups: [number, number]; low: number; high: number }[] = [];
	let row = 0;
	runs.forEach((size, index) => {
		const peak = Math.max(...ends.slice(row, row + size));
		const last = bands.at(-1);
		const low = Math.min(last?.low ?? peak, peak);
		const high = Math.max(last?.high ?? peak, peak);
		// A group holding no parts (only notes) rides along with the band before it.
		if (last && (peak === 0 || high <= low * SPLIT_SPREAD)) {
			last.rows[1] = row + size;
			last.groups[1] = index + 1;
			if (peak > 0) {
				last.low = low;
				last.high = high;
			}
		} else {
			bands.push({ rows: [row, row + size], groups: [index, index + 1], low: peak, high: peak });
		}
		row += size;
	});
	if (bands.length > 3) return [{ rows: [0, ends.length], groups: [0, runs.length] }];
	return bands;
}

/**
 * The gradients a transition's connector fades along, from the muted start to
 * the lead series color; ids name their direction, the same in every chart.
 */
const PAIR_DEFS = [
	"<defs>",
	`<linearGradient id="pair-up" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--muted)" stop-opacity="0.35"/><stop offset="1" stop-color="var(--c1)" stop-opacity="0.85"/></linearGradient>`,
	`<linearGradient id="pair-down" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="var(--muted)" stop-opacity="0.35"/><stop offset="1" stop-color="var(--c1)" stop-opacity="0.85"/></linearGradient>`,
	"</defs>",
].join("");

/** Categories a planner highlighted ({@link ChartSpec.annotations}), in range. */
function highlighted(spec: ChartSpec): number[] {
	return (spec.annotations ?? []).flatMap(mark =>
		mark.kind === "highlight" && mark.category >= 0 && mark.category < spec.categories.length ? [mark.category] : [],
	);
}

/**
 * Categories whose labels set semibold: highlighted ones, and rows the table
 * bolded a figure in — unless it bolded every row, which singles none out.
 */
function strongCategories(spec: ChartSpec): Set<number> {
	const bold = spec.categories.flatMap((_, at) => (spec.series.some(entry => entry.points[at]?.emphasis) ? [at] : []));
	return new Set([...highlighted(spec), ...(bold.length * 2 <= spec.categories.length ? bold : [])]);
}

/** Callout text per category from {@link ChartSpec.annotations} (the first per category wins). */
function calloutTexts(spec: ChartSpec): Map<number, string> {
	const texts = new Map<number, string>();
	for (const mark of spec.annotations ?? [])
		if (
			mark.kind === "callout" &&
			mark.category >= 0 &&
			mark.category < spec.categories.length &&
			!texts.has(mark.category)
		)
			texts.set(mark.category, clip(mark.text, MAX_CALLOUT_CHARS));
	return texts;
}

// ── Runs of steps: waterfall and timeline ────────────────────────────────────

/**
 * Each step a floating bar from the running sum before it to the one after
 * it, a hairline carrying each end down to the next step, and the total the
 * steps reach ({@link ChartSpec.total}) as a full bar under them. A cap (a
 * `reference` annotation) draws as a dashed rule, the total's figure saying
 * what it leaves to spare or runs over by. Steps take the lead color; a
 * falling step takes the tone a drop has for its measure (else the second
 * series color). A run of rising steps prints each one's share of the total.
 */
function drawWaterfall(spec: ChartSpec): Layer {
	const entry = spec.series[0]!;
	const { categories } = spec;
	const steps = categories.map((_, at) => entry.points[at]?.value ?? 0);
	let run = 0;
	const ends = steps.map(value => (run += value));
	const starts = ends.map((end, at) => end - steps[at]!);
	const total = spec.total ?? {
		name: "Total",
		point: { value: ends.at(-1) ?? 0, text: "", emphasis: false },
	};
	const references = (spec.annotations ?? []).filter(
		(mark): mark is Extract<ChartAnnotation, { kind: "reference" }> => mark.kind === "reference",
	);
	const cap = references[0];
	const format = (value: number) => formatValue(value, entry.dim, entry.unit);
	const totalText = total.point.text || format(total.point.value);
	const spare = cap ? cap.value - total.point.value : 0;
	const spareText = cap ? `${format(Math.abs(spare))} ${spare >= 0 ? "to spare" : "over"}` : "";
	// Shares of a sum only read when every step adds to it.
	const rising = steps.every(value => value >= 0) && total.point.value > 0;
	const share = (at: number) => {
		if (!rising) return "";
		const percent = (100 * steps[at]!) / total.point.value;
		return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
	};
	const view: ChartSpec = {
		...spec,
		categories: [...categories, total.name],
		groups: spec.groups && [...spec.groups, { name: "", members: [total.name] }],
		status: spec.status && [...spec.status, undefined],
	};
	const figureWidth = (at: number) => {
		const shared = share(at);
		return measure(pointText(entry, at), TICK_SIZE) + (shared ? measure(` · ${shared}`, TICK_SIZE) : 0);
	};
	const valueWidth = Math.min(
		200,
		Math.max(
			...categories.map((_, at) => figureWidth(at)),
			measure(totalText, TICK_SIZE) * SEMIBOLD_WIDTH + (spareText ? measure(` · ${spareText}`, TICK_SIZE) : 0),
		) + 8,
	);
	const left = PAD + labelColumnWidth(view) + 10;
	const right = WIDTH - PAD - valueWidth;
	const scale = valueScale(
		[0, ...starts, ...ends, total.point.value, ...references.map(mark => mark.value)],
		left,
		right,
		{ zero: true },
	);
	const count = categories.length + 1;
	const { row: rowHeight, bar: barHeight } = barMetrics(count, 1);
	const top = references.length ? 16 : 0;
	const tops = rowTops(view, top, rowHeight);
	const bottom = tops.at(-1)!;
	const barTop = (at: number) => tops[at]! + (rowHeight - barHeight) / 2;
	const strong = strongCategories(spec);
	strong.add(categories.length);
	const parts: string[] = [];
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	parts.push(drawValueAxis(scale, entry, top, bottom));
	parts.push(categoryLabels(view, tops, rowHeight, strong));
	for (const mark of references) {
		const x = scale.at(mark.value);
		parts.push(referenceRule(x, top - 2, x, bottom));
		const label = clip(mark.label, MAX_CALLOUT_CHARS);
		const half = measure(label, 10) / 2;
		parts.push(
			text(Math.min(Math.max(x, left + half), WIDTH - PAD - half), top - 9, label, {
				size: 10,
				fill: "fg",
				anchor: "middle",
			}),
		);
	}
	const emphasized = entry.points.some(point => point?.emphasis);
	const fall = moveTone(entry.polarity, 0.5) ?? SERIES[1];
	categories.forEach((_, at) => {
		const point = entry.points[at];
		const y = barTop(at);
		const [from, to] = [scale.at(Math.min(starts[at]!, ends[at]!)), scale.at(Math.max(starts[at]!, ends[at]!))];
		const context = emphasized && !point?.emphasis;
		parts.push(
			rect(
				from,
				y,
				Math.max(1, to - from),
				barHeight,
				context ? "muted" : steps[at]! < 0 ? fall : SERIES[0],
				context ? 0.55 : 1,
			),
		);
		// The running sum carries down to where the next step (or the total) starts.
		const x = scale.at(ends[at]!);
		parts.push(connector(x, y + barHeight, barTop(at + 1)));
		const figure = pointText(entry, at);
		const style = {
			size: TICK_SIZE,
			fill: point?.emphasis ? "fg" : "muted",
			weight: point?.emphasis ? 600 : undefined,
		};
		parts.push(text(to + 6, y + barHeight / 2, figure, style));
		const shared = share(at);
		if (shared)
			parts.push(
				text(
					to + 6 + measure(figure, TICK_SIZE) * (point?.emphasis ? SEMIBOLD_WIDTH : 1) + 4,
					y + barHeight / 2,
					`· ${shared}`,
					{ size: TICK_SIZE, fill: "muted" },
				),
			);
	});
	const y = barTop(categories.length);
	const zero = scale.at(0);
	const end = scale.at(total.point.value);
	parts.push(rect(Math.min(zero, end), y, Math.max(1, Math.abs(end - zero)), barHeight, "muted", 1));
	parts.push(
		text(Math.max(zero, end) + 6, y + barHeight / 2, totalText, { size: TICK_SIZE, fill: "fg", weight: 600 }),
	);
	if (spareText)
		parts.push(
			text(
				Math.max(zero, end) + 6 + measure(totalText, TICK_SIZE) * SEMIBOLD_WIDTH + 4,
				y + barHeight / 2,
				`· ${spareText}`,
				{ size: TICK_SIZE, fill: spare >= 0 ? "muted" : "error", weight: spare >= 0 ? undefined : 600 },
			),
		);
	return { height: bottom + 20, body: parts.join("") };
}

/** A dotted hairline down from a waterfall step's end at `x`, from `y1` to `y2`. */
function connector(x: number, y1: number, y2: number): string {
	if (y2 <= y1) return "";
	return `<line x1="${num(x)}" y1="${num(y1)}" x2="${num(x)}" y2="${num(y2)}" stroke="${token("muted")}" stroke-width="1" stroke-dasharray="2 2" stroke-opacity="0.8"/>`;
}

/** Height of a timeline's strip. */
const STRIP = 30;
/** Most label lanes under a timeline's strip. */
const MAX_LANES = 4;
/** Height of one label lane under a timeline's strip. */
const LANE = 16;
/** Share of a timeline's run from which a segment (or group) leads in the accent color, unless the table bolded some. */
const LEADING_SEGMENT = 0.15;
/** Most segments (or groups) a timeline leads with. */
const MAX_LEADING = 3;
/** Share of a timeline's run from which a stretch's label claims a lane before the smaller ones. */
const LABEL_FIRST = 0.05;

/** A labelled stretch of a timeline: one row, or a group of consecutive rows sharing a name. */
interface Stretch {
	readonly first: number;
	readonly last: number;
	readonly name: string;
	readonly value: number;
	readonly figure: string;
	readonly group: boolean;
}

/**
 * Rows laid end to end on one axis — each at its start ({@link ChartSpec.x})
 * or after the one before — as touching segments of one strip, to scale, with
 * the run's end figure after it and the axis over it. The few stretches
 * (rows, or groups of rows sharing a name) making up most of the run, or
 * those the table bolded, lead in the accent color with their share; the rest
 * recede in alternating grays. A stretch is named inside its segment where
 * the name fits, else in a lane under the strip on a leader (groups on a
 * bracket spanning their rows); members of a group are named inside their
 * segments where they fit.
 */
function drawTimeline(spec: ChartSpec): Layer {
	const entry = spec.series[0]!;
	const { categories } = spec;
	const sizes = categories.map((_, at) => Math.max(0, entry.points[at]?.value ?? 0));
	let run = 0;
	const starts =
		spec.x?.values ??
		sizes.map(size => {
			run += size;
			return run - size;
		});
	const ends = starts.map((start, at) => start + sizes[at]!);
	const from = Math.min(0, ...starts);
	const to = Math.max(...ends);
	const span = to - from || 1;
	const duration = entry.dim === "duration";
	const format = (value: number) => (duration ? clockText(value) : formatValue(value, entry.dim, entry.unit));
	// Parts at their offsets end where the last one does; a run of steps at its total.
	const endText = spec.x ? format(to) : spec.total?.point.text || format(spec.total?.point.value ?? to);
	const left = PAD;
	const right = WIDTH - PAD - measure(endText, TICK_SIZE) * SEMIBOLD_WIDTH - 8;
	const at = (value: number) => left + ((value - from) / span) * (right - left);

	// Stretches: named groups as one, loose rows on their own.
	const stretches: Stretch[] = [];
	let row = 0;
	for (const group of spec.groups ?? [{ name: "", members: categories }]) {
		const first = row;
		row += group.members.length;
		if (group.name && group.members.length > 1) {
			const value = sizes.slice(first, row).reduce((sum, size) => sum + size, 0);
			stretches.push({ first, last: row - 1, name: group.name, value, figure: format(value), group: true });
		} else
			for (let index = first; index < row; index++)
				stretches.push({
					first: index,
					last: index,
					name: categories[index]!,
					value: sizes[index]!,
					figure: pointText(entry, index),
					group: false,
				});
	}
	const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
	const share = (stretch: Stretch) => {
		const percent = (100 * stretch.value) / total;
		return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
	};
	const strong = strongCategories(spec);
	const marked = stretches.filter(stretch =>
		[...strong].some(index => index >= stretch.first && index <= stretch.last),
	);
	const leading = new Set(
		marked.length
			? marked
			: [...stretches]
					.sort((a, b) => b.value - a.value)
					.slice(0, MAX_LEADING)
					.filter(stretch => stretch.value / total >= LEADING_SEGMENT),
	);

	const parts: string[] = [];
	const stripTop = 18;
	const stripBottom = stripTop + STRIP;
	const middle = stripTop + STRIP / 2;
	// Axis over the strip: tick labels and short ticks, the strip itself the baseline.
	const unit = duration ? (to >= 7200 ? 3600 : to >= 120 ? 60 : 1) : 1;
	const step = niceStep(span / unit / 5) * unit;
	for (let tick = Math.ceil(from / step) * step; tick <= to + 1e-9; tick += step) {
		const x = at(tick);
		const label = formatValue(Number(tick.toPrecision(12)), entry.dim, entry.unit, to);
		parts.push(rule(x, 12, x, stripTop - 2));
		// The first tick sits at the margin: its label starts there rather than hanging off the canvas.
		const edge = x - measure(label, TICK_SIZE) / 2 < 2;
		parts.push(
			text(edge ? x - 1 : x, 5, label, { size: TICK_SIZE, fill: "muted", anchor: edge ? "start" : "middle" }),
		);
	}
	// Segments: leading stretches in the lead color, the rest alternating grays — or, where none leads (an
	// even run), every stretch in alternating strengths of the lead color; a sliver parts neighbours.
	const even = leading.size === 0;
	const fill = (stretch: Stretch): [color: string, opacity: number] => {
		const odd = stretches.indexOf(stretch) % 2 === 1;
		if (leading.has(stretch)) return [SERIES[0], 1];
		return even ? [SERIES[0], odd ? 0.7 : 1] : ["muted", odd ? 0.3 : 0.5];
	};
	for (const stretch of stretches) {
		for (let member = stretch.first; member <= stretch.last; member++) {
			const x0 = at(starts[member]!);
			const width = Math.max(1, at(ends[member]!) - x0 - (sizes[member]! > 0 ? 1 : 0));
			parts.push(rect(x0, stripTop, width, STRIP, ...fill(stretch), 2));
		}
	}
	parts.push(text(at(to) + 8, middle, endText, { size: TICK_SIZE, fill: "fg", weight: 600 }));

	// Names inside their segments where they fit (with the figure and share, or less); the rest go to lanes.
	const fit = (x0: number, x1: number, options: readonly string[], lead: boolean, size: number) =>
		options.find(option => measure(option, size) * (lead ? SEMIBOLD_WIDTH : 1) <= x1 - x0 - 10);
	const inside = (x0: number, content: string, lead: boolean, size: number) => {
		const style = { size, fill: "fg", weight: lead ? 600 : undefined } as const;
		parts.push(lead || even ? ink(x0 + 5, middle, content, style) : text(x0 + 5, middle, content, style));
	};
	const pending: Stretch[] = [];
	for (const stretch of stretches) {
		const lead = leading.has(stretch);
		const [x0, x1] = [at(starts[stretch.first]!), at(ends[stretch.last]!)];
		const named = `${stretch.name} ${stretch.figure}`;
		const options = lead ? [`${named} · ${share(stretch)}`, named, stretch.name] : [named, stretch.name];
		const size = lead ? TICK_SIZE + 1 : TICK_SIZE;
		if (stretch.group) {
			const members: [number, string][] = [];
			for (let member = stretch.first; member <= stretch.last; member++) {
				const name = fit(at(starts[member]!), at(ends[member]!), [memberName(spec, member)], lead, 10);
				if (name) members.push([member, name]);
			}
			// A group naming at most one member inside is better named itself, where its name fits.
			const own = members.length <= 1 ? fit(x0, x1, options, lead, size) : undefined;
			if (own) {
				// The slivers between its members close behind the group's name.
				for (let member = stretch.first; member < stretch.last; member++)
					parts.push(rect(at(ends[member]!) - 1, middle - 8, 1, 16, ...fill(stretch), 0));
				inside(x0, own, lead, size);
			} else {
				for (const [member, name] of members) inside(at(starts[member]!), name, lead, 10);
				pending.push(stretch);
			}
			continue;
		}
		const own = fit(x0, x1, options, lead, size);
		if (own) inside(x0, own, lead, size);
		else pending.push(stretch);
	}

	// Groups span a bracket under their rows, whether or not their name finds a lane.
	for (const stretch of stretches.filter(stretch => stretch.group)) {
		const [x0, x1] = [at(starts[stretch.first]!), at(ends[stretch.last]!)];
		parts.push(
			line(x0 + 1, stripBottom + 4, x1 - 1, stripBottom + 4, leading.has(stretch) ? SERIES[0] : "muted", 1.5),
		);
	}
	const labels = placeLanes(
		pending.map(stretch => {
			const lead = leading.has(stretch);
			const [x0, x1] = [at(starts[stretch.first]!), at(ends[stretch.last]!)];
			return {
				leader: stretch.group ? (x0 + x1) / 2 : Math.max(x0 + 1, Math.min((x0 + x1) / 2, x0 + 6)),
				lead,
				value: stretch.value,
				group: stretch.group,
				variants: [
					[stretch.name, lead ? `${stretch.figure} · ${share(stretch)}` : stretch.figure],
					[stretch.name, ""],
					[clip(stretch.name, 12), ""],
				],
			};
		}),
		total,
	);
	let lanes = 0;
	for (const { item, lane, x0, name, figure } of labels) {
		lanes = Math.max(lanes, lane + 1);
		const y = stripBottom + LANE * (lane + 1);
		parts.push(line(item.leader, stripBottom + (item.group ? 5 : 1), item.leader, y - 6, "muted", 1, 0.7));
		parts.push(text(x0, y, name, { size: TICK_SIZE, fill: "fg", weight: item.lead ? 600 : undefined }));
		if (figure)
			parts.push(
				text(x0 + measure(name, TICK_SIZE) * (item.lead ? SEMIBOLD_WIDTH : 1) + 6, y, figure, {
					size: TICK_SIZE,
					fill: "muted",
				}),
			);
	}
	const notes = spec.x ? [`at ${spec.x.name}`] : ["end to end, in table order"];
	return { height: stripBottom + LANE * lanes + (lanes ? 8 : 4), body: parts.join(""), notes };
}

/** A label waiting for a lane under a timeline: where its leader drops, and its texts from fullest to shortest. */
interface LaneItem {
	readonly leader: number;
	readonly lead: boolean;
	readonly value: number;
	readonly group: boolean;
	readonly variants: readonly (readonly [name: string, figure: string])[];
}

/** A {@link LaneItem} placed: its lane, its box, and the text variant that fit. */
interface LaneLabel {
	readonly item: LaneItem;
	readonly lane: number;
	readonly x0: number;
	readonly x1: number;
	readonly name: string;
	readonly figure: string;
}

/**
 * Lanes for `items` of a run of `total`: each, in turn, in the shallowest of {@link MAX_LANES}
 * lanes where its box (reaching right of its leader, else left) overlaps no
 * label and its leader crosses no label above, nor its box a leader below —
 * with its fullest text that fits. Placement is greedy, so several orders are
 * tried (right to left, which stacks a dense run like stairs; leading and
 * {@link LABEL_FIRST}-sized ones first; left to right; largest first) and the
 * one naming the most items, then the most of the run, wins.
 */
function placeLanes(items: readonly LaneItem[], total: number): LaneLabel[] {
	const first = new Set(items.filter(item => item.lead || item.value / total >= LABEL_FIRST));
	const orders = [
		[...items].sort((a, b) => b.leader - a.leader),
		[...items].sort((a, b) => Number(first.has(b)) - Number(first.has(a)) || b.leader - a.leader),
		[...items].sort((a, b) => a.leader - b.leader),
		[...items].sort((a, b) => b.value - a.value),
	];
	let best: LaneLabel[] = [];
	let bestScore = [-1, -1, -1];
	// Each order with full labels or the small items named without their figure, and with labels on the
	// right half reaching right of their leader first or left of it first.
	const attempts = orders.flatMap(order =>
		[false, true].flatMap(terse => [false, true].map(inward => ({ order, terse, inward }))),
	);
	for (const { order, terse, inward } of attempts) {
		const placed: LaneLabel[] = [];
		for (const item of order) {
			const variants = terse && !first.has(item) ? item.variants.filter(([, figure]) => !figure) : item.variants;
			for (const [name, figure] of variants) {
				const width =
					measure(name, TICK_SIZE) * (item.lead ? SEMIBOLD_WIDTH : 1) +
					(figure ? 6 + measure(figure, TICK_SIZE) : 0);
				// Right of the leader (from the margin at the left edge), else left of it.
				const anchors = [Math.max(PAD, item.leader - 2), item.leader + 2 - width].filter(
					start => start >= PAD && start + width <= WIDTH - PAD,
				);
				if (inward && item.leader > WIDTH / 2) anchors.reverse();
				let label: LaneLabel | undefined;
				for (let lane = 0; lane < MAX_LANES && !label; lane++) {
					const x0 = anchors.find(start =>
						placed.every(other =>
							other.lane === lane
								? start + width + 8 < other.x0 || start - 8 > other.x1
								: other.lane < lane
									? item.leader < other.x0 - 3 || item.leader > other.x1 + 3
									: other.item.leader < start - 3 || other.item.leader > start + width + 3,
						),
					);
					if (x0 !== undefined) label = { item, lane, x0, x1: x0 + width, name, figure };
				}
				if (label) {
					placed.push(label);
					break;
				}
			}
		}
		const score = [
			placed.length,
			placed.reduce((sum, label) => sum + label.item.value, 0),
			placed.filter(label => label.figure).length,
		];
		const at = score.findIndex((value, index) => value !== bestScore[index]);
		if (at >= 0 && score[at]! > bestScore[at]!) {
			best = placed;
			bestScore = score;
		}
	}
	return best;
}

/** A grouped category's own name: its member name, or the group's where the group alone names it. */
function memberName(spec: ChartSpec, at: number): string {
	let first = 0;
	for (const group of spec.groups ?? []) {
		if (at < first + group.members.length) return group.members[at - first] || group.name;
		first += group.members.length;
	}
	return spec.categories[at] ?? "";
}

/** A duration as people say it: `48s`, `6m 36s`, `2h 5m`. */
function clockText(seconds: number): string {
	if (seconds < 120) return formatValue(seconds, "duration", "");
	const whole = Math.round(seconds);
	const [hours, minutes, rest] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
	if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
	return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

// ── Grids: heatmap and small multiples ──────────────────────────────────────

/**
 * A matrix of rows by series. `heat`: tinted cells on one sequential ramp of
 * the lead color (each column on its own ramp, in its own color, when shaded
 * per series), faint for the least and opaque for the most; strong cells
 * print their figure in {@link ink}, zeros recede to muted. `bars`: one
 * column of bars per series, each scaled on its own.
 */
function drawGrid(spec: ChartSpec, style: "heat" | "bars"): Layer {
	const { series } = spec;
	const heat = style === "heat";
	const labelWidth = labelColumnWidth(spec);
	const left = PAD + labelWidth + 10;
	const cellWidth = (WIDTH - PAD - left) / series.length;
	const count = spec.categories.length;
	const rowHeight = heat ? (count <= 8 ? 26 : count <= 16 ? 22 : 20) : count <= 8 ? 24 : 20;
	const headerChars = Math.max(4, Math.floor((cellWidth - 6) / (TICK_SIZE * ADVANCE)));
	const perSeries = spec.shading === "series";
	const parts: string[] = [];
	const headers = series.map(entry => wrapHeader(entry.name, headerChars));
	const headerLines = Math.max(...headers.map(lines => lines.length));
	series.forEach((entry, index) => {
		const x = left + index * cellWidth;
		headers[index]!.forEach((content, line) => {
			// A one-line header sits on the line nearest the cells.
			const y = 6 + (headerLines - headers[index]!.length + line) * 13;
			parts.push(
				heat
					? text(x + cellWidth / 2, y, content, {
							size: TICK_SIZE,
							fill: perSeries ? SERIES[index % SERIES.length]! : "muted",
							anchor: "middle",
							weight: perSeries ? 600 : undefined,
						})
					: text(x + 2, y, content, { size: TICK_SIZE, fill: "fg", weight: 600 }),
			);
		});
	});
	const top = 18 + (headerLines - 1) * 13;
	const tops = rowTops(spec, top, rowHeight);
	const bottom = tops.at(-1)!;
	// Heatmaps share one scale unless shaded per series or per row; small multiples scale each series on its own.
	const all = series.flatMap(entry => entry.points.flatMap(point => (point ? [point.value] : [])));
	const shared = shade(all);
	const perRow = heat && spec.shading === "row";
	const byRow = spec.categories.map((_, row) =>
		shade(series.flatMap(entry => (entry.points[row] ? [entry.points[row]!.value] : []))),
	);
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	parts.push(categoryLabels(spec, tops, rowHeight, strongCategories(spec)));
	series.forEach((entry, index) => {
		const x = left + index * cellWidth;
		const values = entry.points.flatMap(point => (point ? [point.value] : []));
		const own = shade(values);
		const textWidth = Math.max(0, ...entry.points.map(point => measure(point?.text ?? "", TICK_SIZE)));
		const leads = entry.best !== undefined || spec.leaders?.includes(index);
		const barSpace = Math.max(0, cellWidth - textWidth - 14 - (leads ? BEST_WIDTH : 0));
		const bars = panelScale(values, x + 2, x + 2 + barSpace);
		const reference = heat ? undefined : referenceRules(spec, entry, tops, rowHeight, bars.at);
		const emphasized = entry.points.some(point => point?.emphasis);
		const color = heat && !perSeries ? SERIES[0] : SERIES[index % SERIES.length]!;
		entry.points.forEach((point, row) => {
			const y = tops[row]!;
			const middle = y + rowHeight / 2;
			if (!point) {
				const note = entry.notes[row];
				if (note) parts.push(noteText(heat ? x + cellWidth / 2 : x + 4, middle, clip(note, headerChars), heat));
				return;
			}
			const best = entry.best === row || spec.leaders?.[row] === index;
			if (heat) {
				const level = perSeries ? own(point.value) : perRow ? byRow[row]!(point.value) : shared(point.value);
				parts.push(
					rect(x + 1.5, y + 1.5, cellWidth - 3, rowHeight - 3, color, HEAT_FLOOR + (1 - HEAT_FLOOR) * level, 4),
				);
				// The best cell of a column is outlined in the success color.
				if (best) parts.push(outline(x + 1.5, y + 1.5, cellWidth - 3, rowHeight - 3, "success"));
				const style = {
					size: TICK_SIZE,
					fill: point.value === 0 ? "muted" : "fg",
					anchor: "middle",
					weight: point.emphasis || best || level >= INK_LEVEL ? 600 : undefined,
				} as const;
				const label = clip(point.text, headerChars);
				parts.push(
					level >= INK_LEVEL
						? ink(x + cellWidth / 2, middle, label, style)
						: text(x + cellWidth / 2, middle, label, style),
				);
				return;
			}
			const end = Math.max(x + 3, bars.at(point.value));
			const bar = Math.min(14, rowHeight - 10);
			const opacity = emphasized && !point.emphasis ? RECEDE : 1;
			parts.push(
				bars.cut && point.value > bars.cut.below
					? cutBar(bars.cut, x + 2, end, middle - bar / 2, bar, color, opacity)
					: rect(x + 2, middle - bar / 2, end - x - 2, bar, color, opacity),
			);
			// A figure clears its group's reference rule.
			const figureX = Math.max(end, reference?.at[row] ?? end) + 4;
			parts.push(
				text(figureX, middle, point.text, {
					size: TICK_SIZE,
					fill: point.emphasis || best ? "fg" : "muted",
					weight: point.emphasis || best ? 600 : undefined,
				}),
			);
			if (best)
				parts.push(bestTag(figureX + measure(point.text, TICK_SIZE) * SEMIBOLD_WIDTH + 5, middle, TICK_SIZE));
		});
		if (reference) parts.push(reference.body);
	});
	if (!heat) {
		for (let index = 1; index < series.length; index++) {
			const x = left + index * cellWidth - 3;
			parts.push(rule(x, top, x, bottom));
		}
		return { height: bottom + 4, body: parts.join(""), notes: ["each column on its own scale"] };
	}
	const logShade = logShaded(all);
	const notes = perSeries
		? ["each column shaded on its own"]
		: perRow
			? ["each row shaded on its own"]
			: logShade
				? ["log shading"]
				: [];
	// The faintest swatch stands for where the shading starts: zero, the least positive value on a log ramp, or the least.
	const least = Math.min(...all);
	const ramp =
		perSeries || perRow || all.length === 0
			? undefined
			: {
					color: SERIES[0],
					low: formatValue(
						logShade ? Math.min(...all.filter(value => value > 0)) : Math.min(least, 0),
						series[0]!.dim,
						series[0]!.unit,
					),
					high: formatValue(Math.max(...all), series[0]!.dim, series[0]!.unit),
				};
	return { height: bottom + 4, body: parts.join(""), notes, ramp };
}

/**
 * A column header in one line of `chars`, or two split at the word boundary
 * nearest the middle when one would clip it (`Strict Recall` → `Strict`,
 * `Recall`); the second line clips what still does not fit.
 */
function wrapHeader(name: string, chars: number): string[] {
	if (name.length <= chars) return [name];
	const breaks = [...name.matchAll(/[\s/_-]+/g)].map(match => match.index! + match[0].length);
	const fitting = breaks.filter(at => at > 0 && name.slice(0, at).trimEnd().length <= chars);
	if (fitting.length === 0) return [clip(name, chars)];
	const at = fitting.reduce((best, next) =>
		Math.abs(next - name.length / 2) < Math.abs(best - name.length / 2) ? next : best,
	);
	return [name.slice(0, at).trimEnd(), clip(name.slice(at), chars)];
}

/**
 * Small multiples as bands of panels, one per series, each scaling its own
 * bars; the few categories are told apart by color through a legend. Fits a
 * table whose rows are metrics: each metric gets a panel comparing the columns.
 */
function drawPanels(spec: ChartSpec): Layer {
	const { categories, series } = spec;
	const parts: string[] = [];
	const bands = Math.ceil(series.length / PANELS_ACROSS);
	const across = Math.ceil(series.length / bands);
	const gap = 18;
	const panelWidth = (WIDTH - 2 * PAD - gap * (across - 1)) / across;
	const panelHeight = 20 + categories.length * 14 + 14;
	const top = 0;
	const titleChars = Math.floor(panelWidth / (TICK_SIZE * ADVANCE));
	series.forEach((entry, index) => {
		const x = PAD + (index % across) * (panelWidth + gap);
		const y = top + Math.floor(index / across) * panelHeight;
		parts.push(text(x, y + 6, clip(entry.name, titleChars), { size: TICK_SIZE, fill: "fg", weight: 600 }));
		const textWidth = Math.max(0, ...entry.points.map((_, at) => measure(pointText(entry, at), 10)));
		const barSpace = Math.max(0, panelWidth - textWidth - 6 - (entry.best === undefined ? 0 : BEST_WIDTH));
		const scale = panelScale(
			entry.points.flatMap(point => (point ? [point.value] : [])),
			x,
			x + barSpace,
		);
		// Categories are colors here, never nested: a reference rule runs through the whole panel.
		const rows = categories.map((_, at) => y + 20 + at * 14);
		const reference = referenceRules({ ...spec, groups: undefined }, entry, rows, 14, scale.at);
		const emphasized = entry.points.some(point => point?.emphasis);
		entry.points.forEach((point, at) => {
			const middle = y + 27 + at * 14;
			if (!point) {
				const note = entry.notes[at];
				if (note) parts.push(noteText(x, middle, clip(note, titleChars)));
				return;
			}
			const end = Math.max(x + 1, scale.at(point.value));
			const color = SERIES[at % SERIES.length]!;
			const opacity = emphasized && !point.emphasis ? RECEDE : 1;
			parts.push(
				scale.cut && point.value > scale.cut.below
					? cutBar(scale.cut, x, end, middle - 5, 10, color, opacity)
					: rect(x, middle - 5, end - x, 10, color, opacity),
			);
			const best = entry.best === at;
			const figureX = Math.max(end, reference.at[at] ?? end) + 4;
			parts.push(
				text(figureX, middle, pointText(entry, at), {
					size: 10,
					fill: point.emphasis || best ? "fg" : "muted",
					weight: point.emphasis || best ? 600 : undefined,
				}),
			);
			if (best) parts.push(bestTag(figureX + measure(pointText(entry, at), 10) * SEMIBOLD_WIDTH + 4, middle, 10));
		});
		parts.push(reference.body);
	});
	return {
		height: top + bands * panelHeight - 10,
		body: parts.join(""),
		legend: categories.map((name, at) => ({ name, color: SERIES[at % SERIES.length]! })),
		notes: ["each panel on its own scale"],
	};
}

// ── Change against a baseline ───────────────────────────────────────────────

/**
 * Factors on a log axis through 1× (the baseline): each metric's bar runs from
 * 1× to its factor, so halving and doubling draw equally long whatever the
 * metric's unit. One series prints the factor and both figures beside its bar.
 */
function drawChange(spec: ChartSpec): Layer {
	const { categories, series } = spec;
	const single = series.length === 1;
	const points = series.flatMap(entry => entry.points.filter(point => point !== null));
	const logs = points.flatMap(point => (point.value > 0 ? [Math.log10(point.value)] : []));
	let low = -roundFactor(-Math.min(0, ...logs));
	let high = roundFactor(Math.max(0, ...logs));
	// A drop to zero has no factor; its bar runs to the axis end.
	if (points.some(point => point.value === 0)) low = Math.min(low, -Math.log10(2));
	if (low === high) high = Math.log10(FACTOR_STOPS[0]!);

	const parts: string[] = [];
	const top = 0;
	const factors = categories.map((_, at) => (single ? factorText(series[0]!.points[at]) : ""));
	const factorWidth = Math.max(0, ...factors.map(label => measure(label, TICK_SIZE)));
	const figures = categories.map((_, at) => (single ? (series[0]!.points[at]?.text ?? "") : ""));
	const figureWidth = Math.max(0, ...figures.map(label => measure(label, TICK_SIZE)));
	const valueWidth = single
		? Math.min(280, factorWidth + 10 + figureWidth) + 8
		: Math.max(0, ...points.map(point => measure(factorText(point), 10))) + 8;
	const left = PAD + labelColumnWidth(spec) + 10;
	const right = WIDTH - PAD - valueWidth;
	const x = (log: number) => left + ((log - low) / (high - low)) * (right - left);
	const metrics = barMetrics(categories.length, series.length);
	const rowHeight = metrics.row;
	const barHeight = metrics.bar;
	const tops = rowTops(spec, top, rowHeight);
	const gridBottom = tops.at(-1)!;

	// 1× always; the ends and whole decades between wherever their labels stay clear of the rest.
	const decade = (right - left) / (high - low);
	const ticks = [0];
	for (const end of [low, high]) if (Math.abs(end) * decade >= 40) ticks.push(end);
	for (let power = Math.ceil(low); power <= Math.floor(high); power++) {
		if (ticks.every(tick => Math.abs(power - tick) * decade >= 40)) ticks.push(power);
	}
	for (const tick of new Set(ticks)) {
		parts.push(rule(x(tick), top, x(tick), gridBottom));
		const label = tick === 0 ? "1×" : `${tick < 0 ? "÷" : "×"}${compactFactor(10 ** Math.abs(tick))}`;
		parts.push(text(x(tick), gridBottom + 12, label, { size: TICK_SIZE, fill: "muted", anchor: "middle" }));
	}

	const emphasized = points.some(point => point.emphasis);
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	// The epsilon keeps a figure that exactly fits from clipping on float error.
	const figureChars = Math.floor((valueWidth - 18 - factorWidth) / (TICK_SIZE * ADVANCE) + 1e-6);
	parts.push(categoryLabels(spec, tops, rowHeight, strongCategories(spec)));
	categories.forEach((_, row) => {
		const rowTop = tops[row]!;
		const middle = rowTop + rowHeight / 2;
		series.forEach((entry, index) => {
			const point = entry.points[row];
			if (!point) return;
			const y = single ? middle - barHeight / 2 : rowTop + 5 + index * metrics.step;
			const end = x(point.value > 0 ? Math.log10(point.value) : low);
			// A metric with a polarity reads its move as an improvement or a regression.
			const tone = moveTone(spec.categoryPolarity?.[row] ?? entry.polarity, point.value);
			// One series tells shrinking from growing by color (better from worse where it can); several keep their own.
			const color = single ? (tone ?? SERIES[point.value > 1 ? 1 : 0]) : SERIES[index % SERIES.length]!;
			const opacity = emphasized && !point.emphasis ? RECEDE : 1;
			parts.push(rect(Math.min(x(0), end), y, Math.max(1, Math.abs(end - x(0))), barHeight, color, opacity));
			if (!single)
				parts.push(text(right + 8, y + barHeight / 2, factorText(point), { size: 10, fill: tone ?? "muted" }));
		});
		if (single) {
			const point = series[0]!.points[row];
			const strong = point?.emphasis ? 600 : undefined;
			const tone = point ? moveTone(spec.categoryPolarity?.[row] ?? series[0]!.polarity, point.value) : undefined;
			parts.push(text(right + 8, middle, factors[row]!, { size: TICK_SIZE, fill: tone ?? "fg", weight: strong }));
			parts.push(
				text(right + 18 + factorWidth, middle, clip(figures[row]!, figureChars), {
					size: TICK_SIZE,
					fill: "muted",
				}),
			);
		}
	});
	parts.push(line(x(0), top - 2, x(0), gridBottom + 2, "muted", 1.5));
	return {
		height: gridBottom + 20,
		body: parts.join(""),
		legend: single
			? []
			: [
					...series.map((entry, at) => ({ name: entry.name, color: SERIES[at % SERIES.length]! })),
					{ name: spec.baseline ?? "baseline", color: "muted" },
				],
		notes: ["factor, log scale"],
	};
}

/** `log10` of the first {@link FACTOR_STOPS} entry (else power of ten) at or past `10^log`; 0 stays 0. */
function roundFactor(log: number): number {
	if (log <= 0) return 0;
	const stop = FACTOR_STOPS.find(factor => Math.log10(factor) >= log - 1e-9);
	return stop === undefined ? Math.ceil(log - 1e-9) : Math.log10(stop);
}

/** A factor as people say it: `48× less`, `2.1× more`, or a percent within 2× (`−12%`, `+27%`). */
function factorText(point: ChartPoint | null | undefined): string {
	if (!point) return "";
	const factor = point.value;
	if (factor === 0) return "−100%";
	if (factor >= 2) return `${compactFactor(factor)}× more`;
	if (factor <= 0.5) return `${compactFactor(1 / factor)}× less`;
	const percent = Math.round((factor - 1) * 100);
	return percent === 0 ? "same" : `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%`;
}

/** `48`, `2.1`, `1.25`, `35k`: whole above 10, one decimal above 2, two below. */
function compactFactor(factor: number): string {
	if (factor >= 10) return compact(Math.round(factor));
	return Number(factor.toFixed(factor >= 2 ? 1 : 2)).toString();
}

// ── Share of a whole ─────────────────────────────────────────────────────────

/**
 * One bar split into the categories' shares, in table order, keyed below with
 * each name and figure. Percentages draw as written; counts splitting a total
 * draw as their percent of it, keyed `248 · 16%`, with the whole they make
 * named in the header (`100% = 1,543`). Outcome categories take their status
 * colors ({@link ChartSpec.tones}).
 */
function drawShare(spec: ChartSpec): Layer {
	const entry = spec.series[0]!;
	const total = entry.points.reduce((sum, point) => sum + Math.max(0, point?.value ?? 0), 0) || 1;
	const counts = entry.dim !== "percent";
	const shares = entry.points.map(point =>
		point && counts ? percentText((100 * Math.max(0, point.value)) / total) : (point?.text ?? ""),
	);
	const parts: string[] = [];
	const barWidth = WIDTH - 2 * PAD;
	let x = PAD;
	entry.points.forEach((point, at) => {
		if (!point || point.value <= 0) return;
		const width = (point.value / total) * barWidth;
		// Segments part with a sliver of the canvas behind them.
		const opacity = partOpacity(spec, at);
		parts.push(rect(x, 0, Math.max(1, width - 2), 24, partColor(spec, at), opacity, 4));
		// A segment wide enough carries its figure inside, in ink to read on the solid color (plain text on a faint one).
		const figure = shares[at]!;
		const style = { size: TICK_SIZE, fill: "fg", anchor: "middle", weight: 600 } as const;
		if (figure && measure(figure, TICK_SIZE) * SEMIBOLD_WIDTH + 12 <= width - 2)
			parts.push((opacity >= INK_LEVEL ? ink : text)(x + (width - 2) / 2, 12, figure, style));
		x += width;
	});
	const columns = spec.categories.length > 5 ? 2 : 1;
	const columnWidth = barWidth / columns;
	const perColumn = Math.ceil(spec.categories.length / columns);
	const names = clipNames(spec.categories, Math.floor((columnWidth - 90) / (LABEL_SIZE * ADVANCE)));
	names.forEach((name, at) => {
		const column = Math.floor(at / perColumn);
		const lx = PAD + column * columnWidth;
		const ly = 42 + (at % perColumn) * 20;
		const point = entry.points[at];
		parts.push(dot(lx + 5, ly, 4.5, partColor(spec, at), partOpacity(spec, at)));
		parts.push(text(lx + 16, ly, name, { fill: "fg" }));
		parts.push(
			text(lx + columnWidth - 12, ly, point && counts ? `${point.text} · ${shares[at]}` : (point?.text ?? ""), {
				size: TICK_SIZE,
				fill: point?.emphasis ? "fg" : "muted",
				anchor: "end",
				weight: point?.emphasis ? 600 : undefined,
			}),
		);
	});
	// The whole the counts split, unless the caption already prints the table's total row.
	const notes = counts && !spec.caption ? [`100% = ${total.toLocaleString("en-US")}`] : [];
	return { height: 42 + perColumn * 20 - 6, body: parts.join(""), notes };
}

// ── Line over an ordered axis ────────────────────────────────────────────────

/** A line's value label at its end, nudged clear of its neighbours by {@link spreadLabels}. */
interface EndLabel {
	readonly x: number;
	y: number;
	readonly text: string;
	readonly color: string;
	/** The line's name, set before its value when lines are labelled directly instead of through a legend. */
	readonly name?: string;
}

/**
 * Lines across the categories (or the numeric x), smoothed without
 * overshooting a sample. Series whose peaks differ {@link SPLIT_SPREAD}× or
 * more stack in panels on their own axes, so one large series never flattens
 * the rest; the panels share the x labels under the last. A lone line draws
 * over a soft area fill, and every line ends in its value — and its name,
 * when there are several and their names are short, instead of a legend.
 */
function drawLine(spec: ChartSpec): Layer {
	const { categories, series, x } = spec;
	const panels = magnitudePanels(series);
	const values = panels.map(panel =>
		panel.flatMap(index => series[index]!.points.flatMap(point => (point ? [point.value] : []))),
	);
	const tickWidth = Math.max(
		...values.flatMap(panelValues => {
			const scale = valueScale(panelValues, 0, 1, { zero: false });
			const format = tickFormat(scale, series[0]!);
			return scale.ticks.map(tick => measure(format(tick), TICK_SIZE));
		}),
	);
	const position = (at: number) => (x ? x.values[at]! : at);
	const order = categories.map((_, at) => at).sort((a, b) => position(a) - position(b));
	// The rightmost sample of each line carries its value label.
	const lasts = series.map(entry => order.findLast(at => entry.points[at]) ?? -1);
	const direct =
		series.length > 1 && series.every(entry => measure(entry.name, TICK_SIZE) * SEMIBOLD_WIDTH <= MAX_DIRECT_LABEL);
	const endWidth = Math.max(
		0,
		...lasts.map((last, index) => {
			const name = direct ? measure(series[index]!.name, TICK_SIZE) * SEMIBOLD_WIDTH + 6 : 0;
			return name + measure(series[index]!.points[last]?.text ?? "", TICK_SIZE);
		}),
	);
	const left = PAD + tickWidth + 8;
	const right = WIDTH - PAD - Math.min(direct ? 230 : 120, endWidth + 10);
	const xScale = x
		? valueScale(x.values, left, right, { zero: false })
		: {
				at: (index: number) =>
					left + (categories.length === 1 ? 0 : (index / (categories.length - 1)) * (right - left)),
			};
	const xAt = (at: number) => xScale.at(position(at));
	const plotHeight = panels.length === 1 ? 180 : Math.max(72, Math.round(200 / panels.length));
	const dotted = categories.length <= MAX_DOTS;

	const parts: string[] = [];
	const references = (spec.annotations ?? []).filter(
		(mark): mark is Extract<ChartAnnotation, { kind: "reference" }> => mark.kind === "reference",
	);
	const callouts = (spec.annotations ?? []).filter(
		(mark): mark is Extract<ChartAnnotation, { kind: "callout" }> => mark.kind === "callout",
	);
	let top = callouts.length ? 18 : 0;
	let plotBottom = 0;
	panels.forEach((panel, panelIndex) => {
		// Lines without direct labels need a legend in each of several panels (one panel's goes in the header).
		if (series.length > 1 && !direct && panels.length > 1) {
			const legend = drawLegend(
				panel.map(index => ({ name: series[index]!.name, color: SERIES[index % SERIES.length]! })),
				PAD,
				WIDTH - PAD,
				6,
			);
			parts.push(`<g transform="translate(0 ${num(top)})">${legend.body}</g>`);
			top += legend.height + 4;
		}
		const plotTop = top + 6;
		plotBottom = plotTop + plotHeight;
		const scale = valueScale(values[panelIndex]!, plotBottom, plotTop, { zero: false });
		const format = tickFormat(scale, series[0]!);
		// Short panels label every other gridline.
		const labelEvery = plotHeight / Math.max(1, scale.ticks.length - 1) < 20 ? 2 : 1;
		scale.ticks.forEach((tick, at) => {
			const y = scale.at(tick);
			parts.push(rule(left, y, right, y));
			if (at % labelEvery === 0)
				parts.push(text(left - 8, y, format(tick), { size: TICK_SIZE, fill: "muted", anchor: "end" }));
		});
		const ends: EndLabel[] = [];
		for (const index of panel) {
			const entry = series[index]!;
			const color = SERIES[index % SERIES.length]!;
			// Runs of consecutive samples; a gap in the table breaks the line.
			const runs: [number, number][][] = [[]];
			for (const at of order) {
				const point = entry.points[at];
				if (point) runs.at(-1)!.push([xAt(at), scale.at(point.value)]);
				else if (runs.at(-1)!.length > 0) runs.push([]);
			}
			if (panel.length === 1) {
				// The fade's id names its color, so two charts inlined in one page agree on it.
				parts.push(
					`<defs><linearGradient id="fade-${color}" x1="0" y1="0" x2="0" y2="1">`,
					`<stop offset="0" stop-color="${token(color)}" stop-opacity="0.26"/>`,
					`<stop offset="1" stop-color="${token(color)}" stop-opacity="0"/>`,
					"</linearGradient></defs>",
				);
				for (const run of runs) {
					if (run.length < 2) continue;
					const floor = `L${num(run.at(-1)![0])} ${num(plotBottom)}L${num(run[0]![0])} ${num(plotBottom)}Z`;
					parts.push(`<path d="${smoothPath(run)}${floor}" fill="url(#fade-${color})"/>`);
				}
			}
			for (const run of runs) {
				if (run.length < 2) continue;
				parts.push(
					`<path d="${smoothPath(run)}" fill="none" stroke="${token(color)}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>`,
				);
			}
			const last = lasts[index]!;
			entry.points.forEach((point, at) => {
				if (!point || !(dotted || point.emphasis || at === last)) return;
				parts.push(dot(xAt(at), scale.at(point.value), point.emphasis ? 4.5 : at === last ? 3.5 : 2.5, color));
			});
			const end = entry.points[last];
			if (end)
				ends.push({
					x: xAt(last) + 8,
					y: scale.at(end.value),
					text: end.text,
					color,
					name: direct ? entry.name : undefined,
				});
			for (const mark of callouts) {
				const point = (mark.series ?? 0) === index ? entry.points[mark.category] : undefined;
				if (!point) continue;
				const label = clip(mark.text, MAX_CALLOUT_CHARS);
				const half = (measure(label, TICK_SIZE) * SEMIBOLD_WIDTH) / 2;
				const px = xAt(mark.category);
				const py = scale.at(point.value);
				parts.push(line(px, py - 6, px, py - 16, "muted", 1));
				parts.push(
					text(Math.min(Math.max(px, left + half), right - half), py - 23, label, {
						size: TICK_SIZE,
						fill: "fg",
						anchor: "middle",
						weight: 600,
					}),
				);
			}
		}
		for (const mark of panelIndex === 0 ? references : []) {
			const y = scale.at(mark.value);
			if (y < plotTop - 0.5 || y > plotBottom + 0.5) continue;
			parts.push(referenceRule(left, y, right, y));
			parts.push(text(right, y - 7, clip(mark.label, MAX_CALLOUT_CHARS), { size: 10, fill: "fg", anchor: "end" }));
		}
		parts.push(spreadLabels(ends, plotTop - 4, plotBottom + 4));
		top = plotBottom + 22;
	});

	// Category labels left to right, skipping any that would touch the last one drawn.
	const slot = (right - left) / Math.max(1, categories.length - 1);
	const labelChars = Math.max(3, Math.floor(Math.max(slot, 60) / (TICK_SIZE * ADVANCE)) - 1);
	const labels = clipNames(categories, labelChars);
	let drawnEnd = Number.NEGATIVE_INFINITY;
	for (const at of order) {
		const label = labels[at]!;
		const width = measure(label, TICK_SIZE);
		const center = Math.min(Math.max(xAt(at), left + width / 2), WIDTH - PAD - width / 2);
		if (center - width / 2 < drawnEnd + 8) continue;
		parts.push(text(center, plotBottom + 14, label, { size: TICK_SIZE, fill: "muted", anchor: "middle" }));
		drawnEnd = center + width / 2;
	}
	return {
		height: plotBottom + 24,
		body: parts.join(""),
		legend:
			series.length > 1 && !direct && panels.length === 1
				? series.map((entry, at) => ({ name: entry.name, color: SERIES[at % SERIES.length]! }))
				: [],
		notes: panels.length > 1 ? ["panels on their own axes"] : [],
	};
}

/**
 * Series indices grouped into panels whose peaks stay within
 * {@link SPLIT_SPREAD}× of the panel's largest, panels and their series in
 * table order. An all-zero series joins the smallest panel.
 */
function magnitudePanels(series: readonly ChartSeries[]): number[][] {
	const peaks = series.map(entry => Math.max(0, ...entry.points.map(point => (point ? Math.abs(point.value) : 0))));
	const panels: number[][] = [];
	let panelPeak = 0;
	for (const index of series.map((_, at) => at).sort((a, b) => peaks[b]! - peaks[a]!)) {
		const peak = peaks[index]!;
		if (panels.length > 0 && (peak === 0 || panelPeak < peak * SPLIT_SPREAD)) {
			panels.at(-1)!.push(index);
		} else {
			panels.push([index]);
			panelPeak = peak;
		}
	}
	for (const panel of panels) panel.sort((a, b) => a - b);
	return panels.sort((a, b) => a[0]! - b[0]!);
}

/**
 * A path through `points` (x ascending) as a monotone cubic (Steffen's
 * method): smooth, yet never overshooting a sample the way a Catmull-Rom
 * curve would between a peak and a flat stretch.
 */
function smoothPath(points: readonly (readonly [number, number])[]): string {
	const n = points.length;
	let path = `M${num(points[0]![0])} ${num(points[0]![1])}`;
	if (n < 3) return n === 2 ? `${path}L${num(points[1]![0])} ${num(points[1]![1])}` : path;
	const secants: number[] = [];
	for (let at = 0; at < n - 1; at++) {
		const h = points[at + 1]![0] - points[at]![0];
		secants.push(h === 0 ? 0 : (points[at + 1]![1] - points[at]![1]) / h);
	}
	const tangents: number[] = [0];
	for (let at = 1; at < n - 1; at++) {
		const h0 = points[at]![0] - points[at - 1]![0];
		const h1 = points[at + 1]![0] - points[at]![0];
		const [s0, s1] = [secants[at - 1]!, secants[at]!];
		const weighted = (s0 * h1 + s1 * h0) / (h0 + h1 || 1);
		tangents.push((Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(weighted)));
	}
	tangents[0] = (3 * secants[0]! - tangents[1]!) / 2;
	tangents.push((3 * secants[n - 2]! - tangents[n - 2]!) / 2);
	for (let at = 0; at < n - 1; at++) {
		const [x0, y0] = points[at]!;
		const [x1, y1] = points[at + 1]!;
		const third = (x1 - x0) / 3;
		path += `C${num(x0 + third)} ${num(y0 + third * tangents[at]!)} ${num(x1 - third)} ${num(y1 - third * tangents[at + 1]!)} ${num(x1)} ${num(y1)}`;
	}
	return path;
}

/** End labels in their lines' colors, nudged apart so none overlap, kept between `top` and `bottom` where they fit. */
function spreadLabels(labels: EndLabel[], top: number, bottom: number): string {
	const gap = TICK_SIZE + 2;
	labels.sort((a, b) => a.y - b.y);
	for (let at = 1; at < labels.length; at++) labels[at]!.y = Math.max(labels[at]!.y, labels[at - 1]!.y + gap);
	for (let at = labels.length - 1; at >= 0; at--) {
		const limit = at === labels.length - 1 ? bottom : labels[at + 1]!.y - gap;
		labels[at]!.y = Math.max(top, Math.min(labels[at]!.y, limit));
	}
	return labels
		.map(label => {
			if (!label.name)
				return text(label.x, label.y, label.text, { size: TICK_SIZE, fill: label.color, weight: 600 });
			const name = text(label.x, label.y, label.name, { size: TICK_SIZE, fill: label.color, weight: 600 });
			const offset = measure(label.name, TICK_SIZE) * SEMIBOLD_WIDTH + 6;
			return name + text(label.x + offset, label.y, label.text, { size: TICK_SIZE, fill: "muted" });
		})
		.join("");
}

// ── Scatter ──────────────────────────────────────────────────────────────────

function drawScatter(spec: ChartSpec): Layer {
	const entry = spec.series[0]!;
	const xs = spec.x!;
	const ys = entry.points.map(point => point?.value ?? Number.NaN);
	const finite = (values: readonly number[]) => values.filter(Number.isFinite);
	const yAxis = valueScale(finite(ys), 0, 1, { zero: false });
	const yFormat = tickFormat(yAxis, entry);
	const left = PAD + Math.max(...yAxis.ticks.map(tick => measure(yFormat(tick), TICK_SIZE))) + 8;
	const right = WIDTH - PAD - 24;
	const top = 18;
	const bottom = top + 200;
	const xScale = valueScale(finite(xs.values), left, right, { zero: false });
	const yScale = valueScale(finite(ys), bottom, top, { zero: false });
	const parts: string[] = [text(left, 6, entry.name, { size: TICK_SIZE, fill: "muted" })];
	for (const tick of yScale.ticks) {
		parts.push(rule(left, yScale.at(tick), right, yScale.at(tick)));
		parts.push(
			text(left - 8, yScale.at(tick), yFormat(tick), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "end",
			}),
		);
	}
	const xFormat = tickFormat(xScale, xs);
	for (const tick of xScale.ticks) {
		parts.push(
			text(xScale.at(tick), bottom + 14, xFormat(tick), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "middle",
			}),
		);
	}
	parts.push(text(right, bottom + 30, xs.name, { size: TICK_SIZE, fill: "muted", anchor: "end" }));
	const marks = entry.points.flatMap((point, at) => {
		const xv = xs.values[at]!;
		return point && Number.isFinite(xv) ? [{ at, point, x: xScale.at(xv), y: yScale.at(point.value) }] : [];
	});
	const emphasized = marks.some(mark => mark.point.emphasis);
	// A highlighted item (the row the table is about) is ringed in the accent and named in full strength.
	const focus = new Set(highlighted(spec));
	for (const mark of marks) {
		const strong = !emphasized || mark.point.emphasis || focus.has(mark.at);
		if (focus.has(mark.at)) parts.push(ring(mark.x, mark.y, 8.5, "accent"));
		parts.push(dot(mark.x, mark.y, mark.point.emphasis ? 5.5 : 4, SERIES[0], strong ? 0.9 : RECEDE));
	}
	// Each name takes the first spot around its dot clear of every dot and name placed so far; crowded ones go unnamed.
	const taken: Box[] = marks.map(mark => ({ x0: mark.x - 5, y0: mark.y - 5, x1: mark.x + 5, y1: mark.y + 5 }));
	const lead = (mark: (typeof marks)[number]) => Number(focus.has(mark.at)) * 2 + Number(mark.point.emphasis);
	const order = marks.toSorted((a, b) => lead(b) - lead(a));
	const names = clipNames(spec.categories, 18);
	for (const mark of order.length <= 40 ? order : []) {
		const label = names[mark.at]!;
		const width = measure(label, 10);
		const spots: [number, number, "start" | "end" | "middle"][] = [
			[mark.x + 8, mark.y, "start"],
			[mark.x - 8, mark.y, "end"],
			[mark.x, mark.y - 12, "middle"],
			[mark.x, mark.y + 12, "middle"],
		];
		for (const [x, y, anchor] of spots) {
			const x0 = anchor === "start" ? x : anchor === "end" ? x - width : x - width / 2;
			const box = { x0: x0 - 1, y0: y - 6, x1: x0 + width + 1, y1: y + 6 };
			if (box.x0 < PAD || box.x1 > WIDTH - PAD || box.y0 < 0 || box.y1 > bottom + 4) continue;
			if (taken.some(other => box.x0 < other.x1 && other.x0 < box.x1 && box.y0 < other.y1 && other.y0 < box.y1))
				continue;
			taken.push(box);
			parts.push(
				text(x, y, label, {
					size: 10,
					fill: focus.has(mark.at) ? "accent" : mark.point.emphasis ? "fg" : "muted",
					anchor,
					weight: mark.point.emphasis || focus.has(mark.at) ? 600 : undefined,
				}),
			);
			break;
		}
	}
	return { height: bottom + 36, body: parts.join("") };
}

// ── Shared pieces ────────────────────────────────────────────────────────────

/**
 * A value axis over `values` from `from` to `to`: logarithmic when every
 * value is positive and they span {@link LOG_SPREAD}× or more, else linear on
 * nice ticks, including zero when `zero` asks for a baseline.
 */
function valueScale(
	values: readonly number[],
	from: number,
	to: number,
	options: { zero: boolean; breakable?: boolean },
): Scale {
	let min = Math.min(...values);
	let max = Math.max(...values);
	if (!Number.isFinite(min) || !Number.isFinite(max)) {
		min = 0;
		max = 1;
	}
	const tier = options.breakable ? outlierTier(values) : undefined;
	if (tier) return brokenScale(tier, from, to, true);
	if (min > 0 && max / min >= LOG_SPREAD) {
		const low = Math.floor(Math.log10(min));
		const high = Math.ceil(Math.log10(max));
		const ticks: number[] = [];
		const stride = Math.max(1, Math.ceil((high - low) / 6));
		for (let power = low; power <= high; power += stride) ticks.push(10 ** power);
		const span = high - low || 1;
		return {
			at: value => from + ((Math.log10(Math.max(value, 10 ** low)) - low) / span) * (to - from),
			ticks,
			log: true,
		};
	}
	if (options.zero) {
		min = Math.min(0, min);
		max = Math.max(0, max);
	} else if (min > 0 && min < max * 0.35) {
		min = 0;
	}
	if (min === max) {
		max = min === 0 ? 1 : min + Math.abs(min) * 0.5;
		if (!options.zero) min -= Math.abs(min) * 0.5;
	}
	const step = niceStep((max - min) / 4);
	const low = Math.floor(min / step) * step;
	const high = Math.ceil(max / step) * step;
	const ticks: number[] = [];
	for (let tick = low; tick <= high + step / 2; tick += step) ticks.push(Number(tick.toPrecision(12)));
	return { at: value => from + ((value - low) / (high - low || 1)) * (to - from), ticks, log: false };
}

/**
 * A positional axis for dots and intervals, which mark where values lie rather
 * than how far they reach from zero: logarithmic once positive values span
 * {@link SPAN_LOG}×, on ticks at 1, 2 and 5 times powers of ten while it spans
 * at most {@link FINE_DECADES} decades (powers of ten past that), its ends on
 * the ticks just outside the values; else {@link valueScale}'s linear axis.
 * Durations from a second up tick on the clock ({@link CLOCK_TICKS}: `1m`,
 * `5m`, `1h`) rather than at `16.7m`. The axis reaches `marks` too (reference
 * rules), which never make it logarithmic.
 */
function spanScale(
	values: readonly number[],
	from: number,
	to: number,
	marks: readonly number[] = [],
	dim?: Dimension,
): Scale {
	const reach = [...values, ...marks];
	const [min, max] = [Math.min(...reach), Math.max(...reach)];
	if (!(Math.min(...values) > 0) || !(min > 0) || Math.max(...values) / Math.min(...values) < SPAN_LOG)
		return valueScale(reach, from, to, { zero: false });
	const fine = Math.log10(max / min) <= FINE_DECADES;
	const steps = fine ? [1, 2, 5] : [1];
	const grid: number[] = [];
	for (let power = Math.floor(Math.log10(min)); power <= Math.ceil(Math.log10(max)); power++)
		for (const step of steps) {
			const tick = Number((step * 10 ** power).toPrecision(6));
			if (dim !== "duration" || tick < 1 || tick > CLOCK_TICKS.at(-1)!) grid.push(tick);
		}
	if (dim === "duration") grid.push(...(fine ? CLOCK_TICKS : CLOCK_TICKS.filter((_, at) => at % 3 === 0)));
	grid.sort((a, b) => a - b);
	const low = Math.max(...grid.filter(tick => tick <= min * (1 + 1e-9)));
	const high = Math.min(...grid.filter(tick => tick >= max * (1 - 1e-9)));
	const all = grid.filter(tick => tick >= low && tick <= high);
	// Past six decades every other power keeps the labels apart.
	const stride = Math.max(1, Math.ceil(all.length / 7));
	const ticks = all.filter((_, at) => at % stride === 0 || at === all.length - 1);
	const [a, b] = [Math.log10(low), Math.log10(high)];
	return {
		at: value => from + ((Math.log10(Math.max(value, low)) - a) / (b - a || 1)) * (to - from),
		ticks,
		log: true,
	};
}

/**
 * The few values (at most {@link MAX_TIER_SHARE} of them) standing
 * {@link TIER_GAP}× or more above the largest of the rest, at the widest such
 * jump — when the rest still read on a linear axis (spread under
 * {@link LOG_SPREAD}), so breaking the axis beats a logarithmic one.
 */
function outlierTier(values: readonly number[]): Tier | undefined {
	if (values.some(value => value < 0)) return undefined;
	const sorted = values.filter(value => value > 0).sort((a, b) => b - a);
	const most = Math.floor(values.length * MAX_TIER_SHARE);
	let best: Tier | undefined;
	let gap = TIER_GAP;
	for (let k = 1; k <= most && k + MIN_BELOW_TIER <= sorted.length; k++) {
		const ratio = sorted[k - 1]! / sorted[k]!;
		if (ratio >= gap) {
			gap = ratio;
			best = { rest: sorted[k]!, low: sorted[k - 1]!, high: sorted[0]! };
		}
	}
	if (!best || best.rest / sorted.at(-1)! >= LOG_SPREAD) return undefined;
	return best;
}

/**
 * A linear axis from zero over the rest of `tier` up to {@link CUT_AT} of its
 * length, then a gap, then a second linear segment zoomed on the tier, so the
 * outliers neither flatten the rest nor lose their own differences. `nice`
 * rounds the segments' ends out to tick values; without, the largest value of
 * each segment reaches its end (bars in a panel without an axis).
 */
function brokenScale(tier: Tier, from: number, to: number, nice: boolean): Scale {
	const middle = from + (to - from) * CUT_AT;
	const start = middle - (Math.sign(to - from) * CUT_GAP) / 2;
	const end = middle + (Math.sign(to - from) * CUT_GAP) / 2;
	const step = niceStep(tier.rest / 4);
	const top = nice ? Math.ceil(tier.rest / step) * step : tier.rest;
	const spread = tier.high - tier.low;
	const zoom = niceStep(Math.max(spread, tier.high * 0.1) / 2);
	// Zoomed no further than half the tier's peak, so an 8% difference never reads as 80%.
	const floor = Math.min(tier.low - Math.max(spread * 0.25, tier.high * 0.05), tier.high / 2);
	const low = Math.max(top, nice ? Math.floor(floor / zoom) * zoom : floor);
	const high = nice ? Math.ceil(tier.high / zoom) * zoom : tier.high;
	const ticks: number[] = [];
	for (let tick = 0; tick <= top + step / 2; tick += step) ticks.push(Number(tick.toPrecision(12)));
	ticks.push(high);
	return {
		at: value =>
			value <= top
				? from + (Math.max(0, value) / top) * (start - from)
				: end + ((Math.max(value, low) - low) / (high - low || 1)) * (to - end),
		ticks,
		log: false,
		cut: { below: top, start, end },
	};
}

/**
 * Bar ends from `from` to `to` for a panel without an axis: broken over an
 * outlier tier ({@link outlierTier}), else linear from zero (from the
 * smallest value when one is negative). No axis would tell a reader a bar is
 * logarithmic, so lengths stay proportional.
 */
function panelScale(values: readonly number[], from: number, to: number): Scale {
	const tier = outlierTier(values);
	if (tier) return brokenScale(tier, from, to, false);
	const max = Math.max(...values);
	const min = Math.min(0, ...values);
	const span = Number.isFinite(max) && max > min ? max - min : 0;
	return { at: value => from + (span ? (value - min) / span : 1) * (to - from), ticks: [], log: false };
}

/**
 * Fill strength 0–1 of heat cells: from zero, logarithmic over the positive
 * values once they span {@link LOG_SPREAD}× or hold an outlier tier — a zero
 * cell (no reasoning tokens) neither blocks that nor takes a shade — min–max
 * when values go negative.
 */
function shade(values: readonly number[]): (value: number) => number {
	const lowest = Math.min(...values);
	if (lowest < 0) {
		const span = Math.max(...values) - lowest;
		return value => (span ? (value - lowest) / span : 1);
	}
	const positive = values.filter(value => value > 0);
	const max = Math.max(...positive);
	const min = Math.min(...positive);
	if (positive.length < 2 || max === min) return value => (value > 0 ? 1 : 0);
	if (logShaded(values)) {
		const low = Math.log10(min);
		const span = Math.log10(max) - low;
		return value => (value > 0 ? 0.1 + (0.9 * (Math.log10(value) - low)) / span : 0);
	}
	return value => Math.max(0, value) / max;
}

/** Whether {@link shade} maps `values` logarithmically: non-negative, positive ones spanning decades or an outlier tier. */
function logShaded(values: readonly number[]): boolean {
	const positive = values.filter(value => value > 0);
	if (positive.length < 2 || values.some(value => value < 0)) return false;
	return Math.max(...positive) / Math.min(...positive) >= LOG_SPREAD || outlierTier(values) !== undefined;
}

/** 1, 2, 2.5 or 5 times a power of ten, at least `raw`. */
function niceStep(raw: number): number {
	const power = 10 ** Math.floor(Math.log10(raw || 1));
	const fraction = raw / power;
	return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
}

/** Gridlines and tick labels under a horizontal value axis; zero, where bars start, draws as a firmer baseline. */
function drawValueAxis(scale: Scale, series: ChartSeries, top: number, bottom: number): string {
	const parts: string[] = [];
	const format = tickFormat(scale, series);
	for (const tick of scale.ticks) {
		const x = scale.at(tick);
		parts.push(tick === 0 && !scale.log ? line(x, top, x, bottom, "border", 1) : rule(x, top, x, bottom));
		// The break mark stands where the first segment's last label would.
		if (tick === scale.cut?.below) continue;
		parts.push(
			text(x, bottom + 12, format(tick), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "middle",
			}),
		);
	}
	if (scale.cut) parts.push(breakMark((scale.cut.start + scale.cut.end) / 2, bottom + 12, 5, "muted"));
	return parts.join("");
}

/** A bar from `zero` to `end` crossing a broken axis: both segments, the gap between them marked. */
function cutBar(cut: Cut, zero: number, end: number, y: number, height: number, fill: string, opacity: number): string {
	return [
		rect(zero, y, cut.start - zero, height, fill, opacity),
		rect(cut.end, y, Math.max(1, end - cut.end), height, fill, opacity),
		breakMark((cut.start + cut.end) / 2, y + height / 2, height / 2 + 1, "muted"),
	].join("");
}

/** Two slanted strokes centred on `x`, `y`: the sign of a broken axis or a bar crossing its gap. */
function breakMark(x: number, y: number, half: number, stroke: string): string {
	const slant = half * 0.55;
	return [-2.5, 2.5]
		.map(offset => line(x + offset - slant, y + half, x + offset + slant, y - half, stroke, 1.25))
		.join("");
}

/**
 * A {@link referenceRule} at each reference category's value of `entry`
 * ({@link ChartSpec.reference}) through the rows of its group (all rows
 * without groups), so the others read as shorter or longer than it; with,
 * per category, the x of its group's rule, which its figure clears.
 */
function referenceRules(
	spec: ChartSpec,
	entry: ChartSeries,
	tops: readonly number[],
	rowHeight: number,
	at: (value: number) => number,
): { readonly body: string; readonly at: readonly (number | undefined)[] } {
	const parts: string[] = [];
	const xs: (number | undefined)[] = spec.categories.map(() => undefined);
	for (const index of spec.reference ?? []) {
		const point = entry.points[index];
		if (!point) continue;
		const [first, last] = groupSpan(spec, index);
		const x = at(point.value);
		xs.fill(x, first, last + 1);
		parts.push(referenceRule(x, tops[first]! + 2, x, tops[last]! + rowHeight - 2));
	}
	return { body: parts.join(""), at: xs };
}

/** First and last category index of the group holding category `at`; every category without groups. */
function groupSpan(spec: ChartSpec, at: number): [number, number] {
	let first = 0;
	for (const group of spec.groups ?? []) {
		const last = first + group.members.length - 1;
		if (at <= last) return [first, last];
		first = last + 1;
	}
	return [0, spec.categories.length - 1];
}

/** Width of one legend entry: its mark, name, and the gap before the next. */
function legendItemWidth(item: LegendItem): number {
	return 12 + measure(clip(item.name, MAX_LEGEND_CHARS), TICK_SIZE) + 16;
}

/** Width of `items` on one line, without the trailing gap. */
function legendWidth(items: readonly LegendItem[]): number {
	return items.reduce((sum, item) => sum + legendItemWidth(item), 0) - 16;
}

/** Dot-and-name legend wrapping across `left`…`right`, its first line centred on `y`. */
function drawLegend(items: readonly LegendItem[], left: number, right: number, y: number): Layer {
	const parts: string[] = [];
	const labels = clipNames(
		items.map(item => item.name),
		MAX_LEGEND_CHARS,
	);
	let x = left;
	items.forEach((item, at) => {
		const width = legendItemWidth(item);
		if (x + width - 16 > right + 0.5 && x > left) {
			x = left;
			y += LEGEND_LINE;
		}
		parts.push(item.ring ? ring(x + 4, y, 3.25, item.color) : dot(x + 4, y, 4, item.color, item.opacity));
		parts.push(text(x + 12, y, labels[at]!, { size: TICK_SIZE, fill: "muted" }));
		x += width;
	});
	return { height: y + 8, body: parts.join("") };
}

/** Width of a heat {@link RampKey}: low figure, five swatches, high figure. */
function rampWidth(ramp: RampKey): number {
	return measure(ramp.low, 10) + 6 + 5 * 13 + 4 + measure(ramp.high, 10);
}

/** A heat scale key from `x`, centred on `y`: the low figure, swatches from faint to opaque, the high figure. */
function drawRamp(ramp: RampKey, x: number, y: number): string {
	const parts = [text(x, y, ramp.low, { size: 10, fill: "muted" })];
	let at = x + measure(ramp.low, 10) + 6;
	for (let step = 0; step < 5; step++, at += 13)
		parts.push(rect(at, y - 5, 11, 10, ramp.color, HEAT_FLOOR + ((1 - HEAT_FLOOR) * step) / 4, 2));
	parts.push(text(at + 4, y, ramp.high, { size: 10, fill: "muted" }));
	return parts.join("");
}

/**
 * Category names down the label column, centred on their rows from `tops`;
 * a group's name once, semibold, beside its first member. Names start at the
 * column's left, so one set wider than {@link measure} estimates (another
 * font, a larger size) runs toward the plot instead of off the canvas.
 */
function categoryLabels(
	spec: ChartSpec,
	tops: readonly number[],
	rowHeight: number,
	strong: ReadonlySet<number> = new Set(),
): string {
	const middle = (at: number) => tops[at]! + rowHeight / 2;
	const { groups, status } = spec;
	const matrix = matrixDots(spec, middle);
	// A status badge leads the name: a dot in the status color.
	const badges = status?.some(Boolean) ? STATUS_WIDTH : 0;
	const badge = (x: number, at: number) => {
		const state = status?.[at];
		return state ? dot(x + 4, middle(at), 4, STATUS_COLORS[state]) : "";
	};
	if (!groups)
		return (
			matrix +
			clipNames(spec.categories, MAX_LABEL_CHARS)
				.map(
					(name, at) =>
						badge(PAD, at) +
						text(PAD + badges, middle(at), name, {
							fill: "fg",
							weight: strong.has(at) ? 600 : undefined,
						}),
				)
				.join("")
		);
	const memberX = PAD + groupNameWidth(groups) + 10;
	const heads = clipNames(
		groups.map(group => group.name),
		groupChars(groups),
	);
	const members = clipNames(
		groups.flatMap(group => group.members),
		MAX_LABEL_CHARS,
	);
	const parts: string[] = [matrix];
	let at = 0;
	groups.forEach((group, index) => {
		parts.push(text(PAD, middle(at), heads[index]!, { fill: "fg", weight: 600 }));
		for (const end = at + group.members.length; at < end; at++)
			parts.push(
				badge(memberX, at) +
					text(memberX + badges, middle(at), members[at]!, {
						fill: "fg",
						weight: strong.has(at) ? 600 : undefined,
					}),
			);
	});
	return parts.join("");
}

/** Characters a matrix column's heading takes per line, wrapped to two lines at most. */
const MATRIX_HEAD_CHARS = 11;
/** Height of one matrix heading line. */
const MATRIX_LINE = 12;

/** A {@link ChartSpec.matrix} column as drawn: its heading lines and its width. */
interface MatrixColumn {
	readonly lines: readonly string[];
	readonly width: number;
}

/** Each matrix column's heading, wrapped, and the width it takes (the heading's, or a dot's). */
function matrixColumns(spec: ChartSpec): MatrixColumn[] {
	return (spec.matrix ?? []).map(column => {
		const lines = wrapHeader(column.name, MATRIX_HEAD_CHARS);
		return { lines, width: Math.max(STATUS_WIDTH, ...lines.map(line => measure(line, TICK_SIZE))) + 12 };
	});
}

/** Each matrix column's centre; the matrix closes the label column. */
function matrixCentres(spec: ChartSpec, columns: readonly MatrixColumn[]): number[] {
	let x = PAD + labelColumnWidth(spec) - columns.reduce((sum, column) => sum + column.width, 0);
	return columns.map(column => {
		x += column.width;
		return x - column.width / 2;
	});
}

/**
 * The matrix columns' headings, a muted row between the header and the plot,
 * each centred over its column of dots and bottom-aligned when one wraps; a
 * single plotted series is headed too, at the plot's start, so the bars read
 * as the matrix's last column (no legend names it).
 */
function matrixHead(spec: ChartSpec): { height: number; body: string } {
	const columns = matrixColumns(spec);
	if (columns.length === 0) return { height: 0, body: "" };
	const lines = Math.max(...columns.map(column => column.lines.length));
	const centres = matrixCentres(spec, columns);
	const body = columns.flatMap((column, index) =>
		column.lines.map((line, at) =>
			text(centres[index]!, (lines - column.lines.length + at) * MATRIX_LINE + 6, line, {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "middle",
			}),
		),
	);
	if (spec.series.length === 1)
		body.push(
			text(PAD + labelColumnWidth(spec) + 10, (lines - 1) * MATRIX_LINE + 6, clip(spec.series[0]!.name, 40), {
				size: TICK_SIZE,
				fill: "muted",
			}),
		);
	return { height: lines * MATRIX_LINE + 4, body: body.join("") };
}

/** The matrix's dots, closing the label column: a status color per cell, a faint speck where a cell says none. */
function matrixDots(spec: ChartSpec, middle: (at: number) => number): string {
	const columns = matrixColumns(spec);
	const centres = matrixCentres(spec, columns);
	return (spec.matrix ?? [])
		.flatMap((column, index) =>
			spec.categories.map((_, at) => {
				const state = column.statuses[at];
				return state
					? dot(centres[index]!, middle(at), 4.5, STATUS_COLORS[state])
					: dot(centres[index]!, middle(at), 1.5, "muted", 0.6);
			}),
		)
		.join("");
}

/**
 * Characters a group name may take: {@link MAX_GROUP_CHARS}, or what short
 * members leave of the two budgets together (`canto-identity-protocol` beside `gpt-5.5`).
 */
function groupChars(groups: readonly ChartGroup[]): number {
	const widest = Math.max(
		0,
		...groups.flatMap(group => group.members.map(member => Math.min(member.length, MAX_LABEL_CHARS))),
	);
	return Math.max(MAX_GROUP_CHARS, MAX_LABEL_CHARS + MAX_GROUP_CHARS - widest);
}

/** Top of each category's row from `top`, a {@link GROUP_GAP} parting consecutive groups, then the bottom of the last row. */
function rowTops(spec: ChartSpec, top: number, rowHeight: number): number[] {
	const sizes = spec.groups?.map(group => group.members.length) ?? [spec.categories.length];
	const tops: number[] = [];
	let y = top;
	sizes.forEach((size, index) => {
		if (index > 0) y += GROUP_GAP;
		for (let at = 0; at < size; at++, y += rowHeight) tops.push(y);
	});
	tops.push(y);
	return tops;
}

/** Width of the category label column: the widest name, or the widest group name beside the widest member. */
function labelColumnWidth(spec: ChartSpec): number {
	const widest = (names: readonly string[]) =>
		Math.max(0, ...clipNames(names, MAX_LABEL_CHARS).map(name => measure(name, LABEL_SIZE)));
	const { groups } = spec;
	const width = groups
		? groupNameWidth(groups) + 10 + widest(groups.flatMap(group => group.members))
		: widest(spec.categories);
	const matrix = matrixColumns(spec).reduce((sum, column) => sum + column.width, 0);
	return Math.max(4 * LABEL_SIZE * ADVANCE, width) + (spec.status?.some(Boolean) ? STATUS_WIDTH : 0) + matrix;
}

/** Width of the widest semibold group name. */
function groupNameWidth(groups: readonly ChartGroup[]): number {
	const heads = clipNames(
		groups.map(group => group.name),
		groupChars(groups),
	);
	return Math.max(0, ...heads.map(name => measure(name, LABEL_SIZE) * SEMIBOLD_WIDTH));
}

/**
 * Labels for a linear axis' ticks in one unit, so it reads `0, 5k, 10k`
 * rather than `0, 5000, 10k`; a log axis spans units, each tick in its own.
 */
function tickFormat(scale: Scale, axis: { readonly dim: Dimension; readonly unit: string }): (tick: number) => string {
	if (scale.log) return tick => formatValue(tick, axis.dim, axis.unit);
	const magnitude = Math.max(0, ...scale.ticks.map(Math.abs));
	const { cut } = scale;
	// Each segment of a broken axis reads in its own unit (`100k` before the break, `7M` after).
	if (cut) return tick => formatValue(tick, axis.dim, axis.unit, tick <= cut.below ? cut.below : magnitude);
	return tick => formatValue(tick, axis.dim, axis.unit, magnitude);
}

/** A point's written figure, or its value formatted when the table wrote none. */
function pointText(series: ChartSeries, at: number): string {
	const point: ChartPoint | null | undefined = series.points[at];
	if (!point) return "";
	return point.text || formatValue(point.value, series.dim, series.unit);
}

/**
 * A value in base units as an axis label: durations and sizes in the unit,
 * counts compacted under the suffix (`12k`, `3.4M`), that `magnitude` reads
 * best in — the value's own size by default, an axis' largest tick to keep
 * its labels in one unit.
 */
export function formatValue(value: number, dim: Dimension, unit: string, magnitude = Math.abs(value)): string {
	switch (dim) {
		case "percent":
			return `${compact(value, magnitude)}%`;
		case "ratio":
			return `${compact(value, magnitude)}×`;
		case "currency":
			return `${value < 0 ? "-" : ""}${unit}${compact(Math.abs(value), magnitude)}`;
		case "duration": {
			const [divisor, suffix] =
				magnitude === 0
					? [1, "s"]
					: magnitude < 1e-6
						? [1e-9, "ns"]
						: magnitude < 1e-3
							? [1e-6, "µs"]
							: magnitude < 1
								? [1e-3, "ms"]
								: magnitude < 120
									? [1, "s"]
									: magnitude < 7200
										? [60, "m"]
										: magnitude < 172_800
											? [3600, "h"]
											: [86_400, "d"];
			return `${compact(value / divisor)}${suffix}`;
		}
		case "bytes": {
			const units = ["B", "KB", "MB", "GB", "TB"];
			let index = 0;
			while (magnitude >= 1000 ** (index + 1) && index < units.length - 1) index++;
			return `${compact(value / 1000 ** index)}${units[index]}`;
		}
		default:
			return compact(value, magnitude);
	}
}

/** `1234567` → `1.2M`, `0.0123` → `0.012`; the suffix follows `magnitude` (`5000` → `5k` beside `10k`). */
function compact(value: number, magnitude = Math.abs(value)): string {
	if (value === 0) return "0";
	if (magnitude >= 1e9) return `${trim(value / 1e9)}B`;
	if (magnitude >= 1e6) return `${trim(value / 1e6)}M`;
	if (magnitude >= 1e4) return `${trim(value / 1e3)}k`;
	return trim(value);
}

function trim(value: number): string {
	const magnitude = Math.abs(value);
	const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 3;
	return Number(value.toFixed(digits)).toString();
}

/** Narrow and wide glyphs of a UI sans (Geist, SF Pro, Helvetica Neue), for {@link measure}. */
const NARROW = "iljtfrI.,:;'!|()[] ";
const WIDE = "mwMW%@—";

/** Estimated width of `content` set in the chart's sans at `size`. */
function measure(content: string, size: number): number {
	let em = 0;
	for (const char of content) {
		if (NARROW.includes(char)) em += 0.3;
		else if (WIDE.includes(char)) em += 0.85;
		else if (char >= "0" && char <= "9") em += 0.58;
		else if (char >= "A" && char <= "Z") em += 0.66;
		else if (char.codePointAt(0)! >= 0x1100) em += 1;
		else em += 0.53;
	}
	return em * size;
}

function clip(content: string, chars: number): string {
	return content.length <= chars ? content : `${content.slice(0, Math.max(1, chars - 1))}…`;
}

/** `content` clipped to fit `width` user units at `size` (an em scale; pass the semibold width for bold text). */
function fitText(content: string, width: number, size: number): string {
	let chars = content.length;
	while (chars > 1 && measure(clip(content, chars), size) > width) chars--;
	return clip(content, chars);
}

/**
 * Category names clipped to `chars`, keeping their start; where two clip to
 * one label, an identifier or path (no spaces) keeps both ends instead
 * (`V12X_DAEM…TENV_DEV`), the end being where such names differ.
 */
function clipNames(names: readonly string[], chars: number): string[] {
	const clipped = names.map(name => clip(name, chars));
	const owners = new Map<string, string>();
	const clashing = new Set<string>();
	clipped.forEach((label, at) => {
		const owner = owners.get(label);
		if (owner === undefined) owners.set(label, names[at]!);
		else if (owner !== names[at]) clashing.add(label);
	});
	if (clashing.size === 0 || chars < 7) return clipped;
	const head = Math.ceil((chars - 1) / 2);
	return clipped.map((label, at) => {
		const name = names[at]!;
		if (!clashing.has(label) || /\s/.test(name)) return label;
		return `${name.slice(0, head)}…${name.slice(name.length - (chars - 1 - head))}`;
	});
}

function token(name: string): string {
	return `var(--${name})`;
}

function num(value: number): string {
	return Number(value.toFixed(1)).toString();
}

interface TextStyle {
	size?: number;
	fill: string;
	anchor?: "start" | "middle" | "end";
	weight?: number;
	italic?: boolean;
}

/** Text vertically centred on `y`. */
function text(x: number, y: number, content: string, style: TextStyle): string {
	if (!content) return "";
	const size = style.size ?? LABEL_SIZE;
	const attrs = [
		`x="${num(x)}"`,
		`y="${num(y + size * 0.35)}"`,
		`fill="${token(style.fill)}"`,
		size === LABEL_SIZE ? "" : `font-size="${size}"`,
		style.anchor && style.anchor !== "start" ? `text-anchor="${style.anchor}"` : "",
		style.weight ? `font-weight="${style.weight}"` : "",
		style.italic ? `font-style="italic"` : "",
	].filter(Boolean);
	const escaped = content.replace(/[&<>"]/g, char =>
		char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;",
	);
	return `<text ${attrs.join(" ")}>${escaped}</text>`;
}

/**
 * Text in a dark ink that reads on a strong fill of a series color in either
 * theme: series colors are bright on dark themes and mid-tone on light ones,
 * so the ink must be dark in both, yet neither `fg` (light on dark themes)
 * nor `surface` (light on light themes) is. The text draws in `fg`, then
 * twice in `surface` through a mask of `fg`'s own luminance: a light `fg`
 * (dark theme) lets the dark `surface` cover it, a dark `fg` (light theme)
 * masks it away and leaves `fg` itself. Tokens only, no theme branch.
 */
function ink(x: number, y: number, content: string, style: TextStyle): string {
	if (!content) return "";
	const cover = text(x, y, content, { ...style, fill: "surface" }).replace(
		"<text ",
		`<text mask="url(#${INK_MASK})" `,
	);
	return text(x, y, content, { ...style, fill: "fg" }) + cover + cover;
}

/** The mask {@link ink} draws through: `fg` everywhere, so its luminance decides how much `surface` covers. */
const INK_DEFS = `<defs><mask id="${INK_MASK}"><rect x="-10000" y="-10000" width="20000" height="20000" fill="var(--fg)"/></mask></defs>`;

/**
 * Annotation primitive: a soft `surface` band behind a highlighted row (or
 * column), under the marks and labels drawn after it.
 */
function band(x: number, y: number, width: number, height: number): string {
	return rect(x, y, width, height, "surface", 0.55, 4);
}

/** Annotation primitive: a dashed reference rule (a budget, a baseline value) over the gridlines. */
function referenceRule(x1: number, y1: number, x2: number, y2: number): string {
	return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${token("fg")}" stroke-width="1" stroke-dasharray="3 3" stroke-opacity="0.6"/>`;
}

/**
 * Annotation primitive: a callout — semibold `note` at `x`, joined to the mark
 * it explains by a dotted leader from `from` (both centred on `y`).
 */
function callout(from: number, y: number, x: number, note: string): string {
	const leader =
		x - 4 > from + 2
			? `<line x1="${num(from)}" y1="${num(y)}" x2="${num(x - 4)}" y2="${num(y)}" stroke="${token("muted")}" stroke-width="1" stroke-dasharray="1 2"/>`
			: "";
	return leader + text(x, y, note, { size: TICK_SIZE, fill: "fg", weight: 600 });
}

/**
 * A status word or prose standing where a cell holds no number: known
 * statuses ({@link cellStatus}) take their color, other short all-caps words
 * (`MISS`) warn, prose (`Binary blob churn`) recedes in muted italics.
 */
function noteText(x: number, y: number, note: string, centred = false): string {
	// A status word (`FAIL`, `ok`, `pending`) takes its status color.
	const said = cellStatus(note);
	const status = said !== undefined || /^[A-Z0-9 _/!-]{1,12}$/.test(note);
	return text(x, y, note, {
		size: TICK_SIZE,
		fill: said ? STATUS_COLORS[said] : status ? "warning" : "muted",
		italic: !status,
		anchor: centred ? "middle" : undefined,
	});
}

/** An occupied rectangle, for keeping labels apart. */
interface Box {
	readonly x0: number;
	readonly y0: number;
	readonly x1: number;
	readonly y1: number;
}

/** A rectangle with corners rounded by `corner` ({@link RADIUS} by default), less for one too small to hold it. */
function rect(
	x: number,
	y: number,
	width: number,
	height: number,
	fill: string,
	opacity: number,
	corner = RADIUS,
): string {
	const w = Math.max(0, width);
	const radius = Math.min(corner, w / 2, height / 2);
	const rounded = radius >= 0.5 ? ` rx="${num(radius)}"` : "";
	const alpha = opacity < 1 ? ` fill-opacity="${Number(opacity.toFixed(2))}"` : "";
	return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(height)}"${rounded} fill="${token(fill)}"${alpha}/>`;
}

/** A round-capped line. */
function line(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number, opacity = 1): string {
	const alpha = opacity < 1 ? ` stroke-opacity="${Number(opacity.toFixed(2))}"` : "";
	return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${token(stroke)}" stroke-width="${width}" stroke-linecap="round"${alpha}/>`;
}

/** A gridline: a hairline that recedes behind the marks. */
function rule(x1: number, y1: number, x2: number, y2: number): string {
	return line(x1, y1, x2, y2, "border", 1, GRID_OPACITY);
}

/** A rectangle's outline with corners rounded by {@link RADIUS}: the best cell of a heatmap column. */
function outline(x: number, y: number, width: number, height: number, stroke: string): string {
	return `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" rx="4" fill="none" stroke="${token(stroke)}" stroke-width="1.5"/>`;
}

/** The `best` mark beside a series' best value, in the success color. */
function bestTag(x: number, y: number, size: number): string {
	return text(x, y, "best", { size: size - 1, fill: "success", weight: 600 });
}

/**
 * The color a move by `factor` takes for a measure of `polarity`: `success`
 * when it improves, `error` when it regresses; none for a neutral measure or
 * a move within {@link STILL}.
 */
function moveTone(polarity: Polarity | undefined, factor: number): string | undefined {
	if (!polarity || !Number.isFinite(factor) || factor < 0) return undefined;
	// A drop to zero has no log, but it is a move all the same.
	if (factor > 0 && Math.abs(Math.log(factor)) < Math.log(STILL)) return undefined;
	return factor > 1 === (polarity === "higher") ? "success" : "error";
}

/** A hollow circle: a transition's starting value, or its legend mark. */
function ring(x: number, y: number, radius: number, stroke: string): string {
	return `<circle cx="${num(x)}" cy="${num(y)}" r="${radius}" fill="none" stroke="${token(stroke)}" stroke-width="1.75"/>`;
}

function dot(x: number, y: number, radius: number, fill: string, opacity = 1): string {
	const alpha = opacity < 1 ? ` fill-opacity="${Number(opacity.toFixed(2))}"` : "";
	return `<circle cx="${num(x)}" cy="${num(y)}" r="${radius}" fill="${token(fill)}"${alpha}/>`;
}
