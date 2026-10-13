import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { acquireFileLock, type FileLockHandle } from "@oh-my-pi/pi-utils/file-lock";
import { Lexer, type Token, type Tokens } from "@oh-my-pi/pi-utils/marked";
import {
	enumerateMarkdownFiles,
	markdownSectionContexts,
	normalizePlainText,
	readMarkdownDocument,
	sectionShape,
} from "./markdown";
import { BUILDING_INDEX_PREFIX, DocsStorage, normalizeFts } from "./storage";
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
			// The table also lists multi-character function words (`是否`, `介绍`).
			// Looking up single characters can never see those entries, so a run that
			// spells one out whole is dropped before the bigram cut.
			if (QUERY_FUNCTION_WORDS.has(run)) continue;
			for (let index = 0; index + 1 < characters.length; index += 1) {
				// Pairs come from the run as written: filtering characters out first
				// would pair characters that never sit together in the corpus
				// (`作用域` → `作域`), which no indexed text can match. A pair is
				// dropped when the table lists it (`是否`) or when both of its
				// characters are function words (`和与`): either way it carries no
				// meaning.
				const pair = `${characters[index]}${characters[index + 1]}`;
				if (QUERY_FUNCTION_WORDS.has(pair)) continue;
				if (QUERY_FUNCTION_WORDS.has(characters[index]) && QUERY_FUNCTION_WORDS.has(characters[index + 1]))
					continue;
				terms.push(pair);
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

function literalPattern(text: string, pathBasename = false): RegExp {
	// Names can touch Chinese prose, but not a larger identifier, namespace,
	// extension or version. A basename may follow a path separator; a query
	// naming an entire path must still start at that path's boundary.
	const prefix = pathBasename ? "[\\p{L}\\p{N}_+#.:-]" : "[\\p{L}\\p{N}_+#/\\\\.:-]";
	const start = /^\p{Script=Han}/u.test(text) ? "" : `(?:(?<=\\p{Script=Han})|(?<!${prefix}))`;
	const end = /\p{Script=Han}$/u.test(text)
		? ""
		: "(?:(?=\\p{Script=Han})|(?![\\p{L}\\p{N}_+#/\\\\-]|[.:][\\p{L}\\p{N}_:]))";
	return new RegExp(`${start}${RegExp.escape(text)}${end}`, "u");
}

const MAX_PAGE_SECTIONS = 500;

/** Only function words are scaffolding; nouns like log can define the topic. */
const QUERY_GENERIC_TERMS: Record<string, true> = Object.fromEntries(
	"the a an and or for of to in on is are what which how does do can should"
		.split(" ")
		.map(term => [term, true] as const),
);

/** Render names without joining identifiers across literal-code boundaries. */
function normalizeNameText(markdown: string, fencePrefix?: string, continuesLine = false): string {
	const render = (tokens: readonly Token[]): string =>
		tokens
			.map(token => {
				if (token.type === "table") {
					const table = token as Tokens.Table;
					return [table.header, ...table.rows]
						.map(row => row.map(cell => render(cell.tokens)).join(" "))
						.join("\n");
				}
				if (token.type === "list") return (token as Tokens.List).items.map(item => render(item.tokens)).join("\n");
				if (token.type === "space" || token.type === "hr" || token.type === "br") return "\n";
				if (token.type === "def") return "";
				const text =
					"tokens" in token && Array.isArray(token.tokens)
						? render(token.tokens)
						: "text" in token && typeof token.text === "string"
							? token.text
							: "";
				return /^(?:heading|paragraph|blockquote|code|codespan)$/.test(token.type) ? `\n${text}\n` : text;
			})
			.join("");
	let source = markdown.replace(/^\uFEFF/u, "");
	if (continuesLine) source = `    ${source}`;
	return normalizeSearchText(render(Lexer.lex(fencePrefix ? `${fencePrefix}\n${source}` : source)));
}

function technicalQueryName(query: string): string | undefined {
	// A whole identifier can name a command without punctuation. Multiword
	// plain text stays prose: command phrases and ordinary topics are ambiguous.
	const spelling = query.normalize("NFKC").trim();
	if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(spelling) && !/\p{Script=Han}/u.test(spelling)) return spelling;
	// Prose punctuation is not part of a name. A standalone spelling (including
	// a quoted literal) keeps its punctuation; dots inside names always survive.
	const literal = /^(?:`([^`]+)`|"([^"]+)"|'([^']+)')$/u.exec(spelling);
	const standalone = literal?.slice(1).find(value => value !== undefined) ?? spelling;
	const tokens = (spelling.match(/[^\s\u3400-\u4dbf\u4e00-\u9fff`"'(),;!?。！？]+/gu) ?? []).map(token =>
		token === standalone ? token : token.replace(/[.:]+$/u, ""),
	);
	return tokens.find(
		token =>
			/[\p{L}\p{N}]/u.test(token) &&
			(/[_+#/\\]|::|^[.-]{1,2}\p{L}|[\p{L}\p{N}][.-][\p{L}\p{N}]/u.test(token) ||
				/^[a-z]+\d[\p{L}\p{N}]*$/iu.test(token)),
	);
}

