import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isRecord, logger, prompt, readSseEvents } from "@oh-my-pi/pi-utils";
import remoteAgentPrompt from "../prompts/system/jchtools-remote-agent.md" with { type: "text" };

export const JCHTOOLS_PROVIDER_ID = "jchtools";
export const JCHTOOLS_API = "jchtools-agent";

export function isJchToolsAgentModel(model: Pick<Model<Api>, "api"> | undefined): boolean {
	return model?.api === JCHTOOLS_API;
}

function inputError(detail: string): AIError.ProviderResponseError {
	return new AIError.ProviderResponseError(`JchTools remote Agent input rejected: ${detail}`, {
		provider: JCHTOOLS_PROVIDER_ID,
		kind: "envelope",
	});
}

function textContent(message: Message): string {
	if (message.role !== "user" && message.role !== "assistant") {
		throw inputError(`unsupported ${message.role} message; only user and remote assistant text is supported`);
	}
	if (message.providerPayload !== undefined) throw inputError("opaque provider history is unsupported");
	if (message.role === "assistant" && !isJchToolsAgentModel(message)) {
		throw inputError("ordinary assistant history must be isolated before sending");
	}
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) throw inputError("message content must be text");
	return message.content
		.map(block => {
			if (block.type !== "text" || typeof block.text !== "string") {
				throw inputError(`${block.type} content is unsupported; send text only`);
			}
			return block.text;
		})
		.join("");
}

/** Find the remote text epoch before ordinary conversion can erase failed assistants. */
export function getJchToolsEpochStart(messages: readonly (AgentMessage | Message)[]): number {
	let start = 0;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "toolResult" || (message.role === "assistant" && !isJchToolsAgentModel(message))) {
			start = index + 1;
		}
	}
	return start;
}

/** Isolate a remote text epoch without rewriting the persisted, ordinary transcript. */
export function projectJchToolsContext(context: Context, cwd: string): Context {
	const latestUser = context.messages.findLast(message => message.role === "user");
	if (latestUser) textContent(latestUser);
	const messages = context.messages.slice(getJchToolsEpochStart(context.messages)).map(message => {
		const text = textContent(message);
		return message.role === "user"
			? { role: "user" as const, content: text, timestamp: message.timestamp }
			: { ...message, content: [{ type: "text" as const, text }] };
	});
	if (!messages.some(message => message.role === "user")) {
		throw inputError("a new text user prompt is required after the ordinary tool/assistant epoch");
	}
	return {
		systemPrompt: [prompt.render(remoteAgentPrompt, { cwd: path.resolve(cwd) }).trim()],
		messages,
	};
}

function responseError(
	detail: string,
	kind: AIError.ProviderResponseErrorKind = "envelope",
): AIError.ProviderResponseError {
	return new AIError.ProviderResponseError(`JchTools remote Agent: ${detail}`, {
		provider: JCHTOOLS_PROVIDER_ID,
		kind,
	});
}

function errorDetail(value: unknown): string {
	if (typeof value === "string") return value;
	if (isRecord(value) && typeof value.message === "string") return value.message;
	return JSON.stringify(value) ?? "unknown backend error";
}

