import { useAIReqDataSource } from "./data-source.js";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { AIReqMarkdownDocument } from "./AIReqMarkdownDocument.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { AIReqAgentModelSummary } from "./AIReqAgentModelSummary.js";
import { useAIReq } from "./AIReqContext.js";
import { requirementsDecisionCurrent, requirementsReviewCurrent } from "./domain.js";
import type { AIReqRequirementGroup, AIReqRequirementsDecision, AIReqReview } from "./types.js";

const outcomeLabels: Record<AIReqRequirementsDecision["outcome"], string> = {
 supplement: "要求补充需求并重新评审",
 maintain: "保留 AI 原结论（不改变通过状态）",
 defer: "争议未解决，暂缓交接",
};
type DecisionDraft = Pick<AIReqRequirementsDecision, "reviewId" | "snapshotDigest" | "inputFiles" | "opinion" | "outcome" | "result" | "review">;

function ReviewBinding({ review }: { review: AIReqReview }) {
 return <div className="space-y-2 text-ui-sm text-foreground-subtle">
  <p className="break-all">原始评审：{review.id} · 第 {review.round ?? 1} 轮 · AI {review.passed ? "通过" : "未通过"}</p>
  <p className="break-all">绑定快照：{review.snapshotDigest}</p>
  <p>发起工号：{review.requestedBy ?? "未记录"} · <time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>（北京时间）</p>
  <details><summary className="cursor-pointer">绑定的需求文件版本（{review.inputFiles?.length ?? 0}）</summary><ul className="mt-1 space-y-1">{review.inputFiles?.map(file => <li key={file.path} className="break-all font-mono">{file.path} · {file.sha256} · {file.size} 字节</li>)}</ul></details>
 </div>;
}

