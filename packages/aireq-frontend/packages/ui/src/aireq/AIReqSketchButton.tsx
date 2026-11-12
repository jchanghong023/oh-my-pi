import { useEffect, useRef, useState } from "react";
import { PencilRuler } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog.js";
import { decodeBase64ToArrayBuffer } from "@/lib/officeFilePreview.js";
import { useOptionalAIReqDataSource } from "./data-source.js";
import sketchHtml from "./sketch.html?raw";

interface AIReqSketchButtonProps {
  disabled: boolean;
  onAddFiles: (files: File[]) => string[];
  onReturnToComposer: () => void;
}

export function AIReqSketchButton({ disabled, onAddFiles, onReturnToComposer }: AIReqSketchButtonProps) {
  const source = useOptionalAIReqDataSource();
  const [open, setOpen] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!open) return;
    const receive = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame || event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "aireq-sketch" || !("action" in data)) return;
      if (data.action === "cancel") { setOpen(false); return; }
      if (data.action !== "submit" || !("dataBase64" in data) || typeof data.dataBase64 !== "string") return;
      try {
        const file = new File([decodeBase64ToArrayBuffer(data.dataBase64)], `sketch-${Date.now()}.png`, { type: "image/png" });
        if (disabled || onAddFiles([file]).length !== 1) throw new Error("输入框当前无法接收图片，请检查附件数量或输入状态。");
        setOpen(false);
      } catch (error) {
        frame.postMessage({ type: "aireq-sketch-error", message: error instanceof Error ? error.message : String(error) }, window.location.origin);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [open, disabled, onAddFiles]);

  if (!source) return null;
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label="画图" title="画图" data-testid="aireq-sketch-open"><PencilRuler className="size-4" /></Button>
    </DialogTrigger>
    <DialogContent
      showCloseButton={false}
      className="flex flex-col overflow-hidden"
      style={{ inset: 0, transform: "none", translate: "none", width: "100vw", height: "100dvh", maxWidth: "none", border: 0, borderRadius: 0, padding: 0, gap: 0 }}
      aria-describedby={undefined}
      onCloseAutoFocus={(event) => { event.preventDefault(); onReturnToComposer(); }}
      onInteractOutside={(event) => event.preventDefault()}
    >
      <DialogTitle className="sr-only">Sketch 画图</DialogTitle>
      <iframe ref={frameRef} title="Sketch 画图" srcDoc={sketchHtml} className="min-h-0 w-full flex-1 border-0" onLoad={() => frameRef.current?.contentWindow?.focus()} />
    </DialogContent>
  </Dialog>;
}
