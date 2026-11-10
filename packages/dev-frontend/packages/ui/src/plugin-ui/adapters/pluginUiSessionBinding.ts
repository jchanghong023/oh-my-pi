import type {
  PluginUiSessionActions,
  PluginUiSessionCommandPort,
} from "@/plugin-ui/contract.js";

/** 会话动作统一翻译 ACK；状态与发送配置始终由原会话入口管理。 */
export function createPluginUiSessionActions(
  port: PluginUiSessionCommandPort,
): PluginUiSessionActions {
  return {
    async sendFollowUp({ prompt, source }) {
      const result = await port.sendText(prompt, { source });
      // 修复：原发送入口正常 ACK 后返回 undefined；不能把已发送消息误报为失败。
      if (result === "blocked" || result === "confirmationRequired")
        throw new Error("Session is not ready to accept input");
    },
  };
}
