export type DocsIndexState = "building" | "ready" | "partial";
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
	absolutePath: string;
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
	state: DocsIndexState;
	lastError?: string;
	createdAt: string;
	updatedAt: string;
	indexedAt?: string;
	documentCount: number;
	partialCount: number;
	sectionCount: number;
}

export interface DocsSectionHit {
	sectionId: number;
	index: string;
	path: string;
	headingPath: string;
	lineStart: number;
	lineEnd: number;
	excerpt: string;
	rank: number;
}

export interface DocsSearchResult {
	sections: DocsSectionHit[];
}

export interface DocsBuildResult {
	index: DocsIndexSummary;
	processed: number;
	failed: number;
}
