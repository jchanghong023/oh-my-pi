import type { PanelImperativeHandle } from "react-resizable-panels";
import type { ComposerInputPreview } from "@/prompt-editor/ChatPromptEditor.js";
import { DevSkillFilePreview } from "./DevSkillFilePreview.js";
import { createUuid } from "@zcode/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FileCode2, FolderGit2, MessageSquare, ArrowRight, WandSparkles, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from "@/components/ui/resizable.js";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Label } from "@/components/ui/label.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { DevAgentModelSummary } from "./DevAgentModelSummary.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { SessionPane } from "@/v4/SessionPane.js";
import type { ExternalTextInsertRequest } from "@/v4/ConversationComposer.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { useServices } from "@/hooks/useServices.js";
import { bindRemoteWorkspaceIdentity, registerRemoteWorkspaceSession, unregisterRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";
import { useDevDataSource } from "./data-source.js";
import { useDev } from "./DevContext.js";
import type { DevAgentModelBinding, DevSkillDesignDraft, DevSkillDesignPreview } from "./types.js";
import type { SkillSummary } from "@zcode/shared";
import { SKILL_DESIGN_FIELDS } from "./skill-design-fields.js";

const skillDesignPanels = ["skill-brief", "skill-conversation"];

export function DevSkillDesignPage() {
  const source = useDevDataSource();
  const dev = useDev();
  if (!source.skillDesign) return <p className="text-ui-sm text-foreground-subtle">当前数据源尚未接入此功能。</p>;
  const project = dev?.view?.projects.find(item => item.id === dev.selection.projectId);
  const developmentRoot = project ? source.projects?.readDevelopmentRoot(project.id, source.backend?.owner) : undefined;
  return <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="Skill 设计">
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-5"><WandSparkles className="size-4 text-foreground-subtle" /><h1 className="text-ui-base font-semibold">Skill 设计</h1><span className="ml-auto text-ui-sm text-foreground-subtle">所有人可用 · 使用当前 Web 的模型配置</span></header>
    <div className="flex min-h-0 flex-1 flex-col p-4"><SkillDesignEditor key={`${source.backend?.id}:${project?.id ?? "personal"}`} projectId={project?.id ?? "personal"} projectName={project?.name ?? "未选择项目"} workspacePath={developmentRoot ?? source.backend?.configDirectory ?? ""} developmentRoot={developmentRoot} /></div>
  </main>;
}

function SkillDesignEditor({ projectId, projectName, workspacePath, developmentRoot }: { projectId: string; projectName: string; workspacePath: string; developmentRoot?: string }) {
  const source = useDevDataSource();
  const design = source.skillDesign!;
  const [session, setSession] = useState<{ id: string; binding: DevAgentModelBinding; identity: string }>();
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    setSession(undefined);
    setLoadError("");
    void (async () => {
      try {
        const id = await design.session(projectId);
        const [binding, identity] = await Promise.all([design.binding(id), design.workspaceIdentity(projectId)]);
        if (active) setSession({ id, binding, identity });
      } catch (cause) {
        if (active) setLoadError(cause instanceof Error ? cause.message : "加载技能设计会话失败。");
      }
    })();
    return () => { active = false; };
  }, [design, projectId]);
  if (loadError) return <p role="alert" className="text-ui-sm text-destructive">{loadError}</p>;
  if (!session) return <p role="status" className="text-ui-sm text-foreground-subtle">正在加载技能设计会话…</p>;
  return <ReadySkillDesignEditor key={session.id} {...{ projectId, projectName, workspacePath, developmentRoot }} sessionId={session.id} modelBinding={session.binding} identity={session.identity} />;
}

