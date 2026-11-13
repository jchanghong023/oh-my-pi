import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ReactElement, ReactNode } from "react";

/** Kept as a type-only contract for cards that render their own shell. */
export type OpenSplitButtonTarget =
  | {
      type: "website";
      url: string;
      localPath?: string;
      sourcePath?: string;
      workspacePath?: string;
    }
  | {
      type: "file";
      path: string;
      title: string;
      label: string;
      previewSource?: CodeViewerSource;
    };

interface OpenSplitButtonProps {
  target: OpenSplitButtonTarget;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  stopPropagation?: boolean;
  /** 整张卡片复用按钮的操作与状态。 */
  renderCard?: (
    button: ReactNode,
    actions: { handlePreview: () => void; canPreview: boolean },
  ) => ReactElement;
}

export function OpenSplitButton({
  target,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  stopPropagation = false,
  renderCard,
}: OpenSplitButtonProps) {
  const { intl } = useZCodeIntl();
  const canPreview =
    target.type === "website"
      ? Boolean(onOpenBrowserUrl)
      : Boolean(onOpenCodeViewer && target.previewSource);
  const handlePreview = () => {
    if (target.type === "website") {
      onOpenBrowserUrl?.(target.url);
      return;
    }
    if (target.previewSource) onOpenCodeViewer?.(target.previewSource);
  };
  const stop = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) event.stopPropagation();
  };
  const button = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!canPreview}
      onClick={(event) => {
        stop(event);
        handlePreview();
      }}
      onPointerDown={stop}
    >
      {intl.formatMessage({ id: "common.open" })}
    </Button>
  );
  return renderCard ? renderCard(button, { handlePreview, canPreview }) : button;
}