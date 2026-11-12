import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function V4NativeBrowserAction({ prompt, action, interactionId, execute, cancel, resolve }: {
  prompt: string;
  action: string;
  interactionId: string;
  execute(): Promise<Record<string, unknown>>;
  resolve(answer: { action: "accept" | "cancel"; content?: Record<string, unknown> }): Promise<boolean>;
  cancel?(result: Record<string, unknown> | null): Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const result = useRef<Record<string, unknown> | null>(null);
  const submit = useCallback(async (cancelled: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // Execute synchronously up to its first await to preserve the user's browser gesture.
      if (!cancelled && result.current === null) result.current = await execute();
      if (cancelled && (result.current !== null || action === "liveAnswer" || action === "liveStop"))
        await cancel?.(result.current);
      const accepted = await resolve(cancelled
        ? { action: "cancel" }
        : { action: "accept", content: result.current ?? {} });
      if (!accepted && cancel) {
        await cancel(result.current);
        result.current = null;
      }
      if (!accepted) throw new Error("The native command did not accept the browser action result");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      inFlight.current = false;
      setBusy(false);
    }
  }, [execute, cancel, resolve, action]);
  const automaticStopStarted = useRef(false);
  useEffect(() => {
    if ((action === "recordStop" || action === "liveStop") && !automaticStopStarted.current) {
      automaticStopStarted.current = true;
      void submit(false);
    }
  }, [action, submit]);
  return (
    <section role="dialog" aria-busy={busy} data-testid="v4-native-browser-action"
      data-native-action={action} data-interaction-id={interactionId}
      className="rounded-xl border border-card-border bg-card p-4">
      <p className="mb-3 whitespace-pre-wrap text-ui-base">{prompt}</p>
      <div className="flex gap-2">
        <Button type="button" disabled={busy} data-testid="v4-native-browser-action-accept"
          onClick={() => void submit(false)}>{intl.formatMessage({ id: "common.confirm" })}</Button>
        <Button type="button" variant="outline" disabled={busy} data-testid="v4-native-browser-action-cancel"
          onClick={() => void submit(true)}>{intl.formatMessage({ id: "common.cancel" })}</Button>
      </div>
      {error ? <p role="alert" className="mt-2 text-ui-sm text-destructive">{error}</p> : null}
    </section>
  );
}
