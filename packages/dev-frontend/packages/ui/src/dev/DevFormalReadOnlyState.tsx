import { Button } from "@/components/ui/button.js";
import { useDev } from "./DevContext.js";
import { useDevDataSource } from "./data-source.js";

/** 说明访客的正式需求查看边界，不挂载开发会话或聊天输入框。 */
export function DevFormalReadOnlyState() {
  const dev = useDev()!;
  const source = useDevDataSource();
  const canPropose = source.capabilities.workflowCommands.includes("createProposal");
  return <section className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6" data-testid="dev-formal-materials-only" aria-labelledby="formal-readonly-title">
    <div className="w-full max-w-md space-y-5">
      <div className="space-y-2">
        <h2 id="formal-readonly-title" className="text-ui-base font-medium">正式需求仅供查看</h2>
        <p className="text-ui-base leading-6 text-foreground-subtle">你正在访问其他开发者的 OMP Web，正式需求的开发聊天不对访客展示。{dev.selection.srId ? "请在右侧查看当前 SR 自己的规格和材料。" : "请在右侧查看该 IR 的需求提案、各 SR 规格和技术设计。"}</p>
      </div>
      <div className="space-y-2 text-ui-base leading-6">
        <p><span className="font-medium">需要调整需求？</span><span className="text-foreground-subtle">{canPropose ? "新建需求提案，与 AI 讨论修改意见。" : "请进入 j00808874 的 OMP Web，新建需求提案讨论修改意见。"}</span></p>
        <p><span className="font-medium">需要修改代码？</span><span className="text-foreground-subtle">由开发人员启动自己的 OMP Web，以自己的工号登录并配置开发项目路径后处理。</span></p>
      </div>
      {canPropose && <Button variant="outline" disabled={dev.pending || !dev.releaseId} onClick={dev.startProposalDraft}>新建需求提案</Button>}
    </div>
  </section>;
}
