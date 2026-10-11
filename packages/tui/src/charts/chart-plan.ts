/**
 * Which chart a table becomes and the data it plots. {@link planChart} is the
 * local best guess over a {@link TableAnalysis}: the chart kind, the label
 * column and the measure columns to draw. A host may substitute its own
 * {@link ChartPlan} (a model's pick for a multi-series table); either way
 * {@link buildChart} turns it into the {@link ChartSpec} that
 * {@link renderChartSvg} draws, and {@link worthCharting} decides whether
 * the picture says more than the table already does.
 *
 * The heuristics were fitted on ~7k tables from real assistant answers: the
 * label is the first text column (index columns like `#`/`Rank` never are),
 * table order is kept (most tables are deliberately unsorted), total rows stay
 * out of the scale, and units never share an axis. Rows whose labels repeat
 * (`Model | Harness | …`) are named by the text columns that tell them apart
 * ({@link ChartPlan.qualifiers}), nested under one of them
 * ({@link ChartPlan.group}) when it already runs in blocks; otherwise names
 * sharing a leading part nest under it (`glm new`, `glm prior`), and names are
 * shortened for display wherever they stay distinct. A row named as the
 * baseline becomes the {@link ChartPlan.reference} the others read against;
 * before/after values spanning decades, or rows of very different sizes
 * beside a baseline column, draw as factors of change.
 *
 * A plan also carries what the table means ({@link guessMeaning} locally, a
 * judge's answers in `smart` mode): which way each measure improves, what
 * competes, the rows it is about, a status column, and the one
 * {@link tableTakeaways | takeaway} stated as its title.
 */
import {
	type Cell,
	cellStatus,
	type Dimension,
	isMonotonic,
	isNumber,
	type NumberCell,
	parseCell,
	plainCell,
	type Status,
	type TableAnalysis,
	type TableColumn,
	writtenSlack,
} from "./table-data";

/**
 * Which way a measure improves: `higher` (pass rate, throughput, speedup) or
 * `lower` (cost, latency, errors). Measures that improve neither way (counts,
 * sizes, shares, ids) have none.
 */
export type Polarity = "higher" | "lower";

/** Which way a table's alternatives run: down its rows or across its plotted columns. */
export type Rivals = "rows" | "columns";

/**
 * Chart kinds, by the table shapes they fit:
 * - `bar`: one measure across categories.
 * - `paired`: one quantity under two conditions per category (before/after, old vs new), or `a → b` cells.
 * - `grouped`: two to four same-unit measures per category that are not one before/after pair.
 * - `stacked`: same-unit parts of one whole per category (`Cached + Uncached input + Output = Total`), one segmented bar each;
 *   outcome counts (`ok | fail`) as each category's mix ({@link ChartPlan.normalize}).
 * - `line`: measures over an ordered axis (dates, runs, sizes).
 * - `heatmap`: a matrix of same-unit values.
 * - `multiples`: measures in different units, each scaled on its own; transposed when each row is its own metric.
 * - `share`: parts of a whole in one bar: percentages summing to 100, or counts splitting one total (items by status).
 * - `diverging`: signed changes around zero.
 * - `scatter`: two continuous measures per item.
 * - `change`: metrics in different units against a baseline column (before/after), as factors.
 * - `progress`: scores out of a total (`12/12`), as filled tracks.
 * - `timeline`: one measure's rows laid end to end on one axis, in table order or at an offset column
 *   (pipeline steps to time scale, parts of a buffer at their offsets).
 * - `waterfall`: one measure's rows building up, step by step in table order, to their total (a total row
 *   or their sum), with any cap row as a rule.
 * - `dots`: two to six same-unit series per category as dots on one shared axis (a Cleveland dot plot),
 *   logarithmic when the values span decades; generalizes the dumbbell beyond two series.
 * - `range`: values written as `a–b` intervals, as floating bars from low to high, with an optional
 *   central estimate and a stated reference (a budget, a price, 1×); series in other units get their own band.
 */
export type ChartKind =
	| "bar"
	| "paired"
	| "grouped"
	| "line"
	| "heatmap"
	| "multiples"
	| "share"
	| "diverging"
	| "scatter"
	| "change"
	| "progress"
	| "stacked"
	| "timeline"
	| "waterfall"
	| "dots"
	| "range";

/** What to draw from a table: the kind, the columns naming each category, and the columns plotted. */
export interface ChartPlan {
	readonly kind: ChartKind;
	/** Column naming each category (or holding the x values of a line); rows are numbered without one. */
	readonly label: number | undefined;
	/** Columns joined to the label to tell rows apart (`Sonnet 5.5 · bash`); none by default. */
	readonly qualifiers?: readonly number[];
	/**
	 * Naming column whose values nest the rows: rows regroup by its values in
	 * order of first appearance (table order within each), and a label column
	 * writes each value once beside its block. Lines keep their x order and ignore it.
	 */
	readonly group?: number;
	/** Plotted columns, in order; a `change` measures the rest against the first (or its `a → b` cells). */
	readonly series: readonly number[];
	/**
	 * `change` over metric pairs (`Baseline Turns | Iter1 Turns | Baseline Tokens
	 * In | Iter1 Tokens In`): the baseline column of each series, in order, so
	 * each series is measured against its own before column instead of the first.
	 */
	readonly baselines?: readonly number[];
	/** Each data row is its own series (a metric with its own unit) and the plotted columns are the categories. */
	readonly transpose: boolean;
	/**
	 * Heatmap cells shaded on one scale across every cell (default), each
	 * series on its own, or each row on its own. A `series`-shaded heatmap of
	 * at most {@link MAX_PANELS} series draws as a grid of bars instead, each
	 * column on its own axis: its columns are different quantities.
	 */
	readonly shading?: Shading;
	/**
	 * Rows whose `column` cell reads `value` are the reference the others are
	 * read against (`Harness` = `baseline`), one per group; none by default.
	 */
	readonly reference?: RowReference;
	/**
	 * Rows ranked by a plotted column instead of table order (rankings,
	 * leaderboards); within each group when grouped. Lines and scatters keep
	 * their x order, `change` charts table order. Table order by default: most
	 * tables are deliberately ordered.
	 */
	readonly order?: RowOrder;
	/**
	 * `stacked`: the column the plotted parts make up (`Total`), labelling each
	 * bar with its written figure and drawing any rest it holds beyond the parts
	 * as an unlabelled track. Without it a bar ends at the parts' sum.
	 */
	readonly whole?: number;
	/**
	 * `stacked`: each bar spans 100% of its category's total (its whole, else
	 * its parts' sum), so rows of very different sizes compare by their mix.
	 * Absent: normalized when the parts are outcomes ({@link outcomeTones}:
	 * `ok | fail`, `Pass | Fail | Skip`), whose rates are the point, over
	 * totals {@link MIX_SPREAD}× apart or more.
	 */
	readonly normalize?: boolean;
	/**
	 * `timeline`: the column holding each segment's start (`Offset`, `Start`),
	 * in the plotted column's dimension; without it segments follow one another
	 * in table order from zero.
	 */
	readonly offsets?: number;
	/**
	 * `waterfall`: the row (by index) of a cap the steps build toward (`Hard
	 * cap`, `Budget`), drawn as a rule across the steps instead of a step.
	 */
	readonly limit?: number;
	/** Which way each column improves, by column index; neutral columns absent. */
	readonly polarity?: Readonly<Record<number, Polarity>>;
	/** Which way each row's metric improves, by row index, where rows are metrics ({@link rowsAreMetrics}). */
	readonly rowPolarity?: Readonly<Record<number, Polarity>>;
	/**
	 * What competes, so each contest's best value (by {@link polarity}) is
	 * marked: `rows` are alternatives scored by every measure (models,
	 * configs, arms: the best per column); `columns` are alternatives measured
	 * on every row (`Record | Map | string[]` per scenario: the best per row).
	 * Absent for parts of a whole, steps, or items described side by side.
	 */
	readonly rivals?: Rivals;
	/** Rows the table is about (the recommended option, `current`, `ours`, the bolded row), by row index. */
	readonly focus?: readonly number[];
	/** Column whose status cells (`ok`, `FAIL`, `pending`, ✅) badge each row's name. */
	readonly status?: number;
	/** The chart's title: one fact stated over it, the text of one of {@link tableTakeaways}; none by default. */
	readonly title?: string;
}

/** A naming cell marking reference rows: column index and cell text. */
export interface RowReference {
	readonly column: number;
	readonly value: string;
}

/** Rows sorted by `column`'s values, largest first (`descending`) or smallest first. */
export interface RowOrder {
	readonly column: number;
	readonly direction: "descending" | "ascending";
}

/**
 * How a heatmap shades its cells: `shared` compares every cell with every
 * other; `series` compares within each column (different quantities, like
 * input vs. reasoning tokens), so one large column does not wash out the
 * rest; `row` compares within each row (one measure across conditions, rows
 * of very different sizes), so one large row does not wash out the rest.
 */
export type Shading = "shared" | "series" | "row";

/** One plotted value. */
export interface ChartPoint {
	/** Value in base units (seconds, bytes, …). */
	readonly value: number;
	/** The number as the table wrote it (`~$250`, `12.5 ms`), shown as the value label. */
	readonly text: string;
	/** The table bolded the cell. */
	readonly emphasis: boolean;
	/** Upper end of a range cell (`24–72 h`). */
	readonly upper?: number;
}

export interface ChartSeries {
	readonly name: string;
	readonly dim: Dimension;
	/** Currency symbol or rate unit the axis prints; empty for other dimensions. */
	readonly unit: string;
	/** One per category; `null` where the cell holds no number of this series' dimension. */
	readonly points: readonly (ChartPoint | null)[];
	/** Status words standing in for a value (`TIMEOUT`, `OOM`), one per category. */
	readonly notes: readonly (string | undefined)[];
	/** Which way the series improves; absent when neutral. */
	readonly polarity?: Polarity;
	/** Category of the series' best value, marked when its rows are rivals; absent when tied or neutral. */
	readonly best?: number;
}

/** Consecutive categories sharing a leading name, which a label column writes once beside its members. */
export interface ChartGroup {
	/** The shared name; empty for a run of rows outside every group, written as members only. */
	readonly name: string;
	/** The rest of each member category's name, in order; empty where the group's name alone names the row. */
	readonly members: readonly string[];
}

/** The data a chart draws, independent of how it is drawn. */
export interface ChartSpec {
	readonly kind: ChartKind;
	/**
	 * One name per category: the label cell, joined with the cells that tell
	 * repeated labels apart (`Sonnet 5.5 · bash`); without groups, shortened
	 * for display where names stay distinct (`openai/gpt-5.5:xhi` → `gpt-5.5`).
	 */
	readonly categories: readonly string[];
	/**
	 * `categories` nested under their {@link ChartPlan.group} values
	 * (`Sonnet 5.5` → `baseline`, `bash`, `http`), covering them in order; without
	 * a group, under a leading part their names share (`glm new`, `glm prior` →
	 * `glm` → `new`, `prior`). Absent when neither applies, or when each series is a row.
	 */
	readonly groups?: readonly ChartGroup[];
	readonly series: readonly ChartSeries[];
	/**
	 * Numeric x positions of a line, the x measure of a scatter, or each
	 * `timeline` segment's start ({@link ChartPlan.offsets}), one per category.
	 */
	readonly x?: {
		readonly name: string;
		readonly dim: Dimension;
		readonly unit: string;
		readonly values: readonly number[];
	};
	/** Total/summary rows, printed under the chart instead of skewing its scale. */
	readonly caption?: string;
	/** Name of the category axis: the headers of the columns naming the rows. */
	readonly axis: string;
	/** What a `change` measures against (its baseline column); its points are factors of it. */
	readonly baseline?: string;
	/** How a heatmap shades its cells; `shared` when absent. */
	readonly shading?: Shading;
	/**
	 * Indices of the categories the others read against ({@link ChartPlan.reference}),
	 * at most one per group: bars and bar grids mark each with a dashed rule at
	 * its value through its group, and single bars print the others' change from it.
	 */
	readonly reference?: readonly number[];
	/** `stacked`: the whole each category's parts make up ({@link ChartPlan.whole}), one point per category. */
	readonly whole?: ChartSeries;
	/** `stacked`: each bar is its category's mix, parts as percentages of its total ({@link ChartPlan.normalize}). */
	readonly normalized?: boolean;
	/**
	 * Outcome of each part of a whole, coloring it `success`/`warning`/`error`/
	 * `muted` instead of a series color: per series of a `stacked` chart
	 * (`ok | fail` headers), per category of a `share` (`✅ Resolved`, `❌ Remaining`);
	 * `undefined` for a part naming none. Absent unless most parts read as
	 * statuses ({@link outcomeTones}) and they are not all alike.
	 */
	readonly tones?: readonly (Status | undefined)[];
	/**
	 * `waterfall`: the bar the steps build to — the table's total row as
	 * written, else the steps' sum written like their figures (`~$8.0M`).
	 */
	readonly total?: { readonly name: string; readonly point: ChartPoint };
	/**
	 * `range`: the central estimate of the first series' intervals, one point per category, from a
	 * plotted column whose values all fall inside them (`≈ $6,700` beside `$6.0k–7.3k`); drawn as a tick.
	 */
	readonly estimate?: ChartSeries;
	/**
	 * The one fact the chart states over it ({@link ChartPlan.title}: `Every
	 * scenario improved (median 14× less)`); no title line without one.
	 */
	readonly title?: string;
	/**
	 * Muted note beside the title. Absent: the renderer writes how the chart
	 * encodes the data where that is not obvious (`log scale`, `each column on its own scale`).
	 */
	readonly subtitle?: string;
	/**
	 * The two series of a `paired` chart are one quantity before and after
	 * (`a → b` cells, before/after headers per {@link isTransition}): drawn as a
	 * transition — a hollow muted start, a connector fading into the lead color,
	 * a solid end, and the figures as `a → b`. Otherwise the pair are peers
	 * (`xutf` vs `std`, two conditions without an order) drawn in two series
	 * colors without direction. Only condition pairs ({@link isConditionPair} or
	 * the judge's `pair`) draw as `paired` at all.
	 */
	readonly transition?: boolean;
	/** Marks laid over the chart by a planner: reference lines, highlighted categories, callouts. */
	readonly annotations?: readonly ChartAnnotation[];
	/**
	 * Each series is a table row (a metric in its own unit) and the categories
	 * are the plotted columns ({@link ChartPlan.transpose}); {@link axis} then
	 * names the series rather than the categories.
	 */
	readonly transposed?: boolean;
	/** Which way each category's metric improves where categories are metrics or items moving by a factor (`change`); neutral absent. */
	readonly categoryPolarity?: readonly (Polarity | undefined)[];
	/**
	 * Per category, the series holding its best value where the plotted
	 * columns are rivals sharing a unit and a polarity; absent where tied.
	 */
	readonly leaders?: readonly (number | undefined)[];
	/** Status of each category (`ok`, `FAIL`, `pending`), badged beside its name. */
	readonly status?: readonly (Status | undefined)[];
	/** Header of the column the {@link status} badges come from, named in their key. */
	readonly statusName?: string;
	/**
	 * Status columns the chart does not plot (`Preserves layout? | Machine-parseable? | Renderable?`),
	 * drawn as a matrix of status dots between the row names and the marks, each column headed by its
	 * name; two to {@link MAX_MATRIX}, in place of the single {@link status} badge.
	 */
	readonly matrix?: readonly StatusColumn[];
}

/** A status column of a {@link ChartSpec.matrix}: its header and each category's status. */
export interface StatusColumn {
	readonly name: string;
	readonly statuses: readonly (Status | undefined)[];
}

/** A fact a chart could state as its title, from {@link tableTakeaways}. */
export interface Takeaway {
	/** What the fact is about (`top:pass%`, `move:Build units`), unique among one chart's takeaways. */
	readonly key: string;
	readonly text: string;
	/** Striking on its figures alone (a large move, a far outlier, a sweep): worth stating without a judge. */
	readonly striking: boolean;
}

/**
 * A mark a planner lays over a chart; the renderer draws each kind where the
 * chart supports it (bar-like kinds and lines) and skips it elsewhere.
 * - `reference`: a dashed rule across the plot at `value` (base units of the
 *   first series), labelled at its end (`budget 200 ms`, `baseline`).
 * - `highlight`: a soft band behind category `category` (an index into
 *   {@link ChartSpec.categories}) and its label set in full strength.
 * - `callout`: short `text` beside the mark of `category` in `series` (default
 *   0) with a leader line (`60× the rest`, `fastest`).
 */
export type ChartAnnotation =
	| {
			readonly kind: "reference";
			readonly value: number;
			readonly label: string;
			/** Series whose axis the value is on, for charts with an axis per unit (`range` bands); 0 by default. */
			readonly series?: number;
	  }
	| { readonly kind: "highlight"; readonly category: number }
	| { readonly kind: "callout"; readonly category: number; readonly series?: number; readonly text: string };

const BEFORE =
	/\b(?:before|old|baseline|base|main|master|prev|previous|original|orig|cold|was|from|v1|stock|default|unpatched|without)\b/i;
