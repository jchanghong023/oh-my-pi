import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useDev } from "./DevContext.js";
import type { DevRequirementGroup, DevSystemRequirement } from "./mock/types.js";

export function DevPublishControls({ group, sr }: { group: DevRequirementGroup; sr?: DevSystemRequirement }) {
  const dev = useDev()!;
  const [message, setMessage] = useState("Dev materials");
  if (sr) return <p className="text-ui-sm text-foreground-subtle">SR 的代码、测试和规格通过顶部“交付 PR”的统一清单准备，不再单独发布阶段材料。</p>;
  if (!group.worktree) return null;
  const versions = [...group.files, ...(group.evidenceFiles ?? []), ...(group.retiredFiles ?? [])];
  const publish = (push: boolean) => void dev.command({ type: "publishMaterials", scope: "requirements", paths: versions.map(file => file.path), versions, message, push });
  return <details className="w-full rounded-md border border-border p-2" data-testid="publish-scope"><summary className="cursor-pointer text-sm">Git 发布范围（交互样例）</summary>
    <p className="my-2 text-xs text-foreground-subtle">阶段性前端原型：仅展示材料选择与授权交互，不会提交、推送或发布，不代表真实仓库状态。</p>
    <ul className="my-2 break-all text-xs">{versions.map(file => <li key={file.path}>{file.size < 0 ? "删除 · " : ""}{file.path}<small className="block text-foreground-subtle">{file.sha256}</small></li>)}</ul>
    <Input data-testid="publish-message" aria-label="材料提交说明" value={message} onChange={event => setMessage(event.target.value)} />
    <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" data-testid="publish-requirements" disabled={dev.pending || !message.trim() || !versions.length} onClick={() => publish(false)}>演示提交需求范围</Button><Button size="sm" variant="outline" data-testid="push-requirements" disabled={dev.pending || !message.trim() || !versions.length} onClick={() => publish(true)}>演示推送需求范围</Button></div>
  </details>;
}
