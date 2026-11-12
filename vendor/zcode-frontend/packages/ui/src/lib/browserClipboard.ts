/** Copy only from an explicit user action; HTTP intranet origins lack the async Clipboard API. */
export async function writeBrowserClipboardText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") throw new Error("Clipboard access is unavailable");

  const active = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const inputSelection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection }
    : undefined;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.tabIndex = -1;
  field.style.position = "fixed";
  field.style.opacity = "0";
  field.style.pointerEvents = "none";
  // Keep the temporary selection inside the active dialog's focus trap.
  const container = active instanceof Element ? active.closest('[role="dialog"],dialog') : null;
  (container ?? document.body).append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    if (!document.execCommand("copy")) throw new Error("复制失败，请选中文字后按 Ctrl+C 复制。");
  } finally {
    field.remove();
    if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true });
    if (inputSelection && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
      && inputSelection.start !== null && inputSelection.end !== null) {
      active.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined);
    } else if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
