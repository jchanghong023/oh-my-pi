import { getSidePaneTabTitle } from "@/app-shell/SidePaneTabTrigger.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

export interface SidePaneTabPresentationLabels {
  fileManagerTitle?: string;
  reviewTitle: string;
  codeViewerTitle: string;
  newTabTitle?: string;
  terminalTitle: string;
  subagentTypeLabel: string;
  subagentDirectoryTitle: string;
  selectionChatTitle: string;
  planTitle: string;
}

export function getSidePaneTabSearchHint(tab: WorkspaceSidePaneTab): string {
  if (tab.type === "plan-detail") {
    return `${tab.parentSessionId} ${tab.toolCallId} plan ExitPlanMode`;
  }
  if (tab.type === "selection-side-chat") {
    return `${tab.parentSessionId} ${tab.childSessionId} ${tab.ordinal} selection side chat`;
  }
  if (tab.type === "subagent-session") {
    return `${tab.title ?? ""} ${tab.subagentType} ${tab.parentSessionId} ${tab.childSessionId}`;
  }
  if (tab.type === "subagent-directory") {
    return `${tab.rootSessionId} ${tab.parentSessionId} subagent directory`;
  }
  if (tab.type === "new-tab") return "new tab launcher";
  if (tab.type === "git") return "git diff";
  if (tab.type === "bash-output")
    return `${tab.title} terminal shell command`;
  if (tab.type === "file-manager") return `${tab.target.workspacePath} ${tab.source?.path ?? ""}`;
  return tab.source.path ?? tab.source.title;
}

export function getLocalizedSidePaneTabTitle(
  tab: WorkspaceSidePaneTab,
  labels: SidePaneTabPresentationLabels,
): string {
  return getSidePaneTabTitle(tab, (descriptor) => {
    const titleByMessageId: Record<string, string> = {
      "sidePane.newTab": labels.newTabTitle ?? "New tab",
      "fileManager.title": labels.fileManagerTitle ?? labels.codeViewerTitle,
      "sidePane.review": labels.reviewTitle,
      "codeViewer.title": labels.codeViewerTitle,
      "terminal.title": labels.terminalTitle,
      "sidePane.subagent": labels.subagentTypeLabel,
      "sidePane.subagentDirectory": labels.subagentDirectoryTitle,
      "sidePane.selectionChat": labels.selectionChatTitle,
      "planTool.panel.planTab": labels.planTitle,
    };
    return titleByMessageId[descriptor.id] ?? descriptor.id;
  });
}

export function getSidePaneTabTypeLabel(
  tab: WorkspaceSidePaneTab,
  labels: SidePaneTabPresentationLabels,
): string {
  if (tab.type === "new-tab") return labels.newTabTitle ?? "New tab";
  if (tab.type === "plan-detail") return labels.planTitle;
  if (tab.type === "selection-side-chat") return labels.selectionChatTitle;
  if (tab.type === "subagent-session") {
    return tab.subagentType.trim() || labels.subagentTypeLabel;
  }
  if (tab.type === "subagent-directory") return labels.subagentDirectoryTitle;
  if (tab.type === "file-manager") return labels.fileManagerTitle ?? labels.codeViewerTitle;
  if (tab.type === "git") return labels.reviewTitle;
  if (tab.type === "bash-output") return labels.terminalTitle;
  return labels.codeViewerTitle;
}
