/**
 * Where brackets, emphasis, code spans, autolinks and inline HTML close in inline Markdown. The indexes are built
 * over one root inline source, each on first use, and shared by every source lexed inside it (a link label, the text
 * of emphasis), so lexing nested sources builds no index of its own and keeps none alive per nesting level.
 */

export const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

// Unicode 17.0 Letter/Number ranges, expanded for ES5 regex engines. Delimiter
// neighbors are single UTF-16 code units, so surrogate halves stay non-word,
// exactly as in the previous Unicode-property test on those same neighbors.
const WORD_CHARACTER = new RegExp(
	"[" +
		"\u0030-\u0039\u0041-\u005a\u0061-\u007a\u00aa\u00b2-\u00b3\u00b5\u00b9-\u00ba\u00bc-\u00be\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02c1\u02c6-\u02d1\u02e0-\u02e4\u02ec\u02ee\u0370-\u0374\u0376-\u0377\u037a-\u037d\u037f\u0386" +
		"\u0388-\u038a\u038c\u038e-\u03a1\u03a3-\u03f5\u03f7-\u0481\u048a-\u052f\u0531-\u0556\u0559\u0560-\u0588\u05d0-\u05ea\u05ef-\u05f2\u0620-\u064a\u0660-\u0669\u066e-\u066f\u0671-\u06d3\u06d5\u06e5-\u06e6\u06ee-\u06fc\u06ff" +
		"\u0710\u0712-\u072f\u074d-\u07a5\u07b1\u07c0-\u07ea\u07f4-\u07f5\u07fa\u0800-\u0815\u081a\u0824\u0828\u0840-\u0858\u0860-\u086a\u0870-\u0887\u0889-\u088f\u08a0-\u08c9\u0904-\u0939\u093d\u0950\u0958-\u0961\u0966-\u096f" +
		"\u0971-\u0980\u0985-\u098c\u098f-\u0990\u0993-\u09a8\u09aa-\u09b0\u09b2\u09b6-\u09b9\u09bd\u09ce\u09dc-\u09dd\u09df-\u09e1\u09e6-\u09f1\u09f4-\u09f9\u09fc\u0a05-\u0a0a\u0a0f-\u0a10\u0a13-\u0a28\u0a2a-\u0a30\u0a32-\u0a33" +
		"\u0a35-\u0a36\u0a38-\u0a39\u0a59-\u0a5c\u0a5e\u0a66-\u0a6f\u0a72-\u0a74\u0a85-\u0a8d\u0a8f-\u0a91\u0a93-\u0aa8\u0aaa-\u0ab0\u0ab2-\u0ab3\u0ab5-\u0ab9\u0abd\u0ad0\u0ae0-\u0ae1\u0ae6-\u0aef\u0af9\u0b05-\u0b0c\u0b0f-\u0b10" +
		"\u0b13-\u0b28\u0b2a-\u0b30\u0b32-\u0b33\u0b35-\u0b39\u0b3d\u0b5c-\u0b5d\u0b5f-\u0b61\u0b66-\u0b6f\u0b71-\u0b77\u0b83\u0b85-\u0b8a\u0b8e-\u0b90\u0b92-\u0b95\u0b99-\u0b9a\u0b9c\u0b9e-\u0b9f\u0ba3-\u0ba4\u0ba8-\u0baa" +
		"\u0bae-\u0bb9\u0bd0\u0be6-\u0bf2\u0c05-\u0c0c\u0c0e-\u0c10\u0c12-\u0c28\u0c2a-\u0c39\u0c3d\u0c58-\u0c5a\u0c5c-\u0c5d\u0c60-\u0c61\u0c66-\u0c6f\u0c78-\u0c7e\u0c80\u0c85-\u0c8c\u0c8e-\u0c90\u0c92-\u0ca8\u0caa-\u0cb3" +
		"\u0cb5-\u0cb9\u0cbd\u0cdc-\u0cde\u0ce0-\u0ce1\u0ce6-\u0cef\u0cf1-\u0cf2\u0d04-\u0d0c\u0d0e-\u0d10\u0d12-\u0d3a\u0d3d\u0d4e\u0d54-\u0d56\u0d58-\u0d61\u0d66-\u0d78\u0d7a-\u0d7f\u0d85-\u0d96\u0d9a-\u0db1\u0db3-\u0dbb\u0dbd" +
		"\u0dc0-\u0dc6\u0de6-\u0def\u0e01-\u0e30\u0e32-\u0e33\u0e40-\u0e46\u0e50-\u0e59\u0e81-\u0e82\u0e84\u0e86-\u0e8a\u0e8c-\u0ea3\u0ea5\u0ea7-\u0eb0\u0eb2-\u0eb3\u0ebd\u0ec0-\u0ec4\u0ec6\u0ed0-\u0ed9\u0edc-\u0edf\u0f00" +
		"\u0f20-\u0f33\u0f40-\u0f47\u0f49-\u0f6c\u0f88-\u0f8c\u1000-\u102a\u103f-\u1049\u1050-\u1055\u105a-\u105d\u1061\u1065-\u1066\u106e-\u1070\u1075-\u1081\u108e\u1090-\u1099\u10a0-\u10c5\u10c7\u10cd\u10d0-\u10fa\u10fc-\u1248" +
		"\u124a-\u124d\u1250-\u1256\u1258\u125a-\u125d\u1260-\u1288\u128a-\u128d\u1290-\u12b0\u12b2-\u12b5\u12b8-\u12be\u12c0\u12c2-\u12c5\u12c8-\u12d6\u12d8-\u1310\u1312-\u1315\u1318-\u135a\u1369-\u137c\u1380-\u138f\u13a0-\u13f5" +
		"\u13f8-\u13fd\u1401-\u166c\u166f-\u167f\u1681-\u169a\u16a0-\u16ea\u16ee-\u16f8\u1700-\u1711\u171f-\u1731\u1740-\u1751\u1760-\u176c\u176e-\u1770\u1780-\u17b3\u17d7\u17dc\u17e0-\u17e9\u17f0-\u17f9\u1810-\u1819\u1820-\u1878" +
		"\u1880-\u1884\u1887-\u18a8\u18aa\u18b0-\u18f5\u1900-\u191e\u1946-\u196d\u1970-\u1974\u1980-\u19ab\u19b0-\u19c9\u19d0-\u19da\u1a00-\u1a16\u1a20-\u1a54\u1a80-\u1a89\u1a90-\u1a99\u1aa7\u1b05-\u1b33\u1b45-\u1b4c\u1b50-\u1b59" +
		"\u1b83-\u1ba0\u1bae-\u1be5\u1c00-\u1c23\u1c40-\u1c49\u1c4d-\u1c7d\u1c80-\u1c8a\u1c90-\u1cba\u1cbd-\u1cbf\u1ce9-\u1cec\u1cee-\u1cf3\u1cf5-\u1cf6\u1cfa\u1d00-\u1dbf\u1e00-\u1f15\u1f18-\u1f1d\u1f20-\u1f45\u1f48-\u1f4d" +
		"\u1f50-\u1f57\u1f59\u1f5b\u1f5d\u1f5f-\u1f7d\u1f80-\u1fb4\u1fb6-\u1fbc\u1fbe\u1fc2-\u1fc4\u1fc6-\u1fcc\u1fd0-\u1fd3\u1fd6-\u1fdb\u1fe0-\u1fec\u1ff2-\u1ff4\u1ff6-\u1ffc\u2070-\u2071\u2074-\u2079\u207f-\u2089\u2090-\u209c" +
		"\u2102\u2107\u210a-\u2113\u2115\u2119-\u211d\u2124\u2126\u2128\u212a-\u212d\u212f-\u2139\u213c-\u213f\u2145-\u2149\u214e\u2150-\u2189\u2460-\u249b\u24ea-\u24ff\u2776-\u2793\u2c00-\u2ce4\u2ceb-\u2cee\u2cf2-\u2cf3\u2cfd" +
		"\u2d00-\u2d25\u2d27\u2d2d\u2d30-\u2d67\u2d6f\u2d80-\u2d96\u2da0-\u2da6\u2da8-\u2dae\u2db0-\u2db6\u2db8-\u2dbe\u2dc0-\u2dc6\u2dc8-\u2dce\u2dd0-\u2dd6\u2dd8-\u2dde\u2e2f\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303c" +
		"\u3041-\u3096\u309d-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3105-\u312f\u3131-\u318e\u3192-\u3195\u31a0-\u31bf\u31f0-\u31ff\u3220-\u3229\u3248-\u324f\u3251-\u325f\u3280-\u3289\u32b1-\u32bf\u3400-\u4dbf\u4e00-\ua48c" +
		"\ua4d0-\ua4fd\ua500-\ua60c\ua610-\ua62b\ua640-\ua66e\ua67f-\ua69d\ua6a0-\ua6ef\ua717-\ua71f\ua722-\ua788\ua78b-\ua7dc\ua7f1-\ua801\ua803-\ua805\ua807-\ua80a\ua80c-\ua822\ua830-\ua835\ua840-\ua873\ua882-\ua8b3" +
		"\ua8d0-\ua8d9\ua8f2-\ua8f7\ua8fb\ua8fd-\ua8fe\ua900-\ua925\ua930-\ua946\ua960-\ua97c\ua984-\ua9b2\ua9cf-\ua9d9\ua9e0-\ua9e4\ua9e6-\ua9fe\uaa00-\uaa28\uaa40-\uaa42\uaa44-\uaa4b\uaa50-\uaa59\uaa60-\uaa76\uaa7a\uaa7e-\uaaaf" +
		"\uaab1\uaab5-\uaab6\uaab9-\uaabd\uaac0\uaac2\uaadb-\uaadd\uaae0-\uaaea\uaaf2-\uaaf4\uab01-\uab06\uab09-\uab0e\uab11-\uab16\uab20-\uab26\uab28-\uab2e\uab30-\uab5a\uab5c-\uab69\uab70-\uabe2\uabf0-\uabf9\uac00-\ud7a3" +
		"\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufa6d\ufa70-\ufad9\ufb00-\ufb06\ufb13-\ufb17\ufb1d\ufb1f-\ufb28\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40-\ufb41\ufb43-\ufb44\ufb46-\ufbb1\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfb" +
		"\ufe70-\ufe74\ufe76-\ufefc\uff10-\uff19\uff21-\uff3a\uff41-\uff5a\uff66-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc" +
		"]",
);

