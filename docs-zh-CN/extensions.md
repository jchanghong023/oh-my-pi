# 扩展

在 `packages/coding-agent` 中编写运行时扩展的主要指南。

本文档涵盖当前扩展运行时所在的位置：

- `src/extensibility/extensions/types.ts`
- `src/extensibility/extensions/runner.ts`
- `src/extensibility/extensions/wrapper.ts`
- `src/extensibility/extensions/index.ts`
- `src/modes/controllers/extension-ui-controller.ts`

有关发现路径和文件系统加载规则，请参阅 [`extension-loading.md`](./extension-loading.md)。

有关面向用户的打包扩展 CLI/功能，请参阅 [`user-facing-packages.md`](./user-facing-packages.md)。

## 什么是扩展

扩展是一个导出默认工厂函数的 TS/JS 模块。工厂函数可以同步初始化，也可以返回 promise：

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // register handlers/tools/commands/renderers
}
```

扩展可以在一个模块中组合以下所有内容：

- 事件处理器（`pi.on(...)`）
- LLM 可调用的工具（`pi.registerTool(...)`）
- 斜杠命令（`pi.registerCommand(...)`）
- 键盘快捷键和标志
- 自定义消息渲染
- 会话/消息注入 API（`sendMessage`、`sendUserMessage`、`appendEntry`）

## 运行时模型

1. 扩展被导入，其工厂函数运行。
2. 在该加载阶段，注册方法是有效的；运行时动作方法尚未初始化。
3. `ExtensionRunner.initialize(...)` 为当前模式连接实时动作/上下文。
4. 会话/代理/工具生命周期事件会发送给处理器。
5. 每个工具的执行都会被扩展拦截包装（`tool_call` / `tool_result`）。

```text
Extension lifecycle (simplified)

load paths
   │
   ▼
import module + run factory (registration only)
   │
   ▼
ExtensionRunner.initialize(mode/session/tool registry)
   │
   ├─ emit session/agent events to handlers
   ├─ wrap tool execution (tool_call/tool_result)
   └─ expose runtime actions (sendMessage, setActiveTools, ...)
