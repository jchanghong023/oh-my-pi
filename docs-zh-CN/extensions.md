# 扩展

在 `packages/coding-agent` 中编写运行时扩展的主要指南。

本文档涵盖当前扩展运行时所在的文件：

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
4. 会话/agent/工具生命周期事件会发送给处理器。
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
- 先注册；运行时行为通过事件/命令/工具执行

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

`getServiceTiers()` 返回会话实时按系列分级映射的分离快照。`setServiceTier(family, tier)` 更改后续请求中某个系列的分级；传入 `undefined` 可清除该会话的这一覆盖。OpenAI 接受 `auto`、`default`、`flex`、`scale` 或 `priority`；Anthropic 接受 `priority`；Google 接受 `flex` 或 `priority`。在响应流式传输期间所做的更改不会影响该进行中的请求。

### provider 注册

`pi.registerProvider(name, config)` 可以包含一个可选的 `usage` 字段，其中包含从 `@oh-my-pi/pi-ai` 导入的 `UsageProvider`。其 `fetchUsage` 实现接收归一化后的凭证并返回归一化的 `UsageReport`；该结果随后由宿主的 AuthStorage 缓存、历史记录和使用量显示处理，就像内置 provider 使用量一样。

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
      const payload = (await response.json()) as {
        used: number;
        limit: number;
      };
      return {
        provider: "my-provider",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "requests",
            label: "Requests",
            scope: { provider: "my-provider" },
            amount: {
              used: payload.used,
              limit: payload.limit,
              unit: "requests",
            },
          },
        ],
      };
    },
  },
});
```

只要该扩展注册处于激活状态，扩展使用量 provider 就会覆盖同名的内置 provider。`pi.unregisterProvider(name)`（以及扩展源清理）仅移除该运行时覆盖，恢复内置或已配置的使用量解析器。

扩展注册的 provider（`registerProvider`）可以提供 `fetchDynamicModels` 用于运行时模型发现；这些请求被硬性限制为 15 秒超时（`model-provider-discovery.ts` 中的 `RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS`），因此挂起的端点不会阻塞发现过程。

provider 登录回调可以通过 `callbacks.onPrompt({ message: "Consumer key", secret: true })` 请求掩码输入。原生 `/login` 和首次运行设置会在输入框、保留的答案和输入诊断预览中隐藏提交的值，同时精确保留该值。登录提示不共享撤销或 kill/yank 历史。普通提示保持不掩码。

RPC 会拒绝机密提示，而不是将其作为普通输入转发。实现 `onPrompt` 的 SDK 宿主必须遵守 `secret` 或拒绝该提示。掩码不提供加密、内存擦除或通用日志脱敏。

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
- `deliverAs: "nextTurn"` — 存储并在下一条用户提示词时注入
- `deliverAs: "aside"` — 在下一个 agent 步骤边界注入，不中断当前的工具批处理；空闲时会启动一轮（`triggerTurn` 被忽略；计划模式会将其折叠进上下文）
- `triggerTurn: true` — 空闲时启动一轮（`deliverAs: "nextTurn"` 同样遵循该选项：空闲时立即发起提示词；流式传输期间，排队的消息会安排一次内部延续）

`pi.sendUserMessage(content, { deliverAs })` 始终经过提示词流程。省略 `deliverAs` 时，空闲状态下会发起正常提示词；流式传输期间，省略 `deliverAs` 会将消息作为 steer 排队。设置 `deliverAs: "followUp"` 可等待当前运行完成。设置 `deliverAs: "aside"` 可在运行进行中时于下一个步骤边界注入该提示词（空闲时的发送照常启动一轮）。消息默认以 `attribution: "user"` 记录，除非你传入 `attribution: "agent"`；对扩展生成的文本或从另一个 agent 中继的文本请传入 `"agent"`，这样消费方就能将其与用户输入的内容区分开。

传递给 `pi.sendMessage` 的载荷在投递前会被归一化（`session/messages.ts` 中的 `normalizeCustomMessagePayload`）：非对象载荷会在默认 custom 类型下被强制转换为字符串内容，缺失的 `customType`/`attribution` 字段会被填入默认值，无效内容会收敛为空字符串 — 格式错误的载荷不再会持久化那些导致后续会话恢复时崩溃的条目。

## 2) 处理器上下文（`ExtensionContext`）

处理器和工具 `execute` 接收带有以下内容的 `ctx`：

- `ui`
- `hasUI`
- `cwd`
- `sessionManager`（只读）
- `modelRegistry`、`model`
- `models`（只读模型查询 — 见下文）
- `localProtocolOptions`（可选的调用方会话 `local://` 根映射，用于外部工具桥接）
- `getContextUsage()`
- `getAsyncJobSnapshot()` 返回当前会话的只读异步任务快照，当没有会话拥有该上下文时返回 `null`
- `compact(...)`
- `isIdle()`、`hasPendingMessages()`、`abort()`
- `shutdown()`
- `getSystemPrompt()`
- `memory`（可选的结构化记忆运行时 — 在已配置的后端上进行状态/搜索/保存）
- `setInterval(fn, ms, ...args)` / `setTimeout(fn, ms, ...args)` / `clearTimer(timer)` — 托管定时器（见下文）

