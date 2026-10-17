export type ReviewExportScope =
	| { kind: "uncommitted" }
	| { kind: "commit"; ref: string }
	| { kind: "base-branch"; baseRef: string; targetRef: string }
	| { kind: "pr"; repo: string; number: number };

export interface ReviewExportChange {
	path: string;
	previousPath?: string;
	status: string;
	binary?: boolean;
	beforeMode?: string;
	afterMode?: string;
}

export interface ReviewExportSnapshot {
	root: string;
	scope: ReviewExportScope;
	mode: string;
	baseCommit: string | null;
	targetCommit: string;
	diff: string;
	changes: ReviewExportChange[];
	limitations: string[];
	readFile(path: string, version?: "target" | "base"): Promise<Uint8Array | undefined>;
	assertUnchanged(): Promise<void>;
	dispose(): Promise<void>;
}

export interface ReviewExportResult {
	path: string;
	fileCount: number;
	sourceLines: number;
	uncompressedBytes: number;
	compressedBytes: number;
	mode: string;
	baseCommit: string | null;
	targetCommit: string;
	limitations: string[];
}
