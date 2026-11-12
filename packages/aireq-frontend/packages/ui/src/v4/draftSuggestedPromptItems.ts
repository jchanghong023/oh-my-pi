export interface DraftSuggestedPromptLocalizedText {
  cn?: string;
  en?: string;
}

export interface DraftSuggestedPromptItem {
  id: string;
  /** Lucide canonical 图标名称。 */
  iconName?: string;
  label: DraftSuggestedPromptLocalizedText;
  prompt: DraftSuggestedPromptLocalizedText;
}

export function resolveDraftSuggestedPromptText(
  text: DraftSuggestedPromptLocalizedText,
  locale: string,
): string {
  const primary = locale.startsWith("zh") ? text.cn : text.en;
  const fallback = locale.startsWith("zh") ? text.en : text.cn;
  return primary?.trim() || fallback?.trim() || "";
}
