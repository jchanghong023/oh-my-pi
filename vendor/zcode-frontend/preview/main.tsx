import type { IPlatformService } from "@zcode/shared";
import { createRoot } from "react-dom/client";
import { Root, ZCodeIntlProvider } from "@zcode/ui";
import { createWebPlatform } from "../packages/web/src/platform/index.js";
import "../packages/web/src/styles.css";
import {
  previewProjectId,
  previewServices,
  previewUnavailableMessage,
  previewWorkspacePath,
  previewWorkspaceSwitcher,
  rejectPreviewAction,
} from "./display-data.js";

const params = new URLSearchParams(window.location.search);
const mount = document.getElementById("root")!;

// An actual narrow browser viewport activates the original mobile shell. On a
// desktop, ?mobile=1 provides that viewport using the same entry in an iframe;
// no product media queries, components or imported source files are modified.
if (params.get("mobile") === "1" && !params.has("mobileFrame")) {
  const mobileUrl = new URL(window.location.href);
  mobileUrl.searchParams.delete("mobile");
  mobileUrl.searchParams.set("mobileFrame", "1");
  const frame = document.createElement("iframe");
  frame.id = "preview-phone";
  frame.title = "ZCode 原版手机界面预览";
  frame.src = mobileUrl.href;
  mount.append(frame);
} else {
  const webPlatform = createWebPlatform();
  // Retain the source browser platform's event and UI adapters, but do not let
  // help/config/OAuth/desktop operations turn this isolated preview into a client.
  const platform: IPlatformService = {
    ...webPlatform,
    openExternal: () => { window.alert(previewUnavailableMessage); },
    openFeedback: async () => rejectPreviewAction("openFeedback"),
    openCommunity: async () => rejectPreviewAction("openCommunity"),
    canOpenCommunity: async () => false,
    selectDirectory: async () => rejectPreviewAction("selectDirectory"),
    selectFile: async () => rejectPreviewAction("selectFile"),
    selectFiles: async () => rejectPreviewAction("selectFiles"),
    connectRemote: async () => ({ success: false, error: previewUnavailableMessage }),
    startWebRemoteControl: async () => rejectPreviewAction("startWebRemoteControl"),
    stopWebRemoteControl: async () => rejectPreviewAction("stopWebRemoteControl"),
    executeDesktopCommand: async () => rejectPreviewAction("executeDesktopCommand"),
  };

  createRoot(mount).render(
    <ZCodeIntlProvider initialLocale="zh-CN" settingService={previewServices.settingService}>
      <Root
        services={previewServices}
        platform={platform}
        initialWorkspaceAbsPath={previewWorkspacePath}
        initialTaskDraft={{ projectId: previewProjectId }}
        composerClientNamespace="interface-only-preview"
        restoreSession={false}
        isDesktop={false}
        supportsSettings
        supportsEmbeddedBrowser={false}
        allowOpenWorkspace
        preferDirectoryBrowser
        allowRemoteWorkspace
        webRemoteControlFeatureEnabled
        webRemoteControlWorkspaceSwitcher={previewWorkspaceSwitcher}
        initialWebRemoteControlMobileNavigationIntent={params.get("view") === "chat" ? "chat" : undefined}
      />
    </ZCodeIntlProvider>,
  );
}
