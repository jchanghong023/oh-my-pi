import { useCallback, useEffect, useRef, useState } from "react";
import type { AIReqNativePredictionAction, AIReqNativePredictionSnapshot, AIReqNativeSurfaceTarget } from "./types.js";
import { nativeSurfaceKey, sameNativeSurfaceTarget } from "./AIReqNativeSurface.js";

export function AIReqNativePredictions({ target, prediction, draft, disabled, onAction, onInsert }: {
  target?: AIReqNativeSurfaceTarget;
  prediction?: AIReqNativePredictionSnapshot | null;
  draft: string;
  disabled: boolean;
  onAction(action: AIReqNativePredictionAction): Promise<unknown>;
  onInsert(text: string): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ id: string; rank: number }>();
  const [dismissed, setDismissed] = useState<string>();
  const flight = useRef<string | undefined>(undefined);
  const shown = useRef<string | undefined>(undefined);
  const id = target && prediction && sameNativeSurfaceTarget(target, prediction.target)
    ? `${nativeSurfaceKey(target)}:${prediction.generation}` : "";
  const live = useRef({ id, draft, disabled }); live.current = { id, draft, disabled };
  const visible = Boolean(id && prediction?.choices.length && !disabled && !draft && dismissed !== id);
  const rank = selection?.id === id ? selection.rank : 0;
  useEffect(() => {
    if (!visible || !prediction || shown.current === id) return;
    shown.current = id;
    void onAction({ type: "shown", generation: prediction.generation }).catch(() => {});
  }, [visible, id, onAction, prediction]);
  const accept = useCallback(async (index: number) => {
    const choice = prediction?.choices[index];
    if (!visible || !choice || !prediction || flight.current) return;
    flight.current = id;
    try {
      const admission = await onAction({ type: "accepted", generation: prediction.generation, rank: index });
      if (typeof admission !== "object" || admission === null || !("accepted" in admission) || admission.accepted !== true) return;
      if (live.current.id !== id || live.current.draft || live.current.disabled) return;
      setDismissed(id);
      onInsert(choice);
    } catch { /* The surface displays transport errors; failed admission never inserts. */ }
    finally { if (flight.current === id) flight.current = undefined; }
  }, [id, onAction, onInsert, prediction, visible]);
  const dismiss = useCallback(() => {
    setDismissed(id);
    void onAction({ type: "cancel" }).catch(() => {});
  }, [id, onAction]);
  useEffect(() => {
    const composer = container.current?.closest('[data-testid="v4-composer"]');
    if (!composer || !visible || !prediction) return;
    const keydown = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.isComposing || key.keyCode === 229 || key.altKey || key.ctrlKey || key.metaKey || key.shiftKey ||
        !(key.target instanceof HTMLElement) || !key.target.closest('[contenteditable="true"]')) return;
      if (!["Tab", "ArrowRight", "ArrowUp", "ArrowDown", "Escape"].includes(key.key)) return;
      key.preventDefault(); key.stopImmediatePropagation();
      if (key.key === "Tab" || key.key === "ArrowRight") void accept(rank);
      else if (key.key === "Escape") dismiss();
      else setSelection({ id, rank: (rank + (key.key === "ArrowDown" ? 1 : prediction.choices.length - 1)) % prediction.choices.length });
    };
    composer.addEventListener("keydown", keydown, true);
    return () => composer.removeEventListener("keydown", keydown, true);
  }, [accept, dismiss, id, prediction, rank, visible]);
  return <div ref={container} data-testid="aireq-native-predictions" data-generation={visible ? prediction?.generation : undefined}
    className="space-y-1 px-3 text-ui-sm empty:hidden">
    {visible ? <>
      <p className="text-foreground-subtle">Tab / → 插入，不发送 · ↑ / ↓ 选择 · Esc 取消</p>
      {prediction?.choices.map((choice, index) => <button key={index} type="button"
        data-testid="aireq-native-prediction" data-rank={index} aria-pressed={rank === index}
        className="block w-full rounded-lg border border-card-border px-3 py-2 text-left hover:bg-hover aria-pressed:bg-selected"
        onMouseDown={event => event.preventDefault()} onClick={() => void accept(index)}>{choice}</button>)}
      <button type="button" data-testid="aireq-native-prediction-cancel" className="text-foreground-subtle" onClick={dismiss}>取消预测</button>
    </> : null}
  </div>;
}