```

`loader.ts` 中的重要约束：

- 在扩展加载期间调用 `pi.sendMessage()` 这类动作方法会抛出 `ExtensionRuntimeNotInitializedError`
- 先注册；通过事件/命令/工具执行运行时行为

## 快速开始

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const z = pi.zod;

  pi.setLabel("Safety + Utilities");

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Extension loaded in ${ctx.cwd}`, "info");
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      return { block: true, reason: "Blocked by extension policy" };
    }
  });

  pi.registerTool({
    name: "hello_extension",
    label: "Hello Extension",
    description: "Return a greeting",
    parameters: z.object({ name: z.string() }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}` }],
        details: { greeted: params.name },
      };
    },
  });

  pi.registerCommand("hello-ext", {
    description: "Show queue state",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`pending=${ctx.hasPendingMessages()}`, "info");
    },
  });
}
```

## 扩展 API 接口

## 1) 注册和动作（`ExtensionAPI`）

核心方法：

- `on(event, handler)`
- `registerTool`、`registerCommand`、`registerShortcut`、`registerFlag`
- `registerMessageRenderer`、`registerAssistantThinkingRenderer`
- `registerComposerShape`
- `setLabel`、`getFlag`
- `sendMessage`、`sendUserMessage`、`appendEntry`、`exec`
- `getActiveTools`、`getAllTools`、`setActiveTools`
- `getCommands`
- `getSessionName`、`setSessionName`
- `setModel`、`getThinkingLevel`、`setThinkingLevel`
- `getServiceTiers`、`setServiceTier`
- `registerProvider`
- `registerFileWriteFallback`、`registerFileDeleteFallback`
- `events`（共享事件总线）

`getServiceTiers()` 返回会话实时按系列分级映射的分离快照。`setServiceTier(family, tier)` 更改后续请求中某个系列的分级；传入 `undefined` 以清除该会话的覆盖。OpenAI 接受 `auto`、`default`、`flex`、`scale` 或 `priority`；Anthropic 接受 `priority`；Google 接受 `flex` 或 `priority`。在响应流式传输期间所做的更改不会影响该进行中的请求。

### 提供商注册

`pi.registerProvider(name, config)` 可以包含一个可选的 `usage` 字段，其中包含一个
从 `@oh-my-pi/pi-ai` 导入的 `UsageProvider`。其 `fetchUsage` 实现接收归一化后的凭证并返回归一化的 `UsageReport`；然后该结果由主机的 AuthStorage 缓存、历史记录和使用量显示处理，就像内置提供商使用量一样。

```ts
pi.registerProvider("my-provider", {
  baseUrl: "https://api.example.com/v1",
  api: "openai-completions",
  usage: {
    id: "my-provider",
    async fetchUsage(params, { fetch }) {
      const response = await fetch("https://api.example.com/usage", {
        headers: { Authorization: `Bearer ${params.credential.apiKey}` },
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { used: number; limit: number };
      return {
        provider: "my-provider",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "requests",
            label: "Requests",
            scope: { provider: "my-provider" },
            amount: { used: payload.used, limit: payload.limit, unit: "requests" },
          },
        ],
      };
    },
  },
});
```

只要该扩展注册处于激活状态，扩展使用量提供商会覆盖同名的内置提供商。`pi.unregisterProvider(name)`（以及扩展源清理）仅移除该运行时覆盖，恢复内置或已配置的使用量解析器。

在交互模式下，`input` 处理器在内置的首条消息自动标题检查之前运行。从 `input` 调用 `await pi.setSessionName(...)` 的扩展可以设置持久化的会话名称，并阻止该会话运行默认的自动生成标题。

另外还暴露了：

- `pi.logger`
- `pi.arktype`（omptype `type(...)` 模式构建器）
- `pi.zod`（由 omptype 支持的 Zod 兼容构建器）
- `pi.typebox`（旧版 TypeBox 兼容垫片）
- `pi.pi`（包导出）

### 消息传递语义

`pi.sendMessage(message, options)` 支持：

- `deliverAs: "steer"`（默认）— 中断当前运行
- `deliverAs: "followUp"` — 排队在当前运行之后运行
- `deliverAs: "nextTurn"` — 存储并在下一条用户提示时注入
- `triggerTurn: true` — 空闲时启动一轮（同时受 `deliverAs: "nextTurn"` 尊重：空闲时立即提示；在流式传输期间，排队的消息会安排一个内部延续）

`pi.sendUserMessage(content, { deliverAs })` 始终经过提示流程。省略 `deliverAs` 会在空闲时启动正常提示；在流式传输期间，省略 `deliverAs` 会将消息作为 steer 排队。将 `deliverAs` 设置为 `"followUp"` 可等到当前运行完成。

## 2) 处理器上下文（`ExtensionContext`）

处理器和工具 `execute` 接收带有以下内容的 `ctx`：

- `ui`
- `hasUI`
- `cwd`
- `sessionManager`（只读）
- `modelRegistry`、`model`
- `models`（只读模型查询 — 见下文）
- `localProtocolOptions`（可选的调用会话 `local://` 根映射，用于外部工具桥接）
- `getContextUsage()`
- `getAsyncJobSnapshot()` 返回当前会话的只读异步任务快照，当没有会话拥有该上下文时为 `null`
- `compact(...)`
- `isIdle()`、`hasPendingMessages()`、`abort()`
- `shutdown()`
- `getSystemPrompt()`
- `memory`（可选的结构化内存运行时 — 在已配置后端上进行状态/搜索/保存）
- `setInterval(fn, ms, ...args)` / `setTimeout(fn, ms, ...args)` / `clearTimer(timer)` — 托管定时器（见下文）

### 后台工作（`ctx.setInterval` / `ctx.setTimeout`）

扩展**在没有隔离的情况下与进程内联运行**。原始的 `setInterval`/`setTimeout`/分离的 promise 回调如果抛出，会在处理器分派 try/catch 之外运行，作为进程级的 `uncaughtException` 浮出，并且全局事后处理程序会将其视为致命错误 — **整个会话都会被拆除**，而不仅仅是出错的扩展。

对任何周期性或延迟的后台工作使用 `ctx.setInterval` / `ctx.setTimeout`。它们镜像平台签名，但：

- 以与处理器分派相同的隔离运行回调 — 同步抛出或被拒绝的 promise 会被记录并通过扩展错误通道报告，会话继续运行；
- 返回一个可以传递给 `ctx.clearTimer(handle)` 的句柄；
- 被 `unref`（永远不会自行让进程保持运行），并在 `session_shutdown` 时自动清除。

```ts
pi.on("session_start", async (_event, ctx) => {
  const timer = ctx.setInterval(() => {
    // A throw here is contained — it will not crash the session.
    ctx.ui.notify("tick", "info");
  }, 60_000);
  // Optional: clear it yourself; otherwise it is cleared on shutdown.
  pi.on("session_shutdown", () => ctx.clearTimer(timer));
});
```

如果改用原始的 `setInterval`/`setTimeout` 或分离的 promise，你需要自己负责隔离：在回调主体外包装你自己的 `try/catch`（未处理的抛出将会终止会话），并在 `session_shutdown` 时清除定时器。

### 模型选择（`ctx.models`）

`ctx.models` 是一个只读外观，用于以与核心相同的方式选择和比较模型：

- `list()` — 本会话可用的已认证模型。
- `current()` — 实时会话模型（惰性读取，因此反映 `/model` 切换）。
- `resolve(spec)` — 模型字符串（`provider/id`、裸 id）或角色别名（`@slow`、已配置角色）→ `Model`，尊重视设置支持的别名和与 `--model` 相同的匹配首选项。没有任何匹配时返回 `undefined`。
- `family(model)` — 用于"同一系列？"检查的不透明血统令牌（Claude 点发布共享一个令牌；Claude 和 GPT 不同）。比较它；不要持久化它（词汇表会跟踪新发布）。

```ts
// Pick a model from a different family than the current one (e.g. a cross-family reviewer).
const current = ctx.models.current();
const contrasting = ctx.models
  .list()
  .find((m) => current && ctx.models.family(m) !== ctx.models.family(current));
```

## 3) 命令上下文（`ExtensionCommandContext`）

命令处理器额外获得：

- `waitForIdle()`
- `newSession(...)`
- `switchSession(...)`
- `branch(entryId)`
- `navigateTree(targetId, { summarize })`
- `reload()`

对会话控制流使用命令上下文；这些方法被有意地与通用事件处理器分开。

## 事件接口（当前名称和行为）

规范的事件联合和有效负载类型在 `types.ts` 中。

### 会话生命周期

- `session_start`
- `session_before_switch` / `session_switch`
- `session_before_branch` / `session_branch`
- `session_before_compact` / `session.compacting` / `session_compact`
- `session_before_tree` / `session_tree`
- `session_shutdown`

可取消的预事件：

- `session_before_switch` → `{ cancel?: boolean }`
- `session_before_branch` → `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_before_compact` → `{ cancel?: boolean; compaction?: CompactionResult }`
- `session_before_tree` → `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`

### 提示和轮次生命周期

- `input`
- `before_agent_start`
- `before_provider_request`（可以替换提供商请求有效负载 — 替换由每个触发该钩子的提供商应用，除 `devin-agent` 之外的所有提供商都会触发它，而 `devin-agent` 不会触发）
- `after_provider_response`
- `context`
- `agent_start` / `agent_end` — 代理循环生命周期通知；`agent_end` 仍仅为通知
- `session_stop` — 主会话停止钩子，在 settle 之前等待；可以以 `{ continue: true, additionalContext }` 或 `{ decision: "block", reason }` 继续；连续延续次数上限为 8，且永远不会为任务/子代理会话触发
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end` — 生命周期通知；`message_end` 接收分离的消息快照，因此当扩展需要更改提供商上下文时，请使用 `tool_result` 或 `context`

### 工具生命周期

- `tool_call`（执行前，可以阻止或修改工具的 `input`；对于模型发起的调用，它在代理循环的参数准备时间触发，因此修改会被重新验证并被并发调度、执行事件、持久化的助手消息和审批关卡同时看到）
- `tool_result`（执行后，可以修补 content/details/isError）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`（可观测性）
- `tool_approval_requested` / `tool_approval_resolved`（可观测性；仅当工具需要审批且注册了审批处理器时由 `wrapper.ts` 发出）

`tool_result` 是中间件风格的：处理器按扩展顺序运行，每个都可以看到之前的修改。

### 可靠性/运行时信号

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`
- `goal_updated`
- `credential_disabled`

### MCP 通知

- `mcp_notification` — 从已连接的 MCP 服务器收到的每个 JSON-RPC 通知都会触发，在管理器对已知 list/update 方法（`notifications/tools/list_changed`、`notifications/resources/list_changed`、`notifications/resources/updated`、`notifications/prompts/list_changed`）进行自身处理之后触发。未知或服务器自定义方法也会被传递。有效负载：`{ server: string; method: string; params: unknown }`。多个扩展可以订阅；抛出异常的处理器不会阻止其他处理器触发。在任何监听器附加之前收到的通知会被缓冲（有界 FIFO，上限 100，丢弃最旧）并在第一个订阅者时排出 — 因此启动时的帧即使在扩展在 MCP 发现之后绑定也不会丢失。

将支持推送的 MCP 桥接到会话 steer：

```ts
pi.on("mcp_notification", (event) => {
  if (event.server !== "peer-bus") return;
  if (event.method !== "notifications/peer_message") return;
  const params = event.params as { from: string; text: string };
  pi.sendUserMessage(`[from ${params.from}] ${params.text}`, {
    deliverAs: "steer",
  });
});
```

运行时首先处理 JSON-RPC 传输及其自身的 list/update 刷新；处理器随后运行，可以通过 `pi.sendMessage` / `pi.sendUserMessage` 注入中途 steer。

### 用户命令拦截

- `user_bash`（用 `{ result }` 覆盖）
- `user_python`（用 `{ result }` 覆盖）

### `resources_discover`

`resources_discover` 存在于扩展类型和 `ExtensionRunner` 中。
当前运行时说明：`ExtensionRunner.emitResourcesDiscover(...)` 已实现，但当前代码库中没有 `AgentSession` 调用点调用它。

## 工具编写细节

`registerTool` 使用 `types.ts` 中的 `ToolDefinition`。其 `parameters` 字段接受 omptype 模式；注入的 TypeBox 兼容性垫片仍可用于旧版扩展。

当前 `execute` 签名：

```ts
execute(
	toolCallId,
	params,
	signal,
	onUpdate,
	ctx,
): Promise<AgentToolResult>
```

### 委托给原生内置工具（`ctx.invokeTool`）

重新注册内置名称的工具（例如包装 `write` 以添加日志记录或策略检查）可以运行原始工具而不是重新实现它。当您注册的工具遮蔽了内置工具时，传递给 `execute` 的 `ctx` 携带：

```ts
ctx.invokeTool?<TDetails>(
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback },
): Promise<AgentToolResult<TDetails>>
```

它运行与您的工具同名的**原生**内置工具（委托仅限于同工具，因此不能到达任意目标或绕过已授予此调用的审批）并返回其结果，包括原生工具自身的副作用和内部簿记。它仅在该名称存在原生内置工具时存在 — 对于不遮蔽任何内置工具的全新工具，`ctx.invokeTool` 为 `undefined`。原生调用不会被重新关卡，因为它就是您已被批准使用的同一工具，并且委托深度可防止意外的自我递归。

模板：

```ts
const z = pi.zod;

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "...",
  parameters: z.object({}),
  hidden: false,
  defaultInactive: false,
  deferrable: false,
  async execute(_id, _params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
    return { content: [{ type: "text", text: "Done" }], details: {} };
  },
  onSession(event, ctx) {
    // reason: start|switch|branch|tree|shutdown
  },
  renderCall(args, options, theme) {
    // optional TUI render
  },
  renderResult(result, options, theme, args) {
    // optional TUI render
  },
});
```

`tool_call`/`tool_result` 一旦注册表在 `sdk.ts` 中被包装，就会拦截所有工具，包括内置工具和扩展/自定义工具。`ToolDefinition` 还支持可选的 `hidden`、`defaultInactive`、`loadMode`（默认为 `"discoverable"`，或 `"essential"`）、`deferrable`、`approval`（默认为 `"exec"`）、`strict`、`mcpServerName`、`mcpToolName`、`renderCall` 和 `renderResult` 字段。

### 文件写入回退（`registerFileWriteFallback`）

`write`、`edit` 和 `apply_patch` 通过一个共享原语对普通文件路径执行实际的字节写入
（`file ? file.write(content) : Bun.write(dst, content)`）。当该原语因权限错误失败时
（`EPERM`/`EACCES`/`EROFS` — 其他每个错误，例如 `EISDIR`，都不受影响），编码代理会在放弃之前咨询通过 `pi.registerFileWriteFallback` 注册的处理器：

```ts
import type { FileWriteFallbackHandler } from "@oh-my-pi/pi-coding-agent";

