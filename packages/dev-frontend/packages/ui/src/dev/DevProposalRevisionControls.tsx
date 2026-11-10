import { useDevDataSource } from "./data-source.js";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Label } from "@/components/ui/label.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { useDev } from "./DevContext.js";
import { proposalRevisionBlocker } from "./domain.js";
import type { DevRequirementGroup } from "./types.js";

export function DevProposalRevisionControls({ group }: { group: DevRequirementGroup }) {
 const source = useDevDataSource();
 if (source.mode !== "prototype" || !source.capabilities.prototypeBusiness) return null;
 const dev = useDev()!;
 const [open, setOpen] = useState(false);
 const [reason, setReason] = useState("");
 const formal = dev.view?.groups.some(item => item.id === group.id);
 const blocker = dev.view ? proposalRevisionBlocker(dev.view, group) : "正在读取提案。";
 return <section className="space-y-2 text-ui-sm" data-testid="proposal-revision-controls">
  {formal && <Button size="sm" variant="outline" data-testid="proposal-revision-start" disabled={dev.pending || !!blocker} title={blocker} onClick={() => setOpen(true)}>修订正式提案（演示）</Button>}
  {group.revising && <p role="status" className="text-foreground-subtle" data-testid="proposal-revision-blocked">正式提案修订中：原入库版本保留在历史；全部 SR 禁止开始开发。补充需求后须重新评审、人工确认、提交推送及提案 PR 合并核验，才能恢复开发准入。</p>}
  {!!group.proposalRevisions?.length && <details className="space-y-2" data-testid="proposal-revision-history"><summary className="cursor-pointer">修订及原入库历史（{group.proposalRevisions.length}）</summary>{group.proposalRevisions.map((revision, index) => <details key={revision.startedAt} className="mt-2 space-y-2 rounded-md border border-border p-3"><summary className="cursor-pointer">第 {index + 1} 次修订 · {revision.completedAt ? "已重新入库" : "修订中"} · 原合并：{revision.merge.commit}</summary><p className="whitespace-pre-wrap break-words">修订原因：{revision.reason}</p><p className="text-foreground-subtle">操作人：{revision.employeeId} · 开始：{revision.startedAt}{revision.completedAt ? ` · 入库：${revision.completedAt}` : ""}</p><p className="break-all">原需求版本：{revision.snapshot.digest}</p>{revision.delivery && <p className="break-all">原确认候选：{revision.delivery.candidate} · 确认人：{revision.delivery.confirmedBy}</p>}{revision.requirementsPr && <p className="break-all">原提案 PR：{revision.requirementsPr.url}</p>}{revision.review && <details><summary className="cursor-pointer">原 AI 评审（历史，只读）</summary><MessageResponse>{revision.review.report}</MessageResponse></details>}{revision.materials.map(material => <details key={material.path}><summary className="cursor-pointer break-all">原文件：{material.path} · {material.sha256}</summary><MessageResponse>{material.content ?? "原文件正文不可用"}</MessageResponse></details>)}</details>)}</details>}
  <Dialog open={open} onOpenChange={setOpen}>
   <DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>修订正式提案（演示）</DialogTitle><DialogDescription>仅限所有 SR 尚未开发。原入库材料和评审保留为只读历史，同一 IR 返回需求提案继续补充；修订期间不能使用旧合并记录开发。不执行真实 Git 或修改真实文件。</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={async event => {
     event.preventDefault();
     if (blocker) return;
     const result = await dev.command({ type: "beginProposalRevision", projectId: group.projectId, irId: group.id, reason });
     if (result?.status === "completed") { setOpen(false); setReason(""); }
    }}><div className="space-y-2"><Label htmlFor="proposal-revision-reason">修订原因与范围</Label><SettingsFormTextarea id="proposal-revision-reason" data-testid="proposal-revision-reason" value={reason} onChange={event => setReason(event.target.value)} rows={4} required /></div>{dev.error && <p role="alert" className="text-destructive">{dev.error}</p>}<DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button><Button type="submit" data-testid="proposal-revision-confirm" disabled={dev.pending || !!blocker || !reason.trim()}>开始修订（演示）</Button></DialogFooter></form>
   </DialogContent>
  </Dialog>
 </section>;
}
