import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import {
  RemoteServiceAccess,
  type RemoteServiceAccessOptions,
} from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface ProtocolConnectionOptions extends RemoteServiceAccessOptions {
  signal?: AbortSignal;
}

export interface WebSocketConnectionOptions extends ProtocolConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
}

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  let disposed = false;

  const handleMessage = (event: MessageEvent<ArrayBuffer>) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(event.data)));
  };
  const handleClose = () => {
    onClose.fire();
    onEnd.fire();
  };

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", handleMessage);
  ws.addEventListener("close", handleClose);
  ws.addEventListener("error", handleClose);

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (!disposed && ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ws.removeEventListener("message", handleMessage);
      ws.removeEventListener("close", handleClose);
      ws.removeEventListener("error", handleClose);
      onData.dispose();
      onClose.dispose();
      onEnd.dispose();
      ws.close();
    },
  };
}

export function connectViaWebSocket(
  wsUrl: string,
  options: WebSocketConnectionOptions = {},
): Promise<IServiceAccessor> {
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason);
  }

  const { promise, resolve, reject } = Promise.withResolvers<IServiceAccessor>();
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch (error) {
    reject(error);
    return promise;
  }

  const lifetime = new AbortController();
  let socket: ISocket | undefined;
  let protocol: SocketProtocol | undefined;
  let settled = false;
  let disposed = false;

  const terminate = (reason: unknown, awaitClose = false) => {
    ws.removeEventListener("open", handleOpen);
    ws.removeEventListener("error", handleError);
    options.signal?.removeEventListener("abort", handleAbort);
    // Keep only the one-shot native close notification while close() completes.
    if (!awaitClose || ws.readyState === WebSocket.CLOSED) {
      ws.removeEventListener("close", handleClose);
    }
    if (disposed) return;
    disposed = true;
    if (!settled) {
      settled = true;
      reject(reason);
    }
    // Abort RPC first: even calls still waiting for Initialize must reject.
    lifetime.abort();
    protocol?.dispose();
    if (socket) socket.dispose();
    else ws.close();
  };

  const handleError = () => {
    terminate(new Error(`WebSocket connection failed: ${wsUrl}`), true);
  };
  const handleClose = (event: CloseEvent) => {
    terminate(
      new Error(
        event.reason
          ? `WebSocket closed before ready: ${event.reason}`
          : `WebSocket closed before ready (${event.code})`,
      ),
    );
    options.onClose?.({
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
  };
  const handleAbort = () => {
    terminate(options.signal?.reason, true);
  };
  const handleOpen = () => {
    ws.removeEventListener("open", handleOpen);
    try {
      socket = wrapBrowserWebSocket(ws);
      protocol = new SocketProtocol(socket);
      const services = connectViaProtocol(protocol, {
        ...options,
        signal: lifetime.signal,
      });
      options.onOpenSocket?.(ws);
      if (disposed) return;
      if (ws.readyState !== WebSocket.OPEN) {
        terminate(new Error("WebSocket closed before ready"), true);
        return;
      }
      settled = true;
      resolve(services);
    } catch (error) {
      terminate(error, true);
    }
  };

  ws.addEventListener("error", handleError);
  ws.addEventListener("close", handleClose, { once: true });
  ws.addEventListener("open", handleOpen, { once: true });
  options.signal?.addEventListener("abort", handleAbort, { once: true });
  // A custom WebSocket constructor may synchronously abort the caller's signal.
  if (options.signal?.aborted) handleAbort();
  return promise;
}

export function connectViaProtocol(
  protocol: IMessagePassingProtocol,
  options: ProtocolConnectionOptions = {},
): IServiceAccessor {
  const client = new ChannelClient(protocol);
  // Lifecycle ownership stays with the caller; dispose also rejects RPC calls
  // queued before Initialize, not only requests already sent to the transport.
  const dispose = () => client.dispose();
  if (options.signal?.aborted) dispose();
  else options.signal?.addEventListener("abort", dispose, { once: true });
  return new RemoteServiceAccess(client, options);
}
