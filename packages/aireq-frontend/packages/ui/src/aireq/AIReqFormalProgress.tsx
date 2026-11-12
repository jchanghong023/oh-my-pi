import { WorkspaceSidebarToolbar } from "@/WorkspaceSidebarToolbar.js";
import type { WorkspaceSidebarToolbarProps } from "@/WorkspaceSidebarToolbar.js";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, CircleDashed, CircleDot, ClipboardCheck, GitMerge, ChevronDown, ChevronLeft, ChevronRight, FileText, PanelRightClose, Search } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Progress } from "@/components/ui/progress.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { MarkdownTableBody, MarkdownTableCell, MarkdownTableHead, MarkdownTableHeader, MarkdownTableRow } from "@/components/ai-elements/markdown-table.js";
import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from "@/components/ui/resizable.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { AIReqMaterialsPane } from "./AIReqWorkbench.js";
import { useAIReq } from "./AIReqContext.js";
import { useAIReqDataSource } from "./data-source.js";
import { getEmployeeId } from "./identity.js";
import { AssignOwner, AIReqDependencies, AIReqEditPlanning, AIReqPlanningSummary } from "./AIReqRequirementPlanning.js";
import { irPlanning, planningDate, planningWarnings, srDependencies } from "./planning.js";
import { irProgress, irProgressStatus, irSrs, progressLabel, PROGRESS_STATUSES, srProgress, srProgressStatus } from "./progress.js";
import type { AIReqProgressStatus } from "./progress.js";
import type { AIReqRequirementGroup, AIReqSystemRequirement } from "./types.js";
import { BranchCopy } from "./BranchCopy.js";
import { AIReqEmployeePicker } from "./AIReqEmployeePicker.js";

// 复用主题语义色；待合入／待验收表示等待人工处理，不表示异常或失败。
const progressAppearance = {
  待开发: { badge: "bg-tag text-foreground-subtle", indicator: "bg-foreground-subtle", icon: CircleDashed },
  开发中: { badge: "bg-progress-surface text-progress-surface-foreground", indicator: "bg-progress-surface-foreground", icon: CircleDot },
  待合入: { badge: "bg-warning-surface text-warning-surface-foreground", indicator: "bg-warning", icon: GitMerge },
  待验收: { badge: "bg-warning-surface text-warning-surface-foreground", indicator: "bg-warning", icon: ClipboardCheck },
  已完成: { badge: "bg-success-surface text-success-surface-foreground", indicator: "bg-success", icon: CheckCircle2 },
} satisfies Record<AIReqProgressStatus, { badge: string; indicator: string; icon: typeof CircleDot }>;

function ProgressStatusBadge({ status }: { status: AIReqProgressStatus }) {
  const appearance = progressAppearance[status];
  const Icon = appearance.icon;
  return <Badge variant="secondary" className={`gap-1 whitespace-nowrap ${appearance.badge}`} data-progress-status={status}><Icon aria-hidden="true" />{status}</Badge>;
}

function ProgressValue({ value, label, status, source, showStatus = true }: { value: number; label: string; status: AIReqProgressStatus; source?: string; showStatus?: boolean }) {
  const indicator = <Progress value={value} aria-label={`${label}进度`} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-valuetext={`${status} · ${progressLabel(value)}`} className="h-1 min-w-12 flex-1" indicatorClassName={progressAppearance[status].indicator} />;
  const percent = <span className="shrink-0 text-right text-ui-sm"><span className="font-mono tabular-nums">{progressLabel(value)}</span>{source && <span className="ml-2 text-ui-xs text-foreground-subtle">{source}</span>}</span>;
  return showStatus ? <div className="min-w-28 space-y-1.5"><div className="flex items-center justify-between gap-2"><ProgressStatusBadge status={status} />{percent}</div>{indicator}</div> : <div className="flex min-w-28 items-center gap-2">{indicator}{percent}</div>;
}
interface FormalNavigationProps { navigationOpen: boolean; onToggleNavigation(): void; toolbar: WorkspaceSidebarToolbarProps }