interface SectionContext {
	shape: DocsSectionHit["shape"];
	fencePrefix?: string;
	continuesLine: boolean;
	before: string;
	after: string;
}

/** Adjacent stored characters constrain matches, but never supply their body. */
function matchesSectionName(name: RegExp, text: string, markdown: string, context: SectionContext): boolean {
	// Rendering trims block whitespace. Keep actual source whitespace at the
	// edges so it still separates names from characters in neighboring chunks.
	const before = /^\s/u.test(markdown) ? " " : context.before.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ");
	const after = /\s$/u.test(markdown) ? " " : context.after.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ");
	const contextual = `${before}${text}${after}`;
	const end = before.length + text.length;
	name.lastIndex = 0;
	for (let match = name.exec(contextual); match; match = name.exec(contextual)) {
		if (match.index >= before.length && match.index + match[0].length <= end) return true;
	}
	return false;
}

interface RankedRow {
	row: Record<string, unknown>;
	shape: DocsSectionHit["shape"];
	matchKind: DocsSectionHit["matchKind"];
	titlePhrase: boolean;
	phrase: boolean;
	topicTitle: number;
	topicBody: number;
	relevance: number;
	bodyHash?: string;
}

interface SearchCursor {
	v: 1;
	q: string;
	s: string;
	p: number;
}

