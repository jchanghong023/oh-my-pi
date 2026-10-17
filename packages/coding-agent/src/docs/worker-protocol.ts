import type {
	DocsBuildResult,
	DocsIndexSummary,
	DocsProgress,
	DocsSearchWindow,
	DocsSearchWindowOptions,
	DocsServiceOptions,
} from "./types";

/** Only correlation identifiers cross the process boundary, never arbitrary logger fields. */
export type DocsWorkerLogContext = {
	operation_id: string;
	call_id: string;
	parent_call_id?: string;
};

export type DocsWorkerCommand =
	| { type: "configure"; options: DocsServiceOptions; cursorPath: string }
	| { type: "list" }
	| { type: "init"; directory: string; name: string }
	| { type: "remove"; name: string }
	| { type: "searchWindow"; query: string; options: DocsSearchWindowOptions };

export type DocsWorkerInbound = DocsWorkerCommand & { id: string; context: DocsWorkerLogContext };

export interface DocsWorkerResults {
	configure: undefined;
	list: DocsIndexSummary[];
	init: DocsBuildResult;
	remove: undefined;
	searchWindow: DocsSearchWindow;
}

export interface DocsWorkerError {
	name: string;
	message: string;
	code?: string;
}

export type DocsWorkerOutbound =
	| {
			[K in keyof DocsWorkerResults]: {
				type: "result";
				id: string;
				command: K;
				value: DocsWorkerResults[K];
				engine_ms: number;
			};
	  }[keyof DocsWorkerResults]
	| { type: "progress"; id: string; progress: DocsProgress }
	| { type: "error"; id: string; error: DocsWorkerError; engine_ms: number };

export interface DocsWorkerTransport {
	send(message: DocsWorkerOutbound): void;
	onMessage(handler: (message: DocsWorkerInbound) => void): () => void;
}
