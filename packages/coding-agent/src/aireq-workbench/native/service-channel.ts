import {
	type CancellationToken,
	Emitter,
	type Event,
	type IDisposable,
	toDisposable,
} from "../../../../../packages/aireq-frontend/packages/rpc/src/foundation";
import {
	type WebGuiMethod,
	WebGuiNotImplementedError,
	type WebGuiServiceContext,
	type WebGuiServiceDefinition,
	type WebGuiServiceOptions,
} from "./rpc-contract";

function cancellationError(): Error {
	const error = new Error("WebGUI RPC operation was cancelled or its connection was closed");
	error.name = "Canceled";
	return error;
}

class WebGuiService implements WebGuiServiceDefinition {
	readonly name: string;
	#methods: Readonly<Record<string, WebGuiMethod>>;
	#options: WebGuiServiceOptions;
	#pending = new Set<() => void>();
	#subscriptions = new Set<IDisposable>();
	#abortListeners = new Map<AbortSignal, () => void>();
	#disposed = false;

	constructor(name: string, methods: Readonly<Record<string, WebGuiMethod>>, options: WebGuiServiceOptions) {
		this.name = name;
		this.#methods = methods;
		this.#options = options;
	}

	#watchContext(context: WebGuiServiceContext): boolean {
		if (this.#disposed) return false;
		if (context.signal.aborted) {
			this.dispose();
			return false;
		}
		if (!this.#abortListeners.has(context.signal)) {
			const onAbort = () => this.dispose();
			this.#abortListeners.set(context.signal, onAbort);
			context.signal.addEventListener("abort", onAbort, { once: true });
		}
		return true;
	}

	call<T>(
		context: WebGuiServiceContext,
		command: string,
		arg?: unknown,
		cancellationToken?: CancellationToken,
	): Promise<T> {
		if (!this.#watchContext(context)) return Promise.reject(cancellationError());
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let settled = false;
		let cancellationSubscription: IDisposable | undefined = undefined;
		const cleanup = (): boolean => {
			if (settled) return false;
			settled = true;
			this.#pending.delete(cancel);
			cancellationSubscription?.dispose();
			return true;
		};
		const cancel = () => {
			if (cleanup()) reject(cancellationError());
		};
		const fail = (error: unknown) => {
			if (cleanup()) reject(error);
		};
		this.#pending.add(cancel);
		cancellationSubscription = cancellationToken?.onCancellationRequested(cancel);
		if (settled) cancellationSubscription?.dispose();
		if (cancellationToken?.isCancellationRequested || context.signal.aborted) cancel();

		// Dispatch after the current protocol batch so an already received cancellation wins.
		queueMicrotask(() => {
			if (settled) return;
			if (this.#disposed || context.signal.aborted || cancellationToken?.isCancellationRequested) {
				cancel();
				return;
			}
			try {
				const method = Object.hasOwn(this.#methods, command) ? this.#methods[command] : undefined;
				if (!method) {
					// Only explicitly registered methods are callable.
					throw new WebGuiNotImplementedError(`${this.name}.${command}`);
				}
				if (arg !== undefined && !Array.isArray(arg)) {
					throw new TypeError(`WebGUI RPC ${this.name}.${command} requires positional arguments`);
				}
				const result = method(...(arg ?? []));
				Promise.resolve(result).then(value => {
					if (cleanup()) resolve(value as T);
				}, fail);
			} catch (error) {
				fail(error);
			}
		});
		return promise;
	}

	listen<T>(context: WebGuiServiceContext, event: string, arg?: unknown): Event<T> {
		return listener => {
			if (!this.#watchContext(context)) return toDisposable(() => {});
			const emitter = new Emitter<unknown>();
			const listenerSubscription = emitter.event(value => listener(value as T));
			let upstream: IDisposable | undefined;
			const subscription = toDisposable(() => {
				this.#subscriptions.delete(subscription);
				try {
					upstream?.dispose();
				} finally {
					listenerSubscription.dispose();
					emitter.dispose();
				}
			});
			this.#subscriptions.add(subscription);
			try {
				let source: Event<unknown> | undefined;
				const dynamicEvent =
					this.#options.dynamicEvents && Object.hasOwn(this.#options.dynamicEvents, event)
						? this.#options.dynamicEvents[event]
						: undefined;
				if (dynamicEvent) {
					source = dynamicEvent(arg, context);
				} else if (this.#options.events && Object.hasOwn(this.#options.events, event)) {
					source = this.#options.events[event];
				}
				if (this.#disposed) return subscription;
				// Missing publishers do not produce synthetic business events.
				upstream = source?.(value => emitter.fire(value));
				// A synchronous publisher can close the connection while its subscription is being created.
				if (this.#disposed) upstream?.dispose();
				return subscription;
			} catch (error) {
				subscription.dispose();
				throw error;
			}
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const [signal, onAbort] of this.#abortListeners) signal.removeEventListener("abort", onAbort);
		this.#abortListeners.clear();
		for (const cancel of this.#pending) cancel();
		this.#pending.clear();
		const errors: unknown[] = [];
		for (const subscription of this.#subscriptions) {
			try {
				subscription.dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		this.#subscriptions.clear();
		try {
			this.#options.dispose?.();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) throw new AggregateError(errors, `Failed to dispose WebGUI service ${this.name}`);
	}
}

export function createWebGuiService(
	name: string,
	methods: Readonly<Record<string, WebGuiMethod>>,
	options: WebGuiServiceOptions = {},
): WebGuiServiceDefinition {
	return new WebGuiService(name, methods, options);
}
