import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { useDev } from "./DevContext.js";
import { hasCurrentProposalSolution, PROPOSAL_STATUS_LABELS } from "./mock/proposal-flow.js";
import type { DevRequirementGroup } from "./mock/types.js";

export function DevProposalControls({ group }: { group: DevRequirementGroup }) {
 const dev = useDev()!;
 const [dialog, setDialog] = useState<"return" | "pr" | "merge" | null>(null);
 const [reason, setReason] = useState("");
 const [url, setUrl] = useState("");
 const [filesConfirmed, setFilesConfirmed] = useState(false);
 const phase = group.proposalStage ?? "requirements";
 const viewing = dev.selection.discussionPhase ?? phase;
 const history = viewing !== phase;
 const target = { projectId: group.projectId, irId: group.id };
 const ready = hasCurrentProposalSolution(group);
 return <div className="space-y-2" data-testid="proposal-controls">
  <nav aria-label="需求讨论阶段" className="flex gap-1">
   <Button size="sm" variant={viewing === "requirements" ? "secondary" : "ghost"} aria-pressed={viewing === "requirements"} onClick={() => dev.select({ ...dev.selection, discussionPhase: "requirements" })}>业务需求</Button>
   <Button size="sm" variant={viewing === "solution" ? "secondary" : "ghost"} aria-pressed={viewing === "solution"} disabled={!group.developerHandoff} onClick={() => dev.select({ ...dev.selection, discussionPhase: "solution" })}>方案</Button>
  </nav>
  <p className="text-ui-sm text-foreground-subtle">{PROPOSAL_STATUS_LABELS[group.status]} · 当前阶段：{phase === "requirements" ? "业务需求" : "方案"}{history ? " · 正在查看历史讨论，只读" : ""}</p>
  {!history && phase === "requirements" && <div className="space-y-2">
   {group.returnFeedback && <div className="rounded-md border border-border p-2 text-ui-sm" data-testid="proposal-return-feedback"><p className="whitespace-pre-wrap break-words">开发反馈：{group.returnFeedback.reason}</p><p className="text-foreground-subtle">由 {group.returnFeedback.employeeId} 打回业务补充，旧方案已失效。</p></div>}
   <Button size="sm" data-testid="proposal-submit-review" disabled={dev.pending || group.status !== "draft"} onClick={() => void dev.command({ type: "submitProposalReview", ...target })}>提交评审</Button>
   <p className="text-ui-sm text-foreground-subtle">提交评审无需方案，将交给开发人员完善方案。</p>
  </div>}
  {!history && phase === "solution" && <div className="space-y-2">
   <p className="text-ui-sm text-foreground-subtle">由评审需求的开发人员完成方案；有业务卡点可打回补充。</p>

   <div className="flex flex-wrap gap-2">
    {group.status !== "requirements-pr" && <>
     <Button size="sm" data-testid="proposal-generate-solution" disabled={dev.pending || !group.srIds.length} title={!group.srIds.length ? "请先完成 IR 与至少一个 SR" : undefined} onClick={() => void dev.command({ type: "generateProposalSolution", ...target })}>{ready ? "重新生成方案（演示）" : "生成方案（演示）"}</Button>
     <Button size="sm" variant="outline" data-testid="proposal-return" onClick={() => { setReason(""); setDialog("return"); }}>打回业务补充</Button>
     <Button size="sm" variant="outline" data-testid="proposal-submit-pr" disabled={!ready || group.status !== "solution-ready" || dev.pending} onClick={() => { setUrl(`https://example.invalid/proposals/${group.id}`); setDialog("pr"); }}>提交 PR（演示）</Button>
    </>}
    {group.status === "requirements-pr" && <Button size="sm" data-testid="proposal-merge" onClick={() => { setFilesConfirmed(false); setDialog("merge"); }}>演示确认 PR 合并</Button>}
   </div>
   {ready && <p className="text-ui-sm text-foreground-subtle" data-testid="proposal-solution-ready">方案已完成 · 开发人员：{group.proposalSolution?.employeeId}</p>}
   {group.requirementsPr && <p className="break-all text-ui-sm text-foreground-subtle">PR 待合并：{group.requirementsPr.url} · 合并前仍在需求提案中。</p>}
  </div>}
  <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}>
   <DialogContent className="sm:max-w-lg">
    <DialogHeader><DialogTitle>{dialog === "return" ? "打回业务补充" : dialog === "pr" ? "提交需求 PR（演示）" : "确认 PR 合并（演示）"}</DialogTitle><DialogDescription>{dialog === "return" ? "明确需要业务补充的细节。打回后回到业务需求阶段，保留讨论和文件，旧方案失效。" : dialog === "pr" ? "正式实现使用服务账号提交包含 IR、全部 SR 与方案的需求 PR。本页仅记录示例，不访问平台或执行 Git。" : "正式实现必须核对默认分支中的 IR、全部 SR 与本轮方案。下方只演示核对与转正，不查询真实 Git。"}</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={async event => {
     event.preventDefault();
     const result = dialog === "return" ? await dev.command({ type: "returnProposal", ...target, reason }) : dialog === "pr" ? await dev.command({ type: "markRequirementsPrSubmitted", ...target, url }) : await dev.command({ type: "markRequirementsMerged", ...target, defaultBranchFilesConfirmed: filesConfirmed });
     if (result?.status === "completed") setDialog(null);
    }}>
     {dialog === "return" && <div className="space-y-2"><Label htmlFor="proposal-return-reason">需补充的业务细节</Label><SettingsFormTextarea id="proposal-return-reason" value={reason} onChange={event => setReason(event.target.value)} rows={4} placeholder="例如：需明确重复执行、失败重试和取消的业务规则。" required /></div>}
     {dialog === "pr" && <div className="space-y-2"><Label htmlFor="proposal-pr-url">示例 PR 地址</Label><Input id="proposal-pr-url" type="url" value={url} onChange={event => setUrl(event.target.value)} required /></div>}
     {dialog === "merge" && <div className="space-y-3"><ul className="max-h-40 space-y-1 overflow-y-auto break-all text-ui-sm">{group.files.map(file => <li key={file.path}>{file.path}</li>)}</ul><label className="flex items-start gap-2 text-ui-sm"><Checkbox checked={filesConfirmed} onCheckedChange={checked => setFilesConfirmed(checked === true)} />仅演示：PR 已合并，默认分支已包含以上全部文件</label></div>}
     {dev.error && <p role="alert" className="text-ui-sm text-destructive">{dev.error}</p>}
     <DialogFooter><Button type="button" variant="outline" onClick={() => setDialog(null)}>取消</Button><Button type="submit" disabled={dev.pending || (dialog === "return" ? !reason.trim() : dialog === "pr" ? !url.trim() : !filesConfirmed)}>{dialog === "return" ? "打回补充" : dialog === "pr" ? "记录 PR 提交" : "演示合并并转为正式需求"}</Button></DialogFooter>
    </form>
   </DialogContent>
  </Dialog>
 </div>;
}
