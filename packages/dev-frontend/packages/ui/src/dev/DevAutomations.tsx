import { useDevDataSource } from "./data-source.js";
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { Button } from "@/components/ui/button.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";

interface AutomationSession { workspacePath: string; workspaceIdentity?: string; sessionId: string }

/** 复用原自动化页面，演示会话独立于 Dev 的 IR/SR，避免历史查看改变需求目标。 */
export function DevAutomations({ workspacePath, workspaceIdentity }: { workspacePath: string; workspaceIdentity?: string }) {
	const source = useDevDataSource();
  const openSettings = useTabStore(state => state.openSettingsTab);
 const [session, setSession] = useState<AutomationSession | null>(null);
	const scope = useMemo(() => ({ workspacePath: session?.workspacePath ?? workspacePath, workspaceIdentity: session ? session.workspaceIdentity : workspaceIdentity }), [session?.workspacePath, session?.workspaceIdentity, workspacePath, workspaceIdentity]);
	return <div data-testid="dev-automations">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3" data-testid="dev-automation-boundary"><div className="min-w-0 flex-1"><p className="text-ui-base font-medium">通用定时任务与工作流</p><p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">这里的任务不会自动更新需求进度。正式 SR 的自动分析由“平台配置 → 需求进度分析”单独管理；运行状态以后台记录为准。</p></div><Button variant="outline" size="sm" onClick={() => { setPendingSettingsSection("progressAnalysis"); openSettings(); }}>查看需求进度分析</Button></div>
		<AutomationsSection workspacePath={workspacePath} workspaceIdentity={workspaceIdentity} onOpenSession={setSession} />
		<Dialog open={session !== null} onOpenChange={open => { if (!open) setSession(null); }}>
			<DialogContent className="flex h-[80dvh] max-w-4xl flex-col gap-2">
				<DialogTitle>自动化运行会话{source.provenance.kind === "sample" ? "（样例）" : ""}</DialogTitle><DialogDescription>只读查看运行历史，关闭后回到自动化页面，不切换当前 IR/SR。</DialogDescription>
				{session && <div className="relative min-h-0 flex-1"><V4PaneConversationProvider scope={scope} sessionId={session.sessionId}><SessionPane paneId={`automation-preview:${session.sessionId}`} sessionId={session.sessionId} rootSessionId={session.sessionId} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} embedded readOnly readOnlyReason="运行历史，仅供只读查看。" /></V4PaneConversationProvider></div>}
			</DialogContent>
		</Dialog>
	</div>;
}
