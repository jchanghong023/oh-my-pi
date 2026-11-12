import { useAIReqDataSource } from "./data-source.js";
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

interface AutomationSession { workspacePath: string; workspaceIdentity?: string; sessionId: string }

/** 复用原自动化页面，演示会话独立于 AIReq 的 IR/SR，避免历史查看改变需求目标。 */
export function AIReqAutomations({ workspacePath, workspaceIdentity }: { workspacePath: string; workspaceIdentity?: string }) {
	const source = useAIReqDataSource();
 const [session, setSession] = useState<AutomationSession | null>(null);
	const scope = useMemo(() => ({ workspacePath: session?.workspacePath ?? workspacePath, workspaceIdentity: session ? session.workspaceIdentity : workspaceIdentity }), [session?.workspacePath, session?.workspaceIdentity, workspacePath, workspaceIdentity]);
	return <div data-testid="aireq-automations">
		<AutomationsSection workspacePath={workspacePath} workspaceIdentity={workspaceIdentity} onOpenSession={setSession} />
		<Dialog open={session !== null} onOpenChange={open => { if (!open) setSession(null); }}>
			<DialogContent className="flex h-[80dvh] max-w-4xl flex-col gap-2">
				<DialogTitle>自动化运行会话{source.provenance.kind === "sample" ? "（样例）" : ""}</DialogTitle><DialogDescription>只读查看运行历史，关闭后回到自动化页面，不切换当前 IR/SR。</DialogDescription>
				{session && <div className="relative min-h-0 flex-1"><V4PaneConversationProvider scope={scope} sessionId={session.sessionId}><SessionPane paneId={`automation-preview:${session.sessionId}`} sessionId={session.sessionId} rootSessionId={session.sessionId} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} embedded readOnly readOnlyReason="运行历史，仅供只读查看。" /></V4PaneConversationProvider></div>}
			</DialogContent>
		</Dialog>
	</div>;
}
