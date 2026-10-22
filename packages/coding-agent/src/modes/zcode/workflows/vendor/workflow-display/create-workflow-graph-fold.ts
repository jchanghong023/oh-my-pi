// Adapted from pinned ZCode core/src/tool/handlers/create-workflow-graph-fold.ts.
// Pure display projection only; no original Agent runtime is instantiated.
import { reduceOrdering, type ReducibleEdge } from "../dynamic-workflow/projections.js";

export interface RawEdge {
	from: string;
	to: string;
	back: boolean;
}

/** 原生显示图算法：先折叠同向边，再在前向强连通分量的缩点图上归约，不能跨环删掉分支。 */
export function foldPhaseEdges(raw: readonly RawEdge[]): RawEdge[] {
	const folded = foldPairs(raw);
	const componentOf = componentsOf(folded);
	const component = (id: string): string => componentOf.get(id) ?? id;
	const keyOf = (from: string, to: string, back: boolean): string => `${from} ${to} ${back}`;
	const order: string[] = [];
	const byKey = new Map<string, ReducibleEdge>();
	for (const edge of folded) {
		const from = component(edge.from);
		const to = component(edge.to);
		if (from === to) continue;
		const key = keyOf(from, to, edge.back);
		if (byKey.has(key)) continue;
		order.push(key);
		byKey.set(key, edge.back ? { carryOf: "seq", from, kind: "carry", to } : { from, kind: "seq", to });
	}
	const condensed = order.map(key => byKey.get(key) as ReducibleEdge);
	const kept = new Set(reduceOrdering(condensed).map(edge => keyOf(edge.from, edge.to, edge.kind === "carry")));
	return folded.filter(edge => {
		const from = component(edge.from);
		const to = component(edge.to);
		return from === to || kept.has(keyOf(from, to, edge.back));
	});
}

function foldPairs(raw: readonly RawEdge[]): RawEdge[] {
	const order: string[] = [];
	const byKey = new Map<string, RawEdge>();
	for (const edge of raw) {
		if (edge.from === edge.to) continue;
		const key = `${edge.from} ${edge.to}`;
		const seen = byKey.get(key);
		if (seen === undefined) {
			order.push(key);
			byKey.set(key, { ...edge });
		} else {
			seen.back = seen.back && edge.back;
		}
	}
	return order.map(key => byKey.get(key) as RawEdge);
}

function componentsOf(folded: readonly RawEdge[]): Map<string, string> {
	const nodes: string[] = [];
	const seen = new Set<string>();
	const next = new Map<string, string[]>();
	for (const edge of folded) {
		for (const id of [edge.from, edge.to]) {
			if (seen.has(id)) continue;
			seen.add(id);
			nodes.push(id);
		}
		if (edge.back) continue;
		const list = next.get(edge.from);
		if (list === undefined) next.set(edge.from, [edge.to]);
		else list.push(edge.to);
	}
	const reach = new Map<string, Set<string>>();
	for (const start of nodes) {
		const reached = new Set<string>();
		const stack = [...(next.get(start) ?? [])];
		while (stack.length > 0) {
			const node = stack.pop() as string;
			if (reached.has(node)) continue;
			reached.add(node);
			stack.push(...(next.get(node) ?? []));
		}
		reach.set(start, reached);
	}
	const componentOf = new Map<string, string>();
	for (const node of nodes) {
		if (componentOf.has(node)) continue;
		componentOf.set(node, node);
		for (const other of reach.get(node) ?? []) {
			if (componentOf.has(other)) continue;
			if (reach.get(other)?.has(node) === true) componentOf.set(other, node);
		}
	}
	return componentOf;
}
