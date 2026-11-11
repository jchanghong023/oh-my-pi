import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FileCode2, FolderGit2, MessageSquare, Copy } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Label } from "@/components/ui/label.js";
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { DevAgentModelSummary } from "./DevAgentModelSummary.js";
import { DevPersonalConfigScope } from "./DevPersonalConfigScope.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { SessionPane } from "@/v4/SessionPane.js";
import type { ExternalTextInsertRequest } from "@/v4/ConversationComposer.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { useServices } from "@/hooks/useServices.js";
import { bindRemoteWorkspaceIdentity, registerRemoteWorkspaceSession, unregisterRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";
import { useDevDataSource } from "./data-source.js";
import { useDev } from "./DevContext.js";
import type { DevSkillDesignDraft } from "./types.js";
import { SKILL_DESIGN_FIELDS } from "./skill-design-fields.js";

export function DevSkillDesignSettings() {
  const source = useDevDataSource();
  const dev = useDev();
  if (source.mode !== "prototype" || !source.skillDesign) return <p className="text-ui-sm text-foreground-subtle">当前数据源尚未接入此功能。</p>;
  const project = dev?.view?.projects.find(item => item.id === dev.selection.projectId);
  const developmentRoot = project ? source.projects?.readDevelopmentRoot(project.id, source.backend?.owner) : undefined;
  return <div className="space-y-4"><DevPersonalConfigScope /><SkillDesignEditor key={`${source.backend?.id}:${project?.id ?? "personal"}`} projectId={project?.id ?? "personal"} projectName={project?.name ?? "未选择项目"} workspacePath={developmentRoot ?? source.backend?.configDirectory ?? ""} developmentRoot={developmentRoot} /></div>;
}

function SkillDesignEditor({ projectId, projectName, workspacePath, developmentRoot }: { projectId: string; projectName: string; workspacePath: string; developmentRoot?: string }) {
  const source = useDevDataSource();
  const design = source.skillDesign!;
  const services = useServices();
  const sessionId = design.session(projectId);
  const [modelBinding] = useState(() => design.binding(sessionId));
  const scope = useMemo(() => ({ workspacePath, workspaceIdentity: `${design.workspaceIdentity(projectId)}:skill-design` }), [design, workspacePath, projectId]);
  useEffect(() => {
    const registrationId = `dev-skill-designer:${source.clientId}:${crypto.randomUUID()}`;
    registerRemoteWorkspaceSession({ sessionId: registrationId, workspacePath: scope.workspacePath, workspaceIdentity: scope.workspaceIdentity, services });
    bindRemoteWorkspaceIdentity(scope.workspaceIdentity, registrationId);
    return () => unregisterRemoteWorkspaceSession(registrationId);
  }, [source, scope, services]);
  const [draft, setDraft] = useState(() => design.read(sessionId));
  const [preview, setPreview] = useState(() => design.readPreview(sessionId));
  const [tab, setTab] = useState("chat");
  const [optionalOpen, setOptionalOpen] = useState(false);
  const [unsupportedOpen, setUnsupportedOpen] = useState(false);
  const [insertRequest, setInsertRequest] = useState<ExternalTextInsertRequest | null>(null);
  const requestId = useRef(0);
  const pendingInsert = useRef<ExternalTextInsertRequest | null>(null);
  const lastFilledText = useRef<string | undefined>(undefined);
  const [fillError, setFillError] = useState("");
  const [selectedFile, setSelectedFile] = useState("SKILL.md");
  const [saveTarget, setSaveTarget] = useState<"project" | "user">(developmentRoot ? "project" : "user");
  const previewRevision = useRef(preview?.revision);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const coreFields = SKILL_DESIGN_FIELDS.filter(field => field.required);
  const completed = coreFields.filter(field => draft[field.id].trim()).length;
  const temporaryDirectory = design.temporaryDirectory(sessionId);
  const targetName = preview?.name ?? "";
  const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(targetName) && targetName.length <= 64;
  const targetDirectory = !preview ? undefined : saveTarget === "user" ? source.backend?.userSkillsDirectory ? `${source.backend.userSkillsDirectory}/${targetName}` : undefined : developmentRoot ? `${developmentRoot}/.omp/skills/${targetName}` : undefined;
  const collision = design.listSkills(workspacePath).some(skill => skill.path === `${targetDirectory}/SKILL.md`);
  const file = preview?.files.find(item => item.path === selectedFile) ?? preview?.files[0];
  const updateDraft = (next: DevSkillDesignDraft) => { setDraft(next); design.saveDraft(sessionId, next); setNotice(""); };
  useEffect(() => {
    const subscription = design.subscribe(id => {
      if (id !== sessionId) return;
      setDraft(design.read(sessionId));
      const next = design.readPreview(sessionId);
      if (previewRevision.current !== next?.revision) { setSavedPath(""); setError(""); }
      previewRevision.current = next?.revision;
      setPreview(next);
    });
    return () => subscription.dispose();
  }, [design, sessionId]);
  const handleInsertApplied = useCallback((appliedId: number) => {
    if (pendingInsert.current?.requestId !== appliedId) return;
    lastFilledText.current = pendingInsert.current.text;
    pendingInsert.current = null;
    setFillError("");
    setInsertRequest(null);
    setNotice("已将全部字段与临时路径填入右侧输入框，保留原有内容。可直接发送，也可继续补充；尚未生成文件。");
  }, []);
  const fillComposer = () => {
    if (source.capabilities.settingsWrite !== true) { setUnsupportedOpen(true); return; }
    setTab("chat");
    if (pendingInsert.current) return;
    setNotice(""); setFillError("");
    const request: ExternalTextInsertRequest = { requestId: ++requestId.current, text: design.prompt(sessionId, draft), mode: "append", replaceText: lastFilledText.current };
    pendingInsert.current = request;
    setInsertRequest(request);
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
  const fillExample = () => {
    const next = { ...draft };
    const sample = design.sample!;
    for (const field of SKILL_DESIGN_FIELDS) if (!next[field.id].trim()) next[field.id] = sample[field.id];
    updateDraft(next); setOptionalOpen(true);
    setNotice("已填入空白字段；尚未发送，也未生成文件。");
  };
  const save = () => {
    if (source.capabilities.settingsWrite !== true) { setUnsupportedOpen(true); return; }
    if (!targetDirectory || !preview || !validName || collision || savedPath) return;
    try { setSavedPath(design.savePreview(sessionId, developmentRoot ?? "", targetName, saveTarget)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "演示保存失败。"); }
  };
  return <div className="flex h-[calc(100dvh-9rem)] min-h-[34rem] flex-col gap-3" data-testid="dev-skill-design">
    <AlertDialog open={unsupportedOpen} onOpenChange={setUnsupportedOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>当前访问方式不支持 Skill 设计</AlertDialogTitle><AlertDialogDescription>当前账号只支持查看技能，只有当前 Web 的所有者可设计或保存技能。请启动自己的 OMP Web 修改自己的技能。本次未填入或发送任何内容。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogAction>知道了</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-ui-sm text-foreground-subtle">填写说明 → 填入聊天并发送 → 预览临时文件 → 选择保存到项目或个人技能目录</p>
      <div className="flex min-w-0 items-center gap-2 text-ui-sm"><FolderGit2 className="size-3.5 text-foreground-subtle" /><span className="truncate">{projectName}</span><Badge variant="outline">原型演示</Badge></div>
    </div>
    <DevAgentModelSummary binding={modelBinding} />
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
      <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border" aria-labelledby="skill-design-brief-title">
        <div className="shrink-0 space-y-2 border-b border-border p-4">
          <div className="flex items-center justify-between gap-2"><h3 id="skill-design-brief-title" className="text-ui-base font-medium">技能说明</h3><div className="flex items-center gap-2"><span className="text-ui-sm text-foreground-subtle">核心说明 {completed}/{coreFields.length}</span>{design.sample && <Button variant="ghost" size="sm" onClick={fillExample}>填入示例</Button>}</div></div>
          <p className="text-ui-sm text-foreground-subtle">表单用于整理给模型的需求。信息不完整也可先讨论；技能标识由模型推荐，无需预先填写。</p>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-testid="skill-design-fields">
          {coreFields.map(field => <div key={field.id} className="space-y-1.5"><div className="flex items-center justify-between gap-2"><Label htmlFor={`skill-design-${field.id}`}>{field.label}</Label>{Boolean(draft[field.id].trim()) && <Check className="size-3.5 text-foreground-subtle" aria-label="已填写" />}</div><SettingsFormTextarea id={`skill-design-${field.id}`} rows={2} className="min-h-20 w-full" value={draft[field.id]} placeholder={field.placeholder} onChange={event => updateDraft({ ...draft, [field.id]: event.target.value })} /><p className="text-ui-sm text-foreground-subtle">{field.hint}</p></div>)}
          <Collapsible open={optionalOpen} onOpenChange={setOptionalOpen}><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="px-0"><ChevronDown className={`size-3 transition-transform ${optionalOpen ? "" : "-rotate-90"}`} />补充字段（选填）</Button></CollapsibleTrigger><CollapsibleContent><div className="space-y-4 pt-3">{SKILL_DESIGN_FIELDS.filter(field => !field.required).map(field => <div key={field.id} className="space-y-1.5"><Label htmlFor={`skill-design-${field.id}`}>{field.label}</Label><SettingsFormTextarea id={`skill-design-${field.id}`} rows={3} className="w-full" value={draft[field.id]} placeholder={field.placeholder} onChange={event => updateDraft({ ...draft, [field.id]: event.target.value })} /><p className="text-ui-sm text-foreground-subtle">{field.hint}</p></div>)}</div></CollapsibleContent></Collapsible>
        </div>
        <div className="shrink-0 space-y-2 border-t border-border p-3">
          <p className="text-ui-sm text-foreground-subtle">模型生成位置（临时目录）</p><p className="break-all font-mono text-ui-sm text-foreground-subtle">{temporaryDirectory}</p>
          {fillError && <p role="alert" className="text-ui-sm text-destructive">{fillError}</p>}
          {insertRequest && <p role="status" className="text-ui-sm text-foreground-subtle">正在填入聊天输入框…</p>}
          {notice && <p role="status" className="text-ui-sm text-foreground-subtle">{notice}</p>}
          <Button className="w-full" disabled={Boolean(insertRequest)} onClick={fillComposer}><Copy className="size-3.5" />填入右侧聊天输入框</Button>
        </div>
      </section>
      <Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2"><TabsList aria-label="技能设计工作区"><TabsTrigger value="chat"><MessageSquare className="size-3.5" />设计对话</TabsTrigger><TabsTrigger value="preview"><FileCode2 className="size-3.5" />临时文件预览</TabsTrigger></TabsList>{preview && <span className="text-ui-sm text-foreground-subtle">{savedPath ? "已保存（演示）" : `临时文件样例 · 第 ${preview.revision} 版`}</span>}</div>
        <TabsContent forceMount value="chat" className={tab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <p className="shrink-0 border-b border-border px-3 py-2 text-ui-sm text-foreground-subtle">发送前可编辑和补充。原型发送后展示固定文件样例，不调用真实模型。</p>
          <div className="relative min-h-0 flex-1" data-testid="skill-design-chat">
            <V4PaneConversationProvider scope={scope} sessionId={sessionId}><SessionPane paneId={`skill-designer-${projectId}`} sessionId={sessionId} rootSessionId={sessionId} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} embedded focused={tab === "chat"} composerInsertRequest={insertRequest} onComposerInsertApplied={handleInsertApplied} /></V4PaneConversationProvider>
          </div>
        </TabsContent>
        <TabsContent forceMount value="preview" className={tab === "preview" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" data-testid="skill-design-preview">
            {!preview ? <div className="flex h-full flex-col items-center justify-center gap-3 text-center"><FileCode2 className="size-6 text-foreground-subtle" /><p className="text-ui-base">尚未生成临时文件</p><p className="max-w-sm text-ui-sm text-foreground-subtle">先把说明填入聊天输入框，确认或补充后发送，再查看临时目录中的文件。填写或复制表单不会生成技能。</p><Button variant="outline" onClick={() => setTab("chat")}>返回设计对话</Button></div> : <>
              <p className="text-ui-sm text-foreground-subtle">临时目录（内存演示）</p><p className="break-all font-mono text-ui-sm">{preview.directory}</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="临时技能文件">{preview.files.map(item => <Button key={item.path} size="sm" variant={file?.path === item.path ? "secondary" : "ghost"} aria-pressed={file?.path === item.path} onClick={() => setSelectedFile(item.path)}><FileCode2 className="size-3.5" />{item.path}</Button>)}</div>
              <p className="break-all font-mono text-ui-sm text-foreground-subtle">{preview.directory}/{file?.path}</p>
              <pre className="whitespace-pre-wrap break-words rounded-lg border border-border p-4 font-mono text-ui-sm">{file?.content}</pre>
              <p className="text-ui-sm text-foreground-subtle">这是固定文件样例，不代表真实模型生成或磁盘文件。继续发送修改要求后可再次预览。</p>
            </>}
          </div>
          <div className="shrink-0 space-y-2 border-t border-border p-3" data-testid="skill-design-save-target">
            <p className="text-ui-sm">技能标识（模型推荐）：<span className="font-mono">{preview?.name ?? "发送后由模型推荐"}</span></p>
            <div className="space-y-1.5"><Label htmlFor="skill-save-scope">保存到</Label><Select value={saveTarget} disabled={Boolean(savedPath)} onValueChange={value => { setSaveTarget(value as "project" | "user"); setError(""); }}><SelectTrigger id="skill-save-scope" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="project">项目技能 · 我的开发项目</SelectItem><SelectItem value="user">个人技能 · 我的 OMP</SelectItem></SelectContent></Select></div>
            <p className="text-ui-sm text-foreground-subtle">{saveTarget === "project" ? `我的开发项目：${projectName}` : `个人技能归属：${source.backend?.owner ?? "当前开发者"}，可用于自己的不同项目`}</p><p className="break-all font-mono text-ui-sm text-foreground-subtle">{targetDirectory ?? "发送并预览后显示保存路径；项目目标须登记“我的开发项目”，个人目标无需绑定项目。"}</p>
            {preview && <p className="text-ui-sm text-foreground-subtle">确认保存整个临时技能目录中的 {preview.files.length} 个文件；不会覆盖同名技能。当前只演示，不写磁盘。</p>}
            {preview && !validName && <p role="alert" className="text-ui-sm text-destructive">标识只能包含小写字母、数字和连字符，最长 64 个字符。</p>}
            {collision && !savedPath && <p role="alert" className="text-ui-sm text-destructive">所选目标已有同名技能，请返回对话让模型推荐其他标识，再预览保存。</p>}
            {error && <p role="alert" className="text-ui-sm text-destructive">{error}</p>}
            {savedPath && <p role="status" className="break-all text-ui-sm text-foreground-subtle">已演示保存全部文件到 {targetDirectory}，未写入真实文件。</p>}
            <div className="flex items-center justify-end gap-2"><Button variant="ghost" onClick={() => { setTab("chat"); }}>继续讨论修改</Button><Button disabled={!targetDirectory || !preview || collision || !validName || Boolean(savedPath)} onClick={save}>确认保存技能（演示）</Button></div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  </div>;
}
