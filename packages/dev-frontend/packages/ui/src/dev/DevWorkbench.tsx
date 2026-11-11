import { DevProposalFeedback } from "./DevProposalFeedback.js";
import { DevPhaseHeader, DevDocumentPhaseActions } from "./DevPhaseHeader.js";
import { useDevDataSource } from "./data-source.js";
import { deriveStageView } from "./domain.js";
import { useEffect, useMemo, useState } from "react";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useDev } from "./DevContext.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { DevDeleteRequirement } from "./DevDeleteRequirement.js";
export { DevSidebar } from "./DevSidebar.js";
export { DevProjectSettings } from "./DevProjectSettings.js";
export function DevStageHeader() { return <><DevPhaseHeader details={<DevEmptySelectionHeader />} /><DevProposalFeedback /></>; }

function DevEmptySelectionHeader() {
 const source = useDevDataSource();
	const dev = useDev();
	const openSettings = useTabStore(state => state.openSettingsTab);
	if (!dev) return null;
	const { view, selection } = dev;
	const project = view?.projects.find(item => item.id === selection.projectId);
	const release = view?.releases.find(item => item.id === dev.releaseId && item.projectId === project?.id);
		return (
			<header className="space-y-2 border-b border-border bg-background px-4 py-3">
				<strong className="text-ui-base">{selection.proposalDraftId ? "新建需求提案" : "需求讨论"}</strong>
				<p className="text-ui-sm text-foreground-subtle">
					{selection.proposalDraftId ? "先输入需求并发送，首次发送成功后才加入提案列表。重复点击“新建需求提案”会回到这份未发送草稿。" : selection.irId
						? view
							? "所选需求当前不可用，请从导航选择已有需求。不会自动新建或替换历史会话。"
							: "正在读取所选需求…"
						: !view
							? "正在读取项目与 Release…"
							: !project
								? "请在导航中选择项目，或前往设置添加项目。"
								: !release
									? "请在导航中选择 Release；尚无 Release 时可前往设置添加。"
									: source.capabilities.workflowCommands.includes("createProposal") ? "点击左侧“新建需求提案”开始，也可从导航继续已有提案。" : "从导航选择已有需求或会话。"}
				</p>
			<div key="dev-actions" className="flex flex-wrap gap-2">
					{!selection.irId && view && (!project || !release) && (
						<Button size="sm" variant="outline" onClick={openSettings}>
							<Settings size={14} />
							项目与 Release 设置
						</Button>
					)}
					<DevDeleteRequirement key="dev-delete-requirement" />
				</div>
				{(dev.error || view?.error) && (
					<p role="alert" className="text-ui-base text-destructive">{dev.error || view?.error}</p>
				)}
			</header>
		);
}
export function DevReadonlyOverview() {
 const source = useDevDataSource();
	const dev = useDev()!;
	const sr = dev.view?.srs.find(item => item.id === dev.selection.srId && item.irId === dev.selection.irId);
	const project = dev.view?.projects.find(item => item.id === dev.selection.projectId);
	const workspace = source.resolveWorkspace(dev.view, dev.selection);
 const scope = useMemo(() => ({ workspacePath: workspace.path ?? "", workspaceIdentity: workspace.identity }), [workspace.path, workspace.identity]);
	const sessionId = sr?.status === "completed" ? sr.sessions.find(session => session.phase === "pr")?.sessionId ?? null : null;
	const reason = sr?.status === "completed" ? "该 SR 已完成，历史讨论只读。" : "该 SR 尚未开始开发，请通过顶部“开始开发”进入开发计划。";
	if (!sr || !project) return <div className="p-6 text-ui-base text-foreground-subtle">所选 SR 当前不可用，请从导航选择已有需求。</div>;
	return <div className="relative flex h-full min-h-0 flex-1 flex-col" data-testid="dev-sr-readonly-chat">
		<V4PaneConversationProvider key={sr.id} scope={scope} sessionId={sessionId}>
			<SessionPane paneId={`dev-readonly-${sr.id}`} sessionId={sessionId} rootSessionId={sessionId ?? undefined} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} embedded readOnly readOnlyReason={reason} />
		</V4PaneConversationProvider>
	</div>;
}
export function DevMaterialsPane() {
	const dev = useDev()!;
	const theme = useZCodeStore(state => state.theme);
	const { selection, view } = dev;
	const [path, setPath] = useState("");
    const [readFeedback, setReadFeedback] = useState("");
  const sr = view?.srs.find(item => item.id === selection.srId && item.irId === selection.irId && item.projectId === selection.projectId);
  const group = [...(view?.groups ?? []), ...(view?.drafts ?? [])].find(item => item.id === selection.irId && item.projectId === selection.projectId);
  const stage = selection.stage ?? sr?.stage;
  const stageView = sr ? deriveStageView(sr, selection) : undefined;
  const proposal = view?.drafts.some(item => item.id === group?.id);
  // IR 只读需求文件；SR 只读自身规格与自身所选阶段／轮次，不能按 IR 混入开发产物。
  const materials = view?.materials.filter(item => {
    if (item.projectId !== selection.projectId || item.irId !== selection.irId) return false;
    if (selection.srId) {
      if (item.srId !== selection.srId) return false;
      if (item.kind === "sr" && item.path === sr?.documentPath) return true;
      return !proposal && Boolean(stage && item.stage === stage && item.round === stageView?.round);
    }
    return item.path === group?.documentPath || (item.kind === "sr" && item.path.endsWith("/spec.md")) ||
      (!item.srId && item.kind === "solution" && item.path.endsWith("/design.md"));
  }) ?? [];
  const proposalSolutionView = proposal && (selection.discussionPhase ?? group?.proposalStage) === "solution";
  const preferred = materials.find(item => item.path === selection.materialPath) ?? (selection.srId ? materials.find(item => item.path === sr?.documentPath)
    : proposalSolutionView ? materials.find(item => item.path.endsWith("/design.md"))
    : materials.find(item => item.path === group?.documentPath)) ?? materials[0];
	useEffect(() => {
		setPath(preferred?.path ?? "");
        setReadFeedback("");
	}, [
		selection.projectId,
		selection.irId,
		selection.srId,
		stage,
		sr?.round,
        selection.stageRound,
		sr?.materialDigest,
		preferred?.path,
		preferred?.sha256,
	]);
  const displayPath = (filePath: string) => proposal
    ? `${group?.proposalLocation?.directory ?? ""}${filePath}`
    : group?.acceptance?.status === "completed"
      ? group.acceptance.archive?.moves.find(move => move.sourcePath === filePath)?.path ?? filePath
      : filePath;
	const listed = materials.find(item => item.path === path);
	const material = listed;
	const error = listed?.error;
	const current = material ?? listed;
	const awaitingRequirements = !path && !selection.srId && group?.status === "draft" &&
		!group.snapshot && !group.files.length && !materials.length;
	return (
		<aside
			className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
			data-testid="materials-pane"
		>
			<div className="space-y-2 p-3">
				<Select value={path || "none"} onValueChange={value => setPath(value === "none" ? "" : value)}>
					<SelectTrigger className="h-auto min-h-8 w-full min-w-0 py-1.5" data-testid="material-menu" aria-label={selection.srId ? "当前 SR 文件目录" : "IR 需求文件目录"}>
						<SelectValue><span className="block min-w-0 whitespace-normal break-all text-left text-ui-sm" title={path ? displayPath(path) : undefined}>{path ? displayPath(path) : awaitingRequirements ? "等待生成需求材料" : "选择文件"}</span></SelectValue>
					</SelectTrigger>
					<SelectContent position="popper" align="start">
                        {!materials.length && <SelectItem value="none">
                          {selection.irId ? awaitingRequirements ? "等待生成需求材料" : selection.srId ? "当前 SR 材料清单不可用" : "IR 需求材料清单不可用" : "选择需求后查看材料"}
                        </SelectItem>}
						{materials.map(item => (
							<SelectItem key={item.path} value={item.path}>
                                {displayPath(item.path)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

			</div>
			<div
				className="min-h-0 flex-1 overflow-auto p-4"
				data-testid="material"
				data-material-path={path}
				data-material-valid={current?.valid}
			>
				{error || current?.error ? (
					<div className="space-y-3"><p role="alert" className="text-ui-base text-destructive">{error ?? current?.error}</p><Button size="sm" variant="outline" data-testid="material-retry" onClick={async () => { const recovered = await dev.retryMaterial(path); setReadFeedback(recovered ? "材料已重新读取。" : "仍无法读取，请恢复原文件；当前阶段可由开发人明确重新生成材料样例。"); }}>重新读取材料</Button>{readFeedback && <p role="status" className="text-ui-sm text-foreground-subtle">{readFeedback}</p>}</div>
				) : !selection.irId ? (
					<p className="text-ui-base text-foreground-subtle">选择需求或新建提案后，在此查看只读材料。</p>
				) : awaitingRequirements ? (
					<p role="status" className="text-ui-base text-foreground-subtle">需求材料尚未生成。可先在对话中讨论需求，生成后将在此显示。</p>
				) : !current ? (
					<p role={path ? "alert" : "status"} className={`text-ui-base ${path ? "text-destructive" : "text-foreground-subtle"}`}>
						{path
							? "所选材料不在当前材料清单中。"
                            : "所选对象的材料清单读取失败，请重新读取。需求文件不依赖聊天是否存在；SR 开发文件仅在对应阶段展示。"}
					</p>
				) : (
					<>
						<MessageResponse className="min-w-0 break-words [&_[data-markdown-table-toolbar]]:hidden [&_button]:hidden" theme={theme} workspacePath={view?.projects.find(project => project.id === selection.projectId)?.root}>{material?.content ?? "样例材料没有正文。"}</MessageResponse>
					</>
				)}
			</div>
      <DevDocumentPhaseActions />
		</aside>
	);
}
