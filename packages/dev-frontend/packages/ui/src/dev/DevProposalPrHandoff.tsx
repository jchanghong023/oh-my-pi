import { Label } from "@/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { readPrototypeProposalPrHandoff, type PrototypePrHandoffScenario } from "./mock/proposal-pr-handoff.js";
import type { DevRequirementGroup } from "./mock/types.js";

const scenarios: { id: PrototypePrHandoffScenario; title: string }[] = [
 { id: "current", title: "当前交接" },
 { id: "missing-directory", title: "未配置个人开发目录" },
 { id: "wrong-repository", title: "目标仓库不匹配" },
 { id: "change-conflict", title: "同名 change 冲突" },
 { id: "stale-version", title: "方案对应旧需求版本" },
];

export function DevProposalPrHandoff({ group, scenario, onScenarioChange }: {
 group: DevRequirementGroup;
 scenario: PrototypePrHandoffScenario;
 onScenarioChange: (scenario: PrototypePrHandoffScenario) => void;
}) {
 const handoff = readPrototypeProposalPrHandoff(group, scenario);
 return <section className="space-y-3 rounded-md border border-border p-3" data-testid="proposal-pr-handoff" aria-label="需求 PR 文件交接">
  <div className="space-y-1"><h3 className="text-ui-base font-medium">需求 PR 文件交接</h3><p className="text-ui-sm text-foreground-subtle">临时工作区 → 我的开发项目需求分支 → 需求 PR → 默认分支核对。当前仅展示交接计划，不复制文件、不执行 Git。</p></div>
  <dl className="space-y-2 text-ui-sm">
   <div><dt className="text-foreground-subtle">来源 · 提案固定临时工作区</dt><dd className="mt-0.5 break-all font-mono" data-testid="proposal-pr-source">{handoff.sourceDirectory || "来源未确定"}</dd></div>
   <div><dt className="text-foreground-subtle">目标 · 工号 {handoff.employeeId} 的开发项目</dt><dd className="mt-0.5 break-all font-mono" data-testid="proposal-pr-target">{handoff.targetDirectory ?? "尚未配置"}</dd></div>
   <div className="grid grid-cols-2 gap-3"><div><dt className="text-foreground-subtle">计划使用的需求分支</dt><dd className="mt-0.5 break-all font-mono" data-testid="proposal-pr-source-branch">{handoff.branch}</dd></div><div><dt className="text-foreground-subtle">PR 目标分支</dt><dd className="mt-0.5 break-all font-mono">{handoff.targetBranch}</dd></div></div>
  </dl>
  <details className="text-ui-sm" data-testid="proposal-pr-file-list"><summary className="cursor-pointer text-foreground-subtle">同一 change 的 {handoff.files.length} 份文件与版本</summary><ul className="mt-2 max-h-48 space-y-3 overflow-auto">{handoff.files.map(file => <li key={file.path} className="space-y-1"><p className="break-all font-mono">{file.path}</p><p className="break-all text-foreground-subtle">{file.version}</p><p className="break-all text-foreground-subtle">目标：{file.targetPath}</p><p className="break-all text-foreground-subtlest" title={file.digest}>版本依据：{file.digest}</p></li>)}</ul></details>
  <div className="space-y-1"><Label htmlFor="proposal-handoff-scenario">异常情景预览（仅原型）</Label><Select value={scenario} onValueChange={value => onScenarioChange(value as PrototypePrHandoffScenario)}><SelectTrigger id="proposal-handoff-scenario" data-testid="proposal-pr-scenario" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{scenarios.map(item => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select></div>
  {handoff.ready ? <p className="text-ui-sm text-foreground-subtle" data-testid="proposal-pr-handoff-ready">演示资料可交接；真实提交前仍需服务端检查仓库、同名 change 与文件版本。</p> : <ul className="space-y-1 text-ui-sm text-destructive" role="status" data-testid="proposal-pr-handoff-blockers">{handoff.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>}
  <p className="text-ui-sm text-foreground-subtle">同名冲突不能直接覆盖，旧方案不能提交。合并核对后转为正式需求，change 继续保留在 changes/，不自动归档。</p>
 </section>;
}
