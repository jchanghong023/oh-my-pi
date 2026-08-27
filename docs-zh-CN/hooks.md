# Hooks

本文档描述 `packages/coding-agent/src/extensibility/hooks/*` 中**当前 hook 子系统的代码**。

## Current status in runtime

默认的 CLI 运行时初始化 **extension runner** 路径。在当前的启动流程中：

- `--hook` 被视作 `--extension` 的别名（CLI 路径会被合并到 `additionalExtensionPaths`）
- 通过 `hookCapability`（例如 `.omp/hooks/pre/*.ts`）发现的 JS/TS hook 工厂会被作为扩展模块加载，使其 `pi.on(...)` 处理器绑定到运行时事件总线
- 工具由 `ExtensionToolWrapper` 包装，而不是 `HookToolWrapper`
- 上下文转换和生命周期事件通过 `ExtensionRunner` 发出

因此，本文件既描述遗留 hook 子系统的实现本身（types/loader/runner/wrapper），也描述当已发现的 hook 路径被 extension runner 加载时仍然接受的工厂形态。

## Key files

- `packages/coding-agent/src/extensibility/hooks/types.ts` — hook 上下文、事件类型和结果契约
- `packages/coding-agent/src/extensibility/hooks/loader.ts` — 模块加载和 hook 发现桥接
- `packages/coding-agent/src/extensibility/hooks/runner.ts` — 事件派发、命令查找、错误信号
- `packages/coding-agent/src/extensibility/hooks/tool-wrapper.ts` — 工具调用前/后拦截包装器
- `packages/coding-agent/src/extensibility/hooks/index.ts` — exports/re-exports

## What a hook module is

一个 hook 模块必须默认导出一个工厂：

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function hook(pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (
      event.toolName === "bash" &&
      String(event.input.command ?? "").includes("rm -rf")
    ) {
      return { block: true, reason: "blocked by policy" };
    }
  });
}
```

该工厂可以：

- 通过 `pi.on(...)` 注册事件处理器
- 通过 `pi.sendMessage(...)` 发送持久的自定义消息
- 通过 `pi.appendEntry(...)` 持久化非 LLM 状态
- 通过 `pi.registerCommand(...)` 注册斜杠命令
- 通过 `pi.registerMessageRenderer(...)` 注册自定义消息渲染器
- 通过 `pi.exec(...)` 运行 shell 命令，并通过 `pi.logger` 记录日志
- 使用注入的 Zod 兼容构建器 `pi.zod`、原生 omptype 构建器 `pi.arktype`、遗留的 `pi.typebox`，以及通过 `pi.pi` 导出包

## Discovery and loading

默认会话会加载由 `hookCapability` 通过 extension runner 发现的 JS/TS hook 工厂。`discoverExtensionPaths(configuredPaths, cwd)` 会执行：

1. 从能力注册表加载原生扩展模块
2. 从 hook 能力注册表加载可导入的 `.ts`/`.js` hook 工厂
3. 追加插件扩展入口点
4. 追加显式配置的路径

遗留的 `discoverAndLoadHooks(configuredPaths, cwd)` 辅助函数仍然存在，会执行：

1. 从能力注册表加载已发现的 hooks（`loadCapability("hooks")`）
2. 追加显式配置的路径（按绝对路径去重）
3. 调用 `loadHooks(allPaths, cwd)`

随后 `loadHooks` 会导入每个路径，并期望其导出一个 `default` 函数。

### Path resolution

`loader.ts` 按以下方式解析 hook 路径：

- 绝对路径：按原样使用
- `~` 路径：进行展开
- 相对路径：相对于 `cwd` 解析

## Event surfaces

Hook 事件在 `types.ts` 中具有强类型定义。

### Session events

- `session_start`
- `session_before_switch` → 可返回 `{ cancel?: boolean }`
- `session_switch`
- `session_before_branch` → 可返回 `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_branch`
- `session_before_compact` → 可返回 `{ cancel?: boolean; compaction?: CompactionResult }`
- `session.compacting` → 可返回 `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }`
- `session_compact`
- `session_before_tree` → 可返回 `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`
- `session_tree`
- `session_shutdown`

### Agent/context events

- `context` → 可返回 `{ messages?: Message[] }`
- `before_agent_start` → 可返回 `{ message?: { customType; content; display; details; attribution } }`
- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `auto_compaction_start`
- `auto_compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`

### Tool events (pre/post model)

- `tool_call`（执行前）→ 可返回 `{ block?: boolean; reason?: string; input?: Record<string, unknown> }`。返回 `input` 的非阻塞处理器会用（原始执行输入，而非归一化的 `event.input` 视图）替换工具将要执行的参数；当 `block` 为 `true` 时被忽略，且不应用于 `computer` 工具调用。
- `tool_result`（执行后）→ 可返回 `{ content?; details?; isError? }`

这是 hook 子系统的核心 pre/post 拦截模型。

```text
Hook tool interception flow