const writeThroughBroker: FileWriteFallbackHandler = async (req, ctx) => {
  // req: { dst: string; content: string; cause: unknown }
  const ok = await myPrivilegedWriter.write(req.dst, req.content);
  return ok;
};

pi.registerFileWriteFallback(writeThroughBroker);
```

处理器按注册顺序运行；第一个解析为 `true` 的视为字节已持久存储在磁盘上，并且原生工具继续运行，就好像其自身的写入已成功 — 包括在真实目标路径下记录其文件快照，以便稍后对该路径进行 hashline `edit` 仍然可以工作。抛出异常的处理器会被记录下来并跳过以支持下一个 — 按处理器进行，因此同一扩展稍后注册的处理器仍会运行；如果每个处理器都返回 `false`（或者根本没有注册任何处理器），则原始错误不变地重新抛出。供将代理嵌入沙箱（拒绝直接文件系统写入但暴露特权写入通道）的主机使用。

`req.dst` 是**解析符号链接后**的目标，而不是工具被给予的路径。
内核会跟踪最后一个组件之上的每个组件，因此 `ws/link -> /elsewhere` 链接下的 `ws/link/file` 会落在 `ws` 之外，同时看起来仍在工作区中，您处理器中的前缀允许列表会通过该看似无害的路径。对于写入操作，最后一个组件也会被跟踪，因此它也会被解析；对于删除操作则不会，因为 `unlink` 删除的是一个链接而不是它指向的内容（因此删除的 `req.dst` 本身可能命名一个链接）。将 `req.dst` 视为权威，不要从其他任何东西重新派生目标。当无法建立真实目标 — 悬空的最终链接，或此进程可能无法解析的祖先时，根本不会咨询任何处理器，原始错误会不变地重新抛出，因为没有目标可以交给特权写入器。

当目标超出主机允许范围时，有两个细节很重要：

- **缺失的父目录。** `Bun.write` 会自己创建缺失的父目录，当该 `mkdir` 是被拒绝的操作时，它会报告后续 `open()` 的 `ENOENT` 而不是拒绝。代理显式重做 `mkdir` 以恢复真实的 errno，因此仍然会到达处理器 — 并将 `req.cause` 设置为 `mkdir` 拒绝。在这种情况下 `req.dst` 的父目录尚不存在，处理器负责创建它。带有真正可创建或无效父目录的 `ENOENT` 不会被转移。 （`apply_patch` 在写入之前将父目录创建作为单独的步骤；该 `mkdir` 在注册了回退时容忍拒绝，因此写入仍然到达处理器。）
- **Hashline `MV`。** `edit` 的移动直接写入其目标，而不是通过 LSP 写穿。它被路由到相同的处理器，源 unlink 转到下面的删除接缝，因此无法写入目录的移动也能完成。

这并不是故意拦截代理可以执行的每个写入。来自这些表面的权限错误与今天一样显示，不咨询任何处理器：

- 写入归档成员（`foo.zip:entry`）或 SQLite 行。两者都不是对 `dst` 的字节写入：归档重写会读取整个归档、替换一个条目、写入临时文件并重命名覆盖原始文件，因此落地的是整个二进制容器而不是工具被交给的字符串；SQLite 写入是数据库引擎内的行操作，根本没有字节有效负载。代理其中任何一个都需要与"这些字节属于此路径"不同的请求形状。
- ACP 桥接的 `writeTextFile`，它将写入交给远程客户端。
- `lsp` 工具自身的写入：应用工作区编辑或代码操作，以及 Biome 格式化程序，它写入缓冲区然后 shell 调用 `biome format --write` — 任何进程内接缝都无法到达的子进程写入。

### 文件删除回退（`registerFileDeleteFallback`）

删除文件是与写入不同的原语，它有自己的接缝：

```ts
pi.registerFileDeleteFallback(async (req, ctx) => {
  // req: { dst; cause; confirmedFile; sessionId } — no `content`.
  return await myPrivilegedWriter.unlink(req.dst);
});
```

它涵盖 `edit` 的 `REM`、hashline `MV` 的源端以及 `apply_patch` 的删除操作，并遵循与写入接缝相同的规则：相同的权限代码，第一个 `true` 获胜，跳过抛出异常的处理器，如果没有成功的处理器则重新抛出原始错误，当没有注册任何处理器时则完全不执行。两点区别：

- **`ENOENT` 永远不会被转移。** 在 unlink 路径上不会创建任何内容，因此缺失的文件确实是缺失的 — `REM` 将其转换为未找到错误。
- **处理器必须 unlink，永远不要递归删除。** 目录上的 `unlink` 在 macOS 上会报告 `EPERM`，仅通过错误代码无法与沙箱拒绝区分，因此该接缝会对目标执行 `lstat` 并拒绝转移目录。但是当目标自身的元数据位于拒绝 unlink 的同一边界之后时 — 常见的沙箱情况 — 该检查无法解析，然后 `req.dst` 可能是目录。`req.confirmedFile` 仅在接缝明确确认目标是普通常规文件时才为 `true`；符号链接也报告为 `false`，因为取消链接链接是可以的，但解析它会作用于完全不同的东西。递归删除 `req.dst` 或先 realpath 它的特权助手将大大超出仅删除一个文件的工具所要求的内容。

**注册删除与注册写入是故意分开的。** 写入处理器将 `req.content` 代理到 `req.dst`；如果删除请求到达它，则缺少的内容会邀请代理空写入并*截断*本应被删除的文件。因此，仅写入处理器永远不会看到删除。

两个生命周期约束同时适用于这两个接缝：

- **在扩展加载期间注册**（从默认工厂中），就像其他 `register*` 调用一样。处理器在 `ExtensionRunner.initialize` 运行时安装；到那时仍未注册任何内容的扩展会被完全跳过，因此以后进行的首次注册永远不会生效。处理器接收的 `ctx` 是按调用构建的，而不是在安装时捕获的，因此 `ctx.cwd` 和 `ctx.hasUI` 描述的是变更被拒绝时的会话状态 — 工作区更改（`/move`）反映在下一个请求中，而不是固定在加载时间。
- **注册表是进程范围的。** 一个进程可以承载多个会话（子代理获得自己的运行器），因此处理器可能会因进程中任何会话（而不仅仅是其扩展注册它的会话）的写入或删除被拒绝而被咨询。这是故意的：以受限工具生成的子代理不加载自己的扩展，并且在顶级会话中注册一次的主机仍然希望其子代理的写入被代理。`req.sessionId` 命名发出变更的会话（当它不是来自工具调用时为 `undefined`），`ctx.sessionManager.getSessionId()` 命名处理器自身的会话 — 比较它们以按会话做出决定。这在提示之前最重要：`ctx.ui` 属于处理器的会话，不一定属于被询问的会话。处理器在 `session_shutdown` 时被删除。

如果没有任何注册，这一切都不会启动：原语完全像以前一样运行，并且不执行额外的系统调用。

## UI 集成点

`ctx.ui` 实现 `ExtensionUIContext` 接口。支持因模式而异。

### 交互模式（`extension-ui-controller.ts`）

支持：

- 对话框：`select`、`confirm`、`input`、`editor`
- 输入编辑：`setEditorText`、`getEditorText`、`pasteToEditor`、`editor`
- 自动完成堆叠：`addAutocompleteProvider(factory)` 包装内置编辑器提供程序（工厂按注册顺序应用，并在每次斜杠命令刷新时重新应用）
- 终端标题和工作消息（`setTitle`、`setWorkingMessage`）
- 通知/状态/编辑器文本/终端输入/自定义覆盖层
- 按名称列出/加载主题（`setTheme` 支持字符串名称）
- 工具展开开关

此控制器中当前的无操作方法：

- `setFooter`
- `setHeader`

`setEditorComponent` 连接到实时编辑器（`ctx.setEditorComponent(factory)`）。`setWidget` 通过 `setHookWidget(...)` 在编辑器上方或下方呈现真实的小组件组件（`placement: "aboveEditor" | "belowEditor"`；字符串数组内容上限为 10 行）。

### RPC 模式（`rpc-mode.ts`）

`ctx.ui` 由 RPC `extension_ui_request` 事件支持：

- 对话框方法（`select`、`confirm`、`input`、`editor`）往返于客户端响应
- 即发即弃方法发出请求（`notify`、`setStatus`、字符串数组的 `setWidget`、`setEditorText`；`setTitle` 仅在 `PI_RPC_EMIT_TITLE=1` 时发出）

RPC 实现中不支持/无操作：

- `onTerminalInput`
- `custom`
- `setFooter`、`setHeader`、`setEditorComponent`、`addAutocompleteProvider`
- `setWorkingMessage`
- 主题切换/加载（`setTheme` 返回失败）
- 工具展开控件是无效的

### 打印/无头/子代理路径

当没有 UI 上下文提供给运行器初始化时，`ctx.hasUI` 为 `false`，方法是无操作/默认返回。

### ACP 模式

ACP 安装一个询问桥接的 UI 上下文（`acp-agent.ts` 中的 `createAcpExtensionUiContext`）。当 `select`/`confirm`/`input`/`editor` 往返时（作为 ACP 询问；当客户端缺少 `elicitation.form` 能力时返回默认值），`ctx.hasUI` 为 `true`。非询问接口（小组件、主题、终端输入、自动完成堆叠）是存根无操作。

## 会话和状态模式

对于持久化扩展状态：

1. 使用 `pi.appendEntry("com.example.my-extension.state", data)` 持久化。`customType` 命名空间是全局的：使用包或反向域名限定的值，并避免 [`custom` 会话条目参考](./session.md#custom)中的核心保留值。
2. 在 `session_start`、`session_branch`、`session_tree` 上从 `ctx.sessionManager.getBranch()` 重建状态。
3. 当状态应该可从工具结果历史记录中可见/重建时，保持工具结果 `details` 是结构化的。

示例重建模式：

```ts
pi.on("session_start", async (_event, ctx) => {
  let latest;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === "com.example.my-extension.state"
    ) {
      latest = entry.data;
    }
  }
  // restore from latest
});
```

## 渲染扩展点

## 合成器形状渲染器

`registerComposerShape` 将扩展拥有的输入编辑器布局添加到 **Appearance → Composer Shape**。从扩展工厂注册它；渲染器被实时编辑器及其设置预览使用。

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ComposerStyle } from "@oh-my-pi/pi-tui";

const dockStyle: ComposerStyle = {
  id: "acme-dock",
  sideBorders: false,
  verticalChrome: 1,
  statusAttachment: "none",
  bottomBar: "full",
  bottomBarGap: true,
  defaultPromptGutter: "❯ ",

  defaultPaddingX: () => 0,
  sideChromeWidth: () => 0,
  renderTop: ({ box, width, borderColor }) =>
    borderColor(box.horizontal.repeat(width)),
  renderRow: ({ gutter, text, pad }) => [gutter + text + pad],
  renderBottom: () => undefined,
};

export default function (pi: ExtensionAPI) {
  pi.registerComposerShape({
    label: "Acme Dock",
    description: "Prompt below a single rule",
    style: dockStyle,
  });
}
```

