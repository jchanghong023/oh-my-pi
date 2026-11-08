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
import {
	commandEnvelopeSchema,
	commandPayloadSchemas,
} from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/command";
import { ServiceChannels } from "../../../../vendor/zcode-frontend/packages/shared/src/channels";
import type { AgentSession } from "../session/agent-session";
import {
	configureNativeWebGuiHandoffAdmission,
	nativeWebGuiQuestions,
	type NativeWebGuiInteractionOrigin,
} from "./native-interactions";
import { type BrowserProjectRecord, readBrowserProject } from "./project-registry";
import type { WebGuiHandoffBinding, WebGuiServiceContext, WebGuiServiceDefinition } from "./rpc-contract";
import { assertWebGuiNativeAdmission } from "./native-session-host";
import { createWebGuiServices, disposeWebGuiServices } from "./services";

// Match the listener envelope: 20 MiB native attachment bytes expand to about 26.7 MiB in JSON.
const MAX_BINARY_MESSAGE = 32 * 1024 * 1024;
const connections = new Map<string, WebGuiConnection>();

interface ConnectionHandoff extends Omit<WebGuiHandoffBinding, "interactionId"> {
	interactionId?: string;
	projectId: string;
	ownerId: string;
	session: AgentSession;
	expiresAt: number;
	timer: Timer;
	consumed: boolean;
}

/** Native-only admission before a selected root leaves its original WebGUI mode owner. */
export function beginWebGuiConnectionHandoff(
	origin: NativeWebGuiInteractionOrigin,
	session: AgentSession,
): AbortSignal {
	const connection = connections.get(origin.connectionId);
	if (!connection) throw new Error("Originating WebGUI connection is no longer available");
	return connection.beginHandoff(origin, session);
}

/** Installed only on the explicit RPC host; the broker supplies its newly minted opaque ID. */
export function admitWebGuiConnectionHandoffAction(
	origin: NativeWebGuiInteractionOrigin,
	interactionId: string,
	session: AgentSession,
): boolean {
	return connections.get(origin.connectionId)?.admitHandoffAction(origin, interactionId, session) ?? false;
}

