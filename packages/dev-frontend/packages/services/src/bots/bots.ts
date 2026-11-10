import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ZCodeConfigOption,
  ZCodeProvider,
  BotContextState,
  BotInboundMessage,
  BotOutboundMessage,
  BotProvider,
  BotProviderCallbackResult,
  BotServiceStatus,
  BotWorkspaceRef,
  BotsConfigFile,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type { ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";

export interface BotListWorkspaceRefsParams {
  currentWorkspace?: BotWorkspaceRef;
}

export interface BotUserConfigOptionsParams {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: ZCodeProvider;
}

export interface BotAutomationRunWatchParams {
  /** 与该次 sendPrompt.traceId 一致，避免排队期间污染其他轮次。 */
  runId?: string;
  target: ZCodeAutomationBotDeliveryTarget;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface IBotsService {
  replyToChannel?(
    params: import("@zcode/shared").ChannelReplyHostRequest,
  ): Promise<import("@zcode/shared").ChannelReplyResult>;
  validateTopicResource?(
    params: import("#src/bots/topicResource.js").TopicResourceRequest,
  ): Promise<void>;
  readTopicResource?(
    params: import("#src/bots/topicResource.js").TopicResourceRequest,
  ): Promise<import("@zcode/shared").ZCodePromptAttachment>;
  /**
   * 将 App 全局交互偏好同步给 Bot 已持有的远端 runtime；不得为此建立新的远端连接。
   */
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
  getStatus(): Promise<BotServiceStatus>;
  getConfig(): Promise<BotsConfigFile>;
  listWorkspaceRefs(params?: BotListWorkspaceRefsParams): Promise<BotWorkspaceRef[]>;
  getUserConfigOptions(params: BotUserConfigOptionsParams): Promise<ZCodeConfigOption[]>;
  getGroupMemberNames?(params: { botId: string; chatId: string }): Promise<Record<string, string>>;
  getBotStates(): Promise<BotContextState[]>;
  retryTopicPreparation?(params: {
    botId: string;
    chatId: string;
    threadId: string;
    messageId: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
  getTopicDetails?(params: {
    botId: string;
    chatId: string;
    threadId?: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    messageCount: number;
    hasGap: boolean;
    historyEnabled: boolean;
    summaries: Array<{ checkpoint: string; text: string }>;
  }>;

  setGroupEnabled?(params: { botId: string; chatId: string; enabled: boolean }): Promise<void>;
  reconcileGroupResult?(params: {
    botId: string;
    chatId: string;
    deliveryId: string;
    threadId?: string;
    received: boolean;
  }): Promise<import("@zcode/shared").BotGroupDelivery>;
  resendGroupResult?(params: {
    botId: string;
    chatId: string;
    deliveryId: string;
    threadId?: string;
  }): Promise<import("@zcode/shared").BotGroupDelivery>;
  retryPrivateDelivery?(params: { botId: string; deliveryId: string }): Promise<void>;
  resetBotState(contextKey: string): Promise<void>;
  /** 在 automation prompt 派发前订阅终态，并把结果回推到创建它的 Bot 会话。 */
  watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void>;
  handleInboundMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  handleProviderCallback(provider: BotProvider, payload: unknown): Promise<BotOutboundMessage[]>;
  handleProviderCallbackResponse(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

export const IBotsService = createServiceDescriptor<IBotsService>(ServiceChannels.Bots);
