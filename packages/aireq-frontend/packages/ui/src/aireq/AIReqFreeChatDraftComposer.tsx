import { useCallback, useMemo } from "react";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { useAIReq } from "./AIReqContext.js";
import { useAIReqDataSource } from "./data-source.js";

/** 复用 WebGUI 的 null 会话草稿与首发接纳，不在点击入口时分配会话记录。 */
export function AIReqFreeChatDraftComposer() {
  const aireq = useAIReq()!;
  const source = useAIReqDataSource();
  const workspace = source.resolveWorkspace(aireq.view, aireq.selection);
  const scope = useMemo(() => ({ workspacePath: workspace.path ?? "", workspaceIdentity: workspace.identity }), [workspace.path, workspace.identity]);
  const onCreated = useCallback((sessionId: string) => aireq.openFreeChat(sessionId, aireq.selection.freeFiles), [aireq.openFreeChat, aireq.selection.freeFiles]);
  if (!workspace.path) return <p className="mx-auto w-full min-w-0 max-w-4xl p-6 text-ui-base text-foreground-subtle">{workspace.error ?? "请先配置自己的开发项目路径。"}</p>;
  return <div className="relative flex min-h-0 flex-1 flex-col" data-testid="aireq-free-chat-draft">
    <V4PaneConversationProvider scope={scope} sessionId={null}>
      <SessionPane paneId="aireq-new-free-chat" sessionId={null} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} onSessionCreated={onCreated} embedded focused />
    </V4PaneConversationProvider>
  </div>;
}
