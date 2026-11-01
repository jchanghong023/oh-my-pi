import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { knowledgePrepareToolQuery } from "@oh-my-pi/pi-natives";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { KnowledgeService } from "../knowledge/service";
import knowledgeSearchDescription from "../prompts/tools/knowledge-search.md" with { type: "text" };
import type { ToolSession } from ".";
import { outputMeta } from "./output-meta";
import { toolResult } from "./tool-result";

const knowledgeSearchSchema = type({
	query: type("string").describe("keywords or a whole question for search; regular expression for grep"),
	"mode?": type("'search' | 'grep'").describe(
		"default search ranks by relevance; grep matches original Markdown lines",
	),
	"case?": type("boolean").describe("grep only: case-sensitive by default (true); false ignores case"),
	"path?": type("string").describe(
		"case-sensitive index-relative file path, or directory path ending in / to search descendants",
	),
	"cursor?": type("string").describe(
		"continuation from the previous page; keep query, mode, effective case and path unchanged",
	),
	"+": "reject",
});

export type KnowledgeSearchToolParams = typeof knowledgeSearchSchema.infer;

export class KnowledgeSearchTool implements AgentTool<typeof knowledgeSearchSchema> {
	readonly name = "knowledge_search";
	readonly approval = "read" as const;
	readonly label = "Knowledge Search";
	readonly loadMode = "discoverable" as const;
	readonly summary = "Search indexed enterprise knowledge and documents by full text and vectors";
	readonly description = prompt.render(knowledgeSearchDescription);
	readonly parameters = knowledgeSearchSchema;
	readonly strict = true;
	/** Near-miss arguments are normalized in `execute`, not rejected up front. */
	readonly lenientArgValidation = true;

	#service?: KnowledgeService;
	#identity?: string;
	#lifetime = new AbortController();
	#disposed = false;
	#disposePromise?: Promise<void>;
	#retiredServices = new Set<Promise<void>>();
	#unregisterDispose?: () => void;
	#unregisterSessionChange?: () => void;

	constructor(private readonly session: ToolSession) {
		this.#unregisterDispose = session.registerDisposeCallback?.(() => this.dispose()) || undefined;
		this.#unregisterSessionChange =
			session.registerSessionChangeCallback?.(() => this.#releaseService()) || undefined;
	}

	/** Standalone consumers must dispose the tool when its owner is finished. */
	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#releaseService();
		this.#unregisterDispose?.();
		this.#unregisterSessionChange?.();
		this.#unregisterDispose = undefined;
		this.#unregisterSessionChange = undefined;
		this.#disposePromise = Promise.all(this.#retiredServices).then(() => {});
		return this.#disposePromise;
	}

