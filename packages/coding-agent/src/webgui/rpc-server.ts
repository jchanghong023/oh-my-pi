import { logger } from "@oh-my-pi/pi-utils";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { VSBuffer } from "../../../../vendor/zcode-frontend/packages/rpc/src/buffer";
import { ChannelServer } from "../../../../vendor/zcode-frontend/packages/rpc/src/channelServer";
import {
	type CancellationToken,
	Emitter,
	type Event,
} from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import {
	HEADER_SIZE,
	type ISocket,
	ProtocolMessageType,
	SocketProtocol,
} from "../../../../vendor/zcode-frontend/packages/rpc/src/protocol";
import { type BrowserProjectRecord, readBrowserProject } from "./project-registry";
import type { WebGuiServiceContext, WebGuiServiceDefinition } from "./rpc-contract";
import { createWebGuiServices, disposeWebGuiServices } from "./services";

const MAX_BINARY_MESSAGE = 16 * 1024 * 1024;

export class WebGuiRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "WebGuiRequestError";
	}
}

/** Absence is unbound; a stale explicit selection must never select another project. */
export async function resolveWebGuiProject(url: URL): Promise<BrowserProjectRecord | undefined> {
	const ids = url.searchParams.getAll("project");
	if (ids.length === 0) return undefined;
	if (ids.length !== 1 || !ids[0]) throw new WebGuiRequestError(404, "Project not found");
	const project = readBrowserProject(ids[0]);
	if (!project) throw new WebGuiRequestError(404, "Project not found");
	if (project.mode !== "webgui" || project.phase !== "active")
		throw new WebGuiRequestError(409, "Project is not active in WebGUI mode");
	return project;
}

function assertProjectOwner(project: BrowserProjectRecord | undefined): void {
	if (!project) return;
	const live = readBrowserProject(project.projectId);
	if (!live || live.ownerId !== project.ownerId || live.root !== project.root)
		throw new WebGuiRequestError(404, "Project ownership has ended");
	if (live.mode !== "webgui" || live.phase !== "active")
		throw new WebGuiRequestError(409, "Project is no longer active in WebGUI mode");
}

export interface WebGuiSocketData {
	readonly kind: "webgui";
	readonly project?: BrowserProjectRecord;
	/** Display context only; project ownership is carried exclusively by project. */
	readonly workspacePath: string;
	connection?: WebGuiConnection;
}

class BunRpcSocket implements ISocket {
	#data = new Emitter<VSBuffer>();
	#close = new Emitter<void>();
	#end = new Emitter<void>();
	#closed = false;
	#draining: { promise: Promise<void>; resolve: () => void } | undefined;
	readonly onData = this.#data.event;
	readonly onClose = this.#close.event;
	readonly onEnd = this.#end.event;

	constructor(readonly websocket: ServerWebSocket<WebGuiSocketData>) {}

	accept(bytes: Uint8Array): void {
		if (!this.#closed) this.#data.fire(VSBuffer.wrap(bytes));
	}

	write(buffer: VSBuffer): void {
		if (this.#closed) throw new Error("WebGUI socket is closed");
		const sent = this.websocket.sendBinary(buffer.buffer);
		if (sent === 0) {
			this.end();
			throw new Error("WebGUI socket could not send the RPC frame");
		}
		if (sent === -1) this.#draining ??= Promise.withResolvers<void>();
	}

	drained(): void {
		this.#draining?.resolve();
		this.#draining = undefined;
	}

	drain(): Promise<void> {
		return this.#draining?.promise ?? Promise.resolve();
	}

	end(): void {
		if (this.#closed) return;
		this.#end.fire();
		this.websocket.close(1000, "WebGUI connection closed");
		this.dispose();
	}

	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.drained();
		this.#close.fire();
		this.#data.dispose();
		this.#close.dispose();
		this.#end.dispose();
	}
}

/** Checks the WebSocket binary boundary, leaving all RPC serialization to the copied stack. */
function validateBinaryMessage(bytes: Uint8Array): void {
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_BINARY_MESSAGE)
		throw new Error("Invalid WebGUI binary message size");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 0;
	while (offset < bytes.byteLength) {
		if (
			bytes.byteLength - offset < HEADER_SIZE ||
			view.getUint8(offset) !== ProtocolMessageType.Regular ||
			view.getUint32(offset + 1) !== 0 ||
			view.getUint32(offset + 5) !== 0
		)
			throw new Error("Invalid WebGUI SocketProtocol frame header");
		const length = view.getUint32(offset + 9);
		if (length === 0 || length > bytes.byteLength - offset - HEADER_SIZE)
			throw new Error("Invalid WebGUI SocketProtocol frame boundary");
		offset += HEADER_SIZE + length;
	}
}

class WebGuiConnection {
	#abort = new AbortController();
	#socket: BunRpcSocket;
	#protocol: SocketProtocol;
	#server: ChannelServer<WebGuiServiceContext> | undefined;
	#services: readonly WebGuiServiceDefinition[] = [];
	#disposed = false;

