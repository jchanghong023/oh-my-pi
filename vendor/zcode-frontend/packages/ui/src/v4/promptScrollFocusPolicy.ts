import type { InputRouting } from "@zcode/shared/zcode-protocol-v4";

export interface PromptScrollFocusPolicyInput {
  draftMode: boolean;
  inputRoutingMode: InputRouting["mode"] | null;
}

/**
 * 新 prompt 只有真正走立即发送路径时才聚焦时间线底部。
 * enqueue 表达未来意图，用户此刻可能正在阅读上文，入队不能抢走阅读位置。
 */
export function shouldFocusTimelineAfterComposerSend(input: PromptScrollFocusPolicyInput): boolean {
  if (input.draftMode) return true;
  return input.inputRoutingMode === "startNow";
}
