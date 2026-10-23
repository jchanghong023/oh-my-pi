import { applyToolProxy } from "../../extensibility/tool-proxy";
import { ToolRestrictions } from "../../session/tool-restrictions";
import type { Tool } from "../../tools";
import { runZCodeToolCall } from "./interactions";

/** 仅 ZCode 宿主使用；通过既有 registry 包装入口关联原生审批，不改核心/TUI。 */
export class ZCodeApprovalToolRestrictions extends ToolRestrictions {
	readonly #approvalWrapped = new WeakMap<Tool, Tool>();

	override clone(): ZCodeApprovalToolRestrictions {
		// SDK 派生 task 子会话时须保留审批入口，否则子工具会继承父 scope 而被安全拒绝。
		return new ZCodeApprovalToolRestrictions(this.snapshot());
	}

	override wrap<T extends Tool>(tool: T): T {
		const existing = this.#approvalWrapped.get(tool);
		if (existing) return existing as T;
		const guarded = super.wrap(tool);
		const execute: Tool["execute"] = (id, params, signal, onUpdate, context) => {
			// registry 的原生入口与审批 wrapper 均经过此处，Stop 后不进入实际副作用。
			signal?.throwIfAborted();
			return runZCodeToolCall(
				{ id, name: tool.name, input: params, signal, sessionId: context?.sessionManager?.getSessionId() },
				() => guarded.execute(id, params, signal, onUpdate, context),
			);
		};
		const wrapped = { execute } as T;
		applyToolProxy(guarded, wrapped);
		this.#approvalWrapped.set(tool, wrapped);
		this.#approvalWrapped.set(wrapped, wrapped);
		return wrapped;
	}
}
