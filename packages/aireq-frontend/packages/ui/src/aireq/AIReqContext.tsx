import type { WorkspaceMainView } from "@/app-shell/types.js";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ComposerDraftHandoff } from "../v4/composer/composerDraftWorkspaceTransfer.js";
import type { ConversationComposerSendOptions } from "../v4/ConversationComposer.js";
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog.js";
import { getEmployeeId } from "./identity.js";
import { useAIReqDataSource } from "./data-source.js";
import { selectionForRelease } from "./domain.js";
import type {
  AIReqAction, AIReqMaterialView, AIReqNativeSessionRef, AIReqSelection, AIReqWorkflowResult, AIReqWorkflowStage, AIReqWorkflowView,
} from "./types.js";

export type { AIReqWorkflowView, AIReqWorkflowStage, AIReqMaterialView, AIReqSelection };
export const AIREQ_STAGES: AIReqWorkflowStage[] = ["planning", "executing", "pr"];
export const AIREQ_STAGE_LABELS = { solution: "方案", planning: "开发计划", executing: "开发与验证", pr: "交付合并" };
export function aiReqQuery(selection: AIReqSelection): string {
  const query = new URLSearchParams();
  for (const key of ["projectId", "irId", "srId"] as const) if (selection[key]) query.set(key, selection[key]!);
  return query.toString();
}
export interface AIReqFirstDiscussion {
  session: AIReqNativeSessionRef;
  handoff: ComposerDraftHandoff;
  text: string;
  options: ConversationComposerSendOptions;
}
interface AIReqContextValue {
  view?: AIReqWorkflowView; selection: AIReqSelection; session?: AIReqNativeSessionRef;
  mainView: WorkspaceMainView; setMainView(value: WorkspaceMainView): void;
  canGoBack: boolean; canGoForward: boolean; goBack(): void; goForward(): void;
  startProposalDraft(): void;
  startFreeChat(projectId?: string, files?: boolean): void; openFreeChat(taskId: string, files?: boolean): void;
  pending: boolean; selectionReady: boolean; error?: string; releaseId: string; setReleaseId(id: string): void;
  switchProject(projectId: string): void;
  select(value: AIReqSelection): void; refresh(): Promise<void>; retryMaterial(path: string): Promise<boolean>; retrySession(): Promise<void>;
  command(value: AIReqAction): Promise<AIReqWorkflowResult | undefined>;
  firstDiscussion?: AIReqFirstDiscussion;
  openFirstDiscussion(handoff: ComposerDraftHandoff, text: string, options: ConversationComposerSendOptions): Promise<void>;
  takeFirstDiscussion(sessionId: string): AIReqFirstDiscussion | undefined;
  finishFirstDiscussion(incoming: AIReqFirstDiscussion, error?: unknown): void;
  report(error: unknown): void;
}
const AIReqContext = createContext<AIReqContextValue | null>(null);
export const useAIReq = () => useContext(AIReqContext);

