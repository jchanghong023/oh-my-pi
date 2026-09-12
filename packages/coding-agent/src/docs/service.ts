import * as path from "node:path";
import { enumerateMarkdownFiles, normalizePlainText, readMarkdownDocument, sectionShape } from "./markdown";
import { BUILDING_INDEX_PREFIX, DocsStorage } from "./storage";
import type {
	DocsBuildResult,
	DocsIndexSummary,
	DocsProgress,
	DocsSearchResult,
	DocsSectionHit,
	MarkdownDocument,
} from "./types";

export interface DocsServiceOptions {
	agentDir: string;
	cwd?: string;
}

export interface DocsBuildOptions {
	signal?: AbortSignal;
	onProgress?: (progress: DocsProgress) => void;
}

function normalizeFts(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[\u3400-\u4dbf\u4e00-\u9fff]/gu, character => ` ${character} `)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Function words a natural-language query can drop without losing meaning.
 * Load-bearing characters (不/无/有/要/能/会/可) are deliberately absent.
 */
const QUERY_FUNCTION_WORDS = new Set([
	...`的 了 是 在 和 与 及 或 之 其 这 那 哪 什 么 怎 样 吗 呢 吧 我 你 他 她 它 们 以 于 请 如 何 把 被 让 给 用 从 到 对 为 就 都 还 而 里 外 个 些`.split(
		" ",
	),
	"怎么",
	"怎样",
	"哪些",
	"哪个",
	"什么",
	"是否",
	"以及",
	"如何",
	"多少",
	"介绍",
	"说明",
]);

/** Query terms kept per search; a long sentence must not blow up the expression. */
const MAX_QUERY_TERMS = 32;

/**
 * Natural-language query → search terms. Identifiers and numbers stay whole;
 * Han runs are cut into adjacent bigrams — a dictionary-free way to span words.
 */
function analyzeQuery(query: string): string[] {
	const terms: string[] = [];
	// `\p{L}` also matches Han, so `mbist问题` arrives as a single part; split each
	// part by script first or the identifier would be cut into `mb`/`bi`/`is`/`st`.
	const runs = /[\u3400-\u4dbf\u4e00-\u9fff]+|[^\u3400-\u4dbf\u4e00-\u9fff]+/gu;
	for (const part of query
		.normalize("NFKC")
		.toLowerCase()
		.match(/[\u3400-\u4dbf\u4e00-\u9fff]+|[\p{L}\p{N}_]+/gu) ?? []) {
		for (const run of part.match(runs) ?? []) {
			if (!/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(run)) {
				terms.push(run);
				continue;
			}
			const characters = [...run];
			if (characters.length === 1) {
				if (!QUERY_FUNCTION_WORDS.has(characters[0])) terms.push(characters[0]);
				continue;
			}
			for (let index = 0; index + 1 < characters.length; index += 1) {
				// Pairs come from the run as written: filtering characters out first
				// would pair characters that never sit together in the corpus
				// (`作用域` → `作域`), which no indexed text can match. Only pairs that
				// are nothing but function words are dropped, as they carry no meaning.
				if (QUERY_FUNCTION_WORDS.has(characters[index]) && QUERY_FUNCTION_WORDS.has(characters[index + 1]))
					continue;
				terms.push(`${characters[index]}${characters[index + 1]}`);
			}
		}
	}
	const unique = [...new Set(terms)];
	if (unique.length <= MAX_QUERY_TERMS) return unique;
	// A long requirement must keep its tail: taking the first N terms would drop
	// everything the sentence says after its opening clause. Steps span the whole
	// list, last index included — stepping by `length / N` never reaches it.
	return Array.from(
		{ length: MAX_QUERY_TERMS },
		(_, index) => unique[Math.floor((index * (unique.length - 1)) / (MAX_QUERY_TERMS - 1))],
	);
}

