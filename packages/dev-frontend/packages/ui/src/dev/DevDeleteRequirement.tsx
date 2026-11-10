import { useDevDataSource } from "./data-source.js";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useDev } from "./DevContext.js";

/** Removal is performed by the injected source; sample and host persistence remain isolated. */
export function DevDeleteRequirement() {
  const source = useDevDataSource();
  const dev = useDev()!;
  const [targetId, setTargetId] = useState<string>();
  const { selection, view } = dev;
  const group = [...(view?.groups ?? []), ...(view?.drafts ?? [])].find(item => item.id === selection.irId && item.projectId === selection.projectId);
  if (!source.capabilities.workflowCommands.includes("deleteRequirement") || !group || selection.srId) return null;
  const started = view?.srs.some(sr => sr.irId === group.id && sr.status !== "pending");
  const prohibition = group.merge || group.proposalRevisions?.length || group.status === "frozen" || started ? "已入库的正式提案、修订及开发历史保留展示；只能移除允许删除的草稿。" : undefined;
  const remove = async () => {
    if (targetId !== group.id || prohibition) return;
    const result = await dev.command({ type: "deleteRequirement", version: 1, projectId: group.projectId, irId: group.id });
    if (result?.status === "completed") setTargetId(undefined);
  };
  return <>
    <Button size="sm" variant="outline" data-testid="delete-requirement" disabled={!!prohibition} title={prohibition} onClick={() => setTargetId(group.id)}>删除需求</Button>
    <AlertDialog open={targetId === group.id} onOpenChange={open => { if (!open) setTargetId(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>移除需求“{group.title}”？</AlertDialogTitle>
          <AlertDialogDescription>{source.mode === "prototype" ? "仅从本次前端演示的列表移除样例需求；刷新页面后恢复原始样例。" : "将向 OMP 提交当前需求的删除操作。历史记录及相关文件的处理以服务端结果为准。"}</AlertDialogDescription>
        </AlertDialogHeader>
        {dev.error && <p role="alert" className="text-sm text-destructive">{dev.error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="delete-requirement-cancel">取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" data-testid="delete-requirement-confirm" onClick={event => { event.preventDefault(); void remove(); }}>{source.mode === "prototype" ? "移除本地样例" : "确认删除"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
