import { useRef, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { TabsTrigger } from "@/components/ui/tabs.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { Button } from "@/components/ui/button.js";
import {
  BotIcon,
  FileIcon,
  ListTreeIcon,
  MessageSquareTextIcon,
  NotepadTextIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { SidePaneTabTitleTooltip } from "@/app-shell/SidePaneTabTitleTooltip.js";

// tab 默认按 156px 等宽排列；空间不足时以相同 grow/shrink 参数平均收缩到 60px，
// 之后由外层滚动容器承接溢出，避免标题长度改变每个 tab 的宽度。
// 标题没有独立上限时，长网页标题会持续撑宽 tab；主 tab 与拖拽浮层都只钳制标题本体，避免挤占图标、徽标和关闭按钮。
export function SortableSidePaneTabTrigger({
  tab,
  title,
  closeTabLabel,
  closeTabMenuLabel,
  closeOtherTabsLabel,
  closeAllTabsLabel,
  diffBadgeLabel,
  isActive,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  canCloseOtherTabs,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  closeTabLabel: string;
  closeTabMenuLabel: string;
  closeOtherTabsLabel: string;
  closeAllTabsLabel: string;
  diffBadgeLabel: string;
  isActive: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  canCloseOtherTabs: boolean;
}) {
  const wasDraggingRef = useRef(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  const normalizedTransform = transform
    ? {
        ...transform,
        // 横向 tabs 是固定高度控件，拖拽时只允许水平位移。
        // dnd-kit 会携带 scale 信息；这里钳回 1，避免 tab 被临时压缩或拉伸。
        scaleX: 1,
        scaleY: 1,
      }
    : null;
  const style: CSSProperties = {
    transform: CSS.Transform.toString(normalizedTransform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  if (isDragging) {
    wasDraggingRef.current = true;
  }

  const tabTrigger = (
    <TabsTrigger value={tab.id} asChild>
      <div
        ref={setNodeRef}
        data-side-pane-tab-id={tab.id}
        data-active={isActive ? "" : undefined}
        data-state={isActive ? "active" : "inactive"}
        style={style}
        {...attributes}
        {...listeners}
        onPointerDown={(event) => {
          listeners?.onPointerDown?.(event);
          // side pane tab 里有独立关闭按钮，外层不能再渲染成 button。
          // 否则会形成 button 嵌套 button，生产包里浏览器会修正 DOM，导致 tab/close/drag 事件错位。
          // 这里用 TabsTrigger asChild 承载 Radix 状态，真实 DOM 改成 div，关闭按钮继续保持原生 button。
          event.preventDefault();
        }}
        onClick={(event) => {
          // 浏览器可能同时派发 middle-click 的 click/auxclick；先在 click 阶段拦截，
          // 避免关闭前把 inactive tab 激活。
          if (event.button === 1) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          if (wasDraggingRef.current) {
            wasDraggingRef.current = false;
            event.preventDefault();
            return;
          }

          onActivateTab(tab.id);
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;

          // Side Pane tab 之前只有左键激活和显式关闭按钮，middle-click 会触发
          // 浏览器默认自动滚动，且部分浏览器还会先触发 tab 激活。统一在 auxclick 阶段
          // 取消默认行为并关闭目标 tab，保持原 active tab 不变。
          event.preventDefault();
          event.stopPropagation();
          onCloseTab(tab.id);
        }}
        className={cn(
          "group relative inline-flex items-center gap-1 [corner-shape:superellipse(1.5)]",
          "flex-[1_1_9.75rem] !h-7 min-w-15 max-w-39 justify-start overflow-hidden rounded-md border px-1.5 pr-2 text-ui-base font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring",
          "!border-transparent !bg-transparent text-foreground-subtle !rounded-lg",
          "hover:text-foreground",
          !isActive && "hover:!bg-hover",
          // TabsTrigger asChild 经过 ContextMenuTrigger 再包一层后，Radix 的 active 标记不会稳定落到真实 tab div。
          // 这里用受控的 isActive 同步补齐 data-active / data-state，保证 Tailwind 的 active variant 能命中。
          "data-active:!bg-selected data-active:text-foreground data-active:shadow-[0_1px_2px_-1px_rgb(0_0_0/0.08)]",
          "cursor-default",
          isDragging && "cursor-grabbing shadow-md",
        )}
      >
        <SidePaneTabItemContent
          tab={tab}
          title={title}
          diffBadgeLabel={diffBadgeLabel}
          closeVisible={isActive}
          revealCloseOnHover
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={closeTabLabel}
          className={cn(
            "absolute right-1 top-1/2 -translate-y-1/2 rounded-md",
            !isActive &&
              "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCloseTab(tab.id);
          }}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
    </TabsTrigger>
  );

  return (
    <ContextMenu>
      <SidePaneTabTitleTooltip isDragging={isDragging} title={title}>
        <ContextMenuTrigger asChild>{tabTrigger}</ContextMenuTrigger>
      </SidePaneTabTitleTooltip>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={() => onCloseTab(tab.id)}>{closeTabMenuLabel}</ContextMenuItem>
        <ContextMenuItem disabled={!canCloseOtherTabs} onSelect={() => onCloseOtherTabs(tab.id)}>
          {closeOtherTabsLabel}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCloseAllTabs}>{closeAllTabsLabel}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function SidePaneTabDragOverlay({
  tab,
  title,
  diffBadgeLabel,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  diffBadgeLabel: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex !h-7 w-39 min-w-15 max-w-39 items-center justify-start gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-selected px-1.5 pr-1 text-ui-base font-medium text-foreground shadow-md",
        "cursor-grabbing [corner-shape:superellipse(1.5)]",
      )}
    >
      <SidePaneTabItemContent tab={tab} title={title} diffBadgeLabel={diffBadgeLabel} />
    </div>
  );
}

function SidePaneTabItemContent({
  tab,
  title,
  diffBadgeLabel,
  closeVisible = false,
  revealCloseOnHover = false,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  diffBadgeLabel: string;
  closeVisible?: boolean;
  revealCloseOnHover?: boolean;
}) {
  return (
    <span
      data-side-pane-tab-content=""
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-var(--tab-fade-offset)-0.5rem),transparent_calc(100%-var(--tab-fade-offset)))]",
        closeVisible ? "[--tab-fade-offset:1.25rem]" : "[--tab-fade-offset:0px]",
        revealCloseOnHover &&
          "group-hover:[--tab-fade-offset:1.25rem] group-focus-within:[--tab-fade-offset:1.25rem]",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <SidePaneTabIcon tab={tab} />
      </span>
      <span data-side-pane-tab-title="" className="shrink-0 whitespace-nowrap">
        {title}
      </span>
    </span>
  );
}


export function SidePaneTabIcon({ tab }: { tab: WorkspaceSidePaneTab }) {
  // plan-detail tab 由 switch-mode（ExitPlanMode）工具调用卡片打开，来源卡片
  // 用 NotepadTextIcon；tab 必须与来源一致，避免点击后图标跳变。不用 ListChecksIcon：
  // 那会与状态面板 Todo section 撞图标，语义上也偏向 todo 而非计划方案文档。
  if (tab.type === "plan-detail") {
    return <NotepadTextIcon className="size-3.5" />;
  }
  if (tab.type === "selection-side-chat") {
    return <MessageSquareTextIcon className="size-3.5" />;
  }
  if (tab.type === "subagent-session") {
    return <BotIcon className="size-3.5" />;
  }

  if (tab.type === "subagent-directory") {
    return <ListTreeIcon className="size-3.5" />;
  }

  if (tab.type === "new-tab") return <FileIcon className="size-3.5" />;

  if (tab.type === "bash-output") {
    return <SquareTerminalIcon className="size-3.5" />;
  }

  const exhaustive: never = tab;
  return exhaustive;
}

export function getSidePaneTabTitle(
  tab: WorkspaceSidePaneTab,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
): string {
  if (tab.type === "plan-detail") {
    return formatMessage({ id: "planTool.panel.planTab" });
  }
  if (tab.type === "selection-side-chat") {
    return `${formatMessage({ id: "sidePane.selectionChat" })} ${tab.ordinal}`;
  }
  if (tab.type === "subagent-session") {
    return tab.title?.trim() || formatMessage({ id: "sidePane.subagent" });
  }

  if (tab.type === "subagent-directory") {
    return formatMessage({ id: "sidePane.subagentDirectory" });
  }
  if (tab.type === "new-tab") return formatMessage({ id: "sidePane.newTab" });

  if (tab.type === "bash-output") {
    return tab.title || formatMessage({ id: "terminal.title" });
  }
  const exhaustive: never = tab;
  return exhaustive;
}
