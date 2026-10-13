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
	const handle = async (message: DocsWorkerInbound): Promise<void> => {
		const started = performance.now();
		try {
			if (message.type === "configure") {
				if (engine) throw new Error("Document worker is already configured");
				engine = new DocsSearchEngine({ ...message.options, cursorPath: message.databasePath });
				transport.send({
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
					transport.send({
						type: "result",
						id: message.id,
						command: "list",
						value: engine.list(),
						engine_ms: performance.now() - started,
					});
					break;
				case "init": {
					const value = await engine.init(message.directory, message.name, {
						onProgress: progress => transport.send({ type: "progress", id: message.id, progress }),
					});
					transport.send({
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
					transport.send({
						type: "result",
						id: message.id,
						command: "remove",
						value: undefined,
						engine_ms: performance.now() - started,
					});
					break;
				case "searchWindow":
					transport.send({
						type: "result",
						id: message.id,
						command: "searchWindow",
						value: engine.searchWindow(message.query, message.options),
						engine_ms: performance.now() - started,
					});
					break;
			}
		} catch (error) {
			transport.send({
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
			busy = false;
		}
	};
	transport.onMessage(message => {
		if (busy) {
			transport.send({
				type: "error",
				id: message.id,
				error: { name: "Error", message: "Document worker received overlapping requests" },
				engine_ms: 0,
			});
			return;
		}
		busy = true;
		void logger.withLogContext(safeLogContext(message.context), () => handle(message));
	});
}
