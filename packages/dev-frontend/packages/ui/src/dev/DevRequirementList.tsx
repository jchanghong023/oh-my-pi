import { DevIrAcceptanceEntry } from "./DevIrAcceptance.js";
import { IR_ACCEPTANCE_LABELS, irAcceptanceVersionBlocker } from "./domain.js";
import { useState } from "react";
import { ProjectFolderIcon } from "@/project-sidebar/ProjectFolderIcon.js";
import { ArrowDownWideNarrow, ChevronDown, CircleDot, ListChevronsDownUp, ListChevronsUpDown, ListFilter, MessagesSquare, Search, X } from "lucide-react";
import { WorkspacePurposeSection } from "@/WorkspaceSidebar/WorkspacePurposeSection.js";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { PROPOSAL_STATUS_LABELS, proposalProgressIndex } from "./domain.js";
import { useOptionalDevDataSource } from "./data-source.js";
import { getEmployeeId } from "./identity.js";
import { PROPOSAL_PHASE_OPTIONS, proposalCreatedTime, proposalPhaseLabel, proposalProcessingHint, proposalUpdatedTime } from "./proposal-list.js";
import { readSidebarPreferences, updateSidebarPreferences } from "./navigation.js";
import { useDev, DEV_STAGE_LABELS } from "./DevContext.js";
import type { DevRequirementGroup } from "./types.js";

