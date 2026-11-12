import { useAIReqDataSource } from "./data-source.js";
import { requirementsReviewBlocker } from "./domain.js";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { getEmployeeId } from "./identity.js";
import { AIReqProposalDeliveryControls } from "./AIReqProposalDeliveryControls.js";
import { AIReqRequirementReview } from "./AIReqRequirementReview.js";
import { AIReqRequirementDraft } from "./AIReqRequirementDraft.js";
import { useAIReq } from "./AIReqContext.js";
import { hasCurrentProposalSolution, PROPOSAL_STATUS_LABELS } from "./domain.js";
import type { AIReqRequirementGroup } from "./types.js";

export function AIReqProposalControls({ group }: { group: AIReqRequirementGroup }) {
 const source = useAIReqDataSource();
 if (!source.capabilities.requirementManagement || source.capabilities.proposalDiscussion === false) return null;
 const aireq = useAIReq()!;
 const [returnOpen, setReturnOpen] = useState(false);
 const [reason, setReason] = useState("");
 const phase = group.proposalStage ?? "requirements";
 const viewing = aireq.selection.discussionPhase ?? phase;
 const history = viewing !== phase;
 const target = { projectId: group.projectId, irId: group.id };
 const ready = hasCurrentProposalSolution(group);
 const reviewBlocker = requirementsReviewBlocker(group);
 const accepted = group.developerAcceptance?.round === (group.proposalRound ?? 1) ? group.developerAcceptance : undefined;
 const mine = accepted?.employeeId === getEmployeeId();
 return <div className="space-y-2" data-testid="proposal-controls">

  <p className="text-ui-sm text-foreground-subtle">{PROPOSAL_STATUS_LABELS[group.status]} · 当前阶段：{phase === "requirements" ? "业务需求" : "方案"}{history ? " · 正在查看历史讨论，只读" : ""}</p>
  {!history && phase === "requirements" && group.status === "draft" && <AIReqRequirementDraft group={group} />}
  <AIReqRequirementReview group={group} readOnly={history} />
  {!history && phase === "requirements" && <div className="space-y-2">
   {group.returnFeedback && <div className="rounded-md border border-border p-2 text-ui-sm" data-testid="proposal-return-feedback"><p className="whitespace-pre-wrap break-words">开发反馈：{group.returnFeedback.reason}</p><p className="text-foreground-subtle">由 {group.returnFeedback.employeeId} 打回业务补充，旧方案已失效。</p></div>}
   <Button size="sm" data-testid="proposal-submit-review" disabled={aireq.pending || group.status !== "draft" || !!reviewBlocker || Boolean(group.developerHandoff)} title={reviewBlocker} onClick={() => void aireq.command({ type: "submitProposalReview", ...target })}>{group.developerHandoff ? "已交给开发，等待接手" : "提交给开发"}</Button>
   {group.developerHandoff && !accepted && <Button size="sm" data-testid="proposal-accept" disabled={aireq.pending || !!reviewBlocker} title={reviewBlocker} onClick={() => void aireq.command({ type: "acceptProposal", ...target, reviewId: group.review?.id, snapshotDigest: group.review?.snapshotDigest })}>接手方案评审</Button>}
   <p className="text-ui-sm text-foreground-subtle">当前版本业务需求评审通过后，交给开发人员；明确接手后才进入方案阶段，此时无需 design.md。</p>
  </div>}
  {!history && phase === "solution" && <div className="space-y-2">
   <p className="text-ui-sm text-foreground-subtle">提交评审人：{group.developerHandoff?.employeeId} · {accepted ? `接手开发人：${accepted.employeeId}` : "尚未接手，等待开发人员处理"}</p>
   <p className="text-ui-sm text-foreground-subtle">{accepted && !mine ? "当前由其他同事接手，可查看需求与方案。" : "接手开发人员在临时工作区同轮完成 design.md 与 sr-dependencies.json；有业务卡点可打回补充。"}</p>

   <div className="flex flex-wrap gap-2">
    {group.status !== "requirements-pr" && <>
     <Button size="sm" data-testid="proposal-generate-solution" disabled={aireq.pending || !group.srIds.length || !mine || !!reviewBlocker} title={reviewBlocker ?? (!group.srIds.length ? "请先完成 IR 与至少一个 SR" : undefined)} onClick={() => void aireq.command({ type: "generateProposalSolution", ...target })}>{ready ? "重新生成方案" : "生成方案"}</Button>
     <Button size="sm" variant="outline" data-testid="proposal-return" disabled={!mine || aireq.pending} onClick={() => { setReason(""); setReturnOpen(true); }}>打回业务补充</Button>
    </>}
   </div>
   {ready && <p className="text-ui-sm text-foreground-subtle" data-testid="proposal-solution-ready">design.md 与 sr-dependencies.json 已完成 · 开发人员：{group.proposalSolution?.employeeId}</p>}
  </div>}
  {viewing === "solution" && <AIReqProposalDeliveryControls group={group} readOnly={history} />}
  <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
   <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>打回业务补充</DialogTitle><DialogDescription>明确需要业务补充的细节。打回后回到业务需求阶段，保留讨论和文件，旧方案失效。</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={async event => {
     event.preventDefault();
     if (aireq.pending || !mine || history || phase !== "solution" || group.status === "requirements-pr" || !reason.trim()) return;
     const result = await aireq.command({ type: "returnProposal", ...target, reason });
     if (result?.status === "completed") setReturnOpen(false);
    }}>
     <div className="space-y-2"><Label htmlFor="proposal-return-reason">需补充的业务细节</Label><SettingsFormTextarea id="proposal-return-reason" value={reason} onChange={event => setReason(event.target.value)} rows={4} placeholder="例如：需明确重复执行、失败重试和取消的业务规则。" required /></div>
     {aireq.error && <p role="alert" className="text-ui-sm text-destructive">{aireq.error}</p>}
     <DialogFooter><Button type="button" variant="outline" onClick={() => setReturnOpen(false)}>取消</Button><Button type="submit" disabled={aireq.pending || !mine || history || phase !== "solution" || group.status === "requirements-pr" || !reason.trim()}>打回补充</Button></DialogFooter>
    </form>
   </DialogContent>
  </Dialog>
 </div>;
}
