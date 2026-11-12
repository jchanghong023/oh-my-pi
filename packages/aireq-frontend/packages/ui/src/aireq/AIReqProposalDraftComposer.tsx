import { useMemo } from "react";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { useAIReq } from "./AIReqContext.js";
import { useAIReqDataSource } from "./data-source.js";

/** 显式进入的未发送草稿，只使用原生输入框，不分配提案记录或模型会话。 */
export function AIReqProposalDraftComposer() {
  const aireq = useAIReq()!;
  const source = useAIReqDataSource();
  const workspace = source.resolveWorkspace(aireq.view, aireq.selection);
  const scope = useMemo(() => ({ workspacePath: workspace.path ?? "", workspaceIdentity: workspace.identity }), [workspace.path, workspace.identity]);
  if (!workspace.path) return <p className="mx-auto w-full min-w-0 max-w-4xl p-6 text-ui-base text-foreground-subtle">{workspace.error ?? "请先选择有效项目。"}</p>;
  return <div className="relative flex min-h-0 flex-1 flex-col" data-testid="aireq-proposal-draft">
    <div className="shrink-0 border-b border-border px-4 py-4 md:px-6 md:py-6"><p className="mx-auto w-full max-w-4xl text-ui-sm text-foreground-subtle">先描述目标或当前问题、使用者与场景、期望结果。不必一次写全，AI 会追问澄清；明确发送后才开始生成需求材料，可随时切换回来续写。</p></div>
    <V4PaneConversationProvider scope={scope} sessionId={null}>
      <SessionPane paneId={`aireq-new-proposal-${aireq.selection.proposalDraftId}`} sessionId={null} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} composerPlaceholder="想解决什么问题？为谁、在什么场景使用？期望什么结果？" embedded focused />
    </V4PaneConversationProvider>
  </div>;
}
