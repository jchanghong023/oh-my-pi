import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ChatMediaAttachmentPreviewTarget {
  filename: string;
  mediaType: string;
  url?: string;
  textContent?: string;
}

export function ChatMediaAttachmentPreviewDialog({
  attachment,
  open,
  onOpenChange,
  loading = false,
  error = false,
}: {
  attachment: ChatMediaAttachmentPreviewTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading?: boolean;
  error?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const isVideo = attachment?.mediaType.startsWith("video/") === true;
  const [videoState, setVideoState] = useState<"loading" | "ready" | "unsupported">("loading");
  useEffect(() => {
    setVideoState("loading");
  }, [attachment?.mediaType, attachment?.url, open]);
  const title = intl.formatMessage({
    id: "chat.attachments.preview.title",
  });
  const loadingLabel = intl.formatMessage({
    id: isVideo
      ? "chat.attachments.preview.videoLoading"
      : "chat.attachments.preview.loading",
  });
  const unavailableLabel = intl.formatMessage({
    id: isVideo
      ? "chat.attachments.preview.videoUnavailable"
      : "chat.attachments.preview.unavailable",
  });
  const unsupportedVideoLabel = intl.formatMessage({
    id: "chat.attachments.preview.videoUnsupported",
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-xl max-w-5xl gap-0 overflow-hidden p-0" showCloseButton>
        <DialogHeader className="gap-1 border-b border-popover-border px-4 py-3 pr-12">
          <DialogTitle className="truncate">{attachment?.filename ?? title}</DialogTitle>
          <DialogDescription className="truncate text-ui-base">
            {attachment?.mediaType ?? title}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[72vh] min-h-64 items-center justify-center bg-background-alt p-4">
          {attachment?.textContent !== undefined ? (
            <pre
              data-text-attachment-preview="true"
              className="max-h-[calc(72vh-2rem)] w-full overflow-auto whitespace-pre-wrap break-words p-4 font-sans text-ui-base text-foreground"
            >
              {attachment.textContent}
            </pre>
          ) : attachment?.url ? (
            isVideo ? (
              videoState === "unsupported" ? (
                <p
                  className="max-w-xl px-6 text-center text-ui-base text-muted-foreground"
                  role="alert"
                >
                  {unsupportedVideoLabel}
                </p>
              ) : (
                <>
                  {videoState === "loading" ? (
                    <p className="text-ui-base text-muted-foreground" role="status">
                      {loadingLabel}
                    </p>
                  ) : null}
                  {/* MIME 可发送不代表当前 Chromium 能解码容器或 codec；
                  media error 只收口预览状态，不能反向修改附件或发送事实。 */}
                  <video
                    controls
                    playsInline
                    className={`max-h-[calc(72vh-2rem)] max-w-full rounded-lg ${
                      videoState === "loading" ? "invisible absolute" : ""
                    }`}
                    src={attachment.url}
                    onLoadedMetadata={() => setVideoState("ready")}
                    onError={() => setVideoState("unsupported")}
                  />
                </>
              )
            ) : (
              <img
                alt={attachment.filename}
                className="max-h-[calc(72vh-2rem)] max-w-full rounded-lg object-contain"
                src={attachment.url}
              />
            )
          ) : error ? (
            <p className="px-6 text-center text-ui-base text-destructive" role="alert">
              {unavailableLabel}
            </p>
          ) : loading ? (
            <p className="text-ui-base text-muted-foreground" role="status">
              {loadingLabel}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
