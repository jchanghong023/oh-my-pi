import * as fs from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import * as path from "node:path";
import { getAgentDir, getLogsDir, logger } from "@oh-my-pi/pi-utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { discoverJchTools, discoverJchToolsModels } from "../../src/config/jchtools-discovery";
import { JCHTOOLS_API, streamJchToolsAgent } from "../../src/config/jchtools-provider";
import { Settings } from "../../src/config/settings";
import { DocsService } from "../../src/docs/service";
import {
	type PendingExtensionRequest,
	type RpcExtensionUIResponse,
	RpcPendingExtensionRequests,
	requestRpcDialog,
	requestRpcEditor,
} from "../../src/modes/rpc/rpc-mode";
import { WikiTool } from "../../src/tools/wiki";

const [mode, root, canary] = process.argv.slice(2);
if (!root || !canary || !process.env.OMP_CONFIG_ROOT) throw new Error("Expected an isolated diagnostic fixture");

async function docsProbe() {
	const service = new DocsService({ agentDir: getAgentDir(), cwd: root });
	try {
		if (mode === "wiki") {
			const tool = new WikiTool({
				cwd: root,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => null,
			});
			const result = await tool.execute("diagnostic-wiki", { query: `${canary}QUERY` });
			return {
				indexes: service.list(),
				text: result.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
			};
		}
		const documents = path.join(root, "interrupted-documents");
		fs.mkdirSync(documents);
		fs.writeFileSync(path.join(documents, "first.md"), `# Evidence\n${canary}ROLLBACKBODY\n`);
		fs.writeFileSync(path.join(documents, "second.md"), `# Evidence\n${canary}ROLLBACKBODY\n`);
		const before = service.list();
		const controller = new AbortController();
		let visibleDuringBuild: unknown;
		let failure: string | undefined;
		try {
			await service.init(documents, `${canary}${mode}`, {
				signal: controller.signal,
				onProgress(progress) {
					if (progress.phase !== "fts" || progress.completed !== 1) return;
					visibleDuringBuild = service.list();
					if (mode === "cancel") controller.abort();
					else {
						// Remove only the unread file, after one real FTS commit, without relying on scan order.
						for (const name of fs.readdirSync(documents)) {
							if (name !== progress.currentPath) fs.unlinkSync(path.join(documents, name));
						}
					}
				},
			});
		} catch (error) {
			failure = error instanceof Error ? error.name : typeof error;
		}
		const hidden = service.storage.db
			.query("SELECT COUNT(*) AS count FROM doc_indexes WHERE name GLOB '__building__*'")
			.get();
		return { before, visibleDuringBuild, after: service.list(), hidden, failure };
	} finally {
		service.close();
	}
}