tool_call handlers
   │
   ├─ any { block: true }? ── yes ──> throw (tool blocked)
   │
   └─ no
      │
      ▼
   execute underlying tool
      │
      ├─ success ──> tool_result handlers can override { content, details }
      │
      └─ error   ──> emit tool_result(isError=true) then rethrow original error
```

## Execution model and mutation semantics

### 1) Pre-execution: `tool_call`

`HookToolWrapper.execute()` 在工具执行前发出 `tool_call`。

- 如果任何处理器返回 `{ block: true }`，执行将停止
- 如果处理器抛出错误，包装器将 fail-closed 并阻止执行
- 返回的 `reason` 将作为抛出的错误文本

### 2) Tool execution

在未被阻止的情况下，底层工具会正常执行。

### 3) Post-execution: `tool_result`

成功执行后，包装器会发出包含以下内容的 `tool_result`：

- `toolName`、`toolCallId`、`input`
- `content`
- `details`
- `isError: false`

如果处理器返回了覆盖：

- `content` 可以替换结果内容
- `details` 可以替换结果详情

工具执行失败时，包装器会发出 `isError: true` 且内容为错误文本的 `tool_result`，然后重新抛出原始错误。

### What hooks can mutate

- 通过 `context` 对单次调用的 LLM 上下文进行修改（`messages` 替换链）
- 通过从 `tool_call` 返回 `input` 来修改原始工具执行参数（`computer` 调用除外）
- 在工具调用成功时修改工具输出内容/详情（`tool_result` 路径）
- 通过 `before_agent_start` 注入 agent 前的消息
- 通过 `session_before_*` 和 `session.compacting` 实现取消/自定义压缩/树行为

### What hooks cannot mutate in this implementation

- `computer` 工具调用的原始参数
- 抛出工具错误后的执行延续（错误路径会重新抛出）
- 包装器行为中的最终成功/错误状态（返回的 `isError` 已声明类型，但 `HookToolWrapper` 不会应用它）

## Ordering and conflict behavior

### Discovery-level ordering

能力提供者按优先级排序（高优先级优先）。去重按 capability key 进行，首个胜出。

对于 `hooks`，capability key 为 `${type}:${tool}:${name}`。来自较低优先级提供者的被遮蔽重复项会被标记，并从有效发现列表中排除。

### Load order

`discoverAndLoadHooks` 构建一个扁平的 `allPaths` 列表，按解析后的绝对路径去重，然后 `loadHooks` 按该顺序进行迭代。
每个已发现目录内的文件顺序取决于 `readdir` 的输出；hook loader 不会执行额外的排序。

### Runtime handler order

在 `HookRunner` 内部，顺序由注册序列确定：

1. hooks 数组顺序
2. 每个 hook/event 的处理器注册顺序

按事件类型的冲突行为：

- `tool_call`：除非某个处理器阻止，否则最后返回的结果胜出；首个阻止将短路。返回的 `input`（执行参数覆盖）遵循同样的最后胜出规则；处理器无法观察到彼此的修改
- `tool_result`：最后返回的覆盖胜出（无短路）
- `context`：链式；每个处理器接收上一个处理器的消息输出
- `before_agent_start`：首个返回的消息被保留；后续消息被忽略
- `session_before_*`：跟踪最近返回的结果；`cancel: true` 将立即短路
- `session.compacting`：最近返回的结果胜出

命令/渲染器冲突：

- `getCommand(name)` 在 hooks 中返回首个匹配项（首个加载的胜出）
- `getMessageRenderer(customType)` 返回首个匹配项
- `getRegisteredCommands()` 返回所有命令（不进行去重）

## UI interactions (`HookContext.ui`)

`HookUIContext` 包含：

- `select`、`confirm`、`input`、`editor`
- `notify`
- `setStatus`
- `custom`
- `setEditorText`、`getEditorText`
- `theme` getter

`ctx` 包含 `hasUI`、`cwd`、`sessionManager`、`modelRegistry`、当前 `model`、`isIdle()`、`abort()` 和 `hasQueuedMessages()`。

在没有 UI 的情况下运行时，默认的 no-op 上下文行为为：

- `select`/`input`/`editor` 返回 `undefined`
- `confirm` 返回 `false`
- `notify`、`setStatus`、`setEditorText` 为 no-op
- `getEditorText` 返回 `""`

### Status line behavior

通过 `ctx.ui.setStatus(key, text)` 设置的 hook 状态文本会：

- 按 key 存储
- 按 key 名称排序
- 进行清理（去除 ANSI/VT 转义序列；将控制字符映射为空格；合并重复空格；进行 trim）
- 拼接并按宽度截断用于显示

## Error propagation and fallback

### Load-time

- 模块无效或缺少默认导出 → 捕获到 `LoadHooksResult.errors`
- 其他 hook 的加载继续进行

### Event-time

`HookRunner.emit(...)` 会捕获大多数事件的处理器错误，并向监听器发出 `HookError`（`hookPath`、`event`、`error`），然后继续。

`emitToolCall(...)` 则更严格：那里的处理器错误不会被吞掉；它们会向上传播给调用方。在 `HookToolWrapper` 中，这将阻止工具调用（fail-safe）。

## Realistic API examples

### Block unsafe bash commands

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd = String(event.input.command ?? "");
    if (!cmd.includes("rm -rf")) return;

    if (!ctx.hasUI) return { block: true, reason: "rm -rf blocked (no UI)" };
    const ok = await ctx.ui.confirm("Dangerous command", `Allow: ${cmd}`);
    if (!ok) return { block: true, reason: "user denied command" };
  });
}
```