/** Whether an odd run of backslashes right before `index` escapes the character there. */
export function escapedAt(src: string, index: number): boolean {
	let at = index - 1;
	while (at >= 0 && src.charCodeAt(at) === 0x5c /* \ */) at--;
	return (index - 1 - at) % 2 === 1;
}

export function canOpenDelimiter(src: string, index: number, width: number, marker: string, previous = "\n"): boolean {
	const before = index === 0 ? previous : src[index - 1]!;
	if (index === 0 && before === marker) return false;
	const after = src[index + width];
	if (after === undefined || /\s/.test(after)) return false;
	if (marker === "_" && WORD_CHARACTER.test(before) && WORD_CHARACTER.test(after)) return false;
	return true;
}

export function canCloseDelimiter(src: string, index: number, marker: string): boolean {
	const before = src[index - 1];
	const after = src[index + 1] ?? "\n";
	if (before === undefined || /\s/.test(before)) return false;
	if (marker === "_" && WORD_CHARACTER.test(before) && WORD_CHARACTER.test(after)) return false;
	return !PUNCTUATION.test(before) || /\s/.test(after) || PUNCTUATION.test(after);
}

/** Index of the first element of the ascending `values` at or above `target`. */
function lowerBound(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (values[mid]! < target) low = mid + 1;
		else high = mid;
	}
	return low;
}

