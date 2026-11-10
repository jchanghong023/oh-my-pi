import { useDevDataSource } from "./data-source.js";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Label } from "@/components/ui/label.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useDev } from "./DevContext.js";
import { irFinalPackageBlocker } from "./domain.js";
import type { DevRequirementGroup } from "./types.js";

export function DevIrFinalPrControls({ group }: { group: DevRequirementGroup }) {
 const source = useDevDataSource();
 if (source.mode !== "prototype" || !source.capabilities.prototypeBusiness) return null;
  const dev = useDev()!;
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(group.acceptance?.pr?.url ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const acceptance = group.acceptance!;
  const blocker = irFinalPackageBlocker(dev.view!, group);
  const pushed = acceptance.pushedCandidate === acceptance.candidate && acceptance.pushedPackageVersion === acceptance.packageVersion;
  return <div className="space-y-2">
    <Button size="sm" data-testid="ir-final-pr-open" onClick={() => setOpen(true)}>处理最终 PR</Button>
    {blocker && <p className="text-ui-sm text-foreground-subtle">{blocker}</p>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>IR 最终修复与归档 PR</DialogTitle><DialogDescription>{group.title} · 验收绑定当前候选；人工合并并核验修复及完整归档后，才完成 IR 并释放仓库。关闭弹窗可在右侧阅读标题、正文和完整清单。</DialogDescription></DialogHeader>
        {blocker && <p role="alert" data-testid="ir-final-package-blocker" className="text-ui-sm text-destructive">{blocker}</p>}
        <div className="space-y-2 text-ui-sm text-foreground-subtle" data-testid="ir-final-archive-summary"><p>{acceptance.hasFixes ? `同一 PR：${acceptance.archive?.fixes.length ?? 0} 个修复／测试文件及完整 Change 归档。` : "本轮无实现修复，最终 PR 仅移动 Change 归档。"}</p><p>归档只移动目录，保留文件内容版本，不再次同步 openspec/specs。</p><p className="break-all">归档目标：{acceptance.archive?.targetRoot}</p></div>
        <details className="text-ui-sm text-foreground-subtle"><summary className="cursor-pointer">修复与归档清单 · {acceptance.archive?.moves.length ?? 0} 个移动文件</summary><ul className="mt-2 space-y-2 break-all">{acceptance.archive?.fixes.map(file => <li key={file.path}>修复／测试：{file.path}</li>)}{acceptance.archive?.moves.map(move => <li key={move.path}>{move.sourcePath} → {move.path}</li>)}</ul></details>
        {!blocker && acceptance.status === "pr-ready" && !pushed && <Button data-testid="ir-final-pr-publish" onClick={() => void dev.command({ type: "publishIrFinalPr", candidate: acceptance.candidate })}>提交并推送最终分支（演示）</Button>}
        {!blocker && acceptance.status === "pr-ready" && pushed && <form className="space-y-3" onSubmit={event => { event.preventDefault(); setConfirmed(false); void dev.command({ type: "markIrFinalPrSubmitted", url }); }}>
          <Label htmlFor="ir-final-pr-url">人工创建的最终 PR 链接</Label><Input id="ir-final-pr-url" type="url" placeholder="https://git.example.com/project/pulls/123" value={url} onChange={event => setUrl(event.target.value)} required />
          <Button data-testid="ir-final-pr-submit" type="submit" disabled={!/^https?:\/\/[^\s]+$/.test(url.trim())}>登记当前候选 PR（演示）</Button>
        </form>}
        {acceptance.pr && <a href={acceptance.pr.url} target="_blank" rel="noreferrer" className="break-all text-ui-sm underline">{acceptance.prCandidate === acceptance.candidate ? "当前最终 PR" : "旧候选 PR，重新验收后需更新登记"}：{acceptance.pr.url}</a>}
        {!blocker && acceptance.status === "pr-submitted" && <div className="space-y-3">
          <div className="flex items-start gap-2"><Checkbox id="ir-final-merge-files" checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} /><Label htmlFor="ir-final-merge-files" className="text-ui-sm leading-5">演示核对：默认分支含当前候选修复和测试，完整 Change 已移入目标归档目录、原目录已不存在；未重复同步规格。</Label></div>
          <Button data-testid="ir-final-merge-verify" disabled={!confirmed} onClick={() => void dev.command({ type: "verifyIrFinalMerge", candidate: acceptance.candidate, filesConfirmed: confirmed })}>告知已合并并核验（演示）</Button>
        </div>}
        <p className="text-ui-xs text-foreground-subtle">仅内存演示，不执行提交、推送、测试、目录移动或 PR 查询；链接与勾选不代表真实平台审核结果。</p>
        {dev.error && <p role="alert" className="text-ui-sm text-destructive">{dev.error}</p>}
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>返回聊天</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
