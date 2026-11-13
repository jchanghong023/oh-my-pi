import type { RefObject } from "react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useAIReqDataSource } from "./data-source.js";

const steps = [
  { section: "需求提案", sectionEn: "Proposal", title: "提出需求", titleEn: "Describe the need", description: "进入提案 IR 与业务需求 Agent 讨论，明确目标、范围和验收标准，再拆分为 SR。提案列表只显示 IR，点击整行进入；拆分出的 SR 规格在右侧材料中查看，讨论、修改和阶段推进统一从 IR 进入。", descriptionEn: "Discuss goals, scope and acceptance criteria in the proposal IR. The proposal list shows IRs only. Click a row to open it and read its SR specifications in the right materials pane; discussion, changes and stage actions belong to the IR." },
  { title: "检查需求", titleEn: "Review requirements", description: "IR／SR 完整后，A／B／C 用不同模型并行只读评审，综合评审 Agent 汇总来源与分歧；默认查看综合意见，由人判断通过进入方案或返回业务 Agent 补充后重评。", descriptionEn: "Three different models review the same IR/SR in parallel. A fourth agent synthesizes their sources and disagreements. A person reads the synthesis and decides to proceed or return for clarification." },
  { title: "制定方案", titleEn: "Design the solution", description: "开发在 A 的 OMP 与方案 Agent 对话，在同一 OMP 项目目录中，由 AI 通过对话生成和更新技术方案、SR 依赖与工期预估，不需要点击生成按钮。逐 SR 预估工期及假设与依赖共同存入 sr-dependencies.json；提案不安排人员或起止日期。回答不了 Agent 的问题时，复制问题，点击退出并粘贴意见，直接返回业务 Agent；业务通过对话让 AI 更新 IR／SR，重评后再继续方案。", descriptionEn: "In the same OMP project directory, a developer discusses the design with the Solution Agent, which generates and updates the design, SR dependencies, and duration estimates through conversation, without a Generate button. Per-SR duration estimates and assumptions share sr-dependencies.json with dependencies; proposals do not assign people or dates. If the developer cannot answer its questions, they copy them into the large Return dialog. The Business Requirements Agent receives the feedback, updates IR/SR through discussion, and the requirements are reviewed again before design resumes." },
  { title: "自动入库", titleEn: "Automatic intake", description: "方案完成并确认后，平台才创建提案分支并提交推送。平台自动创建 MR，人工评审和合并；后台定时查询 MR，核验提案分支已合入默认分支且 IR、全部 SR、方案文档完整，就自动转为正式需求，再创建并推送各 SR 分支。无需个人目录、手填 MR 链接或人工通知；入库仅展示流程状态，不另建 Agent 会话。", descriptionEn: "After solution confirmation, the platform creates and pushes the proposal branch. The platform creates the MR; people review and merge it. Scheduled MR and repository checks automatically admit the requirement when the branch is merged and all IR, SR and solution documents are complete, then create and push SR branches. No personal directory, manually entered MR URL or manual merge confirmation is required." },
  { section: "开发进度跟踪", sectionEn: "Progress tracking", title: "安排人员与排期", titleEn: "Assign people and dates", description: "转为正式需求后分配 IR 负责人，安排各 SR 开发人员及计划起止时间，查看依赖、可并行关系和排期冲突。人员与时间是数据库元数据，不改仓库文档、不新增 PR；平台不执行编码或调度开发。", descriptionEn: "Assign an IR owner and SR developers, then adjust planned start and end dates after conversion to formal requirements. Inspect dependencies, parallel work and scheduling conflicts. These are database metadata, not document changes or new PRs. AIReq does not implement code or schedule coding agents." },
  { title: "查看代码证据", titleEn: "Inspect code evidence", description: "正式需求在大表格展示，选择 IR／SR 后在同页右侧查看进度报告和需求材料。报告说明已实现内容、遗留问题、不确定项、代码活动、分支及分析版本。", descriptionEn: "Formal requirements appear in a table. Select an IR or SR to view its report and materials beside the table. Reports include implemented scope, outstanding issues, uncertainty, code activity, branches and analysed revisions." },
  { title: "核对完成条件", titleEn: "Check completion criteria", description: "SR 的 0%～99% 进度仅由 AI 分析。只有已合入默认分支且 AI 分析到 99% 时，管理员或 IR 负责人才可填写依据，人工确认到 100%；不能填写其他百分比。IR 进度自动取全部 SR 的算术平均值。", descriptionEn: "AI alone determines SR progress from 0% to 99%. An administrator or the IR owner may confirm a merged SR at 99% as 100%, recording the reason. Other manual percentages are not allowed. IR progress is the arithmetic mean of all its SRs." },
  { title: "持续跟踪遗留问题", titleEn: "Track outstanding work", description: "根据新代码版本持续更新进度和遗留问题；合入不等于完成，排期不等于实际进度。开发者在平台外使用自己的工具开发、测试和评审，AIReq 不提供计划／执行 Agent、固定通过验收或编码交付流水线。", descriptionEn: "Track progress and outstanding issues against new code revisions. Merging is not completion, and planned dates are not implementation progress. Developers implement, test and review with their own tools outside AIReq. AIReq has no coding-agent pipeline or automatically passing acceptance stage." },
];

export function AIReqWorkflowHelp({ open, onOpenChange, returnFocusRef }: { open: boolean; onOpenChange(open: boolean): void; returnFocusRef?: RefObject<HTMLButtonElement | null> }) {
  const { locale } = useZCodeIntl();
  const source = useAIReqDataSource();
  const zh = locale === "zh-CN";
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent onCloseAutoFocus={event => { if (returnFocusRef?.current) { event.preventDefault(); returnFocusRef.current.focus(); } }} className="max-h-[85dvh] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0" data-testid="aireq-workflow-help">
      <DialogHeader className="px-6 pt-6 pb-4 pr-14">
        <DialogTitle>{zh ? "业务流程帮助" : "Workflow help"}</DialogTitle>
        <DialogDescription>{zh ? "AI 驱动的需求澄清、管理与进度跟踪。IR 是整体需求，SR 是其中可分别实现的系统需求；AIReq 不参与实际编码。" : "AI-driven requirement clarification, management and progress tracking. An IR is the overall requirement and an SR is a separately implementable system requirement. AIReq does not write code."}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto px-6 pb-5" tabIndex={0} aria-label={zh ? "完整业务流程" : "Complete workflow"}>
        <p className="mb-4 text-ui-sm leading-6 text-foreground-subtle">{zh ? "提案沿用三栏：左侧需求列表、中间 AI 讨论、右侧只读材料。阅读材料后在底栏评审、退回或确认方案；点击阶段只查看历史。正式需求使用大表格与同页报告，不显示开发聊天或阶段推进按钮。" : "Proposals use three panes: navigation, AI discussion and read-only materials. Use the materials footer to review, return or confirm the solution; stage clicks only view history. Formal requirements use a table and same-page reports, without coding chat or execution controls."}{source.provenance.kind === "sample" && (zh ? "所有演示操作保存于后端内存，刷新保留、后端重启恢复样例。" : "Demo changes stay in backend memory across reloads and reset on backend restart.")}</p><ol className="space-y-3">
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
