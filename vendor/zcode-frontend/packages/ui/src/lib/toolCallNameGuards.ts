/**
 * 少数工具名不在 `packages/shared` 的已知工具表里，identity 只会回 `unknown`，
 * 分流会掉进 raw JSON 兜底卡。这里按名字先认领它们，且必须排在 family 分流之前。
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolToken(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

interface ToolNameSource {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  raw?: unknown;
}

function matchesToolName(source: ToolNameSource, token: string): boolean {
  const rawNames = isPlainRecord(source.raw)
    ? [source.raw.toolName, source.raw.tool_name, source.raw.name]
    : [];
  return [source.toolName, source.kind, source.title, ...rawNames].some(
    (value) => normalizeToolToken(value) === token,
  );
}

/** 子代理提问（escalate）。 */
export function isEscalateToolCall(source: ToolNameSource): boolean {
  return matchesToolName(source, "escalate");
}

/** 模型目录（ListModels）：否则兜底卡会把模型面文本原样摊进聊天区。 */
export function isListModelsToolCall(source: ToolNameSource): boolean {
  return matchesToolName(source, "listmodels");
}