### Redact tool output on post-execution

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read" || event.isError) return;

    const redacted = event.content.map((chunk) => {
      if (chunk.type !== "text") return chunk;
      return {
        ...chunk,
        text: chunk.text.replaceAll(/API_KEY=\S+/g, "API_KEY=[REDACTED]"),
      };
    });

    return { content: redacted };
  });
}
```

### Modify model context per LLM call

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("context", async (event) => {
    const filtered = event.messages.filter(
      (msg) => !(msg.role === "custom" && msg.customType === "debug-only"),
    );
    return { messages: filtered };
  });
}
```

### Register slash command with command-safe context methods

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.registerCommand("handoff", {
    description: "Create a new session with setup message",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sm) => {
          sm.appendMessage({
            role: "user",
            content: [
              { type: "text", text: "Continue from prior session summary." },
            ],
            timestamp: Date.now(),
          });
        },
      });
    },
  });
}
```

## Export surface

`packages/coding-agent/src/extensibility/hooks/index.ts` 和包子路径 `@oh-my-pi/pi-coding-agent/extensibility/hooks` 导出：

- 加载 API（`discoverAndLoadHooks`、`loadHooks`）
- runner 和 wrapper（`HookRunner`、`HookToolWrapper`）
- 所有 hook 类型
- `execCommand` re-export

包根（`@oh-my-pi/pi-coding-agent`）不会 re-export `HookAPI`；请从 hooks 子路径导入遗留的 hook 类型。
