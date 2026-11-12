import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createUuid } from "@zcode/shared";
import { CirclePlus, FileSearch, ListChecks, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Badge } from "@/components/ui/badge.js";
import { Progress } from "@/components/ui/progress.js";
import { Switch } from "@/components/ui/switch.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable.js";
import { MarkdownTableBody, MarkdownTableCell, MarkdownTableHead, MarkdownTableHeader, MarkdownTableRow } from "@/components/ai-elements/markdown-table.js";
import { useAIReq } from "./AIReqContext.js";
import { useAIReqDataSource } from "./data-source.js";
import { BranchCopy } from "./BranchCopy.js";
import { ISSUE_TYPES, ISSUE_STATUSES, type AIReqIssue, type AIReqIssueInput, type AIReqIssueScope, type AIReqIssueSnapshot, type AIReqIssueServices } from "./issues.js";

type IssuePage = "issueCreate" | "issueAnalysis" | "issueProgress";
const pageLabels = { issueCreate: "新建 Issue", issueAnalysis: "Issue 分析", issueProgress: "Issue 进度" };
const priorityLabels = { high: "高", normal: "中", low: "低" };
const time = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const cell = "px-3 py-3 text-left align-middle";

function IssueSelect({ id, label, value, onChange, children, disabled }: { id: string; label: string; value: string; onChange(value: string): void; children: ReactNode; disabled?: boolean }) {
  return <div className="min-w-0 space-y-2"><Label htmlFor={id}>{label}</Label><Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{children}</SelectContent></Select></div>;
}
function IssueStatus({ issue }: { issue: AIReqIssue }) {
  const color = issue.status === "completed" ? "bg-success-surface text-success-surface-foreground" : issue.status === "developing" ? "bg-progress-surface text-progress-surface-foreground" : issue.status === "pending" ? "bg-tag text-foreground-subtle" : "bg-warning-surface text-warning-surface-foreground";
  return <Badge variant="secondary" className={`whitespace-nowrap font-normal ${color}`}>{ISSUE_STATUSES[issue.status]}</Badge>;
}
function IssueTable({ headings, children }: { headings: string[]; children: ReactNode }) {
  return <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-ui-base"><MarkdownTableHeader><MarkdownTableRow>{headings.map(heading => <MarkdownTableHead key={heading} className={`${cell} whitespace-nowrap font-medium text-foreground-subtle`}>{heading}</MarkdownTableHead>)}</MarkdownTableRow></MarkdownTableHeader><MarkdownTableBody>{children}</MarkdownTableBody></table></div>;
}

export function AIReqIssuePages({ page }: { page: IssuePage }) {
  const aireq = useAIReq()!;
  const source = useAIReqDataSource();
  const scope = { projectId: aireq.selection.projectId ?? "", releaseId: aireq.releaseId };
  return <main aria-label={pageLabels[page]} className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-ui-base">
    <header className="h-12 shrink-0 border-b border-border"><div className="mx-auto flex h-full w-full max-w-7xl items-center gap-2 px-4 md:px-6">{page === "issueCreate" ? <CirclePlus className="size-4 text-foreground-subtle" /> : page === "issueAnalysis" ? <FileSearch className="size-4 text-foreground-subtle" /> : <ListChecks className="size-4 text-foreground-subtle" />}<h1 className="font-semibold">{pageLabels[page]}</h1></div></header>
    {!scope.projectId || !scope.releaseId ? <p role="status" className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">请先选择项目与 Release。</p> : !source.issues ? <p role="status" className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">当前数据源尚未接入 Issue 管理。</p> : <ConnectedIssuePages key={`${source.backend?.id ?? source.clientId}:${scope.projectId}:${scope.releaseId}`} page={page} scope={scope} service={source.issues} />}
  </main>;
}

