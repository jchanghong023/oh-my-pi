import { proposalDeliveryCurrent } from "./domain.js";
import { DevProposalStageBody } from "./DevPhaseHeader.js";
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
 if (dev.selection.proposalDraftId && project && release && source.capabilities.workflowCommands.includes("createProposal")) return <DevProposalDraftComposer key={dev.selection.proposalDraftId} />;
 const proposal = dev.view?.drafts.find(item => item.id === dev.selection.irId);
 if (proposal && source.capabilities.proposalDiscussion === false) return <main className="flex h-full min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto p-6" data-testid="dev-proposal-web-readonly"><section className="w-full min-w-0 max-w-md space-y-3 text-center"><h2 className="text-ui-base font-medium">当前 Web 只读查看提案</h2><p className="text-ui-base leading-6 text-foreground-subtle">在右侧阅读需求和方案文件。当前 Web 不支持讨论、修改、确认方案或提交推送；请进入提案所有者的 OMP Web 继续操作。无需配置个人开发目录。</p></section></main>;
 if (proposal && (dev.selection.proposalStep === "intake" || (!dev.selection.proposalStep && !dev.selection.discussionPhase && (proposalDeliveryCurrent(proposal) || proposal.status === "requirements-pr")))) return <DevProposalStageBody />;
 const missingSession = Boolean(dev.selection.irId);
 const title = missingSession ? "所选会话暂不可用" : !project ? "请选择项目" : !release ? "此项目尚无 Release" : "选择需求或新建提案";
 const description = missingSession ? "会话记录缺失或所选阶段尚未开始。不会替换为其他需求或自动创建会话。" : !project ? "先登记 Git 仓库，再选择项目的 Release。" : !release ? "请先选择已有 Release，或在设置中添加。" : "从左侧选择需求提案继续讨论，或新建提案；查看实现情况请进入正式需求。当前 Release 没有提案时，可直接从自然语言开始。";
 return <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6" data-testid="dev-empty-state">
  <section className="w-full max-w-xl space-y-4"><h2 className="text-ui-base font-medium">{title}</h2><p className="text-ui-base leading-6 text-foreground-subtle">{description}</p>
   <div className="flex flex-wrap gap-2">
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
 return <main className="flex h-full min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto p-6" data-testid="dev-proposal-sr-readonly">
  <section className="w-full min-w-0 max-w-md space-y-3 text-center">
   <p className="text-ui-base leading-6 text-foreground-subtle">请进入所属 IR 讨论或修改需求。</p>
   <Button variant="outline" onClick={() => dev.select({ projectId: dev.selection.projectId, irId: dev.selection.irId })}>返回 IR</Button>
  </section>
 </main>;
}
