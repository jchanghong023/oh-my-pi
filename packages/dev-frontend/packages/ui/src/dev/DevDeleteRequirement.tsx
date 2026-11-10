import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useDev } from "./DevContext.js";

/** Removes only the current sample IR from frontend memory; no remote deletion receipts. */
export function DevDeleteRequirement() {
  const dev = useDev()!;
  const [targetId, setTargetId] = useState<string>();
  const { selection, view } = dev;
  const group = [...(view?.groups ?? []), ...(view?.drafts ?? [])].find(item => item.id === selection.irId && item.projectId === selection.projectId);
  if (!group || selection.srId) return null;
  const started = view?.srs.some(sr => sr.irId === group.id && sr.status !== "pending");
  const prohibition = group.merge || group.status === "frozen" || started ? "已入库的正式提案和开发历史保留展示；可选择草稿演示移除操作。" : undefined;
  const remove = async () => {
    if (targetId !== group.id || prohibition) return;
    await dev.command({ type: "deleteRequirement", version: 1, projectId: group.projectId, irId: group.id });
    setTargetId(undefined);
  };
  return <>
    <Button size="sm" variant="outline" data-testid="delete-requirement" disabled={!!prohibition} title={prohibition} onClick={() => setTargetId(group.id)}>删除需求</Button>
    <AlertDialog open={targetId === group.id} onOpenChange={open => { if (!open) setTargetId(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>移除样例需求“{group.title}”？</AlertDialogTitle>
          <AlertDialogDescription>仅从本次前端演示的列表移除样例需求。不会操作文件、Git、真实 PR 或 OMP 会话；刷新页面后恢复原始样例。</AlertDialogDescription>
        </AlertDialogHeader>
        {dev.error && <p role="alert" className="text-sm text-destructive">{dev.error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="delete-requirement-cancel">取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" data-testid="delete-requirement-confirm" onClick={event => { event.preventDefault(); void remove(); }}>移除本地样例</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
