import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { MarkerType, Position } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import { Canvas } from "@/components/ai-elements/canvas.js";
import { Controls } from "@/components/ai-elements/controls.js";
import { readSrDependencies } from "./sr-dependencies.js";
import type { DevMaterialView, DevRequirementGroup, DevSystemRequirement } from "./types.js";

type DependencyEdge = Edge<{ reason: string }>;

export function DevSrDependencyGraph({ group, material, rows }: { group: DevRequirementGroup; material: DevMaterialView; rows: DevSystemRequirement[] }) {
 const [selectedId, setSelectedId] = useState<string>();
 const graph = useMemo(() => {
  const result = readSrDependencies(group, material);
  const nodes: Node<{ label: ReactNode }>[] = [];
  const edges: DependencyEdge[] = [];
  if (!result.document) return { nodes, edges, issue: result.issue };
  const entries = new Map(result.document.srs.map(row => [row.srId, row]));
  const levels = new Map<string, number>();
  const level = (id: string): number => {
   const saved = levels.get(id);
   if (saved !== undefined) return saved;
   const depth = Math.max(0, ...entries.get(id)!.prerequisites.map(item => level(item.srId) + 1));
   levels.set(id, depth);
   return depth;
  };
  const widths = new Map<number, number>();
  for (const row of result.document.srs) {
   const depth = level(row.srId);
   widths.set(depth, (widths.get(depth) ?? 0) + 1);
  }
  const columns = new Map<number, number>();
  const maxWidth = Math.max(1, ...widths.values());
  for (const row of result.document.srs) {
   const depth = levels.get(row.srId)!;
   const column = columns.get(depth) ?? 0;
   columns.set(depth, column + 1);
   const title = rows.find(sr => sr.id === row.srId)?.title ?? row.srId;
   nodes.push({ id: row.srId, position: { x: (column + (maxWidth - widths.get(depth)!) / 2) * 250, y: depth * 180 },
    sourcePosition: Position.Bottom, targetPosition: Position.Top,
    ariaLabel: `${row.srId}：${title}`, style: { width: 220, minHeight: 110, background: "var(--color-card)", color: "var(--color-foreground)", borderColor: "var(--color-border)", borderRadius: 8 },
    data: { label: <div className="space-y-2 text-left"><p className="break-all font-mono text-ui-xs text-foreground-subtle">{row.srId}</p><p className="break-words text-ui-sm font-medium">{title}</p><p className="text-ui-xs text-foreground-subtle">预估 {row.estimate.workingDays} 个工作日</p></div> } });
   for (const dependency of row.prerequisites) edges.push({ id: JSON.stringify([dependency.srId, row.srId]), source: dependency.srId, target: row.srId, type: "smoothstep", data: { reason: dependency.reason },
    ariaLabel: `${dependency.srId} → ${row.srId}：${dependency.reason}`, markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-foreground-subtle)" }, style: { stroke: "var(--color-foreground-subtle)", strokeWidth: 2 }, interactionWidth: 24 });
  }
  return { nodes, edges };
 }, [group, material, rows]);
 const selected = graph.edges.find(edge => edge.id === selectedId);
 if (graph.issue) return <p role="alert" className="text-ui-sm text-destructive">{graph.issue}</p>;
 if (!graph.nodes.length) return <p className="text-ui-sm text-foreground-subtle">当前 IR 没有 SR。</p>;
 return <section className="space-y-3" aria-label="SR 依赖图" data-testid="sr-dependency-graph">
  <p className="text-ui-xs text-foreground-subtle">箭头从前置 SR 指向依赖它的 SR。可缩放、平移；点击连线查看原因。{!graph.edges.length && "各 SR 无前置依赖，可独立安排。"}</p>
  <div className="h-[420px] min-w-0 overflow-hidden rounded-md border border-border">
   <Canvas key={`${material.path}:${material.sha256}`} nodes={graph.nodes} edges={graph.edges} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} selectionOnDrag={false} panOnDrag minZoom={0.1} maxZoom={2} fitViewOptions={{ padding: 0.2, maxZoom: 1 }} onEdgeClick={(_event, edge) => setSelectedId(edge.id)} onPaneClick={() => setSelectedId(undefined)}>
    <Controls showInteractive={false} />
   </Canvas>
  </div>
  {selected && <div role="status" className="space-y-1 rounded-md border border-border p-3 text-ui-sm"><p className="break-all font-mono text-ui-xs text-foreground-subtle">{selected.source} → {selected.target}</p><p className="break-words">{selected.data?.reason}</p></div>}
 </section>;
}
