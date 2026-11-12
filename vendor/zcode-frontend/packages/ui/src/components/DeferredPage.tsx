import { Suspense, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 加载与失败局限在目标页面，侧栏及当前会话继续由原来的 Shell 持有。 */
export function DeferredPage({ children, scope }: { children: ReactNode; scope: string }) {
  const { intl } = useZCodeIntl();
  return <ScopedErrorBoundary scope={scope} variant="panel" className="h-full min-h-0 min-w-0">
    <Suspense fallback={<div role="status" aria-live="polite" className="flex h-full min-h-0 items-center justify-center gap-2 p-6 text-ui-sm text-foreground-subtle"><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /><span>{intl.formatMessage({ id: "common.loading" })}</span></div>}>
      {children}
    </Suspense>
  </ScopedErrorBoundary>;
}
