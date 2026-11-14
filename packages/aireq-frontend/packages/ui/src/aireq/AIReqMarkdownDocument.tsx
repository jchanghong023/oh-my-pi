import { MessageResponse, type MessageResponseProps } from "@/components/ai-elements/message.js";
import { cn } from "@/components/lib/utils.js";

/** AIReq 长文档预览统一使用 github-markdown-css 排版；聊天与工具卡片保持原生 MessageResponse。 */
export function AIReqMarkdownDocument({ className, ...props }: MessageResponseProps) {
  return <MessageResponse {...props} className={cn("aireq-markdown", className)} />;
}
