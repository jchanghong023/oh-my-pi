import { useCallback, useMemo } from "react";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { useDev } from "./DevContext.js";
import { useDevDataSource } from "./data-source.js";

/** 复用 WebGUI 的 null 会话草稿与首发接纳，不在点击入口时分配会话记录。 */
export function DevFreeChatDraftComposer() {
  const dev = useDev()!;
  const source = useDevDataSource();
  const workspace = source.resolveWorkspace(dev.view, dev.selection);
  const scope = useMemo(() => ({ workspacePath: workspace.path ?? "", workspaceIdentity: workspace.identity }), [workspace.path, workspace.identity]);
  const onCreated = useCallback((sessionId: string) => dev.openFreeChat(sessionId, dev.selection.freeFiles), [dev.openFreeChat, dev.selection.freeFiles]);
  if (!workspace.path) return <p className="p-6 text-ui-base text-foreground-subtle">{workspace.error ?? "请先配置自己的开发项目路径。"}</p>;
  return <div className="relative flex min-h-0 flex-1 flex-col" data-testid="dev-free-chat-draft">
    <V4PaneConversationProvider scope={scope} sessionId={null}>
      <SessionPane paneId="dev-new-free-chat" sessionId={null} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} onSessionCreated={onCreated} embedded focused />
    </V4PaneConversationProvider>
  </div>;
}