/** Closing-delimiter offsets by the depth before each, every list ascending. */
class ClosersByDepth {
	readonly #offsets = new Map<number, number[]>();

	/** Records a closer at `offset`, which lies past every closer recorded before it. */
	add(depth: number, offset: number): void {
		let offsets = this.#offsets.get(depth);
		if (!offsets) this.#offsets.set(depth, (offsets = []));
		offsets.push(offset);
	}

	/** The first closer at `depth` at or after `from`, or -1. */
	first(depth: number, from: number): number {
		const offsets = this.#offsets.get(depth);
		if (!offsets) return -1;
		const at = lowerBound(offsets, from);
		return at === offsets.length ? -1 : offsets[at]!;
	}
}

/**
 * Where a bracket opened in the root source closes. A search starts right after the opening bracket, and a bracket
 * never begins an escape, so the escape pairing from there is the pairing from the start of the root source. The
 * closer is then the first unescaped closing bracket at or after the start whose depth (openers minus closers
 * before it, from the start of the root source) equals the depth at the start.
 */
class BracketDepths {
	// The depth before each offset.
	readonly #depth: Int32Array;
	readonly #closers = new ClosersByDepth();
	// Every unescaped closing bracket, ascending.
	readonly #all: number[] = [];

	constructor(src: string, open: number, close: number) {
		const depth = new Int32Array(src.length + 1);
		let level = 0;
		for (let i = 0; i < src.length; i++) {
			depth[i] = level;
			const code = src.charCodeAt(i);
			if (code === 0x5c /* \ */) {
				depth[++i] = level;
			} else if (code === open) {
				level++;
			} else if (code === close) {
				this.#closers.add(level, i);
				this.#all.push(i);
				level--;
			}
		}
		depth[src.length] = level;
		this.#depth = depth;
	}