### 后台工作（`ctx.setInterval` / `ctx.setTimeout`）

扩展**在没有隔离的情况下在进程内运行**。原始 `setInterval`/`setTimeout`/分离 promise 的回调如果抛出异常，会在处理器分派的 try/catch 之外运行，作为进程级 `uncaughtException` 浮出，全局事后分析处理器会将其视为致命错误 — **整个会话都会被拆除**，而不仅仅是出错的扩展。

对任何周期性或延迟的后台工作，请使用 `ctx.setInterval` / `ctx.setTimeout`。它们镜像平台签名，但：

- 以与处理器分派相同的隔离运行回调 — 同步抛出或被拒绝的 promise 会被记录并通过扩展错误通道报告，会话继续运行；
- 返回一个可传递给 `ctx.clearTimer(handle)` 的句柄；
- 被 `unref`（绝不会仅凭自身让进程保持存活），并在 `session_shutdown` 时自动清除。

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

如果改用原始的 `setInterval`/`setTimeout` 或分离的 promise，隔离由你自己负责：将回调主体包装在你自己的 `try/catch` 中（未处理的抛出会终止会话），并在 `session_shutdown` 时清除定时器。

### 模型选择（`ctx.models`）

`ctx.models` 是一个只读外观，用于以与核心相同的方式挑选和比较模型：

- `list()` — 本会话可用的已认证模型。
- `current()` — 实时会话模型（惰性读取，因此反映 `/model` 切换）。
- `resolve(spec)` — 模型字符串（`provider/id`、裸 id）或角色别名（`@slow`、已配置的角色）→ `Model`，遵循与 `--model` 相同的基于设置的别名和匹配偏好。没有任何匹配时返回 `undefined`。
- `family(model)` — 用于“同一系列？”检查的不透明血统令牌（Claude 点版本共享一个令牌；Claude 与 GPT 不同）。可以比较它；不要持久化它（词汇表会跟踪新发布）。

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

会话控制流程请使用命令上下文；这些方法被有意地与通用事件处理器分开。

## 事件接口（当前名称和行为）

规范的事件联合类型和载荷类型在 `types.ts` 中。

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

### 提示词和轮次生命周期

