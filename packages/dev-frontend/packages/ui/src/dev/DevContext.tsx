import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ComposerDraftHandoff } from "../v4/composer/composerDraftWorkspaceTransfer.js";
import type { ConversationComposerSendOptions } from "../v4/ConversationComposer.js";
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog.js";
import { getEmployeeId } from "./identity.js";
import { useDevDataSource } from "./data-source.js";
import type {
  DevAction, DevMaterialView, DevNativeSessionRef, DevSelection, DevWorkflowResult, DevWorkflowStage, DevWorkflowView,
} from "./types.js";

export type { DevWorkflowView, DevWorkflowStage, DevMaterialView, DevSelection };
export const DEV_STAGES: DevWorkflowStage[] = ["planning", "executing", "pr"];
export const DEV_STAGE_LABELS = { solution: "方案", planning: "开发计划", executing: "开发与验证", pr: "交付 PR" };
export function devQuery(selection: DevSelection): string {
  const query = new URLSearchParams();
  for (const key of ["projectId", "irId", "srId"] as const) if (selection[key]) query.set(key, selection[key]!);
  return query.toString();
}
export interface DevFirstDiscussion {
  session: DevNativeSessionRef;
  handoff: ComposerDraftHandoff;
  text: string;
  options: ConversationComposerSendOptions;
}
interface DevContextValue {
  view?: DevWorkflowView; selection: DevSelection; session?: DevNativeSessionRef;
  startProposalDraft(): void;
  startFreeChat(projectId?: string, files?: boolean): void; openFreeChat(taskId: string, files?: boolean): void;
  pending: boolean; error?: string; releaseId: string; setReleaseId(id: string): void;
  select(value: DevSelection): void; refresh(): Promise<void>; retryMaterial(path: string): Promise<boolean>; retrySession(): Promise<void>;
  command(value: DevAction): Promise<DevWorkflowResult | undefined>;
  firstDiscussion?: DevFirstDiscussion;
  openFirstDiscussion(handoff: ComposerDraftHandoff, text: string, options: ConversationComposerSendOptions): Promise<void>;
  takeFirstDiscussion(sessionId: string): DevFirstDiscussion | undefined;
  finishFirstDiscussion(incoming: DevFirstDiscussion, error?: unknown): void;
  report(error: unknown): void;
}
const DevContext = createContext<DevContextValue | null>(null);
export const useDev = () => useContext(DevContext);

function scopeProposalDraft(value: DevSelection, webId: string): DevSelection {
  if (value.freeDraftId) {
    try {
      const key = JSON.parse(value.freeDraftId);
      if (Array.isArray(key) && key[0] === webId && key[1] === getEmployeeId() && key[2] === value.projectId) return value;
    } catch { /* 不恢复其他 Web、账号或项目的自由会话草稿。 */ }
    return { projectId: value.projectId };
  }
  if (!value.proposalDraftId) return value;
  try {
    const key = JSON.parse(value.proposalDraftId);
    if (Array.isArray(key) && key[0] === webId && key[1] === getEmployeeId() && key[2] === value.projectId && key[3] === value.proposalDraftReleaseId) return value;
  } catch { /* 无效历史记录不恢复其他账号的未发送输入。 */ }
  return { projectId: value.projectId };
}