function ReadySkillDesignEditor({ projectId, projectName, workspacePath, developmentRoot, sessionId, modelBinding, identity }: { projectId: string; projectName: string; workspacePath: string; developmentRoot?: string; sessionId: string; modelBinding: DevAgentModelBinding; identity: string }) {
  const source = useDevDataSource();
  const design = source.skillDesign!;
  const services = useServices();
  const scope = useMemo(() => ({ workspacePath, workspaceIdentity: `${identity}:skill-design` }), [workspacePath, identity]);
  useEffect(() => {
    const registrationId = `dev-skill-designer:${source.clientId}:${createUuid()}`;
    registerRemoteWorkspaceSession({ sessionId: registrationId, workspacePath: scope.workspacePath, workspaceIdentity: scope.workspaceIdentity, services });
    bindRemoteWorkspaceIdentity(scope.workspaceIdentity, registrationId);
    return () => unregisterRemoteWorkspaceSession(registrationId);
  }, [source, scope, services]);
  const [draft, setDraft] = useState<DevSkillDesignDraft>();
  const [preview, setPreview] = useState<DevSkillDesignPreview>();
  const [temporaryDirectory, setTemporaryDirectory] = useState("");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filling, setFilling] = useState(false);
  const active = useRef(true);
  const draftVersion = useRef(0);
  const pendingDraftSaves = useRef(0);
  const draftSave = useRef<Promise<void>>(Promise.resolve());
  const draftSaveError = useRef<unknown>(undefined);
  const [tab, setTab] = useState("chat");
  const [optionalOpen, setOptionalOpen] = useState(false);
  const briefPanel = useRef<PanelImperativeHandle | null>(null);
  const [briefOpen, setBriefOpen] = useState(true);
  const [composerInputPreview, setComposerInputPreview] = useState<ComposerInputPreview>();
  const [insertRequest, setInsertRequest] = useState<ExternalTextInsertRequest | null>(null);
  const requestId = useRef(0);
  const pendingInsert = useRef<ExternalTextInsertRequest | null>(null);
  const lastFilledText = useRef<string | undefined>(undefined);
  const [fillError, setFillError] = useState("");
  const [selectedFile, setSelectedFile] = useState("SKILL.md");
  const [saveTarget, setSaveTarget] = useState<"project" | "user">(developmentRoot ? "project" : "user");
  const previewRevision = useRef<number | undefined>(undefined);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const coreFields = SKILL_DESIGN_FIELDS.filter(field => field.required);
  const completed = SKILL_DESIGN_FIELDS.filter(field => draft?.[field.id].trim()).length;
  const targetName = preview?.name ?? "";
  const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(targetName) && targetName.length <= 64;
  const targetDirectory = !preview ? undefined : saveTarget === "user" ? source.backend?.userSkillsDirectory ? `${source.backend.userSkillsDirectory}/${targetName}` : undefined : developmentRoot ? `${developmentRoot}/.omp/skills/${targetName}` : undefined;
  const collision = skills.some(skill => skill.path === `${targetDirectory}/SKILL.md`);
  const file = preview?.files.find(item => item.path === selectedFile) ?? preview?.files[0];
  const generationStatus = savedPath
    ? `第 ${preview?.revision} 版已保存。`
    : preview ? `已生成临时文件 · 第 ${preview.revision} 版，尚未保存。` : "尚未生成临时文件。";
  const updateDraft = (next: DevSkillDesignDraft) => {
    setDraft(next);
    setNotice("");
    const version = ++draftVersion.current;
    pendingDraftSaves.current++;
    const save = draftSave.current.then(async () => {
      await design.saveDraft(sessionId, next);
    });
    draftSave.current = save.catch(() => {});
    return save.then(() => {
      if (version === draftVersion.current) {
        draftSaveError.current = undefined;
        if (active.current) setError("");
      }
      return true;
    }, cause => {
      if (version === draftVersion.current) {
        draftSaveError.current = cause;
        if (active.current) setError(cause instanceof Error ? cause.message : "保存技能说明失败。");
      }
      return false;
    }).finally(() => { pendingDraftSaves.current--; });
  };
  useEffect(() => {
    active.current = true;
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      const editVersion = draftVersion.current;
      const canReadDraft = pendingDraftSaves.current === 0;
      try {
        const [nextDraft, next, directory, nextSkills] = await Promise.all([
          design.read(sessionId), design.readPreview(sessionId),
          design.temporaryDirectory(sessionId), design.listSkills(workspacePath),
        ]);
        if (disposed || request !== revision) return;
        if (canReadDraft && pendingDraftSaves.current === 0 && editVersion === draftVersion.current) setDraft(nextDraft);
        if (previewRevision.current !== next?.revision) {
          setSavedPath(""); setNotice(""); setFillError("");
          pendingInsert.current = null; setInsertRequest(null);
        }
        previewRevision.current = next?.revision;
        setPreview(next);
        setTemporaryDirectory(directory);
        setSkills(nextSkills);
        setLoading(false);
      } catch (cause) {
        if (disposed || request !== revision) return;
        setError(cause instanceof Error ? cause.message : "加载技能设计数据失败。");
        setLoading(false);
      }
    };
    const subscription = design.subscribe(id => { if (id === sessionId) void refresh(); });
    void refresh();
    return () => { disposed = true; active.current = false; subscription.dispose(); };
  }, [design, sessionId, workspacePath]);
  const handleInsertApplied = useCallback((appliedId: number) => {
    if (pendingInsert.current?.requestId !== appliedId) return;
    lastFilledText.current = pendingInsert.current.text;
    pendingInsert.current = null;
    setFillError("");
    setInsertRequest(null);
    setNotice("已准备好，尚未发送。请到右侧核对后发送。");
  }, []);
  const fillComposer = async () => {
    setTab("chat");
    if (pendingInsert.current || filling || !draft) return;
    setNotice(""); setFillError(""); setFilling(true);
    try {
      await draftSave.current;
      if (draftSaveError.current) throw draftSaveError.current;
      const text = await design.prompt(sessionId, draft);
      if (!active.current) return;
      const request: ExternalTextInsertRequest = { requestId: ++requestId.current, text, mode: "append", replaceText: lastFilledText.current };
      pendingInsert.current = request;
      setComposerInputPreview({ text, summary: draft.goal.trim() || "已整理技能说明，可展开核对全部内容。" });
      setInsertRequest(request);
    } catch (cause) {
      if (active.current) setFillError(cause instanceof Error ? cause.message : "生成聊天说明失败。");
    } finally {
      if (active.current) setFilling(false);
    }
  };
  useEffect(() => {
    if (!insertRequest) return;
    const timer = window.setTimeout(() => {
      if (pendingInsert.current?.requestId !== insertRequest.requestId) return;
      pendingInsert.current = null;
      setInsertRequest(null);
      setNotice("");
      setFillError("聊天输入框尚未就绪，未确认填入成功。请稍后重试；表单内容已保留。");
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [insertRequest]);
  const fillExample = async () => {
    if (!draft) return;
    const next = { ...draft };
    const sample = design.sample!;
    for (const field of SKILL_DESIGN_FIELDS) if (!next[field.id].trim()) next[field.id] = sample[field.id];
    const version = draftVersion.current + 1;
    if (await updateDraft(next) && active.current && version === draftVersion.current) setNotice("已填入空白字段；尚未发送。");
  };
  const save = async () => {
    if (!targetDirectory || !preview || !validName || collision || savedPath || saving) return;
    const revision = preview.revision;
    setSaving(true);
    try {
      await draftSave.current;
      if (draftSaveError.current) throw draftSaveError.current;
      const path = await design.savePreview(sessionId, developmentRoot ?? "", targetName, saveTarget);
      if (!active.current || previewRevision.current !== revision) return;
      setSavedPath(path); setError(""); setNotice(""); setFillError("");
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : "保存失败。");
    } finally {
      if (active.current) setSaving(false);
    }
  };
  if (loading) return <p role="status" className="text-ui-sm text-foreground-subtle">正在加载技能设计数据…</p>;
  if (!draft) return <p role="alert" className="text-ui-sm text-destructive">{error || "加载技能设计数据失败。"}</p>;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" data-testid="dev-skill-design">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <ol className="flex flex-wrap items-center gap-2 text-ui-sm" aria-label="技能设计步骤">
        {["整理说明", "对话设计", savedPath ? "已保存" : "预览并保存"].map((label, index) => {
          const current = preview ? 2 : composerInputPreview ? 1 : 0;
          return <li key={index} aria-current={index === current ? "step" : undefined} className={index === current ? "font-medium text-foreground" : "text-foreground-subtle"}>
            {index > 0 && <span className="mr-2" aria-hidden="true">›</span>}{index + 1}. {label}
          </li>;
        })}
      </ol>
      <div className="flex min-w-0 items-center gap-2 text-ui-sm"><FolderGit2 className="size-3.5 text-foreground-subtle" /><span className="truncate">{projectName}</span><Badge variant="outline">{source.provenance.kind === "sample" ? "原型演示" : "后台数据"}</Badge></div>
    </div>
    {error && <p role="alert" className="text-ui-sm text-destructive">{error}</p>}
    <Collapsible>
      <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="max-w-full justify-start px-0 text-foreground-subtle"><ChevronDown className="size-3" /><span className="truncate">会话模型 · {modelBinding.modelName}</span></Button></CollapsibleTrigger>
      <CollapsibleContent className="pb-1"><DevAgentModelSummary binding={modelBinding} /></CollapsibleContent>
    </Collapsible>
    <ResizablePanelGroup layoutId="dev-skill-design-layout-v1" panelIds={skillDesignPanels} className="min-h-0 flex-1">
      <ResizablePanel id="skill-brief" panelRef={briefPanel} defaultSize="40%" minSize="280px" maxSize="60%" collapsible collapsedSize="0px" onResize={size => setBriefOpen(size.asPercentage > 0)}>
      <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border" id="skill-design-brief" aria-labelledby="skill-design-brief-title" aria-hidden={!briefOpen} inert={!briefOpen}>
        <div className="shrink-0 space-y-2 border-b border-border p-4">
          <div className="flex items-center justify-between gap-2"><h3 id="skill-design-brief-title" className="text-ui-base font-medium">技能说明</h3><div className="flex items-center gap-2"><span className="text-ui-sm text-foreground-subtle">已整理 {completed} 项</span>{design.sample && <Button variant="ghost" size="sm" onClick={fillExample}>填入示例</Button>}</div></div>
          <p className="text-ui-sm text-foreground-subtle">填写核心目标即可开始讨论，其余可稍后补充。技能标识由模型推荐。</p>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-testid="skill-design-fields">
          {coreFields.map(field => <div key={field.id} className="space-y-1.5"><div className="flex items-center justify-between gap-2"><Label htmlFor={`skill-design-${field.id}`}>{field.label}</Label>{Boolean(draft[field.id].trim()) && <Check className="size-3.5 text-foreground-subtle" aria-label="已填写" />}</div><SettingsFormTextarea id={`skill-design-${field.id}`} rows={2} aria-describedby={`skill-design-${field.id}-hint`} className="min-h-16 w-full resize-y" value={draft[field.id]} placeholder={field.placeholder} onChange={event => updateDraft({ ...draft, [field.id]: event.target.value })} /><p id={`skill-design-${field.id}-hint`} className="text-ui-sm text-foreground-subtle">{field.hint}</p></div>)}
          <Collapsible open={optionalOpen} onOpenChange={setOptionalOpen}><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="px-0"><ChevronDown className={`size-3 transition-transform ${optionalOpen ? "" : "-rotate-90"}`} />补充字段（选填）</Button></CollapsibleTrigger><CollapsibleContent><div className="space-y-4 pt-3">{SKILL_DESIGN_FIELDS.filter(field => !field.required).map(field => <div key={field.id} className="space-y-1.5"><Label htmlFor={`skill-design-${field.id}`}>{field.label}</Label><SettingsFormTextarea id={`skill-design-${field.id}`} rows={3} aria-describedby={`skill-design-${field.id}-hint`} className="w-full" value={draft[field.id]} placeholder={field.placeholder} onChange={event => updateDraft({ ...draft, [field.id]: event.target.value })} /><p id={`skill-design-${field.id}-hint`} className="text-ui-sm text-foreground-subtle">{field.hint}</p></div>)}</div></CollapsibleContent></Collapsible>
        </div>
        <div className="shrink-0 space-y-2 border-t border-border p-3">
          <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="px-0 text-foreground-subtle"><ChevronDown className="size-3" />临时生成路径</Button></CollapsibleTrigger><CollapsibleContent><p className="break-all font-mono text-ui-sm text-foreground-subtle">{temporaryDirectory}</p></CollapsibleContent></Collapsible>
          {fillError && <p role="alert" className="text-ui-sm text-destructive">{fillError}</p>}
          {insertRequest && <p role="status" className="text-ui-sm text-foreground-subtle">正在填入聊天输入框…</p>}
          {notice && <p role="status" className="text-ui-sm text-foreground-subtle">{notice}</p>}
          <Button className="w-full" disabled={Boolean(insertRequest) || filling} onClick={fillComposer}><ArrowRight className="size-3.5" />准备设计对话</Button>
        </div>
      </section>
      </ResizablePanel>
      {briefOpen && <ResizableHandle />}
      <ResizablePanel id="skill-conversation" defaultSize="60%" minSize="360px">
      <Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" size="icon-sm" aria-label={briefOpen ? "收起技能说明" : "展开技能说明"} title={briefOpen ? "收起技能说明" : "展开技能说明"} aria-expanded={briefOpen} aria-controls="skill-design-brief" onClick={() => { if (briefPanel.current?.isCollapsed()) briefPanel.current.expand(); else briefPanel.current?.collapse(); }}>
              {briefOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
            </Button>
            <TabsList aria-label="技能设计工作区"><TabsTrigger value="chat"><MessageSquare className="size-3.5" />设计对话</TabsTrigger><TabsTrigger value="preview"><FileCode2 className="size-3.5" />临时文件预览{preview && <span className="text-ui-sm text-foreground-subtle">{preview.files.length}</span>}</TabsTrigger></TabsList>
          </div>
          <span role="status" className="text-ui-sm text-foreground-subtle" data-testid="skill-design-generation-status">{generationStatus}</span>
        </div>
        <TabsContent forceMount value="chat" className={tab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <div className="relative min-h-0 flex-1" data-testid="skill-design-chat">
            <V4PaneConversationProvider scope={scope} sessionId={sessionId}><SessionPane paneId={`skill-designer-${projectId}`} sessionId={sessionId} rootSessionId={sessionId} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} embedded focused={tab === "chat"} conversationEmptyState={<div className="mx-auto flex min-h-64 max-w-md flex-col items-center justify-center gap-3 px-6 py-8 text-center"><WandSparkles className="size-6 text-foreground-subtle" /><h2 className="text-ui-lg font-medium">从一个任务开始设计技能</h2><p className="text-ui-base leading-6 text-foreground-subtle">在左侧整理目标，或直接在下方描述需求。核对内容并发送后，再预览和确认保存。</p>{source.provenance.kind === "sample" && <p className="text-ui-sm text-foreground-subtle">原型使用预置回复与文件样例，不调用真实模型或写入磁盘。</p>}</div>} composerPlaceholder="描述想设计的技能，或补充修改要求…" composerAriaLabel="技能设计对话输入" composerInputPreview={composerInputPreview} composerInsertRequest={insertRequest} onComposerInsertApplied={handleInsertApplied} /></V4PaneConversationProvider>
          </div>
        </TabsContent>
        <TabsContent forceMount value="preview" className={tab === "preview" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" data-testid="skill-design-preview">
            {!preview ? <div className="flex h-full flex-col items-center justify-center gap-3 text-center"><FileCode2 className="size-6 text-foreground-subtle" /><p className="text-ui-base">尚未生成临时文件</p><p className="max-w-sm text-ui-sm text-foreground-subtle">先准备设计对话，核对内容后发送。生成的文件会在这里预览，保存前仍需你确认。</p><Button variant="outline" onClick={() => setTab("chat")}>返回设计对话</Button></div> : <>
              <Select value={file?.path} onValueChange={setSelectedFile}><SelectTrigger className="w-full" aria-label="选择临时技能文件"><SelectValue /></SelectTrigger><SelectContent>{preview.files.map(item => <SelectItem key={item.path} value={item.path}>{item.path}</SelectItem>)}</SelectContent></Select>
              <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="px-0 text-foreground-subtle"><ChevronDown className="size-3" />查看完整文件路径</Button></CollapsibleTrigger><CollapsibleContent><p className="break-all font-mono text-ui-sm text-foreground-subtle">{preview.directory}/{file?.path}</p></CollapsibleContent></Collapsible>
              {file && <DevSkillFilePreview file={file} workspacePath={scope.workspacePath} />}
              {source.provenance.kind === "sample" && <p className="text-ui-sm text-foreground-subtle">原型固定文件样例，未调用真实模型或写入磁盘。</p>}
            </>}
          </div>
          <div className="shrink-0 space-y-2 border-t border-border p-3" data-testid="skill-design-save-target">
            <p className="text-ui-sm">技能标识（模型推荐）：<span className="font-mono">{preview?.name ?? "发送后由模型推荐"}</span></p>
            <div className="space-y-1.5"><Label htmlFor="skill-save-scope">保存到</Label><Select value={saveTarget} disabled={Boolean(savedPath) || saving} onValueChange={value => { setSaveTarget(value as "project" | "user"); setError(""); }}><SelectTrigger id="skill-save-scope" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="project" disabled={!developmentRoot}>项目技能 · 当前有效项目</SelectItem><SelectItem value="user">Profile 技能 · 共享 OMP</SelectItem></SelectContent></Select></div>
            <p className="text-ui-sm text-foreground-subtle">{saveTarget === "project" ? `当前项目：${projectName}` : `共享 OMP profile 归属：${source.backend?.owner ?? "Web 启动者"}，不是访问者的个人后端`}</p><p className="break-all font-mono text-ui-sm text-foreground-subtle">{targetDirectory ?? "发送并预览后显示保存路径；项目目标须有效可写，profile 目标无需绑定项目。"}</p>
            {preview && <p className="text-ui-sm text-foreground-subtle">将保存第 {preview.revision} 版的全部 {preview.files.length} 个文件，不覆盖同名技能。</p>}
            {preview && !validName && <p role="alert" className="text-ui-sm text-destructive">标识只能包含小写字母、数字和连字符，最长 64 个字符。</p>}
            {collision && !savedPath && <p role="alert" className="text-ui-sm text-destructive">所选目标已有同名技能，请返回对话让模型推荐其他标识，再预览保存。</p>}
            {savedPath && <p role="status" className="break-all text-ui-sm text-foreground-subtle">已保存全部文件到 {targetDirectory}。</p>}
            <div className="flex items-center justify-end gap-2"><Button variant="ghost" onClick={() => { setTab("chat"); }}>继续讨论修改</Button><Button disabled={!targetDirectory || !preview || collision || !validName || Boolean(savedPath) || saving} onClick={save}>确认保存技能</Button></div>
          </div>
        </TabsContent>
      </Tabs>
      </ResizablePanel>
    </ResizablePanelGroup>
  </div>;
}
