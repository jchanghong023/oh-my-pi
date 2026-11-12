import { useState } from "react";
import { MicIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useOptionalDevDataSource } from "./data-source.js";

interface DevSpeechInputButtonProps {
  disabled: boolean;
  onInsertText: (text: string) => boolean;
  onReturnToComposer: () => void;
}

export function DevSpeechInputButton({ disabled, onInsertText, onReturnToComposer }: DevSpeechInputButtonProps) {
  const source = useOptionalDevDataSource();
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(true);
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  if (!source?.prototype) return null;
  return <Dialog open={open} onOpenChange={next => {
    setOpen(next);
    if (next) { setRecording(true); setText(""); setError(""); }
  }}>
    <DialogTrigger asChild>
      <Button type="button" variant="ghost" size="icon-md" className="rounded-full" disabled={disabled} aria-label="语音输入" title="语音输入" data-testid="dev-speech-open"><MicIcon className="size-4" /></Button>
    </DialogTrigger>
    <DialogContent className="sm:max-w-md" onCloseAutoFocus={event => { event.preventDefault(); onReturnToComposer(); }}>
      <DialogHeader>
        <DialogTitle>语音转文字</DialogTitle>
        <DialogDescription>原型演示：不采集声音、不调用服务；后续复用 OMP 现有语音转文字能力。</DialogDescription>
      </DialogHeader>
      {recording ? <div className="flex flex-col items-center gap-4 py-6">
        <MicIcon className="size-8 text-brand" />
        <p role="status" className="text-ui-base">正在演示录音…</p>
        <Button type="button" variant="secondary" onClick={() => { setRecording(false); setText("请帮我整理这次需求的验收标准。"); }}><SquareIcon className="size-4" />停止并查看示例文字</Button>
      </div> : <div className="space-y-2">
        <label htmlFor="dev-speech-transcript" className="text-ui-sm">示例识别结果（可编辑）</label>
        <Textarea id="dev-speech-transcript" value={text} onChange={event => { setText(event.target.value); setError(""); }} className="max-h-60 min-h-28 overflow-y-auto" />
        <p className="text-ui-sm text-foreground-subtle">确认后追加到原输入框，由你手动发送。</p>
      </div>}
      {error && <p role="alert" className="text-ui-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>取消</Button>
        {!recording && <Button type="button" disabled={disabled || !text.trim()} onClick={() => {
          if (!onInsertText(text.trim())) { setError("输入框暂不可编辑，请保留文字后重试。"); return; }
          setOpen(false);
        }}>填入输入框</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
