import { Snowflake } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter } from "../../internal-urls";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	WriteContext,
} from "../../internal-urls/types";
import type {
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcHostUriSchemeDefinition,
} from "./rpc-types";

type RpcHostUriOutput = (frame: RpcHostUriRequest | RpcHostUriCancelRequest) => void;

type PendingUriRequest = {
	operation: "read" | "write";
	url: string;
	resolve: (frame: RpcHostUriResult) => void;
	reject: (error: Error) => void;
};

/** Type guard for inbound `host_uri_result` frames coming from the host. */
export function isRpcHostUriResult(value: unknown): value is RpcHostUriResult {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown };
	return frame.type === "host_uri_result" && typeof frame.id === "string";
}

/**
 * One handler instance per host-registered scheme, shared by every bridge that
 * registered the scheme on the same router. Reads and writes are routed to the
 * bridge of the CALLING session (rpc-ui-protocol.md §5.2/§13.2): in project
 * mode every session registers the same project-wide scheme set, and a global
 * last-writer handler would stamp another session's identity onto the request.
 * Callers without a session identity fall back to the first owner.
 */
class RpcHostUriProtocolHandler implements ProtocolHandler {
	readonly scheme: string;
	readonly spec: SchemeSpec;
	readonly write?: (url: InternalUrl, content: string, context?: WriteContext) => Promise<void>;
	readonly #ownership: RpcHostUriSchemeOwnership;

	constructor(definition: RpcHostUriSchemeDefinition, ownership: RpcHostUriSchemeOwnership) {
		this.scheme = definition.scheme;
		this.#ownership = ownership;
		const writable = definition.writable === true;
		this.spec = {
			backing: "remote",
			selectors: "none",
			immutable: definition.immutable === true,
			write: writable ? { via: "handler", payload: "text", scope: "workspace", tier: () => "write" } : undefined,
		};
		if (writable) {
			this.write = (url, content, context) =>
				this.#bridgeFor(context).requestWrite(this.scheme, url, content, context);
		}
	}

	resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		return this.#bridgeFor(context).requestRead(this.scheme, url, context);
	}

	/** The bridge owning the calling session, else the first registered owner. */
	#bridgeFor(context: { sessionId?: unknown; session?: unknown } | undefined) {
		let callerSessionId = context?.sessionId;
		if (typeof callerSessionId !== "string") {
			const getSessionId = (context?.session as { getSessionId?: unknown } | undefined)?.getSessionId;
			callerSessionId = typeof getSessionId === "function" ? getSessionId.call(context?.session) : undefined;
		}
		if (typeof callerSessionId === "string") {
			const owner = this.#ownership.bridges.find(bridge => bridge.ownerSessionId === callerSessionId);
			if (owner) return owner;
		}
		const fallback = this.#ownership.bridges[0];
		if (!fallback) throw new Error(`Host URI scheme is not available: ${this.scheme}://`);
		return fallback;
	}
}

/** Per-router scheme ownership: the definition plus every bridge still holding it. */
interface RpcHostUriSchemeOwnership {
	definition: RpcHostUriSchemeDefinition;
	bridges: RpcHostUriBridge[];
}

/** Scheme ownership tables keyed by router instance (the process router is shared across RPC sessions). */
const schemeOwnerships = new WeakMap<InternalUrlRouter, Map<string, RpcHostUriSchemeOwnership>>();

function ownershipsFor(router: InternalUrlRouter): Map<string, RpcHostUriSchemeOwnership> {
	let table = schemeOwnerships.get(router);
	if (!table) {
		table = new Map();
		schemeOwnerships.set(router, table);
	}
	return table;
}

function sameRegistration(
	a: RpcHostUriSchemeDefinition | undefined,
	b: RpcHostUriSchemeDefinition | undefined,
): boolean {
	return a?.scheme === b?.scheme && a?.writable === b?.writable && a?.immutable === b?.immutable;
}

/**
 * Bidirectional bridge that lets the RPC host own a set of URI schemes.
 *
 * The host registers schemes via `set_host_uri_schemes`; in project mode every
 * session's bridge registers the same set into the process-global
 * {@link InternalUrlRouter}. The router keeps ONE handler per scheme, owned by
 * the shared ownership table above: requests carry the calling session's
 * identity, and a session detaching only releases its own share — the scheme
 * stays registered while any other session still holds it.
 */
export class RpcHostUriBridge {
	#output: RpcHostUriOutput;
	#router: InternalUrlRouter;
	/** Session this bridge stamps host_uri_request frames for; undefined for unscoped bridges (tests). */
	readonly ownerSessionId: string | undefined;
	#definitions = new Map<string, RpcHostUriSchemeDefinition>();
	#pending = new Map<string, PendingUriRequest>();

	constructor(
		output: RpcHostUriOutput,
		router: InternalUrlRouter = InternalUrlRouter.instance(),
		ownerSessionId?: string,
	) {
		this.#output = output;
		this.#router = router;
		this.ownerSessionId = ownerSessionId;
	}