	/** The offset of the bracket closing the one just before `start`, or -1. */
	closeAfter(start: number): number {
		return this.#closers.first(this.#depth[start]!, start);
	}

	/** Whether an unescaped closing bracket lies at or after `from`, right after a bracket, and before `to`. */
	closesWithin(from: number, to: number): boolean {
		const at = lowerBound(this.#all, from);
		return at < this.#all.length && this.#all[at]! < to;
	}
}

/**
 * The delimiters the emphasis rule's closer walk visits for one marker and width in the root source, typed the way
 * the walk types them: a delimiter that can close is a closer, else one that can open is an opener. For width 1 they
 * are every unescaped marker. For width 2 they are marker pairs taken two at a time from the start of each run of
 * markers (after it when an odd run of backslashes escapes the start), which is where a walk that reaches the run
 * from before it enters. The closer for an opener is then the first closer after it whose depth (openers minus
 * closers before it) equals the depth where its walk begins, the first point where the walk's nesting count would
 * drop below zero.
 */
class EmphasisDelimiters {
	readonly #src: string;
	readonly #marker: string;
	readonly #width: number;
	// Delimiter offsets, ascending, and the depth before each.
	readonly #at: number[] = [];
	readonly #depth: number[] = [];
	readonly #closers = new ClosersByDepth();

	constructor(src: string, marker: string, width: number) {
		this.#src = src;
		this.#marker = marker;
		this.#width = width;
		let level = 0;
		for (let run = src.indexOf(marker); run !== -1;) {
			let end = run + 1;
			while (src[end] === marker) end++;
			for (let at = escapedAt(src, run) ? run + width : run; at + width <= end; at += width) {
				this.#at.push(at);
				this.#depth.push(level);
				if (canCloseDelimiter(src, at, marker)) {
					this.#closers.add(level, at);
					level--;
				} else if (canOpenDelimiter(src, at, width, marker)) {
					level++;
				}
			}
			run = src.indexOf(marker, end);
		}
	}

