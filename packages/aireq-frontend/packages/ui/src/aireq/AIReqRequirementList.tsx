import { useEffect, useState } from "react";
import { ArrowDownWideNarrow, FilePenLine, ListFilter, Search, TriangleAlert, X } from "lucide-react";
import { WorkspacePurposeSection } from "@/WorkspaceSidebar/WorkspacePurposeSection.js";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { proposalProgressIndex } from "./domain.js";
import { useOptionalAIReqDataSource } from "./data-source.js";
import { getEmployeeId } from "./identity.js";
import { PROPOSAL_PHASE_OPTIONS, proposalCreatedTime, proposalNeedsAttention, proposalPhaseLabel, proposalProcessingHint, proposalUpdatedTime } from "./proposal-list.js";
import { readSidebarPreferences, updateSidebarPreferences } from "./navigation.js";
import { useAIReq } from "./AIReqContext.js";
import type { AIReqRequirementGroup } from "./types.js";

export function AIReqRequirementList({ title, groups, onSearch, onNavigate, automationsActive, open, onOpenChange }: {
 open: boolean; onOpenChange(open: boolean): void;
 title: string; groups: AIReqRequirementGroup[];
 onSearch(): void; onNavigate?: () => void; automationsActive?: boolean;
}) {
 const aireq = useAIReq()!;
 const source = useOptionalAIReqDataSource();
 const preferenceScope = `${source?.backend?.id ?? source?.clientId}:${aireq.selection.projectId}:${aireq.releaseId}`;
 const [proposalPreferences, setProposalPreferences] = useState(() => readSidebarPreferences(preferenceScope).proposalList);
 useEffect(() => { setProposalPreferences(readSidebarPreferences(preferenceScope).proposalList); }, [preferenceScope]);
 const { phase, proposer, intake, sort } = proposalPreferences;
 const updateProposalPreferences = (patch: Partial<typeof proposalPreferences>) => {
  const next = { ...proposalPreferences, ...patch };
  updateSidebarPreferences(preferenceScope, { proposalList: next });
  setProposalPreferences(next);
 };
 const setPhase = (phase: string) => updateProposalPreferences({ phase });
 const setProposer = (proposer: string) => updateProposalPreferences({ proposer });
 const setIntake = (intake: "all" | "attention") => updateProposalPreferences({ intake });
 const setSort = (sort: string) => updateProposalPreferences({ sort });
 const employeeId = getEmployeeId();
 const proposerOptions = [{ id: "all", title: "全部" }, { id: "mine", title: "我提交的" }, ...[...new Set(groups.map(group => group.proposalLocation?.employeeId).filter((id): id is string => Boolean(id)))].sort().map(id => ({ id: `employee:${id}`, title: id }))];
 const personMatches = (selected: string, actual?: string) => selected === "all" || (selected === "mine" ? Boolean(employeeId && actual && actual === employeeId) : Boolean(actual && selected === `employee:${actual}`));
 const proposalFiltered = phase !== "all" || proposer !== "all" || intake !== "all";
 const filtered = proposalFiltered;
 const clearFilters = () => updateProposalPreferences({ phase: "all", proposer: "all", intake: "all" });
 const summary = [
  phase !== "all" ? `阶段：${PROPOSAL_PHASE_OPTIONS.find(option => option.id === phase)?.title}` : "",
  proposer !== "all" ? `提交人：${proposerOptions.find(option => option.id === proposer)?.title ?? proposer.slice(9)}` : "",
  intake !== "all" ? "入库检查：需要处理" : "",
 ].filter(Boolean).join(" · ");
 const matchesProposalContext = (group: AIReqRequirementGroup) => (phase === "all" || String(proposalProgressIndex(group)) === phase)
  && personMatches(proposer, group.proposalLocation?.employeeId);
 const matchingGroups = groups.filter(group => matchesProposalContext(group) && (intake === "all" || proposalNeedsAttention(group)));
 const visibleGroups = matchingGroups.map(group => ({ group, time: sort === "created" ? proposalCreatedTime(group) : proposalUpdatedTime(group, aireq.view?.operations ?? []) }))
  .sort((a, b) => b.time - a.time || a.group.id.localeCompare(b.group.id)).map(item => item.group);
 const choose = (irId: string) => { aireq.select({projectId:aireq.selection.projectId,irId}); onNavigate?.(); };
 return <WorkspacePurposeSection icon={<FilePenLine aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />} title={title} open={open} onOpenChange={onOpenChange} sortable={false} sortableId="aireq-proposals" dragHandleLabel={title} testId="proposal-list" action={<>
   <ControlHintTooltip title={`搜索${title}`}><Button variant="ghost" size="icon-sm" aria-label={`搜索${title}`} aria-haspopup="dialog" className="shrink-0 text-foreground-subtle hover:text-foreground" onClick={onSearch}><Search className="size-3.5" /></Button></ControlHintTooltip>
   <DropdownMenu><ControlHintTooltip title="需求提案排序"><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="需求提案排序" className="shrink-0 text-foreground-subtle hover:text-foreground"><ArrowDownWideNarrow className="size-3.5" /></Button></DropdownMenuTrigger></ControlHintTooltip><DropdownMenuContent align="end"><DropdownMenuLabel>排序 · 降序</DropdownMenuLabel><DropdownMenuRadioGroup value={sort} onValueChange={setSort}><DropdownMenuRadioItem value="updated">最近更新</DropdownMenuRadioItem><DropdownMenuRadioItem value="created">创建时间</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
   <DropdownMenu><ControlHintTooltip title={`筛选${title}`}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`筛选${title}`} className={`shrink-0 text-foreground-subtle hover:text-foreground ${filtered ? "bg-selected" : ""}`}><ListFilter className="size-3.5" /></Button></DropdownMenuTrigger></ControlHintTooltip><DropdownMenuContent align="end">
    <>
     <DropdownMenuLabel>当前阶段</DropdownMenuLabel><DropdownMenuRadioGroup value={phase} onValueChange={setPhase}>{PROPOSAL_PHASE_OPTIONS.map(option => <DropdownMenuRadioItem key={option.id} value={option.id}>{option.title}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
     <DropdownMenuSeparator /><DropdownMenuLabel>提交人</DropdownMenuLabel><DropdownMenuRadioGroup value={proposer} onValueChange={setProposer}>{proposerOptions.map(option => <DropdownMenuRadioItem key={option.id} value={option.id}>{option.title}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
     <DropdownMenuSeparator /><DropdownMenuLabel>入库检查</DropdownMenuLabel><DropdownMenuCheckboxItem checked={intake === "attention"} onCheckedChange={checked => setIntake(checked === true ? "attention" : "all")}>需要处理</DropdownMenuCheckboxItem>
     <DropdownMenuSeparator /><DropdownMenuItem disabled={!proposalFiltered} onSelect={clearFilters}>清除全部筛选</DropdownMenuItem>
    </>
   </DropdownMenuContent></DropdownMenu>
  </>}>
  {filtered && <div className="flex items-center justify-between gap-2 px-4 pb-2 text-ui-sm text-foreground-subtle" data-testid="proposal-filter-summary">
   <p role="status" className="min-w-0 truncate" title={summary}>找到 {visibleGroups.length} 项</p>
   <ControlHintTooltip title={`清除筛选 · ${summary}`}><Button variant="ghost" size="sm" className="shrink-0 gap-1" aria-label={`清除${title}筛选`} onClick={clearFilters}><X className="size-3" />清除</Button></ControlHintTooltip>
  </div>}
  <div className="px-2">
					{visibleGroups.map(group => {
      const selected = !automationsActive && aireq.selection.irId === group.id && !aireq.selection.srId;
      const intakeIssue = proposalNeedsAttention(group);
      const processingHint = proposalProcessingHint(group);
      const processingLabel = intakeIssue ? `${processingHint} · ${proposalPhaseLabel(group)}` : `${proposalPhaseLabel(group)} · ${processingHint}`;
      const processingDescription = intakeIssue && group.proposalDelivery?.mergeCheck?.message ? `${processingLabel}：${group.proposalDelivery.mergeCheck.message}` : processingLabel;
      return <Button key={group.id} variant={selected ? "secondary" : "ghost"} className="mb-1 h-auto min-h-12 w-full min-w-0 justify-start gap-2 rounded-lg px-2.5 py-1.5 text-left font-normal focus-visible:ring-2 focus-visible:ring-ring/50" data-ir-id={group.id} aria-current={selected ? "page" : undefined} onClick={() => choose(group.id)}>
       <Badge variant="outline" className="h-4 min-w-5 justify-center rounded-sm border-border/70 bg-surface px-0.5 font-mono text-ui-xs font-medium text-foreground-subtle">IR</Badge>
       {/* 标题是可操作的主要内容；工号和阶段不能沿用最弱的 10px 装饰文字。 */}
       <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-1.5"><span className={`min-w-0 flex-1 truncate text-ui-base text-foreground ${selected ? "font-medium" : "font-normal"}`} title={group.title}>{group.title}</span>{intakeIssue && <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-warning-surface-foreground" />}</span><span className="mt-0.5 flex items-center justify-between gap-1 text-ui-sm text-foreground-subtle"><span className="shrink-0" title="提案提交人">提交 {group.proposalLocation?.employeeId ?? "未记录"}</span><span className={`truncate ${intakeIssue ? "text-warning-surface-foreground" : ""}`} title={processingDescription}>{processingLabel}</span></span></span>
      </Button>;
					})}
  {!visibleGroups.length && <p className="px-2.5 py-3 text-ui-sm text-foreground-subtle">{groups.length ? "没有符合筛选条件的内容。" : `当前 Release 暂无${title}。`}</p>}
  </div>
 </WorkspacePurposeSection>;
}
