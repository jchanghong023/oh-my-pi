import { AIReqMarkdownDocument } from "./AIReqMarkdownDocument.js";
import { useAIReqDataSource } from "./data-source.js";
import { AIReqIrFinalPrControls } from "./AIReqIrFinalPrControls.js";
import { ArrowLeft, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useAIReq } from "./AIReqContext.js";
import { AIReqAgentModelSummary } from "./AIReqAgentModelSummary.js";
import { IR_ACCEPTANCE_LABELS, irAcceptanceBlocker, irAcceptanceVersionBlocker, irAcceptanceReportBlocker } from "./domain.js";
import { getEmployeeId } from "./identity.js";
import type { AIReqRequirementGroup } from "./types.js";

export function AIReqIrAcceptanceEntry({ group, compact = false, onNavigate }: { group: AIReqRequirementGroup; compact?: boolean; onNavigate?: () => void }) {
  const source = useAIReqDataSource();
  if (!source.capabilities.requirementManagement) return null;
  const aireq = useAIReq()!;
  const blocker = aireq.view ? irAcceptanceBlocker(aireq.view, group) : "正在读取 SR 状态。";
  const title = group.acceptance ? `IR 验收 · ${aireq.view && irAcceptanceVersionBlocker(aireq.view, group) ? "待重新验收" : IR_ACCEPTANCE_LABELS[group.acceptance.status]}` : blocker ?? "全部 SR 已合并，可进入 IR 整体验收。";
  return <span title={title} className="inline-flex shrink-0">
    <Button variant={compact ? "ghost" : "outline"} size={compact ? "icon-sm" : "sm"} disabled={!group.acceptance && !!blocker}
      data-testid={`ir-acceptance-entry-${group.id}`} aria-label={`${group.title}：IR 验收`} aria-pressed={aireq.selection.irId === group.id && !!aireq.selection.irAcceptance}
      onClick={() => { aireq.select({ projectId: group.projectId, irId: group.id, irAcceptance: true }); onNavigate?.(); }}>
      <ClipboardCheck className="size-3.5" />{!compact && (group.acceptance ? "查看 IR 验收" : "IR 验收")}
    </Button>
  </span>;
}

