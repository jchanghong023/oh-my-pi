import type { AttachmentRef, ConversationInputSource } from "@zcode/shared/zcode-protocol-v4";
import type { PluginUiImageBlock } from "./domain/pluginUiImageBlocks.js";

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
  /** images 先经会话的附件上传入口变成 AttachmentRef，再随 sendText 发送。 */
  sendFollowUp(input: {
    prompt: string;
    source: ConversationInputSource;
    images?: readonly PluginUiImageBlock[];
  }): Promise<void>;
}

/** 适配既有 SessionPane 发送入口，不重新实现 admission / owner / ACK。 */
export interface PluginUiSessionCommandPort {
  sendText(
    prompt: string,
    options: { source: ConversationInputSource; attachments?: AttachmentRef[] },
  ): Promise<"sent" | "blocked" | "confirmationRequired" | undefined>;
  /** 内联图片 → 会话附件引用（走 v4 attachmentPut，与 composer 粘贴截图同一条链路）。 */
  uploadAttachment(input: {
    fileName: string;
    mime: string;
    dataBase64: string;
  }): Promise<AttachmentRef>;
}


export function buildPluginUiSessionKey(target: PluginUiSessionScope): string {
  return JSON.stringify([
    target.workspaceIdentity?.trim() || target.workspacePath,
    target.sessionId,
  ]);
}