const AFTER = /\b(?:after|new|patched|optimi[sz]ed|fixed|warm|now|to|v2|with|proposed|branch|pr|ours)\b/i;
const DELTA = /(?:Δ|delta|change|diff|improvement|speedup|reduction|savings|saved|gain|regression|% chg)/i;
/** Aggregate columns that restate the others; dropped when enough same-unit series remain. */
const AGGREGATE = /^(?:total|sum|cumulative|cum\.?|running total|avg|average|mean)\b/i;
/** The arrow of an `a → b` header or cell, with the spaces around it. */
const ARROW = /\s*(?:→|->|⇒)\s*/;
/** Row labels that name an ordered step (`Run 3`, `Day 2`, `N=1000`, `Q3`). */
const SEQUENCE_LABEL =
	/^(?:(?:run|day|week|month|iter(?:ation)?|round|step|phase|epoch|v|version|n\s*=|wave|attempt|pass|batch)\s*\d+(?:\.\d+)*|q[1-4]|#\s*\d{1,2})\b/i;
const MONTH = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
/** Distinct series colors (`c1`…`c6`): the most segments a stacked bar tells apart. */
const SERIES_COLORS = 6;
/** Most panels a small-multiples grid stays legible with. */
const MAX_PANELS = 6;
/** Most lines one line chart keeps apart. */
const MAX_LINES = 6;
/** Most series grouped bars hold; more draw as a heatmap. */
const MAX_GROUPED = 4;
/** Spread of a dumbbell's values (max/min) from which it reads as factors of change instead. */
const DECADES = 100;
/** Typical ratio between two rows from which grouped bars against a baseline column read as its factors. */
const ROW_SPREAD = 8;
/** Ratio between columns' (or rows') typical sizes from which a heatmap shades each on its own. */
const QUANTITY_SPREAD = 30;
/** Typical spread within a row (max/min) a heatmap needs before each row shades on its own. */
const ROW_CONTRAST = 1.5;
/** Words naming a reference row, strongest first. */
const REFERENCE_WORDS = [
	"baseline",
	"control",
	"reference",
	"before",
	"original",
	"stock",
	"default",
	"main",
	"master",
	"current",
];
/** A row name saying it is the reference: leading the name (`baseline`, `current-api …`) or marked (`#1 (baseline)`). */
const REFERENCE_ROW = new RegExp(
	String.raw`^(?<lead>${REFERENCE_WORDS.join("|")})\b|\((?<marked>${REFERENCE_WORDS.join("|")})\)`,
	"i",
);
/** Most series a `progress` pick draws as tracks per category; more read as bars or a heatmap. */
const MAX_TRACKS = 3;
/** Smallest factor (either way) that makes a `change` chart say more than its table. */
const NOTABLE_FACTOR = 1.5;
/** Joins the parts of a row's name (`Sonnet 5.5 · bash`). */
const NAME_JOIN = " · ";
/** Longest cell a column may hold to help name its row; longer text describes the row rather than naming it. */
const MAX_NAME_PART = 40;
/** Longest row name {@link tidyNames} leaves whole: the renderer's label budget. */
const MAX_LABEL = 28;
/** Shortest leading part {@link nestNames} writes as a group name (`glm`, not `A`). */
const MIN_NEST_HEAD = 3;
/** Share of rows {@link nestNames} must nest for an outline to read better than flat names. */
const NEST_SHARE = 0.6;
/** Text a row's prose columns hold (by their median cells) from which the prose carries the table ({@link proseLed}). */
const PROSE_CELL = 40;
/** Largest whole number a chart may plot beside a table's prose and still restate it ({@link proseLed}). */
const MAX_PROSE_COUNT = 5;
/** Where a row name splits into a group and a member, most telling first (`char index, emoji`, `glm new`, `sofa-arm`). */
const NEST_SEPARATORS = [" — ", " – ", ": ", " · ", ", ", " ", "/", "-", "_"];
/** Where a long row name's description starts (`Payroll (10 people…)`, `@watzon — #19, #53`). */
const DESCRIPTION = / [—–] | - |: | \(/;

/**
 * Measures that improve upward, by header: pass and success rates, retrieval
 * scores, throughput, speedups and savings.
 */
const HIGHER_BETTER =
	/(?:^|[^\w])(?:pass(?:ed|es|ing)?|pass ?%|pass ?rate|success(?:es|ful)?|succeeded|accuracy|acc|recall|precision|prec|f1|em|exact[_ ]?match|scores?|wins?|win ?rate|hit ?rate|throughput|qps|rps|ops\/s|req\/s|tok\/s|tokens\/s|speedup|faster|improvement|savings?|saved|gain|coverage|quality|relevance|correct|solved|ok|renders|completion ?rate|uptime|per \$|\/\$)(?![\w])/i;
/** Measures that improve downward, by header: cost, time, failures. */
const LOWER_BETTER =
	/(?:^|[^\w])(?:cost|costs|price|bill|spend|usd|latency|time|duration|wall(?: ?clock)?|elapsed|errors?|err|fail(?:s|ed|ures?)?|timeouts?|miss(?:es)?|crash(?:es)?|regressions?|bugs?|warnings?|retries|turns|p\d{2}|blockers|violations|leaks?|stalls?|load|\$\/\w+)(?![\w])/i;
/** Resources a before/after change aims to shrink: lower is better only beside a baseline. */
const LOWER_IN_CHANGE =
	/(?:^|[^\w])(?:tokens?|tok|rss|memory|mem|heap|allocs?|allocations?|clones|size|bytes|cpu|gc|input|output)(?![\w])/i;
/** Names of shares and counts that describe rather than score: no polarity whatever else they say. */
const NEUTRAL = /(?:^|[^\w])(?:share|shares|% of|portion|fraction|distribution|breakdown)(?![\w])/i;
/** Label headers naming rival options a table compares (models, configs, arms). */
const RIVALS =
	/(?:^|[^\w])(?:models?|config(?:uration)?s?|arms?|variants?|approach(?:es)?|options?|plans?|polic(?:y|ies)|providers?|modes?|strateg(?:y|ies)|candidates?|settings?|shapes?|backends?|engines?|librar(?:y|ies)|implementations?|vendors?|tools?|methods?|algorithms?|setups?|runs?)(?![\w])/i;
/** Label headers naming the ordered steps of one run (`Step`, `CI stage`, `Phase`): their durations lie end to end. */
const STEP_HEADER = /^(?:(?:ci|pipeline|build|job|run)\s+)?(?:steps?|stages?|phases?)(?:\s+name)?$/i;
/** Headers of a column holding where each row starts on a shared axis (`Offset`, `Start`, `Address`). */
const OFFSET_HEADER = /^(?:(?:byte|vertex|index|file|start)\s+)?(?:offset|start|begin|addr(?:ess)?)(?:\s*\(.*\))?$/i;
/** Label headers naming parts one sum is made of (`Bucket`, `Line item`, `Expense`). */
const PART_HEADER =
	/^(?:buckets?|(?:line\s+)?items?|components?|categor(?:y|ies)|expenses?|costs?|allocations?|use of funds|parts?|breakdown)$/i;
/** Amounts per unit (`Price`, `$/1M tok`, `Avg cost`): no sum of them means anything. */
const PER_UNIT = /\/|\bper\b|\bprice\b|\brate\b|\bavg\b|\baverage\b|\bmean\b|\beach\b|\bunit\b|\bmedian\b|\bp\d{2}\b/i;
/** A last row naming the cap a plan's steps build toward (`Hard cap`, `Budget`, `Limit`). */
const LIMIT_ROW = /\b(?:cap|limit|budget|ceiling|allowance|quota)\b/i;
/** Dimensions whose rows add up along one axis. */
const FLOW_DIMS: Partial<Record<Dimension, true>> = { count: true, duration: true, bytes: true, currency: true };
/** Most steps a waterfall or a timeline of consecutive rows keeps legible. */
const MAX_STEPS = 12;
/** Most segments a timeline at explicit offsets lays out (named in groups where names share a part). */
const MAX_SEGMENTS = 40;
/** Share of a run one step may take before the rest shrink to slivers: bars read such a table better. */
const MOST_OF_RUN = 0.9;
/** A row name drawn as a branch of a tree (`└ full clone`, `├─ parse`, `↳ retry`) or indented under another. */
const TREE_NAME = /^(?:\s|&nbsp;|\u00a0)*[└├↳┗┣╰]|^(?:&nbsp;|\u00a0){2,}/;
/** A step named as a total the table's total rows miss (`total_ms`, `Overall`): the rows are no flat run. */
const TOTAL_NAME = /^(?:total|overall|grand|sum)(?:\b|_)/i;
/** A row name saying it is the whole of others (`End-to-end wall`, `All tests`, `Overall`). */
const WHOLE_NAME = /\b(?:total|overall|all|whole|end[- ]to[- ]end|wall(?:[- ]?clock)?|combined|sum)\b/i;
/** Steps per rise a descending list of parts may hold and still read as a ranking. */
const RANKED_RISES = 8;
/** Row names marking one of several variants of the same step (`(before)`, `(new)`). */
const VARIANT_NAME = /\b(?:before|after|old|new|baseline|current|cold|warm)\b/i;
/** Count headers naming a quantity that builds up (`Tokens`, `Lines saved`), not things counted. */
const AMOUNT_HEADER =
	/\b(?:tokens?|lines?|loc|sloc|chars?|characters|words|bytes|calls|requests|cost|spend|budget|amount)\b/i;
/** Share of an offset column's rows that must start where the row before ends for it to lay them out. */
const CONTIGUOUS = 0.75;
/** Row names that point at the row a table is about. */
const FOCUS_NAME =
	/\((?:current|ours|recommended|chosen|selected|winner|best|shipped|proposed|pick)\b[^)]*\)|(?:^|[^\w])(?:ours|recommended)(?![\w])|[✅⭐★]/i;

/** The local best guess at a chart for `table`, or `undefined` when no chart fits. */
export function planChart(table: TableAnalysis): ChartPlan | undefined {
	const shape = guessShape(table);
	if (!shape) return undefined;
	const plan = { ...shape, ...guessMeaning(table, shape) };
	// Unprompted, a title states only a fact the figures alone make striking.
	const lead = tableTakeaways(table, plan).find(fact => fact.striking);
	return lead ? { ...plan, title: lead.text } : plan;
}

/**
 * Whether a model should pick `table`'s chart (`tui.autoGraph: smart`):
 * multi-series tables, and tables whose rows may be named by a number the
 * `guess` plots (`Thread | State`, `Finding | Current`), where only meaning
 * tells a name from a measure.
 */
export function shouldJudge(table: TableAnalysis, guess: ChartPlan | undefined): boolean {
	if (!guess || table.rows.length < 3) return false;
	return table.measures.length >= 2 || leadingMeasures(table, guess).length > 0;
}

/** Measure columns before `guess`'s text label column: numbers that may only name their rows. */
export function leadingMeasures(table: TableAnalysis, guess: ChartPlan): TableColumn[] {
	const label = guess.label === undefined ? undefined : table.columns[guess.label];
	if (label?.role !== "label") return [];
	return table.measures.filter(column => column.index < label.index);
}

/**
 * Facts about `table` a chart could state as its headline under `plan`'s
 * meaning, whatever chart it draws, strongest first: those of `plan`'s own
 * chart (its moves, its trend) and of every measure side by side (a row best
 * on measures the chart leaves out), under each of `contests` (`plan`'s own
 * {@link ChartPlan.rivals} by default; a judge is offered either reading's).
 */
export function tableTakeaways(
	table: TableAnalysis,
	plan: ChartPlan,
	contests: readonly (Rivals | undefined)[] = [plan.rivals],
): Takeaway[] {
	const measures = table.measures.filter(column => column.index !== plan.label).map(column => column.index);
	const wide = !(plan.kind === "change" || plan.transpose || measures.length <= plan.series.length);
	const facts: Fact[] = [];
	for (const rivals of contests) {
		const drawn = buildChart(table, { ...plan, rivals });
		if (drawn) facts.push(...chartFacts(drawn));
		const side = wide && buildChart(table, { ...plan, rivals, kind: "grouped", series: measures });
		if (side) facts.push(...chartFacts(side));
	}
	return rankFacts(facts);
}

/**
 * The local guess at what `plan`'s rows and measures mean: header keywords
 * for each measure's {@link Polarity} (resources like tokens or memory only
 * beside a baseline), rivals from the label's header, focus from bolded or
 * `(current)` row names, and a status column whose cells vary.
 */
export function guessMeaning(
	table: TableAnalysis,
	plan: ChartPlan,
): Pick<ChartPlan, "polarity" | "rowPolarity" | "rivals" | "focus" | "status"> {
	const label = plan.label === undefined ? undefined : table.columns[plan.label];
	const change = plan.kind === "change" || table.columns.some(column => BEFORE.test(column.header));
	const polarity: Record<number, Polarity> = {};
	for (const column of table.columns) {
		if (column === label) continue;
		// A signed delta's sign convention (saved vs. spent) is not in its unit.
		const delta = DELTA.test(column.header) || column.signedShare >= 0.5;
		const guessed =
			headerPolarity(column.header, change) ??
			(column.role === "measure" && !delta
				? dimPolarity(column.dim, column.unit, change, column.scores)
				: undefined);
		if (guessed) polarity[column.index] = guessed;
	}
	const rowPolarity: Record<number, Polarity> = {};
	if (label && rowsAreMetrics(table, plan))
		for (const row of [...table.rows, ...table.totals]) {
			const first = plan.series.map(index => table.columns[index]!.cells[row]).find(isNumber);
			const guessed =
				headerPolarity(label.cells[row]!.text, true) ??
				(first ? dimPolarity(first.dim, first.unit, true, false) : undefined);
			if (guessed) rowPolarity[row] = guessed;
		}
	return {
		polarity,
		rowPolarity,
		rivals: label !== undefined && RIVALS.test(label.header) ? "rows" : undefined,
		focus: guessFocus(table, label),
		status: guessStatus(table, plan),
	};
}

/** Whether `plan`'s rows may each be a metric of their own: a `change`, a transposed table, or mixed-unit columns. */
export function rowsAreMetrics(table: TableAnalysis, plan: ChartPlan): boolean {
	return plan.kind === "change" || plan.transpose || plan.series.some(index => table.columns[index]?.mixed);
}

/**
 * A measure's {@link Polarity} from its name (`undefined` when it names
 * none); `change` admits resources a change aims to shrink.
 */
function headerPolarity(name: string, change: boolean): Polarity | undefined {
	// `gtTagRelevance`: camelCase words read apart.
	const plain = plainCell(name).text.replace(/([a-z])([A-Z])/g, "$1 $2");
	if (NEUTRAL.test(plain)) return undefined;
	if (HIGHER_BETTER.test(plain)) return "higher";
	if (LOWER_BETTER.test(plain)) return "lower";
	if (change && LOWER_IN_CHANGE.test(plain)) return "lower";
	return undefined;
}

/**
 * A measure's {@link Polarity} from its unit when its name gives none:
 * scores out of a total and rates per second climb, durations shrink, and
 * money and sizes shrink beside a baseline.
 */
function dimPolarity(dim: Dimension | undefined, unit: string, change: boolean, scores: boolean): Polarity | undefined {
	if (scores) return "higher";
	if (dim === "rate" && unit.endsWith("/s")) return "higher";
	if (dim === "duration") return "lower";
	// Money and sizes may be value or budget (`Per 30 days`, `Amount`); beside a baseline they are what a change cuts.
	if ((dim === "currency" || dim === "bytes") && change) return "lower";
	return undefined;
}

/**
 * Rows the table singles out: a minority of rows whose names (or most of
 * whose numbers) are bolded, else rows named `(current)`, `(recommended)`, ✅.
 */
function guessFocus(table: TableAnalysis, label: TableColumn | undefined): number[] {
	const { rows } = table;
	if (!label || rows.length < 2) return [];
	const measures = table.measures;
	const bolded = rows.filter(row => {
		if (label.cells[row]!.emphasis) return true;
		const numbers = measures.map(column => column.cells[row]).filter(isNumber);
		return numbers.length >= 2 && numbers.filter(cell => cell.emphasis).length * 2 > numbers.length;
	});
	if (bolded.length > 0 && bolded.length * 3 <= rows.length + 1) return bolded;
	const named = rows.filter(row => FOCUS_NAME.test(label.cells[row]!.text));
	return named.length > 0 && named.length * 3 <= rows.length + 1 ? named : [];
}

/** A text or measure column (not naming the rows) whose cells lead with statuses that are not all alike. */
function guessStatus(table: TableAnalysis, plan: ChartPlan): number | undefined {
	const naming = new Set([plan.label, ...(plan.qualifiers ?? [])]);
	return table.columns.find(column => {
		if (naming.has(column.index) || !column.statuses) return false;
		const seen = new Set(table.rows.map(row => column.statuses![row]).filter(Boolean));
		return seen.size >= 2;
	})?.index;
}

/** The local guess at a chart's kind, label and series for `table`. */
function guessShape(table: TableAnalysis): ChartPlan | undefined {
	const { rows } = table;
	let label = table.label;
	const change = changeColumns(table);
	if (change)
		return {
			kind: "change",
			label: label?.index,
			...guessNaming(table, label),
			series: change.map(column => column.index),
			transpose: false,
		};
	const pairs = metricPairs(table.measures);
	if (pairs.length >= 2)
		return {
			kind: "change",
			label: label?.index,
			...guessNaming(table, label),
			series: pairs.map(([, after]) => after.index),
			baselines: pairs.map(([before]) => before.index),
			transpose: false,
		};
	let measures = dropAggregates(table.measures);
	if (measures.length === 0 || rows.length < 2) return undefined;

	let order = axisOrder(table, label);
	// Without a name column, a monotonic leading measure (`Workers | p50 | p99`) is the
	// x axis of the rest (the name of each row, under four rows); beside one it is just
	// a sorted measure (`% | Self | Function`).
	if (!order && label?.role !== "label" && measures.length >= 2 && measures[0]!.index === 0) {
		const xs = columnValues(measures[0]!, rows);
		if (xs.length === rows.length && isMonotonic(xs)) {
			label = measures[0];
			measures = measures.slice(1);
			if (rows.length >= 4) order = "numeric";
		}
	}
	if (proseLed(table, measures)) return undefined;
	const naming = guessNaming(table, label);
	const reference = guessReference(table, label, naming.qualifiers);
	const plan = (kind: ChartKind, series: readonly TableColumn[], transpose = false): ChartPlan => ({
		kind,
		label: label?.index,
		...naming,
		...(reference && { reference }),
		series: series.map(column => column.index),
		transpose,
	});

	// `a → b` cells: one axis when the rows share a unit, factors of change when each row has its own.
	if (measures.length === 1 && measures[0]!.arrowShare >= 0.6)
		return plan(measures[0]!.mixed ? "change" : "paired", measures);
	// Several `a → b` columns (`mean before → after | p99 before → after`): each moves by its own factor.
	const arrows = measures.filter(column => column.arrowShare >= 0.6);
	if (arrows.length >= 2) return plan("change", arrows);
	const composition = table.composition;
	if (composition && composition.parts.every(index => index !== label?.index))
		return {
			...plan(
				"stacked",
				composition.parts.map(index => table.columns[index]!),
			),
			whole: composition.whole,
		};
	// Outcome counts (`ok | fail`, `Pass | Fail | Skip`) are parts of each row's attempts even without a total column.
	const outcomes = outcomeColumns(measures);
	if (outcomes) return plan("stacked", outcomes);
	const flow = guessFlow(table, label, measures);
	if (flow)
		return {
			...plan(flow.kind, [flow.column]),
			...(flow.offsets !== undefined && { offsets: flow.offsets }),
			...(flow.limit !== undefined && { limit: flow.limit }),
		};
	const mixed = measures.filter(column => column.mixed);
	if (mixed.length > 0 && mixed.length * 2 >= measures.length) return plan("multiples", measures, true);
	// Values written as `a–b` float from low to high: a bar from zero would hide where each interval starts.
	// Most measures must be among them; otherwise panels keep the other quantities.
	const ranges = rangeColumns(measures, rows);
	if (ranges && ranges.length * 2 > measures.length) return plan("range", ranges);

	const dims = new Set(measures.map(column => column.dim));
	if (measures.length >= 2 && measures.length <= 4) {
		const before = measures.find(column => BEFORE.test(column.header));
		const after = measures.find(
			column => column !== before && column.dim === before?.dim && AFTER.test(column.header),
		);
		if (before && after) return plan("paired", [before, after]);
	}
	if (rows.length === 2 && measures.length === 1) return undefined;
	if (order && rows.length >= 4) {
		const lead = measures[0]!.dim;
		return plan("line", measures.filter(column => column.dim === lead).slice(0, MAX_LINES));
	}
	// Several score columns compare like any same-unit measures (as rates); a lone one fills tracks.
	if (measures.length === 1 && measures[0]!.scores) return plan("progress", measures);
	if (measures.length <= 2) {
		const delta = measures.find(
			column =>
				(column.signedShare >= 0.6 || DELTA.test(column.header)) &&
				columnValues(column, rows).some(value => value < 0),
		);
		if (delta) return plan("diverging", [delta]);
	}
	const share = measures.find(column => column.dim === "percent" && !column.scores);
	if (share && rows.length <= 10 && (measures.length === 1 || (measures.length === 2 && dims.size === 2))) {
		const values = columnValues(share, rows);
		const sum = values.reduce((total, value) => total + value, 0);
		if (values.every(value => value >= 0) && sum >= 97 && sum <= 103) return plan("share", [share]);
	}
	if (measures.length === 1 && splitsTotal(table, label, measures[0]!)) return plan("share", measures);
	if (dotsFit(measures, rows)) return plan("dots", measures);
	if (dims.size === 1 && measures.length >= 4 && rows.length >= 3)
		return { ...plan("heatmap", measures), shading: guessShading(measures, rows) };
	if (!label && measures.length === 2 && rows.length >= 6) return plan("scatter", measures);
	if (dims.size >= 2) return plan("multiples", measures.slice(0, MAX_PANELS));
	if (measures.length === 2)
		return plan(isConditionPair(measures[0]!.header, measures[1]!.header) ? "paired" : "grouped", measures);
	if (measures.length >= 3) return plan("grouped", measures);
	return plan("bar", measures);
}

/** Most parts a count column may split its total into and still draw as one bar. */
const MAX_SHARE_PARTS = 6;
/** Relative slack between a total row and its parts' sum where either is written as an estimate (`~3900`). */
const APPROX_SUM = 0.02;
/** Headers that only say a column counts something (`count`, `n`, `#`). */
const COUNT_HEADER = /^(?:count|counts|cnt|n|#|number|num|items|tally|freq|frequency)$/i;
/** Label headers naming a classification of one population, each row one bucket of it (`Severity`, `Verdict`). */
const BUCKET_HEADER =
	/^(?:status|state|verdict|outcome|result|severity|priority|bucket|cohort|category|class|type|kind|tier|level|grade|cause|reason|disposition|resolution)$/i;

/**
 * Whether `column`'s counts split one total among its rows, so their shares of
 * it are the point (`ported 248 | redesigned 125 | … | missing 786`): 3 to
 * {@link MAX_SHARE_PARTS} rows of whole counts, and either a total row the
 * counts add up to (exactly, or within {@link APPROX_SUM} where one is written
 * `~`), or a label header naming buckets ({@link BUCKET_HEADER}, or none)
 * beside a count header ({@link COUNT_HEADER}, or none).
 */
function splitsTotal(table: TableAnalysis, label: TableColumn | undefined, column: TableColumn): boolean {
	const { rows } = table;
	if (label?.role !== "label" || column.dim !== "count" || column.unit || column.scores) return false;
	if (rows.length < 3 || rows.length > MAX_SHARE_PARTS) return false;
	const values = columnValues(column, rows);
	if (values.length !== rows.length || values.some(value => value < 0 || !Number.isInteger(value))) return false;
	if (values.filter(value => value > 0).length < 2) return false;
	const sum = values.reduce((total, value) => total + value, 0);
	const approx = rows.some(row => {
		const cell = column.cells[row];
		return isNumber(cell) && cell.approx;
	});
	const totalled = table.totals.some(row => {
		const cell = column.cells[row];
		return isNumber(cell) && Math.abs(cell.value - sum) <= (approx || cell.approx ? APPROX_SUM * sum : 0.5);
	});
	return (
		totalled ||
		((!label.header || BUCKET_HEADER.test(label.header)) && (!column.header || COUNT_HEADER.test(column.header)))
	);
}

/**
 * Same-unit count or percent measures whose headers each lead with an outcome
 * (`ok | fail`, `Pass | Partial | Fail`) of more than one kind: the parts of
 * each row's attempts, read as its mix.
 */
export function outcomeColumns(measures: readonly TableColumn[]): TableColumn[] | undefined {
	const first = measures.find(column => cellStatus(column.header));
	if (!first || (first.dim !== "count" && first.dim !== "percent") || first.scores) return undefined;
	const parts = measures.filter(
		column =>
			column.dim === first.dim &&
			column.unit === first.unit &&
			!column.scores &&
			column.signedShare === 0 &&
			cellStatus(column.header),
	);
	return parts.length >= 2 && outcomeTones(parts.map(column => column.header)) ? parts : undefined;
}

/** Share of parts that must read as outcomes before the parts take outcome colors. */
const TONED_SHARE = 2 / 3;

/**
 * The outcome each of `names` leads with (`ok`, `FAIL`, ✅, or none) when at
 * least {@link TONED_SHARE} of them lead with one, `good` and something else
 * among them: parts colored by what they say rather than by series
 * (`✅ FIXED | 🟡 PARTIAL | 🎨 VISUAL? | ❌ OPEN`). `undefined` otherwise.
 */
export function outcomeTones(names: readonly string[]): (Status | undefined)[] | undefined {
	const tones = names.map(name => cellStatus(name));
	const said = tones.filter(tone => tone !== undefined);
	if (said.length < 2 || said.length < TONED_SHARE * tones.length) return undefined;
	return said.includes("good") && said.some(tone => tone !== "good") ? tones : undefined;
}

/** Rows read as one run of steps: the kind, the plotted column, and any offset column or cap row. */
interface Flow {
	readonly kind: "timeline" | "waterfall";
	readonly column: TableColumn;
	readonly offsets?: number;
	readonly limit?: number;
}

/**
 * Rows that lie end to end on one axis, read from the values and headers:
 * - parts at an offset column (`Offset` 0, 16, 20 beside `Verts` 16, 4, 8) — a `timeline` at those offsets;
 * - durations of a run's steps (a `Step`/`Stage`/`Phase` label, a total row they sum to, or a running
 *   `Cumulative` column) — a `timeline` in table order;
 * - amounts building to a total row they sum to, toward a cap row (`Hard cap`), beside a running total, or
 *   listed as parts (`Bucket`, `Line item`) — a `waterfall`.
 * Shares (percent) stay `share`; amounts per unit (`Price`) and deltas without a total never add up.
 */
function guessFlow(
	table: TableAnalysis,
	label: TableColumn | undefined,
	measures: readonly TableColumn[],
): Flow | undefined {
	const { rows } = table;
	if (label?.role !== "label" || rows.length < 3) return undefined;
	if (rows.length <= MAX_SEGMENTS)
		for (const offsets of table.columns) {
			if (offsets === label || !OFFSET_HEADER.test(offsets.header)) continue;
			const size = measures.find(column => column !== offsets && laidOut(offsets, column, rows));
			if (size) return { kind: "timeline", column: size, offsets: offsets.index };
		}
	// A running column beside its steps (`Time | Cumulative`) restates them, within the precision written.
	const steps = measures.filter(column => !measures.some(other => other !== column && endsOf(column, other, rows)));
	if (steps.length !== 1) return undefined;
	const column = steps[0]!;
	const running =
		steps.length < measures.length ||
		table.columns.some(other => other.restates === column.index && endsOf(other, column, rows));
	if (!column.dim || !FLOW_DIMS[column.dim] || column.scores || column.mixed || PER_UNIT.test(column.header))
		return undefined;
	const cells = rows.map(row => flowCell(column, row));
	if (cells.some(cell => !cell)) return undefined;
	const values = cells.map(cell => cell!.value);
	const negative = values.some(value => value < 0);
	const totalRow = table.totals.find(row => flowCell(column, row));
	const sums = totalRow !== undefined && addsUp(cells as NumberCell[], flowCell(column, totalRow)!);
	// A total the rows miss is a subset or overlapping parts, not one run.
	if (totalRow !== undefined && !sums) return undefined;
	const last = rows.at(-1)!;
	// A cap stands above every step it caps (`Hard cap` $9.50 over `Video` $5.10).
	const capped =
		column.dim !== "duration" &&
		!negative &&
		!sums &&
		rows.length >= 4 &&
		LIMIT_ROW.test(label.cells[last]!.text) &&
		values.at(-1)! >= Math.max(...values.slice(0, -1));
	const run = (capped ? cells.slice(0, -1) : cells) as NumberCell[];
	if (run.length > MAX_STEPS) return undefined;
	// No one step may be nearly all of the run; without a total row to vouch for them, steps must be flat
	// parts (no row summing others: `Evaluated` over `Landed` and `Rejected`).
	const sizes = run.map(cell => Math.abs(cell.value));
	const names = rows.map(row => label.cells[row]!.text);
	if (
		Math.max(...sizes) > MOST_OF_RUN * sizes.reduce((a, b) => a + b, 0) ||
		names.some(name => TOTAL_NAME.test(name)) ||
		(!sums && nested(run, names))
	)
		return undefined;
	if (column.dim === "duration") {
		// Before/after variants of one step (`js-release (before)`, `(after)`) are alternatives, and a total per
		// row (`Total wall` after each change) a state, not a run.
		const variants = names.filter(name => VARIANT_NAME.test(name)).length;
		if (negative || variants >= 2 || WHOLE_NAME.test(column.header)) return undefined;
		return STEP_HEADER.test(label.header) || sums || running ? { kind: "timeline", column } : undefined;
	}
	// Amounts that build up: money, sizes, and counts of a quantity (tokens, lines), not of things (issues, PRs).
	if (column.dim === "count" && !AMOUNT_HEADER.test(column.header)) return undefined;
	// Listed parts alone (`Bucket | Amount`) in descending order (one rise in eight steps allowed) are a
	// ranking: bars read it.
	const rises = values.filter((value, at) => at > 0 && value > values[at - 1]!).length;
	const parts = !negative && PART_HEADER.test(label.header) && rises * RANKED_RISES > values.length - 1;
	if (!(sums || capped || running || parts)) return undefined;
	return { kind: "waterfall", column, ...(capped && { limit: last }) };
}

/**
 * Rows over more than one level of parts: names drawn as a tree (`└ full
 * clone`), or a row named as a whole (`End-to-end wall`) summing two or more
 * rows right after (or right before) it within written precision.
 */
function nested(cells: readonly NumberCell[], names: readonly string[]): boolean {
	if (names.some(name => TREE_NAME.test(name))) return true;
	return cells.some(
		(parent, at) =>
			WHOLE_NAME.test(names[at] ?? "") &&
			[1, -1].some(direction => {
				const run: NumberCell[] = [];
				for (let next = at + direction; next >= 0 && next < cells.length; next += direction) {
					run.push(cells[next]!);
					if (run.length >= 2 && addsUp(run, parent)) return true;
				}
				return false;
			}),
	);
}

/** The cell of `column` at `row` as one plain number of the column's dimension (no range or transition). */
function flowCell(column: TableColumn, row: number): NumberCell | undefined {
	const cell = column.cells[row];
	return isNumber(cell) && cell.dim === column.dim && cell.upper === undefined && cell.to === undefined
		? cell
		: undefined;
}

/** `cells` sum to `total` within the precision they were written in. */
function addsUp(cells: readonly NumberCell[], total: NumberCell): boolean {
	const sum = cells.reduce((acc, cell) => acc + cell.value, 0);
	const slack = cells.reduce((acc, cell) => acc + writtenSlack(cell), writtenSlack(total));
	return Math.abs(sum - total.value) <= slack + 1e-9 * Math.abs(total.value);
}

/**
 * `offsets` places each row of `size` on one axis: both plain numbers of one
 * dimension in every row, starts never falling back, and at least
 * {@link CONTIGUOUS} of the rows starting where the one before ends (`Offset`
 * 0, 16, 20 beside `Verts` 16, 4, 8); a gap or a slip between parts may stay.
 */
function laidOut(offsets: TableColumn, size: TableColumn, rows: readonly number[]): boolean {
	if (offsets.dim !== size.dim) return false;
	const starts = rows.map(row => flowCell(offsets, row));
	const sizes = rows.map(row => flowCell(size, row));
	if (starts.some(cell => !cell) || sizes.some(cell => !cell || cell.value < 0)) return false;
	let contiguous = 0;
	for (let at = 1; at < rows.length; at++) {
		const end = starts[at - 1]!.value + sizes[at - 1]!.value;
		const slack = writtenSlack(starts[at]!) + writtenSlack(sizes[at - 1]!) + writtenSlack(starts[at - 1]!);
		if (starts[at]!.value < starts[at - 1]!.value) return false;
		if (Math.abs(starts[at]!.value - end) <= slack) contiguous++;
	}
	return contiguous >= CONTIGUOUS * (rows.length - 1);
}

/** `running` totals `step` row by row, each row's value its end (`Cumulative` 8, 25, 35 beside `Duration` 8, 17, 10). */
function endsOf(running: TableColumn, step: TableColumn, rows: readonly number[]): boolean {
	let sum = 0;
	for (const row of rows) {
		const [total, by] = [flowCell(running, row), flowCell(step, row)];
		if (!total || !by) return false;
		sum += by.value;
		if (Math.abs(total.value - sum) > writtenSlack(total) + 1e-9 * Math.abs(sum)) return false;
	}
	return true;
}

/**
 * Whether the table's prose carries it, so a chart of `columns` would only
 * restate small whole numbers set beside sentences: text columns (other than
 * the label) whose typical cells add up to {@link PROSE_CELL} characters a
 * row, next to plotted values that are all whole numbers up to
 * {@link MAX_PROSE_COUNT} (tiers, ratings, fixes per PR).
 */
export function proseLed(table: TableAnalysis, columns: readonly TableColumn[]): boolean {
	const { rows } = table;
	let prose = 0;
	for (const column of table.columns) {
		if (column.role !== "label" || column === table.label) continue;
		const lengths = rows.map(row => column.cells[row]!.text.length).sort((a, b) => a - b);
		prose += lengths[lengths.length >> 1] ?? 0;
	}
	return (
		prose >= PROSE_CELL &&
		columns.every(column =>
			columnValues(column, rows).every(value => Number.isInteger(value) && Math.abs(value) <= MAX_PROSE_COUNT),
		)
	);
}

/**
 * The data `plan` draws from `table`, or `undefined` when it leaves fewer than
 * two categories or no series with two values. The kind is fitted to the
 * series it ends up with ({@link fitKind}), so any plan — a model's pick
 * included — draws as something the renderer supports.
 */
export function buildChart(table: TableAnalysis, plan: ChartPlan): ChartSpec | undefined {
	const label = plan.label === undefined ? undefined : table.columns[plan.label];
	const columns = plan.series.map(index => table.columns[index]).filter(column => column !== undefined);
	if (columns.length === 0) return undefined;
	const wanted = new Set([plan.label, ...(plan.qualifiers ?? []), plan.group]);
	const namers = table.columns.filter(column => wanted.has(column.index));
	// A line keeps its x order; a transposed table's rows are its series; grouping by the
	// only naming column would leave every member unnamed.
	const grouper = plan.group === undefined ? undefined : table.columns[plan.group];
	// Steps of a timeline or waterfall keep table order: regrouping would reorder the run.
	const flowing = plan.kind === "timeline" || plan.kind === "waterfall";
	const group =
		plan.kind === "line" || flowing || plan.transpose || !namers.some(column => column !== grouper)
			? undefined
			: grouper;
	if (plan.kind === "change" && !plan.transpose && plan.baselines?.length === columns.length)
		return changeChart(
			table,
			plan,
			namers,
			group,
			columns,
			plan.baselines.map(index => table.columns[index]!),
		);
	if (plan.kind === "change" && !plan.transpose) return changeChart(table, plan, namers, group, columns);
	// Several `a → b` columns hold two values per cell; only factors of change draw them side by side.
	const arrows = columns.filter(column => column.arrowShare >= 0.6);
	if (arrows.length >= 2 && !plan.transpose) return changeChart(table, plan, namers, group, arrows);
	// Before/after values spanning decades share no readable axis, nor do rows of very different sizes beside a
	// baseline column; their factors do (`20.1 ms → 0.13 ms` is 155× less).
	// Intervals keep their values: a range chart prints the factor between a pair's midpoints beside both.
	const factored =
		plan.transpose || rangeColumns(columns, table.rows)
			? undefined
			: plan.kind === "paired"
				? beforeAfter(table, columns)
				: plan.kind === "grouped" || plan.kind === "dots"
					? againstBaseline(table, columns)
					: undefined;
	const factors = factored && changeChart(table, plan, namers, group, factored);
	if (factors) return factors;
	const ranked = plan.order && !plan.transpose && plan.kind !== "scatter" && !flowing ? plan.order : undefined;
	const rows =
		plan.kind === "line"
			? chronological(table.rows, label)
			: flowing
				? table.rows.filter(row => row !== plan.limit)
				: rank(regroup(table.rows, group), group, ranked, table);
	// Names nest by their leading part where the chart lists rows down a label column.
	const nest = !plan.transpose && plan.kind !== "line" && plan.kind !== "scatter";
	const naming = nameRows(namers, group, rows, nest);

	let categories: readonly string[];
	let series: ChartSeries[];
	if (plan.transpose) {
		categories = columns.map(column => column.header);
		series = rows.map((row, at) => ({
			...rowSeries(naming.names[at]!, columns, row),
			polarity: plan.rowPolarity?.[row],
		}));
	} else if (plan.kind === "paired" && columns.length === 1) {
		// `a → b` cells: the column splits into its from and to values.
		const column = columns[0]!;
		const [from, to] = arrowNames(column.header);
		const before = { ...columnSeries(column, rows, from), polarity: plan.polarity?.[column.index] };
		const after: ChartSeries = {
			...before,
			name: to,
			points: rows.map(row => {
				const cell = column.cells[row];
				return isNumber(cell) && cell.to !== undefined
					? { value: cell.to, text: cell.toFigure ?? "", emphasis: cell.emphasis }
					: null;
			}),
		};
		categories = naming.names;
		series = [before, after];
	} else {
		categories = naming.names;
		series = columns.map(column => ({
			...columnSeries(column, rows, column.header),
			// Plotted at their start, `a → b` cells rank where each began, not how it ended.
			polarity: column.arrowShare >= 0.6 ? undefined : plan.polarity?.[column.index],
		}));
	}

	let x: ChartSpec["x"];
	if (plan.kind === "scatter" && series.length >= 2) {
		const xs = series[0]!;
		x = { name: xs.name, dim: xs.dim, unit: xs.unit, values: xs.points.map(entry => entry?.value ?? Number.NaN) };
		series = [series[1]!];
	} else if (plan.kind === "line" && label && !plan.transpose) {
		const values = rows.map(row => label.cells[row]).map(cell => (isNumber(cell) ? cell.value : Number.NaN));
		if (values.every(Number.isFinite) && isMonotonic(values)) {
			const first = label.cells[rows[0]!];
			x = {
				name: label.header,
				dim: isNumber(first) ? first.dim : "count",
				unit: label.unit,
				values,
			};
		}
	}

	series = series.filter(entry => entry.points.filter(point => point !== null).length >= 2);
	if (categories.length < 2 || series.length === 0) return undefined;
	// A dot plot is one shared axis: series in another unit than the first leave it while two remain.
	if (plan.kind === "dots" && !plan.transpose) {
		const unit = `${series[0]!.dim}:${series[0]!.unit}`;
		const shared = series.filter(entry => `${entry.dim}:${entry.unit}` === unit);
		if (shared.length >= 2) series = shared;
	}
	// Intervals: a column of values inside the first's (`≈ $6,700` in `$6.0k–7.3k`) is its estimate.
	const intervals = plan.transpose ? undefined : foldEstimate(series);
	const lead = intervals?.series[0];
	let estimate: ChartSeries | undefined;
	let kind = plan.transpose ? "multiples" : fitKind(plan.kind, series, x !== undefined);
	// Values mostly written `a–b` draw as intervals whatever bars, dumbbell or dots were asked for; panels
	// of several quantities stay panels unless a range chart was asked for.
	if (
		intervals &&
		(kind === "range" || kind === "bar" || kind === "grouped" || kind === "paired" || kind === "dots") &&
		intervalShare(intervals.series) >= RANGE_SHARE &&
		intervals.series.length <= MAX_RANGES &&
		!(lead?.dim === "count" && POSITIONS.test(lead.name))
	) {
		kind = "range";
		series = intervals.series;
		estimate = intervals.estimate;
		// The factor a pair of intervals prints at each row's end restates a `speedup` column beside them.
		const [first, second] = series;
		if (first && second && first.dim === second.dim && first.unit === second.unit && series.length > 2)
			series = series.filter(entry => !DELTA.test(entry.name) || entry === first || entry === second);
	} else if (kind === "range") kind = fitKind("grouped", series, x !== undefined);
	// Grouped bars over one quantity spanning decades leave the small ones as slivers (or, on a log axis,
	// lengths from an arbitrary floor): dots on a shared log axis keep every value readable.
	const layout =
		kind === "grouped" || kind === "dots"
			? dotLayout(
					categories.map((_, at) =>
						series.map(entry => {
							const value = entry.points[at]?.value ?? Number.NaN;
							return value > 0 ? value : Number.NaN;
						}),
					),
				)
			: undefined;
	const plotted = layout ? columns.filter(column => series.some(entry => entry.name === column.header)) : [];
	if (
		kind === "grouped" &&
		!plan.transpose &&
		DOT_DIMS.has(series[0]!.dim) &&
		(layout === "apart" || (layout === "clumped" && dotBaseline(plotted))) &&
		spreadOf(
			series.flatMap(entry =>
				entry.points.flatMap(point => (point ? [point.value, point.upper ?? point.value] : [])),
			),
		) >= (series.length >= 3 ? DOT_SPREAD : DECADES)
	)
		kind = "dots";
	// Dots of rows too tight for one axis (`3.56s…4.14s` beside `104ms…115ms`) read as factors of the baseline column.
	const baseline = kind === "dots" && layout === "clumped" ? dotBaseline(plotted) : undefined;
	const base = baseline && series.length >= 3 ? series.find(entry => entry.name === baseline.header) : undefined;
	if (base)
		series = series
			.filter(entry => entry !== base)
			.map(entry => ({
				...entry,
				dim: "ratio" as const,
				unit: "",
				points: entry.points.map((point, at) => {
					const from = base.points[at];
					return point && from && from.value > 0
						? {
								value: point.value / from.value,
								text: `${from.text} → ${point.text}`,
								emphasis: point.emphasis || from.emphasis,
							}
						: null;
				}),
			}));
	// Columns of different quantities compare within each column: bars on their own axes read that better than shades.
	if (kind === "heatmap" && plan.shading === "series" && series.length <= MAX_PANELS) kind = "multiples";
	// A share or a delta reads one series (a delta the first going negative); the rest would overdraw it.
	if (kind === "share") series = series.slice(0, 1);
	if (kind === "diverging")
		series = [series.find(entry => entry.points.some(point => point && point.value < 0)) ?? series[0]!];
	const wholeColumn = plan.whole === undefined ? undefined : table.columns[plan.whole];
	const whole =
		kind === "stacked" && wholeColumn && wholeColumn.dim === series[0]!.dim
			? columnSeries(wholeColumn, rows, wholeColumn.header)
			: undefined;
	// Parts that are outcomes take their status colors; outcome stacks over rows of different sizes read as each row's mix.
	const tones =
		kind === "stacked"
			? outcomeTones(series.map(entry => entry.name))
			: kind === "share"
				? outcomeTones(categories)
				: undefined;
	const normalized =
		kind === "stacked" && (plan.normalize ?? (tones !== undefined && totalSpread(series, whole) >= MIX_SPREAD));
	// Only condition pairs reach `paired` ({@link fitKind}); `a → b` cells or before/after words give them a direction.
	// A range chart's pair is its first two series in one unit, whatever bands follow.
	const transition =
		(kind === "paired"
			? series.length === 2
			: kind === "range" &&
				series.length >= 2 &&
				series[0]!.dim === series[1]!.dim &&
				series[0]!.unit === series[1]!.unit) &&
		((plan.kind === "paired" && columns.length === 1) || isTransition(series[0]!.name, series[1]!.name));
	// A dumbbell of peers (`in-memory` vs `disk`) is no improvement or regression: only a transition is toned.
	if (kind === "paired" && !transition) series = series.map(entry => ({ ...entry, polarity: undefined }));
	// What competes gets its best marked; lines, dumbbells, shares and stacks read a trend, a move or parts,
	// and an interval has no single value to rank. Factors of a baseline column leave it out of the contest:
	// the best of the rest may still trail it.
	const contest =
		kind !== "line" &&
		kind !== "paired" &&
		kind !== "share" &&
		kind !== "stacked" &&
		kind !== "timeline" &&
		kind !== "waterfall" &&
		kind !== "range" &&
		!base;
	const flow = kind === "timeline" || kind === "waterfall" ? flowSpec(table, plan, rows, series[0]!) : undefined;
	let leaders: (number | undefined)[] | undefined;
	if (contest && plan.transpose) {
		// The compared columns are the categories: two suffice, and a delta column competes with none.
		const rivals = columns.map(column => !DELTA.test(column.header) && column.signedShare < 0.5);
		series = series.map(entry => ({ ...entry, best: bestPoint(entry, rivals, 2) }));
	} else if (contest && plan.rivals === "rows") series = series.map(entry => ({ ...entry, best: bestPoint(entry) }));
	else if (contest && plan.rivals === "columns") leaders = columnLeaders(categories, series);
	// Intervals and dots read against what the table states as the bar to clear (`vs $200`, `20k budget`, 1×).
	const stated = kind === "range" || kind === "dots" ? statedReferences(table, series, base?.name) : undefined;
	// A ratio against that stated value (`Leverage vs $200`) restates the rule beside the intervals.
	if (stated?.restating.length && series.length > stated.restating.length)
		series = series.filter(entry => !stated.restating.includes(entry.name));
	return withMeaning(
		table,
		plan,
		{
			kind,
			transition: transition || undefined,
			transposed: plan.transpose || undefined,
			categories,
			groups: plan.transpose ? undefined : naming.groups,
			series,
			x: flow?.x ?? x,
			caption: flow?.total ? undefined : totalsCaption(table, label, columns, plan.transpose),
			axis: naming.axis,
			shading: plan.shading,
			reference: plan.transpose ? undefined : referenceRows(table, plan.reference, group, rows),
			whole,
			normalized: normalized || undefined,
			tones,
			total: flow?.total,
			// A flow's cap rule, or the references intervals and dots are read against; never both.
			annotations: flow?.annotations ?? (stated?.marks.length ? stated.marks : undefined),
			leaders,
			estimate,
			baseline: base?.name,
		},
		plan.transpose ? undefined : rows,
	);
}

/** Share of a column's numbers written `a–b` from which it reads as intervals rather than values. */
const RANGE_SHARE = 0.5;
/** Most series one range chart draws across its bands: more interval rows per category stop reading apart. */
const MAX_RANGES = 4;
/** Spread (max/min) from which three or more same-unit series read better as dots on a log axis than as grouped bars. */
const DOT_SPREAD = 10;
/** Most categories a dot plot keeps a glance tall: one row each. */
const MAX_DOT_ROWS = 20;
/** Share of the axis (in logs) a row's typical spread must span for its dots not to merge into one blot. */
const DOT_CLUMP = 0.2;
/**
 * Measurements dots place by position and ratio (timings, prices, sizes, rates); tallies and shares
 * add up, so bars from zero tell them better.
 */
const DOT_DIMS: ReadonlySet<Dimension> = new Set(["duration", "bytes", "currency", "rate", "ratio"]);
/** A header marking the configuration in use, which the others compare against. */
const IN_USE = /\((?:shipped|current|default|in use|deployed|prod(?:uction)?)\b[^)]*\)/i;
/**
 * Factor within which a stated reference may lie of the values it is read against (`$200` beside
 * `$4.4k–6.1k` is 22× under); farther, the axis reaching it would flatten them.
 */
const REFERENCE_REACH = 50;
/**
 * Headers of spans of positions rather than amounts (`Lines` 110–112, `Line Range`, `Cases` 12–17,
 * `New #` 1–7): their count ranges say where, not how much.
 */
const POSITIONS =
	/(?:^|[^\w])(?:lines?|line ?(?:no|nos|numbers?)|cases?|ids?|rows?|cols?|columns?|offsets?|pages?|pp|ind(?:ex|ices)|positions?|range|span|issues?|#|no\.?)(?![\w])/i;
/**
 * A number a table states as the bar its values are read against: after `vs`,
 * `budget`, `limit` (`Leverage vs $200`, `limit of 512 MB`), or before such a
 * word (`blew the 20k budget`, `128k token limit`).
 */
const STATED_REFERENCE =
	/\b(?<lead>vs\.?|versus|budget|limit|cap|target|quota|threshold)\s+(?:of\s+)?(?<after>[~≈]?\s?[$€£]?\d[\d,]*(?:\.\d+)?\s?(?:[a-z%×µμ]+(?:\/[a-z]+)?)?)|(?<before>[$€£]?\d[\d,]*(?:\.\d+)?\s?[a-z%×]{0,3})\s+(?:[a-z]+\s+)?(?<word>budget|limit|cap|quota|threshold|target)\b/i;

/**
 * The same-unit measures plotted as intervals when values written `a–b` make
 * up most of the numbers of at least one of them ({@link RANGE_SHARE}), with the
 * measures sharing its unit (an estimate column, a pair's other side); other
 * units' interval columns join as bands of their own. At most {@link MAX_RANGES}.
 */
export function rangeColumns(measures: readonly TableColumn[], rows: readonly number[]): TableColumn[] | undefined {
	const key = (column: TableColumn) => `${column.dim}:${column.unit}`;
	const ranged = new Set(
		measures
			.filter(
				column =>
					!(column.dim === "count" && POSITIONS.test(column.header)) &&
					columnRangeShare(column, rows) >= RANGE_SHARE,
			)
			.map(key),
	);
	if (ranged.size === 0) return undefined;
	const columns = measures.filter(column => ranged.has(key(column))).slice(0, MAX_RANGES);
	// Most of what the chart plots must be intervals: one ranged column among plain ones stays bars.
	const cells = columns.flatMap(column =>
		rows.map(row => column.cells[row]).filter(cell => isNumber(cell) && cell.dim === column.dim),
	);
	const spans = cells.filter(cell => isNumber(cell) && cell.upper !== undefined && cell.upper > cell.value).length;
	return spans >= cells.length * RANGE_SHARE ? columns : undefined;
}

/**
 * Whether `columns` over `rows` read best as dots: three to six columns of one measurement
 * ({@link DOT_DIMS}) spanning {@link DOT_SPREAD}× or more, where grouped bars from zero would flatten
 * the small values — one quantity whose rows sit apart on a log axis, or rows too tight for one axis
 * beside a baseline column their factors can be read against ({@link dotLayout}).
 */
export function dotsFit(columns: readonly TableColumn[], rows: readonly number[]): boolean {
	const first = columns[0];
	if (
		!first?.dim ||
		!DOT_DIMS.has(first.dim) ||
		// Durations and sizes share an axis in base units whatever unit each column writes; money and rates do not.
		columns.some(
			column =>
				column.dim !== first.dim ||
				((first.dim === "currency" || first.dim === "rate") && column.unit !== first.unit),
		) ||
		columns.length < 3 ||
		columns.length > SERIES_COLORS ||
		rows.length < 3 ||
		rows.length > MAX_DOT_ROWS ||
		valueSpread(columns, rows) < DOT_SPREAD
	)
		return false;
	const layout = dotLayout(
		rows.map(row =>
			columns.map(column => {
				const cell = column.cells[row];
				return isNumber(cell) && cell.dim === column.dim && cell.value > 0 ? cell.value : Number.NaN;
			}),
		),
	);
	return layout === "apart" || (layout === "clumped" && dotBaseline(columns) !== undefined);
}

/**
 * How dots would sit for `grid` (rows of positive values, `NaN` where absent): `apart` when its columns
 * are one quantity and a row's typical spread spans at least {@link DOT_CLUMP} of the whole axis (in
 * logs); `clumped` when rows of very different sizes are each so tight their dots merge on one axis
 * (factors of a baseline column part them); `undefined` when one column typically runs
 * {@link QUANTITY_SPREAD}× another: different quantities, which share no axis.
 */
function dotLayout(grid: readonly (readonly number[])[]): "apart" | "clumped" | undefined {
	if (pairSpread(grid) >= QUANTITY_SPREAD) return undefined;
	const values = grid.flat().filter(Number.isFinite);
	if (values.length < 2) return undefined;
	const whole = Math.log(Math.max(...values) / Math.min(...values));
	const spans = grid
		.map(row => row.filter(Number.isFinite))
		.filter(row => row.length >= 2)
		.map(row => Math.log(Math.max(...row) / Math.min(...row)))
		.sort((a, b) => a - b);
	const typical = spans[spans.length >> 1] ?? 0;
	return whole > 0 && typical < DOT_CLUMP * whole ? "clumped" : "apart";
}

/**
 * The column the others are read against: one its header marks as what is in use (`GOGC=400
 * (shipped)`, `(current)`), or the baseline every other moves from ({@link isTransition}: `stock`
 * beside `branch | tsc-rs`).
 */
function dotBaseline(columns: readonly TableColumn[]): TableColumn | undefined {
	return (
		columns.find(column => IN_USE.test(column.header)) ??
		columns.find(column => columns.every(other => other === column || isTransition(column.header, other.header)))
	);
}

/**
 * Share of `column`'s numbers of its own dimension over `rows` written as an `a–b` range running up
 * (`0.805-0.764 = 0.041` is a difference, not an interval).
 */
function columnRangeShare(column: TableColumn, rows: readonly number[]): number {
	const numbers = rows.map(row => column.cells[row]).filter(cell => isNumber(cell) && cell.dim === column.dim);
	return numbers.length
		? numbers.filter(cell => isNumber(cell) && cell.upper !== undefined && cell.upper > cell.value).length /
				numbers.length
		: 0;
}

/** Share of the plotted values written as `a–b` ranges running up. */
function intervalShare(series: readonly ChartSeries[]): number {
	const points = series.flatMap(entry => entry.points.filter(point => point !== null));
	return points.length
		? points.filter(point => point.upper !== undefined && point.upper > point.value).length / points.length
		: 0;
}

/** Largest over smallest of the values (range ends included) in `columns` over `rows`; 1 when any is zero or negative. */
function valueSpread(columns: readonly TableColumn[], rows: readonly number[]): number {
	return spreadOf(
		columns.flatMap(column =>
			rows.flatMap(row => {
				const cell = column.cells[row];
				return isNumber(cell) && cell.dim === column.dim ? [cell.value, cell.upper ?? cell.value] : [];
			}),
		),
	);
}

/**
 * The middle of a value written `a–b`, which a factor between two intervals compares: the geometric
 * mean (`5.7–9.6 ms` → 7.4 ms), the arithmetic one from zero; a single value is its own.
 */
export function intervalMiddle(point: ChartPoint): number {
	const { value, upper } = point;
	if (upper === undefined) return value;
	return value > 0 ? Math.sqrt(value * upper) : (value + upper) / 2;
}

/** Largest over smallest of `values`; 1 when any is zero or negative (no log axis holds them). */
function spreadOf(values: readonly number[]): number {
	if (values.length < 2 || values.some(value => value <= 0)) return 1;
	return Math.max(...values) / Math.min(...values);
}

/**
 * `series` with the first interval series leading, and a series of the same unit whose values all
 * fall inside its intervals (two at least) taken out as its estimate: `≈ $6,700` beside `$6.0k–7.3k`.
 */
function foldEstimate(series: readonly ChartSeries[]): { series: ChartSeries[]; estimate?: ChartSeries } {
	const ranged = series.find(entry => intervalShare([entry]) >= RANGE_SHARE);
	if (!ranged) return { series: [...series] };
	const inside = (entry: ChartSeries) => {
		if (entry === ranged || entry.dim !== ranged.dim || entry.unit !== ranged.unit) return false;
		let held = 0;
		for (const [at, point] of entry.points.entries()) {
			const span = ranged.points[at];
			if (!point) continue;
			if (point.upper !== undefined || !span?.upper || point.value < span.value || point.value > span.upper)
				return false;
			held++;
		}
		return held >= 2;
	};
	const estimate = series.find(inside);
	return {
		series: [ranged, ...series.filter(entry => entry !== ranged && entry !== estimate)],
		estimate,
	};
}

/**
 * Reference rules a `range` or `dots` chart reads its values against: `1×` across ratios on both sides
 * of it, and numbers the table states as a bar to clear ({@link STATED_REFERENCE}) in a plotted series'
 * unit, within {@link REFERENCE_REACH} of its values. `restating` names ratio series measured against
 * such a number (`Leverage vs $200`): the rule says what they do.
 */
function statedReferences(
	table: TableAnalysis,
	series: readonly ChartSeries[],
	baseline: string | undefined,
): { marks: Extract<ChartAnnotation, { kind: "reference" }>[]; restating: string[] } {
	const marks: Extract<ChartAnnotation, { kind: "reference" }>[] = [];
	const restating: string[] = [];
	const ends = (entry: ChartSeries) =>
		entry.points.flatMap(point => (point ? [point.value, point.upper ?? point.value] : []));
	// One `1×` rule per axis, named after the baseline column when the values are its factors.
	const parity = series.findIndex(entry => {
		const values = ends(entry);
		return entry.dim === "ratio" && Math.min(...values) < 1 && Math.max(...values) > 1;
	});
	if (baseline) marks.push({ kind: "reference", value: 1, label: baseline, series: 0 });
	else if (parity >= 0) marks.push({ kind: "reference", value: 1, label: "1×", series: parity });
	const headers = new Set(table.columns.map(column => column.header));
	const texts = [...headers, ...table.columns.flatMap(column => table.rows.map(row => column.cells[row]?.text ?? ""))];
	for (const source of texts) {
		const match = STATED_REFERENCE.exec(source);
		const figure = (match?.groups?.after ?? match?.groups?.before)?.trim();
		if (!match || !figure) continue;
		// A cell's `110 ms vs 51 ms` compares its own row; only a header's `vs $200` frames the column.
		if (/^(?:vs\.?|versus)$/i.test(match.groups?.lead ?? "") && !headers.has(source)) continue;
		const cell = parseCell(figure);
		if (!isNumber(cell) || cell.fit !== "pure" || cell.value <= 0) continue;
		const at = series.findIndex(
			entry => entry.dim === cell.dim && (entry.dim !== "currency" || entry.unit === cell.unit),
		);
		const values = at < 0 ? [] : ends(series[at]!);
		if (
			!values.length ||
			cell.value * REFERENCE_REACH < Math.min(...values) ||
			cell.value > Math.max(...values) * REFERENCE_REACH ||
			marks.some(mark => mark.series === at && mark.value === cell.value)
		)
			continue;
		const word = match.groups?.word ?? match.groups?.lead ?? "";
		const label = /^(?:vs\.?|versus)$/i.test(word) ? cell.figure : `${cell.figure} ${word.toLowerCase()}`;
		marks.push({ kind: "reference", value: cell.value, label, series: at });
		for (const entry of series) if (entry.dim === "ratio" && entry.name === source) restating.push(entry.name);
	}
	return { marks, restating };
}

/**
 * `spec` with what `plan` says the table means: its title, a highlight on
 * each focus row and the status badges, where its categories are the
 * table's rows `order` (`undefined` when they are not, as in a transposed chart).
 */
function withMeaning(
	table: TableAnalysis,
	plan: ChartPlan,
	spec: ChartSpec | undefined,
	order: readonly number[] | undefined,
): ChartSpec | undefined {
	if (!spec) return undefined;
	const focus = order ? (plan.focus ?? []).flatMap(row => (order.includes(row) ? [order.indexOf(row)] : [])) : [];
	const matrix = order && MATRIX_KINDS.has(spec.kind) ? statusMatrix(table, plan, order) : undefined;
	const column = plan.status === undefined || !order || matrix ? undefined : table.columns[plan.status];
	const statuses = column?.statuses;
	return {
		...spec,
		title: plan.title,
		annotations: focus.length
			? [...(spec.annotations ?? []), ...focus.map(category => ({ kind: "highlight" as const, category }))]
			: spec.annotations,
		status: statuses && order?.map(row => statuses[row]),
		statusName: statuses && column?.header,
		matrix,
	};
}

/**
 * How many times the largest category total an outcome stack may hold over
 * the smallest before its bars read as mixes: alike totals (`158 | 1` of 159
 * in each row) read as well in counts, which the axis then shows.
 */
const MIX_SPREAD = 1.5;

/** Largest over smallest positive category total of a stack: its whole where written, else its parts' sum. */
function totalSpread(series: readonly ChartSeries[], whole: ChartSeries | undefined): number {
	const totals = (series[0]?.points ?? []).flatMap((_, at) => {
		const total =
			whole?.points[at]?.value || series.reduce((sum, entry) => sum + Math.max(0, entry.points[at]?.value ?? 0), 0);
		return total > 0 ? [total] : [];
	});
	return totals.length ? Math.max(...totals) / Math.min(...totals) : 1;
}

/** Most status columns a {@link ChartSpec.matrix} draws; a wider ✓/✗ grid is the table's own point, left to it. */
const MAX_MATRIX = 4;
/** Kinds whose rows run down a label column the matrix can stand beside: horizontal bars of every sort. */
const MATRIX_KINDS: ReadonlySet<ChartKind> = new Set(["bar", "grouped", "paired", "progress", "diverging"]);

/**
 * The status columns of `table` that neither name nor plot `plan`'s rows, as
 * a {@link ChartSpec.matrix} over the rows `order`: two to {@link MAX_MATRIX}
 * of them, saying more than one thing between them.
 */
function statusMatrix(table: TableAnalysis, plan: ChartPlan, order: readonly number[]): StatusColumn[] | undefined {
	const taken = new Set([plan.label, ...(plan.qualifiers ?? []), plan.group, ...plan.series]);
	const columns = table.columns.filter(column => column.statuses && !taken.has(column.index));
	if (columns.length < 2 || columns.length > MAX_MATRIX) return undefined;
	const seen = new Set(columns.flatMap(column => order.map(row => column.statuses![row])).filter(Boolean));
	if (seen.size < 2) return undefined;
	return columns.map(column => ({ name: column.header, statuses: order.map(row => column.statuses![row]) }));
}

/**
 * What a `timeline` or `waterfall` of `entry` (drawn over `rows`) adds to its
 * spec: the segments' starts from {@link ChartPlan.offsets}; the total the
 * steps reach (the table's total row, else their sum written like their
 * figures); and the cap row ({@link ChartPlan.limit}) as a reference rule.
 */
function flowSpec(
	table: TableAnalysis,
	plan: ChartPlan,
	rows: readonly number[],
	entry: ChartSeries,
): Pick<ChartSpec, "x" | "total" | "annotations"> {
	const column = table.columns[plan.series[0] ?? -1];
	const label = plan.label === undefined ? undefined : table.columns[plan.label];
	const offsets = plan.kind === "timeline" && plan.offsets !== undefined ? table.columns[plan.offsets] : undefined;
	const starts = offsets && rows.map(row => flowCell(offsets, row)?.value ?? Number.NaN);
	const x =
		offsets && starts?.every(Number.isFinite)
			? { name: offsets.header, dim: offsets.dim ?? entry.dim, unit: offsets.unit, values: starts }
			: undefined;
	const row = column && table.totals.find(at => flowCell(column, at));
	const cell = row === undefined || !column ? undefined : flowCell(column, row);
	const values = entry.points.flatMap(point => (point ? [point] : []));
	const total =
		cell && label
			? { name: label.cells[row!]!.text, point: point(cell) }
			: {
					name: "Total",
					point: {
						value: values.reduce((sum, point) => sum + point.value, 0),
						// Durations mix units (`8s`, `4:14`); the renderer says their sum as people do (`6m 36s`).
						text: entry.dim === "duration" ? "" : sumFigure(values),
						emphasis: false,
					},
				};
	const cap =
		plan.kind === "waterfall" && plan.limit !== undefined && column ? flowCell(column, plan.limit) : undefined;
	const capName = label && plan.limit !== undefined ? label.cells[plan.limit]!.text : "";
	return {
		x,
		total,
		annotations: cap
			? [{ kind: "reference", value: cap.value, label: `${capName} ${cap.figure}`.trim() }]
			: undefined,
	};
}

/**
 * The sum of `points` written like their figures (`~$5.0M` + `~$0.9M` →
 * `~$8.0M`, approximate when any part is), when all share a currency, a unit
 * and a scale; else empty, for the renderer to format.
 */
function sumFigure(points: readonly ChartPoint[]): string {
	const figure = /^([~≈≤≥<>]?)\s*([+\-−]?)\s*([$€£¥]?)\s*(\d[\d,]*)(?:\.(\d+))?(\s*)([A-Za-zµ]*)$/;
	const read = points.map(point => figure.exec(point.text.trim()));
	if (read.length === 0 || read.some(match => !match)) return "";
	const matches = read as RegExpExecArray[];
	const [first] = matches;
	const scale = (match: RegExpExecArray, at: number) => {
		const written = Number(`${match[4]!.replaceAll(",", "")}.${match[5] ?? "0"}`);
		return written ? Math.abs(points[at]!.value) / written : Number.NaN;
	};
	const factor = matches.map(scale).find(Number.isFinite) ?? 1;
	if (
		matches.some(
			(match, at) =>
				match[3] !== first![3] ||
				match[7] !== first![7] ||
				(Number.isFinite(scale(match, at)) && Math.abs(scale(match, at) / factor - 1) > 1e-6),
		)
	)
		return "";
	const decimals = Math.max(...matches.map(match => match[5]?.length ?? 0));
	const sum = points.reduce((total, point) => total + point.value, 0) / factor;
	const digits = Math.abs(sum).toLocaleString("en-US", {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
		useGrouping: matches.some(match => match[4]!.includes(",")) || Math.abs(sum) >= 10_000,
	});
	const approx = matches.some(match => match[1]) ? "~" : "";
	return `${approx}${sum < 0 ? "−" : ""}${first![3]}${digits}${first![6]}${first![7]}`;
}

/**
 * `rows` sorted by `order`'s column within each run of one `group` value (all
 * of them without a group); rows without a number of it keep their place at
 * the end, ties keep table order.
 */
function rank(
	rows: readonly number[],
	group: TableColumn | undefined,
	order: RowOrder | undefined,
	table: TableAnalysis,
): readonly number[] {
	const column = order && table.columns[order.column];
	if (!order || !column) return rows;
	const sign = order.direction === "descending" ? -1 : 1;
	// A cell of another dimension (`12c $128` under `8c`) is no rank of this column.
	const value = (row: number) => {
		const cell = column.cells[row];
		return isNumber(cell) && cell.dim === column.dim ? cell.value : Number.NaN;
	};
	const runs: number[][] = [];
	for (const row of rows) {
		const last = runs.at(-1);
		if (last && (!group || nameCell(group, last[0]!) === nameCell(group, row))) last.push(row);
		else runs.push([row]);
	}
	return runs.flatMap(run =>
		run.toSorted((a, b) => {
			const [x, y] = [value(a), value(b)];
			if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
			return sign * (x - y);
		}),
	);
}

/** Positions in `rows` of the rows `reference` marks, the first per run of one `group` value; else `undefined`. */
function referenceRows(
	table: TableAnalysis,
	reference: RowReference | undefined,
	group: TableColumn | undefined,
	rows: readonly number[],
): readonly number[] | undefined {
	const column = reference && table.columns[reference.column];
	if (!reference || !column) return undefined;
	const marked: number[] = [];
	const seen = new Set<string>();
	rows.forEach((row, at) => {
		const run = group ? nameCell(group, row) : "";
		if (seen.has(run) || nameCell(column, row) !== reference.value) return;
		seen.add(run);
		marked.push(at);
	});
	return marked.length ? marked : undefined;
}

/**
 * The baseline and compared column of a dumbbell pick whose values span
 * {@link DECADES}× or more — a direction pair ({@link isTransition}: `Before |
 * After`, `Current | New`), or one column of `a → b` cells — else `undefined`:
 * on a logarithmic axis a dumbbell's length is its factor, which a `change`
 * chart prints and aligns at 1×. Peers (`xutf | std`) keep their dumbbell.
 */
function beforeAfter(table: TableAnalysis, columns: readonly TableColumn[]): TableColumn[] | undefined {
	const values: number[] = [];
	for (const column of columns)
		for (const row of table.rows) {
			const cell = column.cells[row];
			if (isNumber(cell)) values.push(cell.value, cell.to ?? cell.value);
		}
	const positive = values.filter(value => value > 0);
	if (positive.length < 4 || Math.max(...positive) / Math.min(...positive) < DECADES) return undefined;
	if (columns.length === 1) return columns[0]!.arrowShare >= 0.6 ? [columns[0]!] : undefined;
	if (columns.length !== 2) return undefined;
	const [a, b] = columns as [TableColumn, TableColumn];
	if (a.dim !== b.dim) return undefined;
	return isTransition(a.header, b.header) ? [a, b] : isTransition(b.header, a.header) ? [b, a] : undefined;
}

/**
 * The plotted columns baseline first when one of them is the baseline every
 * other moves from ({@link isTransition}: `baseline` beside `bash | http`) and
 * two rows typically differ {@link ROW_SPREAD}× or more: one shared axis
 * flattens the small rows, while factors of the baseline show each row's
 * pattern at any size.
 */
function againstBaseline(table: TableAnalysis, columns: readonly TableColumn[]): TableColumn[] | undefined {
	// More than grouped bars hold (a heatmap's worth) would crowd each row with bars.
	if (columns.length < 2 || columns.length > MAX_GROUPED || new Set(columns.map(column => column.dim)).size > 1)
		return undefined;
	const baseline = columns.find(column =>
		columns.every(other => other === column || isTransition(column.header, other.header)),
	);
	if (!baseline) return undefined;
	const grid = columns.map(column =>
		table.rows.map(row => {
			const cell = column.cells[row];
			return isNumber(cell) && cell.value > 0 ? cell.value : Number.NaN;
		}),
	);
	if (pairSpread(grid) < ROW_SPREAD) return undefined;
	return [baseline, ...columns.filter(column => column !== baseline)];
}

/**
 * Measure columns pairing a before condition with another over the same
 * metric (`Baseline Turns` → `Iter1 Turns`, `Baseline Tokens In` → `Iter1
 * Tokens In`): the before column's words without its condition word, plus one
 * or two words naming the other condition. Same dimension within a pair; a
 * before column several columns could pair with (`stock c4` beside `branch c4`
 * and `tsc-rs c4`) makes no pairs: that table compares more than two conditions.
 */
function metricPairs(measures: readonly TableColumn[]): [TableColumn, TableColumn][] {
	const words = (header: string) =>
		header
			.toLowerCase()
			.split(/[^a-z0-9.]+/)
			.filter(Boolean);
	const pairs: [TableColumn, TableColumn][] = [];
	for (const before of measures) {
		if (!BEFORE.test(before.header)) continue;
		const subject = words(before.header).filter(word => !BEFORE.test(word));
		if (subject.length === 0) continue;
		const partners = measures.filter(column => {
			if (column === before || column.dim !== before.dim || BEFORE.test(column.header)) return false;
			const own = words(column.header);
			const extra = own.filter(word => !subject.includes(word));
			return subject.every(word => own.includes(word)) && extra.length >= 1 && extra.length <= 2;
		});
		if (partners.length > 1) return [];
		const after = partners[0];
		if (after && !pairs.some(([, taken]) => taken === after)) pairs.push([before, after]);
	}
	return pairs;
}

/**
 * Whether two headers name one quantity under two conditions — the one
 * before/after helper every pair decision goes through (the judge's `pair`
 * answer stands in for it where the headers say nothing): a before/after word
 * ({@link isTransition}) or the same words around one that differs (`gpt-5.5
 * window | gpt-5.4 (target) window`, `Q5_K_M | Q4_K_M`). Identical headers (a
 * list wrapped into two halves) and unrelated quantities (`Verts | Faces`,
 * `Tier | New Findings`) are no pair.
 */
export function isConditionPair(first: string, second: string): boolean {
	const words = (header: string) =>
		header
			.toLowerCase()
			.split(/[^a-z0-9.]+/)
			.filter(Boolean);
	const [a, b] = [words(first), words(second)];
	if (a.join(" ") === b.join(" ")) return false;
	if (isTransition(first, second)) return true;
	const shared = a.filter(word => b.includes(word));
	return shared.length > 0 && shared.length < Math.max(a.length, b.length);
}

/**
 * The direction of a condition pair: `first` names the before state and
 * `second` the after one (`Baseline | Iter20`, `old (diff) | new`, `Stock |
 * Patched`), so the pair reads as a move from `first` to `second`. A pair
 * without such words (`xutf | std`, `Q5_K_M | Q4_K_M`) has no direction: peers.
 */
export function isTransition(first: string, second: string): boolean {
	return (BEFORE.test(first) && !BEFORE.test(second)) || (AFTER.test(second) && !AFTER.test(first));
}

/** Most categories a best mark singles out of; beyond it the mark is lost among the rows. */
const MAX_RIVALS = 16;

/**
 * Per category, the series with its best value among the rival columns: the
 * most series sharing one unit and one polarity, two at least (`pi-walker`
 * and `Go` beside their `Speedup`); `undefined` where tied or missing.
 */
function columnLeaders(
	categories: readonly string[],
	series: readonly ChartSeries[],
): (number | undefined)[] | undefined {
	const kinds = new Map<string, number[]>();
	series.forEach((entry, index) => {
		if (!entry.polarity) return;
		const kind = `${entry.polarity}:${entry.dim}:${entry.unit}`;
		kinds.set(kind, [...(kinds.get(kind) ?? []), index]);
	});
	const rivals = [...kinds.values()].sort((a, b) => b.length - a.length)[0];
	if (!rivals || rivals.length < 2) return undefined;
	const sign = series[rivals[0]!]!.polarity === "higher" ? 1 : -1;
	return categories.map((_, at) => {
		const ranked = rivals
			.flatMap(index => {
				const point = series[index]!.points[at];
				return point ? [{ index, value: sign * point.value }] : [];
			})
			.sort((a, b) => b.value - a.value);
		return ranked.length >= 2 && ranked[0]!.value !== ranked[1]!.value ? ranked[0]!.index : undefined;
	});
}

/**
 * The category holding `series`' best value by its polarity among the
 * `rivals` categories (all by default): one of at least `least` values, not
 * tied with another.
 */
function bestPoint(series: ChartSeries, rivals?: readonly boolean[], least = 3): number | undefined {
	if (!series.polarity) return undefined;
	const sign = series.polarity === "higher" ? 1 : -1;
	const ranked = series.points
		.flatMap((point, at) => (point && (rivals?.[at] ?? true) ? [{ at, value: sign * point.value }] : []))
		.sort((a, b) => b.value - a.value);
	if (ranked.length < least || ranked.length > MAX_RIVALS) return undefined;
	const [first, second] = [ranked[0]!, ranked[1]!];
	if (first.value === second.value) return undefined;
	return first.at;
}

/** Most takeaways offered for one chart; the strongest first. */
const MAX_TAKEAWAYS = 8;
/** Most series whose extremes are offered as takeaways. */
const TAKEAWAY_SERIES = 4;
/** Factor between the top value and the next from which the top is an outlier worth naming. */
const OUTLIER = 2;
/** Factor from which an outlier or a move is striking enough to state unprompted. */
const STRIKING = 3;
/** Factor from which a before/after move is striking enough to state unprompted. */
const STRIKING_MOVE = 2;
/** Share of a stack's wholes one part must make up to be worth stating. */
const DOMINANT_PART = 0.6;
/** Share of a run's total two steps make up from which they are what the run is (`build` and `check` are 85%). */
const DOMINANT_PAIR = 0.75;
/** Share of a run's total the second of a {@link DOMINANT_PAIR} must make up to be named beside the first. */
const SECOND_PART = 0.15;
/** Factor within which a category barely moved, neither with nor against the rest. */
const STILL_FACTOR = 1.03;
/** Weight lifting a whole-table move above every single move (a log factor stays far below it). */
const CONSENSUS_WEIGHT = 20;
/** Weight lifting a contest's outcome (a sweep, a trade-off, a column best in most rows) above a ×20 outlier. */
const RIVALRY_WEIGHT = 4;

/** A takeaway with the weight ranking it among a chart's others. */
interface Fact extends Takeaway {
	readonly weight: number;
}

/**
 * Facts `spec` could state as its headline, unranked: the largest moves of a
 * change or dumbbell (and every row moving one way), a group or category
 * standing far above the next, one rival best on several measures (or best
 * on one at the highest cost), each series' top value and its best one, ties
 * at the top, the overall move of a line, the largest share. Each is a short
 * sentence over the figures as the table wrote them.
 */
function chartFacts(spec: ChartSpec): Fact[] {
	const facts: Fact[] = [];
	const { categories, series } = spec;
	const name = (at: number) => categories[at]!;
	// Dots against a baseline column plot its factors, like a `change`.
	if (spec.kind === "change" || (spec.kind === "dots" && spec.baseline)) {
		for (const entry of series.slice(0, TAKEAWAY_SERIES)) {
			const moves = entry.points.flatMap((point, at) => (point && point.value > 0 ? [{ at, point }] : []));
			moves.sort((a, b) => Math.abs(Math.log(b.point.value)) - Math.abs(Math.log(a.point.value)));
			const lead = series.length > 1 ? `${entry.name} ` : "";
			for (const { at, point } of moves.slice(0, 2)) {
				const move = factorWords(point.value);
				if (move === "same") continue;
				const weight = Math.abs(Math.log(point.value));
				facts.push({
					key: `move:${entry.name}:${name(at)}`,
					text: `${name(at)}: ${lead}${move} (${point.text})`,
					weight,
					striking: weight >= Math.log(STRIKING_MOVE),
				});
			}
			const consensus = consensusMove(
				spec,
				entry.points.map(point => point?.value),
				entry.points.map((_, at) => spec.categoryPolarity?.[at] ?? entry.polarity),
				`every ${rowNoun(spec)}`,
				series.length > 1 ? ` on ${entry.name}` : "",
			);
			if (consensus) facts.push({ ...consensus, key: `moves:${entry.name}` });
		}
	} else if ((spec.kind === "paired" || spec.kind === "range") && series.length === 2) {
		const [before, after] = series as [ChartSeries, ChartSeries];
		// Two rivals on one axis (`in-memory` vs `disk`) make no move: an `a → b` would misstate them.
		// A range chart's first two series move only as its transition (one unit, before/after words).
		if (spec.kind === "range" ? spec.transition : isTransition(before.name, after.name)) {
			// Intervals move by the factor between their middles, as the range chart prints it.
			const value = (point: ChartPoint) => (spec.kind === "range" ? intervalMiddle(point) : point.value);
			const factors = categories.map((_, at) => {
				const [a, b] = [before.points[at], after.points[at]];
				return a && b && value(a) > 0 ? value(b) / value(a) : undefined;
			});
			factors.forEach((factor, at) => {
				const move = factor === undefined ? "same" : factorWords(factor);
				if (move === "same") return;
				facts.push({
					key: `move:${name(at)}`,
					text: `${name(at)}: ${before.points[at]!.text} → ${after.points[at]!.text} (${move})`,
					weight: Math.abs(Math.log(Math.max(factor!, 1e-9))),
					// One row's move may be noise (`1 → 2`); the whole table moving together is the finding.
					striking: false,
				});
			});
			const polarity = after.polarity ?? before.polarity;
			const consensus = consensusMove(
				spec,
				factors,
				factors.map(() => polarity),
				`every ${rowNoun(spec)}`,
				` from ${before.name} to ${after.name}`,
			);
			if (consensus) facts.push(consensus);
		}
	} else if (spec.kind === "line") {
		for (const entry of series.slice(0, TAKEAWAY_SERIES)) {
			const present = entry.points.flatMap((point, at) => (point ? [{ at, point }] : []));
			const [first, last] = [present[0], present.at(-1)];
			if (!first || !last || first === last || first.point.value <= 0) continue;
			const factor = last.point.value / first.point.value;
			facts.push({
				key: `trend:${entry.name}`,
				text: `${entry.name}: ${first.point.text} → ${last.point.text} from ${name(first.at)} to ${name(last.at)} (${factorWords(factor)})`,
				weight: Math.abs(Math.log(factor)),
				striking: false,
			});
		}
	} else if (spec.kind === "stacked") {
		// Parts of a whole: facts about the wholes, and a part making up most of them.
		if (spec.whole) facts.push(...extremes(spec, spec.whole));
		const sums = series.map(entry => entry.points.reduce((total, point) => total + (point?.value ?? 0), 0));
		const grand =
			spec.whole?.points.reduce((total, point) => total + (point?.value ?? 0), 0) ??
			sums.reduce((total, sum) => total + sum, 0);
		const lead = sums.indexOf(Math.max(...sums));
		const part = grand > 0 ? sums[lead]! / grand : 0;
		if (part >= DOMINANT_PART)
			facts.push({
				key: `part:${series[lead]!.name}`,
				text: `${series[lead]!.name} is ${Math.round(part * 100)}% of ${spec.whole?.name ?? "the total"}`,
				weight: 1 + part,
				striking: false,
			});
		// A mix: the row where each outcome other than the good ones runs highest, weighed against its rate overall.
		if (spec.normalized && spec.tones)
			series.forEach((entry, index) => {
				if (spec.tones![index] === "good" || !(sums[index]! > 0) || !(grand > 0)) return;
				const rates = categories.map((_, at) => {
					const total =
						spec.whole?.points[at]?.value ||
						series.reduce((sum, other) => sum + (other.points[at]?.value ?? 0), 0);
					return total > 0 ? (entry.points[at]?.value ?? 0) / total : 0;
				});
				const top = rates.indexOf(Math.max(...rates));
				facts.push({
					key: `mix:${entry.name}`,
					text: `${name(top)} has the highest ${entry.name} rate (${percentText(rates[top]! * 100)})`,
					weight: 1 + Math.log(rates[top]! / (sums[index]! / grand)),
					striking: false,
				});
			});
	} else if ((spec.kind === "timeline" || spec.kind === "waterfall") && spec.total) {
		facts.push(...flowFacts(spec, spec.total.point));
	} else if (spec.kind === "share") {
		const top = byValue(series[0]!.points)[0];
		const total = series[0]!.points.reduce((sum, point) => sum + Math.max(0, point?.value ?? 0), 0);
		// Counts gain the share the table never wrote.
		const share =
			top && series[0]!.dim !== "percent" && total > 0
				? `${top.point.text}, ${percentText((100 * top.point.value) / total)}`
				: top?.point.text;
		if (top)
			facts.push({
				key: "share:top",
				text: `${name(top.at)} is the largest share (${share})`,
				weight: 1,
				striking: false,
			});
	} else {
		// Earlier columns are what the table leads with: their facts weigh a little more.
		series.slice(0, TAKEAWAY_SERIES).forEach((entry, index) => {
			for (const fact of extremes(spec, entry)) facts.push({ ...fact, weight: fact.weight - 0.2 * index });
		});
		facts.push(...rivalry(spec));
	}
	return facts;
}

/**
 * What a run of steps is mostly made of: the largest step (or group of steps)
 * making up {@link DOMINANT_PART} of `total`; or the two largest together
 * making up {@link DOMINANT_PAIR} of it, the second {@link SECOND_PART} at
 * least, when the first alone falls short or the table bolded both — striking
 * in a run of four or more.
 */
function flowFacts(spec: ChartSpec, total: ChartPoint): Fact[] {
	const entry = spec.series[0]!;
	if (total.value <= 0) return [];
	let at = 0;
	const units = spec.groups
		? spec.groups.flatMap(group => {
				const points = group.members.map(() => entry.points[at++]);
				// Rows outside every group stand on their own.
				return group.name && points.length > 1
					? [{ name: group.name, value: points.reduce((sum, point) => sum + (point?.value ?? 0), 0), bold: false }]
					: points.map((point, index) => ({
							name: spec.categories[at - points.length + index]!,
							value: point?.value ?? 0,
							bold: point?.emphasis ?? false,
						}));
			})
		: spec.categories.map((name, index) => ({
				name,
				value: entry.points[index]?.value ?? 0,
				bold: entry.points[index]?.emphasis ?? false,
			}));
	if (units.some(unit => unit.value < 0)) return [];
	units.sort((a, b) => b.value - a.value);
	const [first, second] = units;
	if (!first || !second) return [];
	const of = total.text ? `of ${total.text}` : "of the total";
	const lead = first.value / total.value;
	const pair = (first.value + second.value) / total.value;
	const striking = units.length >= 4;
	// The largest alone tells most of it, unless the table bolded the second beside it.
	const named = lead < DOMINANT_PART || (first.bold && second.bold);
	if (named && pair >= DOMINANT_PAIR && second.value / total.value >= SECOND_PART)
		return [
			{
				key: `part:${first.name}`,
				text: `${first.name} and ${second.name} are ${Math.round(pair * 100)}% ${of}`,
				weight: 1 + pair,
				striking,
			},
		];
	if (lead < DOMINANT_PART) return [];
	return [
		{
			key: `part:${first.name}`,
			text: `${first.name} is ${Math.round(lead * 100)}% ${of}`,
			weight: 1 + lead,
			striking,
		},
	];
}

/** `facts` strongest first, one per key, at most {@link MAX_TAKEAWAYS}. */
function rankFacts(facts: Fact[]): Takeaway[] {
	facts.sort((a, b) => b.weight - a.weight);
	const seen = new Set<string>();
	return facts
		.filter(fact => !seen.has(fact.key) && seen.add(fact.key))
		.slice(0, MAX_TAKEAWAYS)
		.map(({ key, text, striking }) => ({ key, text, striking }));
}

/**
 * Facts across rivals' best values ({@link ChartSeries.best},
 * {@link ChartSpec.leaders}): one row best on two or more measures (a sweep),
 * best on a higher-is-better measure while worst on a lower-is-better one (a
 * trade-off: the top pass rate at the top cost), or one column best in most rows.
 */
function rivalry(spec: ChartSpec): Fact[] {
	const { categories, series } = spec;
	const facts: Fact[] = [];
	const bests = new Map<number, ChartSeries[]>();
	for (const entry of series) {
		if (entry.best === undefined) continue;
		bests.set(entry.best, [...(bests.get(entry.best) ?? []), entry]);
	}
	for (const [at, won] of bests) {
		if (won.length < 2) continue;
		facts.push({
			key: `sweep:${categories[at]}`,
			text: `${categories[at]} is best on ${list(won.map(entry => entry.name))}`,
			weight: RIVALRY_WEIGHT + 0.3 * won.length,
			striking: true,
		});
	}
	for (const gain of series.filter(entry => entry.polarity === "higher" && entry.best !== undefined)) {
		const top = gain.best!;
		for (const price of series.filter(entry => entry.polarity === "lower")) {
			const costliest = byValue(price.points);
			if (costliest[0]?.at !== top || costliest[1]?.point.value === costliest[0].point.value) continue;
			facts.push({
				key: `tradeoff:${gain.name}:${price.name}`,
				text: `${categories[top]} has the highest ${gain.name} (${gain.points[top]!.text}) but also the highest ${price.name} (${price.points[top]!.text})`,
				// Above a two-measure sweep (often one measure twice: `pass` and `pass%`), below a wider one.
				weight: RIVALRY_WEIGHT + 0.7,
				striking: true,
			});
		}
	}
	const leaders = spec.leaders ?? [];
	const decided = leaders.filter(lead => lead !== undefined);
	if (decided.length >= 3) {
		const wins = new Map<number, number>();
		for (const lead of decided) wins.set(lead, (wins.get(lead) ?? 0) + 1);
		const [index, count] = [...wins].sort((a, b) => b[1] - a[1])[0]!;
		if (count * 3 >= decided.length * 2)
			facts.push({
				key: `leader:${series[index]!.name}`,
				text: `${series[index]!.name} is best in ${count === leaders.length ? "every row" : `${count} of ${leaders.length} rows`}`,
				weight: RIVALRY_WEIGHT + count / leaders.length,
				striking: true,
			});
	}
	return facts;
}

/**
 * Every category moving one way by more than {@link STILL_FACTOR} (three at
 * least): `every model fell (median 2.5× less)`, or `improved` / `regressed`
 * where each category's polarity agrees on it. Striking: a whole table
 * moving together is what a before/after is usually written to show.
 */
function consensusMove(
	spec: ChartSpec,
	factors: readonly (number | undefined)[],
	polarities: readonly (Polarity | undefined)[] | undefined,
	subject: string,
	span: string,
): Fact | undefined {
	const moved = factors.flatMap((factor, at) =>
		factor !== undefined && factor > 0 && Math.abs(Math.log(factor)) >= Math.log(STILL_FACTOR)
			? [{ at, factor }]
			: [],
	);
	if (moved.length < 3 || moved.length < spec.categories.length) return undefined;
	const down = moved.every(item => item.factor < 1);
	if (!down && !moved.every(item => item.factor > 1)) return undefined;
	const tones = moved.map(item => polarities?.[item.at] && item.factor > 1 === (polarities[item.at] === "higher"));
	const verb = tones.every(tone => tone === true)
		? "improved"
		: tones.every(tone => tone === false)
			? "regressed"
			: down
				? "fell"
				: "rose";
	const sorted = moved.map(item => item.factor).sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)]!;
	return {
		key: "moves",
		text: `${subject[0]!.toUpperCase()}${subject.slice(1)} ${verb}${span} (median ${factorWords(median)})`,
		// The whole table moving together outranks any one move in it.
		weight: CONSENSUS_WEIGHT + Math.abs(Math.log(median)),
		striking: true,
	};
}

