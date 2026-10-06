/**
 * Fork-extension (protocol v3) runtime host for RPC mode.
 *
 * Owns the v3 negotiation gate and is the single dispatch point rpc-mode.ts
 * hooks into: fork commands are only answered after a client negotiated v3,
 * unknown fork frames fall through to the stock `Unknown command` behavior,
 * and registered fail-closed disposers run on client disconnect. Feature
 * modules (permission approval, session listing, rich ask, ...) register their
 * handlers here instead of extending the upstream command switch.
 */
import type { RpcResponse } from "./rpc-types";
import type { RpcForkCommandBase } from "./rpc-fork-types";

/** Capabilities fork feature modules use to answer commands and emit frames. */
export interface RpcForkContext {
	/** Emit an outbound protocol frame (fork bypass events, requests) on stdout. */
	readonly emit: (frame: object) => void;
	readonly success: (id: string | undefined, command: string, data?: object | null) => RpcResponse;
	readonly error: (id: string | undefined, command: string, message: string, code?: string) => RpcResponse;
}

export type RpcForkCommandHandler = (command: RpcForkCommandBase) => Promise<RpcResponse> | RpcResponse;

export class RpcForkHost {
	#negotiated = false;
	#disposed = false;
	readonly #commands = new Map<string, RpcForkCommandHandler>();
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

	registerCommand(type: string, handler: RpcForkCommandHandler): void {
		this.#commands.set(type, handler);
	}

	/** Register an inbound side-channel frame handler; it returns true to consume the frame. */
	registerFrameHandler(handler: (parsed: unknown) => boolean): void {
		this.#frameHandlers.push(handler);
	}

	/** Register cleanup executed on disconnect, including resources acquired before negotiation. */
	registerDisposer(disposer: (reason: string) => void): void {
		this.#disposers.push(disposer);
	}

	/**
	 * Dispatch a command frame. `undefined` = not handled: either v3 was never
	 * negotiated (stock behavior preserved) or no fork feature owns the type
	 * (stock `Unknown command` error).
	 */
	async handleCommand(command: RpcForkCommandBase): Promise<RpcResponse | undefined> {
		if (this.#disposed) {
			return this.context.error(command.id, command.type, "RPC session has been disposed", "session_disposed");
		}
		if (!this.#negotiated) return undefined;
		const handler = this.#commands.get(command.type);
		if (!handler) return undefined;
		return handler(command);
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