`ComposerShapeDefinition` 包含：

- `label`：必需的选择器标签。
- `description`：可选的选择器详细信息。
- `style`：完整的 `ComposerStyle` 渲染契约。`style.id` 也是持久化的 `composer.shape` 值。

使用包限定的、非空的、修剪过的 `style.id`。内置 id（`box`、`claude`、`pi`、`borderless`、`rule`、`field` 和 `rail`）无法替换。如果扩展不可用但其 id 仍被配置，则编辑器回退到 `box`。

### `ComposerStyle` 布局元数据

- `sideBorders`：内容行是否拥有侧边框。这控制光标预留、IME 布局和滚动条行为；它不仅仅是描述性的。
- `verticalChrome`：固定顶部/底部边框行的精确数量（`0`、`1` 或 `2`），用于编辑器高度预算。
- `statusAttachment`：`"top-border"` 接收嵌入的状态指示器，`"top-rule-chip"` 接收用于停靠在规则上的右侧状态组，`"none"` 将状态从编辑器边框分离。
- `bottomBar`：编辑器下方的独立状态内容：`"none"`、`"left"` 或 `"full"`。
- `bottomBarGap`：是否有一空行将编辑器与独立底部状态栏分隔开。
- `defaultPromptGutter`：当主机不提供覆盖时使用的提示文本。
- `defaultPaddingX(themePaddingX)`：为此样式选择的水平填充。
- `sideChromeWidth(paddingX)`：内容行**每**侧消耗的可见单元格，包括填充和边框/导轨字形。

