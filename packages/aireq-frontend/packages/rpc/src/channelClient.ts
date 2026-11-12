import { VSBuffer } from "./buffer.js";
import { CancellationToken, Event, Emitter, type IDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannel,
  type IChannelClient,
  type IHandler,
  type IRawResponse,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

enum State {
  Uninitialized,
  Idle,
}

export class ChannelClient implements IChannelClient, IDisposable {
  private state = State.Uninitialized;
  private isDisposed = false;
  private activeRequests = new Set<IDisposable>();
  private handlers = new Map<number, IHandler>();
  // Promise 请求和事件监听共用 handlers，但只有前者需要在连接终结时 reject。
  // 单独维护 reject map，避免 dispose 把事件订阅误当成挂起的 RPC 请求。
  private pendingRejections = new Map<number, (error: Error) => void>();
  #pendingPromises = new Set<Promise<unknown>>();
  private lastRequestId = 0;
  private protocolListener: IDisposable | null;

  private readonly _onDidInitialize = new Emitter<void>();
  readonly onDidInitialize = this._onDidInitialize.event;

  constructor(private protocol: IMessagePassingProtocol) {
    this.protocolListener = this.protocol.onMessage((msg) => this.onBuffer(msg));
  }

  getChannel<T extends IChannel>(channelName: string): T {
    return {
      call: (command: string, arg?: any, cancellationToken?: CancellationToken) => {
        if (this.isDisposed) {
          return Promise.reject(new Error("ChannelClient is disposed"));
        }
        return this.requestPromise(channelName, command, arg, cancellationToken);
      },
      listen: (event: string, arg?: any) => {
        if (this.isDisposed) {
          return Event.None;
        }
        return this.requestEvent(channelName, event, arg);
      },
    } as T;
  }

  private requestPromise(
    channelName: string,
    name: string,
    arg?: any,
    cancellationToken = CancellationToken.None,
  ): Promise<any> {
    const id = this.lastRequestId++;

    if (cancellationToken.isCancellationRequested) {
      return Promise.reject(new Error("Cancelled"));
    }

    const { promise: result, resolve, reject } = Promise.withResolvers<any>();
    this.pendingRejections.set(id, reject);
    const doRequest = () => {
      // dispose/cancel before Initialize must not send an already rejected request.
      if (this.isDisposed || !this.pendingRejections.has(id)) {
        return;
      }

      const handler: IHandler = (response) => {
        switch (response.type) {
          case ResponseType.PromiseSuccess:
            this.handlers.delete(id);
            this.pendingRejections.delete(id);
            resolve(response.data);
            return;
          case ResponseType.PromiseError: {
            this.handlers.delete(id);
            this.pendingRejections.delete(id);
            const error = new Error(response.data.message) as Error & Record<string, unknown>;
            error.name = response.data.name;
            if (response.data.stack) {
              error.stack = response.data.stack.join("\n");
            }
            const passthroughKeys = [
              "code",
              "kind",
              "status",
              "retryAfterMs",
              "data",
              "detail",
              "details",
              "taskId",
              "traceId",
              "retryable",
              "profileId",
            ] as const;
            for (const key of passthroughKeys) {
              const value = response.data[key];
              if (value !== undefined) {
                error[key] = value;
              }
            }
            reject(error);
            return;
          }
          case ResponseType.PromiseErrorObj:
            this.handlers.delete(id);
            this.pendingRejections.delete(id);
            reject(response.data);
            return;
        }
      };

      this.handlers.set(id, handler);
      this.sendRequest(RequestType.Promise, id, channelName, name, arg);
    };

    const disposable = cancellationToken.onCancellationRequested(() => {
      if (!this.pendingRejections.has(id)) {
        return;
      }
      this.sendCancelOrDispose(RequestType.PromiseCancel, id);
      this.handlers.delete(id);
      this.pendingRejections.delete(id);
      reject(new Error("Cancelled"));
    });
    this.activeRequests.add(disposable);

    if (this.state === State.Idle) {
      doRequest();
    } else {
      this.whenInitialized().then(doRequest);
    }

    this.#pendingPromises.add(result);
    const settled = () => { this.#pendingPromises.delete(result); };
    void result.then(settled, settled);
    return result.finally(() => {
      disposable?.dispose();
      if (disposable) {
        this.activeRequests.delete(disposable);
      }
    });
  }

  private requestEvent(channelName: string, name: string, arg?: any): Event<any> {
    let subscriptionId: number | undefined;
    const emitter = new Emitter<any>({
      onWillAddFirstListener: () => {
        if (this.isDisposed) {
          return;
        }
        const id = this.lastRequestId++;
        subscriptionId = id;
        this.activeRequests.add(emitter);
        this.handlers.set(id, (response) => {
          if (subscriptionId !== id) {
            return;
          }
          if (response.type === ResponseType.EventFire) {
            emitter.fire(response.data);
          } else if (response.type === ResponseType.EventError) {
            // Subscription failures terminate this generation, never the normal event stream.
            subscriptionId = undefined;
            this.handlers.delete(id);
            this.activeRequests.delete(emitter);
            emitter.dispose();
            const error = new Error(response.data.message);
            error.name = response.data.name;
            if (response.data.stack) error.stack = response.data.stack.join("\n");
            console.error(`RPC event subscription failed: ${channelName}.${name}`, error);
          }
        });
        const doRequest = () => {
          if (this.isDisposed || subscriptionId !== id) {
            return;
          }
          this.sendRequest(RequestType.EventListen, id, channelName, name, arg);
        };

        if (this.state === State.Idle) {
          doRequest();
        } else {
          this.whenInitialized().then(doRequest);
        }
      },
      onDidRemoveLastListener: () => {
        const id = subscriptionId;
        if (id === undefined) {
          return;
        }
        subscriptionId = undefined;
        this.activeRequests.delete(emitter);
        this.handlers.delete(id);
        this.sendCancelOrDispose(RequestType.EventDispose, id);
      },
    });

    return emitter.event;
  }

  private sendRequest(
    type: RequestType,
    id: number,
    channelName: string,
    name: string,
    arg?: any,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id, channelName, name]);
    serialize(writer, arg);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private sendCancelOrDispose(
    type: RequestType.PromiseCancel | RequestType.EventDispose,
    id: number,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id]);
    serialize(writer, undefined);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private onBuffer(message: VSBuffer): void {
    // 修复原因：同一 protocol 上还有反向 ChannelServer（host ↔ 远端 WebSocket 两端都是），对方发来的
    // 请求也会到这里。原来先解码消息体再判断类型，每条请求都被完整解码两次，大请求（例如数据同步的
    // 归档）白白多花一倍 CPU。修法：先读消息头，只解码属于本端的响应体。
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const type = header[0] as ResponseType;

    switch (type) {
      case ResponseType.Initialize:
        this.onResponse({ type: ResponseType.Initialize });
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.EventError:
      case ResponseType.PromiseErrorObj:
        this.onResponse({
          type,
          id: header[1],
          data: deserialize(reader),
        } as IRawResponse);
        return;
    }
  }

  private onResponse(response: IRawResponse): void {
    if (response.type === ResponseType.Initialize) {
      this.state = State.Idle;
      this._onDidInitialize.fire();
      return;
    }

    this.handlers.get(response.id)?.(response);
  }

  private whenInitialized(): Promise<void> {
    if (this.state === State.Idle) {
      return Promise.resolve();
    }
    return Event.toPromise(this.onDidInitialize);
  }

  /** Wait for already issued cleanup/read calls before an intentional attachment release. */
  async whenIdle(): Promise<void> {
    while (!this.isDisposed && this.#pendingPromises.size) {
      await Promise.allSettled([...this.#pendingPromises]);
    }
  }

  dispose(reason?: Error): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.protocolListener?.dispose();
    this.protocolListener = null;

    const rejection = reason ?? new Error("ChannelClient disposed");
    if (!reason) {
      rejection.name = "ConnectionClosed";
    }
    // 传输已终结时，所有已发出以及排队等待 Initialize 的 Promise 请求都必须
    // fail-closed。否则上层的 in-flight 去重 Promise 会永久占用 workspace key。
    for (const [id, reject] of this.pendingRejections) {
      this.pendingRejections.delete(id);
      this.handlers.delete(id);
      reject(rejection);
    }
    for (const disposable of this.activeRequests) {
      disposable.dispose();
    }
    this.activeRequests.clear();
    this.pendingRejections.clear();
    this.handlers.clear();
    this._onDidInitialize.dispose();
  }
}
