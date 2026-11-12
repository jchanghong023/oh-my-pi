import { AIReqReviewNavigation } from "./AIReqReviewNavigation.js";
import { AIReqProposalFeedback } from "./AIReqProposalFeedback.js";
import { AIReqPhaseHeader, AIReqDocumentPhaseActions } from "./AIReqPhaseHeader.js";
import { AIReqPlanningSummary } from "./AIReqRequirementPlanning.js";
import { AIReqSrDependencyGraph } from "./AIReqSrDependencyGraph.js";
import { useAIReqDataSource } from "./data-source.js";
import type { AIReqMaterialView } from "./types.js";
import { MATERIAL_KIND_LABELS, requirementMaterialName } from "./domain.js";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Settings } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useAIReq } from "./AIReqContext.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { AIReqDeleteRequirement } from "./AIReqDeleteRequirement.js";
export { AIReqSidebar } from "./AIReqSidebar.js";
export { AIReqProjectSettings } from "./AIReqProjectSettings.js";
export function AIReqStageHeader() { return <><AIReqPhaseHeader details={<AIReqEmptySelectionHeader />} /><AIReqReviewNavigation /><AIReqProposalFeedback /></>; }

function AIReqEmptySelectionHeader() {
 const source = useAIReqDataSource();
	const aireq = useAIReq();
	const openSettings = useTabStore(state => state.openSettingsTab);
	if (!aireq) return null;
	const { view, selection } = aireq;
	const project = view?.projects.find(item => item.id === selection.projectId);
	const release = view?.releases.find(item => item.id === aireq.releaseId && item.projectId === project?.id);
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
			<div key="aireq-actions" className="flex flex-wrap gap-2">
					{!selection.irId && view && (!project || !release) && (
						<Button size="sm" variant="outline" onClick={openSettings}>
							<Settings size={14} />
							项目与 Release 设置
						</Button>
					)}
					<AIReqDeleteRequirement key="aireq-delete-requirement" />
				</div>
				{(aireq.error || view?.error) && (
					<p role="alert" className="text-ui-base text-destructive">{aireq.error || view?.error}</p>
				)}
			</header>
		);
}
export function AIReqReadonlyOverview() {
 const source = useAIReqDataSource();
	const aireq = useAIReq()!;
	const sr = aireq.view?.srs.find(item => item.id === aireq.selection.srId && item.irId === aireq.selection.irId);
	const project = aireq.view?.projects.find(item => item.id === aireq.selection.projectId);
	const workspace = source.resolveWorkspace(aireq.view, aireq.selection);
 const scope = useMemo(() => ({ workspacePath: workspace.path ?? "", workspaceIdentity: workspace.identity }), [workspace.path, workspace.identity]);
	const sessionId = sr?.status === "completed" ? sr.sessions.find(session => session.phase === "pr")?.sessionId ?? null : null;
	const reason = sr?.status === "completed" ? "该 SR 已完成，历史讨论只读。" : "该 SR 尚未开始开发，请通过顶部“开始开发”进入开发计划。";
	if (!sr || !project) return <div className="mx-auto w-full min-w-0 max-w-4xl p-6 text-ui-base text-foreground-subtle">所选 SR 当前不可用，请从导航选择已有需求。</div>;
	return <div className="relative flex h-full min-h-0 flex-1 flex-col" data-testid="aireq-sr-readonly-chat">
		<V4PaneConversationProvider key={sr.id} scope={scope} sessionId={sessionId}>
			<SessionPane paneId={`aireq-readonly-${sr.id}`} sessionId={sessionId} rootSessionId={sessionId ?? undefined} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} embedded readOnly readOnlyReason={reason} />
		</V4PaneConversationProvider>
	</div>;
}
export function AIReqMaterialsPane() {
 const source = useAIReqDataSource();
	const aireq = useAIReq()!;
	const theme = useZCodeStore(state => state.theme);
 const codePreviewSettings = useZCodeStore(state => state.codePreviewSettings);
	const { selection, view } = aireq;
	const [path, setPath] = useState("");
    const [readFeedback, setReadFeedback] = useState("");
  const [showPlanning, setShowPlanning] = useState(false);
  const sr = view?.srs.find(item => item.id === selection.srId && item.irId === selection.irId && item.projectId === selection.projectId);
  const group = [...(view?.groups ?? []), ...(view?.drafts ?? [])].find(item => item.id === selection.irId && item.projectId === selection.projectId);
  const stage = selection.stage ?? sr?.stage;
  const proposal = view?.drafts.some(item => item.id === group?.id);
  // IR 只读需求文件；SR 只读自身规格，不能按 IR 混入开发产物。
  const materials = view?.materials.filter(item => {
    if (item.projectId !== selection.projectId || item.irId !== selection.irId) return false;
    if (selection.srId) {
      if (item.srId !== selection.srId) return false;
      if (item.kind === "sr" && item.path === sr?.documentPath) return true;
      return false;
    }
    return item.path === group?.documentPath || (item.kind === "sr" && item.path.endsWith("/spec.md")) ||
      (!item.srId && item.kind === "solution" && (item.path.endsWith("/design.md") || item.path.endsWith("/sr-dependencies.json")));
  }) ?? [];
  const proposalSolutionView = proposal && (selection.discussionPhase ?? group?.proposalStage) === "solution";
  const preferred = materials.find(item => item.path === selection.materialPath) ?? (selection.srId ? materials.find(item => item.path === sr?.documentPath)
    : proposalSolutionView ? materials.find(item => item.path.endsWith("/design.md"))
    : materials.find(item => item.path === group?.documentPath)) ?? materials[0];
	useEffect(() => {
		setPath(preferred?.path ?? "");
        setReadFeedback("");
    setShowPlanning(false);
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
  const displayPath = (filePath: string) => {
    const storedPath = group?.acceptance?.status === "completed"
      ? group.acceptance.archive?.moves.find(move => move.sourcePath === filePath)?.path ?? filePath
      : filePath;
    if (!proposal) return storedPath;
    const root = group?.proposalLocation?.directory;
    return storedPath.startsWith("/") || !root ? storedPath : `${root.replace(/\/$/, "")}/${storedPath}`;
  };
  const materialLabel = (item: AIReqMaterialView) => requirementMaterialName(item.path, view?.srs) ?? MATERIAL_KIND_LABELS[item.kind];
  const solutionMaterial = materials.find(item => item.path.endsWith("/design.md"));
  const dependencyMaterial = materials.find(item => item.path.endsWith("/sr-dependencies.json"));
  const planningRows = view?.srs.filter(item => item.irId === group?.id && item.projectId === group?.projectId) ?? [];
	const listed = materials.find(item => item.path === path);
	const material = listed;
	const error = listed?.error;
	const current = material ?? listed;
	const awaitingRequirements = !path && !selection.srId && group?.status === "draft" &&
		(group.pendingFirstMessage || (!group.snapshot && !group.files.length && !materials.length));
	return (
		<aside
			className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
			data-testid="materials-pane"
		>
			<div className="shrink-0 px-4 pt-4 pb-3 md:px-6 md:pt-6"><div className={`mx-auto w-full min-w-0 space-y-2 ${!showPlanning && path.endsWith("/sr-dependencies.json") ? "max-w-4xl" : "max-w-[72ch]"}`}>
        {proposalSolutionView && group && <nav aria-label="方案材料定位" className="flex gap-1" data-testid="proposal-material-navigation">
          <Button size="sm" variant={!showPlanning && path === solutionMaterial?.path ? "secondary" : "ghost"} className="min-w-0 flex-1" disabled={!solutionMaterial} aria-pressed={!showPlanning && path === solutionMaterial?.path} onClick={() => { setShowPlanning(false); setPath(solutionMaterial!.path); }}>技术方案</Button>
          <Button size="sm" variant={!showPlanning && path === dependencyMaterial?.path ? "secondary" : "ghost"} className="min-w-0 flex-1" disabled={!dependencyMaterial} aria-pressed={!showPlanning && path === dependencyMaterial?.path} onClick={() => { setShowPlanning(false); setPath(dependencyMaterial!.path); }}>SR 依赖</Button>
          <Button size="sm" variant={showPlanning ? "secondary" : "ghost"} className="min-w-0 flex-1" aria-pressed={showPlanning} onClick={() => setShowPlanning(true)}>工期预估</Button>
        </nav>}
        {!showPlanning && <Select value={path || "none"} onValueChange={value => { setShowPlanning(false); setPath(value === "none" ? "" : value); }}>
					<SelectTrigger className="h-auto min-h-8 w-full min-w-0 py-1.5" data-testid="material-menu" aria-label="选择材料类型">
						<SelectValue><span className="block min-w-0 whitespace-normal break-all text-left text-ui-sm">{current ? materialLabel(current) : awaitingRequirements ? "等待生成需求材料" : "选择材料类型"}</span></SelectValue>
					</SelectTrigger>
					<SelectContent position="popper" align="start">
                        {!materials.length && <SelectItem value="none">
                          {selection.irId ? awaitingRequirements ? "等待生成需求材料" : selection.srId ? "当前 SR 材料清单不可用" : "IR 需求材料清单不可用" : "选择需求后查看材料"}
                        </SelectItem>}
						{materials.map(item => (
							<SelectItem key={item.path} value={item.path}>
                                {materialLabel(item)}
							</SelectItem>
						))}
					</SelectContent>
        </Select>}

			</div></div>
			<div
        key={`${selection.projectId}:${selection.irId}:${showPlanning ? "planning" : path}`}
				className="min-h-0 flex-1 overflow-auto px-4 py-4 md:px-6 md:py-6"
				data-testid="material"
        data-material-path={showPlanning ? undefined : path}
        data-material-valid={showPlanning ? undefined : current?.valid}
			>
        <div className={`mx-auto w-full min-w-0 ${!showPlanning && path.endsWith("/sr-dependencies.json") ? "max-w-4xl" : "max-w-[72ch]"}`}>
        {!showPlanning && path && <Collapsible className="mb-4">
          <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="group/material-path gap-1 px-0 text-ui-sm text-foreground-subtle focus-visible:ring-2 focus-visible:ring-ring/50"><ChevronRight className="size-3.5 transition-transform group-data-[state=open]/material-path:rotate-90" />文件路径与技术信息</Button></CollapsibleTrigger>
          <CollapsibleContent><p className="pt-2 whitespace-pre-wrap break-all font-mono text-ui-sm text-foreground-subtle select-text" data-testid="material-full-path">{displayPath(path)}</p></CollapsibleContent>
        </Collapsible>}
        {showPlanning && proposalSolutionView && group ? <AIReqPlanningSummary group={group} rows={planningRows} editable /> : error || current?.error ? (
					<div className="space-y-3"><p role="alert" className="text-ui-base text-destructive">{error ?? current?.error}</p><Button size="sm" variant="outline" data-testid="material-retry" onClick={async () => { const recovered = await aireq.retryMaterial(path); setReadFeedback(recovered ? "材料已重新读取。" : "仍无法读取，请恢复原文件；当前阶段可由开发人明确重新生成材料。"); }}>重新读取材料</Button>{readFeedback && <p role="status" className="text-ui-sm text-foreground-subtle">{readFeedback}</p>}</div>
				) : !selection.irId ? (
          selection.proposalDraftId ? <section className="space-y-4" data-testid="proposal-material-empty"><h2 className="text-ui-base font-medium">从描述需求开始</h2><p className="text-ui-sm leading-6 text-foreground-subtle">先在对话输入框说明想解决的问题，再点击发送。可从下面三点开始，不必一次写完整：</p><ol className="list-decimal space-y-2 pl-5 text-ui-sm"><li>现在遇到了什么问题，希望达成什么目标？</li><li>谁会使用，在什么场景使用？</li><li>期望得到什么结果，怎样判断完成？</li></ol><p className="text-ui-sm leading-6 text-foreground-subtle">AI 会围绕缺失信息追问并整理需求；首次发送后，需求与拆分出的 SR 材料会在这里展示。</p></section> : <p className="text-ui-base text-foreground-subtle">选择需求或新建提案后，在此查看只读材料。</p>
				) : awaitingRequirements ? (
          <section className="space-y-3"><h2 className="text-ui-base font-medium">继续讨论，完善需求</h2><p role="status" className="text-ui-sm leading-6 text-foreground-subtle">需求材料尚未生成。请在对话中说明目标、使用场景和期望结果，按追问补充；材料生成后将在此显示。</p></section>
				) : !current ? (
					<p role={path ? "alert" : "status"} className={`text-ui-base ${path ? "text-destructive" : "text-foreground-subtle"}`}>
						{path
							? "所选材料不在当前材料清单中。"
                            : "所选对象的材料清单读取失败，请重新读取。需求文件不依赖聊天是否存在；SR 开发文件仅在对应阶段展示。"}
					</p>
				) : (
					<>
						{path.endsWith("/sr-dependencies.json") && group && current ? <AIReqSrDependencyGraph group={group} material={current} rows={view?.srs.filter(item => item.irId === group.id && item.projectId === group.projectId) ?? []} /> : <article className="mx-auto w-full min-w-0 max-w-[72ch]" data-testid="material-document">
              <MessageResponse className="h-auto min-w-0 break-words leading-[1.85] tracking-normal [&>p]:my-3 [&_[data-streamdown=heading-1]]:mb-4 [&_[data-streamdown=heading-2]]:mt-8 [&_[data-streamdown=heading-2]]:mb-3 [&_[data-streamdown=heading-3]]:mt-6 [&_[data-streamdown=heading-3]]:mb-2 [&_[data-streamdown=heading-4]]:mt-5 [&_[data-streamdown=heading-4]]:mb-2" theme={theme} codePreviewSettings={codePreviewSettings} showExportActions={false} workspacePath={view?.projects.find(project => project.id === selection.projectId)?.root}>{material?.content ?? "材料没有正文。"}</MessageResponse>
            </article>}
					</>
				)}
        </div>
			</div>
      {(proposal || !group) && <AIReqDocumentPhaseActions />}
		</aside>
	);
}