/**
 * Terms → one FTS5 union expression. Chinese is indexed per character, so a
 * multi-character term becomes an adjacency phrase. Terms come from
 * `analyzeQuery`, so they only ever hold query-safe characters.
 */
function compileFtsQuery(terms: readonly string[]): string {
	return (
		terms
			// Chinese is indexed per character, so only those terms become phrases.
			.map(
				term =>
					`"${(/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(term) ? [...term].join(" ") : term).replace(/"/g, '""')}"`,
			)
			.join(" OR ")
	);
}

function normalizeSearchText(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function literalPattern(text: string): RegExp {
	// Han terms may occur inside longer Chinese text. Technical names must not
	// match identifier/version continuations, but may touch surrounding Chinese.
	const start = /^\p{Script=Han}/u.test(text) ? "" : "(?:(?<=\\p{Script=Han})|(?<![\\p{L}\\p{N}_+#-]))";
	const end = /\p{Script=Han}$/u.test(text) ? "" : "(?:(?=\\p{Script=Han})|(?![\\p{L}\\p{N}_+#-]|\\.[\\p{L}\\p{N}_]))";
	return new RegExp(`${start}${RegExp.escape(text)}${end}`, "u");
}

/**
 * Hard ceiling on one page. Callers size pages by returned characters, but the
 * ranked list still needs an upper bound: corpora converted from slides and
 * spreadsheets hold hundreds of thousands of tiny sections.
 */
const MAX_PAGE_SECTIONS = 500;

/** Candidate rows reranked per query. Reordering only ever promotes hits inside
 * this window, so it stays small: the caller's page is filled from the top. */
const CANDIDATE_WINDOW_MAX = 1_000;

/**
 * Ceiling for that window when a query matches nothing but stubs: widening is the
 * only way to reach the readable hits sitting below them, so the retry may read
 * more rows. It stays bounded because such a query is answered from its first hit.
 */
const CANDIDATE_LIMIT_MAX = 10_000;

/**
 * Markdown characters fetched per candidate for scoring. Sections cap at 24k
 * characters, and pulling every candidate's full text dominated query time on
 * large corpora; the page's real text is loaded afterwards, by id.
 */
const CANDIDATE_SNIPPET_CHARS = 2_000;

/**
 * Candidate windows to try, widest last: the page is cut from the top of the
 * window, so a window that holds no readable hit is retried larger, up to the
 * ceiling. The last value is the ceiling itself — multiplying past it would
 * leave the widest window never read.
 */
function* candidateWindows(first: number): Generator<number> {
	let limit = Math.min(first, CANDIDATE_LIMIT_MAX);
	while (true) {
		yield limit;
		if (limit === CANDIDATE_LIMIT_MAX) return;
		limit = Math.min(limit * 4, CANDIDATE_LIMIT_MAX);
	}
}

/** One scored candidate row within a window. */
interface RankedRow {
	row: Record<string, unknown>;
	literalCount: number;
	stub: boolean;
	titlePhrase: boolean;
	phrase: boolean;
}

function validateName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Document index name must not be empty");
	if ([...trimmed].length > 64) throw new Error("Document index name must contain at most 64 Unicode scalar values");
	if (/\p{Cc}/u.test(trimmed)) throw new Error("Document index name must not contain control characters");
	if (trimmed.startsWith(BUILDING_INDEX_PREFIX))
		throw new Error(`Document index name uses reserved prefix: ${BUILDING_INDEX_PREFIX}`);
	return trimmed;
}

function checkCancelled(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("Document indexing cancelled");
	error.name = "AbortError";
	throw error;
}

function indexFilter(index: string | undefined): { sql: string; args: string[] } {
	// GLOB keeps `_` literal, so ordinary names containing the prefix stay visible.
	const visible = ` AND i.name NOT GLOB '${BUILDING_INDEX_PREFIX}*'`;
	return index ? { sql: `${visible} AND i.name=?`, args: [index] } : { sql: visible, args: [] };
}