async function transportProbe() {
	const cleanups: Array<() => void | Promise<void>> = [];
	const requests: Array<{ method: string; path: string; authorization: string | null; credential: string | null }> =
		[];
	const pair = Promise.withResolvers<void>();
	let pairArrived = 0;
	const frame = (text: string) =>
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				authorization: request.headers.get("authorization"),
				credential: request.headers.get("x-api-key"),
			});
			if (request.method === "GET") {
				return new Response(`${canary}MODELSBODY`, {
					status: 503,
					headers: { "x-diagnostic-secret": `${canary}HEADER` },
				});
			}
			const body = (await request.json()) as { messages: Array<{ content: string }> };
			const prompt = body.messages.at(-1)?.content ?? "";
			if (!prompt.endsWith("cancel")) {
				if (++pairArrived === 2) pair.resolve();
				await pair.promise;
			}
			if (prompt.endsWith("http503")) {
				return Response.json(
					{ error: { message: `${canary}ERRORBODY` } },
					{ status: 503, headers: { "x-diagnostic-secret": `${canary}HEADER` } },
				);
			}
			if (prompt.endsWith("cancel")) {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(frame(`${canary}PARTIAL`)));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return new Response(frame(`${canary}PARTIAL`) + 'data: {"choices":', {
				headers: { "content-type": "text/event-stream", "x-diagnostic-secret": `${canary}HEADER` },
			});
		},
	});
	cleanups.push(() => server.stop(true));
	function pipePath(label: string) {
		return process.platform === "win32"
			? `\\\\.\\pipe\\omp-diagnostic-${label}-${crypto.randomUUID()}`
			: path.join(root, `${label}.sock`);
	}
	function framed(payload: string) {
		const bytes = Buffer.from(payload);
		const output = Buffer.alloc(4 + bytes.length);
		output.writeUInt32LE(bytes.length);
		bytes.copy(output, 4);
		return output;
	}
	const ipcRequests: unknown[] = [];
	async function peer(label: string, reply: Buffer) {
		const endpoint = pipePath(label);
		const sockets = new Set<Socket>();
		const listener = createServer(socket => {
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
			let received = Buffer.alloc(0);
			let answered = false;
			socket.on("data", chunk => {
				if (answered) return;
				received = Buffer.concat([received, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
				if (received.length < 4 || received.length < 4 + received.readUInt32LE()) return;
				answered = true;
				ipcRequests.push(JSON.parse(received.subarray(4).toString()));
				socket.end(reply);
			});
		});
		await new Promise<void>((resolve, reject) => {
			listener.once("error", reject);
			listener.listen(endpoint, resolve);
		});
		cleanups.push(async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => listener.close(() => resolve()));
		});
		return endpoint;
	}
	try {
		const oversized = Buffer.alloc(4);
		oversized.writeUInt32LE(1024 * 1024 + 1);
		const [malformedPath, oversizedPath, modelsPath] = await Promise.all([
			peer("malformed", framed(`${canary}MALFORMED`)),
			peer("oversized", oversized),
			peer(
				"models",
				framed(
					JSON.stringify({
						protocol: 1,
						pid: process.pid,
						result: {
							Ok: {
								protocol_version: 1,
								service_id: "jchtools-acp-http",
								instance_id: "12345678-1234-4234-8234-123456789abc",
								phase: "ready",
								base_url: server.url.origin,
								execution_mode: "server_agent",
								capabilities: { text: true, streaming: true, client_tools: false, server_tools: true },
							},
						},
					}),
				),
			),
		]);
		const cancelled = new AbortController();
		cancelled.abort();
		const discoveryOptions = { env: {}, timeoutMs: 5000 };
		const discovery = await Promise.all([
			discoverJchTools({ ...discoveryOptions, pipePath: pipePath("absent") }),
			discoverJchTools({ ...discoveryOptions, pipePath: malformedPath }),
			discoverJchTools({ ...discoveryOptions, pipePath: oversizedPath }),
			discoverJchTools({ ...discoveryOptions, pipePath: pipePath("cancelled"), signal: cancelled.signal }),
			discoverJchToolsModels({ ...discoveryOptions, pipePath: modelsPath }),
		]);
		const model = buildModel({
			id: "backend/actual-agent",
			name: "Diagnostic fixture",
			api: JCHTOOLS_API,
			provider: "jchtools",
			baseUrl: server.url.origin,
			reasoning: false,
			supportsTools: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 4096,
		});
		async function consume(kind: string) {
			const controller = new AbortController();
			const stream = streamJchToolsAgent(
				{
					...model,
					baseUrl: kind === "url-query" ? `${server.url.origin}/?secret=${canary}URLQUERY` : model.baseUrl,
					headers: { Authorization: `${canary}AUTHORIZATION`, "x-api-key": `${canary}CREDENTIAL` },
				},
				{
					systemPrompt: [`${canary}SYSTEM`],
					messages: [{ role: "user", content: `${canary}PROMPT ${kind}`, timestamp: 1 }],
				},
				{ signal: controller.signal, apiKey: `${canary}APIKEY` },
			);
			const events: string[] = [];
			for await (const event of stream) {
				events.push(event.type);
				if (kind === "cancel" && event.type === "text_delta") controller.abort();
			}
			const result = await stream.result();
			return {
				kind,
				events,
				stopReason: result.stopReason,
				errorStatus: result.errorStatus,
				errorMessage: result.errorMessage,
				content: result.content,
			};
		}
		const remote = await Promise.all([
			consume("http503"),
			consume("truncated"),
			consume("cancel"),
			consume("url-query"),
		]);
		return { discovery: discovery.map(value => value ?? null), remote, requests, ipcRequests };
	} finally {
		pair.resolve();
		for (const cleanup of cleanups.reverse()) await cleanup();
	}
}

