import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  ConversationDraftSuggestedPrompts,
  type DraftSuggestedPromptItem,
} from "@/v4/ConversationDraftSuggestedPrompts.js";
import { resolveDraftSuggestedPromptText } from "@/v4/draftSuggestedPromptItems.js";
import { featureSuggestedPrompts } from "@/v4/featureSuggestedPrompts.js";
import { useDev } from "@/dev/DevContext.js";

type Props = {
  className?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  onOpenAutomations?: () => void;
};

export function ConversationDraftSuggestedPromptsContainer({
  className,
  workspacePath,
  workspaceIdentity,
  onOpenAutomations,
}: Props) {
  const { intl, locale } = useZCodeIntl();
  const dev = useDev();
  const handleSelect = (item: DraftSuggestedPromptItem) => {
    useZCodeSessionStore
      .getState()
      .requestComposerTextInsert(
        workspacePath,
        resolveDraftSuggestedPromptText(item.prompt, locale),
        workspaceIdentity,
      );
  };
  // 提案草稿用于澄清需求，不提供运行仓库、测试或编码调度快捷入口。
  if (dev?.selection.proposalDraftId) return null;

  return (
    <div
      data-v4-draft-suggested-prompts-slot="true"
      className={cn("flex min-w-0 flex-col items-center gap-2", className)}
    >
      <ConversationDraftSuggestedPrompts
        items={featureSuggestedPrompts}
        onSelect={handleSelect}
      />
      {onOpenAutomations ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => onOpenAutomations()}>
          <CalendarClock className="size-4" />
          {intl.formatMessage({ id: "workspace.openScheduledSettings" })}
        </Button>
      ) : null}
    </div>
  );
}
