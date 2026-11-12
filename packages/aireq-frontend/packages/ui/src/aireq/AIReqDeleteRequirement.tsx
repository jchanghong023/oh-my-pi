import { useAIReqDataSource } from "./data-source.js";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useAIReq } from "./AIReqContext.js";

/** Removal is performed by the injected source; sample and host persistence remain isolated. */
export function AIReqDeleteRequirement({ renderTrigger }: { renderTrigger?: (openDelete?: () => void, prohibition?: string) => ReactNode }) {
  const source = useAIReqDataSource();
  const aireq = useAIReq()!;
  const [targetId, setTargetId] = useState<string>();
  const { selection, view } = aireq;
  const group = [...(view?.groups ?? []), ...(view?.drafts ?? [])].find(item => item.id === selection.irId && item.projectId === selection.projectId);
  if (!source.capabilities.workflowCommands.includes("deleteRequirement") || !group || selection.srId) return <>{renderTrigger?.()}</>;
  const started = view?.srs.some(sr => sr.irId === group.id && sr.status !== "pending");
  const prohibition = group.merge || group.proposalRevisions?.length || group.status === "frozen" || started ? "已入库的正式提案、修订及开发历史保留展示；只能移除允许删除的草稿。" : undefined;
  const remove = async () => {
    if (targetId !== group.id || prohibition) return;
    const result = await aireq.command({ type: "deleteRequirement", version: 1, projectId: group.projectId, irId: group.id });
    if (result?.status === "completed") setTargetId(undefined);
  };
  return <>
    {renderTrigger ? renderTrigger(() => setTargetId(group.id), prohibition) : <Button size="sm" variant="outline" data-testid="delete-requirement" disabled={!!prohibition} title={prohibition} onClick={() => setTargetId(group.id)}>删除需求</Button>}
    <AlertDialog open={targetId === group.id} onOpenChange={open => { if (!open) setTargetId(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>移除需求“{group.title}”？</AlertDialogTitle>
          <AlertDialogDescription>{source.provenance.kind === "sample" ? "从后端内存样例中移除需求；刷新页面保留，后端重启后恢复原始样例。" : "将向 OMP 提交当前需求的删除操作。历史记录及相关文件的处理以服务端结果为准。"}</AlertDialogDescription>
        </AlertDialogHeader>
        {aireq.error && <p role="alert" className="text-sm text-destructive">{aireq.error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="delete-requirement-cancel">取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" data-testid="delete-requirement-confirm" onClick={event => { event.preventDefault(); void remove(); }}>{source.provenance.kind === "sample" ? "移除本地样例" : "确认删除"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
