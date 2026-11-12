import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuPortal,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu.js";
import { TID_CHAT_MODEL_SELECT_GROUP, testId } from "@zcode/shared/test-ids";

const query = "(max-width: 639px)";
function subscribe(listener: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const snapshot = () => window.matchMedia(query).matches;

// 合并菜单曾只渲染名称而丢失接入标识；主行和子菜单复用同一目录字段。
function ProviderAccessBadge({ group }: { group: ModelSelectGroup }) {
  return group.labelBadge ? (
    <span
      data-provider-access-badge
      title={group.labelBadge}
      className="max-w-48 shrink-0 truncate rounded-full bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle"
    >
      {group.labelBadge}
    </span>
  ) : null;
}

export function ComposerProviderMenu({
  groups,
  group,
  label,
  providerFooter,
  onSelect,
  children,
}: {
  groups: readonly ModelSelectGroup[];
  group: ModelSelectGroup | undefined;
  label: string;
  providerFooter?: ReactNode;
  onSelect: (group: ModelSelectGroup) => void;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const narrow = useSyncExternalStore(subscribe, snapshot, () => false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ side: 9, align: -5 });
  const contents = (
    <>
      <DropdownMenuRadioGroup
        value={group?.key}
        data-composer-provider-list
        className="min-h-0 overflow-y-auto"
      >
        {groups.map((candidate) => (
            <DropdownMenuRadioItem
              key={candidate.key}
              value={candidate.key}
              aria-label={[candidate.label, candidate.labelBadge].filter(Boolean).join(" ")}
              data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, candidate.key)}
              data-model-provider-key={candidate.key}
              className="min-h-8 gap-2 pl-2 pr-8"
              onSelect={(event) => {
                event.preventDefault();
                onSelect(candidate);
                setOpen(false);
              }}
            >
              <ProviderLogo logo={candidate.logo} className="size-4 rounded-sm" />
              {/* 名称不占满剩余空间，避免把接入标签推到行尾。 */}
              <span className="min-w-0 whitespace-normal break-words">{candidate.label}</span>
              <ProviderAccessBadge group={candidate} />
            </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {providerFooter ? (
        <>
          {groups.length > 0 ? <DropdownMenuSeparator className="shrink-0 bg-border/50" /> : null}
          <div className="shrink-0">{providerFooter}</div>
        </>
      ) : null}
    </>
  );
  const title = (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {group ? <ProviderLogo logo={group.logo} className="size-4 rounded-sm" /> : null}
      <span className="truncate">{group?.label ?? "—"}</span>
      {group ? <ProviderAccessBadge group={group} /> : null}
    </span>
  );
  const triggerProps = {
    "data-testid": "composer-provider-trigger",
    "aria-label": `${label}: ${group?.label ?? "—"}`,
    disabled: !group && !providerFooter,
    className:
      "min-h-8 gap-3 data-[highlighted]:bg-menu-hover/50 data-[state=open]:bg-menu-hover/50",
  };
  if (narrow)
    return open ? (
      <>
        <DropdownMenuItem
          data-testid="composer-provider-back"
          className="shrink-0"
          onSelect={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <ChevronLeftIcon />
          {intl.formatMessage({ id: "common.back" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="shrink-0 bg-border/50" />
        {contents}
      </>
    ) : (
      <>
        <DropdownMenuItem
          {...triggerProps}
          onSelect={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          {title}
          <ChevronRightIcon className="ml-auto size-4 text-foreground-subtle" />
        </DropdownMenuItem>
        {children}
      </>
    );
  return (
    <>
      <DropdownMenuSub
        open={open}
        onOpenChange={(next) => {
          if (next && triggerRef.current) {
            const row = triggerRef.current.getBoundingClientRect();
            const menu = triggerRef.current.closest('[role="menu"]')!.getBoundingClientRect();
            // 子菜单默认锚定行的内边缘；补偿父菜单 padding/border 后外框对齐并留 4px。
            setOffset({ side: menu.right - row.right + 4, align: menu.top - row.top });
          }
          setOpen(next);
        }}
      >
        <DropdownMenuSubTrigger {...triggerProps} ref={triggerRef}>
          {title}
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent
            sideOffset={offset.side}
            alignOffset={offset.align}
            collisionPadding={12}
            className="z-[61] w-max min-w-0 max-w-(--radix-dropdown-menu-content-available-width) max-h-(--radix-dropdown-menu-content-available-height) [app-region:no-drag]"
          >
            {contents}
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
      {children}
    </>
  );
}
