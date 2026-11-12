import { useState } from "react";
import { Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useAIReq } from "./AIReqContext.js";

/** 原文只读；页面内独立滚动，全屏阅读不切换阶段或改变聊天位置。 */
export function AIReqProposalFeedback() {
 const aireq = useAIReq()!;
 const [expanded, setExpanded] = useState(false);
 const group = aireq.view?.drafts.find(item => item.id === aireq.selection.irId);
 const feedback = group?.returnFeedback;
 if (!group || aireq.selection.srId || group.proposalStage !== "requirements" || !feedback || feedback.resumedAt) return null;
 return <>
  <section className="shrink-0 border-b border-border bg-surface px-4 py-3 md:px-6" aria-label="最新待处理意见" data-testid="proposal-latest-feedback">
   <div className="mx-auto w-full min-w-0 max-w-4xl space-y-2">
   <div className="flex items-center justify-between gap-3"><h3 className="text-ui-base font-semibold">最新待处理意见</h3><Button size="sm" variant="ghost" onClick={() => setExpanded(true)}><Maximize2 className="size-3.5" />全屏阅读</Button></div>
   <p className="text-ui-sm text-foreground-subtle">开发 {feedback.employeeId}</p>
   <div className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-ui-base leading-6" role="region" aria-label="最新意见原文，可滚动" tabIndex={0} data-testid="proposal-feedback-scroll">{feedback.reason}</div>
   <p className="text-ui-sm text-foreground-subtle">与业务需求 Agent 讨论这些意见，由 AI 补充、修改 IR／SR，再发起需求评审。</p>
   </div>
  </section>
  <Dialog open={expanded} onOpenChange={setExpanded}>
   <DialogContent className="inset-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none" data-testid="proposal-feedback-fullscreen">
    <DialogHeader className="shrink-0 border-b border-border px-4 py-4 md:px-6 md:py-6"><div className="mx-auto w-full max-w-4xl space-y-1 pr-8"><DialogTitle>最新待处理意见</DialogTitle><DialogDescription>{group.title} · 开发 {feedback.employeeId} · 只读原文</DialogDescription></div></DialogHeader>
    <div className="min-h-0 flex-1 overflow-auto px-4 py-4 text-ui-base leading-7 md:px-6 md:py-6" role="region" aria-label="完整意见原文，可滚动" tabIndex={0} data-testid="proposal-feedback-fulltext"><div className="mx-auto w-full max-w-4xl whitespace-pre-wrap break-words">{feedback.reason}</div></div>
    <DialogFooter className="shrink-0 border-t border-border px-4 py-3 md:px-6"><div className="mx-auto flex w-full max-w-4xl justify-end"><Button variant="outline" onClick={() => setExpanded(false)}>返回讨论</Button></div></DialogFooter>
   </DialogContent>
  </Dialog>
 </>;
}
