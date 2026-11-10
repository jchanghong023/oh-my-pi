/** GenUI 与宿主 renderer 共用的沙箱句柄、资源安全策略和平台端口。 */

/** 沙箱页面提交图片的共享白名单及单张解码大小上限。 */
export const MCP_APPS_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MCP_APPS_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** MCP Apps 资源级 CSP（`McpUiResourceCsp`）：四类域。资源 `_meta` 为主，工具级 `_meta.ui.csp` 只在资源没有声明时兜底。 */
export interface McpToolUiCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/**
 * 资源级 `_meta["zcode/csp"]`：宿主缺省按规范块（只有 'self' 'unsafe-inline'），不放行 `'unsafe-eval'` /
 * `'wasm-unsafe-eval'`；需要 eval / WebAssembly 的资源在这里显式声明。宿主经
 * `hostCapabilities.experimental["zcode/csp"].flags` 宣告支持的键。
 */
export const MCP_APPS_CSP_RELAXATION_META_KEY = "zcode/csp";
export const MCP_APPS_CSP_RELAXATION_FLAGS = ["unsafeEval", "wasmUnsafeEval"] as const;
export type McpAppCspRelaxationFlag = (typeof MCP_APPS_CSP_RELAXATION_FLAGS)[number];
export type McpAppCspRelaxations = Partial<Record<McpAppCspRelaxationFlag, boolean>>;
export function buildMcpAppsCspExperimentalCapability(): {
  [MCP_APPS_CSP_RELAXATION_META_KEY]: { flags: McpAppCspRelaxationFlag[] };
} {
  return { [MCP_APPS_CSP_RELAXATION_META_KEY]: { flags: [...MCP_APPS_CSP_RELAXATION_FLAGS] } };
}

/**
 * 资源可声明的浏览器权限（规范草案 `UIResourceMeta.permissions` 的四键），顺序即归一化顺序。
 * 宿主：未声明一律拒绝；camera / microphone / geolocation 首次使用时原生弹框确认，clipboardWrite 按声明放行。
 */
export const MCP_APPS_RESOURCE_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "clipboardWrite",
] as const;
export type McpAppsResourcePermission = (typeof MCP_APPS_RESOURCE_PERMISSIONS)[number];
/** 规范权限键 → 插件 iframe `allow` 的 Permissions Policy 特性名。 */
export const MCP_APPS_IFRAME_ALLOW_TOKENS: Record<McpAppsResourcePermission, string> = {
  camera: "camera",
  microphone: "microphone",
  geolocation: "geolocation",
  clipboardWrite: "clipboard-write",
};
/** 与官方 SDK `buildAllowAttribute` 同形：`"camera; clipboard-write"`；没有声明返回空串。 */
export function buildMcpAppsIframeAllow(
  permissions: readonly McpAppsResourcePermission[] | undefined,
): string {
  if (!permissions?.length) return "";
  return MCP_APPS_RESOURCE_PERMISSIONS.filter((key) => permissions.includes(key))
    .map((key) => MCP_APPS_IFRAME_ALLOW_TOKENS[key])
    .join("; ");
}

/**
 * `ui://` HTML 资源自己的 `_meta`（`resources/read` 内容项优先）。`heightHint` / `minFrameHeight` 是初始高度与
 * 最小高度（px）；`showInline` 为 true 时卡片强制常驻、不进折叠区。
 */
export interface McpAppResourceMeta {
  csp?: McpToolUiCsp;
  cspRelaxations?: McpAppCspRelaxations;
  /** `_meta.ui.permissions` 声明的浏览器权限（规范四键；顺序固定、去重）。 */
  permissions?: McpAppsResourcePermission[];
  prefersBorder?: boolean;
  heightHint?: number;
  minFrameHeight?: number;
  showInline?: boolean;
  /** 资源级显式后台保留申请；缺省不保留，实际回收由宿主裁决。 */
  backgroundRetention?: boolean;
}
/** 随沙箱句柄回到 renderer 的资源级呈现信息；CSP 与放宽只在 main 生效，不回传。 */
export type PluginSandboxResourceMeta = Omit<McpAppResourceMeta, "csp" | "cspRelaxations">;

/** 宿主 renderer ↔ relay shell 之间唯一一条 MessageChannel 的名字；上面跑原始 JSON-RPC（官方 AppBridge / App）。 */
export const PLUGIN_SANDBOX_PORT_NAME = "plugin-sandbox-rpc";