/** One UI state controller; the entry point owns data and execution authority. */
export function DevProvider({ children }: { children: ReactNode }) {
  const source = useDevDataSource();
  const [selection, setSelection] = useState<DevSelection>(() => scopeProposalDraft(source.mode === "prototype" && window.history.state?.devSelection ? window.history.state.devSelection as DevSelection : { ...source.initialSelection }, source.backend?.id ?? source.clientId));
  const selectionRef = useRef(selection);
  const [view, setView] = useState<DevWorkflowView>();
  const viewRef = useRef(view);
  const [error, setError] = useState<string>();
  const [ownWebNotice, setOwnWebNotice] = useState(false);
  const [pending, setPending] = useState(true);
  const [releaseId, updateReleaseId] = useState("");
  const requestRevision = useRef(0);
  const firstDiscussionRef = useRef<DevFirstDiscussion | undefined>(undefined);
  const provisional = useRef(new Map<string, { projectId: string; irId: string }>());
  const creatingFirst = useRef<Promise<void> | null>(null);
  const claimed = useRef<DevFirstDiscussion | undefined>(undefined);
  const [firstDiscussion, setFirstDiscussion] = useState<DevFirstDiscussion>();
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const load = useCallback(async (target: DevSelection, projectChanged = false) => {
    const revision = ++requestRevision.current;
    setPending(true);
    try {
      const next = await source.readWorkflow(target);
      if (revision !== requestRevision.current) return;
      for (const [key, item] of provisional.current) if (next.drafts.some(group => group.id === item.irId && group.projectId === item.projectId && !group.pendingFirstMessage)) provisional.current.delete(key);
      viewRef.current = next;
      setView(next);
      setError(next.error);
      updateReleaseId(current => !projectChanged && next.releases.some(item => item.id === current) ? current : next.releases[0]?.id ?? "");
    } catch (cause) {
      if (revision === requestRevision.current) report(cause);
    } finally {
      if (revision === requestRevision.current) setPending(false);
    }
  }, [source, report]);
  const refresh = useCallback(() => load(selectionRef.current), [load]);
  useEffect(() => {
    void refresh();
    const unsubscribe = source.subscribeWorkflow(() => { void refresh(); });
    return () => { unsubscribe(); requestRevision.current += 1; };
  }, [source, refresh]);
  const select = useCallback((value: DevSelection, addHistory = true) => {
    value = scopeProposalDraft(value, source.backend?.id ?? source.clientId);
    const projectChanged = selectionRef.current.projectId !== value.projectId;
    if (source.mode === "prototype" && addHistory) window.history.pushState({ ...window.history.state, devSelection: value }, "");
    source.selectProject(value.projectId);
    selectionRef.current = value;
    setSelection(value);
    setError(undefined);
    void load(value, projectChanged);
    if (firstDiscussionRef.current && firstDiscussionRef.current.session.irId !== value.irId) {
      firstDiscussionRef.current = undefined;
      setFirstDiscussion(undefined);
    }
  }, [source, load]);
  useEffect(() => {
    if (source.mode !== "prototype") return;
    window.history.replaceState({ ...window.history.state, devSelection: selectionRef.current }, "");
    const restore = (event: PopStateEvent) => {
      if (event.state?.devSelection) select(event.state.devSelection as DevSelection, false);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [source, select]);
  const startProposalDraft = useCallback(() => {
    const projectId = selectionRef.current.projectId;
    if (!projectId || !releaseId || !source.capabilities.workflowCommands.includes("createProposal")) return;
    const key = JSON.stringify([source.backend?.id ?? source.clientId, getEmployeeId(), projectId, releaseId]);
    const retry = provisional.current.get(key);
    const target: DevSelection = retry ? { projectId, irId: retry.irId } : { projectId, proposalDraftId: key, proposalDraftReleaseId: releaseId };
    const current = selectionRef.current;
    if (current.projectId === projectId && (retry ? current.irId === retry.irId : current.proposalDraftId === key && !current.irId)) return;
    select(target);
  }, [source, releaseId, select]);
  const startFreeChat = useCallback((projectId?: string, files = false) => {
    const targetProjectId = projectId ?? selectionRef.current.projectId;
    if (!targetProjectId) { report(new Error("请先选择项目。")); return; }
    if (!source.capabilities.freeChat || !source.capabilities.codeDevelopment) { setOwnWebNotice(true); return; }
    const root = source.projects?.readDevelopmentRoot(targetProjectId, getEmployeeId());
    if (!root) { report(new Error("请先配置本项目的 Git 开发路径。")); return; }
    // 与 WebGUI 新建任务一致：只选择 null 会话草稿，首发由原生输入框创建并接纳。
    const key = JSON.stringify([source.backend?.id ?? source.clientId, getEmployeeId(), targetProjectId, root]);
    const current = selectionRef.current;
    if (current.freeDraftId === key && Boolean(current.freeFiles) === files) return;
    select({ projectId: targetProjectId, freeDraftId: key, freeFiles: files });
  }, [source, select, report]);
  const openFreeChat = useCallback((taskId: string, files = false) => {
    if (!source.capabilities.codeDevelopment) { setOwnWebNotice(true); return; }
    void source.readFreeChat(taskId).then(item => {
      if (!item) { report(new Error("自由会话不存在或已移除。")); return; }
      select({ projectId: item.projectId, freeSessionId: taskId, freeFiles: files });
    }, report);
  }, [source, select, report]);
  const setReleaseId = useCallback((id: string) => {
    const current = selectionRef.current;
    const data = viewRef.current;
    if (!data?.releases.some(item => item.id === id)) return;
    updateReleaseId(id);
    if (current.proposalDraftId && current.projectId) {
      const key = JSON.stringify([source.backend?.id ?? source.clientId, getEmployeeId(), current.projectId, id]);
      select({ projectId: current.projectId, proposalDraftId: key, proposalDraftReleaseId: id });
      return;
    }
    const selected = [...data.groups, ...data.drafts].find(item => item.id === current.irId);
    if (selected && selected.releaseId !== id) select({ projectId: current.projectId });
  }, [source, select]);
  const retryMaterial = useCallback(async (path: string) => {
    try {
      const recovered = await source.retryMaterial(path, selectionRef.current);
      await refresh();
      return recovered;
    } catch (cause) { report(cause); return false; }
  }, [source, refresh, report]);
  const retrySession = useCallback(async () => {
    try { await source.retrySession(selectionRef.current); await refresh(); }
    catch (cause) { report(cause); }
  }, [source, refresh, report]);
  const command = useCallback(async (value: DevAction) => {
    const target = selectionRef.current;
    try {
      const result = await source.command(value, target, viewRef.current?.revision ?? 0);
      if (result.status === "failed") throw new Error(result.error ?? result.receipt.error ?? "操作失败。");
      // An operation completing in the background must not navigate a different view.
      if (selectionRef.current !== target) return result;
      if (value.type === "createProposal") select({ projectId: result.projectId, irId: result.irId });
      else if (value.type === "beginProposalRevision") select({ projectId: result.projectId, irId: result.irId, discussionPhase: "requirements" });
      else if (value.type === "markRequirementsMerged") select({ projectId: target.projectId, irId: target.irId });
      else if (["submitProposalReview", "acceptProposal", "generateProposalSolution", "returnProposal"].includes(value.type)) select({ ...target, discussionPhase: undefined });
      else if (value.type === "deleteRequirement") select({ projectId: target.projectId });
      else if (["startSr", "approveStage", "backStage"].includes(value.type)) select({ projectId: target.projectId, irId: target.irId, srId: target.srId });
      else await refresh();
      setError(undefined);
      return result;
    } catch (cause) { report(cause); return undefined; }
  }, [source, refresh, report, select]);
  const openFirstDiscussion = useCallback(async (handoff: ComposerDraftHandoff, text: string, options: ConversationComposerSendOptions) => {
    if (creatingFirst.current) return creatingFirst.current;
    if (!text.trim() && !handoff.attachments.length) throw new Error("请先输入需求内容或添加附件，再发送。");
    const target = selectionRef.current;
    const targetRelease = target.proposalDraftReleaseId ?? releaseId;
    const key = target.proposalDraftId ?? JSON.stringify([source.backend?.id ?? source.clientId, getEmployeeId(), target.projectId, targetRelease]);
    const create = async () => {
      const result = await command({ type: "createProposal", projectId: target.projectId, releaseId: targetRelease, clientDraftId: key });
      const createdSelection = { projectId: result?.projectId, irId: result?.irId };
      const session = result?.view && source.resolveSession(result.view, createdSelection);
      if (!session || !result?.irId || !result.projectId) throw new Error("需求讨论会话尚未就绪。输入内容未发送。");
      provisional.current.set(key, { projectId: result.projectId, irId: result.irId });
      const incoming = { session, handoff, text, options };
      firstDiscussionRef.current = incoming;
      claimed.current = undefined;
      setFirstDiscussion(incoming);
    };
    const flight = create();
    creatingFirst.current = flight;
    try { await flight; } finally { if (creatingFirst.current === flight) creatingFirst.current = null; }
  }, [source, command, releaseId]);
  const takeFirstDiscussion = useCallback((sessionId: string) => {
    const incoming = firstDiscussionRef.current;
    if (!incoming || claimed.current === incoming || incoming.session.sessionId !== sessionId) return;
    claimed.current = incoming;
    return incoming;
  }, []);
  const finishFirstDiscussion = useCallback((incoming: DevFirstDiscussion, cause?: unknown) => {
    if (firstDiscussionRef.current !== incoming) return;
    firstDiscussionRef.current = undefined;
    setFirstDiscussion(undefined);
    if (cause === undefined) {
      for (const [key, item] of provisional.current) if (item.irId === incoming.session.irId) provisional.current.delete(key);
    }
    if (cause !== undefined) report(cause);
  }, [report]);
  return <DevContext.Provider value={{ view, selection, session: view && source.resolveSession(view, selection), pending,
    error, releaseId, setReleaseId, select, refresh, retryMaterial, retrySession, command, report, firstDiscussion, startProposalDraft, startFreeChat, openFreeChat,
    openFirstDiscussion, takeFirstDiscussion, finishFirstDiscussion }}>{children}
    <AlertDialog open={ownWebNotice} onOpenChange={setOwnWebNotice}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>请进入自己的 OMP Web</AlertDialogTitle>
          <AlertDialogDescription>请在自己启动的 OMP Web 中登录，并配置开发项目路径后使用自由会话。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogAction>知道了</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </DevContext.Provider>;
}