function ConnectedIssuePages({ page, scope, service }: { page: IssuePage; scope: AIReqIssueScope; service: AIReqIssueServices }) {
  const [snapshot, setSnapshot] = useState<AIReqIssueSnapshot>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const active = useRef(true);
  const busy = useRef(false);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => { active.current = true; const unsubscribe = service.subscribe(refresh); return () => { active.current = false; unsubscribe(); }; }, [service, refresh]);
  useEffect(() => {
    let current = true;
    void service.read(scope).then(value => { if (current) { setSnapshot(value); setError(""); } }, cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [service, scope.projectId, scope.releaseId, revision]);
  const mutate = async (action: () => Promise<void>, success: string) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(""); setMessage("");
    try { await action(); if (active.current) { setMessage(success); refresh(); } }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  };
  return <>
    {(error || message) && <div className="mx-auto w-full max-w-7xl px-4 pt-4 md:px-6">{error ? <div role="alert" className="flex items-center gap-3 text-destructive"><span>{error}</span><Button size="sm" variant="outline" onClick={refresh}>重新加载</Button></div> : <p role="status" className="text-foreground-subtle">{message}</p>}</div>}
    {!snapshot ? !error && <p role="status" className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6">正在加载 Issue…</p> : page === "issueCreate" ? <CreateIssue scope={scope} service={service} pending={pending} mutate={mutate} onMessage={setMessage} /> : page === "issueAnalysis" ? <IssueAnalysis scope={scope} service={service} snapshot={snapshot} pending={pending} mutate={mutate} /> : <IssueProgress scope={scope} service={service} snapshot={snapshot} pending={pending} mutate={mutate} onMessage={setMessage} />}
  </>;
}
interface MutationProps { pending: boolean; mutate(action: () => Promise<void>, success: string): Promise<void> }

function CreateIssue({ scope, service, pending, mutate, onMessage }: { scope: AIReqIssueScope; service: AIReqIssueServices; onMessage(value: string): void } & MutationProps) {
  const aireq = useAIReq()!;
  const source = useAIReqDataSource();
  const [requestId, setRequestId] = useState(() => createUuid());
  const [title, setTitle] = useState("");
  const [type, setType] = useState<AIReqIssueInput["type"]>("bug");
  const [priority, setPriority] = useState<AIReqIssueInput["priority"]>("normal");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [developer, setDeveloper] = useState("");
  const [requirement, setRequirement] = useState("none");
  const [created, setCreated] = useState<AIReqIssue>();
  const groups = aireq.view?.groups.filter(group => group.projectId === scope.projectId && group.releaseId === scope.releaseId) ?? [];
  const relations: { key: string; irId: string; srId?: string; title: string }[] = groups.flatMap(group => [{ key: group.id, irId: group.id, title: `${group.id} · ${group.title}` }, ...(aireq.view?.srs.filter(sr => sr.irId === group.id).map(sr => ({ key: `${group.id}/${sr.id}`, irId: group.id, srId: sr.id, title: `${sr.id} · ${sr.title}` })) ?? [])]);
  const relation = relations.find(item => item.key === requirement);
  const project = aireq.view?.projects.find(item => item.id === scope.projectId);
  return <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-4 md:px-6 md:py-6">
    <p className="text-foreground-subtle">登记 Bug、重构或其他非功能工作。每个 Issue 独立跟踪，可选关联需求。</p>
    {created ? <section className="space-y-4 rounded-lg border border-border p-4" aria-label="Issue 创建结果"><h2 className="font-medium">{created.id} · {created.title}</h2><p>已登记，开发分支由平台分配。</p><BranchCopy branch={created.branch} onMessage={onMessage} /><div className="flex gap-2"><Button onClick={() => aireq.setMainView("issueProgress")}>查看 Issue 进度</Button><Button variant="outline" onClick={() => { setCreated(undefined); setTitle(""); setDescription(""); setAcceptance(""); setRequestId(createUuid()); }}>继续新建</Button></div></section> : <form className="space-y-5" onSubmit={event => {
      event.preventDefault();
      void mutate(async () => { const value = await service.create({ ...scope, requestId, title, type, priority, description, acceptance, developerEmployeeId: developer, requirement: relation ? { irId: relation.irId, srId: relation.srId } : undefined }); setCreated(value); }, "Issue 已创建。");
    }}>
      <fieldset disabled={pending} className="space-y-5">
        <div className="space-y-2"><Label htmlFor="issue-title">标题</Label><Input id="issue-title" value={title} onChange={event => setTitle(event.target.value)} placeholder="简要描述需要解决的问题" required maxLength={200} /></div>
        <div className="grid grid-cols-2 gap-4"><IssueSelect id="issue-type" label="类型" value={type} onChange={value => setType(value as AIReqIssueInput["type"])}>{Object.entries(ISSUE_TYPES).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</IssueSelect><IssueSelect id="issue-priority" label="优先级" value={priority} onChange={value => setPriority(value as AIReqIssueInput["priority"])}>{Object.entries(priorityLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</IssueSelect></div>
        <div className="space-y-2"><Label htmlFor="issue-description">问题说明</Label><Textarea id="issue-description" value={description} onChange={event => setDescription(event.target.value)} required rows={5} placeholder="当前表现、期望结果、复现步骤或需要调整的范围" /></div>
        <div className="space-y-2"><Label htmlFor="issue-acceptance">完成标准</Label><Textarea id="issue-acceptance" value={acceptance} onChange={event => setAcceptance(event.target.value)} required rows={3} placeholder="满足哪些条件后可以确认完成" /></div>
        <IssueSelect id="issue-developer" label="开发人员（单人）" value={developer} onChange={setDeveloper}>{source.employeeDirectory?.entries.map(person => <SelectItem key={person.employeeId} value={person.employeeId}>{person.name} · {person.employeeId}</SelectItem>)}</IssueSelect>
        <IssueSelect id="issue-requirement" label="关联需求（可选）" value={requirement} onChange={setRequirement}><SelectItem value="none">不关联，独立跟踪</SelectItem>{relations.map(item => <SelectItem key={item.key} value={item.key}>{item.title}</SelectItem>)}</IssueSelect>
        <div className="rounded-lg border border-border p-4 text-foreground-subtle">开发分支由平台基于 {project?.defaultBranch ?? "默认分支"} 自动分配，无需手动填写。AI 分析最高 99%，合入后由人工确认完成。</div>
        <Button type="submit" disabled={pending || !title.trim() || !description.trim() || !acceptance.trim() || !developer || (requirement !== "none" && !relation)}>{pending ? "正在创建…" : "创建 Issue"}</Button>
      </fieldset>
    </form>}
  </div></div>;
}

function IssueAnalysis({ scope, service, snapshot, pending, mutate }: { scope: AIReqIssueScope; service: AIReqIssueServices; snapshot: AIReqIssueSnapshot } & MutationProps) {
  const source = useAIReqDataSource();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [enabled, setEnabled] = useState(snapshot.enabled);
  const [interval, setInterval] = useState(String(snapshot.intervalMinutes));
  const [tab, setTab] = useState("tasks");
  const [query, setQuery] = useState("");
  const canManage = source.capabilities.settingsWrite === true;
  const matches = (id: string, title: string) => `${id} ${title}`.toLowerCase().includes(query.toLowerCase());
  const tasks = snapshot.issues.filter(issue => issue.status !== "completed" && matches(issue.id, issue.title));
  const runs = snapshot.runs.filter(run => matches(run.issueId, run.title));
  const [run, setRun] = useState<AIReqIssueSnapshot["runs"][number]>();
  return <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-7xl space-y-5 px-4 py-4 md:px-6 md:py-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-foreground-subtle">{snapshot.enabled ? `自动分析 · 每 ${snapshot.intervalMinutes} 分钟 · 下次 ${time(snapshot.nextRunAt)}` : "自动分析已暂停"}</p><div className="flex gap-2"><Button variant="outline" disabled={pending || !canManage} onClick={() => { setEnabled(snapshot.enabled); setInterval(String(snapshot.intervalMinutes)); setSettingsOpen(true); }}><Settings2 className="size-4" />分析设置</Button><Button disabled={pending || !canManage || !snapshot.issues.some(issue => issue.status !== "completed")} onClick={() => void mutate(() => service.runNow(scope), "本轮 Issue 分析已完成。")}>{pending ? "正在处理…" : "立即分析"}</Button></div></div>
    <Label htmlFor="issue-analysis-search" className="sr-only">搜索 Issue 分析</Label><Input id="issue-analysis-search" className="max-w-sm" placeholder="搜索 Issue 编号或标题" value={query} onChange={event => setQuery(event.target.value)} />
    <Tabs value={tab} onValueChange={setTab}><TabsList><TabsTrigger value="tasks">分析任务</TabsTrigger><TabsTrigger value="history">分析历史</TabsTrigger></TabsList>
      <TabsContent value="tasks" className="mt-4"><IssueTable headings={["Issue", "开发分支", "状态", "进度", "最近更新"]}>{tasks.length ? tasks.map(issue => <MarkdownTableRow key={issue.id}><MarkdownTableCell className={cell}><span className="text-ui-sm text-foreground-subtle">{issue.id}</span><p>{issue.title}</p></MarkdownTableCell><MarkdownTableCell className={cell}><span className="font-mono text-ui-sm">{issue.branch}</span></MarkdownTableCell><MarkdownTableCell className={cell}><IssueStatus issue={issue} /></MarkdownTableCell><MarkdownTableCell className={cell}>{issue.percent}%</MarkdownTableCell><MarkdownTableCell className={`${cell} whitespace-nowrap text-ui-sm text-foreground-subtle`}>{time(issue.updatedAt)}</MarkdownTableCell></MarkdownTableRow>) : <MarkdownTableRow><MarkdownTableCell colSpan={5} className={`${cell} h-32 text-center text-foreground-subtle`}>{query ? "没有匹配的 Issue。" : "暂无待分析 Issue。新建 Issue 后会自动进入任务列表。"}</MarkdownTableCell></MarkdownTableRow>}</IssueTable></TabsContent>
      <TabsContent value="history" className="mt-4"><IssueTable headings={["Issue", "分析时间", "结果", "报告"]}>{runs.length ? runs.map(item => <MarkdownTableRow key={item.id}><MarkdownTableCell className={cell}>{item.issueId} · {item.title}</MarkdownTableCell><MarkdownTableCell className={cell}>{time(item.startedAt)}</MarkdownTableCell><MarkdownTableCell className={cell}>{item.status === "succeeded" ? "成功" : "失败"}</MarkdownTableCell><MarkdownTableCell className={cell}><Button variant="ghost" size="sm" onClick={() => setRun(item)}>查看报告</Button></MarkdownTableCell></MarkdownTableRow>) : <MarkdownTableRow><MarkdownTableCell colSpan={4} className={`${cell} h-32 text-center text-foreground-subtle`}>暂无分析记录。</MarkdownTableCell></MarkdownTableRow>}</IssueTable></TabsContent>
    </Tabs>
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}><DialogContent><DialogTitle>Issue 分析设置</DialogTitle><DialogDescription>仅分析当前项目与 Release 的 Issue，与需求分析独立调度。</DialogDescription><div className="flex items-center justify-between gap-4"><Label htmlFor="issue-analysis-enabled">启用自动分析</Label><Switch id="issue-analysis-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={pending} /></div><div className="space-y-2"><Label htmlFor="issue-analysis-interval">分析间隔（分钟）</Label><Input id="issue-analysis-interval" type="number" min={15} max={1440} value={interval} disabled={pending} onChange={event => setInterval(event.target.value)} /></div><Button disabled={pending || !canManage || !Number.isInteger(Number(interval)) || Number(interval) < 15 || Number(interval) > 1440} onClick={() => void mutate(async () => { await service.configure(scope, enabled, Number(interval)); setSettingsOpen(false); }, "Issue 分析设置已保存。")}>保存</Button></DialogContent></Dialog>
    <Dialog open={Boolean(run)} onOpenChange={open => { if (!open) setRun(undefined); }}><DialogContent><DialogTitle>{run?.issueId} · 分析报告</DialogTitle><DialogDescription>{time(run?.startedAt)}</DialogDescription><p className="whitespace-pre-wrap text-ui-base">{run?.summary}</p></DialogContent></Dialog>
  </div></div>;
}

function IssueProgress({ scope, service, snapshot, pending, mutate, onMessage }: { scope: AIReqIssueScope; service: AIReqIssueServices; snapshot: AIReqIssueSnapshot; onMessage(value: string): void } & MutationProps) {
  const aireq = useAIReq()!;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("all");
  const [selected, setSelected] = useState<string>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reason, setReason] = useState("");
  const issue = snapshot.issues.find(item => item.id === selected);
  const items = snapshot.issues.filter(item => (status === "all" || item.status === status) && (type === "all" || item.type === type) && `${item.id} ${item.title} ${item.developerEmployeeId}`.toLowerCase().includes(query.toLowerCase()));
  return <ResizablePanelGroup orientation="horizontal" layoutId="aireq-issue-progress-v1" className="min-h-0 flex-1" panelIds={issue ? ["issues", "issue-report"] : ["issues"]}>
    <ResizablePanel id="issues" defaultSize={issue ? "65%" : "100%"} minSize="360px" className="min-w-0"><div className="h-full overflow-y-auto"><div className="mx-auto w-full max-w-7xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <div className="flex flex-wrap items-end gap-3"><div className="min-w-48 flex-1 space-y-2"><Label htmlFor="issue-progress-search">搜索</Label><Input id="issue-progress-search" placeholder="编号、标题或开发人员工号" value={query} onChange={event => setQuery(event.target.value)} /></div><IssueSelect id="issue-progress-status" label="状态" value={status} onChange={setStatus}><SelectItem value="all">全部状态</SelectItem>{Object.entries(ISSUE_STATUSES).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</IssueSelect><IssueSelect id="issue-progress-type" label="类型" value={type} onChange={setType}><SelectItem value="all">全部类型</SelectItem>{Object.entries(ISSUE_TYPES).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</IssueSelect></div>
      <IssueTable headings={["Issue", "类型 / 优先级", "开发人员", "开发分支", "状态", "进度"]}>{items.length ? items.map(item => <MarkdownTableRow key={item.id} className={selected === item.id ? "bg-selected" : ""}><MarkdownTableCell className={`${cell} min-w-48`}><Button variant="link" className="h-auto max-w-80 justify-start whitespace-normal p-0 text-left" aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>{item.title}</Button><p className="mt-1 text-ui-sm text-foreground-subtle">{item.id}{item.requirement ? ` · ${item.requirement.srId ?? item.requirement.irId}` : " · 独立跟踪"}</p></MarkdownTableCell><MarkdownTableCell className={`${cell} whitespace-nowrap`}>{ISSUE_TYPES[item.type]} · {priorityLabels[item.priority]}</MarkdownTableCell><MarkdownTableCell className={cell}>{item.developerEmployeeId}</MarkdownTableCell><MarkdownTableCell className={`${cell} min-w-44`}><BranchCopy branch={item.branch} onMessage={onMessage} /></MarkdownTableCell><MarkdownTableCell className={cell}><IssueStatus issue={item} /></MarkdownTableCell><MarkdownTableCell className={`${cell} min-w-28`}><span className="tabular-nums">{item.percent}%</span><Progress className="mt-1 h-1.5" value={item.percent} aria-label={`${item.id} 进度 ${item.percent}%`} /></MarkdownTableCell></MarkdownTableRow>) : <MarkdownTableRow><MarkdownTableCell colSpan={6} className={`${cell} h-40 text-center text-foreground-subtle`}>{snapshot.issues.length ? "没有匹配的 Issue。" : <div className="space-y-3"><p>暂无 Issue。</p><Button variant="outline" onClick={() => aireq.setMainView("issueCreate")}>新建 Issue</Button></div>}</MarkdownTableCell></MarkdownTableRow>}</IssueTable>
      <p className="text-ui-sm text-foreground-subtle">共 {items.length} 个 Issue · AI 最高 99%，合入默认分支后由人工确认到 100%。</p>
    </div></div></ResizablePanel>
    {issue && <><ResizableHandle /><ResizablePanel id="issue-report" defaultSize="35%" minSize="320px" maxSize="50%" className="min-w-0"><aside aria-label="Issue 详情" className="h-full overflow-y-auto"><div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-4 md:px-6 md:py-6"><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><p className="text-ui-sm text-foreground-subtle">{issue.id}</p><h2 className="mt-1 break-words text-ui-lg font-medium">{issue.title}</h2></div><Button variant="ghost" size="icon" aria-label="关闭 Issue 详情" onClick={() => setSelected(undefined)}><X className="size-4" /></Button></div><div className="flex items-center gap-3"><IssueStatus issue={issue} /><span>{issue.percent}%</span></div><BranchCopy branch={issue.branch} onMessage={onMessage} /><p className="text-ui-sm text-foreground-subtle">开发人员：{issue.developerEmployeeId}<br />关联需求：{issue.requirement?.srId ?? issue.requirement?.irId ?? "未关联"}<br />最近更新：{time(issue.updatedAt)}</p>
      <Tabs defaultValue="report" key={issue.id}><TabsList><TabsTrigger value="report">报告</TabsTrigger><TabsTrigger value="material">材料</TabsTrigger></TabsList><TabsContent value="report" className="space-y-4 pt-4"><section className="space-y-2"><h3 className="font-medium">进度分析</h3><p className="whitespace-pre-wrap leading-relaxed">{issue.report}</p></section><section className="space-y-2"><h3 className="font-medium">遗留问题</h3>{issue.remaining.length ? <ul className="list-disc space-y-2 pl-5">{issue.remaining.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul> : <p className="text-foreground-subtle">暂无遗留问题。</p>}</section></TabsContent><TabsContent value="material" className="space-y-5 pt-4"><section><h3 className="mb-2 font-medium">问题说明</h3><p className="whitespace-pre-wrap leading-relaxed">{issue.description}</p></section><section><h3 className="mb-2 font-medium">完成标准</h3><p className="whitespace-pre-wrap leading-relaxed">{issue.acceptance}</p></section></TabsContent></Tabs>
      {issue.status === "completed" ? <Button variant="outline" disabled={pending} onClick={() => { setReason(""); setReopenOpen(true); }}>重新打开</Button> : <div className="space-y-2"><Button disabled={pending || !issue.merged} onClick={() => setConfirmOpen(true)}>确认完成</Button>{!issue.merged && <p className="text-ui-sm text-foreground-subtle">等待开发分支合入默认分支后确认。</p>}</div>}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}><DialogContent><DialogTitle>确认完成 {issue.id}？</DialogTitle><DialogDescription>确认完成标准已满足，进度将记为 100%。</DialogDescription><Button disabled={pending || !issue.merged} onClick={() => void mutate(async () => { await service.confirm(scope, issue.id); setConfirmOpen(false); }, "Issue 已确认完成。")}>确认完成</Button></DialogContent></Dialog>
      <Dialog open={reopenOpen} onOpenChange={setReopenOpen}><DialogContent><DialogTitle>重新打开 {issue.id}</DialogTitle><DialogDescription>记录遗留问题并恢复进度跟踪。</DialogDescription><Label htmlFor="issue-reopen-reason">重新打开原因</Label><Textarea id="issue-reopen-reason" value={reason} onChange={event => setReason(event.target.value)} /><Button disabled={pending || !reason.trim()} onClick={() => void mutate(async () => { await service.reopen(scope, issue.id, reason); setReopenOpen(false); }, "Issue 已重新打开。")}>重新打开</Button></DialogContent></Dialog>
    </div></aside></ResizablePanel></>}
  </ResizablePanelGroup>;
}
