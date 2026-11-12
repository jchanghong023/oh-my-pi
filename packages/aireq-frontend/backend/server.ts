import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { ServerWebSocket } from "bun";
import type { ScopeRequest, ScopeResponse, ScopeMessage } from "./transport.js";
import type { AIReqRemoteErrorCode, AIReqRemoteResponse } from "./contract.js";

interface Scope {
	worker: Worker;
	ready: Promise<void>;
	error?: Error;
	pending: Map<string, { resolve(value: ScopeResponse): void; reject(error: Error): void }>;
}
interface SocketData {
	id: string;
	scope: Scope;
	url: string;
}
export interface AIReqBackendServerOptions {
	hostname?: string;
	port?: number;
}
const cors = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};
const demos = new Set([
	"",
	"analysis-scale",
	"review-chat",
	"proposal-feedback",
	"proposal-intake",
	"sr-delivery",
	"requirements-review",
	"proposal-freeze",
	"parallel-admission",
	"ir-acceptance",
	"empty-projects",
	"empty-releases",
	"empty-requirements",
	"missing-requirement",
	"missing-sr",
	"missing-directory",
	"unreadable-directory",
	"wrong-repository",
	"missing-material",
	"material-read-failure",
	"session-read-failure",
	"send-failure",
	"operation-failure",
]);

/** Starts independent HTTP/WebSocket transport; each named fixture owns exactly one worker. */
export function createAIReqBackendServer(options: AIReqBackendServerOptions = {}) {
	const scopes = new Map<string, Scope>();
	const sockets = new Map<string, ServerWebSocket<SocketData>>();
	let disposed = false;
	const getScope = (demo: string): Scope => {
		const existing = scopes.get(demo);
		if (existing) return existing;
		const ready = Promise.withResolvers<void>();
		const worker = new Worker(new URL("./main.ts", import.meta.url), {
			execArgv: [
				"--tsconfig-override",
				fileURLToPath(new URL("./tsconfig.json", import.meta.url)),
				"--preload",
				fileURLToPath(new URL("./register.ts", import.meta.url)),
			],
			env: { ...process.env, OMP_AIREQ_BACKEND_SCOPE: "1", OMP_AIREQ_BACKEND_SCENARIO: demo },
		});
		const scope: Scope = { worker, ready: ready.promise, pending: new Map() };
		scopes.set(demo, scope);
		worker.on("message", (message: ScopeMessage) => {
			if (message.kind === "ready") {
				ready.resolve();
				return;
			}
			if (message.kind === "response") {
				scope.pending.get(message.id)?.resolve(message);
				scope.pending.delete(message.id);
				return;
			}
			const socket = sockets.get(message.id);
			if (message.kind === "send") socket?.send(message.data);
			else socket?.close();
		});
		const failed = (error: Error) => {
			scope.error = error;
			ready.reject(error);
			for (const pending of scope.pending.values()) pending.reject(error);
			scope.pending.clear();
			for (const socket of sockets.values())
				if (socket.data.scope === scope) socket.close(1011, "Backend scenario unavailable");
		};
		worker.on("error", failed);
		worker.on("exit", code => {
			if (!disposed) failed(new Error(`Backend scenario stopped (${code})`));
		});
		return scope;
	};
	const call = async (scope: Scope, request: ScopeRequest): Promise<ScopeResponse> => {
		await scope.ready;
		if (scope.error) throw scope.error;
		const pending = Promise.withResolvers<ScopeResponse>();
		scope.pending.set(request.id, pending);
		scope.worker.postMessage(request);
		return pending.promise;
	};
	const failure = (status: number, code: AIReqRemoteErrorCode, message: string) =>
		Response.json({ ok: false, error: { code, message } } satisfies AIReqRemoteResponse<never>, {
			status,
			headers: cors,
		});
	const server = Bun.serve<SocketData>({
		hostname: options.hostname ?? "127.0.0.1",
		port: options.port ?? 4174,
		async fetch(request, server) {
			if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
			const url = new URL(request.url);
			const route = url.pathname.replace(/\/$/, "");
			const ws = route === "/api/aireq/events" || route === "/api/aireq/services";
			if (!ws && route !== "/api/aireq/bootstrap" && route !== "/api/aireq/call")
				return failure(404, "NOT_FOUND", "Unknown backend route");
			if (route === "/api/aireq/call" ? request.method !== "POST" : request.method !== "GET")
				return failure(405, "METHOD_NOT_ALLOWED", "Unsupported request method");
			const employee = url.searchParams.get("employeeId") ?? "";
			if (employee && !/^[a-z][0-9]{8}$/.test(employee))
				return failure(400, "INVALID_IDENTITY", "Invalid employee identity");
			if (!url.searchParams.get("clientId")) return failure(400, "INVALID_CLIENT", "Missing clientId");
			const demo = url.searchParams.get("demo") ?? "";
			if (!demos.has(demo)) return failure(400, "INVALID_SCENARIO", "Unknown prototype scenario");
			try {
				const scope = getScope(demo);
				await scope.ready;
				if (ws) {
					if (route.endsWith("/services") && !employee)
						return failure(403, "FORBIDDEN", "Sign in before connecting services");
					if (server.upgrade(request, { data: { id: crypto.randomUUID(), scope, url: url.href }, headers: cors }))
						return;
					return failure(400, "INVALID_UPGRADE", "Expected WebSocket upgrade");
				}
				const result = await call(scope, {
					kind: "http",
					id: crypto.randomUUID(),
					url: url.href,
					body: request.method === "POST" ? await request.text() : undefined,
				});
				return Response.json(result.response, { status: result.status, headers: cors });
			} catch (error) {
				return failure(503, "BACKEND_UNAVAILABLE", error instanceof Error ? error.message : "Backend unavailable");
			}
		},
		websocket: {
			open(socket) {
				sockets.set(socket.data.id, socket);
				void call(socket.data.scope, { kind: "open", id: socket.data.id, url: socket.data.url })
					.then(result => {
						if (!result.response.ok) {
							socket.send(JSON.stringify({ type: "error", error: result.response.error }));
							socket.close(1008, result.response.error.message.slice(0, 120));
						}
					})
					.catch(() => socket.close(1011, "Backend unavailable"));
			},
			message(socket, data) {
				socket.data.scope.worker.postMessage({ kind: "message", id: socket.data.id, data } satisfies ScopeRequest);
			},
			close(socket) {
				sockets.delete(socket.data.id);
				socket.data.scope.worker.postMessage({ kind: "close", id: socket.data.id } satisfies ScopeRequest);
			},
		},
	});
	const dispose = async () => {
		if (disposed) return;
		disposed = true;
		for (const socket of sockets.values()) socket.close(1001, "Backend shutting down");
		await server.stop(true);
		await Promise.all(
			[...scopes.values()].map(async scope => {
				try {
					await call(scope, { kind: "shutdown", id: crypto.randomUUID() });
				} catch {
					/* Failed workers are still terminated below. */
				}
			}),
		);
		await Promise.all([...scopes.values()].map(scope => scope.worker.terminate()));
		scopes.clear();
		sockets.clear();
	};
	return { server, hostname: server.hostname, port: server.port, url: server.url, dispose };
}
