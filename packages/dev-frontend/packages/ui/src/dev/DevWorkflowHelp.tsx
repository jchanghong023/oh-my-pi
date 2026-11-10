import type { RefObject } from "react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const steps = [
  { section: "需求提案", sectionEn: "Proposal", title: "提出需求", titleEn: "Describe the need", description: "与业务需求 Agent 讨论，明确目标、范围和验收标准，形成整体需求 IR，并拆分为具体需求 SR。", descriptionEn: "Discuss goals, scope and acceptance criteria with the Requirements Agent. Organize the overall requirement (IR) into specific requirements (SRs)." },
  { title: "检查需求", titleEn: "Review requirements", description: "业务需求评审 Agent 检查遗漏和矛盾，有问题则补充完善，有争议由人工决定。", descriptionEn: "The Business Requirements Review Agent checks for gaps and contradictions. Clarify issues and ask a person to resolve disagreements." },
  { title: "制定方案", titleEn: "Design the solution", description: "开发人员接手，由方案 Agent 制定技术方案和开发顺序；需要业务澄清时，退回补充。", descriptionEn: "A developer takes over and the Solution Agent prepares the technical design and development order. Business questions return for clarification." },
  { title: "确认入库", titleEn: "Approve the proposal", description: "人工确认需求与方案，通过 PR 评审并合并后，提案进入“正式需求”。", descriptionEn: "A person confirms the requirements and design. After the proposal PR is reviewed and merged, it appears under Formal Requirements." },
  { section: "开发交付", sectionEn: "Development", title: "逐项开发", titleEn: "Develop each SR", description: "按依赖关系开发各个 SR，独立的 SR 可并行；AI 制定计划、开发、测试和审查，开发开始后需求与方案冻结。", descriptionEn: "Develop SRs according to their dependencies; independent SRs may run in parallel. AI plans, implements, tests and reviews. Requirements and design freeze when development starts." },
  { title: "评审合并", titleEn: "Review and merge", description: "每个 SR 的代码、测试和规格一起提交 PR，由人工评审合并，平台核验后完成该 SR。", descriptionEn: "Each SR delivers code, tests and specification updates in one PR. A person reviews and merges it, and the platform verifies the result before completing the SR." },
  { section: "验收完成", sectionEn: "Acceptance", title: "整体验收", titleEn: "Accept the whole IR", description: "全部 SR 合并后，IR 验收 Agent 检查整体效果，发现实现问题则修复并重新验证。", descriptionEn: "After all SRs merge, the IR Acceptance Agent checks the integrated result, fixes implementation issues and verifies it again." },
  { title: "完成归档", titleEn: "Complete and archive", description: "最终修复和归档通过人工 PR 评审、合并并核验后，整个 IR 完成；需求或方案变化需重新提案。", descriptionEn: "The final fixes and archive PR is reviewed and merged by a person, then verified by the platform. This completes the IR. Changes to requirements or design need a new proposal." },
];

export function DevWorkflowHelp({ open, onOpenChange, returnFocusRef }: { open: boolean; onOpenChange(open: boolean): void; returnFocusRef?: RefObject<HTMLButtonElement | null> }) {
  const { locale } = useZCodeIntl();
  const zh = locale === "zh-CN";
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent onCloseAutoFocus={event => { if (returnFocusRef?.current) { event.preventDefault(); returnFocusRef.current.focus(); } }} className="max-h-[85dvh] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0" data-testid="dev-workflow-help">
      <DialogHeader className="px-6 pt-6 pb-4 pr-14">
        <DialogTitle>{zh ? "业务流程帮助" : "Workflow help"}</DialogTitle>
        <DialogDescription>{zh ? "一项需求，从讨论到完成。IR 是整体需求，SR 是其中可分别开发的具体需求；PR 是交给人工评审、合并的申请。" : "From an idea to completion. An IR is the overall requirement, an SR is a specific deliverable within it, and a PR is a request for human review and merge."}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto px-6 pb-5" tabIndex={0} aria-label={zh ? "完整业务流程" : "Complete workflow"}>
        <ol className="space-y-3">
          {steps.map((step, index) => <li key={step.title}>
            {step.section && <h3 className={`${index ? "pt-3" : ""} mb-3 text-ui-sm font-medium text-foreground-subtle`}>{zh ? step.section : step.sectionEn}</h3>}
            <div className="flex gap-3">
              <span aria-hidden="true" className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-ui-sm text-foreground-subtle">{index + 1}</span>
              <div className="min-w-0 space-y-1"><h4 className="text-ui-base font-medium">{zh ? step.title : step.titleEn}</h4><p className="text-ui-sm leading-6 text-foreground-subtle">{zh ? step.description : step.descriptionEn}</p></div>
            </div>
          </li>)}
        </ol>
      </div>
      <DialogFooter className="border-t border-border px-6 py-3">
        <DialogClose asChild><Button>{zh ? "我知道了" : "Got it"}</Button></DialogClose>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
