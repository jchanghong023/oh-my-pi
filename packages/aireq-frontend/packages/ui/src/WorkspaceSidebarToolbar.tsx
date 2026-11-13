import { ArrowLeft, ArrowRight, MessageCirclePlus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface WorkspaceSidebarToolbarProps {
  expanded: boolean;
  collapsible?: boolean;
  onToggle(): void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  toggleShortcut?: string;
  backShortcut?: string;
  forwardShortcut?: string;
  onCreate?: () => void;
  createLabel?: string;
  createDisabled?: boolean;
}

/** ZCode 顶栏的浏览器适配：保留原生导航按钮，不伪造桌面窗口控制。 */
export function WorkspaceSidebarToolbar({ expanded, collapsible = true, onToggle, canGoBack, canGoForward, onGoBack, onGoForward, toggleShortcut, backShortcut, forwardShortcut, onCreate, createLabel, createDisabled }: WorkspaceSidebarToolbarProps) {
  const { intl } = useZCodeIntl();
  const toggleLabel = intl.formatMessage({ id: "workspaceSidebar.toggleSidebar" });
  const backLabel = intl.formatMessage({ id: "taskNav.back" });
  const forwardLabel = intl.formatMessage({ id: "taskNav.forward" });
  const newLabel = createLabel ?? intl.formatMessage({ id: "taskList.newThread" });
  return <nav aria-label={toggleLabel} className="flex h-12 shrink-0 items-center gap-1 px-3" data-testid="workspace-sidebar-toolbar">
    {collapsible && <ControlHintTooltip title={toggleLabel} shortcut={toggleShortcut} side="bottom"><Button type="button" variant="ghost" size="icon-md" className="group relative transition-colors" aria-label={toggleLabel} aria-expanded={expanded} aria-controls="sidebar" onClick={() => onToggle()}>{expanded ? <PanelLeftClose className="size-4" /> : <><span aria-hidden="true" className="flex size-5 items-center justify-center transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"><ZCodeStartupLogoBadge size="titlebar" animated={false} /></span><PanelLeftOpen aria-hidden="true" className="absolute inset-0 m-auto size-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" /></>}</Button></ControlHintTooltip>}
    <ControlHintTooltip title={backLabel} shortcut={backShortcut} side="bottom"><Button type="button" variant="ghost" size="icon-md" className="transition-colors" aria-label={backLabel} disabled={!canGoBack || !onGoBack} onClick={() => onGoBack?.()}><ArrowLeft className="size-4" /></Button></ControlHintTooltip>
    <ControlHintTooltip title={forwardLabel} shortcut={forwardShortcut} side="bottom"><Button type="button" variant="ghost" size="icon-md" className="transition-colors" aria-label={forwardLabel} disabled={!canGoForward || !onGoForward} onClick={() => onGoForward?.()}><ArrowRight className="size-4" /></Button></ControlHintTooltip>
    {!expanded && onCreate && <ControlHintTooltip title={newLabel} side="bottom"><Button type="button" variant="ghost" size="icon-md" className="transition-colors" aria-label={newLabel} data-testid="workspace-new-session" disabled={createDisabled} onClick={() => onCreate()}><MessageCirclePlus className="size-4" /></Button></ControlHintTooltip>}
  </nav>;
}