/** What a sentence calls one category: the axis name when it is one short word (`model`), else `row`. */
function rowNoun(spec: ChartSpec): string {
	if (!/^[a-z]{1,16}$/i.test(spec.axis)) return "row";
	// A plural header (`Blocks`) names one row in the singular.
	return spec.axis.toLowerCase().replace(/([^s])s$/, "$1");
}

/** `a`, `a and b`, `a, b and c`. */
function list(names: readonly string[]): string {
	return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Present points of `points`, largest first. */
function byValue(points: readonly (ChartPoint | null)[]): { at: number; point: ChartPoint }[] {
	return points.flatMap((point, at) => (point ? [{ at, point }] : [])).sort((a, b) => b.point.value - a.point.value);
}

/**
 * A series' extremes as takeaways: a group (or category) standing
 * {@link OUTLIER}× above the next, the top value (or a tie for it), and for a
 * lower-is-better series its lowest; the best value of a series with a
 * polarity weighs more.
 */
function extremes(spec: ChartSpec, entry: ChartSeries): Fact[] {
	const facts: Fact[] = [];
	const name = (at: number) => spec.categories[at]!;
	const ranked = byValue(entry.points);
	if (ranked.length < 3) return facts;
	const [top, second] = [ranked[0]!, ranked[1]!];
	const bottom = ranked.at(-1)!;
	const groups = spec.groups;
	if (groups && groups.length >= 2) {
		// Each group's mean: whole blocks outweighing the rest (one model's every harness).
		let at = 0;
		const means = groups.map(group => {
			const values = group.members.flatMap(() => {
				const point = entry.points[at++];
				return point ? [point.value] : [];
			});
			return {
				name: group.name,
				members: group.members.join("\0"),
				mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN,
			};
		});
		const sorted = means.filter(group => Number.isFinite(group.mean)).sort((a, b) => b.mean - a.mean);
		if (sorted.length >= 2 && sorted[1]!.mean > 0 && sorted[0]!.mean / sorted[1]!.mean >= OUTLIER) {
			const factor = sorted[0]!.mean / sorted[1]!.mean;
			// Blocks of the same members (each model's `baseline`, `bash`, `http`) compare like for like;
			// blocks of different members (`macOS` timed on larger trees than `Linux`) only a judge can weigh.
			const alike = sorted[0]!.members === sorted[1]!.members;
			facts.push({
				key: `outlier:${entry.name}`,
				text: `${sorted[0]!.name} has ${roundFactor(factor)}× the ${entry.name} of ${sorted[1]!.name}`,
				weight: Math.log(factor) + 1,
				// A volume one block dwarfs (tokens per model) is the story; a ranked measure's is a judge's call.
				striking: factor >= STRIKING && alike && !entry.polarity,
			});
		}
	}
	if (second.point.value > 0 && top.point.value / second.point.value >= OUTLIER) {
		const factor = top.point.value / second.point.value;
		facts.push({
			key: `outlier:${entry.name}`,
			text: `${name(top.at)} has ${roundFactor(factor)}× the ${entry.name} of the next (${top.point.text} vs ${second.point.text})`,
			weight: Math.log(factor) + 1,
			// Any column may hold one large count; a rival far ahead on a ranked measure is a finding.
			striking: entry.best === top.at && factor >= STRIKING,
		});
	}
	const tied = ranked.filter(item => item.point.value === top.point.value);
	if (tied.length >= 2 && tied.length < ranked.length) {
		const names = tied.length === 2 ? `${name(tied[0]!.at)} and ${name(tied[1]!.at)}` : `${tied.length} rows`;
		facts.push({
			key: `tie:${entry.name}`,
			text: `${names} tie for the highest ${entry.name} (${top.point.text})`,
			weight: entry.polarity === "higher" ? 0.9 : 0.3,
			striking: false,
		});
	} else if (tied.length === 1) {
		facts.push({
			key: `top:${entry.name}`,
			text: `${name(top.at)} has the highest ${entry.name} (${top.point.text})`,
			weight: entry.polarity === "higher" ? 0.9 : 0.3,
			striking: false,
		});
	}
	if (entry.polarity === "lower" && ranked.filter(item => item.point.value === bottom.point.value).length === 1)
		facts.push({
			key: `low:${entry.name}`,
			text: `${name(bottom.at)} has the lowest ${entry.name} (${bottom.point.text})`,
			weight: 0.9,
			striking: false,
		});
	return facts;
}

/**
 * A share in percent as a chart writes it: whole percents, one decimal within
 * 1 of either end (`0.4%`, `99.6%`) so a sliver never rounds to nothing or
 * everything, and `<0.1%` / `>99.9%` past that. Exported for the renderer.
 */
export function percentText(percent: number): string {
	if (percent <= 0 || percent >= 100) return `${Math.max(0, Math.min(100, percent))}%`;
	if (percent < 0.05) return "<0.1%";
	if (percent >= 99.95) return ">99.9%";
	return percent < 1 || percent > 99 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/** A factor as people say it: `48× less`, `2.1× more`, or a percent within 2× (`−12%`, `+27%`). */
function factorWords(factor: number): string {
	if (factor === 0) return "−100%";
	if (factor >= 2) return `${roundFactor(factor)}× more`;
	if (factor <= 0.5) return `${roundFactor(1 / factor)}× less`;
	const percent = Math.round((factor - 1) * 100);
	return percent === 0 ? "same" : `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%`;
}

/** `48`, `2.1`: whole from 10, one decimal below. */
function roundFactor(factor: number): string {
	return factor >= 10 ? Math.round(factor).toLocaleString("en-US") : Number(factor.toFixed(1)).toString();
}

/**
 * Whether a chart of `spec` reads faster than its table: at least four
 * categories (or small-multiple panels), and either nine plotted values or a
 * 3× spread within a series. On a model-judged sample of assistant tables this
 * gate kept 85% of the tables a chart clearly helped while rejecting most two-
 * and three-row ones. A `change` needs three metrics and one moving by
 * {@link NOTABLE_FACTOR} either way: its factors are what the table lacks.
 */
export function worthCharting(spec: ChartSpec): boolean {
	const { kind, categories, series } = spec;
	// Factors share no unit with the table's figures: three metrics are enough once one moves noticeably.
	if (kind === "change")
		return (
			categories.length >= 3 &&
			series.some(entry =>
				entry.points.some(point => point && Math.abs(Math.log(point.value)) >= Math.log(NOTABLE_FACTOR)),
			)
		);
	// Counts splitting a total gain the shares the table never wrote: three parts are worth a bar.
	if (kind === "share" && series[0]!.dim !== "percent") return categories.length >= 3;
	// Intervals are hard to compare in a table: four categories suffice, three once a pair (or a band) doubles them.
	if (kind === "range") return categories.length >= 4 || (categories.length === 3 && series.length >= 2);
	// Small multiples compare within each panel, so four metrics count like four categories;
	// a waterfall's total is a bar of its own.
	const bars =
		kind === "multiples"
			? Math.max(categories.length, series.length)
			: kind === "waterfall"
				? categories.length + 1
				: categories.length;
	if (bars < 4) return false;
	let points = 0;
	let spread = 1;
	for (const entry of series) {
		const positive: number[] = [];
		for (const point of entry.points) {
			if (!point) continue;
			points++;
			if (point.value > 0) positive.push(point.value);
		}
		if (positive.length >= 2) spread = Math.max(spread, Math.max(...positive) / Math.min(...positive));
	}
	return points >= 9 || spread >= 3;
}

/**
 * The nearest kind `kind` draws as for `series`: a shared axis needs one unit
 * (else small multiples), bars take one series, a dumbbell two, grouped bars
 * up to four (more become a heatmap), and a scatter needs its x measure.
 */
function fitKind(kind: ChartKind, series: readonly ChartSeries[], hasX: boolean): ChartKind {
	if (kind === "multiples") return kind;
	if (kind === "scatter" && hasX) return kind;
	// Intervals band by unit, each band on its own axis ({@link buildChart} checks they are mostly intervals).
	if (kind === "range") return kind;
	if (new Set(series.map(entry => `${entry.dim}:${entry.unit}`)).size > 1) return "multiples";
	// Dots share one axis: two to six series, one dot color each.
	if (kind === "dots") return series.length === 1 ? "bar" : series.length <= SERIES_COLORS ? kind : "heatmap";
	if (kind === "share" || kind === "diverging" || kind === "line" || kind === "heatmap") return kind;
	// A run of steps: one series, every step present; a timeline's segments are lengths, never negative.
	if (
		(kind === "timeline" || kind === "waterfall") &&
		series.length === 1 &&
		series[0]!.points.every(point => point && (kind === "waterfall" || point.value >= 0))
	)
		return kind;
	// Parts of a whole stack while a bar stays legible: up to six segments, none negative.
	if (
		kind === "stacked" &&
		series.length >= 2 &&
		series.length <= SERIES_COLORS &&
		series.every(entry => entry.points.every(point => !point || point.value >= 0))
	)
		return kind;
	if (
		kind === "progress" &&
		series.length <= MAX_TRACKS &&
		series.every(
			entry =>
				entry.dim === "percent" && entry.points.every(point => !point || (point.value >= 0 && point.value <= 100)),
		)
	)
		return kind;
	// Two series pair up as a dumbbell only when asked to: unrelated quantities stand side by side.
	const count = series.length;
	return count === 1
		? "bar"
		: count === 2 && kind === "paired"
			? "paired"
			: count <= MAX_GROUPED
				? "grouped"
				: "heatmap";
}

/**
 * Baseline and compared columns of a before/after table a shared axis cannot
 * hold: rows in different units, or prose cells (`none seen`) keeping its
 * columns from reading as measures. The baseline is the `before` column; the
 * compared ones are the `after` column and any measure beside it pairing with
 * the baseline in two or more rows. Deltas and columns holding their own
 * `a → b` transitions take no part.
 */
function changeColumns(table: TableAnalysis): TableColumn[] | undefined {
	const { label } = table;
	if (label?.role !== "label") return undefined;
	const values = table.columns.filter(
		column =>
			column !== label &&
			(column.role === "measure" || column.role === "label") &&
			!DELTA.test(column.header) &&
			!ARROW.test(column.header) &&
			column.arrowShare < 0.6,
	);
	const baseline = values.find(column => BEFORE.test(column.header));
	if (!baseline) return undefined;
	const rows = [...table.rows, ...table.totals];
	const compared = values.filter(
		column =>
			column !== baseline &&
			(column.role === "measure" || AFTER.test(column.header)) &&
			rows.filter(row => changePoint(baseline.cells[row], column.cells[row])).length >= 2,
	);
	if (!compared.some(column => AFTER.test(column.header))) return undefined;
	const columns = [baseline, ...compared];
	// One unit throughout: a shared axis holds the values themselves (`paired`, `grouped`).
	if (columns.every(column => column.role === "measure" && !column.mixed)) return undefined;
	return columns;
}

/**
 * A `change` over `columns`: per row, each compared column as a factor of the
 * baseline's value (or of its own column in `baselines`), or the `a → b` cells
 * of each column as factors of their start. Total rows stay (a factor never
 * skews the scale); rows with no pair are named in the caption instead.
 */
function changeChart(
	table: TableAnalysis,
	plan: ChartPlan,
	namers: readonly TableColumn[],
	group: TableColumn | undefined,
	columns: readonly TableColumn[],
	baselines?: readonly TableColumn[],
): ChartSpec | undefined {
	const [baseline, ...picked] = columns;
	if (!baseline) return undefined;
	// A delta is no value to take a factor of: `+21.7pp` over `44.3%` would read as a regression.
	const values = picked.filter(column => !DELTA.test(column.header));
	const compared = values.length ? values : picked;
	const [from, to] = arrowNames(baseline.header);
	// Each series improves the way its measure does: the compared column's polarity, else its baseline's.
	const improves = (column: TableColumn, before = baseline) =>
		plan.polarity?.[column.index] ?? plan.polarity?.[before.index];
	let pairs: { name: string; polarity?: Polarity; at: (row: number) => ChartPoint | undefined }[];
	let against: string;
	if (baselines) {
		// Metric pairs: each series against its own before column, the legend naming the before condition.
		pairs = columns.map((column, at) => ({
			name: column.header,
			polarity: improves(column, baselines[at]),
			at: row => changePoint(baselines[at]!.cells[row], column.cells[row]),
		}));
		against = BEFORE.exec(baselines[0]!.header)?.[0] ?? baselines[0]!.header;
	} else if (compared.length > 0 && columns.every(column => column.arrowShare >= 0.6)) {
		// `a → b` columns each move from their own start: one series per column, named by what it measures.
		pairs = columns.map(column => ({
			name: arrowSubject(column.header),
			polarity: improves(column),
			at: row => arrowChange(column.cells[row]),
		}));
		against = BEFORE.exec(from)?.[0] ?? "before";
	} else if (compared.length > 0) {
		pairs = compared.map(column => ({
			name: column.header,
			polarity: improves(column),
			at: row => changePoint(baseline.cells[row], column.cells[row]),
		}));
		against = baseline.header;
	} else {
		pairs = [{ name: to, polarity: improves(baseline), at: row => arrowChange(baseline.cells[row]) }];
		against = from;
	}
	const rows = regroup(
		[...table.rows, ...table.totals].sort((a, b) => a - b),
		group,
	);
	const kept = rows.filter(row => pairs.some(pair => pair.at(row)));
	if (kept.length < 2) return undefined;
	const all = nameRows(namers, undefined, rows).names;
	const skipped = rows.flatMap((row, at) => (kept.includes(row) ? [] : [all[at]!]));
	const naming = nameRows(namers, group, kept, true);
	const spec: ChartSpec = {
		kind: "change",
		categories: naming.names,
		groups: naming.groups,
		series: pairs.map(pair => ({
			name: pair.name,
			dim: "ratio",
			unit: "",
			points: kept.map(row => pair.at(row) ?? null),
			notes: kept.map(() => undefined),
			polarity: pair.polarity,
		})),
		// Commas: a nested row name already holds `·`.
		caption: skipped.length ? `Not plotted: ${skipped.join(", ")}` : undefined,
		axis: naming.axis,
		baseline: against,
		categoryPolarity: kept.map(row => plan.rowPolarity?.[row]),
	};
	return withMeaning(table, plan, spec, kept);
}

/** What an `a → b` header's column measures, its condition words dropped (`mean before → after` → `mean`). */
function arrowSubject(header: string): string {
	const [from] = header.split(ARROW);
	const subject = from?.replace(new RegExp(BEFORE.source, "gi"), "").replace(/\s+/g, " ").trim();
	return subject || header;
}

/** `to` as a factor of `from` (`59.4 s → 1.23 s` is 0.0207), when both are numbers of one dimension. */
function changePoint(from: Cell | undefined, to: Cell | undefined): ChartPoint | undefined {
	if (!isNumber(from) || !isNumber(to) || from.dim !== to.dim || from.value <= 0 || to.value < 0) return undefined;
	return {
		value: to.value / from.value,
		text: `${from.figure} → ${to.figure}`,
		emphasis: from.emphasis || to.emphasis,
	};
}

/** An `a → b` cell as the factor `b ÷ a`. */
function arrowChange(cell: Cell | undefined): ChartPoint | undefined {
	if (!isNumber(cell) || cell.to === undefined || cell.value <= 0 || cell.to < 0) return undefined;
	return { value: cell.to / cell.value, text: `${cell.figure} → ${cell.toFigure ?? ""}`, emphasis: cell.emphasis };
}

/** The from and to names in an `a → b` header (`out tokens r5 → r6`), else `before` and `after`. */
function arrowNames(header: string): [string, string] {
	const [from, to] = header.split(ARROW);
	return from && to ? [from, to] : ["before", "after"];
}

/** What a chart calls each of its rows. */
interface RowNames {
	readonly names: readonly string[];
	/** Headers of the columns the names come from. */
	readonly axis: string;
	readonly groups?: readonly ChartGroup[];
}

/**
 * Names of `rows` from the `namers` cells, in table order (`Sonnet 5.5 ·
 * bash`), `#n` where they are all empty. Runs of one `group` value become
 * {@link ChartGroup}s holding the rest of each name; the caller {@link regroup}s
 * the rows first. Without a group, `nest` lets names sharing a leading part
 * nest under it ({@link nestNames}). Names are tidied for display ({@link tidyNames}):
 * group names across groups, members within their group.
 */
function nameRows(
	namers: readonly TableColumn[],
	group: TableColumn | undefined,
	rows: readonly number[],
	nest = false,
): RowNames {
	const join = (columns: readonly TableColumn[], row: number) =>
		columns
			.map(column => nameCell(column, row))
			.filter(Boolean)
			.join(NAME_JOIN);
	const full = rows.map((row, at) => join(namers, row) || `#${at + 1}`);
	const axis = namers
		.map(column => column.header)
		.filter(Boolean)
		.join(NAME_JOIN);
	const rest = namers.filter(column => column !== group);
	if (!group || rest.length === 0) {
		const nested = nest ? nestNames(full) : undefined;
		return nested ? { names: full, axis, groups: nested } : { names: tidyNames(full), axis };
	}
	const groups: { name: string; members: string[] }[] = [];
	for (const row of rows) {
		const name = nameCell(group, row);
		const last = groups.at(-1);
		if (last?.name === name) last.members.push(join(rest, row));
		else groups.push({ name, members: [join(rest, row)] });
	}
	// Runs of one row already name every row once.
	if (groups.length === rows.length) return { names: tidyNames(full), axis };
	const heads = tidyNames(groups.map(entry => entry.name));
	return {
		names: full,
		axis,
		groups: groups.map((entry, at) => ({ name: heads[at]!, members: tidyNames(entry.members) })),
	};
}

/**
 * Row names nested under a leading part they share, when that reads as an
 * outline: `glm new`, `glm prior`, `claude new` → `glm` › `new`, `prior`;
 * `sofa-base`, `sofa-arm` → `sofa` › `base`, `arm`. Splits every name at the
 * first {@link NEST_SEPARATORS} entry that nests the most rows, each leading
 * part in one consecutive run of two or more. Rows outside every run stay
 * whole, in nameless groups. Needs {@link NEST_SHARE} of the rows nested, and
 * more than one group (a part every row shares is a prefix for {@link tidyNames}).
 */
function nestNames(names: readonly string[]): ChartGroup[] | undefined {
	if (names.length < 3) return undefined;
	let best: { groups: ChartGroup[]; nested: number } | undefined;
	for (const separator of NEST_SEPARATORS) {
		const runs: { head: string | undefined; members: string[]; names: string[] }[] = [];
		const seen = new Set<string>();
		let valid = true;
		for (const name of names) {
			const at = name.indexOf(separator);
			const head = at >= MIN_NEST_HEAD ? name.slice(0, at) : undefined;
			const member = head === undefined ? "" : name.slice(at + separator.length).trim();
			const last = runs.at(-1);
			if (head !== undefined && member && last?.head === head) {
				last.members.push(member);
				last.names.push(name);
				continue;
			}
			if (head !== undefined && member) {
				if (seen.has(head)) {
					valid = false;
					break;
				}
				seen.add(head);
			}
			runs.push({ head: member ? head : undefined, members: [member], names: [name] });
		}
		if (!valid) continue;
		const groups: { name: string; members: string[] }[] = [];
		let nested = 0;
		let named = 0;
		for (const run of runs) {
			if (run.head !== undefined && run.members.length >= 2) {
				groups.push({ name: run.head, members: tidyNames(run.members) });
				nested += run.members.length;
				named++;
				continue;
			}
			const last = groups.at(-1);
			if (last?.name === "") last.members.push(...run.names);
			else groups.push({ name: "", members: [...run.names] });
		}
		if (named === 0 || nested < names.length * NEST_SHARE || (named === 1 && nested === names.length)) continue;
		if (!best || nested > best.nested) best = { groups, nested };
	}
	return best?.groups;
}

/**
 * Shorter names that still tell `names` apart, for labels: a path-like name
 * (`~/.omp/agent/history.db`, `openai/gpt-5.5:xhi`) by its last segment; among
 * such single-token names, a prefix or suffix all share at a separator
 * (`/vs/…`, `…:xhi`) dropped, unless only numbers or dates would remain; and
 * when most names past {@link MAX_LABEL} overflow with a description, every
 * name cut before its own (`Payroll (10 people…)`, `@watzon — #19, #53`). Each step applies only
 * when the names stay distinct; names that clash already stay as written.
 */
function tidyNames(names: readonly string[]): string[] {
	const usable = (list: readonly string[]) =>
		list.every(name => name.length >= 2) &&
		new Set(list).size === list.length &&
		!list.every(name => /^[\d\s.,:/+\-–]+$/.test(name));
	let tidy = [...names];
	if (tidy.length < 2 || !usable(tidy)) return tidy;
	if (tidy.every(name => /[^/\s]\/[^/\s]/.test(name) && !/\s/.test(name))) {
		const tails = tidy.map(name => name.replace(/\/+$/, "").split("/").at(-1)!);
		if (usable(tails)) tidy = tails;
	}
	if (tidy.length >= 3 && tidy.every(name => !/\s/.test(name))) {
		const prefix = sharedEdge(tidy, "start");
		const trimmed = tidy.map(name => name.slice(prefix.length).replace(/^[\s,;:·/_-]+/, ""));
		if (prefix.length >= 3 && usable(trimmed)) tidy = trimmed;
		const suffix = sharedEdge(tidy, "end");
		const cut = tidy.map(name => name.slice(0, name.length - suffix.length).replace(/[\s,;:·/_-]+$/, ""));
		if (suffix.length >= 3 && usable(cut)) tidy = cut;
	}
	// Descriptions go when they are what makes names overflow: most long names carry one.
	const long = tidy.filter(name => name.length > MAX_LABEL);
	if (long.filter(name => name.search(DESCRIPTION) >= 2).length * 2 <= long.length) return tidy;
	const short = tidy.map(name => {
		const at = name.search(DESCRIPTION);
		return at >= 2 ? name.slice(0, at).replace(/[\s,;:·—–-]+$/, "") : name;
	});
	return usable(short) ? short : tidy;
}

/** The longest start (or end) every name shares, ending (or starting) at a separator: `/vs/`, `:xhi`, `_PRODUCTION`. */
function sharedEdge(names: readonly string[], edge: "start" | "end"): string {
	const read = (name: string) => (edge === "start" ? name : [...name].reverse().join(""));
	const first = read(names[0]!);
	let length = first.length;
	for (const name of names) {
		const other = read(name);
		let at = 0;
		while (at < length && at < other.length && other[at] === first[at]) at++;
		length = at;
	}
	// Back off to a boundary: the shared part ends in a separator, so no word is cut.
	while (length > 0 && !/[/:_-]/.test(first[length - 1]!)) length--;
	const shared = first.slice(0, length);
	return edge === "start" ? shared : [...shared].reverse().join("");
}

/** `rows` in time order when `label` holds dates: a line runs left to right whatever order the table lists them. */
function chronological(rows: readonly number[], label: TableColumn | undefined): readonly number[] {
	if (label?.role !== "temporal") return rows;
	const times = new Map(rows.map(row => [row, Date.parse(label.cells[row]!.text)]));
	for (const time of times.values()) if (!Number.isFinite(time)) return rows;
	return rows.toSorted((a, b) => times.get(a)! - times.get(b)!);
}

/** `rows` with each `group` value gathered into one run, runs in order of first appearance, rows within a run in table order. */
function regroup(rows: readonly number[], group: TableColumn | undefined): readonly number[] {
	if (!group) return rows;
	const runs = new Map<string, number>();
	for (const row of rows) {
		const name = nameCell(group, row);
		if (!runs.has(name)) runs.set(name, runs.size);
	}
	return rows.toSorted((a, b) => runs.get(nameCell(group, a))! - runs.get(nameCell(group, b))!);
}

/**
 * Columns that may join `label` in naming rows: short text or date columns
 * whose cells vary (a column of one value tells no rows apart).
 */
export function namingColumns(table: TableAnalysis, label: TableColumn | undefined): TableColumn[] {
	const { rows } = table;
	return table.columns.filter(
		column =>
			column !== label &&
			(column.role === "label" || column.role === "temporal") &&
			rows.every(row => nameCell(column, row).length <= MAX_NAME_PART) &&
			new Set(rows.map(row => nameCell(column, row))).size > 1,
	);
}

/**
 * The local guess at the columns naming rows beside `label`: the fewest of
 * `spare` (by default {@link namingColumns}) that tell repeated labels apart
 * (`Model | Harness`), the one with the fewest distinct values first (a factor
 * like `Harness`, not a notes column); and as the group, the first naming
 * column already running in blocks, so table order stays as written.
 */
export function guessNaming(
	table: TableAnalysis,
	label: TableColumn | undefined,
	spare: readonly TableColumn[] = namingColumns(table, label),
): { qualifiers: readonly number[]; group: number | undefined } {
	const { rows } = table;
	if (!label) return { qualifiers: [], group: undefined };
	const clashes = (columns: readonly TableColumn[]) =>
		rows.length - new Set(rows.map(row => columns.map(column => nameCell(column, row)).join("\0"))).size;
	const namers = [label];
	let clash = clashes(namers);
	while (clash > 0) {
		// Stable sort: equal candidates keep table order.
		const next = spare
			.filter(column => !namers.includes(column))
			.map(column => ({
				column,
				clash: clashes([...namers, column]),
				distinct: new Set(rows.map(row => nameCell(column, row))).size,
			}))
			.filter(candidate => candidate.clash < clash)
			.sort((a, b) => a.clash - b.clash || a.distinct - b.distinct)[0];
		if (!next) break;
		namers.push(next.column);
		clash = next.clash;
	}
	const qualifiers = namers.slice(1).map(column => column.index);
	if (qualifiers.length === 0) return { qualifiers, group: undefined };
	namers.sort((a, b) => a.index - b.index);
	const group = namers.find(column => inRuns(rows.map(row => nameCell(column, row))));
	return { qualifiers, group: group?.index };
}

/**
 * The local guess at the reference rows: a naming cell that says so
 * ({@link REFERENCE_ROW}: `baseline`, `#1 (baseline)`, `current-api`), the
 * qualifiers searched before the label (`Harness` = `baseline` within each
 * model). Its value must mark one row, or one in each value of the label
 * when it marks a qualifier; the strongest word wins (`baseline` over `current`).
 */
function guessReference(
	table: TableAnalysis,
	label: TableColumn | undefined,
	qualifiers: readonly number[],
): RowReference | undefined {
	if (!label) return undefined;
	const columns = [...qualifiers.toReversed().map(index => table.columns[index]!), label];
	for (const column of columns) {
		let best: { value: string; rank: number } | undefined;
		let tied = false;
		for (const value of new Set(table.rows.map(row => nameCell(column, row)))) {
			const word = REFERENCE_ROW.exec(value)?.groups;
			const name = (word?.lead ?? word?.marked)?.toLowerCase();
			if (!name) continue;
			const rank = REFERENCE_WORDS.indexOf(name);
			if (best && rank === best.rank) tied = true;
			if (!best || rank < best.rank) {
				best = { value, rank };
				tied = false;
			}
		}
		if (!best || tied) continue;
		const { value } = best;
		const marked = table.rows.filter(row => nameCell(column, row) === value);
		const owners = new Set(marked.map(row => nameCell(label, row)));
		if (column === label ? marked.length === 1 : owners.size === marked.length && owners.size >= 2)
			return { column: column.index, value };
	}
	return undefined;
}

/**
 * How a heatmap of `columns` over `rows` should shade: each column on its own
 * when two columns typically differ {@link QUANTITY_SPREAD}× within a row
 * (different quantities, like input vs. reasoning tokens), each row on its
 * own when two rows typically do within a column (one measure on a small and
 * a huge item) and a row's cells typically differ {@link ROW_CONTRAST}×,
 * else one scale for every cell. The local default of the
 * judge's shading answer.
 */
export function guessShading(columns: readonly TableColumn[], rows: readonly number[]): Shading {
	const grid = rows.map(row =>
		columns.map(column => {
			const cell = column.cells[row];
			return isNumber(cell) && cell.value > 0 ? cell.value : Number.NaN;
		}),
	);
	if (pairSpread(grid) >= QUANTITY_SPREAD) return "series";
	const transposed = columns.map((_, at) => grid.map(values => values[at]!));
	if (pairSpread(transposed) < QUANTITY_SPREAD) return "shared";
	// Shades from zero tell a row's cells apart only when they differ by a good share (`458 | 163`, not `3.56s | 4.14s`).
	const contrasts = grid
		.map(values => values.filter(Number.isFinite))
		.filter(values => values.length >= 2)
		.map(values => Math.max(...values) / Math.min(...values))
		.sort((a, b) => a - b);
	return (contrasts[contrasts.length >> 1] ?? 1) >= ROW_CONTRAST ? "row" : "shared";
}

/**
 * The widest typical ratio between two columns of `grid` (rows of positive
 * values, `NaN` where absent): per pair, the median of their ratios over the
 * rows holding both.
 */
function pairSpread(grid: readonly (readonly number[])[]): number {
	const width = grid[0]?.length ?? 0;
	let widest = 1;
	for (let a = 0; a < width; a++) {
		for (let b = a + 1; b < width; b++) {
			const ratios = grid
				.map(values => values[a]! / values[b]!)
				.filter(Number.isFinite)
				.sort((x, y) => x - y);
			if (ratios.length < 2) continue;
			const middle = ratios[Math.floor(ratios.length / 2)]!;
			widest = Math.max(widest, middle, 1 / middle);
		}
	}
	return widest;
}

/** A naming cell's text; a blank or a dash names nothing, a word read as missing (`na`, `none`) still names its row. */
function nameCell(column: TableColumn, row: number): string {
	const cell = column.cells[row]!;
	return cell.kind === "missing" && !/[\p{L}\p{N}]/u.test(cell.text) ? "" : cell.text;
}

/** Each distinct value in one consecutive run, one run at least two long: a name a chart can write once per run. */
function inRuns(values: readonly string[]): boolean {
	const seen = new Set<string>();
	let repeats = false;
	for (let at = 0; at < values.length; at++) {
		const value = values[at]!;
		if (at > 0 && value === values[at - 1]) repeats = true;
		else if (seen.has(value)) return false;
		else seen.add(value);
	}
	return repeats;
}

/** Same-unit aggregate columns (`Total`, `avg`) restate the series beside them. */
function dropAggregates(measures: readonly TableColumn[]): readonly TableColumn[] {
	return measures.filter(
		column =>
			!AGGREGATE.test(column.header) ||
			measures.filter(other => other !== column && other.dim === column.dim).length < 2,
	);
}

/** How the label column orders the rows: by time, by step, by a numeric size — or not at all. */
function axisOrder(
	table: TableAnalysis,
	label: TableColumn | undefined,
): "temporal" | "sequence" | "numeric" | undefined {
	if (!label) return undefined;
	if (label.role === "temporal") return "temporal";
	// Repeating steps (`Tier` 1, 1, 2) bucket the rows rather than order an axis.
	if (label.role === "sequence") return isMonotonic(columnValues(label, table.rows)) ? "sequence" : undefined;
	const names = table.rows.map(row => label.cells[row]!.text);
	const mostly = (pattern: RegExp) => names.filter(name => pattern.test(name)).length >= names.length * 0.8;
	if (mostly(SEQUENCE_LABEL)) return "sequence";
	if (mostly(MONTH)) return "temporal";
	const values = columnValues(label, table.rows);
	if (values.length === names.length && values.length >= 3 && isMonotonic(values)) return "numeric";
	return undefined;
}

function columnValues(column: TableColumn, rows: readonly number[]): number[] {
	const values: number[] = [];
	for (const row of rows) {
		const cell = column.cells[row];
		if (isNumber(cell)) values.push(cell.value);
	}
	return values;
}

/** A column as a series: its cells of the column's dimension, other cells as gaps (status words kept as notes). */
function columnSeries(column: TableColumn, rows: readonly number[], name: string): ChartSeries {
	const points: (ChartPoint | null)[] = [];
	const notes: (string | undefined)[] = [];
	for (const row of rows) {
		const cell = column.cells[row]!;
		const fits = isNumber(cell) && cell.dim === column.dim;
		points.push(fits ? point(cell) : null);
		notes.push(!fits && cell.kind !== "missing" && !isNumber(cell) ? cell.text : undefined);
	}
	return { name, dim: column.dim ?? "count", unit: column.unit, points, notes };
}

/** One row of a metric-per-row table as a series over the plotted columns, in the row's dominant dimension. */
function rowSeries(name: string, columns: readonly TableColumn[], row: number): ChartSeries {
	const cells = columns.map(column => column.cells[row]);
	const tally = new Map<Dimension, number>();
	for (const cell of cells) if (isNumber(cell)) tally.set(cell.dim, (tally.get(cell.dim) ?? 0) + 1);
	let dim: Dimension = "count";
	for (const [key, count] of tally) if (count > (tally.get(dim) ?? 0)) dim = key;
	const unitCell = cells.find(cell => isNumber(cell) && cell.dim === dim);
	return {
		name,
		dim,
		unit: isNumber(unitCell) && (dim === "currency" || dim === "rate") ? unitCell.unit : "",
		points: cells.map(cell => (isNumber(cell) && cell.dim === dim ? point(cell) : null)),
		notes: cells.map(cell => (cell && !isNumber(cell) && cell.kind !== "missing" ? cell.text : undefined)),
	};
}

/** A numeric cell as a plotted point labelled with its written figure. */
function point(cell: NumberCell): ChartPoint {
	return { value: cell.value, text: cell.figure, emphasis: cell.emphasis, upper: cell.upper };
}

/** `Total: 2,964 · 2,310` for each summary row, over the plotted columns. */
function totalsCaption(
	table: TableAnalysis,
	label: TableColumn | undefined,
	columns: readonly TableColumn[],
	transpose: boolean,
): string | undefined {
	if (transpose || !label || table.totals.length === 0) return undefined;
	const lines = table.totals.slice(0, 2).flatMap(row => {
		const values = columns.map(column => column.cells[row]?.text ?? "").filter(Boolean);
		return values.length ? [`${label.cells[row]!.text}: ${values.join(" · ")}`] : [];
	});
	return lines.length ? lines.join("   ") : undefined;
}