	#sessionIdentity(): string {
		return JSON.stringify([
			this.session.settings.getAgentDir(),
			this.session.cwd,
			this.session.getSessionId?.(),
			this.session.getSessionFile(),
		]);
	}

	#releaseService(): void {
		this.#lifetime.abort();
		if (this.#service) {
			const shutdown = this.#service.close();
			this.#retiredServices.add(shutdown);
			void shutdown.then(
				() => {
					this.#retiredServices.delete(shutdown);
				},
				() => {
					// Keep failed shutdowns observable by the explicit owner awaiting dispose.
				},
			);
		}
		this.#service = undefined;
		this.#identity = undefined;
		this.#lifetime = new AbortController();
	}

	#getService(): KnowledgeService {
		if (this.#disposed || this.session.isDisposed?.()) {
			throw new DOMException("Knowledge search tool owner has been disposed", "AbortError");
		}
		const identity = this.#sessionIdentity();
		if (this.#identity !== identity) this.#releaseService();
		if (!this.#service) {
			this.#service = new KnowledgeService({
				agentDir: this.session.settings.getAgentDir(),
				cwd: this.session.cwd,
			});
			this.#identity = identity;
		}
		return this.#service;
	}

	#assertCurrent(service: KnowledgeService, signal: AbortSignal): void {
		if (this.#identity !== this.#sessionIdentity() || this.session.isDisposed?.()) this.#releaseService();
		if (signal.aborted || this.#disposed || this.#service !== service) {
			throw new DOMException("Knowledge search query cancelled", "AbortError");
		}
	}

	async execute(
		_toolCallId: string,
		params: KnowledgeSearchToolParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	) {
		return logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `knowledge-${crypto.randomUUID()}`,
				tool_call_id: _toolCallId,
			},
			async () => {
				const started = performance.now();
				let stage = "validate";
				let expectedResult: string | undefined;
				let completion: Record<string, number | undefined> | undefined;
				const fields = { component: "knowledge", event: "knowledge.query" };
				let operationSignal = _signal;
				logger.info("knowledge.query.started", { ...fields, stage, result: "started" });
				try {
					// Argument validation is lenient so a stray extra key cannot fail a call;
					// `query` itself is still required, and the error names what arrived.
					const raw = params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
					const prepared = knowledgePrepareToolQuery(
						raw.query,
						raw.cursor,
						Object.keys(raw),
						"cursor" in raw,
						raw.mode,
						raw.case,
					);
					if (prepared.error !== undefined) {
						expectedResult = prepared.errorKind;
						throw new ToolError(prepared.error);
					}
					if (raw.path !== undefined && (typeof raw.path !== "string" || raw.path.length === 0)) {
						expectedResult = "invalid_path";
						throw new ToolError("Knowledge search path must be a non-empty index-relative path");
					}
					const query = prepared.query!;
					const cursor = prepared.cursor;
					const mode = prepared.mode as KnowledgeSearchToolParams["mode"];
					const caseSensitive = prepared.case;
					const path = raw.path as string | undefined;
					logger.info("knowledge.query.validated", {
						...fields,
						stage,
						result: "completed",
						query_length: query.length,
						query_truncated: prepared.queryTruncated,
						ignored_argument_count: prepared.ignoredArgumentCount,
					});
					stage = "open";

					const service = this.#getService();
					operationSignal = _signal ? AbortSignal.any([_signal, this.#lifetime.signal]) : this.#lifetime.signal;
					this.#assertCurrent(service, operationSignal);
					try {
						stage = "indexes";
						const indexCount = (await service.list({ signal: operationSignal })).length;
						this.#assertCurrent(service, operationSignal);
						if (indexCount === 0) {
							expectedResult = "no_index";
							throw new ToolError('No document indexes. Run: omp knowledge init "<dir>" --name <name>');
						}
						logger.info("knowledge.query.indexes", {
							...fields,
							stage,
							result: "completed",
							index_count: indexCount,
						});
						stage = "query";
						const page = await service.searchKnowledge(query, {
							signal: operationSignal,
							cursor,
							mode,
							case: caseSensitive,
							path,
						});
						this.#assertCurrent(service, operationSignal);
						stage = "render";
						const result = page.result;
						completion = {
							match_count: result.total,
							section_count: result.sections.length,
							rendered_section_count: page.renderedSectionCount,
							rendered_characters: page.renderedCharacters,
							duplicate_count: page.duplicateCount,
							oversize_count: page.oversizeCount,
						};
						return toolResult({ meta: outputMeta().completePage().get() }).text(page.text).done();
					} finally {
						if (completion)
							logger.info("knowledge.query.completed", {
								...fields,
								stage: "render",
								result: "completed",
								elapsed_ms: performance.now() - started,
								...completion,
							});
					}
				} catch (error) {
					if (operationSignal?.aborted) error = new DOMException("Knowledge search query cancelled", "AbortError");
					const cancelled = error instanceof Error && error.name === "AbortError";
					const log = expectedResult || cancelled ? logger.info : logger.error;
					log("knowledge.query.finished", {
						...fields,
						stage,
						result: cancelled ? "cancelled" : (expectedResult ?? "failed"),
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					});
					throw error;
				}
			},
		);
	}
}
