import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { applyToolProxy } from "../extensibility/tool-proxy";
import { normalizeToolNames } from "../tools/builtin-names";
import type { Tool } from "../tools";

export interface ToolRestrictionOptions {
	/** Undefined permits the normal catalog; an explicit empty list permits nothing. */
	allowlist?: readonly string[];
	denylist?: readonly string[];
}

function names(values: readonly string[]): Set<string> {
	return new Set(normalizeToolNames(values.map(name => (name.startsWith("xd://") ? name.slice(5) : name))));
}

/** Session-owned admission boundary, independent of tool presentation and Settings. */
export class ToolRestrictions {
	readonly #allowlist: Set<string> | undefined;
	readonly #denylist: Set<string>;
	readonly #wrapped = new WeakMap<Tool, Tool>();

	constructor(options: ToolRestrictionOptions = {}) {
		this.#allowlist = options.allowlist === undefined ? undefined : names(options.allowlist);
		this.#denylist = names(options.denylist ?? []);
	}

	get hasAllowlist(): boolean {
		return this.#allowlist !== undefined;
	}

	/** Freeze effective admission for a child. */
	snapshot(): ToolRestrictionOptions {
		return {
			allowlist: this.#allowlist === undefined ? undefined : [...this.#allowlist],
			denylist: [...this.#denylist],
		};
	}

	/** Preserve snapshot isolation while allowing embedding policies to retain their wrapper. */
	clone(): ToolRestrictions {
		return new ToolRestrictions(this.snapshot());
	}

	allows(name: string): boolean {
		const canonical = normalizeToolNames([name.startsWith("xd://") ? name.slice(5) : name])[0];
		return !this.#denylist.has(canonical) && (!this.#allowlist || this.#allowlist.has(canonical));
	}

	assertAllowed(name: string): void {
		if (!this.allows(name)) throw new ToolError(`Tool '${name}' is denied by the caller's tool policy.`);
	}

	filter<T extends { name: string }>(tools: readonly T[]): T[] {
		return tools.filter(tool => this.allows(tool.name));
	}

	/** Guard canonical dispatch itself, including handles retained by the caller. */
	wrap<T extends Tool>(tool: T): T {
		const existing = this.#wrapped.get(tool);
		if (existing) return existing as T;
		const execute = tool.execute;
		const policy = this;
		const guardedExecute: Tool["execute"] = async (id, params, signal, onUpdate, context) => {
			signal?.throwIfAborted();
			policy.assertAllowed(tool.name);
			return execute.call(tool, id, params, signal, onUpdate, context);
		};
		// Reuse schema-preserving forwarding without modifying caller-owned tools.
		// Another session may register the same instance.
		const wrapped = {
			execute: guardedExecute,
			// Speculation bypasses canonical dispatch and can outlive input admission.
			speculation: undefined,
		} as T;
		applyToolProxy(tool, wrapped);
		this.#wrapped.set(tool, wrapped);
		this.#wrapped.set(wrapped, wrapped);
		return wrapped;
	}
}