export class DocsService {
	readonly storage: DocsStorage;
	readonly cwd: string;

	constructor(options: DocsServiceOptions) {
		this.storage = DocsStorage.open(options.agentDir);
		this.cwd = path.resolve(options.cwd ?? process.cwd());
	}

	close(): void {
		this.storage.close();
	}

	list(): DocsIndexSummary[] {
		return this.storage.list();
	}

	async init(directory: string, name: string, options: DocsBuildOptions = {}): Promise<DocsBuildResult> {
		checkCancelled(options.signal);
		const storedName = validateName(name);
		if (this.storage.get(storedName)) throw new Error(`Document index already exists: ${storedName}`);
		const rootPath = path.resolve(this.cwd, directory);
		const files = await enumerateMarkdownFiles(rootPath);
		checkCancelled(options.signal);
		if (files.length === 0) throw new Error(`No Markdown files found in: ${rootPath}`);
		// A killed import leaves a half-built index behind; clear those out now that
		// this process is the one building.
		this.storage.removeAbandoned();
		const temp = this.storage.create({ name: `${BUILDING_INDEX_PREFIX}${crypto.randomUUID()}`, rootPath });
		try {
			options.onProgress?.({ phase: "scan", total: files.length, completed: 0, failed: 0 });
			let completed = 0;
			for (const relativePath of files) {
				checkCancelled(options.signal);
				const document = await readMarkdownDocument(rootPath, relativePath);
				checkCancelled(options.signal);
				this.#commitDocument(temp.id, document);
				completed++;
				options.onProgress?.({
					phase: "fts",
					total: files.length,
					completed,
					failed: 0,
					currentPath: relativePath,
				});
			}
			checkCancelled(options.signal);
			return { processed: completed, failed: 0, index: this.storage.promote(temp.id, storedName) };
		} catch (error) {
			this.storage.removeById(temp.id);
			throw error;
		}
	}

	remove(name: string): void {
		if (!this.storage.remove(name)) throw new Error(`Unknown document index: ${name}`);
	}