- `input`
- `before_agent_start`
- `before_provider_request`（可替换 provider 请求载荷 — 该替换由每个触发此 hook 的 provider 应用，即除不触发它的 `devin-agent` 之外的所有 provider）
- `after_provider_response`
- `context`
- `agent_start` / `agent_end` — agent 循环生命周期通知；`agent_end` 仍仅为通知
- `session_stop` — 主会话停止 hook，在 settle 之前被等待。建议性 `{ continue: true, additionalContext }` 请求的连续延续次数上限为 8。显式 `{ decision: "block", reason }` 拒绝优先于建议性请求，不消耗该额度，并保持阻塞，直到该 hook 允许完成或操作者中断。没有原因的拒绝会收到一次诊断性延续，而不是被允许结束。该事件绝不会为任务/子 agent 会话触发，并且会推迟到 agent 拥有的后台作业完全空闲（`session/agent-session.ts` 中的 `#hasPendingAsyncWake`）。
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end` — 生命周期通知；`message_end` 接收分离的消息快照，因此当扩展需要更改 provider 上下文时，请使用 `tool_result` 或 `context`

`before_agent_start` 为普通提示词，以及为每个包含用户工作且实际出队的 steering 或 follow-up 批次准备策略。它不是入队通知：活跃批次可以在没有另一个 `agent_start` 的情况下触发它。队列窥视、provider 重试、仅工具的迭代以及仅合成内容的排队延续不会触发它。显式合成提示词保留其普通提示词生命周期。

对于排队批次，`prompt` 包含每条被选中的用户消息已完成转换的文本，消息之间以两个换行符连接；消息内的文本块会被拼接。`images` 按投递顺序包含它们已归一化的图像。隐藏的 agent 归因伴随消息被排除在这些事件输入之外，但仍保留在投递的批次中。输入 hook、命令、模板和原始附件预处理不会重新运行。

处理器从当前的基础系统提示词开始链式运行。它们的最终覆盖控制下一个 provider 请求及其延续，直到另一个提示词或包含用户内容的批次再次准备策略。覆盖仍然是完整替换，包括与基础无关的字符串或数组；宿主从不推断文本补丁或对其进行 rebase。返回的自定义消息在原始批次之后追加一次；原始消息保留其顺序、身份、归因和元数据。如果在处理器待处理期间该轮被中止，或会话或队列所有权发生变化，宿主对结果的应用会被取消。

如果返回覆盖的源基础在准备期间发生变化（例如，某个处理器等待了 `ctx.setActiveTools()`），宿主会丢弃该次尝试返回的自定义消息和暂存的记忆，然后从胜出的基础重新进行策略准备。每次投递最多运行三次尝试；反复的基础变化会引发错误，并且不投递原始输入。排队的原始消息保持排队，失败轮次的结算不会自动重试它们。新的提示词或排队投递可以重新开启排空，包括合成 follow-up 以及来自扩展或 advisor 的自定义消息；暂停并不限于仅用户重试。普通文本通过 dropped-prompt 回调返回。未变化的基础内容不会触发重试，即使某次刷新替换了数组。没有覆盖的准备仍然使用胜出的基础，不会重新运行处理器或召回。在发布结果之前会同步地再次检查所有权；迟来的变化会拒绝该投递，且不提交记忆或上下文。

处理器必须容忍重入：源基础重试可能会为同一次提交再次调用整个 `before_agent_start` 链，而被取消的投递在恢复时可能会再次被准备。只有被接受的尝试所返回的上下文和暂存记忆会被发布；处理器执行的外部副作用无法回滚。输入 hook、命令、模板和原始附件预处理绝不会因这些策略重试而重放。

如果稍后的队列排空失败，尚未进入会话记录的较早原始消息会被恢复到较新入队消息之前。生成的准备上下文不会重新入队，被显式清除或替换的队列也不会复活。

### 工具生命周期

- `tool_call`（执行前，可以阻止，或修改工具的执行 `input`；对于模型发起的调用，它在 agent 循环的参数准备阶段触发，因此修改会被重新验证，并被并发调度、执行事件、持久化的助手消息和审批关卡同时看到）
- `tool_result`（执行后，可以修补 content/details/isError）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`（可观测性）
- `tool_approval_requested` / `tool_approval_resolved`（可观测性；仅当工具需要审批且已注册审批处理器时由 `wrapper.ts` 发出）

`tool_result` 是中间件风格的：处理器按扩展顺序运行，每个处理器都能看到之前的修改。

