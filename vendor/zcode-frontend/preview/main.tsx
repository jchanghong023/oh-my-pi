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
import { WEBGUI_SESSION_INFO_PATH, type WebGuiSessionInfo } from "./session-info.js";

const sessionInfoStatus = document.getElementById("session-info-status")!;
const sessionInfoFields = document.getElementById("session-info-fields")!;
let sessionInfoRequest = 0;

async function refreshSessionInfo() {
  const request = ++sessionInfoRequest;
  sessionInfoStatus.textContent = "正在读取会话信息…";
  sessionInfoFields.hidden = true;
  try {
    const response = await fetch(WEBGUI_SESSION_INFO_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const info: WebGuiSessionInfo = await response.json();
    if (request !== sessionInfoRequest) return;
    if (info.bound === false) {
      sessionInfoStatus.textContent = "未绑定 OMP 会话；聊天和其他业务仍为预览。";
      return;
    }
    if (info.bound !== true) throw new Error("无效的会话信息响应");
    const values = {
      cwd: info.cwd,
      name: info.sessionName || "未命名",
      id: info.sessionId,
      provider: info.model?.provider ?? "未选择模型",
      "model-id": info.model?.id ?? "未选择模型",
      "model-name": info.model?.name ?? "未选择模型",
      busy: info.busy ? "忙碌（busy）" : "空闲（idle）",
    };
    for (const [field, value] of Object.entries(values)) {
      document.getElementById(`session-info-${field}`)!.textContent = value;
    }
    sessionInfoFields.hidden = false;
    sessionInfoStatus.textContent = "仅会话信息已接入，聊天和其他业务仍为预览。";
  } catch (error) {
    if (request !== sessionInfoRequest) return;
    sessionInfoFields.hidden = true;
    sessionInfoStatus.textContent = `会话信息读取失败：${error instanceof Error ? error.message : String(error)}。请手动刷新重试。`;
  }
}

document.getElementById("session-info-refresh")!.addEventListener("click", () => { void refreshSessionInfo(); });
void refreshSessionInfo();

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
