import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Badge } from "@/components/ui/badge.js";
import { Switch } from "@/components/ui/switch.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { BranchCopy } from "./BranchCopy.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { useDevDataSource, useOptionalDevDataSource, type DevDataSource } from "./data-source.js";
import type { DevAnalysisFilter, DevAnalysisRun, DevAnalysisRunSummary, DevAnalysisTask, DevProgressScheduler } from "./progress-scheduler.js";

const taskLabels: Record<DevAnalysisTask["state"], string> = { waiting: "待分析", running: "分析中", failed: "失败", completed: "已完成", paused: "已暂停" };
const runLabels: Record<DevAnalysisRun["status"], string> = { running: "分析中", succeeded: "成功", failed: "失败", skipped: "无变化跳过" };
const presets = [15, 30, 60, 120];
const cellClass = "px-4 py-2.5 text-left align-middle";
const tableClass = "w-full table-fixed text-ui-base";
const headClass = "sticky top-0 z-10 bg-background text-foreground-subtle";
function time(value?: string) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function shortTime(value?: string) { return value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—"; }
function duration(run: DevAnalysisRunSummary) {
  return run.endedAt ? `${Math.max(0, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000))} 秒` : "执行中";
}
function FilterSelect({ id, label, value, onChange, children, disabled, className = "w-44" }: { id: string; label: string; value: string; onChange: (value: string) => void; children: ReactNode; disabled?: boolean; className?: string }) {
  return <div className={className}><Label htmlFor={id} className="sr-only">{label}</Label><Select value={value} disabled={disabled} onValueChange={onChange}><SelectTrigger id={id} className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{children}</SelectContent></Select></div>;
}
function RowLabel({ title, subtitle }: { title: string; subtitle: string }) {
  return <div className="min-w-0"><ControlHintTooltip title={title} description={subtitle}><span tabIndex={0} className="block truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused">{title}</span></ControlHintTooltip><p className="mt-0.5 truncate text-ui-sm text-foreground-subtle" title={subtitle}>{subtitle}</p></div>;
}
function Status({ value, children }: { value: string; children: ReactNode }) {
  return <Badge variant="outline" className={`whitespace-nowrap font-normal ${value === "failed" ? "border-destructive/40 text-destructive" : value === "running" ? "bg-selected" : ""}`}>{children}</Badge>;
}
function Pagination({ kind, page, pageSize, total, onPage, onPageSize }: { kind: "task" | "history"; page: number; pageSize: number; total: number; onPage: (page: number) => void; onPageSize: (size: number) => void }) {
  const label = kind === "task" ? "任务" : "历史";
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div data-testid={`analysis-${kind}-pagination`} className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-ui-sm">
    <p aria-live="polite" className="tabular-nums text-foreground-subtle">共 {total} 条 · 第 {page} / {pages} 页</p>
    <div className="flex flex-wrap items-center gap-3"><FilterSelect id={`analysis-${kind}-page-size`} label={`${label}每页条数`} className="w-28" value={String(pageSize)} onChange={value => onPageSize(Number(value))}><SelectItem value="25">25 条 / 页</SelectItem><SelectItem value="50">50 条 / 页</SelectItem></FilterSelect>
      <nav aria-label={`${label}分页`} className="flex items-center gap-1"><Button variant="ghost" size="sm" aria-label={`${label}首页`} disabled={page <= 1} onClick={() => onPage(1)}>首页</Button><Button variant="outline" size="sm" aria-label={`${label}上一页`} disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</Button><Button variant="outline" size="sm" aria-label={`${label}下一页`} disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</Button><Button variant="ghost" size="sm" aria-label={`${label}末页`} disabled={page >= pages} onClick={() => onPage(pages)}>末页</Button></nav>
    </div>
  </div>;
}
function useSchedulerQuery<T>(load: () => T | Promise<T>, revision: number, enabled = true) {
  const [result, setResult] = useState<{ load: typeof load; revision: number; value?: T; error?: string; loading: boolean }>();
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setResult(previous => ({ load, revision, value: previous?.load === load ? previous.value : undefined, loading: true }));
    void (async () => {
      try {
        const value = await load();
        if (active) setResult({ load, revision, value, loading: false });
      } catch (cause) {
        if (active) setResult(previous => ({ load, revision, value: previous?.load === load ? previous.value : undefined, error: cause instanceof Error ? cause.message : String(cause), loading: false }));
      }
    })();
    return () => { active = false; };
  }, [load, revision, enabled]);
  return enabled && result?.load === load ? { ...result, loading: result.revision !== revision || result.loading } : { loading: enabled, value: undefined, error: undefined };
}
function QueryFeedback({ loading, error, onRetry }: { loading: boolean; error?: string; onRetry: () => void }) {
  return loading ? <p role="status" className="px-4 py-3 text-ui-sm text-foreground-subtle">正在加载…</p> : error ? <div role="alert" className="flex items-center gap-3 px-4 py-3 text-ui-sm text-destructive"><span>{error}</span><Button variant="outline" size="sm" onClick={onRetry}>重试加载</Button></div> : null;
}
export function DevProgressAnalysisSettings() {
  const source = useOptionalDevDataSource();
  if (!source?.progressScheduler) return <p role="status" className="text-ui-base text-foreground-subtle">当前数据源尚未接入需求进度分析；未加载演示数据，也不会执行后台分析。</p>;
  return <ConnectedProgressAnalysis source={source} scheduler={source.progressScheduler} />;
}
function ConnectedProgressAnalysis({ source, scheduler }: { source: DevDataSource; scheduler: DevProgressScheduler }) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const loadSnapshot = useCallback(() => scheduler.read(), [scheduler]);
  const snapshotQuery = useSchedulerQuery(loadSnapshot, revision);
  const snapshot = snapshotQuery.value;
  const [interval, setInterval] = useState("");
  const [projectId, setProjectId] = useState("all");
  const [irId, setIrId] = useState("all");
  const [projectSearch, setProjectSearch] = useState("");
  const [srSearch, setSrSearch] = useState("");
  const [historyStatus, setHistoryStatus] = useState("all");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [tab, setTab] = useState("tasks");
  const [taskPage, setTaskPage] = useState(1);
  const [taskPageSize, setTaskPageSize] = useState(25);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(25);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const reportTrigger = useRef<HTMLButtonElement | null>(null);
  const [message, setMessage] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const canManage = source.capabilities.settingsWrite === true;
  const [pending, setPending] = useState(false);
  const mutation = useRef(false);
  const lifecycle = useRef<object | undefined>(undefined);
  useEffect(() => {
    const scope = {};
    lifecycle.current = scope;
    mutation.current = false;
    setPending(false);
    const unsubscribe = scheduler.subscribe(refresh);
    refresh();
    return () => { lifecycle.current = undefined; unsubscribe(); };
  }, [scheduler, refresh]);
  useEffect(() => { if (snapshot) setInterval(String(snapshot.intervalMinutes)); }, [snapshot?.intervalMinutes]);
  const mutate = async (action: () => void | Promise<void>, success: string) => {
    if (!canManage || mutation.current) return;
    const scope = lifecycle.current;
    mutation.current = true;
    setPending(true);
    setMessage("");
    try {
      await action();
      if (lifecycle.current === scope) { setMessage(success); refresh(); }
    } catch (cause) {
      if (lifecycle.current === scope) setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (lifecycle.current === scope) { mutation.current = false; setPending(false); }
    }
  };
  const minutes = Number(interval);
  const positiveInterval = /^\d+$/.test(interval) && Number.isSafeInteger(minutes) && minutes >= 1;
  const validInterval = positiveInterval && Number.isFinite(new Date(Date.parse(snapshot?.currentTime ?? new Date().toISOString()) + minutes * 60_000).getTime());
  const irs = snapshot?.irs.filter(ir => projectId === "all" || ir.projectId === projectId) ?? [];
  const dateError = Boolean(since && until && since > until);
  const filter: DevAnalysisFilter = useMemo(() => ({ projectId: projectId === "all" ? undefined : projectId, irId: irId === "all" ? undefined : irId, srSearch }), [projectId, irId, srSearch]);
  const loadTasks = useCallback(() => scheduler.queryTasks(filter, taskPage, taskPageSize), [scheduler, filter, taskPage, taskPageSize]);
  const taskQuery = useSchedulerQuery(loadTasks, revision);
  const taskResult = taskQuery.value;
  const loadHistory = useCallback(() => scheduler.queryRuns({ ...filter, status: historyStatus === "all" ? undefined : historyStatus as DevAnalysisRunSummary["status"], since: since ? new Date(since).toISOString() : undefined, until: until ? new Date(until).toISOString() : undefined }, historyPage, historyPageSize), [scheduler, filter, historyStatus, since, until, historyPage, historyPageSize]);
  const historyQuery = useSchedulerQuery(loadHistory, revision, tab === "history" && !dateError);
  const historyResult = historyQuery.value;
  const loadReport = useCallback(async () => {
    const run = selectedRunId ? await scheduler.readRun(selectedRunId) : undefined;
    if (!run) throw new Error("未找到此执行报告。");
    const tasks = await scheduler.queryTasks({ projectId: run.projectId, irId: run.irId, srId: run.srId }, 1, 25);
    return { run, task: tasks.items[0] };
  }, [scheduler, selectedRunId]);
  const reportQuery = useSchedulerQuery(loadReport, revision, Boolean(selectedRunId));
  const selectedRun = reportQuery.value?.run;
  const selectedTask = reportQuery.value?.task;
  const retryBlocker = (task?: DevAnalysisTask) => !canManage ? "仅此 OMP 启动者可重试；只读访问仍可查看失败原因。"
    : !task ? "此 SR 已不在当前任务范围，无法重试。"
    : !snapshot?.projects.find(project => project.id === task.projectId)?.enabled ? "项目分析已关闭，请先开启项目分析。"
    : task.state === "running" ? "此 SR 正在分析，不会重复接纳；完成后再查看结果。"
    : task.state === "completed" || task.percent >= 100 ? "此 SR 已完成，分析已停止。"
    : undefined;
  const retry = (task: DevAnalysisTask) => {
    const exact = { projectId: task.projectId, irId: task.irId, srId: task.srId };
    void mutate(async () => {
      const current = (await scheduler.queryTasks(exact, 1, 25)).items[0];
      const blocker = retryBlocker(current);
      if (blocker) throw new Error(blocker);
      await scheduler.runNow(exact);
    }, `仅已请求 ${task.srId} 的单 SR 重试；未派发其他 SR，运行中不会重复接纳。`);
  };
  const openReport = (id: string, trigger: HTMLButtonElement) => { reportTrigger.current = trigger; setSelectedRunId(id); };
  const taskActions = (task: DevAnalysisTask) => task.error && task.lastRunId ? <div className="mt-1 space-y-1 whitespace-normal">
    <div className="flex flex-wrap gap-1"><Button variant="ghost" size="sm" className="px-1" aria-label={`查看 ${task.srId} 失败原因`} onClick={event => openReport(task.lastRunId!, event.currentTarget)}>查看原因</Button><Button variant="outline" size="sm" className="px-1" aria-label={`重试 ${task.srId}`} disabled={pending || Boolean(retryBlocker(task))} onClick={() => retry(task)}>重试</Button></div>
    {retryBlocker(task) && <p className="text-ui-xs text-foreground-subtle">{retryBlocker(task)}</p>}
  </div> : null;
  useEffect(() => {
    if (taskResult && taskResult.page !== taskPage) { setTaskPage(taskResult.page); setSelectedRunId(undefined); }
    if (historyResult && historyResult.page !== historyPage) { setHistoryPage(historyResult.page); setSelectedRunId(undefined); }
    if (selectedRunId && tab === "history" && historyResult && !historyResult.items.some(run => run.id === selectedRunId)) setSelectedRunId(undefined);
  }, [taskResult, taskPage, historyResult, historyPage, selectedRunId, tab]);
  const resetAnalysisPages = () => { setTaskPage(1); setHistoryPage(1); setSelectedRunId(undefined); };
  const resetHistoryPage = () => { setHistoryPage(1); setSelectedRunId(undefined); };
  if (!snapshot) return <section data-testid="dev-progress-analysis-settings"><QueryFeedback loading={snapshotQuery.loading} error={snapshotQuery.error} onRetry={refresh} /></section>;
  const visibleProjects = snapshot.projects.filter(project => `${project.id} ${project.name}`.toLowerCase().includes(projectSearch.toLowerCase()));
  const runningCount = snapshot.projects.reduce((total, project) => total + project.runningCount, 0);
  return <section className="space-y-4" data-testid="dev-progress-analysis-settings">
    <QueryFeedback loading={snapshotQuery.loading} error={snapshotQuery.error} onRetry={refresh} />
    <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{source.provenance.kind === "sample" ? "内存原型 · 不调用模型" : "后台进度分析"}</Badge>{snapshot.scaleDemo && <span data-testid="analysis-scale-demo" className="text-foreground-subtle">规模演示 · {snapshot.tasksTotal} 个 SR · {snapshot.runsTotal} 条执行历史</span>}</div><span className="text-foreground-subtle">{canManage ? "启动者可管理" : "只读访问"} · {source.backend?.owner ?? "共享 OMP"}</span></div>
    <section aria-labelledby="analysis-projects-title" className="overflow-hidden rounded-xl border border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div className="flex items-center gap-2"><h3 id="analysis-projects-title" className="text-ui-base font-medium">项目分析范围</h3><span className="text-ui-sm text-foreground-subtle">{snapshot.projects.filter(project => project.enabled).length} / {snapshot.projects.length} 已开启</span></div><div className="w-64"><Label htmlFor="analysis-project-search" className="sr-only">搜索项目</Label><Input id="analysis-project-search" className="h-8" placeholder="搜索项目名称" value={projectSearch} onChange={event => setProjectSearch(event.target.value)} /></div></div>
      <div className="max-h-48 overflow-auto"><table className={`${tableClass} min-w-[640px]`}><colgroup><col className="w-[30%]" /><col className="w-24" /><col className="w-28" /><col className="w-36" /><col /></colgroup><thead className={headClass}><tr className="border-y border-border"><th className={cellClass}>项目</th><th className={cellClass}>自动分析</th><th className={cellClass}>待分析 SR</th><th className={cellClass}>最近分析</th><th className={cellClass}>状态</th></tr></thead><tbody>{visibleProjects.map(project => <tr key={project.id} className="border-b border-border last:border-0"><td className={cellClass}>{project.name}</td><td className={cellClass}><Switch checked={project.enabled} disabled={!canManage} aria-label={`启用${project.name}进度分析`} onCheckedChange={enabled => mutate(() => scheduler.setProjectEnabled(project.id, enabled), `已${enabled ? "启用" : "停用"}“${project.name}”（内存保存）。`)} /></td><td className={`${cellClass} tabular-nums`}>{project.pendingCount}</td><td className={`${cellClass} whitespace-nowrap tabular-nums`} title={time(project.lastRunAt)}>{shortTime(project.lastRunAt)}</td><td className={cellClass}>{project.runningCount ? `${project.runningCount} 个分析中` : !project.enabled ? "已关闭" : !snapshot.enabled ? "全局暂停" : project.lastStatus ? runLabels[project.lastStatus] : "等待首次分析"}</td></tr>)}</tbody></table></div>{!visibleProjects.length && <p className="px-4 py-3 text-ui-sm text-foreground-subtle">没有匹配项目。</p>}
    </section>
    <section aria-labelledby="analysis-schedule-title" className="min-w-0 overflow-hidden rounded-xl border border-border">
      <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"><div className="flex flex-wrap items-center gap-3"><h3 id="analysis-schedule-title" className="text-ui-base font-medium">统一分析调度</h3><Switch id="analysis-enabled" checked={snapshot.enabled} disabled={!canManage} aria-label="全局自动分析" onCheckedChange={enabled => mutate(() => scheduler.configure(enabled, snapshot.intervalMinutes), `全局自动分析已${enabled ? "开启" : "暂停"}。`)} /><span className="text-ui-sm text-foreground-subtle">{snapshot.enabled ? `每 ${snapshot.intervalMinutes} 分钟` : "自动分析已暂停"}</span><span className="text-ui-sm tabular-nums text-foreground-subtle" title={time(snapshot.nextCheckAt)}>下次检查 {shortTime(snapshot.nextCheckAt)}</span><Badge variant="outline">{runningCount} 个运行中</Badge></div><CollapsibleTrigger asChild><Button variant="ghost" size="sm" aria-label="调度设置"><Settings2 aria-hidden="true" className="size-4" />调度设置<ChevronDown aria-hidden="true" className={`size-3.5 ${settingsOpen ? "rotate-180" : ""}`} /></Button></CollapsibleTrigger></div>
        <CollapsibleContent><div className="space-y-3 border-b border-border bg-surface/40 p-4 text-ui-sm">
          <form className="flex flex-wrap items-center gap-3" onSubmit={event => { event.preventDefault(); if (validInterval) mutate(() => scheduler.configure(snapshot.enabled, minutes), "全局间隔已保存。"); }}><Label htmlFor="analysis-minutes">统一间隔</Label><FilterSelect id="analysis-interval-preset" label="间隔预设" className="w-32" disabled={!canManage} value={presets.includes(minutes) ? String(minutes) : "custom"} onChange={value => { if (canManage) setInterval(value === "custom" ? "" : value); }}><SelectItem value="custom">自定义</SelectItem>{presets.map(value => <SelectItem key={value} value={String(value)}>{value} 分钟</SelectItem>)}</FilterSelect><Input id="analysis-minutes" type="number" min="1" step="1" value={interval} disabled={!canManage} onChange={event => setInterval(event.target.value)} aria-invalid={!validInterval} aria-describedby="analysis-interval-help" className="h-9 w-24" /><span>分钟</span><Button size="sm" type="submit" disabled={!canManage || !validInterval || minutes === snapshot.intervalMinutes}>保存间隔</Button><Button variant="link" size="sm" type="button" onClick={() => setPendingSettingsSection("modelProvider")}>查看 Agent 模型配置</Button></form>
          <p id="analysis-interval-help" className="text-foreground-subtle">所有 SR 共用间隔；项目开关立即保存。关闭自动调度不取消在途分析，仍可手动分析已开启项目。{!validInterval && <span role="alert" className="text-destructive">{positiveInterval ? "间隔超出可表示的日期范围，请使用更小的分钟数。" : "请输入正整数分钟数。"}</span>}</p>
          {source.prototype && <div className="flex flex-wrap items-center gap-3"><Button variant="outline" size="sm" disabled={!canManage} onClick={() => mutate(() => scheduler.advance(), "已推进原型时钟：完成在途任务，或派发下一轮到期任务；未调用模型。")} >模拟一次调度检查（原型）</Button><span className="text-foreground-subtle">虚拟时间 {time(snapshot.currentTime)} · 最近检查 {shortTime(snapshot.lastCheckAt)}</span></div>}
          {source.provenance.kind === "sample" && <p className="max-w-4xl leading-relaxed text-foreground-subtle">仅内存演示：不连接模型、Git 或数据库，刷新页面保留后端内存状态，仅重启后端恢复样例。模拟检查先完成在途任务，否则派发到期任务；再次点击完成。每个正式 SR 自动建档，完成后停止，重开复用记录；需求和代码均未变则跳过。模型配置沿用需求进度分析 Agent，本页不重复设置。</p>}
        {source.provenance.kind === "sample" && <p className="px-4 pt-2 text-ui-sm text-foreground-subtle">失败演示含仓库读取、模型调用、文档读取三类模拟样例；任务行可直接查看最近原因，执行历史筛选“失败”可查看各类处理建议。均不代表真实后端错误。</p>}
        </div></CollapsibleContent>
      </Collapsible>
      <Tabs value={tab} onValueChange={value => { setTab(value); setSelectedRunId(undefined); }} className="min-w-0 gap-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3"><TabsList aria-label="进度分析列表"><TabsTrigger value="tasks" aria-label="SR 任务">SR 任务 <span className="ml-1 tabular-nums text-foreground-subtle">{snapshot.tasksTotal}</span></TabsTrigger><TabsTrigger value="history" aria-label="执行历史">执行历史 <span className="ml-1 tabular-nums text-foreground-subtle">{snapshot.runsTotal}</span></TabsTrigger></TabsList><Button size="sm" disabled={!canManage || pending || taskQuery.loading || Boolean(taskQuery.error) || !taskResult?.eligibleCount} onClick={() => mutate(() => scheduler.runNow(filter), "已请求全部匹配 SR 的分析，不限当前页；重复运行中的任务不会再次入队。")}>分析当前筛选范围的 {taskResult?.eligibleCount ?? "…"} 个 SR</Button></div>
        <div className="flex flex-wrap items-center gap-2 p-4"><FilterSelect id="analysis-project" label="项目" value={projectId} onChange={value => { setProjectId(value); setIrId("all"); resetAnalysisPages(); }}><SelectItem value="all">全部项目</SelectItem>{snapshot.projects.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</FilterSelect><FilterSelect id="analysis-ir" label="IR" value={irId} onChange={value => { setIrId(value); resetAnalysisPages(); }}><SelectItem value="all">全部 IR</SelectItem>{irs.map(ir => <SelectItem key={`${ir.projectId}-${ir.id}`} value={ir.id}>{ir.id} · {ir.title}</SelectItem>)}</FilterSelect><div className="min-w-56 flex-1"><Label htmlFor="analysis-sr-search" className="sr-only">搜索 SR（任务与历史）</Label><Input id="analysis-sr-search" className="h-9" placeholder="搜索 SR 名称或编号" value={srSearch} onChange={event => { setSrSearch(event.target.value); resetAnalysisPages(); }} /></div>{(projectId !== "all" || irId !== "all" || srSearch) && <Button variant="ghost" size="sm" onClick={() => { setProjectId("all"); setIrId("all"); setSrSearch(""); resetAnalysisPages(); }}>清除范围筛选</Button>}</div>
        {tab === "tasks" && <QueryFeedback loading={taskQuery.loading} error={taskQuery.error} onRetry={refresh} />}
        {tab === "tasks" && taskResult && <TabsContent value="tasks" className="m-0 min-w-0"><div className="max-h-[28rem] overflow-auto"><table data-testid="analysis-task-table" className={`${tableClass} min-w-[1040px]`}><colgroup><col className="w-64" /><col className="w-48" /><col className="w-20" /><col className="w-40" /><col className="w-36" /><col /></colgroup><thead className={headClass}><tr className="border-y border-border">{["SR / 所属 IR", "分支 · 点击复制", "进度", "状态 / 失败处理", "下次分析", "最近分析"].map(title => <th key={title} className={cellClass}>{title}</th>)}</tr></thead><tbody>{taskResult.items.map(task => <tr key={task.id} data-task-id={task.id} className="border-b border-border last:border-0 hover:bg-hover"><td className={cellClass}><RowLabel title={task.srTitle} subtitle={`${task.srId} · ${task.irId}`} /></td><td className={cellClass}><BranchCopy branch={task.branch} onMessage={setMessage} /></td><td className={`${cellClass} whitespace-nowrap tabular-nums`}>{task.percent}%</td><td className={cellClass}><ControlHintTooltip title={task.error ?? taskLabels[task.state]}><span tabIndex={0} className="inline-flex rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"><Status value={task.state}>{taskLabels[task.state]}</Status></span></ControlHintTooltip>{taskActions(task)}</td><td className={`${cellClass} whitespace-nowrap tabular-nums`} title={time(task.nextRunAt)}>{task.state === "completed" ? "已停止" : shortTime(task.nextRunAt)}</td><td className={`${cellClass} tabular-nums`}><span title={time(task.lastRunAt)}>{shortTime(task.lastRunAt)}</span></td></tr>)}</tbody></table></div>{!taskResult.total && <p className="px-4 py-8 text-center text-ui-base text-foreground-subtle">当前范围没有正式 SR 任务。</p>}<Pagination kind="task" page={taskResult.page} pageSize={taskPageSize} total={taskResult.total} onPage={page => { setTaskPage(page); setSelectedRunId(undefined); }} onPageSize={size => { setTaskPageSize(size); setTaskPage(1); setSelectedRunId(undefined); }} /></TabsContent>}
        {tab === "history" && <TabsContent value="history" className="m-0 min-w-0"><div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3"><FilterSelect id="analysis-history-status" label="历史状态" className="w-36" value={historyStatus} onChange={value => { setHistoryStatus(value); resetHistoryPage(); }}><SelectItem value="all">全部状态</SelectItem>{Object.entries(runLabels).map(([status, label]) => <SelectItem key={status} value={status}>{label}</SelectItem>)}</FilterSelect><Label htmlFor="analysis-since" className="sr-only">开始时间（含）</Label><Input id="analysis-since" className="h-9 w-48" type="datetime-local" value={since} onChange={event => { setSince(event.target.value); resetHistoryPage(); }} /><span className="text-ui-sm text-foreground-subtle">至</span><Label htmlFor="analysis-until" className="sr-only">结束时间（含）</Label><Input id="analysis-until" className="h-9 w-48" type="datetime-local" value={until} onChange={event => { setUntil(event.target.value); resetHistoryPage(); }} /><Button variant="ghost" size="sm" onClick={() => { setHistoryStatus("all"); setSince(""); setUntil(""); resetHistoryPage(); }}>清除历史筛选</Button>{dateError && <span role="alert" className="text-ui-sm text-destructive">结束时间不能早于开始时间。</span>}</div>
          <QueryFeedback loading={historyQuery.loading} error={historyQuery.error} onRetry={refresh} />
          {historyResult && <>
          <div className="min-w-0"><div className="max-h-[28rem] overflow-auto"><table data-testid="analysis-history-table" className={`${tableClass} min-w-[1040px]`}><colgroup><col className="w-64" /><col className="w-52" /><col className="w-20" /><col className="w-40" /><col className="w-28" /><col className="w-24" /><col className="w-24" /></colgroup><thead className={headClass}><tr className="border-y border-border">{["SR / 项目", "执行分支 · 点击复制", "触发", "时间 / 耗时", "结果", "进度变化", "报告"].map(title => <th key={title} className={cellClass}>{title}</th>)}</tr></thead><tbody>{historyResult.items.map(run => <tr key={run.id} data-run-id={run.id} className={`border-b border-border last:border-0 hover:bg-hover ${selectedRunId === run.id ? "bg-selected" : ""}`}><td className={cellClass}><RowLabel title={run.srTitle} subtitle={`${run.srId} · ${snapshot.projects.find(project => project.id === run.projectId)?.name ?? run.projectId} · ${run.irId}`} /></td><td className={cellClass}><BranchCopy branch={run.branch} onMessage={setMessage} /></td><td className={`${cellClass} whitespace-nowrap`}>{run.trigger === "schedule" ? "定时" : "手动"}</td><td className={`${cellClass} tabular-nums`} title={time(run.startedAt)}><p className="whitespace-nowrap">{shortTime(run.startedAt)}</p><p className="text-ui-sm text-foreground-subtle">{duration(run)}</p></td><td className={cellClass}><Status value={run.status}>{runLabels[run.status]}</Status></td><td className={`${cellClass} whitespace-nowrap tabular-nums`}>{run.before}% → {run.after}%</td><td className={cellClass}><Button variant="ghost" size="sm" aria-haspopup="dialog" aria-label={`查看 ${run.srId} ${time(run.startedAt)} 报告`} onClick={event => openReport(run.id, event.currentTarget)}>查看详情</Button></td></tr>)}</tbody></table></div>{!historyResult.total && <p className="px-4 py-8 text-center text-ui-base text-foreground-subtle">当前条件下没有执行历史。</p>}<Pagination kind="history" page={historyResult.page} pageSize={historyPageSize} total={historyResult.total} onPage={page => { setHistoryPage(page); setSelectedRunId(undefined); }} onPageSize={size => { setHistoryPageSize(size); setHistoryPage(1); setSelectedRunId(undefined); }} /></div>
          </>}
        </TabsContent>}
      </Tabs>
    </section>
    <Dialog open={Boolean(selectedRunId)} onOpenChange={open => { if (!open) setSelectedRunId(undefined); }}>
      {selectedRun ? <ReportPane run={selectedRun} feedback={<><QueryFeedback loading={reportQuery.loading} error={reportQuery.error} onRetry={refresh} /><p role="status" aria-live="polite" className="text-ui-sm text-foreground-subtle">{pending ? "正在提交…" : message}</p></>} retryDisabledReason={pending ? "正在提交，请稍候。" : reportQuery.loading ? "正在刷新报告，请稍候。" : reportQuery.error ? "报告刷新失败，请重试加载。" : selectedRun.failure?.retryable === false ? "此失败不可直接重试，请先按下一步处理。" : retryBlocker(selectedTask)} onRetry={() => { if (selectedTask) retry(selectedTask); }} onClose={() => setSelectedRunId(undefined)} onRestoreFocus={() => reportTrigger.current?.isConnected && reportTrigger.current.focus()} /> : <DialogContent onCloseAutoFocus={event => { event.preventDefault(); if (reportTrigger.current?.isConnected) reportTrigger.current.focus(); }}><DialogTitle>执行报告</DialogTitle><DialogDescription>正在读取所选执行报告。</DialogDescription><QueryFeedback loading={reportQuery.loading} error={reportQuery.error} onRetry={refresh} /></DialogContent>}
    </Dialog>
    <p role="status" aria-live="polite" className="min-h-5 text-ui-sm text-foreground-subtle">{pending ? "正在提交…" : message}</p>
  </section>;
}
function ReportPane({ run, onClose, onRetry, retryDisabledReason, onRestoreFocus, feedback }: { run: DevAnalysisRun; onClose: () => void; onRetry: () => void; retryDisabledReason?: string; onRestoreFocus: () => void; feedback: ReactNode }) {
  const source = useDevDataSource();
  const report = run.report;
  return <DialogContent data-testid="analysis-report-dialog" className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={event => { event.preventDefault(); onRestoreFocus(); }}>
    <div className="flex items-start justify-between gap-2 pr-6"><div className="min-w-0"><DialogTitle>执行报告</DialogTitle><DialogDescription className="mt-1 break-all">{run.srId}{source?.provenance.kind === "sample" ? " · 内存样例，不代表真实分析" : ""}</DialogDescription></div><Button size="sm" variant="ghost" onClick={onClose}>关闭详情</Button></div>
    {feedback}
    <p>{run.srTitle}</p><Status value={run.status}>{runLabels[run.status]}</Status><p className="break-words leading-relaxed">{run.message}</p><dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-ui-sm"><dt className="text-foreground-subtle">开始</dt><dd>{time(run.startedAt)}</dd><dt className="text-foreground-subtle">结束</dt><dd>{time(run.endedAt)}</dd><dt className="text-foreground-subtle">耗时</dt><dd>{duration(run)}</dd><dt className="text-foreground-subtle">进度</dt><dd>{run.before}% → {run.after}%</dd></dl>
    {run.status === "failed" && <section aria-label="失败处理建议" className="space-y-3 rounded-lg border border-destructive/40 p-3 text-ui-sm">
      <h5 className="font-medium">分析失败 · {run.failure?.stage ?? "分析阶段未记录"}</h5>
      <dl className="space-y-2"><div><dt className="font-medium">原因</dt><dd>{run.failure?.reason ?? run.message}</dd></div><div><dt className="font-medium">下一步</dt><dd>{run.failure?.nextStep ?? "由启动者核对当前 SR 的需求与项目配置；请按报告中的诊断信息处理。"}</dd></div><div><dt className="font-medium">是否可重试</dt><dd>{run.failure?.retryable === false ? "不可直接重试，需先处理上述问题。" : "可重试；仅派发当前 SR，不影响其他任务。"}</dd></div></dl>
      <Button size="sm" disabled={Boolean(retryDisabledReason)} onClick={onRetry}>重试此 SR</Button>
      <p role="status" className="text-foreground-subtle">{retryDisabledReason ?? "仅启动者可操作；项目已开启，当前 SR 未完成且未运行。"}</p>
    </section>}
    {report ? <><div className="space-y-2 border-t border-border pt-3 text-ui-sm"><h5 className="font-medium">代码依据</h5><p className="break-all">分支：{report.branch}</p><p>合入：{report.merged ? "已合入" : "未合入"} · {report.certain ? "判断确定" : "仍有不确定项"}</p><p className="break-all">代码版本：{report.codeVersion}<br />默认分支：{report.defaultVersion}</p></div><ReportList title="已实现" items={report.implemented} /><ReportList title="待完成" items={report.remaining} /><ReportList title="问题与风险" items={report.issues.map(issue => `${issue.title}：${issue.detail}`)} /><ReportList title="代码活动" items={report.activity.map(item => `${item.commit} · ${item.message} · ${time(item.at)}`)} /></> : <p className="text-ui-sm text-foreground-subtle">尚无报告；运行中、跳过或失败原因见本次执行说明。</p>}
    <details className="border-t border-border pt-3 text-ui-sm"><summary className="cursor-pointer text-foreground-subtle">执行标识与数据来源</summary><p className="mt-2 break-all">运行：{run.id}<br />批次：{run.batchId}</p><p className="mt-2 text-foreground-subtle">{source.provenance.kind === "sample" ? "固定内存样例，不代表真实研发进度，不覆盖正式 SR 报告。" : "报告内容与执行状态由当前后台提供。"}</p></details>
  </DialogContent>;
}
function ReportList({ title, items }: { title: string; items: string[] }) {
  return <div className="space-y-1 text-ui-sm"><h5 className="font-medium">{title}</h5>{items.length ? <ul className="list-disc space-y-1 break-words pl-4 text-foreground-subtle">{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="text-foreground-subtle">无</p>}</div>;
}
