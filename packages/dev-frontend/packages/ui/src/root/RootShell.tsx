import type { ReactNode } from "react";
import { AlertDialogHost } from "@/AlertDialogHost.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";

export function RootShell({ children }: { children: ReactNode }) {
  // 手机浏览器地址栏收放时，用动态视口高度保证底部输入区完整可见。
  return (
    <div className="relative h-dvh">
      {children}
      <AlertDialogHost />
      <ConfirmDialogHost />
    </div>
  );
}