/** Retire every old business binding except the single opaque native handoff control drain. */
export function retireWebGuiConnectionsForHandoff(keepConnectionId: string): void {
	for (const [id, connection] of connections) {
		if (id !== keepConnectionId) connection.fail(1001, "Native WebGUI mode has ended");
	}
}

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
	#context: WebGuiServiceContext;
	#handoff?: ConnectionHandoff;

	constructor(readonly websocket: ServerWebSocket<WebGuiSocketData>) {
		this.#socket = new BunRpcSocket(websocket);
		this.#protocol = new SocketProtocol(this.#socket);
		this.#socket.onClose(() => this.dispose());
		const project = websocket.data.project;
		const context: WebGuiServiceContext = {
			connectionId: crypto.randomUUID(),
			projectId: project?.projectId,
			workspacePath: project?.root ?? websocket.data.workspacePath,
			nativeSession: project?.nativeSession,
			signal: this.#abort.signal,
		};
		this.#context = context;
		connections.set(context.connectionId, this);
		try {
			this.#services = createWebGuiServices(context);
			this.#server = new ChannelServer(this.#protocol, context, undefined, true);
			const connection = this;
			for (const service of this.#services) {
				this.#server.registerChannel(service.name, {
					async call<T>(
						ctx: WebGuiServiceContext,
						command: string,
						arg?: unknown,
						cancellationToken?: CancellationToken,
					): Promise<T> {
						if (service.name === ServiceChannels.FileWatcher && command === "watch")
							assertWebGuiNativeAdmission();
						let handoff: ConnectionHandoff | undefined;
						try {
							assertProjectOwner(project);
						} catch (error) {
							handoff = connection.#claimHandoff(service.name, command, arg);
							if (!handoff) throw error;
						}
						try {
							const result = await service.call<T>(ctx, command, arg, cancellationToken);
							if (handoff) setTimeout(() => connection.fail(1000, "Native mode handoff acknowledged"), 0);
							return result;
						} catch (error) {
							if (handoff) handoff.consumed = false;
							throw error;
						}
					},
					listen<T>(ctx: WebGuiServiceContext, event: string, arg?: unknown): Event<T> {
						assertProjectOwner(project);
						assertWebGuiNativeAdmission();
						const source = service.listen<T>(ctx, event, arg);
						return listener =>
							source(frame => {
								let active = true;
								try {
									assertProjectOwner(project);
								} catch {
									active = false;
								}
								if (active) {
									listener(frame);
									return;
								}
								const handoff = connection.#activeHandoff();
								if (
									!handoff?.interactionId ||
									service.name !== "zcode-agent" ||
									event !== "onDynamicConversationFrame"
								)
									return;
								const drained = service.drainHandoffFrame?.(arg, frame, {
									connectionId: handoff.connectionId,
									clientId: handoff.clientId,
									sessionId: handoff.sessionId,
									interactionId: handoff.interactionId,
								});
								if (drained !== undefined) listener(drained as T);
							});
					},
				});
			}
			this.#server.ready();
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	beginHandoff(origin: NativeWebGuiInteractionOrigin, session: AgentSession): AbortSignal {
		assertProjectOwner(this.websocket.data.project);
		const project = this.websocket.data.project;
		const live = project ? readBrowserProject(project.projectId) : null;
		if (
			this.#disposed ||
			this.#handoff ||
			!project ||
			!live?.nativeSessions?.has(session) ||
			(origin.sessionId !== undefined && origin.sessionId !== session.sessionId)
		)
			throw new Error("Native handoff does not belong to this WebGUI connection");
		const timer = setTimeout(() => this.fail(1008, "Native mode handoff expired"), 30_000);
		this.#handoff = {
			connectionId: this.#context.connectionId,
			clientId: origin.clientId,
			sessionId: session.sessionId,
			projectId: project.projectId,
			ownerId: project.ownerId,
			session,
			expiresAt: Date.now() + 30_000,
			timer,
			consumed: false,
		};
		return this.#abort.signal;
	}

	admitHandoffAction(origin: NativeWebGuiInteractionOrigin, interactionId: string, session: AgentSession): boolean {
		const handoff = this.#activeHandoff();
		if (
			!handoff ||
			handoff.interactionId ||
			!interactionId ||
			handoff.session !== session ||
			handoff.clientId !== origin.clientId ||
			handoff.sessionId !== origin.sessionId
		)
			return false;
		handoff.interactionId = interactionId;
		return true;
	}

	#activeHandoff(): ConnectionHandoff | undefined {
		const handoff = this.#handoff;
		if (
			!handoff ||
			this.#disposed ||
			handoff.consumed ||
			Date.now() >= handoff.expiresAt ||
			readBrowserProject(handoff.projectId)?.ownerId !== handoff.ownerId
		)
			return undefined;
		return handoff;
	}

	#claimHandoff(service: string, command: string, arg: unknown): ConnectionHandoff | undefined {
		const handoff = this.#activeHandoff();
		if (
			!handoff?.interactionId ||
			service !== "zcode-agent" ||
			command !== "sendConversationCommandV4" ||
			!arg ||
			typeof arg !== "object" ||
			!("envelope" in arg)
		)
			return undefined;
		const envelope = commandEnvelopeSchema.safeParse(arg.envelope);
		if (
			!envelope.success ||
			envelope.data.type !== "resolveInteraction" ||
			envelope.data.sessionId !== handoff.sessionId ||
			envelope.data.clientId !== handoff.clientId
		)
			return undefined;
		const payload = commandPayloadSchemas.resolveInteraction.safeParse(envelope.data.payload);
		if (!payload.success || payload.data.interactionId !== handoff.interactionId) return undefined;
		if (
			!nativeWebGuiQuestions(handoff.session)
				.pendingInteractionsFor({
					connectionId: handoff.connectionId,
					clientId: handoff.clientId,
				})
				.some(interaction => interaction.interactionId === handoff.interactionId)
		)
			return undefined;
		handoff.consumed = true;
		return handoff;
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
			const handoff = this.#handoff;
			const draining =
				handoff &&
				Date.now() < handoff.expiresAt &&
				readBrowserProject(handoff.projectId)?.ownerId === handoff.ownerId;
			if (!draining) assertProjectOwner(this.websocket.data.project);
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
		if (this.#handoff) clearTimeout(this.#handoff.timer);
		connections.delete(this.#context.connectionId);
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
	#restoreHandoffAdmission?: () => void;
	readonly websocket: WebSocketHandler<WebGuiSocketData> = {
		maxPayloadLength: MAX_BINARY_MESSAGE,
		backpressureLimit: MAX_BINARY_MESSAGE,
		closeOnBackpressureLimit: true,
		perMessageDeflate: false,
		open: socket => {
			if (this.#disposed) return socket.close(1001, "WebGUI server is stopping");
			this.#restoreHandoffAdmission ??= configureNativeWebGuiHandoffAdmission(admitWebGuiConnectionHandoffAction);
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
		this.#restoreHandoffAdmission?.();
		for (const socket of this.#sockets) socket.data.connection?.fail(1001, "WebGUI server is stopping");
		this.#sockets.clear();
	}
}