	getSchemes(): string[] {
		return Array.from(this.#definitions.keys());
	}

	/**
	 * Replace the registered set of host URI schemes held by THIS bridge. Other
	 * bridges' shares are untouched; the router registration lives until the
	 * last holder drops the scheme.
	 */
	setSchemes(schemes: RpcHostUriSchemeDefinition[]): string[] {
		const normalized = new Map<string, RpcHostUriSchemeDefinition>();
		for (const raw of schemes) {
			const scheme = typeof raw?.scheme === "string" ? raw.scheme.trim().toLowerCase() : "";
			if (!scheme) {
				throw new Error("Host URI scheme must be a non-empty string");
			}
			if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
				throw new Error(`Host URI scheme contains invalid characters: ${raw.scheme}`);
			}
			// Built-in schemes are OMP-owned: a host shadowing one would change its semantics for
			// the whole process, and `clear()` would then delete it for later sessions.
			if (this.#router.isBuiltin(scheme)) {
				throw new Error(`Host URI scheme is reserved by OMP: ${scheme}://`);
			}
			normalized.set(scheme, {
				scheme,
				description: typeof raw.description === "string" ? raw.description : undefined,
				writable: raw.writable === true,
				immutable: raw.immutable === true,
			});
		}

		const ownerships = ownershipsFor(this.#router);
		for (const previous of this.#definitions.keys()) {
			if (normalized.has(previous)) continue;
			this.#releaseOwnership(ownerships, previous);
		}
		for (const definition of normalized.values()) {
			const existing = ownerships.get(definition.scheme);
			if (!sameRegistration(existing?.definition, definition)) {
				// New scheme, or the write/immutable contract changed: publish the
				// handler this definition implies (the router enforces write.via).
				// Existing holders keep their share under the new contract.
				ownerships.set(definition.scheme, { definition, bridges: existing?.bridges ?? [] });
				this.#router.register(new RpcHostUriProtocolHandler(definition, ownerships.get(definition.scheme)!));
			}
			const ownership = ownerships.get(definition.scheme)!;
			if (!ownership.bridges.includes(this)) ownership.bridges.push(this);
		}
		this.#definitions = normalized;
		return Array.from(normalized.keys());
	}

	/** Drop this bridge's share of `scheme`; unregister from the router when the last holder left. */
	#releaseOwnership(ownerships: Map<string, RpcHostUriSchemeOwnership>, scheme: string): void {
		const ownership = ownerships.get(scheme);
		if (!ownership) return;
		ownership.bridges = ownership.bridges.filter(bridge => bridge !== this);
		if (ownership.bridges.length === 0) {
			ownerships.delete(scheme);
			this.#router.unregister(scheme);
		}
	}

	/**
	 * Release every scheme this bridge holds and reject any in-flight requests.
	 * Other bridges holding the same scheme keep the router registration alive.
	 */
	clear(message: string = "Host URI bridge shut down"): void {
		const ownerships = ownershipsFor(this.#router);
		for (const scheme of this.#definitions.keys()) {
			this.#releaseOwnership(ownerships, scheme);
		}
		this.#definitions.clear();
		this.rejectAllPending(message);
	}

	/** Resolve a pending request by id; called by `rpc-mode` on inbound results. */
	handleResult(frame: RpcHostUriResult): boolean {
		const pending = this.#pending.get(frame.id);
		if (!pending) return false;
		this.#pending.delete(frame.id);
		pending.resolve(frame);
		return true;
	}

	rejectAllPending(message: string): void {
		const error = new Error(message);
		const pending = Array.from(this.#pending.values());
		this.#pending.clear();
		for (const entry of pending) {
			entry.reject(error);
		}
	}

	async requestRead(scheme: string, url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const result = await this.#dispatch("read", url.href, undefined, context?.signal);
		if (result.isError) {
			throw new Error(result.error || result.content || `Host URI read failed for ${url.href}`);
		}
		const content = result.content ?? "";
		const contentType = result.contentType ?? "text/plain";
		const definition = this.#definitions.get(scheme);
		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			notes: result.notes && result.notes.length > 0 ? [...result.notes] : undefined,
			immutable: result.immutable ?? definition?.immutable === true,
		};
	}

	async requestWrite(_scheme: string, url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const result = await this.#dispatch("write", url.href, content, context?.signal);
		if (result.isError) {
			throw new Error(result.error || result.content || `Host URI write failed for ${url.href}`);
		}
	}

	#dispatch(
		operation: "read" | "write",
		url: string,
		content: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<RpcHostUriResult> {
		if (signal?.aborted) {
			return Promise.reject(new Error(`Host URI ${operation} for ${url} was aborted`));
		}

		const id = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<RpcHostUriResult>();
		let settled = false;

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
		};

		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			this.#output({
				type: "host_uri_cancel",
				id: Snowflake.next() as string,
				targetId: id,
			});
			reject(new Error(`Host URI ${operation} for ${url} was aborted`));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pending.set(id, {
			operation,
			url,
			resolve: frame => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(frame);
			},
			reject: err => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(err);
			},
		});

		const frame: RpcHostUriRequest = {
			type: "host_uri_request",
			id,
			operation,
			url,
		};
		if (operation === "write") {
			frame.content = content ?? "";
		}
		this.#output(frame);

		return promise;
	}
}