export function DevRequirementList({ title, groups, proposal = false, expandedIrIds, onExpandedChange, onSearch, onNavigate, automationsActive, open, onOpenChange }: {
 open: boolean; onOpenChange(open: boolean): void;
 title: string; groups: DevRequirementGroup[]; proposal?: boolean; expandedIrIds: string[];
 onExpandedChange(ids: string[]): void; onSearch(): void; onNavigate?: () => void; automationsActive?: boolean;
}) {
 const dev = useDev()!;
 const prototype = useOptionalDevDataSource()?.mode === "prototype";
 const proposalFilters = proposal && prototype;
 const [filter, setFilter] = useState("all");
 const preferenceScope = `${dev.selection.projectId}:${dev.releaseId}`;
 const [proposalPreferences, setProposalPreferences] = useState(() => readSidebarPreferences(preferenceScope).proposalList);
 const { phase, proposer, developer, sort } = proposalPreferences;
 const updateProposalPreferences = (patch: Partial<typeof proposalPreferences>) => {
  const next = { ...proposalPreferences, ...patch };
  updateSidebarPreferences(preferenceScope, { proposalList: next });
  setProposalPreferences(next);
 };
 const setPhase = (phase: string) => updateProposalPreferences({ phase });
 const setProposer = (proposer: string) => updateProposalPreferences({ proposer });
 const setDeveloper = (developer: string) => updateProposalPreferences({ developer });
 const setSort = (sort: string) => updateProposalPreferences({ sort });
 const options = proposal ? [{id:"all", title:"全部提案"},{id:"draft", title:"草稿"},{id:"solution-ready", title:"方案完成"},{id:"requirements-pr", title:"PR 待合并"}] : [{id:"all", title:"全部需求"},{id:"developing",title:"开发中"},{id:"pending",title:"待开发"},{id:"acceptance",title:"验收与交付"},{id:"completed",title:"已完成"}];
 const employeeId = getEmployeeId();
 const proposerOptions = [{ id: "all", title: "全部" }, { id: "mine", title: "我提出的" }, ...[...new Set(groups.map(group => group.proposalLocation?.employeeId).filter((id): id is string => Boolean(id)))].sort().map(id => ({ id: `employee:${id}`, title: id }))];
 const developerOptions = [{ id: "all", title: "全部" }, { id: "unaccepted", title: "未接手" }, { id: "mine", title: "我接手的" }, ...[...new Set(groups.map(group => group.developerAcceptance?.employeeId).filter((id): id is string => Boolean(id)))].sort().map(id => ({ id: `employee:${id}`, title: id }))];
 const personMatches = (selected: string, actual?: string) => selected === "all" || (selected === "mine" ? Boolean(employeeId && actual && actual === employeeId) : selected === "unaccepted" ? !actual : Boolean(actual && selected === `employee:${actual}`));
 const proposalFiltered = phase !== "all" || proposer !== "all" || developer !== "all";
 const filtered = proposalFilters ? proposalFiltered : filter !== "all";
 const clearFilters = () => { if (proposalFilters) updateProposalPreferences({ phase: "all", proposer: "all", developer: "all" }); else setFilter("all"); };
 const summary = proposalFilters ? [
  phase !== "all" ? `阶段：${PROPOSAL_PHASE_OPTIONS.find(option => option.id === phase)?.title}` : "",
  proposer !== "all" ? `提出人：${proposerOptions.find(option => option.id === proposer)?.title ?? proposer.slice(9)}` : "",
  developer !== "all" ? `方案开发：${developerOptions.find(option => option.id === developer)?.title ?? developer.slice(9)}` : "",
 ].filter(Boolean).join(" · ") : options.find(option => option.id === filter)?.title;
 const matchingGroups = groups.filter(group => {
  if (proposalFilters) return (phase === "all" || String(proposalProgressIndex(group)) === phase)
   && personMatches(proposer, group.proposalLocation?.employeeId)
   && personMatches(developer, group.developerAcceptance?.employeeId);
  if (filter === "all") return true;
  if (proposal) return group.status === filter;
  const srs = dev.view?.srs.filter(sr => sr.irId === group.id) ?? [];
  const status = group.acceptance?.status === "completed" ? "completed" : group.acceptance || (srs.length && srs.every(sr => sr.status === "completed")) ? "acceptance" : srs.some(sr => sr.status === "developing") ? "developing" : "pending";
  return status === filter;
 });
 const visibleGroups = proposalFilters ? matchingGroups.map(group => ({ group, time: sort === "created" ? proposalCreatedTime(group) : proposalUpdatedTime(group, dev.view?.operations ?? []) }))
  .sort((a, b) => b.time - a.time || a.group.id.localeCompare(b.group.id)).map(item => item.group) : matchingGroups;
 const choose = (irId: string) => { dev.select({projectId:dev.selection.projectId,irId}); onNavigate?.(); };
 const hasExpanded = visibleGroups.some(group => expandedIrIds.includes(group.id));
 const toggleAll = () => {
  const ids = new Set(visibleGroups.map(group => group.id));
  onExpandedChange(hasExpanded ? expandedIrIds.filter(id => !ids.has(id)) : [...new Set([...expandedIrIds, ...ids])]);
  onOpenChange(true);
 };
 return <WorkspacePurposeSection icon={<ProjectFolderIcon rootCount={1} open={open} aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />} title={title} open={open} onOpenChange={onOpenChange} sortable={false} sortableId={proposal ? "dev-proposals" : "dev-formal"} dragHandleLabel={title} testId={proposal ? "proposal-list" : "formal-list"} action={<>
   <ControlHintTooltip title={`${hasExpanded ? "收起" : "展开"}全部${title}`}><Button variant="ghost" size="icon-sm" className="text-foreground-subtle hover:text-foreground" aria-label={`${hasExpanded ? "收起" : "展开"}全部${title}`} disabled={!visibleGroups.length} onClick={toggleAll}>{hasExpanded ? <ListChevronsDownUp className="size-3.5" /> : <ListChevronsUpDown className="size-3.5" />}</Button></ControlHintTooltip>
   <ControlHintTooltip title={`搜索${title}`}><Button variant="ghost" size="icon-sm" aria-label={`搜索${title}`} aria-haspopup="dialog" className="shrink-0 text-foreground-subtle hover:text-foreground" onClick={onSearch}><Search className="size-3.5" /></Button></ControlHintTooltip>
   {proposalFilters && <DropdownMenu><ControlHintTooltip title="需求提案排序"><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="需求提案排序" className="shrink-0 text-foreground-subtle hover:text-foreground"><ArrowDownWideNarrow className="size-3.5" /></Button></DropdownMenuTrigger></ControlHintTooltip><DropdownMenuContent align="end"><DropdownMenuLabel>排序 · 降序</DropdownMenuLabel><DropdownMenuRadioGroup value={sort} onValueChange={setSort}><DropdownMenuRadioItem value="updated">最近更新</DropdownMenuRadioItem><DropdownMenuRadioItem value="created">创建时间</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>}
   <DropdownMenu><ControlHintTooltip title={`筛选${title}`}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`筛选${title}`} className={`shrink-0 text-foreground-subtle hover:text-foreground ${filtered ? "bg-selected" : ""}`}><ListFilter className="size-3.5" /></Button></DropdownMenuTrigger></ControlHintTooltip><DropdownMenuContent align="end">
    {proposalFilters ? <>
     <DropdownMenuLabel>当前阶段</DropdownMenuLabel><DropdownMenuRadioGroup value={phase} onValueChange={setPhase}>{PROPOSAL_PHASE_OPTIONS.map(option => <DropdownMenuRadioItem key={option.id} value={option.id}>{option.title}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
     <DropdownMenuSeparator /><DropdownMenuLabel>提出人</DropdownMenuLabel><DropdownMenuRadioGroup value={proposer} onValueChange={setProposer}>{proposerOptions.map(option => <DropdownMenuRadioItem key={option.id} value={option.id}>{option.title}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
     <DropdownMenuSeparator /><DropdownMenuLabel>方案开发人员</DropdownMenuLabel><DropdownMenuRadioGroup value={developer} onValueChange={setDeveloper}>{developerOptions.map(option => <DropdownMenuRadioItem key={option.id} value={option.id}>{option.title}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
     <DropdownMenuSeparator /><DropdownMenuItem disabled={!proposalFiltered} onSelect={clearFilters}>清除全部筛选</DropdownMenuItem>
    </> : <DropdownMenuRadioGroup value={filter} onValueChange={setFilter}>{options.map(option => <DropdownMenuRadioItem key={option.id} value={option.id}><CircleDot className="size-4 text-foreground-subtle" />{option.title}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>}
   </DropdownMenuContent></DropdownMenu>
  </>}>
  {filtered && (proposalFilters ? <div className="flex items-center justify-between gap-1 px-4 pb-2 text-ui-sm text-foreground-subtle"><span className="min-w-0 break-words">{summary}</span><Button variant="ghost" size="sm" className="shrink-0 gap-1" aria-label={`清除${title}筛选`} onClick={clearFilters}><X className="size-3" />清除全部</Button></div> : <div className="flex items-center justify-between px-4 pb-2 text-ui-sm text-foreground-subtle"><span>{summary}</span><Button variant="ghost" size="icon-xs" aria-label={`清除${title}筛选`} onClick={clearFilters}><X className="size-3" /></Button></div>)}
  <div className="px-2">
					{visibleGroups.map(group => {
						const expanded = expandedIrIds.includes(group.id);
						const srs = dev.view?.srs.filter(sr => sr.irId === group.id) ?? [];
						return <Collapsible key={group.id} open={expanded} onOpenChange={open => onExpandedChange(open ? [...expandedIrIds, group.id] : expandedIrIds.filter(id => id !== group.id))} className="mb-1">
							<div className="group/ir-row flex min-w-0 items-center rounded-lg hover:bg-menu-hover">
								<CollapsibleTrigger asChild><Button variant="ghost" className={`${proposal ? "h-auto min-h-12 py-1.5" : "h-8"} min-w-0 flex-1 justify-start gap-2 rounded-lg pr-1 pl-2.5 text-left hover:bg-transparent`} data-ir-id={group.id}>
									<Badge variant="outline" className="h-4 min-w-5 justify-center rounded-sm border-border/70 bg-surface px-0.5 font-mono text-ui-xs font-medium text-foreground-subtle">IR</Badge><span className="min-w-0 flex-1 text-foreground-subtle"><span className="block truncate" title={group.title}>{group.title}</span>{proposal && <span className="mt-0.5 flex items-center justify-between gap-1 text-ui-xs text-foreground-subtlest"><span className="shrink-0 font-mono" title="提案提出人">提出 {group.proposalLocation?.employeeId ?? "未记录"}</span><span className="truncate">{proposalFilters ? `${proposalPhaseLabel(group)} · ${proposalProcessingHint(group)}` : proposalProcessingHint(group)}</span></span>}</span><span className="text-ui-sm text-foreground-subtlest">{proposal ? "" : group.acceptance ? dev.view && irAcceptanceVersionBlocker(dev.view, group) ? "待重新验收" : IR_ACCEPTANCE_LABELS[group.acceptance.status] : srs.length && srs.every(sr => sr.status === "completed") ? "待验收" : srs.length}</span><ChevronDown className={`size-3 shrink-0 text-foreground-subtlest transition-transform ${expanded ? "" : "-rotate-90"}`} aria-hidden="true" />
								</Button></CollapsibleTrigger>
								<div className="mr-1 flex shrink-0 items-center opacity-0 transition-opacity group-hover/ir-row:opacity-100 group-focus-within/ir-row:opacity-100 [@media(hover:none)]:opacity-100"><ControlHintTooltip title="需求讨论"><Button variant="ghost" size="icon-sm" aria-label={`${group.title}：需求讨论`} aria-pressed={dev.selection.irId === group.id && !dev.selection.srId && !dev.selection.irAcceptance} onClick={() => choose(group.id)}><MessagesSquare className="size-3.5 text-foreground-subtle" /></Button></ControlHintTooltip>{!proposal && <DevIrAcceptanceEntry group={group} compact onNavigate={onNavigate} />}</div>
							</div>
							<CollapsibleContent data-testid={`ir-srs-${group.id}`}><div className="space-y-1 pt-1 pl-2">
{srs.length === 0 && <p className="px-6 py-2 text-ui-sm text-foreground-subtle">尚未拆分 SR，可先进入需求讨论。</p>}
								{srs.map(sr => <Button key={sr.id} variant={!automationsActive && dev.selection.srId === sr.id ? "secondary" : "ghost"} className="h-8 w-full min-w-0 justify-start gap-2 pr-2.5 pl-6.5 text-left font-normal" data-sr-id={sr.id} aria-current={!automationsActive && dev.selection.srId === sr.id ? "page" : undefined} onClick={() => { dev.select({ projectId: dev.selection.projectId, irId: group.id, srId: sr.id }); onNavigate?.(); }}>
									<Badge variant="outline" className="h-4 min-w-5 justify-center rounded-sm border-border/70 bg-transparent px-0.5 font-mono text-ui-xs font-medium text-foreground-subtle">SR</Badge><span className="min-w-0 flex-1 truncate" title={sr.title}>{sr.title}</span><span className="shrink-0 text-ui-sm text-foreground-subtlest">{proposal ? proposalFilters ? proposalPhaseLabel(group) : group.status === "draft" ? group.proposalStage === "solution" ? "方案" : "业务需求" : PROPOSAL_STATUS_LABELS[group.status] : sr.status === "completed" ? "已完成" : sr.stage ? DEV_STAGE_LABELS[sr.stage] : "待开始"}</span>
								</Button>)}
							</div></CollapsibleContent>
						</Collapsible>;
					})}
  {!visibleGroups.length && <p className="px-2.5 py-3 text-ui-sm text-foreground-subtle">{groups.length ? "没有符合筛选条件的内容。" : `当前 Release 暂无${title}。`}</p>}
  </div>
 </WorkspacePurposeSection>;
}