/** A single backend Agent request, never a client tool loop or retrying model transport. */
export function streamJchToolsAgent(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions & { cwd?: string },
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: JCHTOOLS_API,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const parentLogContext = logger.getLogContext();
	const callId = `jchtools-request-${crypto.randomUUID()}`;
	const run = async () => {
		const startedAt = performance.now();
		let stage = "construct_request";
		let terminalResult = "failed";
		let status: number | undefined;
		let httpStartedAt: number | undefined;
		let firstEvent = false;
		let finished = false;
		let done = false;
		let modelIdHash: string | undefined;
		let diagnostic: Record<string, unknown> = {};
		logger.info("JchTools remote request started", {
			component: "jchtools",
			event: "jchtools_request_started",
			stage,
			result: "started",
		});
		let text: TextContent | undefined;
		let textEnded = false;
		const endText = () => {
			if (text && !textEnded) {
				textEnded = true;
				stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: output });
			}
		};
		try {
			if (!isJchToolsAgentModel(model)) throw inputError("model API is not jchtools-agent");
			modelIdHash = new Bun.CryptoHasher("sha256").update(model.id).digest("hex").slice(0, 16);
			if (typeof options?.cwd !== "string" || options.cwd.trim().length === 0) {
				throw inputError("cwd must be an absolute existing directory");
			}
			if (!path.isAbsolute(options.cwd)) throw inputError("cwd must be an absolute existing directory");
			try {
				if (!fs.statSync(options.cwd).isDirectory()) throw inputError("cwd must be an existing directory");
			} catch (error) {
				if (error instanceof AIError.ProviderResponseError) throw error;
				throw inputError("cwd must be an existing directory");
			}
			if (context.tools?.length || context.inactiveTools?.length || options?.toolChoice !== undefined) {
				throw inputError("frontend tools and tool choice are unsupported");
			}
			const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
			for (const system of context.systemPrompt ?? []) {
				if (typeof system !== "string") throw inputError("system content must be text");
				messages.push({ role: "system", content: system });
			}
			for (const message of context.messages) {
				const content = textContent(message);
				if (message.role !== "user" && message.role !== "assistant") throw inputError("unsupported message role");
				messages.push({ role: message.role, content });
			}
			if (!messages.some(message => message.role === "user")) throw inputError("a text user prompt is required");
			const base = new URL(model.baseUrl);
			if (
				base.protocol !== "http:" ||
				base.hostname !== "127.0.0.1" ||
				base.pathname !== "/" ||
				base.search ||
				base.hash ||
				base.username ||
				base.password
			) {
				throw inputError("baseUrl must be the discovered bare local HTTP service root");
			}
			options?.signal?.throwIfAborted();
			stream.push({ type: "start", partial: output });
			stage = "http_request";
			httpStartedAt = performance.now();
			logger.info("JchTools remote HTTP started", {
				component: "jchtools",
				event: "jchtools_request_http_started",
				stage,
				result: "started",
				method: "POST",
				host: "127.0.0.1",
				path: "/v1/chat/completions",
				model_id_hash: modelIdHash,
				message_count: messages.length,
			});
			const response = await fetch(new URL("/v1/chat/completions", base), {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
				body: JSON.stringify({ model: model.id, messages, stream: true, cwd: options.cwd }),
				signal: options.signal,
				redirect: "error",
			});
			status = response.status;
			logger.info("JchTools remote HTTP response", {
				component: "jchtools",
				event: "jchtools_request_http_response",
				stage,
				result: response.ok ? "headers-received" : "http-non2xx",
				status,
				elapsed_ms: performance.now() - httpStartedAt,
			});
			if (!response.ok) {
				stage = "http_error_body";
				const body = await response.text();
				let detail = body;
				try {
					const envelope: unknown = JSON.parse(body);
					if (isRecord(envelope) && envelope.error !== undefined) detail = errorDetail(envelope.error);
				} catch (error) {
					logger.debug("JchTools HTTP error body is not JSON", {
						component: "jchtools",
						event: "jchtools_request_error_body_decode",
						stage,
						result: "JSON",
						...logger.diagnosticError(error),
					});
				}
				throw new AIError.ProviderHttpError(
					`JchTools remote Agent HTTP ${response.status}: ${detail}`,
					response.status,
					{ headers: response.headers },
				);
			}
			stage = "validate_response";
			if (!response.body) throw responseError("response has no body", "empty-body");
			if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
				await response.body.cancel();
				throw responseError("response is not a text/event-stream");
			}
			stage = "read_sse";
			for await (const event of readSseEvents(response.body, options?.signal)) {
				options?.signal?.throwIfAborted();
				if (!firstEvent) {
					firstEvent = true;
					logger.info("JchTools first SSE event", {
						component: "jchtools",
						event: "jchtools_request_first_event",
						stage,
						result: "received",
						elapsed_ms: performance.now() - startedAt,
					});
				}
				stage = "validate_sse";
				if (event.event === "error") {
					stage = "backend_error";
					throw responseError(`backend error: ${event.data}`, "output");
				}
				if (!event.data) {
					stage = "read_sse";
					continue;
				}
				if (event.data === "[DONE]") {
					stage = "done_marker";
					if (!finished) throw responseError("[DONE] arrived without a normal finish_reason");
					done = true;
					logger.info("JchTools DONE marker received", {
						component: "jchtools",
						event: "jchtools_request_done_marker",
						stage,
						result: "received",
						elapsed_ms: performance.now() - startedAt,
					});
					break;
				}
				let chunk: unknown;
				stage = "decode_sse_json";
				try {
					chunk = JSON.parse(event.data);
				} catch (cause) {
					throw responseError(`malformed SSE JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
				}
				stage = "validate_sse";
				if (!isRecord(chunk)) throw responseError("SSE data must be a completion object");
				if (chunk.error !== undefined) {
					stage = "backend_error";
					throw responseError(`backend error: ${errorDetail(chunk.error)}`, "output");
				}
				if (finished) throw responseError("completion data arrived after finish_reason");
				if (!Array.isArray(chunk.choices) || chunk.choices.length !== 1)
					throw responseError("expected exactly one completion choice");
				const choice: unknown = chunk.choices[0];
				if (!isRecord(choice) || choice.index !== 0 || !isRecord(choice.delta))
					throw responseError("malformed completion choice/delta");
				const delta = choice.delta;
				if ("tool_calls" in delta || "function_call" in delta || "tool_calls" in choice || "message" in choice) {
					throw responseError("unexpected frontend tool calls or nonstreaming message");
				}
				if (Object.keys(delta).some(key => key !== "role" && key !== "content"))
					throw responseError("unsupported nontext completion delta");
				if (delta.role !== undefined && delta.role !== "assistant")
					throw responseError("unexpected completion role");
				if (delta.content !== undefined && delta.content !== null && typeof delta.content !== "string")
					throw responseError("completion content must be text");
				if (typeof delta.content === "string" && delta.content.length > 0) {
					if (!text) {
						text = { type: "text", text: "" };
						output.content.push(text);
						output.ttft = performance.now() - startedAt;
						logger.info("JchTools first text received", {
							component: "jchtools",
							event: "jchtools_request_first_text",
							stage: "first_text",
							result: "received",
							elapsed_ms: output.ttft,
						});
						stream.push({ type: "text_start", contentIndex: 0, partial: output });
					}
					text.text += delta.content;
					stream.push({ type: "text_delta", contentIndex: 0, delta: delta.content, partial: output });
				}
				if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
					stage = "finish_marker";
					if (choice.finish_reason !== "stop" && choice.finish_reason !== "length")
						throw responseError(`unexpected finish_reason: ${String(choice.finish_reason)}`, "output");
					output.stopReason = choice.finish_reason;
					finished = true;
					logger.info("JchTools finish marker received", {
						component: "jchtools",
						event: "jchtools_request_finish_marker",
						stage,
						result: "received",
						finish_reason: choice.finish_reason,
						elapsed_ms: performance.now() - startedAt,
					});
				}
				stage = "read_sse";
			}
			stage = "complete_stream";
			options?.signal?.throwIfAborted();
			if (!done) throw responseError("stream ended before finish_reason and [DONE]", "incomplete-stream");
			endText();
			output.duration = performance.now() - startedAt;
			stream.push({ type: "done", reason: output.stopReason === "length" ? "length" : "stop", message: output });
			terminalResult = "success";
		} catch (error) {
			terminalResult = options?.signal?.aborted ? "aborted" : "failed";
			diagnostic = logger.diagnosticError(error);
			endText();
			const result = await AIError.finalize(error, {
				api: JCHTOOLS_API,
				provider: model.provider,
				model: model.id,
				signal: options?.signal,
			});
			output.stopReason = result.stopReason;
			if (result.stopReason === "aborted") terminalResult = "aborted";
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startedAt;
			stream.push({ type: "error", reason: result.stopReason, error: output });
		} finally {
			const fields = {
				component: "jchtools",
				event: "jchtools_request_finished",
				stage,
				result: terminalResult,
				status,
				model_id_hash: modelIdHash,
				first_event_received: firstEvent,
				text_received: !!text,
				finish_marker_received: finished,
				done_marker_received: done,
				finish_reason: output.stopReason,
				elapsed_ms: performance.now() - startedAt,
				...(httpStartedAt === undefined
					? {}
					: {
							method: "POST",
							path: "/v1/chat/completions",
							http_elapsed_ms: performance.now() - httpStartedAt,
						}),
				...diagnostic,
			};
			if (terminalResult === "success") logger.info("JchTools remote request completed", fields);
			else if (terminalResult === "aborted") logger.info("JchTools remote request cancelled", fields);
			else logger.error("JchTools remote request failed", fields);
			stream.end();
		}
	};
	void logger.withLogContext(
		{
			operation_id: parentLogContext.operation_id ?? `jchtools-${crypto.randomUUID()}`,
			request_id: parentLogContext.request_id ?? callId,
			call_id: callId,
			parent_call_id: parentLogContext.call_id,
		},
		run,
	);
	return stream;
}
