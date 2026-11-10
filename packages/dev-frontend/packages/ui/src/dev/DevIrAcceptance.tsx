import { DevIrFinalPrControls } from "./DevIrFinalPrControls.js";
import { ArrowLeft, Check, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useDev } from "./DevContext.js";
import { DevAgentModelSummary } from "./DevAgentModelSummary.js";
import { IR_ACCEPTANCE_LABELS, irAcceptanceBlocker, irAcceptanceVersionBlocker, irAcceptanceReportBlocker } from "./mock/ir-acceptance.js";
import { getPrototypeEmployeeId } from "./mock/employee.js";
import { readPrototypeDevelopmentRoot } from "./mock/project-settings.js";
import type { DevRequirementGroup } from "./mock/types.js";

export function DevIrAcceptanceEntry({ group, compact = false, onNavigate }: { group: DevRequirementGroup; compact?: boolean; onNavigate?: () => void }) {
  const dev = useDev()!;
  const blocker = dev.view ? irAcceptanceBlocker(dev.view, group) : "正在读取 SR 状态。";
  const title = group.acceptance ? `IR 验收 · ${dev.view && irAcceptanceVersionBlocker(dev.view, group) ? "待重新验收" : IR_ACCEPTANCE_LABELS[group.acceptance.status]}` : blocker ?? "全部 SR 已合并，可进入 IR 整体验收。";
  return <span title={title} className="inline-flex shrink-0">
    <Button variant={compact ? "ghost" : "outline"} size={compact ? "icon-sm" : "sm"} disabled={!group.acceptance && !!blocker}
      data-testid={`ir-acceptance-entry-${group.id}`} aria-label={`${group.title}：IR 验收`} aria-pressed={dev.selection.irId === group.id && !!dev.selection.irAcceptance}
      onClick={() => { dev.select({ projectId: group.projectId, irId: group.id, irAcceptance: true }); onNavigate?.(); }}>
      <ClipboardCheck className="size-3.5" />{!compact && (group.acceptance ? "查看 IR 验收" : "IR 验收")}
    </Button>
  </span>;
}

