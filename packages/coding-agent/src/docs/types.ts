export type DocumentFieldType = "string" | "number" | "boolean" | "string[]" | "json";
export type DocumentIdentityScope = "global" | "document" | "section" | "parent";

export interface DocumentSchemaField {
	name: string;
	type: DocumentFieldType;
	description: string;
	required?: boolean;
}

export interface DocumentEntityKind {
	name: string;
	description: string;
	identity: {
		scope: DocumentIdentityScope;
		fields: string[];
		parentKind?: string;
		parentPredicate?: string;
	};
	fields: DocumentSchemaField[];
}

export interface DocumentPredicate {
	name: string;
	description: string;
	sourceKinds: string[];
	targetKinds: string[];
	cardinality?: "one" | "many";
}

export interface DocumentSchemaV1 {
	id: string;
	version: 1;
	title: string;
	description: string;
	instructions: string[];
	entityKinds: DocumentEntityKind[];
	predicates: DocumentPredicate[];
}

export interface ExtractionEvidence {
	quote: string;
	lineStart: number;
	lineEnd: number;
	confidence: number;
}

export interface ExtractedEntity {
	localId: string;
	kind: string;
	identity: Record<string, unknown>;
	displayName: string;
	aliases: string[];
	evidence: ExtractionEvidence;
}

export interface ExtractedAssertion {
	subjectLocalId: string;
	field: string;
	value: unknown;
	condition?: string;
	evidence: ExtractionEvidence;
}

export interface ExtractedRelation {
	sourceLocalId: string;
	predicate: string;
	targetLocalId: string;
	condition?: string;
	evidence: ExtractionEvidence;
}

export interface DocumentExtraction {
	entities: ExtractedEntity[];
	assertions: ExtractedAssertion[];
	relations: ExtractedRelation[];
}

export type DocsIndexMode = "fts" | "structured";
export type DocsIndexState = "building" | "ready" | "partial";
export type DocsDocumentStatus = "ready" | "partial";
export type DocsProgressPhase = "scan" | "fts" | "extract" | "cleanup";

export interface DocsProgress {
	phase: DocsProgressPhase;
	total: number;
	completed: number;
	failed: number;
	currentPath?: string;
	message?: string;
}

export interface ResolvedDocumentSchema {
	schema: DocumentSchemaV1;
	json: string;
	hash: string;
	source: "embedded" | string;
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
	schemaId: string;
	schemaVersion: number;
	schemaHash: string;
	mode: DocsIndexMode;
	state: DocsIndexState;
	lastError?: string;
	createdAt: string;
	updatedAt: string;
	indexedAt?: string;
	documentCount: number;
	partialCount: number;
	sectionCount: number;
	entityCount: number;
	assertionCount: number;
	relationCount: number;
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

export interface DocsEntityHit {
	entityId: number;
	index: string;
	kind: string;
	key: string;
	displayName: string;
	alias?: string;
}

export interface DocsSearchResult {
	entities: DocsEntityHit[];
	sections: DocsSectionHit[];
}

export interface DocsEvidenceResult {
	id: number;
	index: string;
	path: string;
	headingPath: string;
	lineStart: number;
	lineEnd: number;
	byteStart: number;
	byteEnd: number;
	quote: string;
	confidence: number;
	rawMarkdown: string;
}

export interface DocsEntityResult extends DocsEntityHit {
	aliases: string[];
	assertions: Array<{ field: string; value: unknown; condition?: string; evidence: DocsEvidenceResult[] }>;
}

export interface DocsRelationResult {
	id: number;
	index: string;
	sourceEntityId: number;
	sourceName: string;
	predicate: string;
	targetEntityId: number;
	targetName: string;
	condition?: string;
	evidence: DocsEvidenceResult[];
}

export interface DocsConflict {
	index: string;
	subjectEntityId: number;
	subjectName: string;
	predicate: string;
	condition?: string;
	values: Array<{ value: unknown; targetEntityId?: number; evidence: DocsEvidenceResult[] }>;
}

export interface DocsBuildResult {
	index: DocsIndexSummary;
	processed: number;
	failed: number;
}

export interface DocsExtractorContext {
	schema: DocumentSchemaV1;
	document: MarkdownDocument;
	section: MarkdownSection;
	signal?: AbortSignal;
}

export type DocsExtractor = (context: DocsExtractorContext) => Promise<DocumentExtraction>;
