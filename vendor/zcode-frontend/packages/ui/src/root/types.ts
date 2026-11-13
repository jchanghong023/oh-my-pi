import type {
  IPlatformService,
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlMobileTaskView,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlWorkspaceSwitchOptions,
  WorkspacePurpose,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { ReactNode } from "react";
import type { CreateTaskOptions } from "@/app-shell/types.js";

export interface WebRemoteControlWorkspaceSwitcherApi {
  /** 账号级设备导航由 Web 入口注入，不通过 workspace bridge/RPC 访问。 */
  deviceNavigation?: {
    deviceName?: string;
    /** 目标电脑平台（darwin / win32 / linux），来自本机记住的设备记录，只用于展示图标。 */
    devicePlatform?: string;
    chooseOtherDevice(): void;
  };
  listWorkspaces(): Promise<WebRemoteControlWorkspaceListResult>;
  openProjectDraft?(request: CreateTaskOptions): Promise<void>;
  onWorkspaceListUpdated?(
    listener: (result: WebRemoteControlWorkspaceListResult) => void,
  ): () => void;
  switchWorkspace(
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions,
  ): Promise<void>;
  /** 手机端项目侧栏确认用户查看了当前 bridge 内的未读 task；桌面任务选择链路不使用。 */
  markTaskRead?(task: WebRemoteControlTaskTarget): Promise<void>;
  updateMobileViewState?(workspaceKey: string, taskId?: string): Promise<void>;
  /** 只上报前台实际显示的任务；连接代际与 bridge 校验由 Web/Main 负责。 */
  updateMobileTaskView?(view: WebRemoteControlMobileTaskView | null): Promise<void>;
  reconnectWorkspace?(workspaceKey: string): Promise<void>;
  startDraft?(
    workspaceKey: string,
    options?: { mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent },
  ): Promise<void>;
}

export interface RootProps {
  services: IServiceAccessor;
  platform: IPlatformService;
  /** Initial local OMP workspace to open. */
  initialWorkspaceAbsPath?: string;
  /** app-owned workspace 展示分类；缺省为真实项目。 */
  initialWorkspacePurpose?: WorkspacePurpose;
  /** 桌面启动时精确 active 的本地 workspace 不可用；仅用于本次 renderer 生命周期。 */
  unavailableWorkspacePath?: string;
  /** Stable identity used to isolate local workspace state. */
  initialWorkspaceIdentity?: string;
  /** 初始要打开的 task，从全局 task 列表进入时透传 */
  initialTaskId?: string;
  /** 手机目录 admission 完成后，在 prewarm 前接收项目和输入草稿。 */
  initialTaskDraft?: CreateTaskOptions;
  /** Stable identity of the connected local OMP server. */
  composerClientNamespace?: string;
  /** Runtime identity retained for non-UI service integration. */
  isDesktop?: boolean;
  /** Opt into responsive browser presentation without enabling remote-control behavior. */
  responsiveBrowserLayout?: boolean;
  /** Backend account, Agent and configuration business bindings are available; defaults to true. */
  backendBusinessAvailable?: boolean;
  /** Native OMP host operations, independent of ZCode account/cloud capabilities. */
  nativeHostAvailable?: boolean;
  /** Display-only starting location for the project chooser, not an opened workspace. */
  /** Opens/adopts a real project and reconnects its browser binding; create is explicit only. */
  onOpenProject?: (
    path: string, create?: boolean, newSession?: boolean, showFiles?: boolean,
  ) => Promise<void>;
  /** 是否恢复上次关闭时的标签页，首个窗口 true，新窗口 false */
  restoreSession?: boolean;
  /** Whether the connected OMP settings service is available. */
  supportsSettings?: boolean;
  /** 是否允许在当前壳层里切换/新开工作区 */
  allowOpenWorkspace?: boolean;
  /** 是否优先使用服务端目录浏览器，Web 普通模式不能依赖系统目录选择框 */
  /** Initial responsive sidebar file-tree state. */
  initialSidebarFileTreeOpen?: boolean;
  /** Loading content shown while the initial workspace is being injected. */
  initialWorkspaceLoadingFallback?: ReactNode;
  /** Assistant code-comment 卡片灰度；默认关闭，关闭时保留原始 directive。 */
  assistantCodeCommentCardsEnabled?: boolean;
}

