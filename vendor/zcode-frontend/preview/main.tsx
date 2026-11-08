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
import {
  WEBGUI_PROJECTS_PATH,
  WEBGUI_SESSION_INFO_PATH,
  type WebGuiProject,
  type WebGuiProjects,
  type WebGuiSessionInfo,
} from "./session-info.js";

const params = new URLSearchParams(window.location.search);
const mount = document.getElementById("root")!;
const projectSelector = document.getElementById("project-selector") as HTMLSelectElement;
const projectInfoFields = document.getElementById("project-info-fields")!;
const sessionInfoStatus = document.getElementById("session-info-status")!;
const sessionInfoFields = document.getElementById("session-info-fields")!;
const phaseLabels = { entering: "正在进入", active: "已激活", exiting: "正在退出" };
let selectedProjectId = params.get("project") || null;
let selectedProject: WebGuiProject | undefined;
let projects: WebGuiProject[] = [];
let projectsLoaded = false;
let sessionInfoRequest = 0;

function renderProjectSelector() {
  projectSelector.replaceChildren(new Option("未选择项目", ""));
  for (const project of projects) {
    projectSelector.add(new Option(
      `${project.root} · ${project.mode === "dev" ? "Dev" : "WebGUI"} · ${phaseLabels[project.phase]}`,
      project.projectId,
    ));
  }
  if (selectedProjectId && !projects.some(project => project.projectId === selectedProjectId)) {
    projectSelector.add(new Option(
      `${selectedProject?.root ?? selectedProjectId} · ${projectsLoaded ? "已离线" : "等待确认"}`,
      selectedProjectId,
    ));
  }
  projectSelector.value = selectedProjectId ?? "";
}

function renderProjectDetails(phase: string) {
  projectInfoFields.hidden = !selectedProjectId;
  const values = {
    root: selectedProject?.root ?? "未知（未取得项目登记信息）",
    id: selectedProjectId ?? "",
    mode: selectedProject ? `${selectedProject.mode === "dev" ? "Dev" : "WebGUI"}（最近登记）` : "未知",
    phase,
  };
  for (const [field, value] of Object.entries(values)) {
    document.getElementById(`project-info-${field}`)!.textContent = value;
  }
}

function syncProjectNavigation() {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("#preview-notice nav a")) {
    const url = new URL(link.href);
    url.searchParams.delete("project");
    if (selectedProjectId) url.searchParams.set("project", selectedProjectId);
    link.href = url.href;
  }
  const frame = document.getElementById("preview-phone") as HTMLIFrameElement | null;
  if (frame) {
    const url = new URL(window.location.href);
    url.searchParams.delete("mobile");
    url.searchParams.set("mobileFrame", "1");
    if (frame.src !== url.href) frame.src = url.href;
  }
}

async function refreshProjectInfo() {
  const request = ++sessionInfoRequest;
  const projectId = selectedProjectId;
  sessionInfoStatus.textContent = "正在读取项目列表…";
  sessionInfoFields.hidden = true;
  renderProjectDetails("正在确认登记状态…");
  try {
    const response = await fetch(WEBGUI_PROJECTS_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result: WebGuiProjects = await response.json();
    if (request !== sessionInfoRequest) return;
    if (!Array.isArray(result.projects)) throw new Error("无效的项目列表响应");
    projects = result.projects;
    projectsLoaded = true;
    const project = projects.find(candidate => candidate.projectId === projectId);
    if (project) selectedProject = project;
    renderProjectSelector();
    if (!projectId) {
      sessionInfoStatus.textContent = projects.length === 0
        ? "暂无已登记项目；请先从原生终端进入 Dev 或 WebGUI。本页不会创建项目或会话。"
        : "尚未选择项目；请选择一个已登记项目。选择只影响本页，不会切换项目模式。";
      return;
    }
    if (!project) {
      renderProjectDetails("已离线（未登记或已注销）");
      sessionInfoStatus.textContent = "所选项目已离线或已注销；保留此项目选择，不会自动切换到其他项目。请手动刷新重试。";
      return;
    }
    renderProjectDetails(phaseLabels[project.phase]);
    if (project.mode === "dev" || project.phase !== "active") {
      sessionInfoStatus.textContent = `此项目由 ${project.mode === "dev" ? "Dev" : "WebGUI"} 占用，${phaseLabels[project.phase]}；不读取 WebGUI 会话信息。模式只能在原生终端切换。${project.mode === "dev" ? "请使用该项目终端输出的完整 Dev 工作台地址进入；项目列表不公开随机访问凭据。" : ""}`;
      return;
    }
    sessionInfoStatus.textContent = "正在读取所选项目的会话信息…";
    const query = new URLSearchParams({ projectId });
    const infoResponse = await fetch(`${WEBGUI_SESSION_INFO_PATH}?${query}`, { cache: "no-store" });
    if (request !== sessionInfoRequest) return;
    if (infoResponse.status === 404) {
      projects = projects.filter(candidate => candidate.projectId !== projectId);
      renderProjectSelector();
      renderProjectDetails("已离线（未登记或已注销）");
      sessionInfoStatus.textContent = "所选项目已离线或已注销；保留此项目选择，不会自动切换到其他项目。请手动刷新重试。";
      return;
    }
    if (infoResponse.status === 409) {
      renderProjectDetails("模式或阶段已变化，需刷新确认");
      sessionInfoStatus.textContent = "所选项目的模式或阶段已变化，当前不能读取 WebGUI 会话信息。请手动刷新项目列表；本页不会切换模式。";
      return;
    }
    if (!infoResponse.ok) throw new Error(`HTTP ${infoResponse.status}`);
    const info: WebGuiSessionInfo = await infoResponse.json();
    if (request !== sessionInfoRequest) return;
    if (info.bound === false) {
      sessionInfoStatus.textContent = "所选项目尚未绑定 OMP 会话；聊天和其他业务仍为预览。";
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
    sessionInfoStatus.textContent = "仅所选项目的会话信息已接入；原界面的项目、聊天、历史、工具、审批、文件及配置仍为预览，尚未接入。";
  } catch (error) {
    if (request !== sessionInfoRequest) return;
    sessionInfoFields.hidden = true;
    renderProjectDetails("读取失败，无法确认当前状态");
    sessionInfoStatus.textContent = `项目或会话信息读取失败：${error instanceof Error ? error.message : String(error)}。未切换所选项目，请手动刷新重试。`;
  }
}

function selectProject(projectId: string | null) {
  selectedProjectId = projectId;
  selectedProject = projects.find(project => project.projectId === projectId);
  const url = new URL(window.location.href);
  url.searchParams.delete("project");
  if (projectId) url.searchParams.set("project", projectId);
  window.history.replaceState(null, "", url);
  renderProjectSelector();
  syncProjectNavigation();
  void refreshProjectInfo();
}

projectSelector.addEventListener("change", () => selectProject(projectSelector.value || null));
document.getElementById("session-info-refresh")!.addEventListener("click", () => { void refreshProjectInfo(); });
window.addEventListener("popstate", () => selectProject(new URLSearchParams(window.location.search).get("project") || null));
renderProjectSelector();
syncProjectNavigation();
void refreshProjectInfo();
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
