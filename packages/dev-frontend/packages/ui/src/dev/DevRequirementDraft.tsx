import { useDevDataSource } from "./data-source.js";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Label } from "@/components/ui/label.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { useDev } from "./DevContext.js";
import type { DevRequirementGroup } from "./types.js";

export function DevRequirementDraft({ group }: { group: DevRequirementGroup }) {
 const source = useDevDataSource();
 if (source.mode !== "prototype" || !source.capabilities.prototypeBusiness) return null;
 const dev = useDev()!;
 const [open, setOpen] = useState(false);
 const [note, setNote] = useState("");
 const generated = group.srIds.length > 0;
 return <>
  <Button type="button" size="sm" variant="outline" data-testid="requirements-draft-open" disabled={dev.pending} onClick={() => setOpen(true)}>{generated ? "补充 IR／SR（演示）" : "生成 IR／SR（演示）"}</Button>
  <Dialog open={open} onOpenChange={setOpen}>
   <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-xl">
    <DialogHeader className="shrink-0 pr-6"><DialogTitle>{generated ? "补充 IR／SR（演示）" : "生成 IR／SR（演示）"}</DialogTitle><DialogDescription>也可直接在原聊天框描述需求。首次输入按固定模板生成 IR 和两个 SR，后续输入补充整组需求并使旧评审失效；不是 AI 语义拆分，不调用模型或写入真实文件。</DialogDescription></DialogHeader>
    <form className="flex min-h-0 flex-col gap-4 overflow-hidden" onSubmit={async event => {
     event.preventDefault();
     const result = await dev.command({ type: generated ? "supplementRequirements" : "generateRequirements", projectId: group.projectId, irId: group.id, note });
     if (result?.status === "completed") { setNote(""); setOpen(false); }
    }}>
     <div className="min-h-0 space-y-4 overflow-y-auto">
      <div className="space-y-2"><Label htmlFor={`requirements-draft-${group.id}`}>{generated ? "补充业务与验收说明" : "业务需求描述"}</Label><SettingsFormTextarea id={`requirements-draft-${group.id}`} className="max-h-[40dvh] overflow-y-auto" value={note} onChange={event => setNote(event.target.value)} rows={5} required /></div>
      {dev.error && <p role="alert" className="text-ui-sm text-destructive">{dev.error}</p>}
     </div>
     <DialogFooter className="shrink-0"><Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button><Button type="submit" data-testid="requirements-draft-save" disabled={dev.pending || !note.trim()}>{generated ? "更新需求样例" : "生成需求样例"}</Button></DialogFooter>
    </form>
   </DialogContent>
  </Dialog>
 </>;
}
