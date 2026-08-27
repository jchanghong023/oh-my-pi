---
name: authoring-hooks
description: Use when creating a new omp hook. Covers HookAPI, event catalog, blocking/overriding tool calls, and context modification.
---

# 编写 Hook

Hook 是事件驱动的拦截器，与 agent 循环并行运行。它们最适合处理横切关注点：安全策略、敏感信息脱敏、上下文裁剪、审计日志。Hook 模块通过 `pi.on(event, handler)` 注册处理器，可以在每次 LLM 调用之前阻止工具执行、覆盖工具输出，或重写消息上下文。

> **与扩展的关系：** Hook 子系统（`HookAPI`）是旧版 API。扩展运行器现在可以处理 Hook 能做的一切，甚至更多。`ExtensionAPI` 支持 Hook 事件模型以及仅限扩展的事件。新工作请使用 `ExtensionAPI`；只有在维护现有 Hook 模块时才使用 `HookAPI`。

## 工厂签名

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function myHook(omp: HookAPI): void {
  omp.on("tool_call", async (event, ctx) => {
    // intercept every tool call
  });
}
```

默认导出必须是一个函数（而不是类）。它接收一个 `HookAPI` 实例，并应在工厂执行期间注册处理器；加载器会 await 返回的 Promise，因此可以接受异步初始化。

或者，使用 `ExtensionAPI`（推荐）：

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => { /* ... */ });
}
```

## 事件目录

### 工具生命周期

| 事件 | 触发时机 | 可返回值 |
|---|---|---|
| `tool_call` | 每次工具执行之前 | `{ block?: boolean; reason?: string; input?: Record<string, unknown> }` |
| `tool_result` | 每次工具执行之后 | `{ content?; details?; isError?: boolean }` |

### 会话生命周期

| 事件 | 触发时机 | 可返回值 |
|---|---|---|
| `session_start` | 初始会话加载时 | — |
| `session_before_switch` | 切换会话之前 | `{ cancel?: boolean }` |
| `session_switch` | 切换会话之后 | — |
| `session_before_branch` | 创建会话分支之前 | `{ cancel?: boolean; skipConversationRestore?: boolean }` |
| `session_branch` | 创建会话分支之后 | — |
| `session_before_compact` | 压缩之前 | `{ cancel?: boolean; compaction?: CompactionResult }` |
| `session.compacting` | 压缩过程中（注入上下文） | `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }` |
| `session_compact` | 压缩之后 | — |
| `session_before_tree` | 树形导航之前 | `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }` |
| `session_tree` | 树形导航之后 | — |
| `session_shutdown` | 会话关闭时 | — |

### Agent / 轮次生命周期

| 事件 | 触发时机 | 可返回值 |
|---|---|---|
| `before_agent_start` | Agent 开始一轮之前 | `{ message?: { customType; content; display; details; attribution? } }` |
| `agent_start` | Agent 开始流式输出 | — |
| `agent_end` | Agent 结束流式输出 | — |
| `turn_start` | 用户→Agent 轮次开始 | — |
| `turn_end` | 用户→Agent 轮次结束 | — |
| `context` | 每次 LLM API 调用之前 | `{ messages?: Message[] }` |
| `auto_compaction_start` | 自动压缩开始 | — |
| `auto_compaction_end` | 自动压缩结束 | — |
| `auto_retry_start` | 自动重试开始 | — |
| `auto_retry_end` | 自动重试结束 | — |
| `ttsr_triggered` | TTSR（过短响应）触发 | — |
| `todo_reminder` | Todo 提醒触发 | — |

