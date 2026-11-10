import type { ServerWebSocket } from "bun";
import { VSBuffer } from "../../../../packages/dev-frontend/packages/rpc/src/buffer";
import { ChannelServer } from "../../../../packages/dev-frontend/packages/rpc/src/channelServer";
import {
	Emitter,
	type CancellationToken,
	type Event,
} from "../../../../packages/dev-frontend/packages/rpc/src/foundation";
import {
	HEADER_SIZE,
	ProtocolMessageType,
	SocketProtocol,
	type ISocket,
} from "../../../../packages/dev-frontend/packages/rpc/src/protocol";
import type { BrowserConnection } from "./server";
import type { WebGuiServiceContext } from "./native/rpc-contract";
import { createWebGuiServices, disposeWebGuiServices } from "./native/services";
import { assertDevNativeContext } from "./native/native-session-host";

class DevRpcSocket implements ISocket {
	readonly #data = new Emitter<VSBuffer>();
	readonly #close = new Emitter<void>();
	readonly #end = new Emitter<void>();
	readonly onData = this.#data.event;
	readonly onClose = this.#close.event;
	readonly onEnd = this.#end.event;
	#closed = false;
	#draining: { promise: Promise<void>; resolve: () => void } | undefined;
	constructor(readonly websocket: ServerWebSocket<BrowserConnection>) {}
	accept(bytes: Uint8Array): void {
		if (this.#closed || !bytes.length || bytes.length > 32 * 1024 * 1024)
			throw new Error("Invalid Dev RPC message size");
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let offset = 0;
		while (offset < bytes.length) {
			if (
				bytes.length - offset < HEADER_SIZE ||
				view.getUint8(offset) !== ProtocolMessageType.Regular ||
				view.getUint32(offset + 1) !== 0 ||
				view.getUint32(offset + 5) !== 0
			)
				throw new Error("Invalid Dev RPC frame");
			const size = view.getUint32(offset + 9);
			if (!size || size > bytes.length - offset - HEADER_SIZE) throw new Error("Invalid Dev RPC frame boundary");
			offset += HEADER_SIZE + size;
		}
		this.#data.fire(VSBuffer.wrap(bytes));
	}
	write(buffer: VSBuffer): void {
		if (this.#closed) throw new Error("Dev RPC socket is closed");
		const sent = this.websocket.sendBinary(buffer.buffer);
		if (sent === 0) {
			this.end();
			throw new Error("Dev RPC socket could not send the RPC frame");
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
		this.websocket.close(1000, "Dev native connection ended");
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

export interface DevNativeServices {
	drained(): void;
	message(value: string | Buffer): void;
	close(): Promise<void>;
}

/** A per-browser protocol catalog over actual OMP sessions, not a second native host. */
export function openDevNativeServices(
	socket: ServerWebSocket<BrowserConnection>,
	context: WebGuiServiceContext,
): DevNativeServices {
	const transport = new DevRpcSocket(socket);
	const protocol = new SocketProtocol(transport);
	const services = createWebGuiServices(context);
	const server = new ChannelServer(protocol, context, undefined, true);
	let closed = false;
	let closing: Promise<void> | undefined;
	const calls = new Set<Promise<unknown>>();
	const assertCurrent = () => {
		if (closing || closed) throw new Error("Dev native connection is closing");
		assertDevNativeContext(context);
	};
	try {
		for (const service of services)
			server.registerChannel(service.name, {
				async call<T>(
					ctx: WebGuiServiceContext,
					command: string,
					arg?: unknown,
					token?: CancellationToken,
				): Promise<T> {
					assertCurrent();
					const task = service.call<T>(ctx, command, arg, token);
					calls.add(task);
					try {
						const result = await task;
						assertCurrent();
						return result;
					} finally {
						calls.delete(task);
					}
				},
				listen<T>(ctx: WebGuiServiceContext, event: string, arg?: unknown): Event<T> {
					assertCurrent();
					const source = service.listen<T>(ctx, event, arg);
					return listener =>
						source(frame => {
							try {
								assertCurrent();
								listener(frame);
							} catch {
								socket.close(1008, "Dev object binding changed");
							}
						});
				},
			});
		server.ready();
	} catch (error) {
		disposeWebGuiServices(services);
		server.dispose();
		protocol.dispose();
		transport.dispose();
		throw error;
	}
	return {
		drained(): void {
			transport.drained();
		},
		message(value: string | Buffer): void {
			assertCurrent();
			if (typeof value === "string") throw new Error("Native RPC requires binary frames");
			transport.accept(value);
		},
		close(): Promise<void> {
			if (closed) return Promise.resolve();
			if (!closing) {
				const task = (async () => {
					await Promise.allSettled(calls);
					disposeWebGuiServices(services);
					server.dispose();
					protocol.dispose();
					transport.dispose();
					closed = true;
				})();
				closing = task;
				void task.catch(() => {
					if (closing === task) closing = undefined;
				});
			}
			return closing;
		},
	};
}
