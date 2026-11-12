import type { Ref } from "react";

export interface ImagePreviewLeaveGuard {
  requestLeave: (leave: () => void) => void;
}

export interface ImageComposerTarget {
  /** 同步走现有附件 admission；拒绝时返回 false，不发送消息。 */
  append: (file: File) => boolean;
}
export interface ImagePreviewSurfaceProps {
  src: string;
  alt: string;
  filename?: string;
  imageTestId?: string;
  leaveGuardRef?: Ref<ImagePreviewLeaveGuard>;
  onSaved: () => void;
  onClose: () => void;
}
