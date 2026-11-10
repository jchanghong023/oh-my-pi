import { useCallback, useMemo, useRef, type ComponentType } from "react";
import RawAnsi from "ansi-to-react";
import type {
  DevNativeSurfaceTarget, DevNativeUiStateEvent, DevNativePredictionSnapshot, DevNativePredictionAction,
} from "./mock/types.js";
import { devClientId, useDev } from "./DevContext.js";

const NativeText = RawAnsi as unknown as ComponentType<{ children?: string; linkify?: boolean }>;

export interface NativeSurfaceSnapshot {
  target: DevNativeSurfaceTarget;
  events: DevNativeUiStateEvent[];
  prediction?: DevNativePredictionSnapshot | null;
  editorRevisionAtRead?: number;
  editorReadyAtRead?: boolean;
}
export function nativeSurfaceKey(target: DevNativeSurfaceTarget): string {
  return JSON.stringify([target.projectId, target.irId, target.srId ?? null, target.sessionId, target.phase, target.round, target.clientId]);
}
export function sameNativeSurfaceTarget(a: DevNativeSurfaceTarget, b: DevNativeSurfaceTarget): boolean {
  return nativeSurfaceKey(a) === nativeSurfaceKey(b);
}

/** The phase-one prototype preserves the original composer without native UI injection or I/O. */
export function useDevNativeSurface(sessionId: string | null | undefined, workspaceIdentity?: string) {
  const dev = useDev();
  const session = dev?.session;
  const target = useMemo<DevNativeSurfaceTarget | undefined>(() => {
    if (workspaceIdentity?.startsWith("omp-dev-collab:") || !session || session.sessionId !== sessionId) return;
    return { projectId: session.projectId, irId: session.irId, srId: session.srId,
      sessionId: session.sessionId, phase: session.phase, round: session.round, clientId: devClientId };
  }, [sessionId, workspaceIdentity, session?.projectId, session?.irId, session?.srId, session?.sessionId, session?.phase, session?.round]);
  const editorRevision = useRef(0);
  const editorText = useRef("");
  const updateEditor = useCallback((text: string) => {
    if (text !== editorText.current) { editorText.current = text; editorRevision.current += 1; }
  }, []);
  const predictionAction = useCallback(async (_action: DevNativePredictionAction): Promise<{ accepted: boolean }> => ({ accepted: false }), []);
  const snapshot = useMemo<NativeSurfaceSnapshot | undefined>(() => target ? {
    target, events: [], prediction: null, editorRevisionAtRead: editorRevision.current, editorReadyAtRead: true,
  } : undefined, [target]);
  return { target, key: target ? nativeSurfaceKey(target) : "", snapshot,
    error: undefined, updateEditor, predictionAction, editorRevision };
}

export function DevNativeSurface({ target, events, error, placement = "aboveEditor" }: {
  target?: DevNativeSurfaceTarget; events?: DevNativeUiStateEvent[]; error?: string;
  placement?: "aboveEditor" | "belowEditor";
}) {
  if (!target) return null;
  const current = (events ?? []).filter(event => sameNativeSurfaceTarget(event.target, target));
  const widgets = new Map<string, Extract<DevNativeUiStateEvent, { method: "setWidget" }>>();
  const statuses = new Map<string, string>();
  let working: string | undefined;
  let title: string | undefined;
  for (const event of current) {
    if (event.method === "setWidget") widgets.set(event.value.key, event);
    else if (event.method === "setStatus") {
      if (event.value.text === undefined) statuses.delete(event.value.key); else statuses.set(event.value.key, event.value.text);
    } else if (event.method === "setWorkingMessage") working = event.value;
    else if (event.method === "setTitle") title = event.value;
  }
  return (
    <section data-testid="dev-native-surface" data-session-id={target.sessionId} data-phase={target.phase} data-round={target.round}
      data-placement={placement} className="space-y-2 text-ui-sm empty:hidden">
      {placement === "aboveEditor" && title ? <p data-testid="dev-native-title" className="font-medium"><NativeText linkify={false}>{title}</NativeText></p> : null}
      {[...widgets.values()].filter(event => (event.value.options?.placement ?? "aboveEditor") === placement && event.value.content !== undefined).map(event => (
        <div key={event.value.key} data-testid="dev-native-widget" data-widget-key={event.value.key}
          className="whitespace-pre-wrap rounded-xl border border-card-border bg-card px-3 py-2 font-mono">
          <NativeText linkify={false}>{event.value.content?.join("\n")}</NativeText>
        </div>
      ))}
      {placement === "belowEditor" ? <>
        {working ? <p role="status" data-testid="dev-native-working"><NativeText linkify={false}>{working}</NativeText></p> : null}
        {[...statuses].map(([name, text]) => <p key={name} role="status" data-testid="dev-native-status" data-status-key={name}><NativeText linkify={false}>{text}</NativeText></p>)}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      </> : null}
    </section>
  );
}
