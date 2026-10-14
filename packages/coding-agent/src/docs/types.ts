export interface DocsServiceOptions {
	agentDir: string;
	cwd?: string;
}

export interface DocsBuildOptions {
	signal?: AbortSignal;
	onProgress?: (progress: DocsProgress) => void;
}

export interface DocsSearchOptions {
	/** Default relevance search, or explicit regular-expression matching. */
	mode?: "search" | "grep";
	/** Grep only: true is case-sensitive (default); false ignores case. */
	case?: boolean;
	index?: string;
	limit?: number;
	cursor?: string;
	characterBudget?: number;
	sectionCost?: (section: DocsSectionHit, position: number) => number;
	signal?: AbortSignal;
}

export interface DocsSearchWindowOptions {
	mode?: "search" | "grep";
	/** Grep only; defaults to case-sensitive matching. */
	case?: boolean;
	index?: string;
	limit?: number;
	cursor?: string;
}

export interface DocsSearchCursor {
	v: 1;
	q: string;
	s: string;
	p: number;
}

export interface DocsSearchWindow {
	sections: DocsSectionHit[];
	total: number;
	exactNameMatches: number;
	technicalName?: string;
	/** Start of this window, not the position after its prefetched sections. */
	cursorBase: DocsSearchCursor;
}

export type DocsProgressPhase = "scan" | "fts";

export interface DocsProgress {
	phase: DocsProgressPhase;
	total: number;
	completed: number;
	failed: number;
	currentPath?: string;
	message?: string;
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
	/** Search evidence category, or an actual raw Markdown regex match in grep mode. */
	matchKind: "exact-name" | "related" | "regex";
	rank: number;
}

export interface DocsSearchResult {
	/** Requested page in relevance order (search), or stable source order (grep). */
	sections: DocsSectionHit[];
	/** All matching sections in the selected visible indexed corpus. */
	total: number;
	hasMore: boolean;
	/** Opaque continuation bound to the query, mode, effective case, index and snapshot. */
	cursor?: string;
	/** Technical spelling detected in search mode; absent in grep mode. */
	technicalName?: string;
	/** Complete-name sections across search pages; always zero in grep mode. */
	exactNameMatches: number;
}

export interface DocsBuildResult {
	index: DocsIndexSummary;
	processed: number;
	failed: number;
}