function scopeProposalDraft(value: AIReqSelection, webId: string): AIReqSelection {
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
export function AIReqProvider({ children }: { children: ReactNode }) {
  const source = useAIReqDataSource();
  // 每次进入工作台都从需求分析开始，不恢复上一位用户或上次登录的页面／需求会话。
  const [selection, setSelection] = useState<AIReqSelection>(() => ({ projectId: source.initialSelection.projectId }));
  const selectionRef = useRef(selection);
  const [navigation, setNavigation] = useState<{ index: number; extent: number; mainView: WorkspaceMainView }>(() => ({
    index: 0, extent: 0, mainView: "requirementAnalysis",
  }));
  const navigationRef = useRef(navigation);
  const recordNavigation = useCallback((target: AIReqSelection, mainView: WorkspaceMainView) => {
    const previous = navigationRef.current;
    const next = { index: previous.index + 1, extent: previous.index + 1, mainView };
    window.history.pushState({ ...window.history.state, aiReqSelection: target, aiReqBackendId: source.backend?.id ?? source.clientId, aiReqNavigationIndex: next.index, aiReqNavigationExtent: next.extent, aiReqMainView: mainView }, "");
    navigationRef.current = next;
    setNavigation(next);
  }, [source]);
  const setMainView = useCallback((mainView: WorkspaceMainView) => {
    if (mainView !== navigationRef.current.mainView) recordNavigation(selectionRef.current, mainView);
  }, [recordNavigation]);

  const [view, setView] = useState<AIReqWorkflowView>();
  const [loadedSelection, setLoadedSelection] = useState<AIReqSelection>();
  const viewRef = useRef(view);
  const [error, setError] = useState<string>();
  const [ownWebNotice, setOwnWebNotice] = useState(false);
  const [pending, setPending] = useState(true);
  const [releaseId, updateReleaseId] = useState("");
  const requestRevision = useRef(0);
  const firstDiscussionRef = useRef<AIReqFirstDiscussion | undefined>(undefined);
  const provisional = useRef(new Map<string, { projectId: string; irId: string }>());
  const creatingFirst = useRef<Promise<void> | null>(null);
  const claimed = useRef<AIReqFirstDiscussion | undefined>(undefined);
  const [firstDiscussion, setFirstDiscussion] = useState<AIReqFirstDiscussion>();
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const load = useCallback(async (target: AIReqSelection, projectChanged = false) => {
    const revision = ++requestRevision.current;
    setPending(true);
    try {
      const next = await source.readWorkflow(target);
      if (revision !== requestRevision.current) return;
      for (const [key, item] of provisional.current) if (next.drafts.some(group => group.id === item.irId && group.projectId === item.projectId && !group.pendingFirstMessage)) provisional.current.delete(key);
      viewRef.current = next;
      setView(next);
      setLoadedSelection({ ...target });
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
  const select = useCallback((value: AIReqSelection, addHistory = true, mainView: WorkspaceMainView = "chat") => {
    value = scopeProposalDraft(value, source.backend?.id ?? source.clientId);
    const projectChanged = selectionRef.current.projectId !== value.projectId;
    if (addHistory && (JSON.stringify(value) !== JSON.stringify(selectionRef.current) || navigationRef.current.mainView !== mainView)) recordNavigation(value, mainView);
    source.selectProject(value.projectId);
    selectionRef.current = value;
    setSelection(value);
    setError(undefined);
    void load(value, projectChanged);
    if (firstDiscussionRef.current && firstDiscussionRef.current.session.irId !== value.irId) {
      firstDiscussionRef.current = undefined;
      setFirstDiscussion(undefined);
    }
  }, [source, load, recordNavigation]);
  const switchProject = useCallback((projectId: string) => {
    const current = selectionRef.current;
    if (current.projectId === projectId) return;
    // 项目切换只改变数据范围；不能复用打开需求时强制返回聊天页的导航行为。
    updateReleaseId("");
    select({ projectId, ...(current.formalView ? { formalView: "list" as const } : {}) }, true, navigationRef.current.mainView);
  }, [select]);
  useEffect(() => {
    window.history.replaceState({ ...window.history.state, aiReqSelection: selectionRef.current, aiReqBackendId: source.backend?.id ?? source.clientId, aiReqNavigationIndex: navigationRef.current.index, aiReqNavigationExtent: navigationRef.current.extent, aiReqMainView: navigationRef.current.mainView }, "");
    const restore = (event: PopStateEvent) => {
      if (event.state?.aiReqBackendId !== (source.backend?.id ?? source.clientId) || !event.state?.aiReqSelection) return;
      const index = Number.isSafeInteger(event.state.aiReqNavigationIndex) ? event.state.aiReqNavigationIndex : 0;
      const mainView: WorkspaceMainView = ["chat", "automations", "skillDesign", "requirementAnalysis", "issueCreate", "issueAnalysis", "issueProgress"].includes(event.state.aiReqMainView) ? event.state.aiReqMainView : "chat";
      const next = { index, extent: navigationRef.current.extent, mainView };
      navigationRef.current = next;
      setNavigation(next);
      window.history.replaceState({ ...event.state, aiReqNavigationExtent: next.extent }, "");
      select(event.state.aiReqSelection as AIReqSelection, false);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [source, select]);
  const startProposalDraft = useCallback(() => {
    const projectId = selectionRef.current.projectId;
    if (!projectId || !releaseId || !source.capabilities.workflowCommands.includes("createProposal")) return;
    const key = JSON.stringify([source.backend?.id ?? source.clientId, getEmployeeId(), projectId, releaseId]);
    const retry = provisional.current.get(key);
    const target: AIReqSelection = retry ? { projectId, irId: retry.irId } : { projectId, proposalDraftId: key, proposalDraftReleaseId: releaseId };
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
    const next = selectionForRelease(current, data, id);
    if (next !== current) select(next);
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
  const command = useCallback(async (value: AIReqAction) => {
    const target = selectionRef.current;
    try {
      const result = await source.command(value, target, viewRef.current?.revision ?? 0);
      if (result.status === "failed") throw new Error(result.error ?? result.receipt.error ?? "操作失败。");
      // An operation completing in the background must not navigate a different view.
      if (selectionRef.current !== target) return result;
      if (value.type === "createProposal") select({ projectId: result.projectId, irId: result.irId });
      else if (value.type === "beginProposalRevision") select({ projectId: result.projectId, irId: result.irId, discussionPhase: "requirements" });
      else if (value.type === "startIrAcceptance") select({ projectId: target.projectId, irId: target.irId, irAcceptance: true });
      else if (value.type === "markRequirementsMerged") select({ projectId: target.projectId, irId: target.irId });
      else if (value.type === "runRequirementsReview" || value.type === "submitProposalReview") select({ ...target, discussionPhase: "requirements", proposalStep: "requirements-review", reviewAgent: undefined, proposalEditing: undefined });
      else if (["acceptProposal", "generateProposalSolution", "returnProposal"].includes(value.type)) select({ ...target, materialPath: undefined, discussionPhase: undefined, proposalStep: undefined, proposalEditing: undefined });
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
  const finishFirstDiscussion = useCallback((incoming: AIReqFirstDiscussion, cause?: unknown) => {
    if (firstDiscussionRef.current !== incoming) return;
    firstDiscussionRef.current = undefined;
    setFirstDiscussion(undefined);
    if (cause === undefined) {
      for (const [key, item] of provisional.current) if (item.irId === incoming.session.irId) provisional.current.delete(key);
    }
    if (cause !== undefined) report(cause);
  }, [report]);
  return <AIReqContext.Provider value={{ view, selection, session: view && source.resolveSession(view, selection), pending,
    selectionReady: Boolean(view && loadedSelection && JSON.stringify(loadedSelection) === JSON.stringify(selection)),
    mainView: navigation.mainView, setMainView, canGoBack: navigation.index > 0, canGoForward: navigation.index < navigation.extent, goBack: () => { if (navigationRef.current.index > 0) window.history.back(); }, goForward: () => { if (navigationRef.current.index < navigationRef.current.extent) window.history.forward(); },
    error, releaseId, setReleaseId, switchProject, select, refresh, retryMaterial, retrySession, command, report, firstDiscussion, startProposalDraft, startFreeChat, openFreeChat,
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
  </AIReqContext.Provider>;
}
