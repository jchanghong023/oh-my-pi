import type { IFileWatcherService } from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useNativeHostAvailable } from "@/hooks/useBackendBusinessAvailability.js";

/** A resolved host admits subscriptions; native project watches remain server-scoped. */
export function useFileWatchingAvailable(
  fileWatcherService: IFileWatcherService,
  enabled = true,
): boolean {
  const contextServices = useOptionalServices();
  const nativeHostAvailable = useNativeHostAvailable();
  const modelSelectionService = useRemoteWorkspaceSessionStore((state) => {
    if (contextServices?.fileWatcherService === fileWatcherService) {
      return contextServices.modelSelectionService;
    }
    if (state.baseServices?.fileWatcherService === fileWatcherService) {
      return state.baseServices.modelSelectionService;
    }
    return Object.values(state.sessionsById).find(
      (session) => session.services.fileWatcherService === fileWatcherService,
    )?.services.modelSelectionService ?? null;
  });
  const read = useModelSelectionServiceView(modelSelectionService, enabled);
  return enabled && read.state.status === "ready" &&
    !read.state.refreshError &&
    (nativeHostAvailable || read.state.view.nativeSession === undefined);
}
