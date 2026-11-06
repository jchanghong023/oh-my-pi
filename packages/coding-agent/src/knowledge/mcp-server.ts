import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	type CallToolResult,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { knowledgePrepareToolQuery } from "@oh-my-pi/pi-natives";
import { logger, prompt, VERSION } from "@oh-my-pi/pi-utils";
import knowledgeMcpInstructions from "../prompts/system/knowledge-mcp.md" with { type: "text" };
import knowledgeSearchDescription from "../prompts/tools/knowledge-search.md" with { type: "text" };
import { KnowledgeService } from "./service";
import type { KnowledgeSearchOptions, KnowledgeServiceOptions } from "./types";

/** Runs an owner-scoped Knowledge service until its stdio connection closes. */
export async function runKnowledgeMcp(options: KnowledgeServiceOptions): Promise<void> {
	const service = new KnowledgeService(options);
	const lifetime = new AbortController();
	const transport = new StdioServerTransport();
	const server = new Server(
		{ name: "omp-knowledge", version: VERSION },
		{ capabilities: { tools: {} }, instructions: knowledgeMcpInstructions },
	);
	const stopped = Promise.withResolvers<void>();
	let stopping = false;
	let failure: Error | undefined;
	const stop = (error?: Error): void => {
		if (stopping) return;
		stopping = true;
		failure = error;
		lifetime.abort(new DOMException("Knowledge MCP connection closed", "AbortError"));
		stopped.resolve();
	};
	const onEnd = (): void => stop();
	const onInputError = (): void => stop(new Error("Knowledge MCP standard input failed"));
	const onOutputError = (): void => stop(new Error("Knowledge MCP standard output failed"));

	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [
			{
				name: "knowledge_search",
				description: prompt.render(knowledgeSearchDescription),
				inputSchema: {
					type: "object",
					properties: {
						query: {
							type: "string",
							description: "keywords or a whole question for search; regular expression for grep",
						},
						mode: {
							type: "string",
							enum: ["search", "grep"],
							description: "default search ranks by relevance; grep matches original Markdown lines",
						},
						case: {
							type: "boolean",
							description: "grep only: case-sensitive by default (true); false ignores case",
						},
						path: {
							type: "string",
							description:
								"case-sensitive index-relative file path, or directory path ending in / to search descendants",
						},
						cursor: {
							type: "string",
							description:
								"continuation from the previous page; keep query, mode, effective case and path unchanged",
						},
					},
					required: ["query"],
					additionalProperties: true,
				},
				annotations: { readOnlyHint: true },
			},
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
		if (request.params.name !== "knowledge_search") {
			throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
		}
		const signal = AbortSignal.any([extra.signal, lifetime.signal]);
		try {
			signal.throwIfAborted();
			const raw = request.params.arguments ?? {};
			const prepared = knowledgePrepareToolQuery(
				raw.query,
				raw.cursor,
				Object.keys(raw),
				"cursor" in raw,
				raw.mode,
				raw.case,
			);
			if (prepared.error !== undefined) throw new Error(prepared.error);
			if (raw.path !== undefined && (typeof raw.path !== "string" || raw.path.length === 0)) {
				throw new Error("Knowledge search path must be a non-empty index-relative path");
			}
			const indexes = await service.list({ signal });
			signal.throwIfAborted();
			if (indexes.length === 0) {
				throw new Error('No document indexes. Run: omp knowledge init "<dir>" --name <name>');
			}
			const page = await service.searchKnowledge(prepared.query!, {
				signal,
				cursor: prepared.cursor,
				mode: prepared.mode as KnowledgeSearchOptions["mode"],
				case: prepared.case,
				path: raw.path as string | undefined,
			});
			signal.throwIfAborted();
			return { content: [{ type: "text", text: page.text }] };
		} catch (error) {
			// The SDK suppresses responses to cancelled requests and closed connections.
			signal.throwIfAborted();
			return {
				isError: true,
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			};
		}
	});
	server.onclose = onEnd;
	server.onerror = () => {
		// SDK diagnostics can contain raw protocol arguments; log only the event.
		logger.warn("knowledge.mcp.protocol.error", { component: "knowledge" });
	};
	process.stdin.once("end", onEnd);
	process.stdin.once("close", onEnd);
	process.stdin.once("error", onInputError);
	process.stdout.once("error", onOutputError);
	process.stdout.once("close", onOutputError);
	process.once("SIGINT", onEnd);
	process.once("SIGTERM", onEnd);
	try {
		await server.connect(transport);
		if (process.stdin.readableEnded || process.stdin.destroyed) stop();
		await stopped.promise;
	} finally {
		stop();
		try {
			await Promise.all([server.close(), service.close()]);
		} finally {
			process.stdin.off("end", onEnd);
			process.stdin.off("close", onEnd);
			process.stdin.off("error", onInputError);
			process.stdout.off("error", onOutputError);
			process.stdout.off("close", onOutputError);
			process.off("SIGINT", onEnd);
			process.off("SIGTERM", onEnd);
		}
	}
	if (failure) throw failure;
}
