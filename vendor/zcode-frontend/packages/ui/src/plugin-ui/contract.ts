import type { ConversationInputSource } from "@zcode/shared/zcode-protocol-v4";

/** DOM 位置属于视图，页面实例属于窗口 owner；跨容器移动只能走保活承载层。 */
export interface SandboxPagePlacement {
  node: HTMLElement;
  kind: "flow" | "inline" | "sidebar";
  container?: HTMLElement;
  layer?: number;
}
/** 全部宿主绑定使用同一工作区身份；路径只用于执行和显示。 */
export interface PluginUiSessionScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId: string;
}

/** Session actions shared by generated-UI sandboxes. */
export interface PluginUiSessionActions {
  /** 沿用当前会话的发送配置与 admission。 */
  sendFollowUp(input: {
    prompt: string;
    source: ConversationInputSource;
  }): Promise<void>;
}

/** 适配既有 SessionPane 发送入口，不重新实现 admission / owner / ACK。 */
export interface PluginUiSessionCommandPort {
  sendText(
    prompt: string,
    options: { source: ConversationInputSource },
  ): Promise<"sent" | "blocked" | "confirmationRequired" | undefined>;
}


export function buildPluginUiSessionKey(target: PluginUiSessionScope): string {
  return JSON.stringify([
    target.workspaceIdentity?.trim() || target.workspacePath,
    target.sessionId,
  ]);
}

