import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { DevAgentModelSummary } from "./DevAgentModelSummary.js";
import { DevDeleteRequirement } from "./DevDeleteRequirement.js";
import { useDev } from "./DevContext.js";
import type { DevRequirementGroup } from "./types.js";

/** 菜单只承载辅助查看和管理；流程动作只在文档底栏出现。 */
export function DevProposalMenu({ group }: { group: DevRequirementGroup }) {
 const dev = useDev()!;
 const [panel, setPanel] = useState<"info" | "history">();
 const operationLabels: Record<string, string> = { createProposal: "创建提案", generateRequirements: "整理需求", supplementRequirements: "补充需求", runRequirementsReview: "需求评审", submitProposalReview: "交给开发", acceptProposal: "接手技术方案", generateProposalSolution: "生成技术方案", returnProposal: "退回业务补充", recordRequirementsDecision: "记录业务争议处理", confirmProposal: "确认需求与方案", publishProposal: "提交并推送", markRequirementsPrSubmitted: "登记需求 PR", markRequirementsMerged: "核验需求入库" };
 const operations = dev.view?.operations.filter(item => item.irId === group.id) ?? [];
 return <>
  <DevDeleteRequirement renderTrigger={(openDelete, prohibition) => <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="更多提案选项"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
   <DropdownMenuContent align="end" data-testid="proposal-more-menu">
    <DropdownMenuItem onSelect={() => setPanel("info")}>提案信息</DropdownMenuItem>
    <DropdownMenuItem onSelect={() => setPanel("history")}>操作记录</DropdownMenuItem>
    {openDelete && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={!!prohibition} title={prohibition} onSelect={openDelete}>删除提案</DropdownMenuItem></>}
   </DropdownMenuContent>
  </DropdownMenu>} />
  <Dialog open={panel !== undefined} onOpenChange={open => { if (!open) setPanel(undefined); }}>
   <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
    <DialogHeader><DialogTitle>{panel === "info" ? "提案信息" : "操作记录"}</DialogTitle><DialogDescription>{group.title} · 仅查看，不改变需求或阶段。</DialogDescription></DialogHeader>
    {panel === "info" ? <div className="space-y-4 text-ui-sm">
     <dl className="space-y-3"><div><dt className="text-foreground-subtle">提出人</dt><dd>{group.proposalLocation?.employeeId ?? "未记录"}</dd></div>
      <div><dt className="text-foreground-subtle">接手开发人</dt><dd>{group.developerAcceptance?.employeeId ?? "尚未接手"}</dd></div>
      <div><dt className="text-foreground-subtle">提案临时目录</dt><dd className="break-all font-mono">{group.proposalLocation?.directory ?? "目录未记录"}</dd></div>
      {group.requirementsPr && <div><dt className="text-foreground-subtle">已登记需求 PR</dt><dd className="break-all">{group.requirementsPr.url}</dd></div>}
     </dl>
     <DevAgentModelSummary binding={dev.session?.modelConfig ?? group.review?.modelConfig} />
    </div> : <div className="space-y-4 text-ui-sm" data-testid="proposal-operation-records">
     {operations.length ? operations.map(item => <section key={item.operationId} className="space-y-1 border-b border-border pb-3"><p>{operationLabels[item.type] ?? item.type} · {item.status === "completed" ? "已完成" : item.status === "running" ? "进行中" : "失败"}</p><time className="text-foreground-subtle" dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>{item.steps.map((step, index) => <p key={index} className="text-foreground-subtle">{step.detail}</p>)}{item.error && <p className="text-destructive">{item.error}</p>}</section>) : <p className="text-foreground-subtle">暂无操作记录。</p>}
     {[...(group.returnFeedbackHistory ?? []), ...(group.returnFeedback ? [group.returnFeedback] : [])].map((feedback, index) => <details key={`${feedback.returnedAt}:${index}`} data-testid="proposal-feedback-history"><summary className="cursor-pointer">第 {index + 1} 次退回意见 · {feedback.employeeId}{feedback.resumedAt ? " · 已继续方案" : " · 最近一次"}</summary><p className="mt-2 whitespace-pre-wrap break-words">{feedback.reason}</p></details>)}
     {(group.reviewHistory ?? []).map((review, index) => <details key={`${review.id}:${index}`}><summary className="cursor-pointer">历史需求评审 · 第 {review.round ?? 1} 轮 · {review.passed ? "通过" : "待补充"}</summary><MessageResponse>{review.report}</MessageResponse></details>)}
    </div>}
   </DialogContent>
  </Dialog>
 </>;
}
