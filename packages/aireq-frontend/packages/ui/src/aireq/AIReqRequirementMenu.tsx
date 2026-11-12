import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { AIReqAgentModelSummary } from "./AIReqAgentModelSummary.js";
import { AIReqDeleteRequirement } from "./AIReqDeleteRequirement.js";
import { useAIReq, AIREQ_STAGE_LABELS } from "./AIReqContext.js";
import type { AIReqRequirementGroup } from "./types.js";

/** 菜单只承载辅助查看和管理；流程动作只在文档底栏出现。 */
export function AIReqRequirementMenu({ group }: { group: AIReqRequirementGroup }) {
 const aireq = useAIReq()!;
 const [panel, setPanel] = useState<"info" | "history">();
 const formal = aireq.view?.groups.some(item => item.id === group.id && item.projectId === group.projectId);
 const sr = formal ? aireq.view?.srs.find(item => item.id === aireq.selection.srId && item.irId === group.id && item.projectId === group.projectId) : undefined;
 const infoTitle = sr ? "SR 信息" : formal ? "需求信息" : "提案信息";
 const worktree = sr ? sr.worktree : group.acceptance?.worktree ?? group.worktree;
 const operationLabels: Record<string, string> = { createProposal: "创建提案", generateRequirements: "整理需求", supplementRequirements: "补充需求", runRequirementsReview: "需求评审", submitProposalReview: "交给开发", acceptProposal: "接手技术方案", generateProposalSolution: "生成技术方案", returnProposal: "退回业务补充", recordRequirementsDecision: "记录业务争议处理", confirmProposal: "确认需求与方案", publishProposal: "提交并推送", markRequirementsPrSubmitted: "登记需求 PR", markRequirementsMerged: "核验需求入库" };
 const operations = aireq.view?.operations.filter(item => item.irId === group.id && (!sr || item.srId === sr.id)) ?? [];
 return <>
  {formal ? <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="更多需求选项"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
   <DropdownMenuContent align="end" data-testid="formal-more-menu">
    <DropdownMenuItem onSelect={() => setPanel("info")}>{infoTitle}</DropdownMenuItem>
    <DropdownMenuItem onSelect={() => setPanel("history")}>操作记录</DropdownMenuItem>
   </DropdownMenuContent>
  </DropdownMenu> : <AIReqDeleteRequirement renderTrigger={(openDelete, prohibition) => <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="更多提案选项"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
   <DropdownMenuContent align="end" data-testid="proposal-more-menu">
    <DropdownMenuItem onSelect={() => setPanel("info")}>提案信息</DropdownMenuItem>
    <DropdownMenuItem onSelect={() => setPanel("history")}>操作记录</DropdownMenuItem>
    {openDelete && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={!!prohibition} title={prohibition} onSelect={openDelete}>删除提案</DropdownMenuItem></>}
   </DropdownMenuContent>
  </DropdownMenu>} />}
  <Dialog open={panel !== undefined} onOpenChange={open => { if (!open) setPanel(undefined); }}>
   <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
    <DialogHeader><DialogTitle>{panel === "info" ? infoTitle : "操作记录"}</DialogTitle><DialogDescription>{sr?.title ?? group.title} · 仅查看，不改变需求或阶段。</DialogDescription></DialogHeader>
    {panel === "info" ? <div className="space-y-4 text-ui-sm">
     <dl className="space-y-3">
      {formal ? <>
       <div><dt className="text-foreground-subtle">需求文件</dt><dd className="break-all font-mono">{sr?.documentPath ?? group.documentPath}</dd></div>
       {sr ? <>
        <div><dt className="text-foreground-subtle">开发人</dt><dd>{sr.developerEmployeeId ?? "尚未开始"}</dd></div>
        <div><dt className="text-foreground-subtle">当前轮次</dt><dd>第 {sr.round} 轮</dd></div>
        {sr.developmentRoot && <div><dt className="text-foreground-subtle">开发项目</dt><dd className="break-all font-mono">{sr.developmentRoot}</dd></div>}
        {sr.codePr && <div><dt className="text-foreground-subtle">代码 PR</dt><dd className="break-all">{sr.codePr.url}</dd></div>}
       </> : group.acceptance && <div><dt className="text-foreground-subtle">验收开发人</dt><dd>{group.acceptance.employeeId}</dd></div>}
       {worktree && <><div><dt className="text-foreground-subtle">工作目录</dt><dd className="break-all font-mono">{worktree.path}</dd></div><div><dt className="text-foreground-subtle">分支</dt><dd className="break-all font-mono">{worktree.branch}</dd></div></>}
       {!sr && group.acceptance?.pr && <div><dt className="text-foreground-subtle">归档 PR</dt><dd className="break-all">{group.acceptance.pr.url}</dd></div>}
      </> : <>
       <div><dt className="text-foreground-subtle">提出人</dt><dd>{group.proposalLocation?.employeeId ?? "未记录"}</dd></div>
       <div><dt className="text-foreground-subtle">接手开发人</dt><dd>{group.developerAcceptance?.employeeId ?? "尚未接手"}</dd></div>
       <div><dt className="text-foreground-subtle">提案临时目录</dt><dd className="break-all font-mono">{group.proposalLocation?.directory ?? "目录未记录"}</dd></div>
      </>}
      {!sr && group.requirementsPr && <div><dt className="text-foreground-subtle">已登记需求 PR</dt><dd className="break-all">{group.requirementsPr.url}</dd></div>}
     </dl>
     <AIReqAgentModelSummary binding={aireq.session?.modelConfig ?? group.review?.modelConfig} />
    </div> : <div className="space-y-4 text-ui-sm" data-testid={formal ? "formal-operation-records" : "proposal-operation-records"}>
     {operations.length ? operations.map(item => <section key={item.operationId} className="space-y-1 border-b border-border pb-3"><p>{operationLabels[item.type] ?? item.type} · {item.status === "completed" ? "已完成" : item.status === "running" ? "进行中" : "失败"}</p><time className="text-foreground-subtle" dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>{item.steps.map((step, index) => <p key={index} className="text-foreground-subtle">{step.detail}</p>)}{item.error && <p className="text-destructive">{item.error}</p>}</section>) : <p className="text-foreground-subtle">暂无操作记录。</p>}
     {sr ? <>
      {sr.approvals.map(item => <p key={item.operationId}>{AIREQ_STAGE_LABELS[item.stage]} · 第 {item.round} 轮 · {item.valid === false ? "已失效" : "已确认"} · {new Date(item.approvedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</p>)}
      {sr.codePrHistory?.map(item => <p key={item.url} className="break-all">历史代码 PR（不可用作本轮交付）：{item.url}</p>)}
     </> : <>
      {[...(group.returnFeedbackHistory ?? []), ...(group.returnFeedback ? [group.returnFeedback] : [])].map((feedback, index) => <details key={`${feedback.returnedAt}:${index}`} data-testid="proposal-feedback-history"><summary className="cursor-pointer">第 {index + 1} 次退回意见 · {feedback.employeeId}{feedback.resumedAt ? " · 已补充需求" : " · 最近一次"}</summary><p className="mt-2 whitespace-pre-wrap break-words">{feedback.reason}</p></details>)}
      {(group.reviewHistory ?? []).map((review, index) => <details key={`${review.id}:${index}`}><summary className="cursor-pointer">历史需求评审 · 第 {review.round ?? 1} 轮 · {review.passed ? "通过" : "待补充"}</summary><MessageResponse>{review.report}</MessageResponse></details>)}
     </>}
    </div>}
   </DialogContent>
  </Dialog>
 </>;
}