function digest(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function decodeCursor(value: string): SearchCursor {
	try {
		if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
		const decoded = Buffer.from(value, "base64url");
		if (decoded.toString("base64url") !== value) throw new Error();
		const cursor = JSON.parse(decoded.toString("utf8")) as SearchCursor;
		if (
			cursor.v !== 1 ||
			!/^[a-f0-9]{64}$/.test(cursor.q) ||
			!/^[a-f0-9]{64}$/.test(cursor.s) ||
			!Number.isSafeInteger(cursor.p) ||
			cursor.p < 1 ||
			Object.keys(cursor).sort().join(",") !== "p,q,s,v"
		)
			throw new Error();
		return cursor;
	} catch {
		throw new Error("Invalid documentation search cursor");
	}
}

function scoreCandidate(
	row: Record<string, unknown>,
	patterns: readonly RegExp[],
	weights: readonly number[],
	topics: readonly boolean[],
	phrase: RegExp,
	loadContext: (row: Record<string, unknown>) => SectionContext,
): RankedRow {
	const text = row.raw_markdown as string;
	const raw = row.search_raw as string;
	const plain = row.search_plain as string;
	// Only a heading actually present in this section is a local title. Parent
	// heading paths and filenames remain recall metadata, not topical evidence.
	const context = loadContext(row);
	const lines = text.replace(/^\uFEFF/u, "").split("\n", 2);
	const localHeading =
		context.fencePrefix || context.continuesLine
			? ""
			: (/^ {0,3}#{1,6}\s+(.+)/u.exec(lines[0])?.[1] ??
				(/^ {0,3}\S/u.test(lines[0]) && /^ {0,3}(?:=+|-+)\s*$/u.test(lines[1] ?? "") ? lines[0] : ""));
	const title = normalizeSearchText(normalizePlainText(localHeading));
	let relevance = 0;
	let topicTitle = 0;
	let topicBody = 0;
	for (let index = 0; index < patterns.length; index++) {
		const inTitle = patterns[index].test(title);
		const inBody = patterns[index].test(raw) || patterns[index].test(plain);
		if (inBody) relevance += weights[index];
		if (inTitle) relevance += weights[index] * 3;
		if (topics[index]) {
			if (inBody) topicBody++;
			if (inTitle) topicTitle++;
		}
	}
	const shape = sectionShape(text);
	return {
		row,
		shape: shape === "content" ? shape : context.shape,
		matchKind: row.search_exact ? "exact-name" : "related",
		titlePhrase: phrase.test(title),
		phrase: phrase.test(raw) || phrase.test(plain),
		topicTitle,
		topicBody,
		relevance,
		bodyHash: text.length > 200 ? digest(text) : undefined,
	};
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

/**
 * Bounded wait for the shared import lock. The holder keeps it for a whole
 * import, so a second import should report the conflict instead of queueing
 * behind minutes of indexing.
 */
const IMPORT_LOCK_OPTIONS = { retries: 3, retryDelayMs: 100 } as const;

export class DocsService {
	readonly storage: DocsStorage;
	readonly cwd: string;

	constructor(options: DocsServiceOptions) {
		const started = performance.now();
		this.storage = logger.withLogContext(
			{ operation_id: logger.getLogContext().operation_id ?? `docs-open-${crypto.randomUUID()}` },
			() => {
				logger.info("docs.database.started", {
					component: "docs",
					event: "docs.database",
					stage: "open",
					result: "started",
				});
				try {
					const storage = DocsStorage.open(options.agentDir);
					logger.info("docs.database.completed", {
						component: "docs",
						event: "docs.database",
						stage: "open",
						result: "completed",
						elapsed_ms: performance.now() - started,
					});
					return storage;
				} catch (error) {
					logger.error("docs.database.failed", {
						component: "docs",
						event: "docs.database",
						stage: "open",
						result: "failed",
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					});
					throw error;
				}
			},
		);
		this.cwd = path.resolve(options.cwd ?? process.cwd());
	}

	close(): void {
		this.storage.close();
	}

	list(): DocsIndexSummary[] {
		const context = logger.getLogContext();
		return logger.withLogContext(
			{
				operation_id: context.operation_id ?? `docs-list-${crypto.randomUUID()}`,
				parent_call_id: context.call_id,
				call_id: `docs-list-${crypto.randomUUID()}`,
			},
			() => {
				const started = performance.now();
				const fields = { component: "docs", event: "docs.list", stage: "query" };
				logger.info("docs.list.started", {
					...fields,
					result: "started",
					elapsed_ms: performance.now() - started,
				});
				try {
					const indexes = this.storage.list();
					logger.info("docs.list.completed", {
						...fields,
						result: "completed",
						index_count: indexes.length,
						elapsed_ms: performance.now() - started,
					});
					return indexes;
				} catch (error) {
					logger.error("docs.list.failed", {
						...fields,
						result: "failed",
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					});
					throw error;
				}
			},
		);
	}

	async init(directory: string, name: string, options: DocsBuildOptions = {}): Promise<DocsBuildResult> {
		return logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `docs-init-${crypto.randomUUID()}`,
				index_hash:
					typeof name === "string" ? new Bun.CryptoHasher("sha256").update(name).digest("hex") : undefined,
			},
			async () => {
				const started = performance.now();
				let stage = "validate";
				let documentCount = 0;
				let sectionCount = 0;
				let fileCount = 0;
				let cleanup = "not_needed";
				let expectedResult: string | undefined;
				let published = false;
				const fields = () => ({
					component: "docs",
					event: "docs.init",
					stage,
					elapsed_ms: performance.now() - started,
					file_count: fileCount,
					document_count: documentCount,
					section_count: sectionCount,
				});
				logger.info("docs.init.started", { ...fields(), result: "started" });
				try {
					checkCancelled(options.signal);
					stage = "name_validation";
					const storedName = validateName(name);
					stage = "validate";
					if (this.storage.get(storedName)) {
						expectedResult = "duplicate_name";
						throw new Error(`Document index already exists: ${storedName}`);
					}
					const rootPath = path.resolve(this.cwd, directory);
					stage = "scan";
					const scanStarted = performance.now();
					logger.info("docs.init.scan.started", { ...fields(), result: "started" });
					const files = await enumerateMarkdownFiles(rootPath);
					fileCount = files.length;
					logger.info("docs.init.scan.completed", {
						...fields(),
						result: "completed",
						elapsed_ms: performance.now() - scanStarted,
					});
					checkCancelled(options.signal);
					if (files.length === 0) {
						expectedResult = "no_documents";
						throw new Error(`No Markdown files found in: ${rootPath}`);
					}
					// Enumeration runs before the lock: only the database writes need to be
					// exclusive, and the lease is held for the whole build.
					stage = "lock";
					const lockStarted = performance.now();
					logger.info("docs.init.lock.started", {
						...fields(),
						result: "started",
						retry_limit: IMPORT_LOCK_OPTIONS.retries,
					});
					let lease: FileLockHandle;
					try {
						lease = await acquireFileLock(this.storage.path, { ...IMPORT_LOCK_OPTIONS, signal: options.signal });
						logger.info("docs.init.lock.completed", {
							...fields(),
							result: "completed",
							elapsed_ms: performance.now() - lockStarted,
						});
					} catch (error) {
						const log = options.signal?.aborted ? logger.info : logger.warn;
						log("docs.init.lock.failed", {
							...fields(),
							result: options.signal?.aborted ? "cancelled" : "contended",
							elapsed_ms: performance.now() - lockStarted,
							...logger.diagnosticError(error),
						});
						checkCancelled(options.signal);
						throw new Error(
							`Another document index build is already running for this profile: ${this.storage.path}`,
							{ cause: error },
						);
					}
					try {
						checkCancelled(options.signal);
						stage = "validate";
						// Another import may have published this name while we waited for the lease.
						if (this.storage.get(storedName)) {
							expectedResult = "duplicate_name";
							throw new Error(`Document index already exists: ${storedName}`);
						}
						// A killed import leaves a half-built index behind; clear those out now that
						// this process is the one building.
						stage = "recovery";
						this.storage.removeAbandoned();
						stage = "create";
						const temp = this.storage.create({
							name: `${BUILDING_INDEX_PREFIX}${crypto.randomUUID()}`,
							rootPath,
						});
						try {
							options.onProgress?.({ phase: "scan", total: files.length, completed: 0, failed: 0 });
							stage = "read_parse";
							logger.info("docs.init.ingest.started", { ...fields(), result: "started" });
							let readParseMs = 0;
							let ftsMs = 0;
							let completed = 0;
							for (const relativePath of files) {
								checkCancelled(options.signal);
								stage = "read_parse";
								const readStarted = performance.now();
								// The reader parses internally; no per-document text or path is logged.
								let document: MarkdownDocument;
								try {
									document = await readMarkdownDocument(rootPath, relativePath);
								} catch (error) {
									// The reader wraps parse failures with this stable prefix; never log its text.
									stage =
										error instanceof Error && error.message.startsWith("Unable to parse Markdown ")
											? "parse"
											: "read";
									throw error;
								}
								readParseMs += performance.now() - readStarted;
								checkCancelled(options.signal);
								stage = "fts";
								if (completed === 0) logger.info("docs.init.fts.started", { ...fields(), result: "started" });
								const ftsStarted = performance.now();
								this.#commitDocument(temp.id, document);
								ftsMs += performance.now() - ftsStarted;
								completed++;
								documentCount = completed;
								sectionCount += document.sections.length;
								options.onProgress?.({
									phase: "fts",
									total: files.length,
									completed,
									failed: 0,
									currentPath: relativePath,
								});
							}
							logger.info("docs.init.read_parse.completed", {
								...fields(),
								stage: "read_parse",
								result: "completed",
								elapsed_ms: readParseMs,
							});
							logger.info("docs.init.parse.completed", { ...fields(), stage: "parse", result: "completed" });
							logger.info("docs.init.fts.completed", {
								...fields(),
								stage: "fts",
								result: "completed",
								elapsed_ms: ftsMs,
							});
							checkCancelled(options.signal);
							stage = "publish";
							const result = {
								processed: completed,
								failed: 0,
								index: this.storage.promote(temp.id, storedName),
							};
							published = true;
							return result;
						} catch (error) {
							const failedStage = stage;
							const cancelled = error instanceof Error && error.name === "AbortError";
							const log = cancelled ? logger.info : logger.error;
							log("docs.init.ingest.finished", {
								...fields(),
								result: cancelled ? "cancelled" : "failed",
								...logger.diagnosticError(error),
							});
							cleanup = "started";
							logger.info("docs.init.rollback.started", {
								...fields(),
								stage: "rollback",
								result: "started",
								failed_stage: failedStage,
							});
							try {
								this.storage.removeById(temp.id);
								cleanup = "completed";
								logger.info("docs.init.rollback.completed", {
									...fields(),
									stage: "rollback",
									result: "completed",
									failed_stage: failedStage,
								});
							} catch (cleanupError) {
								cleanup = "failed";
								stage = "rollback";
								logger.error("docs.init.rollback.failed", {
									...fields(),
									result: "failed",
									failed_stage: failedStage,
									...logger.diagnosticError(cleanupError),
								});
								throw cleanupError;
							}
							throw error;
						}
					} finally {
						logger.info("docs.init.lock.release.started", {
							...fields(),
							stage: "lock_release",
							result: "started",
						});
						const operationStage = stage;
						stage = "lock_release";
						lease.release();
						stage = operationStage;
						logger.info("docs.init.lock.release.completed", {
							...fields(),
							stage: "lock_release",
							result: "completed",
						});
						if (published) logger.info("docs.init.completed", { ...fields(), result: "completed", cleanup });
					}
				} catch (error) {
					const cancelled = error instanceof Error && error.name === "AbortError";
					if (
						stage === "scan" &&
						error instanceof Error &&
						error.message.startsWith("Markdown root is not a directory: ")
					) {
						expectedResult = "source_not_directory";
					}
					const log =
						cancelled || expectedResult || stage === "name_validation"
							? logger.info
							: stage === "lock"
								? logger.warn
								: logger.error;
					log("docs.init.finished", {
						...fields(),
						result: cancelled
							? "cancelled"
							: expectedResult || stage === "name_validation"
								? "rejected"
								: "failed",
						reason: expectedResult,
						cleanup,
						...logger.diagnosticError(error),
					});
					throw error;
				}
			},
		);
	}

	remove(name: string): void {
		logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `docs-remove-${crypto.randomUUID()}`,
				index_hash:
					typeof name === "string" ? new Bun.CryptoHasher("sha256").update(name).digest("hex") : undefined,
			},
			() => {
				const started = performance.now();
				let notFound = false;
				const fields = { component: "docs", event: "docs.remove", stage: "delete" };
				logger.info("docs.remove.started", { ...fields, result: "started" });
				try {
					// Only visible rows move here; a hidden build belongs to the import lease.
					if (!this.storage.remove(name)) {
						notFound = true;
						logger.info("docs.remove.rejected", {
							...fields,
							result: "not_found",
							elapsed_ms: performance.now() - started,
						});
						throw new Error(`Unknown document index: ${name}`);
					}
					logger.info("docs.remove.completed", {
						...fields,
						result: "completed",
						elapsed_ms: performance.now() - started,
					});
				} catch (error) {
					if (!notFound)
						logger.error("docs.remove.failed", {
							...fields,
							result: "failed",
							elapsed_ms: performance.now() - started,
							...logger.diagnosticError(error),
						});
					throw error;
				}
			},
		);
	}

	#commitDocument(indexId: number, document: MarkdownDocument): void {
		const started = performance.now();
		let stage = "document_insert";
		try {
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
					stage = "section_insert";
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
					stage = "fts_insert";
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
		} catch (error) {
			logger.error("docs.init.document.failed", {
				component: "docs",
				event: "docs.init.document",
				stage,
				result: "failed",
				elapsed_ms: performance.now() - started,
				section_count: document.sections.length,
				...logger.diagnosticError(error),
			});
			throw error;
		}
	}

	search(
		query: string,
		options: {
			index?: string;
			limit?: number;
			cursor?: string;
			characterBudget?: number;
			sectionCost?: (section: DocsSectionHit, position: number) => number;
		} = {},
	): DocsSearchResult {
		return logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `docs-search-${crypto.randomUUID()}`,
				...(options.index === undefined
					? {}
					: { index_hash: new Bun.CryptoHasher("sha256").update(options.index).digest("hex") }),
			},
			() => {
				const started = performance.now();
				const fields = { component: "docs", event: "docs.search", stage: "query" };
				logger.info("docs.search.started", { ...fields, result: "started", query_length: query.length });
				try {
					const limit = Math.max(1, Math.min(MAX_PAGE_SECTIONS, Math.floor(options.limit ?? 10)));
					const budget = options.characterBudget ?? Number.POSITIVE_INFINITY;
					if (!Number.isFinite(limit) || Number.isNaN(budget) || budget < 0)
						throw new Error("Invalid documentation search page size");
					const terms = analyzeQuery(query);
					const technicalName = technicalQueryName(query);
					const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
					const queryKey = digest(
						JSON.stringify([normalizeSearchText(query), options.index ?? null, this.storage.path]),
					);
					if (cursor && cursor.q !== queryKey)
						throw new Error("Documentation search cursor does not match query or index");
					// Version, every ranked hit, counts, text and provenance share a read
					// snapshot. Cursors survive reopening, but never silently cross edits.
					const result = this.storage.read(() => {
						const { ranked, version } = this.#rank(query, terms, technicalName, options.index);
						if (cursor && cursor.s !== version)
							throw new Error("Stale documentation search cursor: indexed snapshot has changed");
						const start = cursor?.p ?? 0;
						if (cursor && start >= ranked.length) throw new Error("Invalid documentation search cursor");
						const sections: DocsSectionHit[] = [];
						let cost = 0;
						for (let position = start; position < ranked.length && sections.length < limit; position++) {
							const { row, shape, matchKind } = ranked[position];
							const hit: DocsSectionHit = {
								sectionId: row.section_id as number,
								index: row.index_name as string,
								documentHash: row.document_hash as string,
								path: row.relative_path as string,
								headingPath: row.heading_path as string,
								lineStart: row.line_start as number,
								lineEnd: row.line_end as number,
								text: row.raw_markdown as string,
								shape,
								matchKind,
								rank: row.rank as number,
							};
							const sectionCost = options.sectionCost?.(hit, sections.length) ?? hit.text.length;
							if (!Number.isFinite(sectionCost) || sectionCost < 0)
								throw new Error("Invalid documentation search section cost");
							// Never skip an oversized next hit. The first hit is always
							// delivered whole, even when it exceeds the caller's target.
							if (sections.length > 0 && cost + sectionCost > budget) break;
							sections.push(hit);
							cost += sectionCost;
						}
						const next = start + sections.length;
						const hasMore = next < ranked.length;
						return {
							sections,
							total: ranked.length,
							hasMore,
							exactNameMatches: ranked.filter(entry => entry.matchKind === "exact-name").length,
							...(technicalName === undefined ? {} : { technicalName }),
							...(hasMore
								? {
										cursor: Buffer.from(
											JSON.stringify({ v: 1, q: queryKey, s: version, p: next } satisfies SearchCursor),
										).toString("base64url"),
									}
								: {}),
						};
					});
					logger.info("docs.search.completed", {
						...fields,
						result: result.sections.length ? "completed" : "no_match",
						elapsed_ms: performance.now() - started,
						term_count: terms.length,
						section_count: result.sections.length,
						match_count: result.total,
					});
					return result;
				} catch (error) {
					logger.error("docs.search.failed", {
						...fields,
						result: "failed",
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					});
					throw error;
				}
			},
		);
	}

	/**
	 * Exhaustive DB ranking. FTS supplies recall and a tie-breaker, never a
	 * bounded candidate window. A stored-body scan also recovers complete names
	 * whose punctuation/tokenization differs from the FTS terms.
	 */
	#rank(
		query: string,
		terms: readonly string[],
		technicalName: string | undefined,
		index: string | undefined,
	): { ranked: RankedRow[]; version: string } {
		const filter = indexFilter(index);
		const patterns = terms.map(term => literalPattern(term));
		const phrase = literalPattern(normalizeSearchText(query));
		const name =
			technicalName === undefined
				? undefined
				: new RegExp(literalPattern(normalizeSearchText(technicalName), !/[\\/]|::/u.test(technicalName)), "gu");
		const ranks = new Map<number, number>();
		if (terms.length > 0) {
			const matches = this.storage.db
				.query(`SELECT f.rowid section_id,bm25(sections_fts,0.0,0.0,0.5,2.0,1.0) rank
					FROM sections_fts f JOIN sections s ON s.id=f.rowid JOIN doc_indexes i ON i.id=s.index_id
					WHERE sections_fts MATCH ?${filter.sql} ORDER BY f.rowid`)
				.all(compileFtsQuery(terms), ...filter.args) as Array<{ section_id: number; rank: number }>;
			for (const match of matches) ranks.set(match.section_id, match.rank);
		}
		const snapshot = new Bun.CryptoHasher("sha256");
		// A logical version is independent of the SQLite connection's data_version
		// (which resets on reopen). Include empty indexes/documents and all visible
		// stored sections, not only today's matches, so later pages cannot mix edits.
		for (const row of this.storage.db
			.query(`SELECT i.id,i.name,i.root_path,d.id document_id,d.relative_path,d.title,d.source_kind,d.sha256,d.size_bytes,d.mtime_ms
				FROM doc_indexes i LEFT JOIN documents d ON d.index_id=i.id
				WHERE i.name NOT GLOB '${BUILDING_INDEX_PREFIX}*' ORDER BY i.id,d.id`)
			.iterate()) {
			snapshot.update(JSON.stringify(row));
		}
		const documentContexts = new Map<number, Map<number, SectionContext>>();
		const loadContext = (row: Record<string, unknown>): SectionContext => {
			const documentId = row.document_id as number;
			let contexts = documentContexts.get(documentId);
			if (!contexts) {
				contexts = this.#sectionContexts(documentId);
				documentContexts.set(documentId, contexts);
			}
			return contexts.get(row.section_id as number) as SectionContext;
		};
		const candidates: Array<Record<string, unknown>> = [];
		const rows = this.storage.db
			.query(`SELECT s.id section_id,s.document_id,s.index_id,s.ordinal,s.byte_start,s.byte_end,s.heading_level,
				i.name index_name,d.relative_path,d.sha256 document_hash,s.heading_path,s.line_start,s.line_end,s.raw_markdown
				FROM sections s JOIN documents d ON d.id=s.document_id JOIN doc_indexes i ON i.id=s.index_id
				WHERE i.name NOT GLOB '${BUILDING_INDEX_PREFIX}*' ORDER BY s.id`)
			.iterate() as Iterable<Record<string, unknown>>;
		for (const row of rows) {
			snapshot.update(JSON.stringify(row));
			if (index !== undefined && row.index_name !== index) continue;
			const rank = ranks.get(row.section_id as number);
			if (rank === undefined && !name) continue;
			const markdown = row.raw_markdown as string;
			const raw = normalizeSearchText(markdown);
			const context = loadContext(row);
			const { fencePrefix, continuesLine } = context;
			const plain = normalizeSearchText(normalizePlainText(markdown, fencePrefix, continuesLine));
			const rawExact = name ? matchesSectionName(name, raw, markdown, context) : false;
			// Render recovered names with the same stored fence/line context,
			// keeping inline code fragments distinct from adjacent text.
			const exact =
				rawExact ||
				(name && matchesSectionName(name, plain, markdown, context)
					? matchesSectionName(name, normalizeNameText(markdown, fencePrefix, continuesLine), markdown, context)
					: false);
			if (rank === undefined && !exact) continue;
			row.rank = rank ?? 0;
			row.search_raw = raw;
			row.search_plain = plain;
			row.search_exact = exact;
			candidates.push(row);
		}
		// FTS-only changes affecting this query also invalidate its continuation.
		snapshot.update(JSON.stringify([...ranks]));
		const frequencies = patterns.map(pattern =>
			candidates.reduce(
				(count, row) =>
					count + Number(pattern.test(row.search_raw as string) || pattern.test(row.search_plain as string)),
				0,
			),
		);
		const weights = terms.map(
			(term, position) =>
				(Object.hasOwn(QUERY_GENERIC_TERMS, term) ? 0.2 : 1) *
				(1 + Math.log(1 + candidates.length / (1 + frequencies[position]))),
		);
		// A standalone Han run is also a query topic (e.g. an explicitly named
		// activity). Bigrams inside a longer question remain recall/detail terms,
		// so its generic prose cannot outvote the technical combination.
		const hanTopics = new Set(query.normalize("NFKC").match(/[\u3400-\u4dbf\u4e00-\u9fff]+/gu) ?? []);
		const topics = terms.map(
			term => !Object.hasOwn(QUERY_GENERIC_TERMS, term) && (/[a-z]/iu.test(term) || hanTopics.has(term)),
		);
		const ranked = candidates.map(row => scoreCandidate(row, patterns, weights, topics, phrase, loadContext));
		// Topic coverage is a conjunction signal, not a frequency contest: a
		// section about both requested technical nouns beats one about only one.
		// Once coverage ties, prefer its own topical title and substantive body.
		ranked.sort(
			(a, b) =>
				Number(b.matchKind === "exact-name") - Number(a.matchKind === "exact-name") ||
				Number(a.shape === "stub") - Number(b.shape === "stub") ||
				Number(b.titlePhrase) - Number(a.titlePhrase) ||
				b.topicBody - a.topicBody ||
				b.topicTitle - a.topicTitle ||
				Number(b.shape === "content") - Number(a.shape === "content") ||
				Number(b.phrase) - Number(a.phrase) ||
				b.relevance - a.relevance ||
				(a.row.rank as number) - (b.row.rank as number) ||
				(a.row.section_id as number) - (b.row.section_id as number),
		);
		// Keep every locator, but prefer distinct evidence inside each match class.
		// Exact-name evidence, even repeated, always precedes related evidence.
		const seen = new Set<string>();
		const distinctExact: RankedRow[] = [];
		const repeatedExact: RankedRow[] = [];
		const distinctRelated: RankedRow[] = [];
		const repeatedRelated: RankedRow[] = [];
		const stubs: RankedRow[] = [];
		for (const entry of ranked) {
			if (entry.shape === "stub" && entry.matchKind === "related") {
				stubs.push(entry);
				continue;
			}
			const repeated = entry.bodyHash !== undefined && seen.has(entry.bodyHash);
			if (entry.bodyHash) seen.add(entry.bodyHash);
			if (entry.matchKind === "exact-name") (repeated ? repeatedExact : distinctExact).push(entry);
			else (repeated ? repeatedRelated : distinctRelated).push(entry);
		}
		return {
			ranked: [...distinctExact, ...repeatedExact, ...distinctRelated, ...repeatedRelated, ...stubs],
			version: snapshot.digest("hex"),
		};
	}

	/** Recover stored fence/line context, original name boundaries, and shapes together. */
	#sectionContexts(documentId: number): Map<number, SectionContext> {
		const rows = this.storage.db
			.query(`SELECT id,document_id documentId,byte_start byteStart,byte_end byteEnd,raw_markdown rawMarkdown
				FROM sections WHERE document_id=? ORDER BY ordinal`)
			.all(documentId) as Array<{
			id: number;
			documentId: number;
			byteStart: number;
			byteEnd: number;
			rawMarkdown: string;
		}>;
		const contexts = new Map<number, SectionContext>();
		const bytes = rows.map(row => Buffer.from(row.rawMarkdown));
		let position = 0;
		for (const { section, fencePrefix, continuesLine } of markdownSectionContexts(rows)) {
			const previous = rows[position - 1];
			const next = rows[position + 1];
			const beforeOffset = previous ? section.byteStart - previous.byteStart : 0;
			const afterOffset = next ? section.byteEnd - next.byteStart : 0;
			// Overlapping chunks share byte coordinates. Read only the adjacent
			// original characters, not the overlap as new evidence for this body.
			const before =
				previous && previous.byteStart < section.byteStart && previous.byteEnd >= section.byteStart
					? [...bytes[position - 1].subarray(Math.max(0, beforeOffset - 8), beforeOffset).toString()]
							.slice(-2)
							.join("")
					: "";
			const after =
				next && next.byteStart <= section.byteEnd && next.byteEnd > section.byteEnd
					? [...bytes[position + 1].subarray(afterOffset, afterOffset + 8).toString()].slice(0, 2).join("")
					: "";
			contexts.set(section.id, {
				shape: fencePrefix || continuesLine ? "content" : sectionShape(section.rawMarkdown),
				fencePrefix,
				continuesLine,
				before,
				after,
			});
			position++;
		}
		return contexts;
	}
}
