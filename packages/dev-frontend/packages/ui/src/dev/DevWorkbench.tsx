import { useDevDataSource } from "./data-source.js";
import { DevSrDeliveryControls } from "./DevSrDeliveryControls.js";
import { requirementsReviewCurrent } from "./domain.js";
import { srStartBlocker } from "./domain.js";
import { DevIrAcceptanceEntry, DevIrAcceptanceHeader } from "./DevIrAcceptance.js";
import { DevAgentModelSummary } from "./DevAgentModelSummary.js";
import { stageMaterialBlocker, deriveStageView } from "./domain.js";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Download, Copy, Settings, FileText } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import {
	useDev,
	DEV_STAGES,
	DEV_STAGE_LABELS,
} from "./DevContext.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { DevProposalControls } from "./DevProposalControls.js";
import { DevProposalRevisionControls } from "./DevProposalRevisionControls.js";
import { DevProposalDeliveryControls } from "./DevProposalDeliveryControls.js";
import { PROPOSAL_STATUS_LABELS } from "./domain.js";
import { DevCollabProjection } from "./DevCollabProjection.js";
import { DevDeleteRequirement } from "./DevDeleteRequirement.js";
import { MATERIAL_KIND_LABELS } from "./domain.js";
import { getEmployeeId } from "./identity.js";
export const DEV_MATERIAL_DISCUSS = "omp-dev:material-discuss";
function download(bytes: Blob, name: string) {
	const url = URL.createObjectURL(bytes);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function copyMaterial(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
	const active = document.activeElement;
	const node = document.createElement("textarea");
	node.value = text;
	node.style.position = "fixed";
	node.style.left = "-10000px";
	const selection = window.getSelection();
	if (!selection) return Promise.reject(new Error("浏览器无法选择材料文本。"));
	const previous = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
	document.body.append(node);
	try {
		node.focus();
		node.select();
		if (!document.execCommand("copy")) throw new Error("浏览器拒绝复制，请手动选择材料文本。");
		return Promise.resolve();
	} catch (error) {
		return Promise.reject(error);
	} finally {
		node.remove();
		if (active instanceof HTMLElement) active.focus({ preventScroll: true });
		selection.removeAllRanges();
		for (const range of previous) selection.addRange(range);
	}
}
export { DevSidebar } from "./DevSidebar.js";
export { DevProjectSettings } from "./DevProjectSettings.js";
export function DevStageHeader() {
 const source = useDevDataSource();
	const dev = useDev();
	const openSettings = useTabStore(state => state.openSettingsTab);
	const [directoryCopyStatus, setDirectoryCopyStatus] = useState("");
	useEffect(() => {
		setDirectoryCopyStatus("");
	}, [dev?.selection.projectId, dev?.selection.irId, dev?.selection.srId]);
	if (!dev) return null;
	const { view, selection, command, pending } = dev;
	const group = [...(view?.groups ?? []), ...(view?.drafts ?? [])].find(item => item.id === selection.irId);
	const sr = view?.srs.find(item => item.id === selection.srId && item.irId === group?.id);
	const project = view?.projects.find(item => item.id === selection.projectId);
	const release = view?.releases.find(item => item.id === dev.releaseId && item.projectId === project?.id);
	if (!group)
		return (
			<header className="space-y-2 border-b border-border bg-background px-4 py-3">
				<strong className="text-ui-base">需求讨论</strong>
				<p className="text-ui-sm text-foreground-subtle">
					{selection.irId
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
	if (selection.irAcceptance) return <DevIrAcceptanceHeader key={group.id} group={group} />;
	const proposal = view?.drafts.some(item => item.id === group.id);
	const prFact = sr ? sr.codePr : group.requirementsPr;
	const employeeId = getEmployeeId();
	const ownsSr = Boolean(sr && sr.developerEmployeeId === employeeId);
	const viewingOtherSr = Boolean(sr?.status === "developing" && !ownsSr);
	const stageView = sr ? deriveStageView(sr, selection) : undefined;
	const stageEditable = !sr || Boolean(stageView?.isCurrent && ownsSr && dev.session);
	const materialBlocker = sr ? stageMaterialBlocker(sr, view?.materials ?? []) : undefined;
	const startBlocker = sr?.status === "pending" && view ? srStartBlocker(view, group, sr) ?? (source.mode === "prototype" && !source.projects?.readDevelopmentRoot(group.projectId) ? "请先在设置中添加我的开发项目。" : undefined) : undefined;
	const dependencyTitles = (sr?.dependencySrIds ?? []).map(id => view?.srs.find(item => item.id === id && item.irId === group.id)?.title ?? id);
	const canRegisterPr = !proposal && stageEditable && ownsSr && sr?.status === "developing" && sr.stage === "pr";
	return (
		<header
			className="space-y-2 border-b border-border bg-background px-4 py-3"
			data-ir-id={group.id}
			data-sr-id={sr?.id}
			data-stage={sr?.stage}
			data-round={sr?.round}
		>
			<div className="flex flex-wrap items-center gap-2">
				<strong>{sr?.title || group.title || "需求讨论"}</strong>
				<span className="text-ui-sm text-foreground-subtle">
					{proposal ? `${(selection.discussionPhase ?? group.proposalStage) === "solution" ? "方案 Agent" : "业务需求 Agent"} · ${PROPOSAL_STATUS_LABELS[group.status]}` : sr ? sr.status === "completed" ? "已完成 · 历史只读" : sr.stage ? `当前阶段：${DEV_STAGE_LABELS[sr.stage]}` : "待开始开发" : "整组业务需求与方案已随 PR 合入"}
				</span>
				{source.mode === "prototype" && <span className="text-ui-sm text-foreground-subtle" title="所有状态均为样例数据，不代表真实执行或验收。">原型 · 演示数据</span>}
				<DevCollabProjection />
			</div>
			{!proposal && <div className="space-y-1 text-ui-sm text-foreground-subtle" data-testid="ir-freeze-status" data-frozen={Boolean(group.freeze)}>
              <p>{group.freeze ? "需求与方案已冻结 · 从首个 SR 开始开发时生效" : "正式提案已入库 · 需求与方案尚未冻结"}</p>
              <p>{group.freeze ? "冻结覆盖整个 IR、全部 SR 及确认方案；业务或方案变化须重新提案。" : "开始首个 SR 时冻结整组确认版本；开发前的修订也须重新评审、确认并通过提案 PR。"}</p>
            </div>}
            {!proposal && !sr && <DevIrAcceptanceEntry group={group} />}
            {(!sr || sr.status === "pending") && <DevProposalRevisionControls key={`revision-${group.id}`} group={group} />}
            {!proposal && !sr && group.proposalDelivery && <DevProposalDeliveryControls group={group} readOnly />}
			<DevAgentModelSummary binding={dev.session?.modelConfig} />
			{!proposal && sr?.developerEmployeeId && <p className="text-ui-sm text-foreground-subtle" data-testid="sr-developer">开发人：{sr.developerEmployeeId}{sr.status === "developing" ? ownsSr ? " · 我正在开发" : " · 当前仅查看，不操作其他同事的开发会话" : ""}</p>}
            {!proposal && sr?.worktree && <p className="break-all text-ui-sm text-foreground-subtle" data-testid="sr-workspace-context">{ownsSr && sr.status === "developing" ? "开发工作区" : "查看工作区"}：<code data-testid="sr-workspace-path">{sr.worktree.path}</code></p>}
            {viewingOtherSr && !sr?.developerEmployeeId && <p className="text-ui-sm text-foreground-subtle" data-testid="sr-developer">当前开发人待确认，仅查看已有记录。</p>}
            {proposal && <DevProposalControls group={group} />}
			{sr?.stage && (
				<nav aria-label="开发阶段" className="flex flex-wrap gap-1">
					{DEV_STAGES.map((stage, index) => (
						<Button
							key={stage}
							size="sm"
							variant={stageView?.stage === stage ? "secondary" : "ghost"}
							data-testid={`stage-${stage}`}
							data-stage={stage}
							data-stage-state={
								index < DEV_STAGES.indexOf(sr.stage!) ? "completed" : sr.stage === stage ? "current" : "pending"
							}
							aria-pressed={stageView?.stage === stage}
                            disabled={!sr.sessions.some(item => item.phase === stage)}
                            title={!sr.sessions.some(item => item.phase === stage) ? "尚未进入此阶段" : undefined}
							onClick={() => dev.select({ ...selection, stage, stageRound: undefined })}
						>
							{DEV_STAGE_LABELS[stage]}
						</Button>
					))}
				</nav>
			)}
	            {!proposal && sr?.stage && <div className="flex flex-wrap items-center gap-2" data-testid="stage-view-context"><span className="text-ui-sm text-foreground-subtle">查看：{DEV_STAGE_LABELS[stageView!.stage!]} · 第 {stageView!.round} 轮{stageView!.isCurrent ? " · 当前阶段" : " · 历史只读"}</span>{sr.status === "developing" && !stageView!.isCurrent && <Button size="sm" variant="outline" data-testid="return-current-stage" onClick={() => dev.select({ ...selection, stage: undefined, stageRound: undefined })}>返回当前阶段</Button>}{sr.sessions.filter(item => item.phase === stageView?.stage).length > 1 && <Select value={String(stageView!.round)} onValueChange={value => dev.select({ ...selection, stageRound: Number(value) })}><SelectTrigger className="w-36" aria-label="查看阶段轮次"><SelectValue /></SelectTrigger><SelectContent>{sr.sessions.filter(item => item.phase === stageView?.stage).sort((a,b) => b.round - a.round).map(item => <SelectItem key={item.sessionId} value={String(item.round)}>第 {item.round} 轮{item.phase === sr.stage && item.round === sr.round ? "（当前）" : "（历史）"}</SelectItem>)}</SelectContent></Select>}</div>}
            {!proposal && sr && view?.repositoryDevelopment && <div className="space-y-1 text-ui-sm text-foreground-subtle" data-testid="sr-admission-summary">
              <p>当前仓库：{view?.repositoryDevelopment?.activeSrs.length ?? 0}/{view?.repositoryDevelopment?.limit ?? 2} 个 SR 占用名额 · 同仓库同时开发一个 IR</p>
              <p>前置依赖：{dependencyTitles.length ? dependencyTitles.join("、") : "无，可与独立 SR 并行"}</p>
              {startBlocker && <p role="status" data-testid="sr-start-blocker">{startBlocker}</p>}
            </div>}
			<div key="dev-actions" className="flex flex-wrap gap-2">

				{source.mode === "prototype" && sr?.status === "pending" && !proposal && !source.projects?.readDevelopmentRoot(group.projectId) && <p className="text-ui-sm text-foreground-subtle">进入开发前，请在设置 → Dev 项目与 Release 中添加“我的开发项目”。</p>}
				{source.capabilities.workflowCommands.includes("startSr") && sr?.status === "pending" && !proposal && (
					<Button
						size="sm"
						data-testid="start-sr"
						disabled={pending || !!startBlocker}
						title={startBlocker}
						onClick={() => void command({ type: "startSr" })}
					>
						开始开发
					</Button>
				)}
                {source.mode === "prototype" && !proposal && sr?.status === "developing" && stageEditable && <><Button size="sm" variant="outline" data-testid="stage-generate-materials" disabled={pending} onClick={() => void command({ type: "generateStageMaterials", stage: sr.stage!, round: sr.round })}>{materialBlocker ? "生成当前阶段材料（演示）" : "更新阶段材料（演示）"}</Button>{materialBlocker && <p className="text-ui-sm text-foreground-subtle" data-testid="stage-material-blocker">{materialBlocker}</p>}</>}
				{source.capabilities.workflowCommands.includes("approveStage") && sr?.status === "developing" && sr.stage !== "pr" && (
					<Button
						size="sm"
						data-testid="stage-approve"
						disabled={pending || !stageEditable || Boolean(materialBlocker)}
						onClick={() =>
							void command({
								type: "approveStage",
								stage: sr.stage!,
								round: sr.round,
								materialDigest: sr.materialDigest!,
							})
						}
					>
						{sr.stage === "planning"
								? "确认计划进入开发与验证"
								: "确认开发与验证进入交付 PR"}
					</Button>
				)}

				{source.capabilities.workflowCommands.includes("backStage") && sr?.status === "developing" && sr.stage !== "planning" && (
					<Button
						size="sm"
						variant="outline"
						data-testid="back-planning"
						disabled={pending || !stageEditable}
						onClick={() => void command({ type: "backStage", stage: "planning", fromStage: sr.stage!, round: sr.round })}
					>
						返回开发计划（保留代码）
					</Button>
				)}
				{source.capabilities.workflowCommands.includes("backStage") && sr?.status === "developing" && sr.stage === "pr" && (
					<Button
						size="sm"
						variant="outline"
						data-testid="back-executing"
						disabled={pending || !stageEditable}
						onClick={() => void command({ type: "backStage", stage: "executing", fromStage: sr.stage!, round: sr.round })}
					>
						返回开发与验证／继续修正（保留代码）
					</Button>
				)}
				{source.capabilities.workflowCommands.includes("stop") && (sr?.status === "developing" || (!sr && proposal)) && (
					<Button
						size="sm"
						variant="outline"
						data-testid="stop"
						disabled={pending || (source.mode === "prototype" && (viewingOtherSr || Boolean(sr && !stageEditable)))}
						onClick={() => void command({ type: "stop" })}
					>
						停止并结清
					</Button>
				)}
				<DevDeleteRequirement key="dev-delete-requirement" />
				<Popover key={`${group.id}:${sr?.id ?? "requirements"}`}>
					<PopoverTrigger asChild><Button size="sm" variant="ghost" data-testid="dev-flow-details">更多<ChevronDown className="size-3" /></Button></PopoverTrigger>
					<PopoverContent align="end" className="max-h-[min(28rem,65dvh)] w-[min(28rem,calc(100vw-2rem))] space-y-3 overflow-y-auto" aria-label="流程详情">
						<p className="text-ui-base font-medium">流程详情与操作记录</p>
						{!sr && group.proposalLocation && <div className="space-y-2 rounded-md border border-border p-3" data-testid="proposal-directory">
							<div className="flex items-center justify-between gap-3"><span className="text-ui-base font-medium">提案临时工作区 · 只读</span><Button type="button" size="sm" variant="outline" aria-label="复制提案目录" onClick={async () => {
								try { await copyMaterial(group.proposalLocation!.directory); setDirectoryCopyStatus("已复制提案目录"); }
								catch { setDirectoryCopyStatus("复制失败，请选择下方路径手动复制。"); }
							}}><Copy className="size-3" />复制</Button></div>
							<p className="text-ui-sm text-foreground-subtle">项目：{group.proposalLocation.projectName} · 提交人：{group.proposalLocation.employeeId}</p>
							<code className="block select-text break-all text-ui-sm" data-testid="proposal-directory-path">{group.proposalLocation.directory}</code>
                            <p className="break-all text-ui-sm text-foreground-subtle">Change：{group.documentPath.replace(/\/proposal\.md$/, "")}/</p>
							<p className="text-ui-sm text-foreground-subtle">OpenSpec 先在此临时工作区生成，需求 PR 前不写入项目目录；同项目所有人可见。当前仅演示，不创建文件。</p>
							{directoryCopyStatus && <p role="status" className="text-ui-sm text-foreground-subtle">{directoryCopyStatus}</p>}
						</div>}
						{proposal && group.developerHandoff && <p className="text-ui-sm text-foreground-subtle" data-testid="proposal-submission-details">提交评审人：{group.developerHandoff.employeeId} · <time dateTime={group.developerHandoff.submittedAt}>{new Date(group.developerHandoff.submittedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>（北京时间）</p>}
                        {proposal && group.developerAcceptance && <p className="text-ui-sm text-foreground-subtle" data-testid="proposal-acceptance-details">接手开发人：{group.developerAcceptance.employeeId} · <time dateTime={group.developerAcceptance.acceptedAt}>{new Date(group.developerAcceptance.acceptedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>（北京时间）{group.developerAcceptance.round !== (group.proposalRound ?? 1) ? " · 历史轮次，需重新接手" : ""}</p>}
                        {!proposal && sr?.worktree && <div className="space-y-1 text-ui-sm" data-testid="sr-workspace-details"><p className="break-all text-foreground-subtle">启动时开发项目：{sr.developmentRoot ?? "记录缺失"}</p><p className="break-all text-foreground-subtle">固定 worktree：{sr.worktree.path}</p><p className="text-foreground-subtle">聊天、文件与审查使用此 worktree。修改个人开发目录只影响之后新开始的 SR，不重绑当前任务。</p></div>}
					{(sr?.worktree || group.worktree) && (
						<p className="text-ui-sm text-foreground-subtle">
							演示分支：{sr?.worktree?.branch ?? group.worktree?.branch} → {project?.defaultBranch}（不操作 Git）。
							{prFact && <>示例 PR：{prFact.url}（未查询平台，不代表真实 PR）</>}
						</p>
					)}
                        {Boolean(sr?.approvals.length) && <details className="text-ui-sm" data-testid="stage-approval-records"><summary className="cursor-pointer">阶段确认记录</summary><ul className="mt-2 space-y-1">{sr?.approvals.map(item => <li key={item.operationId}>{DEV_STAGE_LABELS[item.stage]} · 第 {item.round} 轮 · {item.valid === false ? "已失效" : "已确认"} · {new Date(item.approvedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）</li>)}</ul></details>}
                        {Boolean(sr?.codePrHistory?.length) && <p className="break-all text-ui-sm text-foreground-subtle">历史代码 PR（不可用作本轮交付）：{sr?.codePrHistory?.map(item => item.url).join("、")}</p>}
					<Collapsible data-testid="history">
						<CollapsibleTrigger asChild>
							<Button type="button" size="sm" variant="ghost">
								<ChevronDown className="size-3" />
								操作记录
							</Button>
						</CollapsibleTrigger>
						<CollapsibleContent>
						{view?.operations
							.filter(item => item.irId === group.id && (!sr || item.srId === sr.id))
							.map(item => (
								<div key={item.operationId} className="text-ui-sm">
									<span>
										{item.type} · {item.status}
									</span>
									{item.steps.map((step, index) => (
										<p key={index}>{step.detail}</p>
									))}
									{item.error && <p role="alert">{item.error}</p>}
								</div>
							))}
						</CollapsibleContent>
					</Collapsible>
					</PopoverContent>
				</Popover>
			</div>
			{canRegisterPr && <DevSrDeliveryControls key={`${sr!.id}:${sr!.round}`} sr={sr!} />}
			{sr?.status === "completed" && (
				<p className="text-ui-base">该 SR 的代码、测试与规格已合并核验，释放一个 SR 名额；IR 仍须整体验收和最终归档。</p>
			)}
			{(dev.error || view?.error) && (
				<p role="alert" className="text-ui-base text-destructive">
					{dev.error || view?.error}
				</p>
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
export function DevSrList() {
	const dev = useDev()!;
	return (
		<ul className="mt-4 space-y-1">
			{dev.view?.srs
				.filter(sr => sr.irId === dev.selection.irId)
				.map(sr => (
					<li key={sr.id}>
						<Button
							variant="ghost"
							className="w-full justify-start"
							data-sr-id={sr.id}
							onClick={() => dev.select({ projectId: sr.projectId, irId: sr.irId, srId: sr.id })}
						>
							<span className="min-w-0 flex-1 truncate">{sr.title}</span>
							<small className="ml-auto text-ui-sm text-foreground-subtle">{sr.status === "completed" ? "已完成" : sr.stage ? DEV_STAGE_LABELS[sr.stage] : "待开始"}</small>
						</Button>
					</li>
				))}
		</ul>
	);
}
export function DevMaterialsPane() {
	const dev = useDev()!;
	const theme = useZCodeStore(state => state.theme);
	const { selection, view } = dev;
	const [path, setPath] = useState("");
    const [readFeedback, setReadFeedback] = useState("");
	const materials =
		view?.materials.filter(
			item =>
				item.projectId === selection.projectId &&
				item.irId === selection.irId &&
				(selection.irAcceptance ? ["ir", "sr", "solution", "ir-acceptance-report", "ir-final-pr"].includes(item.kind) : !item.srId || item.srId === selection.srId),
		) ?? [];
	const sr = view?.srs.find(
		item => item.id === selection.srId && item.irId === selection.irId && item.projectId === selection.projectId,
	);
	const group = [...(view?.groups ?? []), ...(view?.drafts ?? [])].find(
		item => item.id === selection.irId && item.projectId === selection.projectId,
	);
	const stage = selection.stage ?? sr?.stage;
	const materialStageView = sr ? deriveStageView(sr, selection) : undefined;
	const materialHistory = Boolean(materialStageView && !materialStageView.isCurrent);
	const proposalSolutionView = view?.drafts.some(item => item.id === group?.id) && (selection.discussionPhase ?? group?.proposalStage) === "solution";
	const deliveryPath = stage === "pr" && sr?.delivery && materialStageView?.round === sr.delivery.round ? sr.delivery.manifestPath : undefined;
	const acceptancePath = selection.irAcceptance ? group?.acceptance?.finalPrPath ?? group?.acceptance?.reportPath ?? group?.documentPath : undefined;
	const preferred = [...materials].sort((a,b) => (b.round ?? 0) - (a.round ?? 0)).find(
		item =>
			(item.valid || (materialHistory && item.stage)) &&
			(selection.irAcceptance ? item.path === acceptancePath : deliveryPath ? item.path === deliveryPath : proposalSolutionView && materials.some(candidate => candidate.kind === "solution" && candidate.valid) ? item.kind === "solution" : selection.srId
				? stage
					? !!sr &&
						item.srId === sr.id &&
						item.stage === stage &&
						sr.materials.some(
							current =>
								(current.valid || materialHistory) &&
								current.stage === stage &&
								current.round === materialStageView?.round &&
								current.path === item.path &&
								current.sha256 === item.sha256 &&
								current.size === item.size,
						)
					: item.kind === "sr" && item.path === sr?.documentPath
				: item.kind === "ir" && item.path === group?.documentPath),
	);
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
					<SelectTrigger className="w-full min-w-0" data-testid="material-menu" aria-label="材料">
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper" align="start">
						<SelectItem value="none">
							{selection.irId ? awaitingRequirements ? "等待生成需求材料" : "没有当前有效材料" : "选择需求后查看材料"}
						</SelectItem>
						{materials.map(item => (
							<SelectItem key={item.path} value={item.path}>
								{MATERIAL_KIND_LABELS[item.kind]} · {item.kind === "sr" ? item.path.split("/").slice(-2).join("/") : item.path.split("/").at(-1)}
								{item.round ? ` · 第 ${item.round} 轮` : ""}{!item.valid ? "（已失效）" : ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{path && group && <p className="break-all text-ui-sm text-foreground-subtle" data-testid="material-source-path">{view?.drafts.some(item => item.id === group.id) ? `临时文件：${group.proposalLocation?.directory ?? ""}${path}` : group.acceptance?.status === "completed" && group.acceptance.archive?.moves.some(move => move.sourcePath === path) ? `归档文件（样例）：${group.acceptance.archive.moves.find(move => move.sourcePath === path)!.path}` : `仓库文件：${path}`}</p>}
				{stage && (
					<p className="text-ui-sm text-foreground-subtle">
						查看：{DEV_STAGE_LABELS[stage]} · 当前：{sr?.stage ? DEV_STAGE_LABELS[sr.stage] : "未开始"}
					</p>
				)}
				<div className="flex flex-wrap gap-1">
					<Button
						size="sm"
						variant="ghost"
						data-testid="material-copy"
						disabled={material?.content === undefined}
						onClick={() => {
							void copyMaterial(material!.content!).catch(dev.report);
						}}
					>
						<Copy size={14} />
						复制
					</Button>
					<Button
						size="sm"
						variant="ghost"
						data-testid="material-download"
						disabled={material?.content === undefined}
						onClick={() =>
							download(
								new Blob([material!.content!], { type: "text/markdown;charset=utf-8" }),
								path.split("/").at(-1)!,
							)
						}
					>
						<Download size={14} />
						下载
					</Button>
					<Button
						size="sm"
						variant="ghost"
						data-testid="material-discuss"
						disabled={
							material?.content === undefined || !dev.session || (selection.irAcceptance && (group?.acceptance?.status === "completed" || group?.acceptance?.status === "pr-ready" || group?.acceptance?.status === "pr-submitted"))
						}
						onClick={() =>
							window.dispatchEvent(
								new CustomEvent(DEV_MATERIAL_DISCUSS, {
									detail: {
										...selection,
										sessionId: dev.session?.sessionId,
										text: `请讨论以下只读材料（${path}）：\n\n${material!.content}`,
									},
								}),
							)
						}
					>
						带入讨论
					</Button>
				</div>
				{selection.irId && !selection.srId && !selection.irAcceptance && (
					<>
						<Button size="sm" variant="ghost" disabled={!preferred} onClick={() => setPath(group?.documentPath ?? preferred!.path)}>
							proposal.md · IR
						</Button>
						<DevSrList />
					</>
				)}
				{group?.review && !selection.irAcceptance && (
					<Collapsible className="text-ui-sm" data-testid="requirement-review">
						<CollapsibleTrigger asChild>
							<Button type="button" size="sm" variant="ghost">
								<ChevronDown className="size-3" />
							需求评审：
							{!requirementsReviewCurrent(group)
								? "旧版本记录（已失效）"
								: group.review.passed && !group.review.findings?.some(item => item.level === "blocking")
									? "通过"
									: "未通过"}
							</Button>
						</CollapsibleTrigger>
						<CollapsibleContent>
						<pre className="mt-2 whitespace-pre-wrap break-words">{group.review.report}</pre>
						</CollapsibleContent>
					</Collapsible>
				)}
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
							: stage
								? `${DEV_STAGE_LABELS[stage]}没有当前有效材料；请生成材料，或从菜单选择历史版本只读查看。`
								: "当前需求材料尚未生成或已失效。"}
					</p>
				) : (
					<>
						{!current.valid && (
							<p role="status" className="mb-3 text-ui-base text-destructive">
								材料已失效，需要重新生成或验证。以下仅供历史查看。
							</p>
						)}
						<MessageResponse className="min-w-0 break-words" theme={theme} workspacePath={view?.projects.find(project => project.id === selection.projectId)?.root}>{material?.content ?? "样例材料没有正文。"}</MessageResponse>
					</>
				)}
			</div>
		</aside>
	);
}
