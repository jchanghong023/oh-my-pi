export interface KnowledgeServiceOptions {
	agentDir: string;
	cwd?: string;
}

export interface KnowledgeBuildOptions {
	signal?: AbortSignal;
	onProgress?: (progress: KnowledgeProgress) => void;
}

export interface KnowledgeSearchOptions {
	/** Default relevance search, or explicit regular-expression matching. */
	mode?: "search" | "grep";
	/** Grep only: true is case-sensitive (default); false ignores case. */
	case?: boolean;
	index?: string;
	/** Stored index-relative file, or directory prefix when ending in `/`. */
	path?: string;
	limit?: number;
	cursor?: string;
	characterBudget?: number;
	sectionCost?: (section: KnowledgeSectionHit, position: number) => number;
	signal?: AbortSignal;
}

export interface KnowledgeSearchWindowOptions {
	mode?: "search" | "grep";
	/** Grep only; defaults to case-sensitive matching. */
	case?: boolean;
	index?: string;
	/** Stored index-relative file, or directory prefix when ending in `/`. */
	path?: string;
	limit?: number;
	cursor?: string;
}

export interface KnowledgeSearchCursor {
	v: 1;
	q: string;
	s: string;
	p: number;
}

export interface KnowledgeSearchWindow {
	sections: KnowledgeSectionHit[];
	total: number;
	exactNameMatches: number;
	technicalName?: string;
	retrieval?: string;
	reranked?: boolean;
	/** Start of this window, not the position after its prefetched sections. */
	cursorBase: KnowledgeSearchCursor;
}

export type KnowledgeProgressPhase = "scan" | "fts";

export interface KnowledgeProgress {
	phase: KnowledgeProgressPhase;
	total: number;
	completed: number;
	failed: number;
	currentPath?: string;
	message?: string;
}

export interface KnowledgeIndexSummary {
	id: number;
	name: string;
	rootPath: string;
	documentCount: number;
	sectionCount: number;
}

export interface KnowledgeSectionHit {
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

export interface KnowledgeSearchResult {
	/** Requested page in relevance order (search), or stable source order (grep). */
	sections: KnowledgeSectionHit[];
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

export interface KnowledgeBuildResult {
	index: KnowledgeIndexSummary;
	processed: number;
	failed: number;
	/** Independent from successful full-text publication; absent on older workers. */
	vectorStatus?: "ready" | "unavailable" | "failed";
}

export interface KnowledgeVectorRetryResult {
	total: number;
	/** Indexes completed by this retry. */
	completed: number;
	/** Indexes already complete for the current model; no embedding request made. */
	skipped: number;
}
