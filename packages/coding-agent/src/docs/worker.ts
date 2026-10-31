import { logger } from "@oh-my-pi/pi-utils";
import { DocsSearchEngine } from "./engine";
import type { DocsWorkerInbound, DocsWorkerLogContext, DocsWorkerTransport } from "./worker-protocol";

function safeLogContext(context: DocsWorkerLogContext): Record<string, string> {
	const safe: Record<string, string> = {};
	for (const key of ["operation_id", "call_id", "parent_call_id"] as const) {
		const value = context?.[key];
		if (typeof value === "string" && /^[\w.:-]{1,160}$/.test(value)) safe[key] = value;
	}
	return safe;
}

/** SQLite opening, migration, ranking and materialization run only in this owned child. */
export function startDocsWorker(transport: DocsWorkerTransport): void {
	let engine: DocsSearchEngine | undefined;
	let busy = false;
	let active: { id: string; controller: AbortController } | undefined;
	const send: DocsWorkerTransport["send"] = message => {
		// Owned workers are killed after replies; persist buffered diagnostics first.
		logger.flush();
		transport.send(message);
	};
	const handle = async (
		message: Exclude<DocsWorkerInbound, { type: "cancel" }>,
		signal: AbortSignal,
	): Promise<void> => {
		const started = performance.now();
		try {
			if (message.type === "configure") {
				if (engine) throw new Error("Document worker is already configured");
				engine = new DocsSearchEngine({ ...message.options, cursorPath: message.cursorPath });
				send({
					type: "result",
					id: message.id,
					command: "configure",
					value: undefined,
					engine_ms: performance.now() - started,
				});
				return;
			}
			if (!engine) throw new Error("Document worker is not configured");
			switch (message.type) {
				case "list":
					send({
						type: "result",
						id: message.id,
						command: "list",
						value: engine.list(),
						engine_ms: performance.now() - started,
					});
					break;
				case "init": {
					const value = await engine.init(message.directory, message.name, {
						signal,
						onProgress: progress => send({ type: "progress", id: message.id, progress }),
					});
					send({
						type: "result",
						id: message.id,
						command: "init",
						value,
						engine_ms: performance.now() - started,
					});
					break;
				}
				case "remove":
					engine.remove(message.name);
					send({
						type: "result",
						id: message.id,
						command: "remove",
						value: undefined,
						engine_ms: performance.now() - started,
					});
					break;
				case "searchWindow":
					send({
						type: "result",
						id: message.id,
						command: "searchWindow",
						value: await engine.searchWindowAsync(message.query, message.options, signal),
						engine_ms: performance.now() - started,
					});
					break;
			}
		} catch (error) {
			send({
				type: "error",
				id: message.id,
				error: {
					name: error instanceof Error ? error.name : "Error",
					message: error instanceof Error ? error.message : String(error),
					...(error instanceof Error && "code" in error && typeof error.code === "string"
						? { code: error.code }
						: {}),
				},
				engine_ms: performance.now() - started,
			});
		} finally {
			active = undefined;
			busy = false;
		}
	};
	transport.onMessage(message => {
		if (message.type === "cancel") {
			if (active?.id === message.id) active.controller.abort();
			return;
		}
		if (busy) {
			send({
				type: "error",
				id: message.id,
				error: { name: "Error", message: "Document worker received overlapping requests" },
				engine_ms: 0,
			});
			return;
		}
		busy = true;
		const controller = new AbortController();
		active = { id: message.id, controller };
		void logger.withLogContext(safeLogContext(message.context), () => handle(message, controller.signal));
	});
}
