import { AsyncLocalStorage } from "node:async_hooks";
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
	readonly #inputs = new Map<symbol, Set<string>>();
	readonly #wrapped = new WeakMap<Tool, Tool>();
	readonly #scope = new AsyncLocalStorage<{ denied: Set<string> }>();

	constructor(options: ToolRestrictionOptions = {}) {
		this.#allowlist = options.allowlist === undefined ? undefined : names(options.allowlist);
		this.#denylist = names(options.denylist ?? []);
	}

	get hasAllowlist(): boolean {
		return this.#allowlist !== undefined;
	}

	get hasInputScope(): boolean {
		return this.#scope.getStore() !== undefined;
	}

	/** Keep concurrent prompt/command inputs independent across asynchronous execution. */
	runInput<T>(denylist: readonly string[], fn: () => T): T {
		return this.#scope.run({ denied: names(denylist) }, fn);
	}

	/** Update only the executing input when its runtime queue promotes another input. */
	replaceCurrentInput(denylist: readonly string[]): void {
		const current = this.#scope.getStore();
		if (!current) throw new Error("Tool policy replacement requires an active input scope.");
		current.denied = names(denylist);
	}

	/** Freeze effective admission for a child without sharing the parent's transient lifetime. */
	snapshot(): ToolRestrictionOptions {
		const denied = new Set(this.#denylist);
		for (const names of this.#inputs.values()) for (const name of names) denied.add(name);
		for (const name of this.#scope.getStore()?.denied ?? []) denied.add(name);
		return {
			allowlist: this.#allowlist === undefined ? undefined : [...this.#allowlist],
			denylist: [...denied],
		};
	}

	allows(name: string): boolean {
		const canonical = normalizeToolNames([name.startsWith("xd://") ? name.slice(5) : name])[0];
		if (this.#denylist.has(canonical) || (this.#allowlist && !this.#allowlist.has(canonical))) return false;
		if (this.#scope.getStore()?.denied.has(canonical)) return false;
		for (const denied of this.#inputs.values()) if (denied.has(canonical)) return false;
		return true;
	}

	assertAllowed(name: string): void {
		if (!this.allows(name)) throw new ToolError(`Tool '${name}' is denied by the caller's tool policy.`);
	}

	filter<T extends { name: string }>(tools: readonly T[]): T[] {
		return tools.filter(tool => this.allows(tool.name));
	}

	/** Install only while this input owns runtime admission; release on completion or cancellation. */
	beginInput(denylist: readonly string[], signal?: AbortSignal): () => void {
		signal?.throwIfAborted();
		const token = Symbol();
		this.#inputs.set(token, names(denylist));
		const release = () => {
			this.#inputs.delete(token);
			signal?.removeEventListener("abort", release);
		};
		signal?.addEventListener("abort", release, { once: true });
		return release;
	}

	/** Guard canonical dispatch itself, including handles retained before an input policy changes. */
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
