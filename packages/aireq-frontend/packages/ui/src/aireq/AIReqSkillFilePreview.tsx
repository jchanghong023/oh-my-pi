import { parseAgentFrontmatter, splitMarkdownFrontmatter } from "@zcode/shared";
import { AIReqMarkdownDocument } from "./AIReqMarkdownDocument.js";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import { Button } from "@/components/ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

/** 元数据与正文分别展示；保存仍使用后端返回的完整原文件，不重写内容。 */
export function AIReqSkillFilePreview({ file, workspacePath }: {
  file: { path: string; content: string };
  workspacePath: string;
}) {
  const theme = useZCodeStore(state => state.theme);
  const codePreviewSettings = useZCodeStore(state => state.codePreviewSettings);
  if (!file.path.endsWith(".md")) return (
    <CodeBlock code={file.content} language={file.path.endsWith(".json") ? "json" : "text"} appTheme={theme} wrapLongLines>
      <CodeBlockHeader displayFile={file.path} language={file.path.endsWith(".json") ? "json" : "text"} showCopyButton={false} />
    </CodeBlock>
  );
  const { body, frontmatter } = splitMarkdownFrontmatter(file.content);
  const metadata = frontmatter === undefined ? undefined : parseAgentFrontmatter(frontmatter).values;
  return <div className="space-y-4">
    {frontmatter !== undefined && <div className="space-y-2 border-b border-border pb-3">
      {typeof metadata?.name === "string" && <p className="break-all font-mono text-ui-sm text-foreground">{metadata.name}</p>}
      {typeof metadata?.description === "string" && <p className="text-ui-sm leading-6 text-foreground-subtle">{metadata.description}</p>}
      <Collapsible>
        <CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm" className="px-0 text-foreground-subtle">查看原始元数据</Button></CollapsibleTrigger>
        <CollapsibleContent>
          <CodeBlock code={frontmatter} language="yaml" appTheme={theme} wrapLongLines>
            <CodeBlockHeader displayFile="Frontmatter" language="yaml" showCopyButton={false} />
          </CodeBlock>
        </CollapsibleContent>
      </Collapsible>
    </div>}
    <AIReqMarkdownDocument theme={theme} codePreviewSettings={codePreviewSettings} showExportActions={false} workspacePath={workspacePath}>{body}</AIReqMarkdownDocument>
  </div>;
}