/** MessagePort 的最小结构类型；宿主 renderer 的 Transport 与 relay shell 都只依赖这几个成员。 */
export interface PluginSandboxTransportPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  start?(): void;
  close(): void;
}

/** main → 宿主 renderer 的端口事件（经 preload `window.postMessage` transfer）。 */
export interface PluginSandboxPortsEvent {
  sandboxId: string;
  initId: number;
  port: PluginSandboxTransportPort;
}
/**
 * renderer 可用的沙箱平台端口，以 `IPlatformService.pluginSandbox` 可选字段挂载；web 端为 undefined，UI 据此回退。
 * 登记沙箱不在这里：它由 host 经 parentPort 完成，renderer 只拿句柄。
 */
export interface PluginSandboxPlatformPort {
  /** preload 已安装限定的沙箱原子移动适配。 */
  supportsRetainedMove?: boolean;
  /** 仅宿主操作可用；Main 校验 owner/代次后复制当前页面内容。 */
  copyImage?(input: PluginSandboxCaptureRequest): Promise<void>;
  /** 只为指定代际的 MCP guest 保持可逆后台执行；不改变窗口或其他页面的节流。 */
  setExecutionActive?(sandboxId: string, initId: number, active: boolean): Promise<void>;
  /** 宿主窗口 webContents id；prepareSandbox 用它作为 owner，main 在 will-attach 时校验。 */
  getOwnerWebContentsId(): Promise<number>;
  /**
   * 释放沙箱。带 initId 时只释放捕获的登记：新页面使用新 Agent 凭证和 sandboxId，
   * 两条 IPC 路径不同（host parentPort vs ipcMain），旧 dispose 到得晚也不能误杀新登记。
   */
  disposeSandbox(sandboxId: string, initId?: number): Promise<void>;
  consumeUserGesture(sandboxId: string): Promise<boolean>;
  onPorts(handler: (event: PluginSandboxPortsEvent) => void): () => void;
}

export interface PluginSandboxCaptureRequest {
  sandboxId: string;
  initId: number;
  captureRect: { x: number; y: number; width: number; height: number };
  viewportSize: { width: number; height: number };
}

/** host → main 登记沙箱内容的消息载荷（模式同 LocalMediaPreviewPathAuthorize*）。 */
export interface PluginSandboxRegisterRequestPayload {
  instance: import("./instance.js").McpAppInstance;
  requestId: string;
  /** 工作区隔离；旧调用允许缺省，新宿主登记须贯穿实际 workspace 范围。 */
  workspacePath?: string;
  workspaceIdentity?: string;
  ownerWebContentsId: number;
  sessionId: string;
  /** Gen UI has Host provenance and never impersonates an MCP plugin. */
  contentKind?: "gen-ui";
  pluginId?: string;
  /** 资源所属的 MCP server 运行时名；沙箱 partition 按它派生（同一 server 的页面共享一份持久存储）。 */
  serverName?: string;
  /** 沙箱登记与 renderer 内存状态路由的作用域。 */
  scopeId: string;
  html: string;
  /** 资源的有效内容安全策略。 */
  csp?: McpToolUiCsp;
  /** 资源级 `_meta["zcode/csp"]` 声明的放宽项。 */
  cspRelaxations?: McpAppCspRelaxations;
  /** 资源声明的浏览器权限；main 据此放宽 Permissions-Policy 与 iframe allow，并把权限请求交给闸门。 */
  permissions?: McpAppsResourcePermission[];
  prefersBorder?: boolean;
  /** 资源级尺寸提示，原样进句柄回给 renderer。 */
  heightHint?: number;
  minFrameHeight?: number;
  /** 资源级强制常驻标记，随句柄 resourceMeta 回 renderer。 */
  showInline?: boolean;
  backgroundRetention?: boolean;
}
/** host 内部使用的登记输入：去掉传输层 requestId。 */
export type PluginSandboxRegisterInput = Omit<PluginSandboxRegisterRequestPayload, "requestId">;
export interface PluginSandboxHandle {
  instance: import("./instance.js").McpAppInstance;
  sandboxId: string;
  initId: number;
  shellUrl: string;
  partition: string;
  /** 资源级呈现信息（prefersBorder / heightHint / minFrameHeight / showInline）；资源没声明时省略。 */
  resourceMeta?: PluginSandboxResourceMeta;
}
export type PluginSandboxRegisterResultPayload =
  | ({ requestId: string; ok: true } & PluginSandboxHandle)
  | { requestId: string; ok: false; error: string };
