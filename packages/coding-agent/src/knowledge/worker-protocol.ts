import type {
	KnowledgeBuildResult,
	KnowledgeIndexSummary,
	KnowledgeProgress,
	KnowledgeSearchWindow,
	KnowledgeSearchWindowOptions,
	KnowledgeServiceOptions,
} from "./types";

/** Only correlation identifiers cross the process boundary, never arbitrary logger fields. */
export type KnowledgeWorkerLogContext = {
	operation_id: string;
	call_id: string;
	parent_call_id?: string;
};

export type KnowledgeWorkerCommand =
	| { type: "configure"; options: KnowledgeServiceOptions; cursorPath: string }
	| { type: "list" }
	| { type: "init"; directory: string; name: string }
	| { type: "remove"; name: string }
	| { type: "searchWindow"; query: string; options: KnowledgeSearchWindowOptions };

export type KnowledgeWorkerInbound =
	| (KnowledgeWorkerCommand & { id: string; context: KnowledgeWorkerLogContext })
	| { type: "cancel"; id: string; context: KnowledgeWorkerLogContext };

export interface KnowledgeWorkerResults {
	configure: undefined;
	list: KnowledgeIndexSummary[];
	init: KnowledgeBuildResult;
	remove: undefined;
	searchWindow: KnowledgeSearchWindow;
}

export interface KnowledgeWorkerError {
	name: string;
	message: string;
	code?: string;
}

export type KnowledgeWorkerOutbound =
	| {
			[K in keyof KnowledgeWorkerResults]: {
				type: "result";
				id: string;
				command: K;
				value: KnowledgeWorkerResults[K];
				engine_ms: number;
			};
	  }[keyof KnowledgeWorkerResults]
	| { type: "progress"; id: string; progress: KnowledgeProgress }
	| { type: "error"; id: string; error: KnowledgeWorkerError; engine_ms: number };

export interface KnowledgeWorkerTransport {
	send(message: KnowledgeWorkerOutbound): void;
	onMessage(handler: (message: KnowledgeWorkerInbound) => void): () => void;
}