`renderTop` 和 `renderBottom` 返回一个样式化的终端行或 `undefined`。`renderRow` 返回一个或多个样式化行。每个正常渲染的行必须恰好占用 `ctx.width` 可见单元格；ANSI 转义序列宽度为零。保留提供的 `gutter`、`text` 和 `pad`，而不是重新流动或截断它们。

### 渲染器上下文

所有渲染方法接收 `width`、`paddingX`、主题的 `box` 字形和三个样式函数：

- `borderColor(text)`：普通框架/规则颜色。
- `accentColor(text)`：用于形状定义导轨或帽的稳定强调色。
- `surfaceColor(text)`：在装饰输入中的嵌套 SGR 重置下存活的合成器背景填充。

如果存在，`topBorder` 是已经样式化的状态内容及其可见 `width`。顶部渲染器拥有其放置位置，必须将最后一行留在 `ctx.width`。

`renderRow` 额外接收：

- `gutter`、`text` 和 `pad`：预渲染的内容片段。
- `isLastRow`：最后一个可见输入行。
- `cursorOverflow`：行末光标从右侧边框消耗的单元格。
- `imeSafeCursorTail`：省略光标右侧的单元格，以便终端本地 IME 预编辑不会移动边框。
- `scrollbarThumb`：此行与编辑器滚动条拇指相交。