/** 人工记录独立保存；不改写 AI 报告，不自动评审，也不提供绕过门槛的确认。 */
export function AIReqRequirementsDecision({ group, readOnly = false }: { group: AIReqRequirementGroup; readOnly?: boolean }) {
 const source = useAIReqDataSource();
 if (!source.capabilities.requirementManagement) return null;
 const aireq = useAIReq()!;
 const [draft, setDraft] = useState<DecisionDraft>();
 const editable = !readOnly && ["draft", "solution-ready"].includes(group.status) && (group.proposalStage ?? "requirements") === "requirements";
 const current = requirementsReviewCurrent(group);
 const draftCurrent = Boolean(draft && requirementsDecisionCurrent(group, draft));
 const decisions = group.requirementsDecisions ?? [];
 const begin = () => {
  if (!editable || !current || !group.review) return;
  const review = structuredClone(group.review);
  setDraft({ review, reviewId: review.id, snapshotDigest: review.snapshotDigest, inputFiles: review.inputFiles ?? [], opinion: "", outcome: "supplement", result: "" });
 };
 return <section className="space-y-3 border-t border-border pt-3" data-testid="requirements-decisions">
  <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-ui-sm font-medium">人工业务争议处理</h3>{editable && <Button type="button" size="sm" variant="outline" data-testid="requirements-decision-begin" disabled={aireq.pending || !current} onClick={begin}>{draft ? "重新开始记录当前评审" : "记录业务争议处理"}</Button>}</div>
  <p className="text-ui-sm text-foreground-subtle">人工意见与 AI 原始结论分开保存。保留原结论不等于人工通过；要求补充须更新材料后显式重评，暂缓争议在相同材料重评后仍阻断交接。</p>
  {!editable && <p className="text-ui-sm text-foreground-subtle" data-testid="requirements-decision-readonly">仅当前业务需求阶段可记录处理结果；PR 待合并、正式需求、技术方案阶段和历史阶段只读。</p>}
  {editable && !current && <p className="text-ui-sm text-foreground-subtle">请先显式评审当前需求版本，再开始人工处理。</p>}
  {draft && <form className="space-y-3 rounded-md border border-border p-3" data-testid="requirements-decision-form" onSubmit={async event => {
   event.preventDefault();
   if (!editable || !draftCurrent || !draft.opinion.trim() || !draft.result.trim() || aireq.pending) return;
   const receipt = await aireq.command({ type: "recordRequirementsDecision", projectId: group.projectId, irId: group.id, reviewId: draft.reviewId, snapshotDigest: draft.snapshotDigest, opinion: draft.opinion.trim(), outcome: draft.outcome, result: draft.result.trim() });
   if (receipt?.status === "completed") setDraft(undefined);
  }}>
   <div data-testid="requirements-decision-entry-version"><ReviewBinding review={draft.review} /></div>
   {(!draftCurrent || !editable) && <p role="alert" className="text-ui-sm text-destructive" data-testid="requirements-decision-stale">开始记录时的评审版本或阶段已变化，此记录不可提交。请返回当前业务需求阶段并重新开始记录。</p>}
   <div className="space-y-1"><Label htmlFor={`requirements-decision-opinion-${group.id}`}>业务争议意见</Label><SettingsFormTextarea id={`requirements-decision-opinion-${group.id}`} data-testid="requirements-decision-opinion" rows={3} value={draft.opinion} disabled={!editable || !draftCurrent || aireq.pending} required placeholder="说明有争议的业务规则、场景及依据。" onChange={event => setDraft({ ...draft, opinion: event.target.value })} /></div>
   <div className="space-y-1"><Label htmlFor={`requirements-decision-outcome-${group.id}`}>处理方式</Label><Select value={draft.outcome} disabled={!editable || !draftCurrent || aireq.pending} onValueChange={value => setDraft({ ...draft, outcome: value as AIReqRequirementsDecision["outcome"] })}><SelectTrigger id={`requirements-decision-outcome-${group.id}`} data-testid="requirements-decision-outcome" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{(Object.keys(outcomeLabels) as AIReqRequirementsDecision["outcome"][]).map(value => <SelectItem key={value} value={value}>{outcomeLabels[value]}</SelectItem>)}</SelectContent></Select></div>
   <div className="space-y-1"><Label htmlFor={`requirements-decision-result-${group.id}`}>明确处理结果及理由</Label><SettingsFormTextarea id={`requirements-decision-result-${group.id}`} data-testid="requirements-decision-result" rows={3} value={draft.result} disabled={!editable || !draftCurrent || aireq.pending} required placeholder="记录需补充什么及重评要求、为何保留原结论，或尚未解决的问题与暂缓原因。" onChange={event => setDraft({ ...draft, result: event.target.value })} /></div>
   <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" data-testid="requirements-decision-submit" disabled={!editable || !draftCurrent || aireq.pending || !draft.opinion.trim() || !draft.result.trim()}>保存人工处理记录</Button><Button type="button" size="sm" variant="ghost" onClick={() => setDraft(undefined)}>取消记录</Button></div>
  </form>}
  {decisions.length === 0 ? <p className="text-ui-sm text-foreground-subtle" data-testid="requirements-decision-empty">尚无人工处理记录。</p> : <div className="space-y-2" data-testid="requirements-decision-history">{decisions.map((decision, index) => {
   const decisionCurrent = requirementsDecisionCurrent(group, decision);
   const superseded = decisions.slice(index + 1).some(item => item.reviewId === decision.reviewId && item.snapshotDigest === decision.snapshotDigest);
   return <details key={`${decision.reviewId}:${decision.createdAt}:${index}`} className="rounded-md border border-border p-3 text-ui-sm" data-testid="requirements-decision-record" open={decisionCurrent && !superseded}>
    <summary className="cursor-pointer"><span data-testid="requirements-decision-version">{decisionCurrent ? superseded ? "当前版本较早处理（已替代）" : "当前版本最新人工处理" : "历史处理（不属于当前评审版本）"}</span> · {outcomeLabels[decision.outcome]}</summary>
    <div className="mt-3 space-y-3">
     <p className="text-foreground-subtle" data-testid="requirements-decision-actor">处理工号：{decision.employeeId} · <time dateTime={decision.createdAt}>{new Date(decision.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>（北京时间）</p>
     <p className="whitespace-pre-wrap break-words" data-testid="requirements-decision-record-opinion">业务争议意见：{decision.opinion}</p>
     <p className="whitespace-pre-wrap break-words" data-testid="requirements-decision-record-result">处理结果：{decision.result}</p>
     <p className="break-all text-foreground-subtle">记录绑定：{decision.reviewId} · {decision.snapshotDigest}</p>
     <details className="space-y-2" data-testid="requirements-decision-original-review"><summary className="cursor-pointer">查看处理时的原始 AI 评审（未改写）</summary><ReviewBinding review={decision.review} /><AIReqAgentModelSummary binding={decision.review.modelConfig} />{Boolean(decision.review.findings?.length) && <ul className="space-y-2">{decision.review.findings?.map(finding => <li key={finding.id} className="rounded-md border border-border p-2"><p>{finding.level === "blocking" ? "需补充" : "建议"}：{finding.message}</p><p className="mt-1 break-all text-foreground-subtle">{finding.documentPath}</p></li>)}</ul>}<AIReqMarkdownDocument>{decision.review.report}</AIReqMarkdownDocument></details>
    </div>
   </details>;
  })}</div>}
  {decisions.length > 0 && <p className="text-ui-sm text-foreground-subtle">版本变化后旧记录只作历史查看；但仅更换评审编号不会解除同一份材料上的暂缓或补充要求，最新人工处理也不会覆盖 AI 的阻断结论。</p>}
 </section>;
}
