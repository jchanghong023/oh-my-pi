export type DocsProgressPhase = "scan" | "fts";

export interface DocsProgress {
	phase: DocsProgressPhase;
	total: number;
	completed: number;
	failed: number;
	currentPath?: string;
	message?: string;
}

export interface MarkdownSourceLine {
	text: string;
	line: number;
	byteStart: number;
	byteEnd: number;
}

export interface MarkdownSection {
	ordinal: number;
	headingPath: string[];
	headingLevel: number;
	lineStart: number;
	lineEnd: number;
	byteStart: number;
	byteEnd: number;
	rawMarkdown: string;
	plainText: string;
}

export interface MarkdownDocument {
	relativePath: string;
	title: string;
	sourceKind: string;
	sha256: string;
	sizeBytes: number;
	mtimeMs: number;
	sections: MarkdownSection[];
}

export interface DocsIndexSummary {
	id: number;
	name: string;
	rootPath: string;
	documentCount: number;
	sectionCount: number;
}

export interface DocsSectionHit {
	sectionId: number;
	index: string;
	documentHash: string;
	path: string;
	headingPath: string;
	lineStart: number;
	lineEnd: number;
	/** Full stored Markdown of the section; search is the content, not a pointer. */
	text: string;
	/** Context-aware shape; a chunk inside fenced code is always content. */
	shape: "stub" | "heading-only" | "content";
	/** Whole user-spelled technical name in this section, or a related match. */
	matchKind: "exact-name" | "related";
	rank: number;
}

export interface DocsSearchResult {
	/** Sections on the requested page, in relevance order. */
	sections: DocsSectionHit[];
	/** All matching sections in the selected visible indexed corpus. */
	total: number;
	hasMore: boolean;
	/** Opaque continuation bound to the query, index and stored snapshot. */
	cursor?: string;
	/** Technical spelling detected in the query, preserved for presentation. */
	technicalName?: string;
	/** Complete-name sections across all pages, before related evidence. */
	exactNameMatches: number;
}

export interface DocsBuildResult {
	index: DocsIndexSummary;
	processed: number;
	failed: number;
}
