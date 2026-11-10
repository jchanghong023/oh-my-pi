import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { ComposerDraftHandoff } from "../v4/composer/composerDraftWorkspaceTransfer.js";
import type { ConversationComposerSendOptions } from "../v4/ConversationComposer.js";
import type {
  DevAction, DevMaterialView, DevNativeSessionRef, DevSelection, DevWorkflowResult, DevWorkflowStage, DevWorkflowView,
} from "./mock/types.js";
import { createPrototypeFreeChat, readPrototypeFreeChat, setPrototypeFreeProject } from "./mock/free-chats.js";
import { applyPrototypeAction, DEFAULT_SELECTION, getPrototypeWorkflow, resolvePrototypeSession, PROTOTYPE_RELEASE_ID } from "./mock/workflow.js";

export type { DevWorkflowView, DevWorkflowStage, DevMaterialView, DevSelection };
export const DEV_STAGES: DevWorkflowStage[] = ["planning", "executing", "pr"];
export const DEV_STAGE_LABELS = { planning: "开发计划", executing: "开发与验证", pr: "交付 PR" };
export const devClientId = "frontend-prototype-tab";
export function devQuery(selection: DevSelection): string {
  const query = new URLSearchParams();
  for (const key of ["projectId", "irId", "srId"] as const) if (selection[key]) query.set(key, selection[key]!);
  return query.toString();
}
export function nativeTarget(view: DevWorkflowView | undefined, selection: DevSelection): DevNativeSessionRef | undefined {
  return view ? resolvePrototypeSession(view, selection) : undefined;
}
export interface DevFirstDiscussion {
  session: DevNativeSessionRef;
  handoff: ComposerDraftHandoff;
  text: string;
  options: ConversationComposerSendOptions;
}
interface DevContextValue {
  view?: DevWorkflowView; selection: DevSelection; session?: DevNativeSessionRef;
  startFreeChat(projectId?: string): void; openFreeChat(taskId: string, files?: boolean): void;
  pending: boolean; error?: string; releaseId: string; setReleaseId(id: string): void;
  select(value: DevSelection): void; refresh(): Promise<void>;
  command(value: DevAction): Promise<DevWorkflowResult | undefined>;
  firstDiscussion?: DevFirstDiscussion;
  openFirstDiscussion(handoff: ComposerDraftHandoff, text: string, options: ConversationComposerSendOptions): Promise<void>;
  takeFirstDiscussion(sessionId: string): DevFirstDiscussion | undefined;
  finishFirstDiscussion(incoming: DevFirstDiscussion, error?: unknown): void;
  report(error: unknown): void;
}
const DevContext = createContext<DevContextValue | null>(null);
export const useDev = () => useContext(DevContext);
/** Phase-one frontend prototype. All interactions below are in-memory presentation only.
 * Real OMP integration and actual business acceptance resume after prototype confirmation. */
export function DevProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<DevSelection>({ ...DEFAULT_SELECTION });
  const selectionRef = useRef(selection);
  const [view, setView] = useState<DevWorkflowView>(() => getPrototypeWorkflow(DEFAULT_SELECTION));
  const [error, setError] = useState<string>();
  const [releaseId, updateReleaseId] = useState(PROTOTYPE_RELEASE_ID);
  const firstDiscussionRef = useRef<DevFirstDiscussion | undefined>(undefined);
  const claimed = useRef<DevFirstDiscussion | undefined>(undefined);
  const [firstDiscussion, setFirstDiscussion] = useState<DevFirstDiscussion>();
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const select = useCallback((value: DevSelection) => {
    const projectChanged = selectionRef.current.projectId !== value.projectId;
    setPrototypeFreeProject(value.projectId);
    selectionRef.current = value;
    setSelection(value);
    const next = getPrototypeWorkflow(value);
    setView(next);
    setError(undefined);
    updateReleaseId(current => !projectChanged && next.releases.some(item => item.id === current) ? current : next.releases[0]?.id ?? "");
    if (firstDiscussionRef.current && firstDiscussionRef.current.session.irId !== value.irId) {
      firstDiscussionRef.current = undefined;
      setFirstDiscussion(undefined);
    }
  }, []);
  const startFreeChat = useCallback((projectId?: string) => {
    try { const meta = createPrototypeFreeChat(projectId ?? selectionRef.current.projectId!); select({ projectId: meta.projectId!, freeSessionId: meta.taskId }); }
    catch (cause) { report(cause); }
  }, [select, report]);
  const openFreeChat = useCallback((taskId: string, files = false) => {
    const item = readPrototypeFreeChat(taskId); if (!item) { report(new Error("自由会话不存在或已移除。")); return; }
    select({ projectId: item.meta.projectId!, freeSessionId: taskId, freeFiles: files });
  }, [select, report]);
  const setReleaseId = useCallback((id: string) => {
    const current = selectionRef.current;
    const data = getPrototypeWorkflow(current);
    if (!data.releases.some(item => item.id === id)) return;
    updateReleaseId(id);
    const selected = [...data.groups, ...data.drafts].find(item => item.id === current.irId);
    if (selected && selected.releaseId !== id) select({ projectId: current.projectId });
  }, [select]);
  const refresh = useCallback(async () => { setView(getPrototypeWorkflow(selectionRef.current)); }, []);
  const command = useCallback(async (value: DevAction) => {
    const target = selectionRef.current;
    try {
      const result = applyPrototypeAction(value, target);
      if (value.type === "createProposal") select({ projectId: result.projectId, irId: result.irId });
      else if (value.type === "markRequirementsMerged") select({ projectId: target.projectId, irId: target.irId });
      else if (["submitProposalReview", "generateProposalSolution", "returnProposal"].includes(value.type)) select({ ...target, discussionPhase: undefined });
      else if (value.type === "deleteRequirement") select({ projectId: target.projectId });
      else if (["startSr", "approveStage", "backStage"].includes(value.type)) select({ projectId: target.projectId, irId: target.irId, srId: target.srId });
      else {
        const next = getPrototypeWorkflow(target);
        setView(next);
        updateReleaseId(current => next.releases.some(item => item.id === current) ? current : next.releases[0]?.id ?? "");
      }
      setError(undefined);
      return result;
    } catch (cause) { report(cause); return undefined; }
  }, [report, select]);
  const openFirstDiscussion = useCallback(async (handoff: ComposerDraftHandoff, text: string, options: ConversationComposerSendOptions) => {
    const target = selectionRef.current;
    const result = await command({ type: "createProposal", projectId: target.projectId, releaseId });
    const session = result?.view && nativeTarget(result.view, selectionRef.current);
    if (!session) throw new Error("前端样例讨论尚未选择。输入内容未发送。");
    const incoming = { session, handoff, text, options };
    firstDiscussionRef.current = incoming;
    claimed.current = undefined;
    setFirstDiscussion(incoming);
  }, [command, releaseId]);
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
    if (cause !== undefined) report(cause);
  }, [report]);
  return <DevContext.Provider value={{ view, selection, session: nativeTarget(view, selection), pending: false,
    error, releaseId, setReleaseId, select, refresh, command, report, firstDiscussion, startFreeChat, openFreeChat,
    openFirstDiscussion, takeFirstDiscussion, finishFirstDiscussion }}>{children}</DevContext.Provider>;
}
