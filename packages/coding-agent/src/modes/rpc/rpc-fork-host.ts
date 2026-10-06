/**
 * Fork-extension (protocol v3) runtime host for RPC mode.
 *
 * Owns v3 negotiation, inbound interaction-frame routing, and fail-closed
 * cleanup on client disconnect. Permission approval and rich ask register
 * side-channel handlers here; the fork host exposes no RPC commands.
 */

/** Outbound frame sink exposed to fork feature modules. */
export interface RpcForkContext {
	/** Emit an outbound protocol frame (fork bypass events, requests) on stdout. */
	readonly emit: (frame: object) => void;
}

export class RpcForkHost {
	#negotiated = false;
	#disposed = false;
	readonly #frameHandlers: Array<(parsed: unknown) => boolean> = [];
	readonly #disposers: Array<(reason: string) => void> = [];
	readonly #activators: Array<() => void> = [];
	readonly #pendingRequestSources: Array<() => boolean> = [];

	constructor(readonly context: RpcForkContext) {}

	/** True once the client negotiated the fork protocol version. */
	get isActive(): boolean {
		return this.#negotiated && !this.#disposed;
	}

	/** True while an owned fork approval or question is awaiting the client. */
	get hasPendingRequests(): boolean {
		return this.#pendingRequestSources.some(source => source());
	}

	registerPendingRequestSource(source: () => boolean): void {
		this.#pendingRequestSources.push(source);
	}

	/** Activate the fork surface after a successful `negotiate_protocol` v3 exchange. */
	activate(): void {
		if (this.#negotiated || this.#disposed) return;
		this.#negotiated = true;
		for (const activator of this.#activators) activator();
	}

	/** Register a callback run once when v3 is negotiated (bridge injection etc.). */
	registerActivation(activator: () => void): void {
		this.#activators.push(activator);
	}

	/** Register an inbound side-channel frame handler; it returns true to consume the frame. */
	registerFrameHandler(handler: (parsed: unknown) => boolean): void {
		this.#frameHandlers.push(handler);
	}

	/** Register cleanup executed on disconnect, including resources acquired before negotiation. */
	registerDisposer(disposer: (reason: string) => void): void {
		this.#disposers.push(disposer);
	}

	/** Dispatch an inbound bypass frame; unconsumed frames keep stock behavior. */
	handleControlFrame(parsed: unknown): boolean {
		if (!this.isActive) return false;
		for (const handler of this.#frameHandlers) {
			if (handler(parsed)) return true;
		}
		return false;
	}

	/** Release every owned resource and fail pending requests closed once. */
	dispose(reason: string): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const disposer of this.#disposers) disposer(reason);
	}
}
