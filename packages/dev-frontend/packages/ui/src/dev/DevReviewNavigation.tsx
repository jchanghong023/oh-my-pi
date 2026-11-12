import { useEffect, useRef, useState } from "react";
import { GitFork } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { WorkflowAgentFace } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import type { TimelineStation, WorkflowTimelineModel } from "@/components/workflow-timeline/timeline-model.js";
import { useDev } from "./DevContext.js";
import { useDevDataSource } from "./data-source.js";
import { proposalViewedIndex, requirementsReviewCurrent } from "./domain.js";
import type { DevReviewAgentId } from "./types.js";

// Switching review sessions remounts the workspace; retain only the pending keyboard focus handoff.
let keyboardTarget: DevReviewAgentId | undefined;

/** Native session navigation and native parallel graph, never a report editor or approval engine. */
export function DevReviewNavigation() {
 const dev = useDev()!;
 const source = useDevDataSource();
 const [expanded, setExpanded] = useState(false);
 const tabList = useRef<HTMLDivElement>(null);
 useEffect(() => {
  const id = keyboardTarget;
  if (!id || id !== (dev.selection.reviewAgent ?? "summary")) return;
  let frame = requestAnimationFrame(() => {
   frame = requestAnimationFrame(() => {
    tabList.current?.querySelector<HTMLButtonElement>(`[data-testid="review-avatar-${id}"]`)?.focus();
    keyboardTarget = undefined;
   });
  });
  return () => cancelAnimationFrame(frame);
 }, [dev.selection.reviewAgent, dev.session?.sessionId]);
 const group = dev.view?.drafts.find(item => item.id === dev.selection.irId && item.projectId === dev.selection.projectId);
 if (!group || dev.selection.srId || proposalViewedIndex(group, dev.selection) !== 1 || !group.review?.agents || !source.capabilities.proposalDiscussion) return null;
 const review = group.review;
 const agents = review.agents!;
 const selected = dev.selection.reviewAgent ?? "summary";
 const current = agents.find(agent => agent.id === selected)!;
 const choose = (id: string) => dev.select({ ...dev.selection, reviewAgent: id as DevReviewAgentId });
 const independentDone = agents.filter(agent => agent.id !== "summary" && agent.status === "completed").length;
 const stations: TimelineStation[] = agents.map((agent, index) => ({
  id: agent.id, naming: { id: agent.id, name: agent.id === "summary" ? "综合意见" : agent.name }, visited: agent.status !== "pending", rounds: 1, onLoop: false, track: index < 3 ? index : 0,
  status: agent.status === "completed" ? "done" : agent.status === "failed" ? "failed" : agent.status,
  selected: agent.id === selected, selectable: true,
  pills: [{ key: agent.id, lane: { id: agent.id, name: agent.session.modelConfig?.modelName, laneClass: "agent" }, laneClass: "agent", avatarIndex: index + 1, slot: { siteId: agent.id, ordinal: 1 }, status: agent.status === "completed" ? "done" : agent.status, stepIds: [] }],
 }));
 stations.push({ id: "human", naming: { id: "human", name: "人工判断" }, pills: [], visited: Boolean(review.humanDecision), status: review.humanDecision ? "done" : "pending", rounds: 0, onLoop: false, track: 0, current: !review.humanDecision, selectable: false });
 const diagram: WorkflowTimelineModel = {
  stations, rails: [{ from: 0, to: 3, ink: "strong" }, { from: 1, to: 3, ink: "strong", kind: "merge" }, { from: 2, to: 3, ink: "strong", kind: "merge" }, { from: 3, to: 4, ink: review.humanDecision ? "strong" : "faint" }], arcs: [],
  bands: [{ from: 0, to: 2, join: 3, tracks: [0, 1, 2].map(index => ({ stations: [index], entry: agents[index]!.status === "pending" ? "faint" : "strong", exit: agents[index]!.status === "completed" ? "strong" : "faint" })) }],
  live: true, runningIndex: undefined,
 };
 return <div className="shrink-0 space-y-2 border-b border-border px-4 py-2" data-testid="dev-review-navigation">
  <div className="flex items-center justify-between gap-2">
   <Tabs value={selected} onValueChange={choose} className="min-w-0"><TabsList ref={tabList} aria-label="评审 Agent 会话" className="h-11 gap-1 p-1 group-data-horizontal/tabs:h-11" onKeyDownCapture={event => {
    const ids = ["summary", "a", "b", "c"] as const;
    const index = ids.indexOf(selected);
    const next = event.key === "ArrowRight" ? ids[(index + 1) % ids.length] : event.key === "ArrowLeft" ? ids[(index + ids.length - 1) % ids.length] : event.key === "Home" ? ids[0] : event.key === "End" ? ids[ids.length - 1] : undefined;
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    keyboardTarget = next;
    choose(next);
   }}>{(["summary", "a", "b", "c"] as const).map(id => {
    const agent = agents.find(item => item.id === id)!;
    const label = id === "summary" ? "综合意见" : agent.name;
    return <ControlHintTooltip key={id} title={`${label} · ${agent.session.modelConfig?.modelName ?? "模型未配置"}`}><span className="inline-flex"><TabsTrigger value={id} aria-label={label} className="h-9 w-9 flex-none p-1.5 data-[state=active]:bg-selected data-[state=active]:ring-1 data-[state=active]:ring-border" data-testid={`review-avatar-${id}`}><WorkflowAgentFace name={agent.name} avatarIndex={agents.findIndex(item => item.id === id) + 1} status={agent.status === "completed" ? "done" : agent.status} className="size-6" /></TabsTrigger></span></ControlHintTooltip>;
   })}</TabsList></Tabs>
   <Button variant="ghost" size="sm" className="shrink-0 gap-1.5" aria-label="展开评审工作流" title="展开评审工作流" onClick={() => setExpanded(true)}><GitFork className="size-4" />评审流程</Button>
  </div>
  <p className="truncate text-ui-xs text-foreground-subtle" title={current.session.modelConfig?.modelName}>{current.name} · {current.session.modelConfig?.modelName} · 独立评审 {independentDone}/3 · {requirementsReviewCurrent(group) ? review.humanDecision ? `已由 ${review.humanDecision.employeeId} 人工通过` : "综合后由人工判断" : "旧版本，仅供历史查看"}</p>
  <Dialog open={expanded} onOpenChange={setExpanded}><DialogContent className="flex max-h-[85dvh] flex-col overflow-auto sm:max-w-6xl"><DialogHeader><DialogTitle>需求评审工作流</DialogTitle><DialogDescription>三个模型并行只读审查同一版需求 → 第四个 Agent 综合意见 → 人工决定。评审结论以当前版本的报告为准。</DialogDescription></DialogHeader>
   <WorkflowTimeline model={diagram} onOpenPill={pill => { choose(pill.key); setExpanded(false); }} onSelectStation={station => { if (station.id !== "human") { choose(station.id); setExpanded(false); } }} />
  </DialogContent></Dialog>
 </div>;
}