async function boundariesProbe() {
	const service = new DocsService({ agentDir: getAgentDir(), cwd: root });
	let listFailure: string | undefined;
	try {
		service.list();
		service.storage.db.exec("DROP TABLE doc_indexes");
		try {
			service.list();
		} catch (error) {
			listFailure = error instanceof Error ? error.name : typeof error;
		}
	} finally {
		service.close();
	}
	const dialogs: Array<{ kind: string; value?: string; failure?: string; pending: number; methods: unknown[] }> = [];
	for (const kind of ["responded", "cancelled", "timed_out", "aborted", "failed", "disconnected", "editor_aborted"]) {
		const pending = new RpcPendingExtensionRequests();
		const controller = new AbortController();
		const methods: unknown[] = [];
		let saved: PendingExtensionRequest | undefined;
		let id: string | undefined;
		const output = (frame: object) => {
			const request = frame as { id: string; method: string };
			methods.push(request.method);
			if (request.method === "cancel") return;
			id = request.id;
			saved = pending.get(request.id);
			queueMicrotask(() =>
				logger.withLogContext({ operation_id: "boundary-control", request_id: "control-response" }, () => {
					if (kind === "responded" || kind === "failed") {
						saved?.resolve({ type: "extension_ui_response", id: request.id, value: `${canary}ANSWER` });
					} else if (kind === "cancelled") {
						saved?.resolve({ type: "extension_ui_response", id: request.id, cancelled: true });
					} else if (kind === "disconnected") {
						pending.rejectAll(`${canary}DISCONNECTED`);
					} else if (kind === "aborted" || kind === "editor_aborted") controller.abort();
				}),
			);
		};
		const options = { signal: controller.signal, ...(kind === "timed_out" ? { timeout: 1 } : {}) };
		const promise = logger.withLogContext({ operation_id: "boundary-parent", request_id: "dialog-command" }, () =>
			kind === "editor_aborted"
				? requestRpcEditor(pending, output, `${canary}TITLE`, `${canary}PREFILL`, options)
				: requestRpcDialog<string | undefined>(
						pending,
						output,
						options,
						undefined,
						{ method: "input", title: `${canary}TITLE`, placeholder: `${canary}PLACEHOLDER` },
						(response: RpcExtensionUIResponse) => {
							if (kind === "failed") throw new Error(`${canary}PARSEFAILURE`);
							return "value" in response ? response.value : undefined;
						},
					),
		);
		let value: string | undefined;
		let failure: string | undefined;
		try {
			value = await promise;
		} catch (error) {
			failure = error instanceof Error ? error.name : typeof error;
		}
		// Stale host answers may still hold the old resolver after local settlement.
		if (id && saved) saved.resolve({ type: "extension_ui_response", id, value: `${canary}LATEANSWER` });
		dialogs.push({ kind, value, failure, pending: pending.size, methods });
	}
	return { listFailure, dialogs };
}

const result =
	mode === "transport" ? await transportProbe() : mode === "boundaries" ? await boundariesProbe() : await docsProbe();
process.stdout.write(JSON.stringify({ logsDir: getLogsDir(), pid: process.pid, ...result }));
