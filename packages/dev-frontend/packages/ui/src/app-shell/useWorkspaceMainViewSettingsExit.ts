import { useLayoutEffect, useRef } from "react";
import type { WorkspaceMainView } from "@/app-shell/types.js";

export function useWorkspaceMainViewSettingsExit({
  isWorkspaceVisible,
  workspaceMainView,
  onExitSettings,
}: {
  isWorkspaceVisible: boolean;
  workspaceMainView: WorkspaceMainView;
  onExitSettings: () => void;
}) {
  const wasWorkspaceVisibleRef = useRef(isWorkspaceVisible);
  const settingsEntryMainViewRef = useRef(workspaceMainView);

  useLayoutEffect(() => {
    const wasWorkspaceVisible = wasWorkspaceVisibleRef.current;
    wasWorkspaceVisibleRef.current = isWorkspaceVisible;

    if (wasWorkspaceVisible && !isWorkspaceVisible) {
      settingsEntryMainViewRef.current = workspaceMainView;
      return;
    }

    if (!wasWorkspaceVisible && isWorkspaceVisible) {

      if (workspaceMainView === settingsEntryMainViewRef.current) {
        // Settings covers the workspace without unmounting it; return to chat on exit.
        onExitSettings();
      }
    }
  }, [isWorkspaceVisible, onExitSettings, workspaceMainView]);

}
