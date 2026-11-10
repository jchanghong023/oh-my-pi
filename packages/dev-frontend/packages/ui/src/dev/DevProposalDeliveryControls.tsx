import { useDevDataSource } from "./data-source.js";
import type { DevPrHandoffScenario } from "./types.js";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { useDev } from "./DevContext.js";
import { DevProposalPrHandoff } from "./DevProposalPrHandoff.js";
import { getEmployeeId } from "./identity.js";
import { proposalDeliveryCurrent, proposalVersion } from "./domain.js";
import type { DevFileVersion, DevProposalDelivery, DevRequirementGroup } from "./types.js";

type DeliveryStep = "confirm" | "push" | "pr" | "merge";
interface DeliveryDialog {
 step: DeliveryStep;
 version: string;
 candidate?: string;
 files: DevFileVersion[];
}
const stepTitles: Record<DeliveryStep, string> = {
 confirm: "人工确认需求与方案（演示）",
 push: "AI 提交并推送需求分支（演示）",
 pr: "人工创建并登记需求 PR（演示）",
 merge: "核验需求 PR 合并（演示）",
};

function DeliveryRecord({ delivery, stale = false }: { delivery: DevProposalDelivery; stale?: boolean }) {
 return <div className="space-y-1 break-all text-ui-sm" data-testid="proposal-delivery-record">
  <p>候选：<span className="font-mono">{delivery.candidate}</span>{stale ? " · 历史版本，不可放行当前交付" : ""}</p>
  <p>人工确认：{delivery.confirmedBy} · {delivery.confirmedAt}</p>
  <p>提交与推送（演示）：{delivery.pushedCandidate === delivery.candidate ? `已完成 · ${delivery.pushedAt ?? "时间未记录"}` : "未完成"}</p>
  <p>人工 PR 登记：{delivery.prCandidate === delivery.candidate ? "已绑定此候选" : "未绑定此候选"}</p>
  <details><summary className="cursor-pointer text-foreground-subtle">确认版本与完整文件清单（{delivery.files.length}）</summary><ul className="mt-2 space-y-2">{delivery.files.map(file => <li key={file.path}><p className="font-mono">{file.path}</p><p className="text-foreground-subtle">样例版本：{file.sha256} · {file.size} 字节</p></li>)}</ul></details>
 </div>;
}