`packages/tui/src/components/composer/` 中的内置实现是带框、规则、填充表面和 IME 安全布局的参考。

## 自定义消息渲染器

```ts
pi.registerMessageRenderer("my-type", (message, { expanded }, theme) => {
  // return pi-tui Component
});
```

在显示自定义消息时由交互式渲染使用。

## 助手思考渲染器

```ts
import { Container, Text } from "@oh-my-pi/pi-tui";

pi.registerAssistantThinkingRenderer((context, theme) => {
  const container = new Container();
  container.addChild(
    new Text(theme.fg("dim", `thinking chars: ${context.text.length}`), 1, 0),
  );
  return container;
});
```

由交互式渲染使用，用于在每个可见的助手思考块下方添加仅显示的补充 UI。渲染器接收已经可见的思考文本、content/thinking 索引、主题和用于异步渲染器的 `requestRender()` 回调。所有返回组件的已注册渲染器按注册顺序附加。渲染器不得变更消息；原始思考块仍然是提供商/会话的真相来源。

## 工具调用/结果渲染器

为 `registerTool` 定义提供 `renderCall` / `renderResult`，以便在 TUI 中自定义工具可视化。

## 约束和陷阱

- 运行时动作在扩展加载期间不可用。
- `tool_call` 错误会阻止执行（默认失败关闭）。
- 与内置命令的命令名称冲突会被跳过并生成诊断信息。
- 保留的快捷键会被忽略（`ctrl+c`、`ctrl+d`、`ctrl+z`、`ctrl+k`、`ctrl+p`、`ctrl+l`、`ctrl+o`、`ctrl+t`、`ctrl+g`、`ctrl+q`、`alt+m`、`shift+tab`、`shift+ctrl+p`、`alt+enter`、`escape`、`enter`）。
- 将 `ctx.reload()` 视为当前命令处理器帧的终止。

## 扩展 vs 钩子 vs 自定义工具

使用正确的接口：

- **扩展**（`src/extensibility/extensions/*`）：统一系统（事件 + 工具 + 命令 + 渲染器 + 提供商注册）。
- **钩子**（`src/extensibility/hooks/*`）：独立的旧版事件 API。
- **自定义工具**（`src/extensibility/custom-tools/*`）：以工具为中心的模块；当与扩展一起加载时，它们会被适配并仍然通过扩展拦截包装器。

如果您需要一个同时拥有策略、工具、命令 UX 和渲染的包，请使用扩展。