export function DevIrAcceptanceHeader({ group }: { group: DevRequirementGroup }) {
  const dev = useDev()!;
  const acceptance = group.acceptance;
  const blocker = irAcceptanceBlocker(dev.view!, group);
  const versionIssue = irAcceptanceVersionBlocker(dev.view!, group);
  const reportIssue = irAcceptanceReportBlocker(dev.view!, group);
  const owns = acceptance?.employeeId === getPrototypeEmployeeId();
  const phase = acceptance?.status === "completed" ? 2 : acceptance?.status === "pr-ready" || acceptance?.status === "pr-submitted" ? 1 : 0;
  const ready = acceptance?.status === "passed" && !reportIssue;
  return <header className="space-y-3 border-b border-border bg-background px-4 py-3" data-testid="ir-acceptance-header" data-status={acceptance?.status ?? "ready"} data-stale={Boolean(versionIssue)}>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="icon-sm" aria-label="返回 IR 需求讨论" onClick={() => dev.select({ projectId: group.projectId, irId: group.id })}><ArrowLeft className="size-4" /></Button>
      <span className="rounded-sm border border-border px-1 font-mono text-ui-xs text-foreground-subtle">IR</span>
      <strong className="min-w-0 flex-1 text-ui-base">{group.title}</strong>
      <span className="text-ui-sm text-foreground-subtle">{versionIssue ? "待重新验收" : acceptance ? IR_ACCEPTANCE_LABELS[acceptance.status] : "待开始验收"}</span>
    </div>
    <nav aria-label="IR 收尾阶段" className="flex flex-wrap gap-1">
      {["整体验收", "最终 PR", "完成"].map((title, index) => <span key={title} aria-current={index === phase ? "step" : undefined} className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-ui-sm ${index === phase ? "bg-selected font-medium text-foreground" : "text-foreground-subtle"}`}>{index < phase ? <Check className="size-3.5" /> : <span>{index + 1}</span>}{title}</span>)}
    </nav>
    <DevAgentModelSummary binding={acceptance?.session.modelConfig} />
    {acceptance && <p className="text-ui-sm text-foreground-subtle">验收开发人：{acceptance.employeeId} · 候选：{acceptance.candidate}{!owns ? " · 当前仅查看" : ""}</p>}
    <div className="flex flex-wrap gap-2">
      {!acceptance && <Button size="sm" data-testid="ir-acceptance-start" disabled={!!blocker || !readPrototypeDevelopmentRoot(group.projectId)} onClick={() => void dev.command({ type: "startIrAcceptance" })}>开始 IR 验收（演示）</Button>}
      {owns && !versionIssue && acceptance?.status === "reviewing" && <>
        <Button size="sm" data-testid="ir-acceptance-find-issues" onClick={() => void dev.command({ type: "generateIrAcceptanceReport", outcome: "issues" })}>生成验收报告（演示）</Button>
        <Button size="sm" variant="outline" data-testid="ir-acceptance-pass" onClick={() => void dev.command({ type: "generateIrAcceptanceReport", outcome: "passed" })}>{acceptance.hasFixes ? "复验通过（演示）" : "演示无需修复通过"}</Button>
      </>}
      {owns && !versionIssue && acceptance?.status === "issues" && <Button size="sm" data-testid="ir-acceptance-repair" onClick={() => void dev.command({ type: "repairIrAcceptance" })}>修复并复验（演示）</Button>}
      {owns && !versionIssue && acceptance?.status === "passed" && <Button size="sm" data-testid="ir-final-pr-prepare" disabled={!ready} onClick={() => void dev.command({ type: "prepareIrFinalPr" })}>确认验收，准备最终 PR（演示）</Button>}
    </div>
    {versionIssue && <div className="space-y-2" data-testid="ir-acceptance-stale"><p role="status" className="text-ui-sm text-foreground-subtle">{versionIssue}</p>{owns && <Button size="sm" data-testid="ir-acceptance-restart" onClick={() => void dev.command({ type: "restartIrAcceptance" })}>重新对齐并验收（演示）</Button>}</div>}
    {!versionIssue && reportIssue && acceptance?.status === "passed" && <div className="space-y-2"><p className="text-ui-sm text-foreground-subtle">{reportIssue}</p>{owns && <Button size="sm" onClick={() => void dev.command({ type: "restartIrAcceptance" })}>重新验收（演示）</Button>}</div>}
    {!acceptance && <p role="status" className="text-ui-sm text-foreground-subtle">{blocker ?? (!readPrototypeDevelopmentRoot(group.projectId) ? "请先在设置中添加我的开发项目。" : "全部 SR 已合并核验（样例）；明确开始后创建独立 IR 验收会话及修复／归档工作区。")}</p>}
    {acceptance?.status === "issues" && <p role="status" className="text-ui-sm text-foreground-subtle">发现需求范围内的实现问题，请修复并重新整体验收；业务或方案变化须暂停并重新提案。</p>}
    {owns && acceptance && ["pr-ready", "pr-submitted"].includes(acceptance.status) && <DevIrFinalPrControls key={`${group.id}:${acceptance.candidate}`} group={group} />}
    {acceptance?.status === "completed" && <p role="status" className="text-ui-sm text-foreground-subtle">最终 PR 已合并并核验（样例），IR 已完成，仓库占用已释放。验收历史只读，未删除 worktree 或分支。</p>}
    {acceptance && acceptance.status !== "completed" && owns && <details className="text-ui-xs text-foreground-subtle"><summary className="cursor-pointer">演示异常场景</summary><Button size="sm" variant="ghost" data-testid="ir-acceptance-default-update" onClick={() => void dev.command({ type: "simulateIrDefaultBranchUpdate" })}>默认分支变化（演示）</Button></details>}
    {Boolean(acceptance?.history?.length) && <details className="text-ui-xs text-foreground-subtle"><summary className="cursor-pointer">历史验收（{acceptance!.history!.length}）</summary><ul className="mt-2 space-y-1 break-all">{acceptance!.history!.map((item, index) => <li key={`${item.candidate}:${index}`}>{item.candidate} · {item.baseCommit} · {item.status} · 仅供历史查看</li>)}</ul></details>}
    {acceptance && <details className="text-ui-sm text-foreground-subtle"><summary className="cursor-pointer">工作区与验收基点</summary><p className="mt-2 break-all">{acceptance.worktree.path}</p><p>分支：{acceptance.worktree.branch} · 基点：{acceptance.baseCommit}</p></details>}
    <p className="text-ui-xs text-foreground-subtle">原型演示：报告、修复与合并核验均为静态样例，不执行模型、测试、Git 或归档。合并前默认分支变化须重新核对影响并补验。</p>
    {dev.error && <p role="alert" className="text-ui-sm text-destructive">{dev.error}</p>}
  </header>;
}

export function DevIrAcceptanceWelcome() {
  return <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center" data-testid="ir-acceptance-welcome"><ClipboardCheck className="size-8 text-foreground-subtle" /><h2 className="text-ui-base font-medium">全部 SR 合并后，验收整个 IR</h2><p className="max-w-md text-ui-sm leading-6 text-foreground-subtle">从顶部明确开始验收，复用原聊天框讨论跨 SR 行为和实现问题。右侧可查看整组需求及方案，报告生成后自动展示。</p></div>;
}
