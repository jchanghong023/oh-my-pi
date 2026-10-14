import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { wikiPrepareToolQuery } from "@oh-my-pi/pi-natives";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { DocsService } from "../docs/service";
import wikiDescription from "../prompts/tools/wiki.md" with { type: "text" };
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

const wikiSchema = type({
	query: type("string").describe("keywords, or a whole question; results are ranked by relevance"),
	"cursor?": type("string").describe("continuation from the previous page; keep query unchanged"),
	"+": "reject",
});

export type WikiToolParams = typeof wikiSchema.infer;

export class WikiTool implements AgentTool<typeof wikiSchema> {
	readonly name = "wiki";
	readonly approval = "read" as const;
	readonly label = "Wiki";
	readonly loadMode = "essential" as const;
	readonly summary = "Search the indexed Markdown corpus and return the matching text";
	readonly description = prompt.render(wikiDescription);
	readonly parameters = wikiSchema;
	readonly strict = true;
	/** Near-miss arguments are normalized in `execute`, not rejected up front. */
	readonly lenientArgValidation = true;

	#service?: DocsService;
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

	#getService(): DocsService {
		if (this.#disposed || this.session.isDisposed?.()) {
			throw new DOMException("Wiki tool owner has been disposed", "AbortError");
		}
		const identity = this.#sessionIdentity();
		if (this.#identity !== identity) this.#releaseService();
		if (!this.#service) {
			this.#service = new DocsService({
				agentDir: this.session.settings.getAgentDir(),
				cwd: this.session.cwd,
			});
			this.#identity = identity;
		}
		return this.#service;
	}

	#assertCurrent(service: DocsService, signal: AbortSignal): void {
		if (this.#identity !== this.#sessionIdentity() || this.session.isDisposed?.()) this.#releaseService();
		if (signal.aborted || this.#disposed || this.#service !== service) {
			throw new DOMException("Wiki query cancelled", "AbortError");
		}
	}

	async execute(
		_toolCallId: string,
		params: WikiToolParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	) {
		return logger.withLogContext(
			{
				operation_id: logger.getLogContext().operation_id ?? `wiki-${crypto.randomUUID()}`,
				tool_call_id: _toolCallId,
			},
			async () => {
				const started = performance.now();
				let stage = "validate";
				let expectedResult: string | undefined;
				let completion: Record<string, number | undefined> | undefined;
				const fields = { component: "wiki", event: "wiki.query" };
				let operationSignal = _signal;
				logger.info("wiki.query.started", { ...fields, stage, result: "started" });
				try {
					// Argument validation is lenient so a stray extra key cannot fail a call;
					// `query` itself is still required, and the error names what arrived.
					const raw = params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
					const prepared = wikiPrepareToolQuery(raw.query, raw.cursor, Object.keys(raw), "cursor" in raw);
					if (prepared.error !== undefined) {
						expectedResult = prepared.errorKind;
						throw new ToolError(prepared.error);
					}
					const query = prepared.query!;
					const cursor = prepared.cursor;
					logger.info("wiki.query.validated", {
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
							throw new ToolError('No document indexes. Run: omp docs init "<dir>" --name <name>');
						}
						logger.info("wiki.query.indexes", { ...fields, stage, result: "completed", index_count: indexCount });
						stage = "query";
						const page = await service.searchWiki(query, { signal: operationSignal, cursor });
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
						return toolResult().text(page.text).done();
					} finally {
						if (completion)
							logger.info("wiki.query.completed", {
								...fields,
								stage: "render",
								result: "completed",
								elapsed_ms: performance.now() - started,
								...completion,
							});
					}
				} catch (error) {
					if (operationSignal?.aborted) error = new DOMException("Wiki query cancelled", "AbortError");
					const cancelled = error instanceof Error && error.name === "AbortError";
					const log = expectedResult || cancelled ? logger.info : logger.error;
					log("wiki.query.finished", {
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
