import type { RefObject } from "react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const steps = [
  { section: "需求提案", sectionEn: "Proposal", title: "提出需求", titleEn: "Describe the need", description: "进入提案 IR 与业务需求 Agent 讨论，明确目标、范围和验收标准，再拆分为 SR。提案列表只显示 IR，点击整行进入；拆分出的 SR 规格在右侧材料中查看，讨论、修改和阶段推进统一从 IR 进入。", descriptionEn: "Discuss goals, scope and acceptance criteria in the proposal IR. The proposal list shows IRs only. Click a row to open it and read its SR specifications in the right materials pane; discussion, changes and stage actions belong to the IR." },
  { title: "检查需求", titleEn: "Review requirements", description: "IR／SR 完整后，A／B／C 用不同模型并行只读评审，综合评审 Agent 汇总来源与分歧；默认查看综合意见，由人判断通过进入方案或返回业务 Agent 补充后重评。", descriptionEn: "Three different models review the same IR/SR in parallel. A fourth agent synthesizes their sources and disagreements. A person reads the synthesis and decides to proceed or return for clarification." },
  { title: "制定方案", titleEn: "Design the solution", description: "开发在 A 的 OMP 与方案 Agent 对话，由 AI 在提案临时目录生成方案。回答不了 Agent 的问题时，复制问题，点击退出并粘贴意见，直接返回业务 Agent；业务通过对话让 AI 更新 IR／SR，重评后再继续方案。", descriptionEn: "On A’s OMP, a developer discusses the design with the Solution Agent. If the developer cannot answer its questions, they copy them into the large Return dialog. The Business Requirements Agent receives the feedback, updates IR/SR through discussion, and the requirements are reviewed again before design resumes." },
  { title: "确认入库", titleEn: "Approve the proposal", description: "只有入库才要求自己启动的 OMP Web 和自己的 Git 开发项目。AI 复制已确认草稿到项目、提交并推送，人工创建和评审合并 PR，核验后进入正式需求。", descriptionEn: "Intake requires the developer’s own OMP Web and Git project. AI copies the confirmed draft, commits and pushes it. A person creates, reviews and merges the PR, and intake follows verification." },
  { section: "开发交付", sectionEn: "Development", title: "逐项开发", titleEn: "Develop each SR", description: "按依赖关系开发各个 SR，独立的 SR 可并行；计划 Agent 编制计划，人工检查文档并点“下一步”后才交给执行 Agent 开发、测试和审查；并发与依赖仅在当前 OMP Web 内检查。", descriptionEn: "Develop SRs according to their dependencies; independent SRs may run in parallel. The Planning Agent prepares the plan. A person reviews the document and clicks Next before the Execution Agent implements, tests and reviews. Dependency and concurrency checks apply within the current OMP Web." },
  { title: "评审合并", titleEn: "Review and merge", description: "执行 Agent 准备每个 SR 的代码、测试和规格，在同一 PR 中交付；人工评审合并，平台核验后才完成 SR，不另设交付 Agent。", descriptionEn: "Each SR delivers code, tests and specification updates in one PR. A person reviews and merges it, and the platform verifies the result before completing the SR." },
  { section: "验收完成", sectionEn: "Acceptance", title: "整体验收", titleEn: "Accept the whole IR", description: "全部 SR 合并核验后，IR 验收 Agent 按固定流程生成通过报告，再准备归档；当前简化设计不包含验收问题、返工或复验。", descriptionEn: "After all SRs merge, the IR Acceptance Agent follows a fixed passing flow, then prepares archiving. This simplified design has no acceptance failures or rework." },
  { title: "完成归档", titleEn: "Complete and archive", description: "归档通过人工 PR 评审、合并并核验后，整个 IR 完成；正式需求与方案可由开发人员在自己的 Web 和 Git 项目中修改、提交，变更后重新核对受影响的计划与验证。", descriptionEn: "The final fixes and archive PR is reviewed and merged by a person, then verified by the platform. This completes the IR. Developers can change formal requirements and designs in their own Web and Git project, then reassess the affected plans and verification." },
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
        <p className="mb-4 text-ui-sm leading-6 text-foreground-subtle">{zh ? "桌面聊天顶部：阶段进度居中。检查右侧文档后，在文档底部固定操作栏进行评审、交接、退回或 PR 确认；提案“更多”只查看信息和记录或删除，不提供流程按钮；点击阶段只查看记录，不改变流程。工作中或文件不完整时不能进入下一步，回退保留代码和历史。" : "Desktop chat: stage progress is centered above the conversation. Review the document on the right, then use its fixed bottom action bar for review, handoff, return or PR confirmation. The proposal menu only provides information, records and deletion. Stage clicks only view records. Work in progress or incomplete documents block advancement; Back preserves code and history."}</p><ol className="space-y-3">
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