	constructor(readonly websocket: ServerWebSocket<WebGuiSocketData>) {
		this.#socket = new BunRpcSocket(websocket);
		this.#protocol = new SocketProtocol(this.#socket);
		this.#socket.onClose(() => this.dispose());
		const project = websocket.data.project;
		const context: WebGuiServiceContext = {
			connectionId: crypto.randomUUID(),
			projectId: project?.projectId,
			workspacePath: project?.root ?? websocket.data.workspacePath,
			signal: this.#abort.signal,
		};
		try {
			this.#services = createWebGuiServices(context);
			this.#server = new ChannelServer(this.#protocol, context, undefined, true);
			for (const service of this.#services) {
				this.#server.registerChannel(service.name, {
					async call<T>(
						ctx: WebGuiServiceContext,
						command: string,
						arg?: unknown,
						cancellationToken?: CancellationToken,
					): Promise<T> {
						assertProjectOwner(project);
						return service.call<T>(ctx, command, arg, cancellationToken);
					},
					listen<T>(ctx: WebGuiServiceContext, event: string, arg?: unknown): Event<T> {
						assertProjectOwner(project);
						return service.listen<T>(ctx, event, arg);
					},
				});
			}
			this.#server.ready();
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	receive(message: string | Uint8Array): void {
		if (this.#disposed) return;
		if (typeof message === "string") {
			this.fail(1003, "Binary RPC messages required");
			return;
		}
		try {
			validateBinaryMessage(message);
		} catch (error) {
			logger.warn("WebGUI rejected an invalid RPC frame", { error: String(error) });
			this.fail(1002, "Invalid binary RPC frame");
			return;
		}
		try {
			assertProjectOwner(this.websocket.data.project);
			this.#socket.accept(message);
		} catch (error) {
			logger.warn("WebGUI RPC connection ended", { error: String(error) });
			this.fail(error instanceof WebGuiRequestError ? 1008 : 1002, "RPC connection unavailable");
		}
	}

	drained(): void {
		this.#socket.drained();
	}

	fail(code: number, reason: string): void {
		this.websocket.close(code, reason);
		this.dispose();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#abort.abort();
		this.#server?.dispose();
		disposeWebGuiServices(this.#services);
		this.#protocol.dispose();
		this.#socket.dispose();
	}
}

export class WebGuiRpcHost {
	#sockets = new Set<ServerWebSocket<WebGuiSocketData>>();
	#disposed = false;
	readonly websocket: WebSocketHandler<WebGuiSocketData> = {
		maxPayloadLength: MAX_BINARY_MESSAGE,
		backpressureLimit: MAX_BINARY_MESSAGE,
		closeOnBackpressureLimit: true,
		perMessageDeflate: false,
		open: socket => {
			if (this.#disposed) return socket.close(1001, "WebGUI server is stopping");
			this.#sockets.add(socket);
			try {
				assertProjectOwner(socket.data.project);
				socket.data.connection = new WebGuiConnection(socket);
			} catch (error) {
				logger.warn("WebGUI RPC initialization failed", { error: String(error) });
				this.#sockets.delete(socket);
				socket.close(1011, "RPC initialization failed");
			}
		},
		message: (socket, message) => socket.data.connection?.receive(message),
		drain: socket => socket.data.connection?.drained(),
		close: socket => {
			socket.data.connection?.dispose();
			socket.data.connection = undefined;
			this.#sockets.delete(socket);
		},
	};

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const socket of this.#sockets) socket.data.connection?.fail(1001, "WebGUI server is stopping");
		this.#sockets.clear();
	}
}