### 可靠性/运行时信号

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`
- `goal_updated`
- `credential_disabled`

### MCP 通知

- `mcp_notification` — 从已连接的 MCP 服务器收到的每个 JSON-RPC 通知都会触发，在管理器对已知 list/update 方法（`notifications/tools/list_changed`、`notifications/resources/list_changed`、`notifications/resources/updated`、`notifications/prompts/list_changed`）完成自身处理之后触发。未知或服务器自定义方法也会被投递。载荷：`{ server: string; method: string; params: unknown }`。多个扩展可以订阅；抛出异常的处理器不会阻止其他处理器触发。在任何监听器附加之前收到的通知会被缓冲（有界 FIFO，上限 100，丢弃最旧）并排空给第一个订阅者 — 因此即使扩展在 MCP 发现之后才绑定，启动时的帧也不会丢失。

将支持推送的 MCP 桥接到会话 steer：

```ts
pi.on("mcp_notification", (event) => {
  if (event.server !== "peer-bus") return;
  if (event.method !== "notifications/peer_message") return;
  const params = event.params as { from: string; text: string };
  pi.sendUserMessage(`[from ${params.from}] ${params.text}`, {
    deliverAs: "steer",
    attribution: "agent",
  });
});
```

运行时首先处理 JSON-RPC 传输及其自身的 list/update 刷新；处理器随后运行，并可以通过 `pi.sendMessage` / `pi.sendUserMessage` 注入轮次中途的 steer。

### 用户命令拦截

- `user_bash`（用 `{ result }` 覆盖）
- `user_python`（用 `{ result }` 覆盖）

### `resources_discover`

`resources_discover` 存在于扩展类型和 `ExtensionRunner` 中。
当前运行时说明：`ExtensionRunner.emitResourcesDiscover(...)` 已实现，但当前代码库中没有调用它的 `AgentSession` 调用点。

## 工具编写细节

`registerTool` 使用 `types.ts` 中的 `ToolDefinition`。其 `parameters` 字段接受 omptype 模式；注入的 TypeBox 兼容垫片对旧版扩展仍然可用。

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

### 委托给 native 内置工具（`ctx.invokeTool`）

重新注册内置名称的工具（例如包装 `write` 以添加日志记录或策略检查）可以运行原始工具而不是重新实现它。当你注册的工具遮蔽了某个内置工具时，传递给 `execute` 的 `ctx` 携带：

```ts
ctx.invokeTool?<TDetails>(
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback },
): Promise<AgentToolResult<TDetails>>
```

它运行与你的工具同名的 **native** 内置工具（委托仅限于同名工具，因此它无法到达任意目标，也无法越过此次调用已授予的审批）并返回其结果，包括 native 工具自身的副作用和内部簿记。仅当该名称存在 native 内置工具时它才存在 — 对于不遮蔽任何内置工具的全新工具，`ctx.invokeTool` 为 `undefined`。native 调用不会被重新关卡，因为它就是你已获批准的同一个工具，并且委托深度受到防护，可避免意外的自我递归。

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

`tool_call`/`tool_result` 在注册表于 `sdk.ts` 中被包装之后拦截所有工具，包括内置工具和扩展/自定义工具。`ToolDefinition` 还支持可选的 `hidden`、`defaultInactive`、`loadMode`（默认 `"discoverable"`，或 `"essential"`）、`deferrable`、`approval`（默认 `"exec"`）、`strict`、`mcpServerName`、`mcpToolName`、`renderCall` 和 `renderResult` 字段。

### 文件写入回退（`registerFileWriteFallback`）

`write`、`edit` 和 `apply_patch` 通过一个共享原语（`file ? file.write(content) : Bun.write(dst, content)`）对普通文件路径执行实际的字节写入。当该原语因权限错误失败时（`EPERM`/`EACCES`/`EROFS` — 其他所有错误，例如 `EISDIR`，均不受影响），编码 agent 会在放弃之前咨询通过 `pi.registerFileWriteFallback` 注册的处理器：

```ts
import type { FileWriteFallbackHandler } from "@oh-my-pi/pi-coding-agent";

const writeThroughBroker: FileWriteFallbackHandler = async (req, ctx) => {
  // req: { dst: string; content: string; cause: unknown }
  const ok = await myPrivilegedWriter.write(req.dst, req.content);
  return ok;
};

