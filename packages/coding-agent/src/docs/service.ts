import * as path from "node:path";
import { enumerateMarkdownFiles, normalizePlainText, readMarkdownDocument } from "./markdown";
import { DocsStorage } from "./storage";
import type { DocsBuildResult, DocsIndexSummary, DocsProgress, DocsSearchResult, MarkdownDocument } from "./types";

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

function ftsQuery(query: string): string {
	const tokens = normalizeFts(query).match(/[\u3400-\u4dbf\u4e00-\u9fff]|[\p{L}\p{N}_]+/gu) ?? [];
	return tokens.map(token => `"${token.replace(/"/g, '""')}"`).join(" AND ");
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

function searchExcerpt(rawMarkdown: string, query: string): string {
	const text = rawMarkdown.replace(/\s+/gu, " ").trim();
	const matchAt = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
	const start = Math.max(0, (matchAt < 0 ? 0 : matchAt) - 100);
	const end = Math.min(text.length, start + 320);
	return `${start > 0 ? "… " : ""}${text.slice(start, end)}${end < text.length ? " …" : ""}`;
}

const BUILDING_INDEX_PREFIX = "__building__";

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
	const visible = " AND i.state!='building'";
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

	status(name?: string): DocsIndexSummary | DocsIndexSummary[] {
		if (!name) return this.list();
		const index = this.storage.get(name);
		if (!index) throw new Error(`Unknown document index: ${name}`);
		return index;
	}

	async init(directory: string, name: string, options: DocsBuildOptions = {}): Promise<DocsBuildResult> {
		checkCancelled(options.signal);
		const storedName = validateName(name);
		if (this.storage.get(storedName)) throw new Error(`Document index already exists: ${storedName}`);
		const rootPath = path.resolve(this.cwd, directory);
		const files = await enumerateMarkdownFiles(rootPath);
		checkCancelled(options.signal);
		if (files.length === 0) throw new Error(`No Markdown files found in: ${rootPath}`);
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
					"INSERT INTO documents(index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms,status,last_error) VALUES(?,?,?,?,?,?,?,'ready',NULL) RETURNING id",
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
		const limit = Math.max(1, Math.min(50, options.limit ?? 10));
		const filter = indexFilter(options.index);
		const match = ftsQuery(query);
		if (!match) return { sections: [] };
		// Rerank a bounded window, not just the user-visible top K. This does not
		// change AND eligibility or guarantee exact matches outside this window.
		const candidateLimit = Math.max(100, limit * 4);
		const candidates = this.storage.db
			.query(`SELECT f.rowid section_id,i.name index_name,d.relative_path,s.heading_path,s.line_start,s.line_end,
			 s.raw_markdown excerpt, bm25(sections_fts,0.0,0.0,0.5,2.0,1.0) rank
			 FROM sections_fts f JOIN sections s ON s.id=f.rowid JOIN documents d ON d.id=s.document_id JOIN doc_indexes i ON i.id=s.index_id
			 WHERE sections_fts MATCH ?${filter.sql} ORDER BY rank,s.id LIMIT ?`)
			.all(match, ...filter.args, candidateLimit) as Array<Record<string, unknown>>;
		const normalizedQuery = normalizeSearchText(query).replace(/^[`"']+|[`"']+$/gu, "");
		const terms = [
			...new Set(
				(normalizedQuery.match(/\p{Script=Han}+|[^\p{Script=Han}\s]+/gu) ?? [])
					.map(term => term.replace(/^[^\p{L}\p{N}_/\\-]+|[^\p{L}\p{N}_+#/\\]+$/gu, ""))
					.filter(Boolean),
			),
		].map(literalPattern);
		const phrase = literalPattern(normalizedQuery);
		const ranked = candidates.map(row => {
			const raw = normalizeSearchText(row.excerpt as string);
			const plain = normalizeSearchText(normalizePlainText(row.excerpt as string));
			const heading = normalizeSearchText(normalizePlainText(row.heading_path as string));
			const path = normalizeSearchText(row.relative_path as string);
			const separator = heading.lastIndexOf(" > ");
			const title = separator < 0 ? heading : heading.slice(separator + 3);
			let literalCount = 0;
			let titleCount = 0;
			for (const term of terms) {
				if (term.test(raw) || term.test(plain) || term.test(heading) || term.test(path)) literalCount++;
				if (term.test(title)) titleCount++;
			}
			return {
				row,
				literalCount,
				titleCount,
				titlePhrase: phrase.test(title),
				phrase: phrase.test(raw) || phrase.test(plain) || phrase.test(heading) || phrase.test(path),
			};
		});
		// Match tiers precede BM25; its query-dependent scale is not an additive bonus.
		ranked.sort(
			(a, b) =>
				b.literalCount - a.literalCount ||
				Number(b.titlePhrase) - Number(a.titlePhrase) ||
				Number(b.phrase) - Number(a.phrase) ||
				b.titleCount - a.titleCount ||
				(a.row.rank as number) - (b.row.rank as number) ||
				(a.row.section_id as number) - (b.row.section_id as number),
		);
		return {
			sections: ranked.slice(0, limit).map(({ row }) => ({
				sectionId: row.section_id as number,
				index: row.index_name as string,
				path: row.relative_path as string,
				headingPath: row.heading_path as string,
				lineStart: row.line_start as number,
				lineEnd: row.line_end as number,
				excerpt: searchExcerpt(row.excerpt as string, query),
				rank: row.rank as number,
			})),
		};
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
