import { useAIReqDataSource } from "./data-source.js";
import type { AIReqWorkspace } from "./types.js";
import { useTheme } from "@/useTheme.js";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { useAIReq } from "./AIReqContext.js";
import { AIReqProjectSettings } from "./AIReqProjectSettings.js";

/** 没有可用目录时仍能进入同一项目设置，不向 Root 注入假目录。 */
export function AIReqWorkspaceRecovery({ workspace }: { workspace: AIReqWorkspace }) {
 const source = useAIReqDataSource();
 const aireq = useAIReq()!;
 useTheme();
 const projects = aireq.view?.projects ?? [];
 const [showSettings, setShowSettings] = useState(!projects.length);
 const [projectId, setProjectId] = useState(projects.some(item => item.id === aireq.selection.projectId) ? aireq.selection.projectId! : "");
 const [retried, setRetried] = useState(false);
 const [sampleDirectoryIssue, setSampleDirectoryIssue] = useState<string>();
 useEffect(() => {
  let active = true;
  setSampleDirectoryIssue(undefined);
  if (workspace.blockedPath && source.prototype) void Promise.resolve(source.prototype.directoryIssue(workspace.blockedPath)).then(value => { if (active) setSampleDirectoryIssue(value); }, aireq.report);
  return () => { active = false; };
 }, [source, workspace.blockedPath, aireq.report]);
 return <main className="h-dvh overflow-x-hidden overflow-y-auto bg-background px-4 py-4 text-foreground md:px-6 md:py-6" data-testid="aireq-workspace-unavailable">
  <div className="mx-auto w-full min-w-0 max-w-4xl space-y-6"><section className="space-y-4 rounded-lg border border-border p-6">
   <h1 className="text-ui-base font-semibold">{projects.length ? "当前工作区不可用" : "添加第一个项目"}</h1>
   <p role={projects.length ? "alert" : "status"} className="text-ui-base leading-6">{workspace.error}</p>
   {workspace.blockedPath && <p className="break-all font-mono text-ui-sm text-foreground-subtle" data-testid="recovery-directory-path">{workspace.blockedPath}</p>}
   <p className="text-ui-sm text-foreground-subtle">{!projects.length ? "先添加已有 Git 项目，再选择项目及 Release；不会自动创建需求或会话。" : workspace.blockedPath ? "当前选择保持不变；重试只读取状态，不发送消息、不推进流程。恢复原目录后可读回已保存的会话草稿。" : "重新读取不会替换需求或新建会话。也可以返回项目，明确选择其他已有需求。"}</p>
   <div className="flex flex-wrap gap-2">
    <Button variant="outline" onClick={() => { setRetried(true); void aireq.refresh(); }}>重试读取</Button>
    {sampleDirectoryIssue && <Button variant="outline" data-testid="restore-directory-sample" onClick={() => { void Promise.resolve(source.prototype!.restoreDirectory(workspace.blockedPath!)).then(() => aireq.refresh(), aireq.report); }}>恢复目录样例（演示）</Button>}
    {aireq.selection.irId && projects.some(item => item.id === aireq.selection.projectId) && <Button variant="outline" onClick={() => aireq.select({ projectId: aireq.selection.projectId })}>返回项目查看</Button>}
    <Button variant="outline" onClick={() => setShowSettings(value => !value)}>{showSettings ? "收起项目设置" : "项目与 Release 设置"}</Button>
   </div>
   {retried && <p role="status" className="text-ui-sm text-foreground-subtle">重新读取后仍不可用，请按上方原因恢复原目录或重新选择。</p>}
   {Boolean(projects.length) && <div className="flex flex-wrap items-center gap-2"><Select value={projectId || "none"} onValueChange={value => setProjectId(value === "none" ? "" : value)}><SelectTrigger className="w-72" aria-label="选择可查看项目"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">请选择项目</SelectItem>{projects.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select><Button disabled={!projectId} onClick={() => aireq.select({ projectId })}>查看所选项目</Button></div>}
  </section>{showSettings && <section className="rounded-lg border border-border p-6" aria-label="项目与 Release 设置"><AIReqProjectSettings /></section>}
  {source.provenance.kind === "sample" && <p className="text-ui-sm text-foreground-subtle">AIReq 原型 · 故障和恢复仅操作内存样例，不检查或修复真实目录。</p>}</div>
 </main>;
}