pi.registerFileWriteFallback(writeThroughBroker);
```

处理器按注册顺序运行；第一个解析为 `true` 的处理器即视为字节已持久落盘，native 工具继续执行，完全如同其自身的写入已成功 — 包括在真实目标路径下记录其文件快照，因此之后对该路径进行 hashline `edit` 仍然有效。抛出异常的处理器会被记录并跳过，转而使用下一个 — 按处理器逐个进行，因此同一扩展稍后注册的处理器仍会运行；如果每个处理器都返回 `false`（或根本没有注册处理器），则原始错误原样重新抛出。适用于将 agent 嵌入沙箱（拒绝直接文件系统写入但暴露特权写入通道）的宿主。

`req.dst` 是**解析符号链接后**的目标，而不是工具被给予的路径。内核会跟随最后一个组件之上的每个组件，因此 `ws/link -> /elsewhere` 链接下的 `ws/link/file` 会落在 `ws` 之外，同时看起来仍在工作区内，你处理器中的前缀允许列表会放行这个看似无害的路径。对于写入，最后一个组件也会被跟随，因此它同样会被解析；对于删除则不会，因为 `unlink` 移除的是链接本身，而不是它指向的内容（因此删除操作的 `req.dst` 本身可能命名一个链接）。请将 `req.dst` 视为权威，不要从其他任何东西重新推导目标。当真实目标无法确定时 — 末级链接悬空，或存在此进程可能无法解析的祖先目录 — 完全不会咨询任何处理器，原始错误会原样重新抛出，因为没有可以交给特权写入器的目标。

当目标超出宿主允许的范围时，有两个细节很重要：

- **缺失的父目录。** `Bun.write` 会自行创建缺失的父目录，而当被拒绝的操作正是那个 `mkdir` 时，它报告的是后续 `open()` 的 `ENOENT` 而不是拒绝本身。agent 会显式重做 `mkdir` 以还原真实的 errno，因此这仍会到达某个处理器 — 此时 `req.cause` 被设为 `mkdir` 拒绝。在这种情况下，`req.dst` 的父目录尚不存在，由处理器负责创建它。父目录确实可创建或确实无效的 `ENOENT` 不会被转移。（`apply_patch` 在写入之前会以单独的步骤创建父目录；在注册了回退时，该 `mkdir` 容忍被拒绝，因此写入仍会到达处理器。）
- **hashline `MV`。** `edit` 的移动操作直接写入其目标，而不是通过 LSP 写透。它被路由到相同的处理器，源端的 unlink 则交给下方的删除接缝，因此从你无法写入的目录中移出也能完成。

这被有意设计为不拦截 agent 进行的每一次写入。来自以下表面的权限错误会像今天一样表现，不咨询任何处理器：

- 对归档成员（`foo.zip:entry`）或 SQLite 行的 `write`。两者都不是对 `dst` 的字节写入：归档重写会读取整个归档、替换一个条目、写入临时文件并重命名覆盖原始文件，因此最终落地的是整个二进制容器，而不是工具收到的字符串；SQLite 写入是数据库引擎内部的行操作，完全没有字节载荷。为其中任一做代理，所需的请求形态都不同于“这些字节属于这个路径”。
- ACP 桥接的 `writeTextFile`，它把写入交给远程客户端。
- `lsp` 工具自身的写入：应用工作区编辑或代码操作，以及 Biome 格式化器 — 它写入缓冲区后调用子进程执行 `biome format --write` — 这是任何进程内接缝都无法触及的子进程写入。

### 文件删除回退（`registerFileDeleteFallback`）

删除文件是与写入不同的原语，它有自己的接缝：

```ts
pi.registerFileDeleteFallback(async (req, ctx) => {
  // req: { dst; cause; confirmedFile; sessionId } — no `content`.
  return await myPrivilegedWriter.unlink(req.dst);
});
```

它涵盖 `edit` 的 `REM`、hashline `MV` 的源端以及 `apply_patch` 的删除操作，并遵循与写入接缝相同的规则：相同的权限错误码、第一个 `true` 获胜、抛出异常的处理器被跳过、没有处理器成功时原样重新抛出原始错误，以及未注册任何处理器时完全不发生任何事情。两点区别：

- **`ENOENT` 绝不会被转移。** unlink 的路径上不会创建任何东西，因此缺失的文件就是真的缺失 — `REM` 会将其转换为未找到错误。
- **处理器必须 unlink，绝不能递归删除。** 对目录执行 `unlink` 在 macOS 上会报告 `EPERM`，仅凭错误码无法与沙箱拒绝区分，因此该接缝会对目标执行 `lstat` 并拒绝转移目录。但当目标自身的元数据位于拒绝 unlink 的同一边界之后时 — 这是最常见的沙箱情况 — 该检查无法得出结论，此时 `req.dst` 可能是一个目录。`req.confirmedFile` 仅在接缝明确确认目标是普通常规文件时才为 `true`；符号链接也报告 `false`，因为 unlink 一个链接本身没问题，但解析它会作用到完全不同的东西上。递归删除 `req.dst` 或先对它做 realpath 的特权助手，其行为会远远超出一个只删除单个文件的工具所请求的范围。

**删除的注册与写入的注册被有意分开。** 写入处理器把 `req.content` 代理到 `req.dst`；如果删除请求到达它，缺失的内容会诱使它代理一次空写入并*截断*本应被删除的文件。因此，仅注册写入的处理器永远不会看到删除。

两个生命周期约束，同时适用于这两个接缝：

- **在扩展加载期间注册**（从默认工厂中），就像其他 `register*` 调用一样。处理器在 `ExtensionRunner.initialize` 运行时安装；到那时仍未注册任何内容的扩展会被完全跳过，因此之后再进行的首次注册永远不会生效。处理器接收的 `ctx` 是按每次调用构建的，而不是在安装时捕获的，因此 `ctx.cwd` 和 `ctx.hasUI` 描述的是变更被拒绝时会话的当时状态 — 工作区变更（`/move`）会反映在下一个请求中，而不是固定在加载时刻。
- **注册表是进程范围的。** 一个进程可以承载多个会话（子 agent 有自己的运行器），因此处理器可能因进程中任何会话的写入或删除被拒绝而被咨询 — 而不仅仅是其扩展注册它的那个会话。这是有意的：在顶级会话中注册一次的宿主，仍然期望其子 agent 的写入被代理，包括没有继承扩展工厂的会话。受限子进程保留父进程加载的 hook，但不发现环境中的扩展。`req.sessionId` 标识发出该变更的会话（当它不是来自工具调用时为 `undefined`），而 `ctx.sessionManager.getSessionId()` 标识处理器自己的会话 — 比较它们以按会话做出决策。这在发起提示词之前最为重要：`ctx.ui` 属于处理器的会话，不一定属于被询问的那个会话。处理器在 `session_shutdown` 时被移除。

什么都没注册时，这一切都不会启用：原语的运行与之前完全一样，不会执行额外的系统调用。

## UI 集成点

`ctx.ui` 实现 `ExtensionUIContext` 接口。支持情况因模式而异。

### 交互模式（`extension-ui-controller.ts`）

支持：

- 对话框：`select`、`confirm`、`input`、`editor`
- 输入编辑：`setEditorText`、`getEditorText`、`pasteToEditor`、`editor`
- 自动补全堆叠：`addAutocompleteProvider(factory)` 包装内置编辑器 provider（工厂按注册顺序应用，并在每次斜杠命令刷新时重新应用）
- 终端标题和工作消息（`setTitle`、`setWorkingMessage`）
- 通知/状态/编辑器文本/终端输入/自定义覆盖层
- 按名称列出/加载主题（`setTheme` 支持字符串名称）
- 工具展开开关

此控制器中当前为无操作的方法：

- `setFooter`
- `setHeader`

`setEditorComponent` 连接到实时编辑器（`ctx.setEditorComponent(factory)`）。`setWidget` 通过 `setHookWidget(...)` 在编辑器上方或下方渲染真实的小部件组件（`placement: "aboveEditor" | "belowEditor"`；字符串数组内容上限为 10 行）。`setEditorText` 和 `pasteToEditor` 在修改编辑器后会安排一次重绘，因此提示词的变更不会在屏幕上留下过期内容。

### RPC 模式（`rpc-mode.ts`）

`ctx.ui` 由 RPC `extension_ui_request` 事件支持：

- 对话框方法（`select`、`confirm`、`input`、`editor`）与客户端响应往返
- 即发即弃方法发出请求（`notify`、`setStatus`、针对字符串数组的 `setWidget`、`setEditorText`；`setTitle` 仅在 `PI_RPC_EMIT_TITLE=1` 时发出）

RPC 实现中不支持/无操作：

- `onTerminalInput`
- `custom`
- `setFooter`、`setHeader`、`setEditorComponent`、`addAutocompleteProvider`
- `setWorkingMessage`
- 主题切换/加载（`setTheme` 返回失败）
- 工具展开控件不起作用

### 打印/无头/子 agent 路径

当运行器初始化未收到 UI 上下文时，`ctx.hasUI` 为 `false`，方法为无操作/返回默认值。

### ACP 模式

ACP 安装一个经 elicitation 桥接的 UI 上下文（`acp-agent.ts` 中的 `createAcpExtensionUiContext`）。当 `select`/`confirm`/`input`/`editor` 往返时（作为 ACP elicitation；当客户端缺少 `elicitation.form` 能力时返回默认值），`ctx.hasUI` 为 `true`。非 elicitation 的部分（小部件、主题、终端输入、自动补全堆叠）是存根无操作。

## 会话和状态模式

对于需要持久保存的扩展状态：

1. 使用 `pi.appendEntry("com.example.my-extension.state", data)` 持久化。`customType` 命名空间是全局的：使用包名或反向域名限定的值，并避免 [`custom` 会话条目参考](./session.md#custom)中的核心保留值。
2. 在 `session_start`、`session_branch`、`session_tree` 时从 `ctx.sessionManager.getBranch()` 重建状态。
3. 当状态需要从工具结果历史中可见/可重建时，保持工具结果的 `details` 为结构化。

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

### 会话条目角色（`message.role` 为 camelCase）

当你遍历 `ctx.sessionManager.getBranch()` 时，每个持久化条目都有一个 `type`（`message`、`custom_message`、`branch_summary`、`compaction` 等；以[会话条目模型](./session.md#entry-taxonomy)为参考）。`type: "message"` 条目在 `entry.message` 下携带一个 `AgentMessage`，其 `role` 判别值是 **camelCase** — 而不是原始 LLM 线上格式或上文 `tool_call` / `tool_result` **hook** 名称所用的 snake_case：

| 持久化的 `entry.message.role` | 含义                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| `user`                        | 用户 / 工具反馈轮次。                                                       |
| `developer`                   | developer 角色的指令轮次。                                                  |
| `assistant`                   | 模型轮次。工具调用是 `content` 内的 `{ type: "toolCall" }` 块。              |
| `toolResult`                  | 单个工具的结果 — **不是** `tool_result`。具有 `toolCallId` / `toolName`。   |
| `bashExecution`               | 独立的 `!` bash 运行。                                                      |
| `pythonExecution`             | 独立的 python 运行。                                                        |
| `hookMessage`                 | 旧版 hook 注入的消息（仅用于迁移；请使用 `custom`）。                       |
| `fileMention`                 | 内联的 `@file` 提及内容。                                                   |

重建 agent 上下文中的三个角色来自扩展可见分支历史中的专门源条目；`getBranch()` 暴露的是那些源条目：

| 持久化的 `entry.type` | 重建的 `message.role` | 含义                                   |
| --------------------- | --------------------- | -------------------------------------- |
| `branch_summary`      | `branchSummary`       | 被放弃分支的摘要。                      |
| `compaction`          | `compactionSummary`   | 压缩摘要轮次。                          |
| `custom_message`      | `custom`              | 通过 `pi.sendMessage` 发送的消息        |

`toolCall` 是一个**内容块类型**，不是角色：工具调用是 `assistant` 消息 `content` 数组中的一个块，配对的结果是一个具有 `role: "toolResult"` 的独立条目。请**逐字**匹配这些值 — 与 snake_case 常量比较、或先将 `role` 小写化（`"toolResult"` → `"toolresult"`）的过滤器匹配不到任何分支，会**静默丢弃**该条目，没有任何错误或日志，因此以 `role` 为键的会话捕获会丢失每一个工具结果，而用户/助手文本仍然正常通过。

```ts
for (const entry of ctx.sessionManager.getBranch()) {
  switch (entry.type) {
    case "custom_message":
      // pi.sendMessage payload: entry.customType, entry.content
      break;
    case "branch_summary":
      // reconstructed as role: "branchSummary"
      break;
    case "compaction":
      // reconstructed as role: "compactionSummary"
      break;
    case "message":
      switch (entry.message.role) {
        case "assistant":
          // tool calls: entry.message.content.filter(b => b.type === "toolCall")
          break;
        case "toolResult":
          // entry.message.toolCallId, entry.message.content
          break;
      }
      break;
  }
}
```

## 渲染扩展点

## Composer 形状渲染器

`registerComposerShape` 将扩展拥有的输入编辑器布局添加到 **Appearance → Composer Shape**。从扩展工厂注册它；渲染器由实时编辑器及其设置预览使用。

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
- `description`：可选的选择器详细说明。
- `style`：完整的 `ComposerStyle` 渲染契约。`style.id` 也是持久化的 `composer.shape` 值。

使用包名限定的、非空且已去除首尾空白的 `style.id`。内置 id（`box`、`claude`、`pi`、`borderless`、`rule`、`field` 和 `rail`）无法被替换。如果扩展不可用但其 id 仍被配置，编辑器会回退到 `box`。

### `ComposerStyle` 布局元数据

- `sideBorders`：内容行是否拥有侧边修饰。这控制光标预留、IME 布局和滚动条行为；它不仅仅是描述性的。
- `verticalChrome`：用于编辑器高度预算的固定顶部/底部修饰行的精确数量（`0`、`1` 或 `2`）。
- `statusAttachment`：`"top-border"` 接收嵌入的状态仪表，`"top-rule-chip"` 接收用于停靠在分隔线上的右侧状态组，`"none"` 将状态从编辑器修饰中分离。
- `bottomBar`：编辑器下方的独立状态内容：`"none"`、`"left"` 或 `"full"`。
- `bottomBarGap`：是否用空行分隔编辑器与独立的底部状态栏。
- `defaultPromptGutter`：宿主未提供覆盖时使用的提示符文本。
- `defaultPaddingX(themePaddingX)`：为此样式选择的水平内边距。
- `sideChromeWidth(paddingX)`：内容行**每**一侧消耗的可见单元格，包括内边距和边框/导轨字形。

`renderTop` 和 `renderBottom` 返回一个样式化的终端行或 `undefined`。`renderRow` 返回一个或多个样式化行。每个正常渲染的行必须恰好占据 `ctx.width` 个可见单元格；ANSI 转义序列宽度为零。请保留传入的 `gutter`、`text` 和 `pad`，而不要重新排版或截断它们。

### 渲染器上下文

所有渲染方法接收 `width`、`paddingX`、主题的 `box` 字形，以及三个样式函数：

- `borderColor(text)`：普通边框/分隔线颜色。
- `accentColor(text)`：用于界定形状的导轨或端帽的稳定强调色。
- `surfaceColor(text)`：在装饰性输入中能经受嵌套 SGR 重置的 composer 背景填充。

如果存在 `topBorder`，它是已完成样式化的状态内容，并带有其可见的 `width`。顶部渲染器拥有其放置权，必须让最后一行保持在 `ctx.width`。

`renderRow` 额外接收：

- `gutter`、`text` 和 `pad`：预渲染的内容片段。
- `isLastRow`：最后一个可见输入行。
- `cursorOverflow`：行尾光标从右侧修饰中消耗的单元格。
- `imeSafeCursorTail`：省略光标之后的右侧单元格，使终端本地的 IME 预编辑无法移动修饰部分。
- `scrollbarThumb`：此行与编辑器滚动条滑块相交。

`packages/tui/src/components/composer/` 中的内置实现是带边框、分隔线、填充表面和 IME 安全布局的参考。

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

由交互式渲染使用，用于在每个可见的助手思考块下方添加仅显示用的补充 UI。渲染器接收已经可见的思考文本、content/thinking 索引、主题，以及供异步渲染器使用的 `requestRender()` 回调。所有返回组件的已注册渲染器按注册顺序追加。渲染器不得变更消息；原始思考块仍然是 provider/会话的事实来源。

## 工具调用/结果渲染器

在 `registerTool` 定义上提供 `renderCall` / `renderResult`，用于在 TUI 中自定义工具的可视化。

## 约束和陷阱

- 扩展加载期间运行时动作不可用。
- `tool_call` 错误会阻止执行（fail-closed）。
- 与内置命令冲突的命令名会被跳过并生成诊断信息。
- 保留的快捷键会被忽略（`ctrl+c`、`ctrl+d`、`ctrl+z`、`ctrl+k`、`ctrl+p`、`ctrl+l`、`ctrl+o`、`ctrl+t`、`ctrl+g`、`ctrl+q`、`alt+m`、`alt+p`、`shift+tab`、`shift+ctrl+p`、`shift+f1`、`shift+f2`、`alt+enter`、`escape`、`enter`）。
- 将 `ctx.reload()` 视为对当前命令处理器帧的终止。

## 扩展 vs hook vs custom-tools

使用正确的接口：

- **扩展**（`src/extensibility/extensions/*`）：统一系统（事件 + 工具 + 命令 + 渲染器 + provider 注册）。
- **hook**（`src/extensibility/hooks/*`）：独立的旧版事件 API。
- **custom-tools**（`src/extensibility/custom-tools/*`）：以工具为中心的模块；与扩展一起加载时，它们会被适配，并且仍然经过扩展拦截包装器。

如果你需要一个同时拥有策略、工具、命令 UX 和渲染的包，请使用扩展。
