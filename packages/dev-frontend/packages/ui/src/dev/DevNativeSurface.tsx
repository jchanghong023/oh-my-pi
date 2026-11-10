import { useCallback, useRef, type ComponentType } from "react";
import RawAnsi from "ansi-to-react";
import type {
  DevNativeSurfaceTarget, DevNativeUiStateEvent, DevNativePredictionSnapshot, DevNativePredictionAction,
} from "./types.js";
import { useOptionalDevDataSource } from "./data-source.js";

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

/** Neither adapter currently advertises native-surface transport. The composer remains native-chat driven. */
export function useDevNativeSurface(_sessionId: string | null | undefined, _workspaceIdentity?: string) {
  const source = useOptionalDevDataSource();
  const editorRevision = useRef(0);
  const editorText = useRef("");
  const updateEditor = useCallback((text: string) => {
    if (text !== editorText.current) { editorText.current = text; editorRevision.current += 1; }
  }, []);
  const predictionAction = useCallback(async (_action: DevNativePredictionAction): Promise<{ accepted: boolean }> => {
    throw new Error("当前数据源未接入原生预测操作。");
  }, []);
  return { target: undefined as DevNativeSurfaceTarget | undefined, key: "",
    snapshot: undefined as NativeSurfaceSnapshot | undefined,
    error: source?.capabilities.nativeSurface ? "当前 UI 未接入原生扩展界面传输。" : undefined,
    updateEditor, predictionAction, editorRevision };
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