export function DevProposalDeliveryControls({ group, readOnly = false }: { group: DevRequirementGroup; readOnly?: boolean }) {
 const source = useDevDataSource();
 if (source.mode !== "prototype" || !source.capabilities.prototypeBusiness) return null;
 if (!source.prototype) return <p className="text-ui-sm text-foreground-subtle">当前数据源尚未接入此功能。</p>;
 const dev = useDev()!;
 const [dialog, setDialog] = useState<DeliveryDialog | null>(null);
 const [scenario, setScenario] = useState<DevPrHandoffScenario>("current");
 const [checkedFiles, setCheckedFiles] = useState<string[]>([]);
 const [acknowledged, setAcknowledged] = useState(false);
 const [url, setUrl] = useState("");
 const delivery = group.proposalDelivery;
 const current = proposalDeliveryCurrent(group);
 const version = proposalVersion(group);
 const pushed = !!delivery && current && delivery.pushedCandidate === delivery.candidate;
 const registered = !!group.requirementsPr && !!delivery && pushed && delivery.prCandidate === delivery.candidate;
 const accepted = group.developerAcceptance;
 const mine = accepted?.round === (group.proposalRound ?? 1) && accepted.employeeId === getEmployeeId();
 const active = !readOnly && (group.proposalStage ?? "requirements") === "solution" && (group.status === "solution-ready" || group.status === "requirements-pr");
 const handoff = source.prototype!.readPrHandoff(group, scenario);
 const boundCurrent = !!dialog && dialog.version === version && (dialog.step === "confirm" || (current && dialog.candidate === delivery?.candidate));
 const allFilesChecked = !!dialog?.files.length && dialog.files.every(file => checkedFiles.includes(file.path));
 const editable = active && mine && !dev.pending && handoff.ready && boundCurrent;
 const canSubmit = editable && !!dialog && (
  dialog.step === "confirm" ? group.status === "solution-ready" && !current && allFilesChecked && acknowledged :
  dialog.step === "push" ? group.status === "solution-ready" && current && !pushed :
  dialog.step === "pr" ? group.status === "solution-ready" && pushed && !registered && /^https?:\/\/[^\s]+$/.test(url.trim()) :
  group.status === "requirements-pr" && registered && allFilesChecked && acknowledged
 );
 const history = (group.proposalDeliveryHistory ?? []).filter(item => item.candidate !== delivery?.candidate);
 const openDialog = () => {
  const step: DeliveryStep = !current ? "confirm" : !pushed ? "push" : !registered ? "pr" : "merge";
  setDialog({ step, version, candidate: current ? delivery?.candidate : undefined, files: (current && delivery ? delivery.files : group.files).map(file => ({ ...file })) });
  setScenario("current");
  setCheckedFiles([]);
  setAcknowledged(false);
  setUrl(registered ? group.requirementsPr?.url ?? "" : "");
 };
 const prTitle = `[需求] ${group.title}`;
 const prBody = dialog ? [
  "## 需求与方案交付（演示）", `IR：${group.id} · ${group.title}`, `候选：${dialog.candidate ?? "尚未人工确认"}`,
  `来源分支：${handoff.branch}`, `目标分支：${handoff.targetBranch}`, "",
  "人工已确认当前 IR、全部 SR 与 design.md；AI 提交与推送仅为内存演示。", "",
  "## 完整文件版本", ...dialog.files.map(file => `- ${file.path} | 样例版本 ${file.sha256} | ${file.size} 字节`), "",
  "请人工创建、评审并合并 PR；默认分支核验须匹配上述候选与全部文件版本。",
  "合并后转为正式需求，保留 changes/，不自动归档，也不表示实现完成。",
 ].join("\n") : "";
 return <section className="space-y-2" data-testid="proposal-delivery-controls">
  <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" data-testid="proposal-delivery-open" disabled={dev.pending} onClick={openDialog}>{readOnly || !active || !mine ? "查看需求交付（演示）" : !current ? "确认需求与方案（演示）" : !pushed ? "AI 提交并推送（演示）" : !registered ? "人工创建需求 PR（演示）" : "核验 PR 合并（演示）"}</Button><span className="text-ui-sm text-foreground-subtle" data-testid="proposal-delivery-status">{registered && group.merge ? "当前候选 PR 已合并并核验（演示），正式需求已入库。" : !current ? delivery || history.length ? "文件版本已变化，旧确认、推送与 PR 不可复用，请重新确认。" : "待人工确认当前 IR、全部 SR 与方案。" : !pushed ? "当前候选已确认，尚未推送。" : !registered ? "当前候选已推送（演示），等待人工创建并登记 PR。" : "当前候选 PR 已登记，等待人工合并与逐文件核验。"}</span></div>
  {delivery && <p className="break-all text-ui-sm text-foreground-subtle" data-testid="proposal-delivery-candidate">{current ? "当前候选" : "旧候选（失效）"}：{delivery.candidate} · 确认人：{delivery.confirmedBy} · {delivery.confirmedAt}</p>}
  {(history.length > 0 || (!!delivery && !current)) && <p className="text-ui-sm text-foreground-subtle" data-testid="proposal-delivery-history-summary">保留 {history.length + (delivery && !current ? 1 : 0)} 份历史交付记录，可在交付弹窗查看。</p>}
  <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}>
   <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>{dialog ? stepTitles[dialog.step] : "需求交付（演示）"}</DialogTitle><DialogDescription>人工确认版本 → AI commit + push 演示 → 人工创建并登记 PR → 核验默认分支。所有状态仅存内存，不调用真实 Git、网络或模型；关闭弹窗不会执行任何步骤。</DialogDescription></DialogHeader>
    {dialog && <form className="space-y-4" onSubmit={async event => {
     event.preventDefault();
     if (!canSubmit) return;
     const target = { projectId: group.projectId, irId: group.id };
     const result = dialog.step === "confirm" ? await dev.command({ type: "confirmProposal", ...target, version: dialog.version }) :
      dialog.step === "push" ? await dev.command({ type: "publishProposal", ...target, candidate: dialog.candidate! }) :
      dialog.step === "pr" ? await dev.command({ type: "markRequirementsPrSubmitted", ...target, candidate: dialog.candidate!, url: url.trim() }) :
      await dev.command({ type: "markRequirementsMerged", ...target, candidate: dialog.candidate!, defaultBranchFilesConfirmed: allFilesChecked && acknowledged });
     if (result?.status === "completed") setDialog(null);
    }}>
     {!active || !mine ? <p className="text-ui-sm text-foreground-subtle" role="status">只读：仅当前方案阶段、当前接手开发人可以操作交付。</p> : null}
     {!boundCurrent && <p className="text-ui-sm text-destructive" role="alert" data-testid="proposal-delivery-stale">弹窗绑定的文件版本或候选已变化，请关闭后重新打开并核对；旧操作不能继续。</p>}
     <DevProposalPrHandoff group={group} scenario={scenario} onScenarioChange={setScenario} />
     {delivery && <DeliveryRecord delivery={delivery} stale={!current} />}
     <div className="space-y-2 rounded-md border border-border p-3" data-testid="proposal-delivery-bound-version"><p className="text-ui-sm font-medium">本次操作绑定下方 {dialog.files.length} 份完整文件版本；材料变化后必须重新确认。</p><p className="break-all text-ui-sm">候选：{dialog.candidate ?? "人工确认成功后生成新的候选"}</p></div>
     <fieldset className="space-y-2" data-testid="proposal-delivery-files"><legend className="text-ui-sm font-medium">{dialog.step === "merge" ? "逐文件核验默认分支中的版本" : dialog.step === "confirm" ? "逐文件确认当前 IR、全部 SR 与 design.md" : "当前候选的完整文件版本"}（{dialog.files.length}）</legend><ul className="max-h-64 space-y-3 overflow-y-auto">{dialog.files.map(file => <li key={file.path} className="rounded-md border border-border p-2 text-ui-sm" data-testid="proposal-delivery-file"><label className="flex items-start gap-2">{(dialog.step === "confirm" || dialog.step === "merge") && <Checkbox data-testid="proposal-delivery-file-check" aria-label={`${dialog.step === "merge" ? "核验默认分支" : "确认"} ${file.path} ${file.sha256}`} checked={checkedFiles.includes(file.path)} disabled={!editable} onCheckedChange={checked => setCheckedFiles(previous => checked === true ? [...previous.filter(path => path !== file.path), file.path] : previous.filter(path => path !== file.path))} />}<span className="min-w-0 space-y-1"><span className="block break-all font-mono">{file.path}</span><span className="block break-all text-foreground-subtle">样例版本：{file.sha256} · {file.size} 字节</span></span></label></li>)}</ul></fieldset>
     {dialog.step === "confirm" && <label className="flex items-start gap-2 text-ui-sm"><Checkbox data-testid="proposal-delivery-confirm-all" checked={acknowledged} disabled={!editable} onCheckedChange={checked => setAcknowledged(checked === true)} />我已逐项确认上述当前 IR、全部 SR 与 design.md 的内容和版本；后续重新生成或修改文件必须重新确认。</label>}
     {dialog.step === "push" && <p className="text-ui-sm text-foreground-subtle">AI 将按上方已确认候选演示 commit + push 到需求分支；不修改默认分支、不真实复制或提交文件，也不自动创建 PR。</p>}
     {(dialog.step === "pr" || dialog.step === "merge") && <section className="space-y-3 rounded-md border border-border p-3" data-testid="proposal-delivery-pr-template"><p className="text-ui-sm text-foreground-subtle">请在代码平台手动创建 PR，使用下方标题和正文；本页不创建 PR。演示时只登记示例链接，登记不代表平台已验证。</p><div className="space-y-1"><Label htmlFor="proposal-pr-title">PR 标题</Label><Input id="proposal-pr-title" data-testid="proposal-pr-title" value={prTitle} readOnly /></div><div className="space-y-1"><Label htmlFor="proposal-pr-body">PR 正文与文件版本清单</Label><SettingsFormTextarea id="proposal-pr-body" data-testid="proposal-pr-body" value={prBody} readOnly rows={8} /></div></section>}
     {dialog.step === "pr" && <div className="space-y-2"><Label htmlFor="proposal-pr-url">人工创建的 PR 地址（演示登记）</Label><Input id="proposal-pr-url" data-testid="proposal-pr-url" type="url" value={url} disabled={!editable || !pushed} onChange={event => setUrl(event.target.value)} placeholder="https://git.example.com/project/pulls/123" required /></div>}
     {group.requirementsPr && <p className="break-all text-ui-sm text-foreground-subtle" data-testid="proposal-delivery-registered-pr">{registered ? "当前候选 PR" : "历史 PR，不可复用于当前候选"}：{group.requirementsPr.url} · {group.requirementsPr.recordedAt} · 仅演示记录，未查询平台</p>}
     {dialog.step === "merge" && <label className="flex items-start gap-2 text-ui-sm"><Checkbox data-testid="proposal-delivery-merge-confirm" checked={acknowledged} disabled={!editable || !registered} onCheckedChange={checked => setAcknowledged(checked === true)} />演示核验：已登记 PR 已合并到 {handoff.targetBranch}，默认分支逐项匹配候选 {dialog.candidate} 的上述完整文件版本；转正不表示实现完成，保留 changes/，不归档。</label>}
     {history.length > 0 && <details className="space-y-2" data-testid="proposal-delivery-history"><summary className="cursor-pointer text-ui-sm text-foreground-subtle">历史交付记录（{history.length}，不可放行当前版本）</summary><div className="space-y-3">{history.map(item => <div key={item.candidate} className="rounded-md border border-border p-3"><DeliveryRecord delivery={item} stale /></div>)}</div></details>}
     {dev.error && <p role="alert" className="text-ui-sm text-destructive">{dev.error}</p>}
     <DialogFooter><Button type="button" variant="outline" onClick={() => setDialog(null)}>关闭</Button><Button type="submit" data-testid={`proposal-delivery-${dialog.step}`} disabled={!canSubmit}>{dialog.step === "confirm" ? "确认此版本（演示）" : dialog.step === "push" ? "AI commit + push（演示）" : dialog.step === "pr" ? "登记当前候选 PR（演示）" : "核验合并并转为正式需求（演示）"}</Button></DialogFooter>
    </form>}
   </DialogContent>
  </Dialog>
 </section>;
}
