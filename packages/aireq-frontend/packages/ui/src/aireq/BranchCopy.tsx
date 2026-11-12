import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Snippet, SnippetCopyButton } from "@/components/ai-elements/snippet.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

export function BranchCopy({ branch, onMessage, compact = false }: { branch: string; onMessage: (message: string) => void; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!branch?.trim()) return <span role="alert" className="text-ui-sm text-destructive">开发分支缺失</span>;
  return <ControlHintTooltip title={branch} description={copied ? "已复制完整分支名" : "点击复制完整分支名"} triggerClassName="min-w-0 w-full"><span className="block min-w-0" onClick={event => event.stopPropagation()}><Snippet code={branch} className="h-8 w-full min-w-0 border-0 bg-transparent shadow-none"><SnippetCopyButton size="sm" className={`h-8 w-full min-w-0 justify-start gap-2 px-0 font-normal ${compact ? "" : "font-mono"}`} aria-label={`复制分支 ${branch}`} onCopy={() => { setCopied(true); onMessage(`已复制分支：${branch}`); }} onError={error => { setCopied(false); onMessage(`复制分支失败：${error.message}`); }}><span className="min-w-0 flex-1 truncate text-left">{compact ? (copied ? "已复制" : "复制分支") : branch}</span>{copied ? <Check aria-hidden="true" className="size-3.5 shrink-0" /> : <Copy aria-hidden="true" className="size-3.5 shrink-0 text-foreground-subtle" />}</SnippetCopyButton></Snippet></span></ControlHintTooltip>;
}