	#commitDocument(indexId: number, document: MarkdownDocument): void {
		this.storage.transaction(() => {
			const inserted = this.storage.db
				.query(
					"INSERT INTO documents(index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms) VALUES(?,?,?,?,?,?,?) RETURNING id",
				)
				.get(
					indexId,
					document.relativePath,
					document.title,
					document.sourceKind,
					document.sha256,
					document.sizeBytes,
					document.mtimeMs,
				) as { id: number };
			for (const section of document.sections) {
				const sectionRow = this.storage.db
					.query(
						"INSERT INTO sections(index_id,document_id,ordinal,heading_path,heading_level,line_start,line_end,byte_start,byte_end,raw_markdown) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id",
					)
					.get(
						indexId,
						inserted.id,
						section.ordinal,
						section.headingPath.join(" > "),
						section.headingLevel,
						section.lineStart,
						section.lineEnd,
						section.byteStart,
						section.byteEnd,
						section.rawMarkdown,
					) as { id: number };
				this.storage.db
					.query(
						"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) VALUES(?,?,?,?,?,?)",
					)
					.run(
						sectionRow.id,
						sectionRow.id,
						indexId,
						section.ordinal === 0 ? normalizeFts(document.relativePath) : "",
						normalizeFts(section.headingPath.join(" > ")),
						normalizeFts(section.plainText),
					);
			}
		});
	}

	search(query: string, options: { index?: string; limit?: number } = {}): DocsSearchResult {
		const filter = indexFilter(options.index);
		const limit = Math.max(1, Math.min(MAX_PAGE_SECTIONS, options.limit ?? 10));
		const terms = analyzeQuery(query);
		if (terms.length === 0) return { sections: [], total: 0 };
		const match = compileFtsQuery(terms);
		const sections = this.#rank(match, query, terms, filter, limit);
		// Only the unscoped caller asks for a count, and it must cover what the page
		// itself may serve.
		const total = options.index === undefined ? this.#countMatches(match) : undefined;
		return { sections, total };
	}

	/**
	 * Matching sections across the corpus, hidden indexes excluded. Reading nothing
	 * but `sections_fts` is the only cheap form (~200x faster than the join measured
	 * on a 386k-section corpus), so the join is paid only while a half-built index
	 * is present — otherwise its rows would promise hits the page never serves.
	 */
	#countMatches(match: string): number {
		const hidden = `${BUILDING_INDEX_PREFIX}*`;
		const building = this.storage.db.query("SELECT 1 FROM doc_indexes WHERE name GLOB ? LIMIT 1").get(hidden);
		const row = (
			building
				? this.storage.db
						.query(`SELECT count(*) n FROM sections_fts f JOIN sections s ON s.id=f.rowid
						 JOIN doc_indexes i ON i.id=s.index_id WHERE sections_fts MATCH ? AND i.name NOT GLOB ?`)
						.get(match, hidden)
				: this.storage.db.query("SELECT count(*) n FROM sections_fts WHERE sections_fts MATCH ?").get(match)
		) as { n: number } | null;
		return row?.n ?? 0;
	}

	/** Ranked page for one compiled FTS expression. */
	#rank(
		match: string,
		query: string,
		terms: readonly string[],
		filter: { sql: string; args: string[] },
		limit: number,
	): DocsSectionHit[] {
		const patterns = terms.map(literalPattern);
		const phrase = literalPattern(normalizeSearchText(query).replace(/^[`"']+|[`"']+$/gu, ""));
		// Stubs are indexed on purpose — a document's first section carries the
		// relative path — so they must not hold page slots meant for readable text.
		// The window is cut from the top, so a query that matches nothing but
		// structural labels (`#### Cell`, hundreds of thousands of them in a legacy
		// index) widens it until readable hits appear or the corpus runs out.
		let page = this.#fill([], patterns, phrase, limit);
		for (const candidateLimit of candidateWindows(Math.min(CANDIDATE_WINDOW_MAX, limit * 3 + 50))) {
			const candidates = this.#candidates(match, filter, candidateLimit);
			page = this.#fill(candidates, patterns, phrase, limit);
			if (page.readable >= limit || candidates.length < candidateLimit) break;
		}
		return this.#hits(page.entries);
	}

	/** Candidate rows for one compiled FTS expression, best BM25 first. */
	#candidates(
		match: string,
		filter: { sql: string; args: string[] },
		candidateLimit: number,
	): Array<Record<string, unknown>> {
		return this.storage.db
			.query(`SELECT f.rowid section_id,i.name index_name,d.relative_path,s.heading_path,s.line_start,s.line_end,
			 substr(s.raw_markdown,1,${CANDIDATE_SNIPPET_CHARS}) snippet, bm25(sections_fts,0.0,0.0,0.5,2.0,1.0) rank
			 FROM sections_fts f JOIN sections s ON s.id=f.rowid JOIN documents d ON d.id=s.document_id JOIN doc_indexes i ON i.id=s.index_id
			 WHERE sections_fts MATCH ?${filter.sql} ORDER BY rank,s.id LIMIT ?`)
			.all(match, ...filter.args, candidateLimit) as Array<Record<string, unknown>>;
	}

	/** One candidate window, ranked, split into readable hits and stub padding. */
	#fill(
		candidates: Array<Record<string, unknown>>,
		patterns: readonly RegExp[],
		phrase: RegExp,
		limit: number,
	): { entries: RankedRow[]; readable: number } {
		const ranked: RankedRow[] = candidates.map(row => {
			const raw = normalizeSearchText(row.snippet as string);
			const plain = normalizeSearchText(normalizePlainText(row.snippet as string));
			const heading = normalizeSearchText(normalizePlainText(row.heading_path as string));
			const path = normalizeSearchText(row.relative_path as string);
			const separator = heading.lastIndexOf(" > ");
			const title = separator < 0 ? heading : heading.slice(separator + 3);
			let literalCount = 0;
			for (const term of patterns) {
				if (term.test(raw) || term.test(plain) || term.test(heading) || term.test(path)) literalCount++;
			}
			return {
				row,
				literalCount,
				// Judged on the snippet, which is all this window loads; the stored
				// section is the final word (that text is what the caller renders).
				stub: sectionShape(`${row.snippet as string}\n`) === "stub",
				titlePhrase: phrase.test(title),
				phrase: phrase.test(raw) || phrase.test(plain) || phrase.test(heading) || phrase.test(path),
			};
		});
		// Ranking tiers, most precise first: the query's own spelling in the heading,
		// then in the body (`std::vector` beats a scattered `vector std`), then
		// sections carrying every analyzed term. BM25 closes each tier — it is the
		// IDF- and length-normalized relevance score, so raw term counts must never
		// outrank it (long boilerplate sections collect them).
		ranked.sort(
			(a, b) =>
				Number(b.titlePhrase) - Number(a.titlePhrase) ||
				Number(b.phrase) - Number(a.phrase) ||
				Number(b.literalCount === patterns.length) - Number(a.literalCount === patterns.length) ||
				(a.row.rank as number) - (b.row.rank as number) ||
				(a.row.section_id as number) - (b.row.section_id as number),
		);
		// Stubs go after every readable hit, keeping their own relative order so the
		// readable page is identical whether or not the padding was needed.
		const readable = ranked.filter(entry => !entry.stub);
		const entries = [...readable, ...ranked.filter(entry => entry.stub)].slice(0, limit);
		return { entries, readable: Math.min(readable.length, limit) };
	}

	/** Page rows as hits, with the stored Markdown loaded by id. */
	#hits(page: RankedRow[]): DocsSectionHit[] {
		const texts = this.#pageTexts(page.map(({ row }) => row.section_id as number));
		return page.map(({ row }) => ({
			sectionId: row.section_id as number,
			index: row.index_name as string,
			path: row.relative_path as string,
			headingPath: row.heading_path as string,
			lineStart: row.line_start as number,
			lineEnd: row.line_end as number,
			text: texts.get(row.section_id as number) ?? (row.snippet as string),
			rank: row.rank as number,
		}));
	}

	/** Full Markdown for the sections on one page, keyed by section id. */
	#pageTexts(ids: readonly number[]): Map<number, string> {
		const texts = new Map<number, string>();
		if (ids.length === 0) return texts;
		const rows = this.storage.db
			.query(`SELECT id,raw_markdown FROM sections WHERE id IN (${ids.map(() => "?").join(",")})`)
			.all(...ids) as Array<{ id: number; raw_markdown: string }>;
		for (const row of rows) texts.set(row.id, row.raw_markdown);
		return texts;
	}

	read(options: { sectionId: number; index?: string }): {
		sectionId: number;
		index: string;
		path: string;
		headingPath: string;
		lineStart: number;
		lineEnd: number;
		rawMarkdown: string;
	} {
		const filter = indexFilter(options.index);
		const row = this.storage.db
			.query(
				`SELECT s.id,i.name index_name,d.relative_path,s.heading_path,s.line_start,s.line_end,s.raw_markdown
			 FROM sections s JOIN documents d ON d.id=s.document_id JOIN doc_indexes i ON i.id=s.index_id
			 WHERE s.id=?${filter.sql}`,
			)
			.get(options.sectionId, ...filter.args) as Record<string, unknown> | null;
		if (!row) throw new Error(`Unknown section: ${options.sectionId}`);
		return {
			sectionId: row.id as number,
			index: row.index_name as string,
			path: row.relative_path as string,
			headingPath: row.heading_path as string,
			lineStart: row.line_start as number,
			lineEnd: row.line_end as number,
			rawMarkdown: row.raw_markdown as string,
		};
	}
}
