import { useEffect, useMemo, useRef } from "react";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import type { TimelinePill, WorkflowTimelineModel } from "@/components/workflow-timeline/timeline-model.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";

/** Only projects Dev state into the native renderer; owns no workflow transitions. */
export function DevWorkflowTimeline({ labels, phase, selected, complete, running, proposal, sr, rounds, returned, canNavigate, entered, onSelect }: {
 labels: string[]; phase: number; selected: number; complete: boolean; running: boolean;
 proposal: boolean; sr: boolean; rounds: number[]; returned: boolean; canNavigate: boolean;
 entered: boolean[]; onSelect(index: number): void;
}) {
 const root = useRef<HTMLDivElement>(null);
 const model = useMemo<WorkflowTimelineModel>(() => {
  const agents = proposal ? [["业务需求 Agent"], ["需求评审 Agent"], ["方案 Agent"], []]
   : sr ? [["计划 Agent"], ["执行 Agent"], ["执行 Agent"]]
   : [["计划 Agent", "执行 Agent"], ["IR 验收 Agent"], []];
  const loop = proposal && returned;
  const stations = labels.map((name, index) => {
   // A current station can be idle awaiting a person; do not fabricate a running lamp.
   const status: StepRunStatus = complete || index < phase ? "done" : index === phase && running ? "running" : "pending";
   const pills: TimelinePill[] = (agents[index] ?? []).map(agent => {
    const avatarIndex = agent === "业务需求 Agent" || agent === "计划 Agent" ? 0 : agent === "需求评审 Agent" || agent === "执行 Agent" ? 1 : 2;
    return { key: `${index}:${agent}`, lane: { id: agent, name: agent, laneClass: "agent" }, laneClass: "agent", runtimeName: agent, avatarIndex, status, stepIds: [] };
   });
   return { id: String(index), naming: { id: String(index), name }, pills, status, visited: entered[index] ?? false, rounds: entered[index] ? rounds[index] ?? 0 : 0, onLoop: loop && index <= 2, track: 0, current: index === phase, selected: index === selected, selectable: canNavigate && entered[index] };
  });
  return { stations, rails: labels.slice(1).map((_, index) => ({ from: index, to: index + 1, ink: complete || index < phase ? "strong" : "faint" })), arcs: loop ? [{ from: 2, to: 0, lane: 0, air: 0, ink: phase === 0 ? "strong" : "faint" }] : [], bands: [], runningIndex: running ? phase : undefined, live: true };
 }, [labels.join("|"), phase, selected, complete, running, proposal, sr, rounds, returned, canNavigate, entered.join("|")]);
 useEffect(() => {
  const scroller = root.current?.querySelector<HTMLElement>('[data-testid="workflow-timeline-scroller"]');
  if (scroller) scroller.scrollTo({ left: Math.max(0, selected * 192 - scroller.clientWidth / 2 + 84), behavior: "instant" });
 }, [selected, labels.length, returned]);
 return <div ref={root} className="w-full min-w-0 max-w-3xl" data-testid="dev-workflow-timeline" aria-label={`当前阶段：${labels[phase]}；查看：${labels[selected]}`}>
  <WorkflowTimeline model={model} onSelectStation={station => { const index = Number(station.id); if (canNavigate && entered[index]) onSelect(index); }} />
 </div>;
}
