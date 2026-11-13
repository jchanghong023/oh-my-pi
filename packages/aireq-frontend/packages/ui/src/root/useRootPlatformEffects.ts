import { useAIReq } from "@/aireq/AIReqContext.js";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { CreateTaskOptions } from "@/app-shell/types.js";
import type { WorkspacePurpose } from "@zcode/shared";
import { readComposerWorkspaceScope } from "@/v4/composer/composerDraftStore.js";
import { matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { isShortcutRecordingActive } from "@/shortcuts/bindings.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";

/**
 * AIReq 只运行在浏览器宿主中：这里只保留工作区引导和 Web 键盘入口。
 * 桌面窗口菜单、deep link、通知点击、更新检查与宿主 tab 同步属于桌面启动流程，已删除。
 */
export function useRootPlatformEffects({
  initialWorkspaceAbsPath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  initialTaskDraft,
  canBootstrapInitialWorkspace = true,
  addTab,
  setIsBootstrappingInitialWorkspace,
  startDraftInWorkspace,
  startNewTaskFromActiveWorkspace,
  openWorkspace,
}: {
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  initialTaskId?: string;
  initialTaskDraft?: CreateTaskOptions;
  canBootstrapInitialWorkspace?: boolean;
  addTab: (
    workspacePath: string,
    options?: {
      workspaceIdentity?: string;
      workspacePurpose?: WorkspacePurpose;
    },
  ) => void;
  setIsBootstrappingInitialWorkspace: (value: boolean) => void;
  startDraftInWorkspace: (
    workspacePath: string,
    workspaceIdentity?: string,
    options?: CreateTaskOptions,
  ) => void;
  startNewTaskFromActiveWorkspace: (source: string) => void;
  openWorkspace: () => void;
}) {
  const didBootstrapInitialWorkspaceRef = useRef(false);
  const aireq = useAIReq();
  const aiReqTargetRef = useRef("");
  const aiReqWorkspaceRef = useRef(JSON.stringify([initialWorkspaceIdentity, initialWorkspaceAbsPath]));
  useLayoutEffect(() => {
    if (!aireq?.selectionReady || !canBootstrapInitialWorkspace || !didBootstrapInitialWorkspaceRef.current || !initialWorkspaceAbsPath) return;
    const target = JSON.stringify([initialWorkspaceAbsPath, initialWorkspaceIdentity, initialTaskId]);
    if (aiReqTargetRef.current === target) return;
    aiReqTargetRef.current = target;
    // 同项目提案共用 dir，只更新 OMP 原生活跃会话；不为 IR 再建 tab 或切目录。
    const previous = aiReqWorkspaceRef.current;
    if (previous !== JSON.stringify([initialWorkspaceIdentity, initialWorkspaceAbsPath])) {
      addTab(initialWorkspaceAbsPath, { workspaceIdentity: initialWorkspaceIdentity });
      aiReqWorkspaceRef.current = JSON.stringify([initialWorkspaceIdentity, initialWorkspaceAbsPath]);
    }
    useZCodeSessionStore.getState().setActiveTaskId(initialWorkspaceAbsPath, initialTaskId ?? null, initialWorkspaceIdentity);
  }, [aireq?.selectionReady, canBootstrapInitialWorkspace, initialWorkspaceAbsPath, initialWorkspaceIdentity, initialTaskId, addTab]);

  useEffect(() => {
    if (!canBootstrapInitialWorkspace || didBootstrapInitialWorkspaceRef.current) {
      return;
    }

    didBootstrapInitialWorkspaceRef.current = true;
    if (initialWorkspaceAbsPath) {
      const savedScope = readComposerWorkspaceScope(
        initialWorkspaceAbsPath,
        initialWorkspaceIdentity,
      );
      const draftIntent =
        initialTaskDraft ??
        (savedScope ? { projectId: savedScope.projectId } : undefined);
      addTab(
        initialWorkspaceAbsPath,
        initialWorkspaceIdentity || initialWorkspacePurpose
          ? {
              ...(initialWorkspaceIdentity ? { workspaceIdentity: initialWorkspaceIdentity } : {}),
              ...(initialWorkspacePurpose ? { workspacePurpose: initialWorkspacePurpose } : {}),
            }
          : undefined,
      );
      if (initialTaskId) {
        useZCodeSessionStore
          .getState()
          .setActiveTaskId(initialWorkspaceAbsPath, initialTaskId, initialWorkspaceIdentity);
      } else if (draftIntent || !isRendererReloadNavigation()) {
        // 没有显式 taskId 的冷启动必须进入草稿；同一 renderer reload 则保留当前会话续流资格。
        startDraftInWorkspace(initialWorkspaceAbsPath, initialWorkspaceIdentity, draftIntent);
      }
    }
    setIsBootstrappingInitialWorkspace(false);
  }, [
    addTab,
    canBootstrapInitialWorkspace,
    initialTaskId,
    initialTaskDraft,
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    setIsBootstrappingInitialWorkspace,
    startDraftInWorkspace,
  ]);

  useEffect(() => {
    function handleWindowKeydown(event: KeyboardEvent) {
      // 录制态键盘归录制器独占，避免录制期 Cmd/Ctrl+N、O 预览真实触发动作。
      if (isShortcutRecordingActive()) {
        return;
      }
      const isNewTaskShortcut = matchesPrimaryShortcut(event, "n");
      const isOpenWorkspaceShortcut = matchesPrimaryShortcut(event, "o");

      if (!isNewTaskShortcut && !isOpenWorkspaceShortcut) {
        return;
      }

      event.preventDefault();
      if (isOpenWorkspaceShortcut) {
        openWorkspace();
        return;
      }

      startNewTaskFromActiveWorkspace("web CmdOrCtrl+N");
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [openWorkspace, startNewTaskFromActiveWorkspace]);
}