	/**
	 * Where the emphasis opened by the delimiter at `opener` closes in a source that ends at `end`, or -1 when the
	 * closer the walk meets first does not lie wholly before `end`. The walk reads nothing before its start. Past
	 * `end` it reads only for the source's last delimiter, which cannot open there and closes as it would at the end
	 * of the source: the sources inline lexing nests end right before a marker or "]", and the closing test reads
	 * either punctuation there like the end.
	 */
	closeFor(opener: number, end: number): number {
		const src = this.#src;
		const marker = this.#marker;
		const width = this.#width;
		const walk = opener + width;
		// A pair right after a width-2 opener has markers on both sides, so the walk takes it as the closer.
		if (width === 2 && src[walk] === marker && src[walk + 1] === marker) return walk + width <= end ? walk : -1;
		const next = lowerBound(this.#at, walk);
		if (next === this.#at.length) return -1;
		const close = this.#closers.first(this.#depth[next]!, this.#at[next]!);
		return close !== -1 && close + width <= end ? close : -1;
	}
}

/**
 * The runs of backticks in the root source, for the code span rule. A span opened by `width` backticks closes at the
 * next run of exactly `width` backticks: a run of any other length is no closer, and the one that closes is the first
 * run of that width at or after the opener. Backslash escapes do not apply inside a code span, so a backslash just
 * before that closing backtick is content and still closes the span.
 */
class CodeRuns {
	// Per run, in order: where it starts and ends; the starts are the binary search `endOf` and `startsStringAt` need.
	readonly #starts: number[] = [];
	readonly #ends: number[] = [];
	// Run starts by width, each list ascending: a closer must have the opener's exact width, so finding one is a
	// binary search in the list for that width and no scan of the runs between.
	readonly #byWidth = new Map<number, number[]>();

	constructor(src: string) {
		for (let at = src.indexOf("`"); at !== -1;) {
			let end = at + 1;
			while (src.charCodeAt(end) === 0x60 /* ` */) end++;
			this.#starts.push(at);
			this.#ends.push(end);
			const width = end - at;
			const starts = this.#byWidth.get(width);
			if (starts === undefined) this.#byWidth.set(width, [at]);
			else starts.push(at);
			at = src.indexOf("`", end);
		}
	}

	/** Where the run of backticks holding the backtick at `at` ends. */
	endOf(at: number): number {
		return this.#ends[lowerBound(this.#starts, at + 1) - 1]!;
	}

	/**
	 * Whether a backtick string starts at `at` for a scan that walked to `at`: a string is a whole run, so it starts at
	 * the run's first backtick and nowhere else. A retry deeper inside a run is not a string, which keeps a run whose
	 * opener found no closer from opening a narrower span one backtick later. A position a tokenizer's raw resumed at,
	 * or the suffix an escape token left behind, is not a walked position — `codeOpenerWidth` admits those on its own,
	 * because it is told the scan resumed there rather than inferring it from the source text.
	 */
	startsStringAt(at: number): boolean {
		const run = lowerBound(this.#starts, at + 1) - 1;
		return this.#starts[run] === at;
	}

	/** Where the closer of a code span opened by `width` backticks that end at `from` starts, or -1. */
	closerAfter(from: number, width: number): number {
		const starts = this.#byWidth.get(width);
		if (starts === undefined) return -1;
		const run = lowerBound(starts, from);
		return run < starts.length ? starts[run]! : -1;
	}
}

/** The closer indexes of one root inline source, each built on first use. */
export class CloserIndexes {
	readonly #src: string;
	#square: BracketDepths | undefined;
	#round: BracketDepths | undefined;
	readonly #emphasis = new Map<string, EmphasisDelimiters>();
	#tagEnds: Int32Array | undefined;
	#commentEnds: number[] | undefined;
	#escapes: number[] | undefined;
	#codeRuns: CodeRuns | undefined;
	// The first " " and the first ">" at or after the offset each was last searched from.
	#space = -1;
	#angle = -1;

	constructor(src: string) {
		this.#src = src;
	}

	get square(): BracketDepths {
		return (this.#square ??= new BracketDepths(this.#src, 0x5b /* [ */, 0x5d /* ] */));
	}

	get round(): BracketDepths {
		return (this.#round ??= new BracketDepths(this.#src, 0x28 /* ( */, 0x29 /* ) */));
	}

	emphasis(marker: string, width: number): EmphasisDelimiters {
		const key = marker.repeat(width);
		let delimiters = this.#emphasis.get(key);
		if (!delimiters) this.#emphasis.set(key, (delimiters = new EmphasisDelimiters(this.#src, marker, width)));
		return delimiters;
	}

	/**
	 * For each offset, where the HTML rule's scan for a tag's end from there stops: the first ">" outside quotes,
	 * where a quote runs to the next quote of its kind, or -1 at the end of the source.
	 */
	get tagEnds(): Int32Array {
		if (this.#tagEnds) return this.#tagEnds;
		const src = this.#src;
		const ends = new Int32Array(src.length + 1);
		ends[src.length] = -1;
		let nextDouble = -1;
		let nextSingle = -1;
		for (let at = src.length - 1; at >= 0; at--) {
			const code = src.charCodeAt(at);
			if (code === 0x3e /* > */) {
				ends[at] = at;
			} else if (code === 0x22 /* " */) {
				ends[at] = nextDouble === -1 ? -1 : ends[nextDouble + 1]!;
				nextDouble = at;
			} else if (code === 0x27 /* ' */) {
				ends[at] = nextSingle === -1 ? -1 : ends[nextSingle + 1]!;
				nextSingle = at;
			} else {
				ends[at] = ends[at + 1]!;
			}
		}
		return (this.#tagEnds = ends);
	}

	/** Every offset where "-->" starts, ascending. */
	get commentEnds(): number[] {
		if (this.#commentEnds) return this.#commentEnds;
		const src = this.#src;
		const ends: number[] = [];
		for (let at = src.indexOf("-->"); at !== -1; at = src.indexOf("-->", at + 1)) ends.push(at);
		return (this.#commentEnds = ends);
	}

	get codeRuns(): CodeRuns {
		return (this.#codeRuns ??= new CodeRuns(this.#src));
	}

	/**
	 * The first " " or ">" at or after `from`, or `Infinity`. Asked at offsets that never decrease, as the lexer's
	 * position does, so each search starts past the last one's answer.
	 */
	spaceOrAngleFrom(from: number): number {
		const src = this.#src;
		if (this.#space < from) {
			const at = src.indexOf(" ", from);
			this.#space = at === -1 ? Infinity : at;
		}
		if (this.#angle < from) {
			const at = src.indexOf(">", from);
			this.#angle = at === -1 ? Infinity : at;
		}
		return Math.min(this.#space, this.#angle);
	}

	/** Every offset of a backslash before ASCII punctuation, ascending: where unescaping drops a backslash. */
	get escapes(): number[] {
		if (this.#escapes) return this.#escapes;
		const src = this.#src;
		const escapes: number[] = [];
		for (let at = src.indexOf("\\"); at !== -1; at = src.indexOf("\\", at + 1)) {
			if (PUNCTUATION.test(src[at + 1] ?? "")) escapes.push(at);
		}
		return (this.#escapes = escapes);
	}
}

/**
 * The link, emphasis, code span, autolink and inline HTML rules' closer lookups for one inline source, which is the
 * root source of `indexes` or a part of it that ends at `end`. Offsets are relative to `rest`, a suffix of the
 * source. A closer the root source places at or past `end` does not exist in the source.
 */
export class InlineClosers {
	readonly #indexes: CloserIndexes;
	/** Where the source ends in the root source. */
	readonly end: number;

	constructor(indexes: CloserIndexes, end: number) {
		this.#indexes = indexes;
		this.end = end;
	}

	/** The closers of a part of `rest` that ends at `end`, lexed as its own source. */
	nested(rest: string, end: number): InlineClosers {
		return new InlineClosers(this.#indexes, this.end - rest.length + end);
	}

	/** Where the "[" just before `start` closes, or -1. */
	closeSquare(rest: string, start: number): number {
		return this.#close(this.#indexes.square, rest, start);
	}

	/** Where the "(" just before `start` closes, or -1. */
	closeRound(rest: string, start: number): number {
		return this.#close(this.#indexes.round, rest, start);
	}

	/** Whether `rest.slice(from, to)`, which starts right after a "[", holds an unescaped "]". */
	squareCloserWithin(rest: string, from: number, to: number): boolean {
		const pos = this.end - rest.length;
		return this.#indexes.square.closesWithin(pos + from, pos + to);
	}

	/** Whether `rest.slice(from, to)` holds a backslash before ASCII punctuation, which unescaping drops. */
	escapeWithin(rest: string, from: number, to: number): boolean {
		const pos = this.end - rest.length;
		const escapes = this.#indexes.escapes;
		const at = lowerBound(escapes, pos + from);
		return at < escapes.length && escapes[at]! + 1 < pos + to;
	}

	/** Where the emphasis opened by the `width` markers at the start of `rest` closes, or -1. */
	closeEmphasis(rest: string, marker: string, width: number): number {
		const pos = this.end - rest.length;
		const close = this.#indexes.emphasis(marker, width).closeFor(pos, this.end);
		return close === -1 ? -1 : close - pos;
	}

	/**
	 * How many backticks start `rest`, which starts with one, or 0 where no code span opens because no backtick string
	 * starts there: the opener is a whole string, so the rest of a run whose opener found no closer is text, while the
	 * backticks left after a backslash escaped the run's first one do open a span. `resumed` says the scan resumed at
	 * `rest` after a tokenizer consumed a raw that ended here, where the backticks are a string wherever they sit.
	 */
	codeOpenerWidth(rest: string, resumed = false): number {
		const pos = this.end - rest.length;
		const runs = this.#indexes.codeRuns;
		if (!resumed && !runs.startsStringAt(pos)) return 0;
		return Math.min(runs.endOf(pos), this.end) - pos;
	}

	/** Where the code span opened by the `width` backticks at the start of `rest` closes, or -1. */
	closeCode(rest: string, width: number): number {
		const pos = this.end - rest.length;
		const close = this.#indexes.codeRuns.closerAfter(pos + width, width);
		return close === -1 || close + width > this.end ? -1 : close - pos;
	}

	/**
	 * Where the URL autolink opened at the start of `rest` ends, its scheme ending at `from`: the first " " or ">"
	 * after the scheme if it is a ">" with text before it, or -1. One past the end of `rest` reads as no ">".
	 */
	closeUrlAutolink(rest: string, from: number): number {
		const pos = this.end - rest.length;
		const close = this.#indexes.spaceOrAngleFrom(pos + from) - pos;
		return close > from && rest.charCodeAt(close) === 0x3e /* > */ ? close : -1;
	}

	/** Where the HTML tag opened by the "<" at the start of `rest` ends: the first ">" after it outside quotes, or -1. */
	closeTag(rest: string): number {
		const pos = this.end - rest.length;
		const close = this.#indexes.tagEnds[pos + 1]!;
		return close === -1 || close >= this.end ? -1 : close - pos;
	}

	/** Where the first "-->" after the "<!--" at the start of `rest` starts, or -1. */
	closeComment(rest: string): number {
		const pos = this.end - rest.length;
		const ends = this.#indexes.commentEnds;
		const at = lowerBound(ends, pos + 4);
		return at === ends.length || ends[at]! + 3 > this.end ? -1 : ends[at]! - pos;
	}

	#close(depths: BracketDepths, rest: string, start: number): number {
		const pos = this.end - rest.length;
		const close = depths.closeAfter(pos + start);
		return close === -1 || close >= this.end ? -1 : close - pos;
	}
}
