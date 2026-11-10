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
 const missingSession = Boolean(dev.selection.irId);
 const title = missingSession ? "所选会话暂不可用" : !project ? "请选择项目" : !release ? "此项目尚无 Release" : "选择已有会话";
 const description = missingSession ? "会话记录缺失或所选阶段尚未开始。不会替换为其他需求或自动创建会话。" : !project ? "先登记已有 Git 项目，再选择它的 Release。" : !release ? "请先选择已有 Release，或在设置中添加。" : "从左侧继续已有会话，或使用下方入口开始。尚未选择会话时不会显示其他需求的聊天。";
 return <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6" data-testid="dev-empty-state">
  <section className="w-full max-w-xl space-y-4"><h2 className="text-ui-base font-medium">{title}</h2><p className="text-ui-base leading-6 text-foreground-subtle">{description}</p>
   <div className="flex flex-wrap gap-2">
    {source.capabilities.freeChat && project && !missingSession && <Button variant="outline" onClick={() => dev.startFreeChat()}>新建自由会话</Button>}
    {source.capabilities.workflowCommands.includes("createProposal") && project && release && !missingSession && <Button disabled={dev.pending} onClick={() => void dev.command({ type: "createProposal", releaseId: release.id })}>新建需求提案</Button>}
    {(!project || !release) && <Button variant="outline" onClick={() => { setPendingSettingsSectionIntent("general"); openSettings(); }}>项目与 Release 设置</Button>}
    {missingSession && <><Button variant="outline" onClick={() => void dev.retrySession()}>重新读取</Button><Button variant="outline" onClick={() => dev.select({ projectId: dev.selection.projectId })}>返回项目查看</Button></>}
   </div>
   {dev.error && <p role="alert" className="text-ui-sm text-destructive">{dev.error}</p>}
  </section>
 </main>;
}
