import { type Component, Container } from "../tui";
import { col } from "../native/describe";
import type { NativeNode } from "../native/node";
export interface ToolActivityComponent {
	setToolActivityVisible(visible: boolean): void;
	/** Whether this activity uses compact rows rather than the upstream detail renderer. */
	isCompactToolActivity?(): boolean;
	/** Successful calls eligible for compact transcript folding. */
	getCompactToolCount?(): number;
	getCompactToolFailureCount?(): number;
	/** Whether the compact presentation changed, including a previously retired summary. */
	setCompactToolLimit?(keep: number, summary: number, failures?: number): boolean;
}

export function isToolActivityComponent(component: Component): component is Component & ToolActivityComponent {
	return typeof (component as Partial<ToolActivityComponent>).setToolActivityVisible === "function";
}

export function isCompactToolActivityComponent(component: Component): component is Component & ToolActivityComponent {
	return isToolActivityComponent(component) && component.isCompactToolActivity?.() !== false;
}

export function compactToolSummary(count: number, failures = 0): string {
	return `… 已收起 ${count} 次成功调用${failures > 0 ? ` · 失败 ${failures} 次（保留）` : ""}`;
}

/** Keep the file identity visible before narrow rows truncate their right edge. */
export function compactToolPath(value: string): string {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
	return value.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || value;
}

/** Error text often leads with a long quoted path; put its actual cause first. */
export function compactToolFailure(value: string): string {
	const line = value
		.split(/\r?\n/, 1)[0]
		.replace(/^Error:\s*/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (/\bENOENT\b|\b(?:path|file)\b.*\bnot found\b|\bno such file\b/i.test(line)) return "文件或路径不存在";
	if (/\bEACCES\b|\bEPERM\b|permission denied|access denied/i.test(line)) return "Permission denied";
	if (/No document indexes/i.test(line)) return "尚未建立文档索引";
	if (/Nothing to wait for/i.test(line)) return "没有可等待的后台任务";
	return (
		line.replace(
			/(['"])([^'"\r\n]*[\\/][^'"\r\n]*)\1/g,
			(_match, quote: string, path: string) => `${quote}${compactToolPath(path)}${quote}`,
		) || "Tool failed"
	);
}

export class ToolActivityContainer extends Container implements ToolActivityComponent {
	#visible = true;
	#native: { children: readonly Component[]; visible: boolean; node: NativeNode } | undefined;

	constructor(component: Component | Component[]) {
		super();
		if (Array.isArray(component)) {
			for (const child of component) this.addChild(child);
		} else {
			this.addChild(component);
		}
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#visible === visible) return;
		this.#visible = visible;
		this.invalidate();
	}

	/**
	 * Forward Ctrl+O expansion to wrapped children. The transcript's expansion
	 * traversal only visits top-level children, so the wrapper must proxy or
	 * wrapped renderers would freeze at their insertion-time expansion state.
	 */
	setExpanded(expanded: boolean): void {
		for (const child of this.children) {
			const expandable = child as Partial<{ setExpanded(expanded: boolean): void }>;
			if (typeof expandable.setExpanded === "function") expandable.setExpanded(expanded);
		}
	}

	override render(width: number): readonly string[] {
		if (!this.#visible) return [];
		return super.render(width);
	}

	/** The wrapped children; hidden tool activity stays mounted so toggling it is one prop change. */
	override describe(): NativeNode {
		const cached = this.#native;
		const children = this.children;
		if (
			cached?.visible === this.#visible &&
			cached.children.length === children.length &&
			cached.children.every((child, index) => child === children[index])
		) {
			return cached.node;
		}
		const snapshot = children.slice();
		const node = col(snapshot, this.#visible ? { role: "omp.activity" } : { role: "omp.activity", hidden: true });
		this.#native = { children: snapshot, visible: this.#visible, node };
		return node;
	}
}