export function AIReqFormalTable({ navigationOpen, toolbar }: FormalNavigationProps) {
  const source = useAIReqDataSource();
  const aireq = useAIReq()!;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [owner, setOwner] = useState("all");
  const [ownerEmployeeId, setOwnerEmployeeId] = useState("");
  const [expanded, setExpanded] = useState(() => new Set(aireq.view?.groups.slice(0, 1).map(group => group.id)));
  const [filteredExpansion, setFilteredExpansion] = useState<Record<string, boolean>>({});
  const [copyMessage, setCopyMessage] = useState("");
  const view = aireq.view;
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const scrollId = useId();
  const scrollDescriptionId = useId();
  const [columns, setColumns] = useState({ canLeft: false, canRight: false, hiddenLeft: 0, hiddenRight: 0 });
  const ready = Boolean(view);
  useEffect(() => {
    const viewport = scrollRef.current;
    const table = tableRef.current;
    if (!viewport || !table) return;
    const headers = Array.from(table.tHead?.rows[0]?.cells ?? []);
    const measure = () => {
      const bounds = viewport.getBoundingClientRect();
      const stickyWidth = headers[0]?.getBoundingClientRect().width ?? 0;
      let hiddenLeft = 0;
      let hiddenRight = 0;
      for (const header of headers.slice(1)) {
        const cell = header.getBoundingClientRect();
        if (cell.left < bounds.left + stickyWidth - 2) hiddenLeft++;
        if (cell.right > bounds.right + 2) hiddenRight++;
      }
      const next = {
        canLeft: viewport.scrollLeft > 2,
        canRight: viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft > 2,
        hiddenLeft,
        hiddenRight,
      };
      setColumns(current => current.canLeft === next.canLeft && current.canRight === next.canRight &&
        current.hiddenLeft === next.hiddenLeft && current.hiddenRight === next.hiddenRight ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(table);
    viewport.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [ready]);
  const scrollColumns = (direction: -1 | 1) => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const stickyWidth = tableRef.current?.tHead?.rows[0]?.cells[0]?.getBoundingClientRect().width ?? 208;
    viewport.scrollBy({ left: direction * Math.max(160, viewport.clientWidth - stickyWidth - 32) });
  };
  if (!view) return <p role="status" className="p-6">正在读取正式需求…</p>;
  const groups = view.groups.filter(group => group.releaseId === aireq.releaseId);
  const normalized = query.trim().toLocaleLowerCase();
  const open = (group: AIReqRequirementGroup, sr?: AIReqSystemRequirement) => aireq.select({ projectId: group.projectId, irId: group.id, srId: sr?.id, formalView: "detail" });
  const matches = (id: string, title: string) => !normalized || `${id} ${title}`.toLocaleLowerCase().includes(normalized);
  const visible = groups.filter(group => {
    const rows = irSrs(view, group);
    return (owner !== "mine" || group.ownerEmployeeId === getEmployeeId() || rows.some(sr => sr.planning?.developerEmployeeId === getEmployeeId())) &&
      (owner !== "unassigned" || !group.ownerEmployeeId) &&
      (owner !== "specified" || !ownerEmployeeId.trim() || group.ownerEmployeeId === ownerEmployeeId.trim()) &&
      (matches(group.id, group.title) || rows.some(sr => matches(sr.id, sr.title))) &&
      (status === "all" || irProgressStatus(rows) === status || rows.some(sr => srProgressStatus(sr) === status));
  });
  const latest = (rows: AIReqSystemRequirement[]) => rows.map(sr => sr.progress?.analysedAt ?? "").sort().at(-1);
  const date = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "尚未分析";
  return <main className="flex h-full min-h-0 min-w-0 flex-col bg-background" data-testid="aireq-formal-table">
    <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-4 py-4 md:px-6 md:py-6">
    <header className="shrink-0 space-y-3 border-b border-border pb-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">{!navigationOpen && <WorkspaceSidebarToolbar {...toolbar} />}<h1 className="shrink-0 text-ui-base font-semibold">正式需求</h1></div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select value={aireq.selection.projectId ?? ""} onValueChange={projectId => aireq.select({ projectId, formalView: "list" })}><SelectTrigger className="h-7 w-40" aria-label="正式需求项目"><SelectValue placeholder="选择项目" /></SelectTrigger><SelectContent>{view.projects.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
          <Select value={aireq.releaseId} onValueChange={aireq.setReleaseId}><SelectTrigger className="h-7 w-44" aria-label="正式需求版本"><SelectValue placeholder="选择版本" /></SelectTrigger><SelectContent>{view.releases.map(item => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select>
          <span className="text-ui-xs text-foreground-subtle" data-testid="formal-counts"><span className="whitespace-nowrap font-medium text-foreground">当前筛选 {visible.length} 个 IR</span><span className="ml-3 inline-block">项目总计（当前版本）{groups.length} 个 IR · {groups.reduce((count, group) => count + irSrs(view, group).length, 0)} 个 SR</span></span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-40 flex-1"><Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-foreground-subtle" /><Input className="h-7 pl-8" aria-label="搜索正式需求" placeholder="搜索 IR／SR 名称或编号" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <Select value={status} onValueChange={setStatus}><SelectTrigger className="h-7 w-28" aria-label="筛选开发状态"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem>{PROGRESS_STATUSES.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select>
        <Select value={owner} onValueChange={value => { setOwner(value); setOwnerEmployeeId(""); }}><SelectTrigger className="h-7 w-40" aria-label="筛选需求负责人"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部需求</SelectItem><SelectItem value="mine">我负责的</SelectItem><SelectItem value="specified">指定 IR 负责人</SelectItem><SelectItem value="unassigned">未分配 IR 负责人</SelectItem></SelectContent></Select>
        {owner === "specified" && <Popover><PopoverTrigger asChild><Button variant="outline" size="sm" className="h-7" aria-label="输入或选择 IR 负责人">{ownerEmployeeId.trim() || "输入或选择工号"}</Button></PopoverTrigger><PopoverContent align="end" className="max-h-[70dvh] w-96 overflow-y-auto" aria-label="筛选 IR 负责人"><AIReqEmployeePicker value={ownerEmployeeId} onChange={setOwnerEmployeeId} ownerIds={groups.flatMap(group => group.ownerEmployeeId ? [group.ownerEmployeeId] : [])} />{!ownerEmployeeId.trim() && <p role="status" className="mt-2 text-ui-xs text-foreground-subtle">选择后按工号精确筛选；当前尚未限定负责人。</p>}</PopoverContent></Popover>}
        {(normalized || status !== "all" || owner !== "all") && <Button variant="ghost" size="sm" onClick={() => { setQuery(""); setStatus("all"); setOwner("all"); setOwnerEmployeeId(""); }}>清除筛选</Button>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={scrollDescriptionId} className="text-ui-xs text-foreground-subtle">
          共 9 列 · 名称列固定。{columns.canLeft || columns.canRight ? `左侧 ${columns.hiddenLeft} 列、右侧 ${columns.hiddenRight} 列未完整显示；使用按钮或聚焦表格后按 ← / →，Home / End 到首尾。` : "全部列已显示；窗口变窄时可横向滚动。"}
        </p>
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="横向查看正式需求列">
          <Button type="button" variant="outline" size="sm" aria-controls={scrollId} aria-label="向左查看前面的列" disabled={!columns.canLeft} onClick={() => scrollColumns(-1)}><ChevronLeft className="size-3.5" />前面的列</Button>
          <Button type="button" variant="outline" size="sm" aria-controls={scrollId} aria-label="向右查看后面的列" disabled={!columns.canRight} onClick={() => scrollColumns(1)}>后面的列<ChevronRight className="size-3.5" /></Button>
        </div>
      </div>
    </header>
    <div ref={scrollRef} id={scrollId} role="region" aria-label="正式需求表格横向滚动区域" aria-describedby={scrollDescriptionId} tabIndex={0} className="mt-3 min-h-0 flex-1 overflow-auto rounded-xl border border-border bg-background focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" data-testid="formal-table-scroll" onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        scrollColumns(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        event.currentTarget.scrollTo({ left: event.key === "Home" ? 0 : event.currentTarget.scrollWidth });
      }
    }}>
      <table ref={tableRef} className="w-full min-w-[1280px] table-fixed border-separate border-spacing-0 text-ui-base" aria-label="正式需求 IR SR 开发进度表">
        <colgroup><col className="w-52" /><col className="w-36" /><col className="w-36" /><col className="w-56" /><col className="w-36" /><col className="w-32" /><col className="w-32" /><col className="w-16" /><col className="w-24" /></colgroup>
        <MarkdownTableHeader className="sticky top-0 z-20 bg-background"><MarkdownTableRow>{["需求", "状态与进度", "负责人 / 开发人员", "开发分支 · 点击复制", "依赖关系", "计划开始", "计划结束", "问题", "最近分析"].map((title, index) => <MarkdownTableHead key={title} scope="col" className={`whitespace-nowrap bg-background px-2 font-medium text-foreground-subtle ${index === 0 ? "sticky left-0 z-30" : ""}`}>{title}</MarkdownTableHead>)}</MarkdownTableRow></MarkdownTableHeader>
        <MarkdownTableBody>{visible.map(group => {
          const srs = irSrs(view, group);
          const groupMatches = matches(group.id, group.title);
          const children = srs.filter(sr => (groupMatches || matches(sr.id, sr.title)) && (status === "all" || irProgressStatus(srs) === status || srProgressStatus(sr) === status));
          const expansionKey = JSON.stringify([group.projectId, group.id, normalized, status]);
          const filteringChildren = Boolean(normalized) || status !== "all";
          const showChildren = filteringChildren ? filteredExpansion[expansionKey] ?? true : expanded.has(group.id);
          const selected = aireq.selection.irId === group.id && !aireq.selection.srId;
          const plan = irPlanning(srs);
          const developers = [...new Set(srs.flatMap(sr => sr.planning?.developerEmployeeId ? [sr.planning.developerEmployeeId] : []))];
          const dependencies = srs.reduce((count, sr) => count + srDependencies(view, sr).length, 0);
          // 主题行色含透明度：固定列在不透明底色上叠加同一行色，避免滚动透字和双层选中色。
          return <Fragment key={group.id}>
            <MarkdownTableRow data-ir-id={group.id} aria-selected={selected} className={`cursor-pointer ${selected ? "bg-selected hover:bg-selected [--formal-row-fill:var(--color-selected)]" : "bg-surface hover:bg-hover [--formal-row-fill:var(--color-surface)] hover:[--formal-row-fill:var(--color-hover)]"}`} onClick={() => open(group)}>
              <MarkdownTableCell className="sticky left-0 z-10 bg-background px-2" style={{ backgroundImage: "linear-gradient(var(--formal-row-fill), var(--formal-row-fill))" }}><div className="flex items-start gap-2"><Button size="icon-sm" variant="ghost" aria-label={`${showChildren ? "收起" : "展开"}${group.title}的SR`} aria-expanded={showChildren} onClick={event => { event.stopPropagation(); if (filteringChildren) { setFilteredExpansion(current => ({ ...current, [expansionKey]: !showChildren })); } else { setExpanded(current => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; }); } }}>{showChildren ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</Button><div className="min-w-0"><Button variant="link" className="h-auto max-w-full justify-start p-0 text-left font-medium whitespace-normal" onClick={event => { event.stopPropagation(); open(group); }}>{group.title}</Button><p className="mt-1 font-mono text-ui-xs text-foreground-subtle">IR · {group.id} · {srs.filter(sr => srProgress(sr) === 100).length}/{srs.length} SR 完成</p></div></div></MarkdownTableCell>
              <MarkdownTableCell className="px-2"><ProgressValue value={irProgress(srs)} label={group.title} status={irProgressStatus(srs)} /></MarkdownTableCell>
              <MarkdownTableCell className="px-2"><AssignOwner group={group} /><p className="mt-1 text-ui-xs text-foreground-subtle" title={developers.join("、")}>{developers.length} 名开发人员</p></MarkdownTableCell>
              <MarkdownTableCell className="px-2 text-ui-sm text-foreground-subtle">见各 SR 开发分支</MarkdownTableCell>
              <MarkdownTableCell className="px-2 text-ui-sm text-foreground-subtle">{dependencies ? `${dependencies} 条依赖 · 见各 SR` : "无前置依赖"}</MarkdownTableCell>
              <MarkdownTableCell className="px-2 text-ui-sm tabular-nums" title={plan.plannedStart?.replace("T", " ")}><p>{planningDate(plan.plannedStart)}</p>{plan.incomplete && <p className="mt-1 text-foreground-subtle">部分未排期</p>}</MarkdownTableCell>
              <MarkdownTableCell className="px-2 text-ui-sm tabular-nums" title={plan.plannedEnd?.replace("T", " ")}>{planningDate(plan.plannedEnd)}</MarkdownTableCell>
              <MarkdownTableCell className="px-2 tabular-nums">{srs.reduce((count, sr) => count + (sr.progress?.issues.length ?? 0), 0)} 项</MarkdownTableCell>
              <MarkdownTableCell className="whitespace-nowrap px-2 text-ui-xs text-foreground-subtle" title={latest(srs)}>{date(latest(srs))}</MarkdownTableCell>
            </MarkdownTableRow>
            {showChildren && children.map(sr => <MarkdownTableRow key={sr.id} data-sr-id={sr.id} aria-selected={aireq.selection.irId === group.id && aireq.selection.srId === sr.id} className={`cursor-pointer ${aireq.selection.irId === group.id && aireq.selection.srId === sr.id ? "bg-selected hover:bg-selected [--formal-row-fill:var(--color-selected)]" : "hover:bg-hover [--formal-row-fill:transparent] hover:[--formal-row-fill:var(--color-hover)]"}`} onClick={() => open(group, sr)}>
              <MarkdownTableCell className="sticky left-0 z-10 bg-background pr-2 pl-9" style={{ backgroundImage: "linear-gradient(var(--formal-row-fill), var(--formal-row-fill))" }}><Button variant="link" className="h-auto max-w-full p-0 text-left whitespace-normal" onClick={event => { event.stopPropagation(); open(group, sr); }}>{sr.title}</Button><p className="mt-1 font-mono text-ui-xs text-foreground-subtle">SR · {sr.id}</p></MarkdownTableCell>
              <MarkdownTableCell className="px-2"><ProgressValue value={srProgress(sr)} label={sr.title} status={srProgressStatus(sr)} /></MarkdownTableCell>
              <MarkdownTableCell className="px-2"><AIReqEditPlanning group={group} sr={sr} compact /><p className="mt-1 text-ui-xs text-foreground-subtle">{sr.planning?.source === "manual" ? "人工调整" : sr.planning ? "AI 建议" : "待分析"}</p></MarkdownTableCell>
              <MarkdownTableCell className="px-2">{sr.trackingBranch?.name || sr.progress?.branch ? <BranchCopy key={sr.trackingBranch?.name || sr.progress?.branch} branch={sr.trackingBranch?.name || sr.progress!.branch} onMessage={setCopyMessage} /> : <span className="text-ui-sm text-foreground-subtle">尚未关联分支</span>}</MarkdownTableCell>
              <MarkdownTableCell className="px-2"><AIReqDependencies sr={sr} view={view} />{planningWarnings(view, sr).length > 0 && <p className="mt-1 text-ui-xs" title={planningWarnings(view, sr).join("\n")}>需协调排期</p>}</MarkdownTableCell>
              <MarkdownTableCell className="whitespace-nowrap px-2 text-ui-sm tabular-nums" title={sr.planning?.plannedStart?.replace("T", " ")}>{planningDate(sr.planning?.plannedStart)}</MarkdownTableCell>
              <MarkdownTableCell className="whitespace-nowrap px-2 text-ui-sm tabular-nums" title={sr.planning?.plannedEnd?.replace("T", " ")}>{planningDate(sr.planning?.plannedEnd)}</MarkdownTableCell>
              <MarkdownTableCell className="px-2 tabular-nums">{sr.progress?.issues.length ?? 0} 项</MarkdownTableCell><MarkdownTableCell className="whitespace-nowrap px-2 text-ui-xs text-foreground-subtle" title={sr.progress?.analysedAt}>{date(sr.progress?.analysedAt)}</MarkdownTableCell>
            </MarkdownTableRow>)}
          </Fragment>;
        })}</MarkdownTableBody>
      </table>
      {!visible.length && <p role="status" className="py-12 text-center text-ui-sm text-foreground-subtle">{groups.length ? "没有符合条件的需求。" : "当前版本尚无正式需求。"}</p>}
    </div>
    <p role="status" aria-live="polite" className="shrink-0 text-ui-xs text-foreground-subtle">{copyMessage}</p>
    <p className="shrink-0 py-2 text-ui-xs text-foreground-subtle">可横向滚动查看全部列，名称列固定。{source.provenance.kind === "sample" ? "原型分配与排期保存于后端内存，刷新保留、后端重启恢复；" : "人员与排期由后台保存；"}IR 时间由 SR 汇总，进度为 SR 平均值。</p>
    </div>
  </main>;
}

function ReportSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-3 border-t border-border pt-5"><h2 className="text-ui-base font-medium">{title}</h2>{children}</section>;
}
function ManualProgress({ group, sr }: { group: AIReqRequirementGroup; sr: AIReqSystemRequirement }) {
  const source = useAIReqDataSource();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(srProgress(sr)));
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const canEdit = getEmployeeId() === "j00808874" || getEmployeeId() === group.ownerEmployeeId;
  if (!canEdit) return null;
  const start = (percent: number) => { setValue(String(percent)); setReason(""); setError(""); setOpen(true); };
  const completionBlocker = !sr.progress ? "尚无代码分析报告，无法确认合入状态与完成情况。"
    : !sr.progress.merged ? "代码尚未合入默认分支，进度最高 99%，不能确认完成。"
    : srProgress(sr) === 100 ? "当前 SR 已完成，无需重复确认。" : undefined;
  return <>
    <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => start(srProgress(sr))}>调整进度</Button><Button variant="outline" size="sm" disabled={Boolean(completionBlocker)} aria-describedby={completionBlocker ? `${id}-completion-reason` : undefined} onClick={() => start(100)}>人工确认完成</Button>{completionBlocker && <p id={`${id}-completion-reason`} className="w-full text-ui-sm leading-5 text-foreground-subtle">{completionBlocker}</p>}</div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>人工调整进度</DialogTitle><DialogDescription>{sr.title} · {sr.progress?.merged ? "已合入默认分支，可根据证据确认完成。" : "尚未合入默认分支，进度最高 99%，不能确认完成。"}</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={async event => { event.preventDefault(); setSaving(true); setError(""); try { await source.progress!.updateSr(group.projectId, group.id, sr.id, Number(value), reason); setOpen(false); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setSaving(false); } }}>
        <div className="space-y-2"><Label htmlFor={`${id}-percent`}>实现进度（%）</Label><Input id={`${id}-percent`} type="number" min={0} max={sr.progress?.merged ? 100 : 99} step={1} required value={value} onChange={event => setValue(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor={`${id}-reason`}>判断依据</Label><SettingsFormTextarea id={`${id}-reason`} required value={reason} onChange={event => setReason(event.target.value)} placeholder="说明调整进度或确认完成的依据" /></div>
        {error && <p role="alert" className="text-ui-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button><Button disabled={saving || !reason.trim()} type="submit">{saving ? "保存中…" : "保存调整"}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
  </>;
}

function AIReqFormalReport() {
  const aireq = useAIReq()!;
  const source = useAIReqDataSource();
  const view = aireq.view;
  const group = view?.groups.find(item => item.id === aireq.selection.irId);
  if (!view || !group) return <p role="status" className="p-6">所选正式需求不可用，请在表格重新选择。</p>;
  const all = irSrs(view, group);
  const selected = aireq.selection.srId ? all.find(sr => sr.id === aireq.selection.srId) : undefined;
  if (aireq.selection.srId && !selected) return <p role="alert" className="p-6">所选 SR 不属于当前 IR。</p>;
  const rows = selected ? [selected] : all;
  const title = selected?.title ?? group.title;
  const percent = selected ? srProgress(selected) : irProgress(all);
  const status = selected ? srProgressStatus(selected) : irProgressStatus(all);
  const project = view.projects.find(item => item.id === group.projectId);
  const analysedAt = rows.map(sr => sr.progress?.analysedAt ?? "").sort().at(-1);
  const issues = rows.flatMap(sr => (sr.progress?.issues ?? []).map(issue => ({ ...issue, sr })));
  const evidence = (kind: "implemented" | "remaining") => rows.flatMap(sr => (sr.progress?.[kind] ?? []).map(text => <li key={`${sr.id}:${text}`} className="leading-6">{!selected && <span className="font-medium">{sr.title}： </span>}{text}</li>));
  const manual = selected?.progress?.manual;
  const hasAnalysis = rows.some(sr => sr.progress);
  const progressSource = manual ? percent === 100 ? "人工确认" : "人工调整" : selected ? hasAnalysis ? "AI 分析" : "尚未分析" : undefined;
  return <main className="h-full min-h-0 overflow-auto bg-background" data-testid="aireq-formal-report">
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-4 md:px-6 md:py-6">
      <header className="space-y-3"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{selected ? "SR" : "IR"}</Badge><span className="font-mono text-ui-xs text-foreground-subtle">{selected?.id ?? group.id}</span><ProgressStatusBadge status={status} /><Badge variant="outline">{hasAnalysis ? source.provenance.kind === "sample" ? "原型预置报告" : "进度分析报告" : "尚未分析"}</Badge></div><h1 className="text-ui-lg font-semibold">{title}</h1><div className="flex flex-wrap items-center gap-2 text-ui-sm"><span className="text-foreground-subtle">需求负责人</span><AssignOwner group={group} /></div><ProgressValue value={percent} label={title} status={status} source={progressSource} showStatus={false} /><p className="text-ui-sm text-foreground-subtle">{selected ? manual ? "当前百分比来自人工判断；下方 AI 报告为此前分析，不代表本次人工结论。" : hasAnalysis ? "进度分析 Agent 根据需求、验收标准与代码证据判断。" : "尚未分析；0% 为新需求的初始进度，不代表已有代码分析结论。" : `${all.length} 个 SR 的进度算术平均值；全部 SR 完成后 IR 才完成。`}</p>{manual && <p className="break-words text-ui-sm" data-testid="manual-progress-source">{progressSource}：{manual.employeeId} · {manual.reason} · {new Date(manual.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</p>}</header>
      {selected && <ManualProgress key={selected.id} group={group} sr={selected} />}
      <ReportSection title={manual ? "此前 AI 报告的问题与不确定项" : "值得关注的问题与不确定项"}>{issues.length ? <ul className="space-y-4">{issues.map((issue, index) => <li key={`${issue.sr.id}:${index}`} className="space-y-1"><p className="text-ui-sm font-medium">{issue.title}{!selected && ` · ${issue.sr.title}`}</p><p className="text-ui-sm leading-6 text-foreground-subtle">{issue.detail}</p></li>)}</ul> : <p className="text-ui-sm text-foreground-subtle">{hasAnalysis ? "当前报告未发现需关注的遗留问题。" : "尚未分析，暂无问题判断。"}</p>}</ReportSection>
      <ReportSection title="已实现内容">{rows.some(sr => sr.progress?.implemented.length) ? <ul className="list-disc space-y-2 pl-5 text-ui-sm">{evidence("implemented")}</ul> : <p className="text-ui-sm text-foreground-subtle">尚无已实现内容的代码证据。</p>}</ReportSection>
      <ReportSection title="尚未实现或待补充证据">{rows.some(sr => sr.progress?.remaining.length) ? <ul className="list-disc space-y-2 pl-5 text-ui-sm">{evidence("remaining")}</ul> : <p className="text-ui-sm text-foreground-subtle">{hasAnalysis ? "当前报告没有列出未实现项；仍须核对合入事实及完成条件。" : "尚未分析，暂无实现情况与代码版本结论。"}</p>}</ReportSection>
      <ReportSection title="人员与计划时间"><AIReqPlanningSummary group={group} rows={rows} editable /></ReportSection>
      <ReportSection title={manual ? "此前 AI 报告的代码活动与合入依据" : "代码活动与合入依据"}><ul className="space-y-5">{rows.map(sr => <li key={sr.id} className="space-y-2 text-ui-sm"><p className="font-medium">{sr.title}</p>{sr.trackingBranch && <p className="break-all text-ui-xs text-foreground-subtle" data-testid="sr-tracking-branch">提案自动入库后已创建并推送分支：{sr.trackingBranch.name} · 基点：{sr.trackingBranch.baseCommit}</p>}{sr.progress ? <><p className="break-all font-mono text-ui-xs text-foreground-subtle">{sr.progress.branch} → {project?.defaultBranch} · {sr.progress.merged ? "已合入" : "尚未确认合入，最高 99%"}</p><p className="break-all text-ui-xs text-foreground-subtle">分析版本：{sr.progress.codeVersion} · 默认分支版本：{sr.progress.defaultVersion} · {sr.progress.certain ? "实现判断确定" : "判断仍有不确定项"}</p>{sr.progress.activity.length ? sr.progress.activity.map(activity => <p key={activity.commit} className="break-all text-ui-sm">{activity.message}<span className="ml-2 font-mono text-ui-xs text-foreground-subtle">{activity.commit}</span></p>) : <p className="text-foreground-subtle">尚无独立开发提交。</p>}</> : <p className="text-foreground-subtle">尚未分析，暂无代码活动、分析版本或合入判断。</p>}</li>)}</ul></ReportSection>
      <div className="space-y-1 text-ui-xs text-foreground-subtle"><p>后台进度分析报告 · {analysedAt ? new Date(analysedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "尚未分析"}</p><p className="break-all">仓库：{project?.repositoryUrl ?? "尚未配置"} · 默认分支：{project?.defaultBranch}</p><p>{source.provenance.kind === "sample" ? "原型预置报告，尚未调用模型或 Git。人工调整保留报告中的问题及代码依据。" : "人工调整保留报告中的问题及代码依据。"}</p></div>
    </div>
  </main>;
}

const formalTablePanels = ["formal-table"];
const formalDetailPanels = ["formal-table", "formal-inspector"];

export function AIReqFormalWorkspace({ navigationOpen, onToggleNavigation, toolbar }: FormalNavigationProps) {
  const aireq = useAIReq()!;
  const detail = aireq.selection.formalView !== "list" && Boolean(aireq.view?.groups.some(group => group.id === aireq.selection.irId));
  return <ResizablePanelGroup layoutId="aireq-formal-progress-layout-v3" panelIds={detail ? formalDetailPanels : formalTablePanels} className="min-h-0 flex-1">
    <ResizablePanel id="formal-table" minSize="400px" defaultSize={detail ? undefined : "100%"}>
      <AIReqFormalTable key={aireq.releaseId} navigationOpen={navigationOpen} onToggleNavigation={onToggleNavigation} toolbar={toolbar} />
    </ResizablePanel>
    {detail && <><ResizableHandle /><ResizablePanel id="formal-inspector" minSize="360px" maxSize="50%" defaultSize="35%">
      <Tabs key={`${aireq.selection.irId}:${aireq.selection.srId}`} defaultValue="report" className="h-full min-h-0 gap-0 overflow-hidden rounded-xl border border-border bg-background">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <TabsList variant="line" aria-label="需求详情"><TabsTrigger value="report">进度报告</TabsTrigger><TabsTrigger value="materials"><FileText className="size-3.5" />需求材料</TabsTrigger></TabsList>
          <Button variant="ghost" size="icon-sm" aria-label="收起需求详情" onClick={() => aireq.select({ projectId: aireq.selection.projectId, formalView: "list" })}><PanelRightClose className="size-4" /></Button>
        </div>
        <TabsContent value="report" className="min-h-0 flex-1 overflow-hidden"><AIReqFormalReport /></TabsContent>
        <TabsContent value="materials" className="min-h-0 flex-1 overflow-hidden"><AIReqMaterialsPane /></TabsContent>
      </Tabs>
    </ResizablePanel></>}
  </ResizablePanelGroup>;
}
