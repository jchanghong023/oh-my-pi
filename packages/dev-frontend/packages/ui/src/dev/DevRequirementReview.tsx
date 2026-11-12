import { useDevDataSource } from "./data-source.js";
import { requirementsReviewBlocker, requirementsReviewCurrent, requirementsReviewStartBlocker } from "./domain.js";
import { DevAgentModelSummary } from "./DevAgentModelSummary.js";
import { DevRequirementsDecision } from "./DevRequirementsDecision.js";
import { useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Label } from "@/components/ui/label.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useDev } from "./DevContext.js";
import type { DevRequirementGroup } from "./types.js";

/** 复用需求工作流的评审投影；此组件不持有第二份评审或需求状态。 */
export function DevRequirementReview({ group, readOnly = false }: { group: DevRequirementGroup; readOnly?: boolean }) {
 const source = useDevDataSource();
 if (source.mode !== "prototype" || !source.capabilities.prototypeBusiness) return null;
 const dev = useDev()!;
 const [open, setOpen] = useState(false);
 const [supplement, setSupplement] = useState("");
 const review = group.review;
 const current = requirementsReviewCurrent(group);
 const blocker = requirementsReviewBlocker(group);
 const startBlocker = requirementsReviewStartBlocker(group);
 const editable = !readOnly && ["draft", "solution-ready"].includes(group.status);
 const canSupplement = editable && (group.proposalStage ?? "requirements") === "requirements";
 const target = { projectId: group.projectId, irId: group.id };
 const run = async () => {
  const result = await dev.command({ type: "runRequirementsReview", ...target });
  if (result?.status === "completed") setOpen(true);
 };
 return <div className="flex flex-wrap items-center gap-2" data-testid="proposal-requirements-review">
  <Button type="button" size="sm" variant="outline" data-testid="requirements-review-run" disabled={!editable || dev.pending || !!startBlocker} title={startBlocker} onClick={() => void run()}><ClipboardCheck className="size-3.5" />{review ? "重新需求评审（演示）" : "需求评审（演示）"}</Button>
  {review && <Button type="button" size="sm" variant="ghost" data-testid="requirements-review-open" onClick={() => setOpen(true)}>查看评审意见{!current ? "（旧版本）" : ""}</Button>}
  <p className="w-full text-ui-sm text-foreground-subtle" data-testid="requirements-review-gate" role="status">{blocker ?? "当前版本业务需求评审通过（演示）；人工确认与 PR 评审仍不可省略。"}</p>
  <Dialog open={open} onOpenChange={setOpen}>
   <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" aria-describedby="requirements-review-description">
    <DialogHeader><DialogTitle>需求评审意见（演示）</DialogTitle><DialogDescription id="requirements-review-description">审查 proposal.md 和各能力 spec.md；技术方案与代码由原生审核能力处理。当前版本评审通过才可交给开发、生成方案和准备提案 PR；需求更新后必须重评。此处仅演示门槛，不运行真实 Agent，不替代人工确认。</DialogDescription></DialogHeader>
    {review && <div className="space-y-4" data-testid="requirements-review-report">
     <DevAgentModelSummary binding={review.modelConfig} />
     <div className="space-y-1 text-ui-sm text-foreground-subtle"><p data-testid="requirements-review-version">{current ? "当前需求版本" : "旧版本记录，需求已更新，需重新评审"} · 第 {review.round ?? 1} 轮 · {review.passed ? "样例：无新增阻断项" : "样例：有待补充事项"}</p><p>发起工号：{review.requestedBy ?? "样例未记录"} · <time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>（北京时间）</p></div>
     <p className="break-all text-ui-sm text-foreground-subtle" data-testid="requirements-review-binding">AI 原始评审：{review.id} · 绑定快照：{review.snapshotDigest}</p>
     <details className="text-ui-sm text-foreground-subtle" data-testid="requirements-review-input-files"><summary className="cursor-pointer">本次 AI 评审绑定的需求文件版本（{review.inputFiles?.length ?? 0}）</summary><ul className="mt-1 space-y-1">{review.inputFiles?.map(file => <li key={file.path} className="break-all font-mono">{file.path} · {file.sha256} · {file.size} 字节</li>)}</ul></details>
     {Boolean(review.findings?.length) && <ul className="space-y-2">{review.findings?.map(item => <li key={item.id} className="rounded-md border border-border p-2 text-ui-sm"><p>{item.level === "blocking" ? "需补充" : "建议"}：{item.message}</p><p className="mt-1 break-all text-foreground-subtle">{item.documentPath}</p></li>)}</ul>}
     <MessageResponse>{review.report}</MessageResponse>
    </div>}
    <DevRequirementsDecision group={group} readOnly={!canSupplement} />
    {canSupplement && <form className="space-y-2 border-t border-border pt-3" onSubmit={async event => {
     event.preventDefault();
     const result = await dev.command({ type: "supplementRequirements", ...target, note: supplement.trim() });
     if (result?.status === "completed") setSupplement("");
    }}>
     <Label htmlFor={`requirements-review-supplement-${group.id}`}>补充验收说明（原型演示）</Label>
     <SettingsFormTextarea id={`requirements-review-supplement-${group.id}`} value={supplement} onChange={event => setSupplement(event.target.value)} rows={3} placeholder="例如：失败时保留输入，显示失败原因，并允许用户修正后重新提交。" required />
     <p className="text-ui-sm text-foreground-subtle">此操作演示更新内存中的需求文件与版本，旧评审和旧方案会失效。实际需求讨论继续使用原聊天框。</p>
     <Button type="submit" size="sm" variant="outline" data-testid="requirements-review-supplement" disabled={dev.pending || !supplement.trim()}>更新需求样例</Button>
    </form>}
    {Boolean(group.reviewHistory?.length) && <details className="space-y-2 border-t border-border pt-3 text-ui-sm" data-testid="requirements-review-history"><summary className="cursor-pointer">历史 AI 评审（{group.reviewHistory!.length}）</summary>{group.reviewHistory!.map((item, index) => <details key={`${item.id}:${index}`} className="mt-2 space-y-2 rounded-md border border-border p-2"><summary className="cursor-pointer">第 {item.round ?? 1} 轮 · {item.passed ? "通过记录" : "待补充记录"} · 仅供历史查看</summary><DevAgentModelSummary binding={item.modelConfig} /><p className="break-all text-foreground-subtle">AI 原始评审：{item.id} · 绑定快照：{item.snapshotDigest}</p><p className="text-foreground-subtle">发起工号：{item.requestedBy ?? "样例未记录"} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>（北京时间）</p><details className="text-foreground-subtle"><summary className="cursor-pointer">绑定的需求文件版本（{item.inputFiles?.length ?? 0}）</summary><ul className="mt-1 space-y-1">{item.inputFiles?.map(file => <li key={file.path} className="break-all font-mono">{file.path} · {file.sha256} · {file.size} 字节</li>)}</ul></details>{Boolean(item.findings?.length) && <ul className="space-y-2">{item.findings?.map(finding => <li key={finding.id} className="rounded-md border border-border p-2"><p>{finding.level === "blocking" ? "需补充" : "建议"}：{finding.message}</p><p className="mt-1 break-all text-foreground-subtle">{finding.documentPath}</p></li>)}</ul>}<MessageResponse>{item.report}</MessageResponse></details>)}</details>}
    <p className="text-ui-sm text-foreground-subtle">反复不通过或存在业务争议时交人工处理；不会自动循环评审或把人工意见伪造成 Agent 通过。</p>
    {editable && review && <div className="flex justify-end"><Button type="button" size="sm" data-testid="requirements-review-rerun" disabled={dev.pending || !!startBlocker} title={startBlocker} onClick={() => void run()}>重新需求评审（演示）</Button></div>}
    {dev.error && <p role="alert" className="text-ui-sm text-destructive">{dev.error}</p>}
   </DialogContent>
  </Dialog>
 </div>;
}
