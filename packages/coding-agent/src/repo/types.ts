export type RepoCategory = "source" | "test" | "config" | "other";
export type RepoFailureKind = "binary" | "oversize" | "unreadable" | "unstable" | "symlink" | "parse";

export interface RepoFailure {
	path: string;
	kind: RepoFailureKind;
	message: string;
}

export interface RepoStatus {
	root: string;
	exists: boolean;
	generation: string | null;
	fileCount: number;
	symbolCount: number;
	failures: RepoFailure[];
	failureCount: number;
	failuresTruncated: boolean;
	pendingPaths: string[];
	pendingCount: number;
	pendingTruncated: boolean;
	needsReconcile: boolean;
	uncertainReasons: string[];
	uncertainCount: number;
	uncertaintyTruncated: boolean;
	unchecked: boolean;
	lastFullCheck: number | null;
	incomplete: boolean;
	exclusions: string[];
}

export interface RepoProgress {
	phase: "enumerating" | "reading" | "parsing" | "publishing";
	processed: number;
	total: number;
	path?: string;
}
export interface RepoMaintenanceOptions {
	signal?: AbortSignal;
	onProgress?: (progress: RepoProgress) => void;
}

export interface RepoQueryOptions {
	path?: string;
	category?: RepoCategory;
	limit?: number;
	cursor?: string;
	signal?: AbortSignal;
}

export interface RepoTextHit {
	path: string;
	category: RepoCategory;
	startLine: number;
	endLine: number;
	snippet: string;
}

export interface RepoSymbolHit {
	path: string;
	category: RepoCategory;
	name: string;
	qualname: string;
	kind: "module" | "class" | "function" | "method";
	startLine: number;
	endLine: number;
	signature?: string;
}

export interface RepoQueryResult<T> {
	root: string;
	generation: string | null;
	status: "ok" | "missing";
	hits: T[];
	cursor?: string;
	truncated: boolean;
	warnings: string[];
	coverage: RepoStatus;
}
