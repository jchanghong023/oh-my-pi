import { hasCurrentProposalSolution, proposalDeliveryCurrent, requirementsReviewCurrent } from "./domain.js";
import { DevProposalStageBody } from "./DevPhaseHeader.js";
import { DevFreeChatDraftComposer } from "./DevFreeChatDraftComposer.js";
import { DevProposalDraftComposer } from "./DevProposalDraftComposer.js";
import { useDevDataSource } from "./data-source.js";
import { Button } from "@/components/ui/button.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useDev } from "./DevContext.js";

/** 没有已选会话时不挂载聊天输入框，不借用固定样例会话。 */
export function DevEmptyState() {
 const source = useDevDataSource();
 const dev = useDev()!;
 const openSettings = useTabStore(state => state.openSettingsTab);
 const project = dev.view?.projects.find(item => item.id === dev.selection.projectId);
 const release = dev.view?.releases.find(item => item.id === dev.releaseId);
 if (dev.selection.freeDraftId && project && source.capabilities.freeChat) return <DevFreeChatDraftComposer key={dev.selection.freeDraftId} />;
 if (dev.selection.proposalDraftId && project && release && source.capabilities.workflowCommands.includes("createProposal")) return <DevProposalDraftComposer key={dev.selection.proposalDraftId} />;
 const proposal = dev.view?.drafts.find(item => item.id === dev.selection.irId);
 if (proposal && source.capabilities.proposalDiscussion === false) return <main className="flex h-full min-h-0 flex-1 items-center justify-center p-6" data-testid="dev-proposal-web-readonly"><section className="max-w-md space-y-3 text-center"><h2 className="text-ui-base font-medium">{hasCurrentProposalSolution(proposal) && source.capabilities.codeDevelopment ? "需求与方案已就绪" : "当前 Web 只读查看提案"}</h2><p className="text-ui-base leading-6 text-foreground-subtle">{hasCurrentProposalSolution(proposal) && source.capabilities.codeDevelopment ? "检查右侧文件，配置自己的开发项目后，在右下角确认入库。AI 将复制草稿到项目、提交并推送，人工处理 PR。提案讨论仍在 A 的 OMP，这里不加载聊天。" : "在右侧阅读需求和方案文件。讨论或修改请进入 j00808874 的 OMP Web；方案完成后，入库才使用自己的 Web 和开发项目。"}</p></section></main>;
 if (proposal && (dev.selection.proposalStep === "requirements-review" || dev.selection.proposalStep === "intake" || (!dev.selection.proposalStep && !dev.selection.discussionPhase && (proposalDeliveryCurrent(proposal) || proposal.status === "requirements-pr" || (proposal.proposalStage !== "solution" && requirementsReviewCurrent(proposal)))))) return <DevProposalStageBody />;
 const missingSession = Boolean(dev.selection.irId);
 const title = missingSession ? "所选会话暂不可用" : !project ? "请选择项目" : !release ? "此项目尚无 Release" : "选择已有会话";
 const description = missingSession ? "会话记录缺失或所选阶段尚未开始。不会替换为其他需求或自动创建会话。" : !project ? "先登记已有 Git 项目，再选择它的 Release。" : !release ? "请先选择已有 Release，或在设置中添加。" : "从左侧继续已有会话，或使用下方入口开始。尚未选择会话时不会显示其他需求的聊天。";
 return <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6" data-testid="dev-empty-state">
  <section className="w-full max-w-xl space-y-4"><h2 className="text-ui-base font-medium">{title}</h2><p className="text-ui-base leading-6 text-foreground-subtle">{description}</p>
   <div className="flex flex-wrap gap-2">
    {source.capabilities.freeChat && project && !missingSession && <Button variant="outline" onClick={() => dev.startFreeChat()}>新建自由会话</Button>}
    {source.capabilities.workflowCommands.includes("createProposal") && project && release && !missingSession && <Button disabled={dev.pending} onClick={dev.startProposalDraft}>新建需求提案</Button>}
    {(!project || !release) && <Button variant="outline" onClick={() => { setPendingSettingsSectionIntent("general"); openSettings(); }}>项目与 Release 设置</Button>}
    {missingSession && <><Button variant="outline" onClick={() => void dev.retrySession()}>重新读取</Button><Button variant="outline" onClick={() => dev.select({ projectId: dev.selection.projectId })}>返回项目查看</Button></>}
   </div>
   {dev.error && <p role="alert" className="text-ui-sm text-destructive">{dev.error}</p>}
  </section>
 </main>;
}

/** 提案以 IR 为讨论单位；SR 只阅读自身规格，不挂载任何聊天会话。 */
export function DevProposalSrReadOnlyState() {
 const dev = useDev()!;
 return <main className="flex h-full min-h-0 flex-1 items-center justify-center p-6" data-testid="dev-proposal-sr-readonly">
  <section className="max-w-md space-y-3 text-center">
   <p className="text-ui-base leading-6 text-foreground-subtle">请进入所属 IR 讨论或修改需求。</p>
   <Button variant="outline" onClick={() => dev.select({ projectId: dev.selection.projectId, irId: dev.selection.irId })}>返回 IR</Button>
  </section>
 </main>;
}
