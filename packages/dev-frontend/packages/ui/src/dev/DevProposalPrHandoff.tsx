import { useEffect, useState } from "react";
import { useDevDataSource } from "./data-source.js";
import type { DevPrHandoff, DevPrHandoffScenario } from "./types.js";
import { Label } from "@/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import type { DevRequirementGroup } from "./types.js";

const scenarios: { id: DevPrHandoffScenario; title: string }[] = [
 { id: "current", title: "当前交接" },
 { id: "wrong-repository", title: "目标仓库不匹配" },
 { id: "change-conflict", title: "同名 change 冲突" },
 { id: "stale-version", title: "方案对应旧需求版本" },
];

export function DevProposalPrHandoff({ group, scenario, onScenarioChange }: {
 group: DevRequirementGroup;
 scenario: DevPrHandoffScenario;
 onScenarioChange: (scenario: DevPrHandoffScenario) => void;
}) {
 const source = useDevDataSource();
 const prototype = source.capabilities.requirementManagement ? source.prototype : undefined;
 const [result, setResult] = useState<{
  prototype: typeof prototype;
  group: DevRequirementGroup;
  scenario: DevPrHandoffScenario;
  handoff?: DevPrHandoff;
  error?: string;
 }>();
 useEffect(() => {
  let active = true;
  setResult(undefined);
  void (async () => {
   try {
    const handoff = await (scenario !== "current" && prototype ? prototype.readPrHandoff(group, scenario) : source.readPrHandoff(group));
    if (active) setResult({ prototype, group, scenario, handoff });
   } catch (error) {
    if (active) setResult({ prototype, group, scenario, error: error instanceof Error ? error.message : String(error) });
   }
  })();
  return () => { active = false; };
 }, [source, prototype, group, scenario]);
 if (!source.capabilities.requirementManagement) return null;
 const currentResult = result && result.prototype === prototype && result.group === group && result.scenario === scenario ? result : undefined;
 const handoff = currentResult?.handoff;
 return <section className="space-y-3 rounded-md border border-border p-3" data-testid="proposal-pr-handoff" aria-label="需求 PR 文件交接">
  <div className="space-y-1"><h3 className="text-ui-base font-medium">需求 PR 文件交接</h3><p className="text-ui-sm text-foreground-subtle">方案完成 → 平台创建提案分支并提交推送 → 人工创建、评审、合并 PR → 后台自动核验。</p></div>
  {!currentResult && <p role="status" className="text-ui-sm text-foreground-subtle">正在加载需求 PR 文件交接…</p>}
  {currentResult?.error !== undefined && <p role="alert" className="text-ui-sm text-destructive">加载需求 PR 文件交接失败：{currentResult.error}</p>}
  {handoff && <><dl className="space-y-2 text-ui-sm">
   <div><dt className="text-foreground-subtle">来源 · 提案固定临时工作区</dt><dd className="mt-0.5 break-all font-mono" data-testid="proposal-pr-source">{handoff.sourceDirectory || "来源未确定"}</dd></div>
   <div><dt className="text-foreground-subtle">目标 · 平台托管 Git 仓库</dt><dd className="mt-0.5 break-all font-mono" data-testid="proposal-pr-target">{handoff.repositoryUrl ?? "尚未配置"}</dd></div>
   <div className="grid grid-cols-2 gap-3"><div><dt className="text-foreground-subtle">提案分支（提交推送时创建）</dt><dd className="mt-0.5 break-all font-mono" data-testid="proposal-pr-source-branch">{handoff.branch}</dd></div><div><dt className="text-foreground-subtle">PR 目标分支</dt><dd className="mt-0.5 break-all font-mono">{handoff.targetBranch}</dd></div></div>
  </dl>
  <details className="text-ui-sm" data-testid="proposal-pr-file-list"><summary className="cursor-pointer text-foreground-subtle">同一 change 的 {handoff.files.length} 份文件与版本</summary><ul className="mt-2 max-h-48 space-y-3 overflow-auto">{handoff.files.map(file => <li key={file.path} className="space-y-1"><p className="break-all font-mono">{file.path}</p><p className="break-all text-foreground-subtle">{file.version}</p><p className="break-all text-foreground-subtle">目标：{file.targetPath}</p><p className="break-all text-foreground-subtlest" title={file.digest}>版本依据：{file.digest}</p></li>)}</ul></details></>}
  {prototype && <div className="space-y-1"><Label htmlFor="proposal-handoff-scenario">异常情景预览（仅原型）</Label><Select value={scenario} onValueChange={value => onScenarioChange(value as DevPrHandoffScenario)}><SelectTrigger id="proposal-handoff-scenario" data-testid="proposal-pr-scenario" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{scenarios.map(item => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select></div>}
  {handoff && (handoff.ready ? <p className="text-ui-sm text-foreground-subtle" data-testid="proposal-pr-handoff-ready">需求与方案已就绪；平台从最新默认分支创建提案分支并提交推送，无需个人开发目录。</p> : <ul className="space-y-1 text-ui-sm text-destructive" role="status" data-testid="proposal-pr-handoff-blockers">{handoff.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>)}
  <p className="text-ui-sm text-foreground-subtle">同名冲突不能直接覆盖，旧方案不能提交。提案分支合入默认分支且文档完整后，后台自动转为正式需求并创建各 SR 分支；不要求登记 PR 链接或人工确认合并。</p>
 </section>;
}
