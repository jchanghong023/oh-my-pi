import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useDev } from "./DevContext.js";
import type { DevFileVersion, DevRequirementGroup, DevSystemRequirement } from "./mock/types.js";
const versionKey = (file: DevFileVersion) => JSON.stringify([file.path, file.sha256, file.size]);
export function DevPublishControls({ group, sr }: { group: DevRequirementGroup; sr?: DevSystemRequirement }) {
  const dev = useDev()!;
  const [message, setMessage] = useState("Dev materials");
  const [selected, setSelected] = useState<string[]>([]);
  if (!(sr?.worktree || group.worktree) || sr?.status === "completed") return null;
  const changes = dev.view?.changes?.filter(file => file.projectId === dev.selection.projectId && file.irId === group.id && file.srId === sr?.id) ?? [];
  const versions = sr ? changes.filter(file => selected.includes(versionKey(file))).map(({ path, sha256, size }) => ({ path, sha256, size })) : [...group.files, ...(group.evidenceFiles ?? []), ...(group.retiredFiles ?? [])];
  const scope = sr ? "development" : "requirements";
  const publish = (push: boolean) => void dev.command({ type: "publishMaterials", scope, paths: versions.map(file => file.path), versions, message, push });
  return <details className="w-full rounded-md border border-border p-2" data-testid="publish-scope"><summary className="cursor-pointer text-sm">Git 发布范围（交互样例）</summary>
    <p className="my-2 text-xs text-foreground-subtle">阶段性前端原型：仅展示材料选择与授权交互，不会提交、推送或发布，不代表真实仓库状态。</p>
    {sr ? <div className="my-2 max-h-48 overflow-y-auto">{changes.length ? changes.map(file => <label key={versionKey(file)} className="flex items-start gap-2 py-1 text-xs"><input type="checkbox" data-testid="publish-file" data-path={file.path} data-sha256={file.sha256} data-size={file.size} checked={selected.includes(versionKey(file))} onChange={event => setSelected(previous => event.target.checked ? [...previous, versionKey(file)] : previous.filter(key => key !== versionKey(file)))} /><span className="break-all">{file.status} · {file.path}<small className="block text-foreground-subtle">{file.sha256} · {file.size < 0 ? "删除" : `${file.size} bytes`}</small></span></label>) : <p className="text-xs">没有当前 SR 的真实 Git 改动。</p>}</div> : <ul className="my-2 break-all text-xs">{versions.map(file => <li key={file.path}>{file.size < 0 ? "删除 · " : ""}{file.path}<small className="block text-foreground-subtle">{file.sha256}</small></li>)}</ul>}
    <Input data-testid="publish-message" aria-label="材料提交说明" value={message} onChange={event => setMessage(event.target.value)} />
    <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" data-testid={`publish-${scope}`} disabled={dev.pending || !message.trim() || !versions.length} onClick={() => publish(false)}>演示提交{sr ? "开发" : "需求"}范围</Button><Button size="sm" variant="outline" data-testid={`push-${scope}`} disabled={dev.pending || !message.trim() || !versions.length} onClick={() => publish(true)}>演示推送{sr ? "开发" : "需求"}范围</Button></div>
  </details>;
}
