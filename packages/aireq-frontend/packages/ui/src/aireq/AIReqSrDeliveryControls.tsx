import { useAIReqDataSource } from "./data-source.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Label } from "@/components/ui/label.js";
import { useAIReq } from "./AIReqContext.js";
import { srDefaultCommit, srDeliveryBlocker, srDeliveryInputBlocker, SR_DELIVERY_LABELS } from "./domain.js";
import type { AIReqSystemRequirement } from "./types.js";

export function AIReqSrDeliveryControls({ sr, compact = false }: { sr: AIReqSystemRequirement; compact?: boolean }) {
 const source = useAIReqDataSource();
 if (!source.capabilities.requirementManagement) return null;
  const aireq = useAIReq()!;
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(sr.codePr?.url ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [scopeUnchanged, setScopeUnchanged] = useState(false);
  const delivery = sr.delivery;
  const inputBlocker = srDeliveryInputBlocker(aireq.view!, sr);
  const blocker = srDeliveryBlocker(aireq.view!, sr);
  const conflict = delivery?.status === "git-conflict" || delivery?.status === "requirement-conflict";
  const needsHuman = conflict && !delivery?.humanResolution;
  const latest = srDefaultCommit(aireq.view!, sr.projectId);
  const statusLabel = delivery ? delivery.defaultCommit !== latest || delivery.round !== sr.round || delivery.inputDigest !== sr.materialDigest ? "交付候选已失效，需重新准备" : SR_DELIVERY_LABELS[delivery.status] : "待准备";
  const canVerify = delivery?.status === "prepared" && delivery.defaultCommit === latest && !srDeliveryBlocker(aireq.view!, sr, false);
  const currentPr = Boolean(sr.codePr && delivery?.prCandidate === delivery?.candidate);
  const prepare = async () => {
    const result = await aireq.command({ type: "prepareSrDelivery" });
    if (result) { setConfirmed(false); setScopeUnchanged(false); setNote(""); }
  };
  return <div className="space-y-2" data-testid="sr-delivery-summary">
    <div className="flex flex-wrap items-center gap-2"><Button size="sm" data-testid="sr-delivery-open" onClick={() => setOpen(true)}>{delivery ? "处理交付 PR" : "准备交付 PR"}</Button>{!compact && <span className="text-ui-sm text-foreground-subtle">{currentPr && !blocker ? "PR 待人工合并核验" : delivery ? statusLabel : "代码、测试和规格同一个 PR"}</span>}</div>
    {!compact && blocker && delivery && <p className="text-ui-sm text-foreground-subtle">{blocker}</p>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>SR 交付 PR</DialogTitle><DialogDescription>{sr.title} · 完整交付、合并前验证与人工合并核验。关闭弹窗可在右侧查看 PR 标题、正文与清单，不会丢失交付状态。</DialogDescription></DialogHeader>
        <section className="space-y-2 rounded-lg border border-border p-3" data-testid="sr-delivery-controls" data-status={delivery?.status ?? "unprepared"}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-ui-sm font-medium">同一 PR 交付：代码、测试与规格</h3><span className="text-ui-xs text-foreground-subtle">{statusLabel}</span></div>
    <p className="text-ui-sm text-foreground-subtle" data-testid="sr-delivery-blocker" role="status">{blocker ?? (currentPr ? "已登记当前候选 PR，等待人工评审、合并与结果核验。" : "当前候选已完成合并前验证，请人工创建 PR 并登记链接。")}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant={delivery ? "outline" : "default"} data-testid="sr-delivery-prepare" disabled={!!inputBlocker || needsHuman} onClick={() => void prepare()}>{delivery?.status === "implementation-issue" ? "修复并重新准备" : delivery ? "重新准备交付" : "准备交付清单"}</Button>
      {delivery && <Button size="sm" data-testid="sr-delivery-verify" disabled={!canVerify} onClick={() => void aireq.command({ type: "verifySrDelivery", candidate: delivery.candidate, defaultCommit: delivery.defaultCommit, outcome: "passed" })}>对齐默认分支并验证</Button>}
    </div>
    {delivery && <details className="text-ui-sm text-foreground-subtle"><summary className="cursor-pointer">交付范围与候选版本 · {delivery.files.length} 个文件</summary><ul className="mt-2 space-y-1 break-all">{delivery.files.map(file => <li key={file.path}>{file.category === "code" ? "代码" : file.category === "test" ? "测试" : "正式规格"}：{file.path}</li>)}</ul><p className="mt-2 break-all">候选：{delivery.candidate} · 对齐基点：{delivery.defaultCommit}</p><p className="break-all">来源：{delivery.sourceSpec}；冻结增量需求保持不变。</p></details>}
    {needsHuman && <div className="space-y-2 border-t border-border pt-2">
      <p className="text-ui-sm text-foreground-subtle">暂停等待人工；如需改变业务需求或方案，请重新提案。当前不会自动解决冲突。</p>
      <Label htmlFor="sr-delivery-human-note">人工处理说明</Label><Input id="sr-delivery-human-note" value={note} onChange={event => setNote(event.target.value)} placeholder="说明冲突如何处理及核对结果" />
      <label className="flex items-start gap-2 text-ui-sm"><Checkbox checked={scopeUnchanged} onCheckedChange={value => setScopeUnchanged(value === true)} />人工确认处理不改变冻结的需求和方案</label>
      <Button size="sm" variant="outline" data-testid="sr-delivery-human-resume" disabled={!note.trim() || !scopeUnchanged} onClick={() => void aireq.command({ type: "resolveSrDeliveryConflict", note, scopeUnchanged })}>记录人工处理结果</Button>
    </div>}
    {delivery && !blocker && delivery.pushedCandidate !== delivery.candidate && <Button size="sm" data-testid="sr-delivery-publish" onClick={() => void aireq.command({ type: "publishSrDelivery", candidate: delivery.candidate })}>提交并推送分支</Button>}
    {delivery?.pushedCandidate === delivery?.candidate && delivery && <p className="text-ui-sm text-foreground-subtle">当前候选分支已提交、推送，请人工创建或更新 PR。</p>}
    {delivery && !blocker && delivery.pushedCandidate === delivery.candidate && <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); setConfirmed(false); void aireq.command({ type: "markCodePrSubmitted", url }); }}>
      <div className="min-w-40 flex-1 space-y-1"><Label htmlFor="sr-delivery-pr-url">人工创建的 PR 地址</Label><Input data-testid="code-pr-url" id="sr-delivery-pr-url" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://git.example.com/project/pulls/123" required /></div>
      <Button size="sm" data-testid="code-pr-submit" disabled={!/^https?:\/\/[^\s]+$/.test(url.trim())}>{currentPr ? "更新当前候选 PR" : "登记 PR"}</Button>
    </form>}
    {sr.codePr && <p className="break-all text-ui-sm text-foreground-subtle">{currentPr ? "当前候选 PR" : "已有 PR，需重新登记当前候选"}：{sr.codePr.url}</p>}
    {currentPr && !blocker && <div className="space-y-2 border-t border-border pt-2">
      <label className="flex items-start gap-2 text-ui-sm"><Checkbox data-testid="sr-delivery-merge-files" checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} />核对：默认分支包含当前候选的代码、测试和对应正式规格，合并前验证仍有效。</label>
      <Button size="sm" data-testid="code-pr-merged" disabled={!confirmed} onClick={() => void aireq.command({ type: "markCodeMerged", candidate: delivery!.candidate, filesConfirmed: confirmed })}>告知已合并并核验</Button>
    </div>}
    {delivery && source.capabilities.workflowCommands.includes("simulateSrDefaultBranchUpdate") && <details className="text-ui-xs text-foreground-subtle"><summary className="cursor-pointer">演示异常场景</summary><div className="mt-2 flex flex-wrap gap-2">
      <Button variant="ghost" size="sm" data-testid="sr-delivery-default-update" onClick={() => { setConfirmed(false); void aireq.command({ type: "simulateSrDefaultBranchUpdate" }); }}>默认分支变化（演示）</Button>
      {(["implementation-issue", "git-conflict", "requirement-conflict"] as const).map(outcome => <Button key={outcome} variant="ghost" size="sm" disabled={!canVerify} data-testid={`sr-delivery-${outcome}`} onClick={() => void aireq.command({ type: "verifySrDelivery", candidate: delivery.candidate, defaultCommit: delivery.defaultCommit, outcome })}>{outcome === "implementation-issue" ? "验证失败" : outcome === "git-conflict" ? "Git 冲突" : "需求冲突"}（演示）</Button>)}
    </div></details>}
    <p className="text-ui-xs text-foreground-subtle">{source.provenance.kind === "sample" ? "仅静态演示，不执行提交、推送、测试或规格同步；PR 由人工创建、评审和合并。右侧提供标题、正文与来源记录。" : "PR 由人工创建、评审和合并。右侧提供标题、正文与来源记录。"}</p>
    {Boolean(sr.deliveryHistory?.length) && <details className="text-ui-xs text-foreground-subtle"><summary className="cursor-pointer">历史交付（{sr.deliveryHistory!.length}）</summary><ul className="mt-2 space-y-1 break-all">{sr.deliveryHistory!.map(item => <li key={item.candidate}>{item.candidate} · {SR_DELIVERY_LABELS[item.status]} · {item.defaultCommit} · 历史记录不可放行当前交付</li>)}</ul></details>}
    {aireq.error && <p role="alert" className="text-ui-sm text-destructive">{aireq.error}</p>}
        </section>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>返回聊天</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
