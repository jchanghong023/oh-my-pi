import { useSyncExternalStore } from "react";
import type { PrototypeAgentModelBinding } from "./mock/agent-models.js";
import { prototypeAgentModelBindingChanged, prototypeAgentModelConfigurationRevision, subscribePrototypeAgentModels } from "./mock/agent-models.js";

export function DevAgentModelSummary({ binding }: { binding?: PrototypeAgentModelBinding }) {
 useSyncExternalStore(subscribePrototypeAgentModels, prototypeAgentModelConfigurationRevision, prototypeAgentModelConfigurationRevision);
 if (!binding) return null;
 const reasoning = ({ default: "模型默认", low: "低", medium: "中", high: "高" } as Record<string, string>)[binding.reasoning] ?? binding.reasoning;
 return <div className="space-y-1 text-ui-sm text-foreground-subtle" data-testid="agent-session-model" data-agent-role={binding.role} data-model-key={binding.modelKey} data-reasoning={binding.reasoning}>
  <p>{binding.roleName} · {binding.modelName} · 思考：{reasoning}{binding.inherited ? " · 跟随默认（创建时）" : ""} · 演示配置</p>
  {prototypeAgentModelBindingChanged(binding) && <p data-testid="agent-session-model-pending">设置已更新；此会话保留创建时配置，新建该角色会话后生效。</p>}
 </div>;
}