仅限扩展的事件（如 `tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`input`、`user_bash` 和 `user_python`）需要使用 `ExtensionAPI`。

## 工具调用前阻断合约

从 `tool_call` 处理器返回 `{ block: true, reason: "..." }` 以阻止执行：

```ts
omp.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash") {
    const cmd = String(event.input.command ?? "");
    if (/\brm\s+-rf\s+\//.test(cmd)) {
      return { block: true, reason: "Refusing to delete root filesystem" };
    }
  }
});
```

合约：

- 如果**任意一个**处理器返回 `{ block: true }`，执行立即停止。
- `reason` 会成为 LLM 看到的工具错误文本。
- 如果处理器**抛出异常**，工具也会被阻止（默认拒绝）。
- 最后一个非阻断返回值生效；首个 `block: true` 会短路。
- 非阻断处理器可以返回 `input` 来替换传递给工具的原始参数。处理器看不到此前的 `input` 修订，且 `computer` 调用会忽略 `input` 替换。

## 工具执行后覆盖合约

从 `tool_result` 处理器返回 `{ content, details, isError }` 以修补 LLM 看到的内容：

```ts
omp.on("tool_result", async (event, ctx) => {
  if (event.toolName === "read" && !event.isError) {
    const redacted = event.content.map(chunk => {
      if (chunk.type !== "text") return chunk;
      return {
        ...chunk,
        text: chunk.text.replace(/(?:sk|pk)-[a-zA-Z0-9]{20,}/g, "[REDACTED_API_KEY]"),
      };
    });
    return { content: redacted };
  }
});
```

合约：

- 处理器按注册顺序运行。对于 `HookAPI`，每个处理器都接收原始的工具结果事件，最后返回的覆盖值生效。
- `content` 会替换供 LLM 使用的完整内容数组。
- `details` 会替换结构化的 details 对象。
- `isError` 存在于共享的结果类型中，但 `HookToolWrapper` 不会将其传播到成功的工具结果中；工具失败时，原始错误会在处理器完成后被重新抛出。
- 工具失败时，仍会以 `isError: true` 触发 `tool_result`。

## 上下文修改合约

从 `context` 处理器返回 `{ messages: [...] }`，以便在每次 LLM API 调用之前重写消息列表：

```ts
omp.on("context", async (event, ctx) => {
  // Remove debug-only custom messages from LLM context
  const filtered = event.messages.filter(
    msg => !(msg.role === "custom" && msg.customType === "debug-only")
  );
  return { messages: filtered };
});
```

合约：

- `event.messages` 是当前累积的列表。
- 处理器按顺序运行；每个处理器都接收上一个处理器的输出。
- 返回 `undefined`（或不返回任何内容）以原样传递消息。

## 三个完整示例

### 1. rm-rf 阻断器

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function rmRfBlocker(omp: HookAPI): void {
  omp.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const cmd = String(event.input.command ?? "");
    if (!/\brm\s+-rf\s+\//.test(cmd)) return;

    // Allow if user explicitly confirms (interactive mode only)
    if (ctx.hasUI) {
      const allow = await ctx.ui.confirm(
        "Dangerous command",
        `This command deletes from root:\n${cmd}\n\nProceed?`
      );
      if (allow) return;
    }

    return { block: true, reason: "rm -rf / blocked by safety policy" };
  });
}
```

### 2. API 密钥脱敏器

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// Common API-key shapes. Not exhaustive — providers using bespoke formats
// (Anthropic `sk-ant-…`, JWT-style bearers, gateway-specific prefixes, etc.)
// need their own entries.
const SECRET_PATTERNS = [
  /\b(sk|pk)-[a-zA-Z0-9]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bghp_[a-zA-Z0-9]{36}\b/g,
  // Zhipu / GLM Coding Plan: `<id>.<secret>` (no `sk-` prefix).
  /\b[a-zA-Z0-9]{16,}\.[a-zA-Z0-9]{16,}\b/g,
  /\b[a-zA-Z0-9_-]{20,}\s*=\s*["']?[a-zA-Z0-9._/+=-]{20,}["']?/g,
];

export default function apiKeyRedactor(omp: HookAPI): void {
  omp.on("tool_result", async (event) => {
    if (event.isError) return;

    let changed = false;
    const redacted = event.content.map(chunk => {
      if (chunk.type !== "text") return chunk;
      let text = chunk.text;
      for (const pattern of SECRET_PATTERNS) {
        const next = text.replace(pattern, "[REDACTED]");
        if (next !== text) { changed = true; text = next; }
      }
      return { ...chunk, text };
    });

    if (changed) return { content: redacted };
  });
}
```

### 3. 上下文过滤器

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function contextFilter(omp: HookAPI): void {
  omp.on("context", async (event) => {
    const MAX_TOOL_OUTPUT_CHARS = 8_000;

    const trimmed = event.messages.map(msg => {
      // Truncate very large tool results to keep context manageable
      if (msg.role !== "toolResult") return msg;
      const content = msg.content.map(chunk => {
        if (chunk.type !== "text" || chunk.text.length <= MAX_TOOL_OUTPUT_CHARS) return chunk;
        return {
          ...chunk,
          text: chunk.text.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n[... truncated by context-filter hook]",
        };
      });
      return { ...msg, content };
    });

    return { messages: trimmed };
  });
}
```

## Hook 上下文中的 UI 方法

`ctx.ui` 是一个 `HookUIContext`。可用方法：

| 方法 | 描述 |
|---|---|
| `notify(message, type?)` | 显示应用内通知 |
| `setStatus(key, text)` | 设置底部状态栏文本（按键名排序） |
| `select(title, options)` | 显示选择对话框 |
| `confirm(title, message)` | 显示是/否对话框 |
| `input(title, placeholder?)` | 显示文本输入对话框 |
| `editor(title, prefill?, { signal }?, { promptStyle }?)` | 显示多行编辑器 |
| `setEditorText(text)` | 设置输入编辑器内容 |
| `getEditorText()` | 获取当前输入编辑器内容 |
| `custom(factory)` | 渲染自定义 TUI 组件 |
| `theme` | 当前主题对象 |

当希望 Enter 提交而 Shift+Enter 插入换行时，请将 `{ promptStyle: true }` 作为第四个参数传入。默认的 hook 编辑器行为将 Enter 视为换行，并通过 `app.message.followUp` 组合键（`Ctrl+Q` 或 `Ctrl+Enter`）提交。

在无头/打印/子 agent 模式下 `ctx.hasUI` 为 `false`——务必对交互式调用进行防护。

## 进一步阅读

- `docs/hooks.md` — hook 子系统内部细节、排序规则、错误传播
- `docs/extensions.md` — `ExtensionAPI`（`HookAPI` 的超集）
- `docs/skills/examples/safety-hook/` — 完整可运行的示例
