import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { useAIReqDataSource } from "./data-source.js";
import { useAIReq } from "./AIReqContext.js";
import { AIReqProposalPrHandoff } from "./AIReqProposalPrHandoff.js";
import { hasCurrentProposalSolution, proposalDeliveryCurrent, proposalVersion, requirementMaterialName } from "./domain.js";
import type { AIReqFileVersion, AIReqPrHandoff, AIReqPrHandoffScenario, AIReqProposalMergeScenario, AIReqRequirementGroup } from "./types.js";

type DeliveryStep = "confirm" | "push" | "pr";
interface DeliveryDialog { step: DeliveryStep; version: string; candidate?: string; files: AIReqFileVersion[] }
const stepTitles: Record<DeliveryStep, string> = {
 confirm: "确认需求与方案并提交推送",
 push: "创建提案分支并提交推送",
 pr: "人工 PR 与后台合入检查",
};
const mergeScenarios: { id: AIReqProposalMergeScenario; title: string }[] = [
 { id: "unmerged", title: "提案分支尚未合入" },
 { id: "merged", title: "提案分支已合入，文档完整" },
 { id: "incomplete", title: "提案分支已合入，文档不完整" },
 { id: "failed", title: "获取默认分支失败" },
];

export function AIReqProposalBackgroundStatus({ group, readOnly = false }: { group: AIReqRequirementGroup; readOnly?: boolean }) {
 const source = useAIReqDataSource();
 const delivery = group.proposalDelivery;
 const [scenarioPending, setScenarioPending] = useState(false);
 const [scenarioError, setScenarioError] = useState<string | null>(null);
 const mutation = useRef({ generation: 0, pending: false });
 useEffect(() => {
  mutation.current.pending = false;
  setScenarioPending(false);
  setScenarioError(null);
  return () => { mutation.current.generation++; };
 }, [source.prototype, group.projectId, group.id]);
 const changeScenario = async (value: string) => {
  if (!source.prototype || readOnly || !source.capabilities.proposalDiscussion || mutation.current.pending) return;
  const generation = mutation.current.generation;
  mutation.current.pending = true;
  setScenarioPending(true);
  setScenarioError(null);
  try {
   await source.prototype.setProposalMergeScenario(group.projectId, group.id, value as AIReqProposalMergeScenario);
  } catch (error) {
   if (generation === mutation.current.generation) setScenarioError(error instanceof Error ? error.message : String(error));
  } finally {
   if (generation === mutation.current.generation) {
    mutation.current.pending = false;
    setScenarioPending(false);
   }
  }
 };
 if (!delivery?.pushedAt) return <p className="text-ui-sm leading-6 text-foreground-subtle">先完成方案设计并确认文档，再由平台创建提案独立分支、提交推送；此前不创建提案或 SR 分支。</p>;
 const check = delivery.mergeCheck;
 const editable = !readOnly && source.capabilities.proposalDiscussion === true;
 const time = (value?: string) => value ? new Date(value).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "等待首轮检查";
 return <section className="space-y-4" data-testid="proposal-background-status">
  <div className="space-y-2 rounded-lg border border-border p-4">
   <h3 className="text-ui-base font-medium">后台自动检查合入状态</h3>
   <p className="text-ui-sm leading-6" role="status" data-testid="proposal-background-result">{check?.message ?? "等待后台检查提案分支与默认分支。"}</p>
   <dl className="space-y-2 text-ui-sm"><div><dt className="text-foreground-subtle">已创建并推送的提案分支</dt><dd className="break-all font-mono">{delivery.branch?.name ?? `ir/${group.id}`}</dd></div><div><dt className="text-foreground-subtle">创建基点</dt><dd className="break-all font-mono">{delivery.branch?.baseCommit ?? "基点未记录"}</dd></div><div><dt className="text-foreground-subtle">最近检查／下一轮检查</dt><dd>{time(check?.checkedAt)}{check?.nextCheckAt ? ` ／ ${time(check.nextCheckAt)}` : ""}</dd></div></dl>
   <p className="text-ui-sm leading-6 text-foreground-subtle">人工在企业 Git 平台创建、评审并合并 PR。平台不使用 PR API；只要提案分支已合入默认分支且 IR、全部 SR、方案文档完整，后台自动转为正式需求，再创建并推送各 SR 分支。</p>
   <p className="text-ui-sm text-foreground-subtle">不要求登记 PR 地址，也无需人工通知或点击“确认合并”。</p>
  </div>
  {source.prototype && <details className="space-y-2 rounded-lg border border-border p-4"><summary className="cursor-pointer text-ui-sm text-foreground-subtle">原型后台结果演示</summary><div className="mt-3 space-y-2"><Label htmlFor={`merge-scenario-${group.id}`}>预置 Git 检查结果</Label><Select value={delivery.mergeScenario ?? "unmerged"} disabled={!editable || scenarioPending} onValueChange={changeScenario}><SelectTrigger id={`merge-scenario-${group.id}`} aria-label="预置 Git 检查结果"><SelectValue /></SelectTrigger><SelectContent>{mergeScenarios.map(item => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select>{scenarioPending && <p role="status" className="text-ui-sm text-foreground-subtle">正在更新后台检查场景…</p>}{scenarioError && <p role="alert" className="text-ui-sm text-destructive">{scenarioError}</p>}<p className="text-ui-xs leading-5 text-foreground-subtle">仅改变预置远端场景，下一轮演示时钟自动检查。本页每 5 秒读取内存样例，不访问真实 Git、PR API、模型或数据库；刷新／关页后演示停止。真实后台应独立于浏览器持续运行。</p></div></details>}
 </section>;
}

export function AIReqProposalDeliveryControls({ group, readOnly = false, compact = false }: { group: AIReqRequirementGroup; readOnly?: boolean; compact?: boolean }) {
 const source = useAIReqDataSource();
 const aireq = useAIReq()!;
 const [dialog, setDialog] = useState<DeliveryDialog | null>(null);
 const [scenario, setScenario] = useState<AIReqPrHandoffScenario>("current");
 const [checkedFiles, setCheckedFiles] = useState<string[]>([]);
 const [acknowledged, setAcknowledged] = useState(false);
 const [url, setUrl] = useState("");
 const prototype = source.prototype;
 const [handoffResult, setHandoffResult] = useState<{
  prototype: typeof prototype;
  group: AIReqRequirementGroup;
  scenario: AIReqPrHandoffScenario;
  handoff?: AIReqPrHandoff;
  launchHandoff?: AIReqPrHandoff;
  error?: string;
 } | null>(null);
 useEffect(() => {
  let active = true;
  setHandoffResult(null);
  if (!source.capabilities.requirementManagement) return;
  const load = async () => {
   try {
    const [handoff, launchHandoff] = await Promise.all([
     scenario !== "current" && prototype ? prototype.readPrHandoff(group, scenario) : source.readPrHandoff(group),
     scenario === "current" ? undefined : source.readPrHandoff(group),
    ]);
    if (active) setHandoffResult({ prototype, group, scenario, handoff, launchHandoff: launchHandoff ?? handoff });
   } catch (error) {
    if (active) setHandoffResult({ prototype, group, scenario, error: error instanceof Error ? error.message : String(error) });
   }
  };
  void load();
  return () => { active = false; };
 }, [source, prototype, group, scenario]);
 if (!source.capabilities.requirementManagement) return null;
 const delivery = group.proposalDelivery;
 const current = proposalDeliveryCurrent(group);
 const version = proposalVersion(group);
 const pushed = !!delivery && current && delivery.pushedCandidate === delivery.candidate;
 const mine = source.capabilities.proposalDiscussion === true;
 const ready = hasCurrentProposalSolution(group) && ["solution-ready", "requirements-pr"].includes(group.status);
 const result = handoffResult?.prototype === prototype && handoffResult?.group === group && handoffResult?.scenario === scenario ? handoffResult : null;
 const handoff = result?.handoff;
 const launchHandoff = result?.launchHandoff;
 const handoffLoading = !result;
 const boundCurrent = !!dialog && dialog.version === version && (dialog.step === "confirm" || (current && dialog.candidate === delivery?.candidate));
 const allFilesChecked = !!dialog?.files.length && dialog.files.every(file => checkedFiles.includes(file.path));
 const editable = !readOnly && ready && mine && !aireq.pending && handoff?.ready === true && boundCurrent;
 const canSubmit = editable && !!dialog && (dialog.step === "confirm" ? !current && allFilesChecked && acknowledged : dialog.step === "push" ? current && !pushed : pushed && /^https?:\/\/[^\s]+$/.test(url.trim()));
 const openDialog = () => {
  const step: DeliveryStep = pushed ? "pr" : current ? "push" : "confirm";
  setDialog({ step, version, candidate: current ? delivery?.candidate : undefined, files: structuredClone(current && delivery ? delivery.files : group.files) });
  setScenario("current"); setCheckedFiles([]); setAcknowledged(false); setUrl(group.requirementsPr?.url ?? "");
 };
 const prTitle = `[需求] ${group.title}`;
 const prBody = dialog && handoff ? ["## 需求与方案", `IR：${group.id} · ${group.title}`, `候选：${dialog.candidate ?? "待确认"}`, `来源分支：${handoff.branch}`, `目标分支：${handoff.targetBranch}`, "", "## 文档清单", ...dialog.files.map(file => `- ${file.path}`), "", "请人工创建、评审和合并 PR。平台根据 Git 合入事实及文档完整性自动入库，不需要 PR API 或人工确认合并。", "入库只表示需求已批准，不表示代码已完成；平台随后创建各 SR 开发分支。"].join("\n") : "";
 return <section className="space-y-2" data-testid="proposal-delivery-controls">
  <Button size="sm" variant={compact ? "default" : "outline"} data-testid="proposal-delivery-open" disabled={aireq.pending || handoffLoading || !!result?.error || (!pushed && (!mine || !ready || !launchHandoff?.ready))} title={!ready ? "请先完成当前需求的方案设计。" : !launchHandoff?.ready ? launchHandoff?.blockers.join("；") : undefined} onClick={openDialog}>{pushed ? "查看 PR 信息与后台检查" : !ready ? "等待方案完成" : !current ? "确认方案并提交推送" : "创建提案分支并提交推送"}</Button>
  {handoffLoading && <p role="status" className="text-ui-sm text-foreground-subtle">正在读取提案交付信息…</p>}
  {result?.error && <p role="alert" className="text-ui-sm text-destructive">{result.error}</p>}
  {!compact && <p className="text-ui-sm text-foreground-subtle">{pushed ? "提案分支已推送，人工创建 PR；后台正在自动检查，无需登记链接。" : "方案完成并人工确认当前文档后，平台才创建提案分支；无需个人开发目录。"}</p>}
  <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
   <DialogHeader><DialogTitle>{dialog ? stepTitles[dialog.step] : "需求交付"}</DialogTitle><DialogDescription>方案完成后创建分支并提交推送 → 人工创建、评审和合并 PR → 后台自动核验并入库。</DialogDescription></DialogHeader>
   {dialog && <form className="space-y-4" onSubmit={async event => {
    event.preventDefault(); if (!canSubmit) return;
    const target = { projectId: group.projectId, irId: group.id };
    if (dialog.step === "confirm") {
     const confirmed = await aireq.command({ type: "confirmProposal", ...target, version: dialog.version });
     if (confirmed?.status !== "completed") return;
     const candidate = confirmed.view?.drafts.find(item => item.projectId === group.projectId && item.id === group.id)?.proposalDelivery?.candidate;
     if (!candidate) return;
     setDialog({ ...dialog, step: "push", candidate });
     const pushedResult = await aireq.command({ type: "publishProposal", ...target, candidate });
     if (pushedResult?.status === "completed") setDialog(null);
    } else {
     const result = dialog.step === "push" ? await aireq.command({ type: "publishProposal", ...target, candidate: dialog.candidate! }) : await aireq.command({ type: "markRequirementsPrSubmitted", ...target, candidate: dialog.candidate!, url: url.trim() });
     if (result?.status === "completed") setDialog(null);
    }
   }}>
    {!boundCurrent && <p role="alert" className="text-ui-sm text-destructive">需求或方案版本已变化，请关闭后重新确认当前文档。</p>}
    {handoffLoading && <p role="status" className="text-ui-sm text-foreground-subtle">正在读取提案交付信息…</p>}
    {result?.error && <p role="alert" className="text-ui-sm text-destructive">{result.error}</p>}
    {dialog.step !== "pr" ? <>
     <AIReqProposalPrHandoff group={group} scenario={scenario} onScenarioChange={setScenario} />
     <fieldset className="space-y-2"><legend className="text-ui-sm font-medium">确认业务需求、全部 SR、技术方案与 SR 依赖</legend><ul className="max-h-64 space-y-2 overflow-auto">{dialog.files.map(file => <li key={file.path}><label className="flex items-start gap-2 text-ui-sm">{dialog.step === "confirm" && <Checkbox data-testid="proposal-delivery-file-check" aria-label={`确认 ${file.path}`} checked={checkedFiles.includes(file.path)} disabled={!editable} onCheckedChange={checked => setCheckedFiles(previous => checked === true ? [...previous.filter(path => path !== file.path), file.path] : previous.filter(path => path !== file.path))} />}<span className="min-w-0"><span className="block">{requirementMaterialName(file.path, aireq.view?.srs) ?? "需求材料"}</span><span className="block break-all font-mono text-ui-xs text-foreground-subtle">{file.path}</span></span></label></li>)}</ul></fieldset>
     {dialog.step === "confirm" && <label className="flex items-start gap-2 text-ui-sm"><Checkbox data-testid="proposal-delivery-confirm-all" checked={acknowledged} disabled={!editable} onCheckedChange={checked => setAcknowledged(checked === true)} />我已确认当前需求与方案，可以创建提案分支并提交推送。</label>}
    </> : <>
     <div className="space-y-2"><Label htmlFor="proposal-pr-title">PR 标题</Label><Input id="proposal-pr-title" data-testid="proposal-pr-title" value={prTitle} readOnly /></div>
     <div className="space-y-2"><Label htmlFor="proposal-pr-body">PR 正文</Label><SettingsFormTextarea id="proposal-pr-body" data-testid="proposal-pr-body" value={prBody} readOnly rows={8} /></div>
     <p className="text-ui-sm text-foreground-subtle">请在企业 Git 网页手动创建、评审和合并 PR；平台不自动创建 PR。</p>
     <div className="space-y-2"><Label htmlFor="proposal-pr-url">PR 地址（选填，仅作参考）</Label><Input id="proposal-pr-url" data-testid="proposal-pr-url" type="url" value={url} disabled={!editable} onChange={event => setUrl(event.target.value)} placeholder="可不填写，不影响后台自动检查" /></div>
     <AIReqProposalBackgroundStatus group={group} readOnly={readOnly} />
    </>}
    {aireq.error && <p role="alert" className="text-ui-sm text-destructive">{aireq.error}</p>}
    <DialogFooter><Button type="button" variant="outline" onClick={() => setDialog(null)}>关闭</Button>{!readOnly && <Button type="submit" data-testid={`proposal-delivery-${dialog.step}`} disabled={!canSubmit}>{dialog.step === "confirm" ? "确认并创建分支、提交推送" : dialog.step === "push" ? "创建分支并提交推送" : "保存 PR 地址（选填）"}</Button>}</DialogFooter>
   </form>}
  </DialogContent></Dialog>
 </section>;
}
