import { useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { DevWorkflowTimeline } from "./DevWorkflowTimeline.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { useDev } from "./DevContext.js";
import { useDevDataSource } from "./data-source.js";
import { getEmployeeId } from "./identity.js";
import { requirementsReviewStartBlocker, requirementsReviewReadyBlocker, deriveStageView, hasCurrentProposalSolution, proposalProgressIndex, proposalViewedIndex, irAcceptanceBlocker, irAcceptanceReportBlocker, irAcceptanceVersionBlocker, requirementsReviewBlocker, requirementsReviewInputs, srStartBlocker, stageMaterialBlocker } from "./domain.js";
import { DevProposalDeliveryControls, DevProposalBackgroundStatus } from "./DevProposalDeliveryControls.js";
import { proposalActorLabel } from "./domain.js";
import { DevSrDeliveryControls } from "./DevSrDeliveryControls.js";
import { DevIrFinalPrControls } from "./DevIrFinalPrControls.js";
import type { DevSelection, DevWorkflowStage } from "./types.js";

const proposalSteps = ["业务需求", "需求评审", "技术方案", "需求入库"];
const proposalIds: NonNullable<DevSelection["proposalStep"]>[] = ["requirements", "requirements-review", "solution", "intake"];
const srStages: DevWorkflowStage[] = ["planning", "executing", "pr"];

/** 阶段只负责导航；人工按钮复用已有动作及文件版本门槛，不以查看代替推进。 */
export function DevPhaseHeader({ details, placement = "header" }: { details: ReactNode; placement?: "header" | "document" }) {
  const dev = useDev()!;
  const source = useDevDataSource();
  const [back, setBack] = useState(false);
  const [reason, setReason] = useState("");
  const [backStage, setBackStage] = useState<DevWorkflowStage>("planning");
  const { view, selection, pending } = dev;
  const group = [...(view?.groups ?? []), ...(view?.drafts ?? [])].find(item => item.id === selection.irId && item.projectId === selection.projectId);
  if (!group || !view) return placement === "document" ? null : <>{details}</>;
  const proposal = view.drafts.some(item => item.id === group.id);
  const sr = view.srs.find(item => item.id === selection.srId && item.irId === group.id);
  if (proposal && sr) return null;
  const acceptance = group.acceptance;
  const phase = proposal ? proposalProgressIndex(group, selection) : sr ? Math.max(0, srStages.indexOf(sr.stage ?? "planning")) : !acceptance ? 0 : ["pr-ready", "pr-submitted", "completed"].includes(acceptance.status) ? 2 : 1;
  const selected = proposal ? proposalViewedIndex(group, selection)
    : sr ? Math.max(0, srStages.indexOf(selection.stage ?? sr.stage ?? "planning")) : selection.irAcceptance ? phase : 0;
  const stageView = sr ? deriveStageView(sr, selection) : undefined;
  const history = selected !== phase || Boolean(sr && !stageView?.isCurrent);
  const labels = proposal ? proposalSteps : sr ? ["开发计划", "开发与验证", "交付合并"] : ["SR 开发", "整体验收", "完成归档"];
  const readOnly = proposal ? !source.capabilities.proposalDiscussion : !source.capabilities.codeDevelopment || Boolean(sr && sr.developerEmployeeId && sr.developerEmployeeId !== getEmployeeId());
  const running = view.running.some(item => item.sessionId === dev.session?.sessionId);
  const complete = sr?.status === "completed" || (!proposal && !sr && acceptance?.status === "completed");
  const role = proposal ? ["业务需求 Agent", group.review?.agents?.find(agent => agent.id === (selection.reviewAgent ?? "summary"))?.name ?? "综合评审 Agent", "方案 Agent", "人工 PR · 后台检查"][selected]
    : sr ? selected === 0 ? "计划 Agent" : "执行 Agent" : selected === 0 ? "各 SR 分别开发" : "IR 验收 Agent";
  const reviewIssue = requirementsReviewBlocker(group);
  const reviewStartIssue = requirementsReviewStartBlocker(group);
  const materialIssue = sr ? stageMaterialBlocker(sr, view.materials) : undefined;
  const target = { projectId: group.projectId, irId: group.id };
  const jump = (index: number) => {
    if (proposal) dev.select({ ...selection, materialPath: undefined, proposalStep: proposalIds[index], discussionPhase: index > 1 ? "solution" : "requirements" });
    else if (sr) dev.select({ ...selection, stage: srStages[index], stageRound: undefined });
    else dev.select({ ...selection, irAcceptance: index > 0 });
  };
  const current = () => {
    if (proposal) dev.select({ ...selection, proposalStep: undefined, discussionPhase: undefined });
    else if (sr) dev.select({ ...selection, stage: undefined, stageRound: undefined });
    else dev.select({ ...selection, irAcceptance: phase > 0 });
  };
  let action: ReactNode;
  let guidance: string | undefined;
  let status = complete ? "已完成 · 历史只读" : readOnly ? "只读查看" : history ? "历史只读" : running ? "工作中" : "等待人工确认";
  if (history) action = <Button size="sm" variant="outline" onClick={current}>返回当前阶段</Button>;
  else if (readOnly || complete) action = null;
  else if (proposal) {
    if (phase === 0) { if (group.returnFeedback && !group.returnFeedback.resumedAt) status = "待业务补充"; else if (!requirementsReviewInputs(group)) status = "需求文档待完成"; action = <Button size="sm" disabled={pending || running || !!reviewStartIssue} title={reviewStartIssue ?? "检查右侧需求文件后，人工发起评审"} onClick={() => void dev.command({ type: "runRequirementsReview", ...target })}>发起需求评审</Button>; }
    else if (phase === 1) {
      const readyIssue = requirementsReviewReadyBlocker(group);
      status = readyIssue ? readyIssue : group.review?.humanDecision ? "已人工通过 · 可进入方案" : "综合意见已就绪 · 等待人工判断";
      action = selection.reviewAgent && selection.reviewAgent !== "summary" ? <Button size="sm" variant="outline" onClick={() => dev.select({ ...selection, reviewAgent: "summary" })}>查看综合意见</Button>
       : <Button size="sm" disabled={pending || running || !!readyIssue} title={readyIssue ?? "我已查看综合意见，由我判断本轮需求可以进入方案"} onClick={() => void dev.command({ type: "acceptProposal", ...target, reviewId: group.review?.id, snapshotDigest: group.review?.snapshotDigest })}>通过，进入技术方案</Button>;
    } else if (phase === 2) {
      status = hasCurrentProposalSolution(group) ? "方案已完成 · 可创建分支并推送" : "等待完成技术方案／SR依赖";
      action = hasCurrentProposalSolution(group) ? <DevProposalDeliveryControls group={group} compact /> : <Button size="sm" disabled={pending || running || !!reviewIssue} title={reviewIssue} onClick={() => void dev.command({ type: "generateProposalSolution", ...target })}>生成技术方案</Button>;
    } else { status = group.proposalDelivery?.pushedAt ? "定时核验合入与文档完整性" : "当前版本已确认 · 待提交推送"; action = <DevProposalDeliveryControls group={group} compact />; }
  } else if (sr) {
    const owns = sr.developerEmployeeId === getEmployeeId();
    if (sr.status === "pending") { status = "待开始开发"; const blocker = srStartBlocker(view, group, sr); action = <Button size="sm" disabled={pending || !!blocker || !source.projects?.readDevelopmentRoot(group.projectId)} title={blocker} onClick={() => void dev.command({ type: "startSr" })}>开始开发计划</Button>; }
    else if (phase < 2) action = <Button size="sm" disabled={pending || running || !owns || !!materialIssue} title={materialIssue ?? "我已检查右侧文档，确认进入下一阶段"} onClick={() => void dev.command({ type: "approveStage", stage: sr.stage!, round: sr.round, materialDigest: sr.materialDigest! })}>下一步：{phase === 0 ? "开发与验证" : "交付合并"}</Button>;
    else { status = sr.codePr ? "人工处理 PR · 后台自动检查" : "等待准备交付"; action = <DevSrDeliveryControls sr={sr} compact />; }
    if (materialIssue && sr.status === "developing") status = "阶段文档待完成";
  } else if (!acceptance) {
    const blocker = irAcceptanceBlocker(view, group);
    status = blocker ? "等待全部 SR 合并" : "可开始整体验收";
    action = <Button size="sm" disabled={pending || !!blocker || !source.projects?.readDevelopmentRoot(group.projectId)} title={blocker ?? (!source.projects?.readDevelopmentRoot(group.projectId) ? "请先配置自己的开发项目路径" : undefined)} onClick={() => void dev.command({ type: "startIrAcceptance" })}>下一步：整体验收</Button>;
  } else {
    const owns = acceptance.employeeId === getEmployeeId();
    const versionIssue = irAcceptanceVersionBlocker(view, group);
    if (versionIssue) { status = "需要重新验收"; action = <Button size="sm" disabled={pending || !owns} title={versionIssue} onClick={() => void dev.command({ type: "restartIrAcceptance" })}>重新对齐并验收</Button>; }
    else if (acceptance.status === "reviewing") { status = "等待完成验收报告"; action = <Button size="sm" disabled={pending || !owns} onClick={() => void dev.command({ type: "generateIrAcceptanceReport", outcome: "passed" })}>生成验收报告</Button>; }
    else if (acceptance.status === "issues") { status = "发现问题 · 等待修复复验"; action = <Button size="sm" disabled={pending || !owns} onClick={() => void dev.command({ type: "repairIrAcceptance" })}>修复并复验</Button>; }
    else if (acceptance.status === "passed") { status = "验收通过 · 等待人工确认"; action = <Button size="sm" disabled={pending || !owns || !!irAcceptanceReportBlocker(view, group)} onClick={() => void dev.command({ type: "prepareIrFinalPr" })}>下一步：准备归档 PR</Button>; }
    else if (["pr-ready", "pr-submitted"].includes(acceptance.status)) { status = "人工处理 PR · 后台自动检查"; action = <DevIrFinalPrControls group={group} compact />; }
  }
  if (proposal && !history) {
    if (readOnly) guidance = "当前 Web 只能查看提案，请进入 j00808874 的 Web 讨论或修改。";
    else if (running || pending) guidance = running ? "Agent 正在工作，完成后再检查文档并操作。" : "正在更新，请稍候。";
    else if (phase === 0) guidance = group.returnFeedback && !group.returnFeedback.resumedAt ? "请与业务需求 Agent 讨论最新待处理意见，由 AI 补充 IR／SR；文件更新后再发起评审。" : requirementsReviewInputs(group) ? "检查 proposal.md 与全部 SR 的 spec.md 后，发起需求评审。" : "请先在 IR 聊天中完善需求，生成 proposal.md 和 SR 规格。";
    else if (phase === 1) guidance = requirementsReviewReadyBlocker(group) ?? "请阅读综合意见，由你判断通过或返回业务补充；模型的建议与分歧不会自动判定结果。";
    else if (phase === 2) guidance = reviewIssue ?? (hasCurrentProposalSolution(group) ? "本轮技术方案／SR依赖已生成；检查 IR、全部 SR 及技术方案／SR依赖后，逐文件确认进入入库。" : group.proposalSolution ? "技术方案／SR依赖缺失、无效或与本轮需求不匹配，请重新生成后确认。" : "尚未生成本轮有效技术方案／SR依赖；右侧已有材料是参考材料，请先生成技术方案。");
    else guidance = group.status === "requirements-pr" ? "等待人工评审合并；后台定时检查提案分支合入及文档完整性，满足后自动入库并创建 SR 分支。" : "按已确认版本创建提案分支、提交推送，随后由人工处理 PR，后台自动检查。";
  }
  const canBack = !history && !readOnly && !complete && (proposal ? (phase === 1) || (phase === 2 && source.capabilities.proposalDiscussion && group.status !== "requirements-pr") : Boolean(sr && sr.status === "developing" && phase > 0));
  const backDialog = (<Dialog open={back} onOpenChange={setBack}><DialogContent className={proposal ? "flex max-h-[85dvh] flex-col sm:max-w-3xl" : "sm:max-w-md"}><DialogHeader><DialogTitle>{proposal ? phase === 1 ? "返回业务补充" : "退出方案，退回业务补充" : "回退开发阶段"}</DialogTitle><DialogDescription>{proposal && phase === 2 ? "粘贴方案 Agent 提出、开发无法回答的问题，可自行编辑补充。确认后直接返回业务需求 Agent，意见会显示在讨论上方；旧方案失效，由 AI 补充文件后重评，再继续方案。" : proposal ? "填写需业务补充的评审意见。确认后返回业务需求阶段，旧评审与方案失效；通过业务需求 Agent 更新 IR／SR 后才能重新评审。" : "保留已有文件、代码和历史记录。回退后重新检查所选阶段，旧批准及后续阶段材料不再用于当前推进。"}</DialogDescription></DialogHeader>
      {proposal ? <SettingsFormTextarea autoFocus aria-label="粘贴需要业务处理的意见" className="min-h-64 max-h-[50dvh] overflow-y-auto" value={reason} onChange={event => setReason(event.target.value)} rows={12} placeholder={phase === 1 ? "填写评审中需要业务补充的问题，也可以粘贴综合评审意见。" : "把方案 Agent 的问题粘贴到这里，也可以补充背景和说明。"} /> : <Select value={backStage} onValueChange={value => setBackStage(value as DevWorkflowStage)}><SelectTrigger aria-label="回退到"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="planning">开发计划</SelectItem>{phase === 2 && <SelectItem value="executing">开发与验证</SelectItem>}</SelectContent></Select>}
      <DialogFooter><Button variant="outline" onClick={() => setBack(false)}>取消</Button><Button disabled={pending || (proposal && !reason.trim())} onClick={async () => {
        const result = proposal ? await dev.command({ type: "returnProposal", ...target, reason }) : await dev.command({ type: "backStage", stage: backStage, fromStage: sr!.stage!, round: sr!.round });
        if (result?.status === "completed") setBack(false);
      }}>确认回退</Button></DialogFooter>
    </DialogContent></Dialog>);
  if (placement === "document") {
    if (readOnly || (complete && !history) || (!canBack && !action)) return null;
    return <>
      <div className="shrink-0 border-t border-border bg-background px-4 py-3 md:px-6" data-testid="dev-document-actions" aria-label="文档确认与阶段操作">
        <div className="mx-auto w-full min-w-0 max-w-[72ch]">
        {guidance && <p className="mb-2 text-ui-sm leading-5 text-foreground-subtle" role="status" data-testid="dev-action-guidance">{guidance}</p>}
        <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 [&_button]:h-auto [&_button]:min-h-6 [&_button]:max-w-full [&_button]:whitespace-normal" data-testid="dev-phase-actions">
          {canBack ? <Button size="sm" variant="outline" disabled={pending || running} onClick={() => { setReason(""); setBackStage("planning"); setBack(true); }}><RotateCcw className="size-3" />{proposal && phase === 2 ? "退出方案，退回业务补充" : proposal ? "返回业务补充" : "回退"}</Button> : <span />}
          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
            {source.capabilities.workflowCommands.includes("generateStageMaterials") && sr?.status === "developing" && !history && sr.developerEmployeeId === getEmployeeId() && materialIssue && <Button size="sm" variant="outline" disabled={pending || running} onClick={() => void dev.command({ type: "generateStageMaterials", stage: sr.stage!, round: sr.round })}>生成当前阶段材料</Button>}
            {action}
          </div>
        </div>
        </div>
      </div>
      {backDialog}

    </>;
  }
  const actor = proposal && selected < 3 && selected !== 1 && !(phase === 2 && hasCurrentProposalSolution(group)) ? proposalActorLabel(group) : undefined;
  const statusText = `${role} · ${status}${actor ? ` · ${actor}` : ""}`;
  return <header className="shrink-0 space-y-1 border-b border-border px-4 py-2" data-testid="dev-phase-header">
    <div className="flex min-w-0 justify-center" data-testid="dev-phase-toolbar">
      <DevWorkflowTimeline labels={labels} phase={phase} selected={selected} complete={complete} running={running} review={proposal ? group.review : undefined} reviewAgent={selection.reviewAgent} canOpenReview={Boolean(proposal && source.capabilities.proposalDiscussion)} onSelectReview={id => dev.select({ ...selection, proposalStep: "requirements-review", discussionPhase: "requirements", reviewAgent: id, materialPath: undefined })} proposal={proposal} sr={Boolean(sr)} rounds={labels.map((_, index) => proposal ? index === 0 ? group.proposalRound ?? 1 : index === 1 ? group.review?.round ?? 0 : index === 2 ? Math.max(0, ...group.sessions.filter(item => item.phase === "solution").map(item => item.round)) : 0 : sr?.round ?? 1)} returned={Boolean(proposal && group.returnFeedback)} canNavigate={proposal ? Boolean(source.capabilities.proposalDiscussion) : Boolean(source.capabilities.codeDevelopment)} entered={labels.map((_, index) => proposal ? index <= phase || (index === 1 && !!group.review) || (index === 2 && group.sessions.some(item => item.phase === "solution")) || (index === 3 && !!group.proposalDelivery) : sr ? index === 0 || sr.sessions.some(item => item.phase === srStages[index]) : index === 0 || Boolean(acceptance && index <= phase))} onSelect={jump} />

    </div>
    <p className={`whitespace-normal break-words text-center text-ui-sm leading-5 ${dev.error ? "text-destructive" : "text-foreground-subtle"}`} title={dev.error ?? statusText} role={dev.error ? "alert" : undefined} data-testid="dev-phase-agent">{dev.error ? `操作失败：${dev.error}` : statusText}</p>

  </header>;
}

/** 人工处理 PR，后台自动核验入库；此阶段不创建聊天 Agent。 */
export function DevProposalStageBody() {
 const dev = useDev()!;
 const group = dev.view?.drafts.find(item => item.projectId === dev.selection.projectId && item.id === dev.selection.irId);
 // 以实际中栏宽度居中；侧栏开合或拖动时由 CSS 重新排版，不缓存窗口宽度。
 return <main className="h-full min-h-0 w-full min-w-0 overflow-y-auto p-6" data-testid="dev-proposal-stage-body"><div className="mx-auto w-full min-w-0 max-w-3xl space-y-4 break-words"><h3 className="text-ui-base font-medium">需求入库</h3><p className="text-ui-base leading-6 text-foreground-subtle">方案完成后由平台创建提案独立分支并提交推送。人工创建、评审和合并 PR；后台只根据提案分支是否合入默认分支及需求文档是否完整自动更新状态。</p>{group && <DevProposalBackgroundStatus group={group} />}</div></main>;
}

/** 正式 IR 的 SR 开发是汇总节点，开发聊天分别属于每个 SR。 */
export function DevFormalProgressBody() {
 const dev = useDev()!;
 const rows = dev.view?.srs.filter(item => item.irId === dev.selection.irId && item.projectId === dev.selection.projectId) ?? [];
 const completed = rows.filter(item => item.status === "completed").length;
 return <main className="flex min-h-0 flex-1 items-center justify-center p-6" data-testid="dev-formal-development-overview"><section className="max-w-md space-y-3"><h3 className="text-ui-base font-medium">SR 开发 · {completed}/{rows.length} 已完成</h3><p className="text-ui-base leading-6 text-foreground-subtle">每个 SR 在自己的计划 Agent、执行 Agent 会话中推进。请从左侧选择 SR 查看开发记录，并在右侧检查对应文件。</p><p className="text-ui-base leading-6 text-foreground-subtle">全部 SR 合并并核验后，由人工点击右侧文档底部“下一步：整体验收”，再进入 IR 验收 Agent。</p></section></main>;
}

/** 每个材料页就地渲染操作，复用同一阶段与门槛计算，不向其他保留页挂载按钮。 */
export function DevDocumentPhaseActions() { return <DevPhaseHeader placement="document" details={null} />; }
