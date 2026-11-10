import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

interface AutomationSession { workspacePath: string; workspaceIdentity?: string; sessionId: string }

/** 复用原自动化页面，演示会话独立于 Dev 的 IR/SR，避免历史查看改变需求目标。 */
export function DevAutomations({ workspacePath, workspaceIdentity }: { workspacePath: string; workspaceIdentity?: string }) {
	const [session, setSession] = useState<AutomationSession | null>(null);
	const scope = useMemo(() => ({ workspacePath: session?.workspacePath ?? workspacePath, workspaceIdentity: session ? session.workspaceIdentity : workspaceIdentity }), [session?.workspacePath, session?.workspaceIdentity, workspacePath, workspaceIdentity]);
	return <div data-testid="dev-automations">
		<p className="mb-4 text-ui-sm text-foreground-subtle">前端原型：自动化定义、运行历史和子任务均为内存样例；不会后台调度、调用模型、写入配置或推进 IR/SR。</p>
		<AutomationsSection workspacePath={workspacePath} workspaceIdentity={workspaceIdentity} onOpenSession={setSession} />
		<Dialog open={session !== null} onOpenChange={open => { if (!open) setSession(null); }}>
			<DialogContent className="flex h-[80dvh] max-w-4xl flex-col gap-2">
				<DialogTitle>自动化运行会话（样例）</DialogTitle><DialogDescription>只读查看演示历史，关闭后回到自动化页面，不切换当前 IR/SR。</DialogDescription>
				{session && <div className="relative min-h-0 flex-1"><V4PaneConversationProvider scope={scope} sessionId={session.sessionId}><SessionPane paneId={`automation-preview:${session.sessionId}`} sessionId={session.sessionId} rootSessionId={session.sessionId} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} embedded readOnly readOnlyReason="前端原型的运行历史，仅供只读查看。" /></V4PaneConversationProvider></div>}
			</DialogContent>
		</Dialog>
	</div>;
}
