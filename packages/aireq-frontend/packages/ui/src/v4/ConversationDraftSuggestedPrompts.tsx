import type { CSSProperties } from "react";
import { SquareCode } from "lucide-react";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveDraftSuggestedPromptText,
  type DraftSuggestedPromptItem,
} from "@/v4/draftSuggestedPromptItems.js";

export type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

function DraftSuggestedPromptIcon({ name }: { name?: string }) {
  return (
    <ClientSceneLucideIcon
      name={name}
      aria-hidden="true"
      className="size-4"
      strokeWidth={2}
      fallback={<SquareCode aria-hidden="true" className="size-4" strokeWidth={2} />}
    />
  );
}

interface ConversationDraftSuggestedPromptsProps {
  className?: string;
  /** 本地编程任务提示词。 */
  items?: DraftSuggestedPromptItem[];
  /** 点击后填入文本草稿，不发送任务。 */
  onSelect?: (item: DraftSuggestedPromptItem) => void;
  disabled?: boolean;
}

export function ConversationDraftSuggestedPrompts({
  className,
  items = [],
  onSelect,
  disabled = false,
}: ConversationDraftSuggestedPromptsProps) {
  const { locale } = useZCodeIntl();

  if (items.length === 0) return null;

  return (
    <div
      data-v4-draft-suggested-prompts="true"
      className={cn("w-full min-w-0 overflow-x-auto", className)}
    >
      <div
        data-v4-draft-suggested-prompts-group="true"
        className="mx-auto flex w-max items-center gap-4"
      >
        {items.map((item, index) => {
          const label = resolveDraftSuggestedPromptText(item.label, locale);
          return (
            <Button
              key={item.id}
              type="button"
              variant="outline"
              size="lg"
              data-draft-suggested-prompt={item.id}
              aria-label={label}
              title={label}
              disabled={!onSelect || disabled}
              onClick={onSelect ? () => onSelect(item) : undefined}
              className="zcode-draft-prompt-waterfall h-8 min-w-0 justify-start gap-1.5 overflow-hidden rounded-lg px-3 text-left text-ui-caption font-normal leading-4.5 text-foreground"
              style={
                {
                  "--zcode-draft-prompt-waterfall-delay": `${index * 65}ms`,
                } as CSSProperties
              }
            >
              <span
                data-draft-suggested-prompt-icon="true"
                className="flex size-4 shrink-0 items-center justify-center text-foreground opacity-70 transition-opacity group-hover/button:opacity-100 motion-reduce:transition-none"
              >
                <DraftSuggestedPromptIcon name={item.iconName} />
              </span>
              <span
                data-draft-suggested-prompt-text="true"
                className="min-w-0 max-w-64 truncate text-ui-base text-foreground opacity-70 transition-opacity group-hover/button:opacity-100 motion-reduce:transition-none"
              >
                {label}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