export function AIReqIrAcceptanceHeader({ group }: { group: AIReqRequirementGroup }) {
 const source = useAIReqDataSource();
  if (!source.capabilities.requirementManagement) return null;
  const aireq = useAIReq()!;
  const acceptance = group.acceptance;
  const blocker = irAcceptanceBlocker(aireq.view!, group);
  const versionIssue = irAcceptanceVersionBlocker(aireq.view!, group);
  const reportIssue = irAcceptanceReportBlocker(aireq.view!, group);
  const owns = acceptance?.employeeId === getEmployeeId();
  const ready = acceptance?.status === "passed" && !reportIssue;
  return <header className="space-y-3 border-b border-border bg-background px-4 py-3" data-testid="ir-acceptance-header" data-status={acceptance?.status ?? "ready"} data-stale={Boolean(versionIssue)}>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="icon-sm" aria-label="返回 IR 需求讨论" onClick={() => aireq.select({ projectId: group.projectId, irId: group.id })}><ArrowLeft className="size-4" /></Button>
      <span className="rounded-sm border border-border px-1 font-mono text-ui-xs text-foreground-subtle">IR</span>
      <strong className="min-w-0 flex-1 text-ui-base">{group.title}</strong>
      <span className="text-ui-sm text-foreground-subtle">{versionIssue ? "待重新验收" : acceptance ? IR_ACCEPTANCE_LABELS[acceptance.status] : "待开始验收"}</span>
    </div>

    <AIReqAgentModelSummary binding={acceptance?.session.modelConfig} />
    {acceptance && <p className="text-ui-sm text-foreground-subtle">验收开发人：{acceptance.employeeId} · 候选：{acceptance.candidate}{!owns ? " · 当前仅查看" : ""}</p>}
    <div className="flex flex-wrap gap-2">
      {!acceptance && <Button size="sm" data-testid="ir-acceptance-start" disabled={!!blocker || !source.projects?.readDevelopmentRoot(group.projectId)} onClick={() => void aireq.command({ type: "startIrAcceptance" })}>开始 IR 验收</Button>}
      {owns && !versionIssue && acceptance?.status === "reviewing" && <Button size="sm" data-testid="ir-acceptance-pass" onClick={() => void aireq.command({ type: "generateIrAcceptanceReport", outcome: "passed" })}>生成通过报告</Button>}

      {owns && !versionIssue && acceptance?.status === "passed" && <Button size="sm" data-testid="ir-final-pr-prepare" disabled={!ready} onClick={() => void aireq.command({ type: "prepareIrFinalPr" })}>确认验收，准备最终 PR</Button>}
    </div>
    {versionIssue && <div className="space-y-2" data-testid="ir-acceptance-stale"><p role="status" className="text-ui-sm text-foreground-subtle">{versionIssue}</p>{owns && <Button size="sm" data-testid="ir-acceptance-restart" onClick={() => void aireq.command({ type: "restartIrAcceptance" })}>重新对齐并验收</Button>}</div>}
    {!versionIssue && reportIssue && acceptance?.status === "passed" && <div className="space-y-2"><p className="text-ui-sm text-foreground-subtle">{reportIssue}</p>{owns && <Button size="sm" onClick={() => void aireq.command({ type: "restartIrAcceptance" })}>重新验收</Button>}</div>}
    {!acceptance && <p role="status" className="text-ui-sm text-foreground-subtle">{blocker ?? (!source.projects?.readDevelopmentRoot(group.projectId) ? "请先在设置中添加我的开发项目。" : "全部 SR 已合并核验（样例）；明确开始后创建独立 IR 验收会话及修复／归档工作区。")}</p>}
    {acceptance?.status === "issues" && <p role="status" className="text-ui-sm text-foreground-subtle">发现需求范围内的实现问题，请修复并重新整体验收；需求或方案有变化时，请在自己的开发项目中修改提交并重新核对影响。</p>}
    {owns && acceptance && ["pr-ready", "pr-submitted"].includes(acceptance.status) && <AIReqIrFinalPrControls key={`${group.id}:${acceptance.candidate}`} group={group} />}
    {acceptance?.status === "completed" && <p role="status" className="text-ui-sm text-foreground-subtle">最终 PR 已合并并核验（样例），IR 已完成，仓库占用已释放。验收历史只读，未删除 worktree 或分支。</p>}

    {Boolean(acceptance?.history?.length) && <details className="text-ui-xs text-foreground-subtle"><summary className="cursor-pointer">历史验收（{acceptance!.history!.length}）</summary><ul className="mt-2 space-y-1 break-all">{acceptance!.history!.map((item, index) => <li key={`${item.candidate}:${index}`}>{item.candidate} · {item.baseCommit} · {item.status} · 仅供历史查看</li>)}</ul></details>}
    {acceptance?.reportPath && <details className="space-y-3 text-ui-sm"><summary className="cursor-pointer">验收报告</summary><p className="break-all text-foreground-subtle">{acceptance.reportPath}</p><AIReqMarkdownDocument>{aireq.view?.materials.find(item => item.path === acceptance.reportPath)?.content ?? "验收报告不可读，请恢复对应文件后重新核验。"}</AIReqMarkdownDocument></details>}
    {acceptance && <details className="text-ui-sm text-foreground-subtle"><summary className="cursor-pointer">工作区与验收基点</summary><p className="mt-2 break-all">{acceptance.worktree.path}</p><p>分支：{acceptance.worktree.branch} · 基点：{acceptance.baseCommit}</p></details>}
    <p className="text-ui-xs text-foreground-subtle">{source.provenance.kind === "sample" ? "简化原型：验收固定通过，不演示问题、返工或复验；报告与合并核验均为静态样例，不执行模型、测试、Git 或归档。人工 PR 合并与归档核验仍保留。" : "验收结论以报告与合并核验记录为准，人工 PR 合并与归档核验仍须完成。"}</p>
    {aireq.error && <p role="alert" className="text-ui-sm text-destructive">{aireq.error}</p>}
  </header>;
}

export function AIReqIrAcceptanceWelcome() {
  return <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center" data-testid="ir-acceptance-welcome"><ClipboardCheck className="size-8 text-foreground-subtle" /><h2 className="text-ui-base font-medium">全部 SR 合并后，验收整个 IR</h2><p className="max-w-md text-ui-sm leading-6 text-foreground-subtle">在右侧文档底部明确开始验收，按固定流程生成通过报告，再准备归档 PR。右侧可查看整组需求及方案，验收报告和 PR 详情在“更多”中查看。</p></div>;
}
