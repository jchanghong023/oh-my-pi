# SDK

SDK 是 `@oh-my-pi/pi-coding-agent` 的进程内集成接口。
当你希望在 Bun 进程中直接访问 agent 状态、事件流、工具装配和会话控制时，请使用它。

如果需要跨语言/进程隔离，请改用 RPC 模式。

## Installation

```bash
bun add @oh-my-pi/pi-coding-agent
```

需要 Bun 1.3.14 或更高版本。在首次发起依赖模型的 prompt 之前，请为某个 provider 配置凭据，或运行一个免密钥的本地 provider；参见
[Providers](./providers.md)。会话构造在没有可用模型的情况下也可以成功，但 prompt 行为不能。

## Entry points

包根 `@oh-my-pi/pi-coding-agent` 是完整的嵌入接口。它包含 `createAgentSession` 以及聚焦的 `/sdk` 导出，外加更底层的 session、auth、model、mode、extension 和 tool API。

从包根导入这些核心嵌入 API：

- `createAgentSession`
- `SessionManager`
- `Settings`
- `AuthStorage`
- `ModelRegistry`
- `AgentRegistry`
- `discoverAuthStorage`
- 发现辅助函数（`discoverExtensions`、`discoverSkills`、`discoverContextFiles`、`discoverPromptTemplates`、`discoverSlashCommands`、`discoverCustomTSCommands`、`discoverMCPServers`）
- 工具工厂接口（`createTools`、`BUILTIN_TOOLS`、tool 类）

更窄的 `@oh-my-pi/pi-coding-agent/sdk` 子路径导出 `createAgentSession` 及其选项/结果类型、`Settings`、`AgentRegistry`、发现与 system-prompt 辅助函数、工作区目录树辅助函数、选定的 extension/MCP/tool 类型，以及选定的 tool 类/工厂。它**不**导出 `SessionManager`、`AuthStorage` 或 `ModelRegistry`；请按下方示例所示，从包根导入这三者。

## Quick start (auto-discovery defaults)

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";

const { session, modelFallbackMessage } = await createAgentSession();

if (modelFallbackMessage) {
  process.stderr.write(`${modelFallbackMessage}\n`);
}

const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Summarize this repository in 3 bullets.");
unsubscribe();
await session.dispose();
```

## What `createAgentSession()` discovers by default

`createAgentSession()` 遵循“提供以覆盖，省略以发现”的原则。

如果省略，它会解析以下内容：

- `cwd`：`getProjectDir()`
- `agentDir`：`~/.omp/agent`（通过 `getAgentDir()`）
- `authStorage`：`discoverAuthStorage(agentDir)`
- `modelRegistry`：`new ModelRegistry(authStorage)`，当未提供 registry 时会在后台执行 `refreshInBackground()`
- `settings`：`await Settings.init({ cwd, agentDir })`
- `sessionManager`：`SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))`（基于文件）
- skills/rules/context files/prompt templates/slash commands/extensions/custom TS commands
- 通过 `createTools(...)` 提供的内置工具
- MCP 工具（默认启用；Exa MCP 服务器被合并进原生 Exa 集成，并且当内置浏览器工具启用时，浏览器自动化 MCP 服务器会被过滤）
- LSP 集成（默认启用）
- `eventBus`：除非提供，否则新建一个 `EventBus()`

### Required vs optional inputs

通常你只需要提供你希望控制的内容：

```ts
function createAgentSession(
  options?: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult>;
```

- **必须提供**：对于一个最小化会话而言，无需提供任何内容
- **在嵌入器中通常显式提供**：
  - `sessionManager`（如果你需要内存中或自定义位置的会话）
  - `authStorage` + `modelRegistry`（如果你自行管理凭据/模型生命周期）
  - `model` 或 `modelPattern`（如果模型选择的确定性很重要）
  - `settings`（如果你需要隔离/测试用的配置）

如果在一个进程中需要多个并发的顶层会话，请为每个会话传入一个私有的
`AgentRegistry`。默认的进程全局 registry 在每一代中只允许一个 `"Main"` 标识。

## Session manager behavior (persistent vs in-memory)

`AgentSession` 始终使用一个 `SessionManager`；其行为取决于你使用的工厂方法。

### File-backed (default)

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

console.log(session.sessionFile); // absolute .jsonl path
```

- 将对话/消息/状态增量持久化到会话文件。
- 支持 resume/open/list/fork 工作流。
- `session.sessionFile` 会被定义。

### In-memory

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

console.log(session.sessionFile); // undefined
```

- 不进行文件系统持久化。
- 适用于测试、临时 worker、按请求作用域的 agent。
- 会话方法仍然可用，但与持久化相关的行为（文件 resume/fork 路径）自然会受到限制。

### Resume/open/list helpers

```ts
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

const recent = await SessionManager.continueRecent(process.cwd());
const listed = await SessionManager.list(process.cwd());
const opened = listed[0] ? await SessionManager.open(listed[0].path) : null;
```

## Model and auth wiring

`createAgentSession()` 使用 `ModelRegistry` + `AuthStorage` 来进行模型选择和 API key 解析。

如果同时提供了 `authStorage` 和 `modelRegistry`，
那么 `modelRegistry.authStorage` 必须是同一个实例；会话创建会拒绝不一致的存储。

### Explicit wiring

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const available = modelRegistry.getAvailable();
if (available.length === 0)
  throw new Error("No authenticated models available");

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  model: available[0],
  thinkingLevel: "medium",
  sessionManager: SessionManager.inMemory(),
});
```

### Selection order when `model` is omitted

当未提供显式的 `model`/`modelPattern` 时：

1. 从现有会话中恢复模型（如果可恢复且密钥可用）
2. settings 中的默认模型角色（`default`）
3. 按可用性顺序选择一个已认证的 provider 默认模型（当没有 provider 默认模型时，回退到第一个已认证的可用模型）

如果恢复失败，`modelFallbackMessage` 会解释回退原因。

### Auth priority

`AuthStorage.getApiKey(...)` 按以下顺序解析：

1. 运行时覆盖（`setRuntimeApiKey`，由 CLI `--api-key` 使用）
2. 来源于配置的 API key 覆盖（`models.yml` 中 provider 的 `apiKey`）
3. 存储的 OAuth 凭据，必要时进行刷新
4. 通过一次成功的 `/login` 持久化的 API key
5. provider 的环境变量
6. `agent.db`/broker 后端存储中的其他已存储 API key 凭据
7. custom-provider 解析器的回退

## Event subscription model

通过 `session.subscribe(listener)` 订阅；它返回一个取消订阅的函数。

```ts
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "tool_execution_start":
      break;
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
  }
});
```

`AgentSessionEvent` 包含核心的 `AgentEvent` 以及会话级事件：

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `retry_fallback_applied` / `retry_fallback_succeeded`
- `model_changed`
- `thinking_level_changed`
- `ttsr_triggered`
- `todo_reminder` / `todo_auto_clear`
- `irc_message`
- `notice`
- `goal_updated`

`agent_end` 包含 `messages`、可选的遥测字段，以及
`isTerminal?: boolean`。当 `isTerminal` 为 `false` 时，维护或异步交付逻辑会在真正最终结算之前恢复该会话。将 `agent_end` 用作完成信号的订阅者必须等待 `isTerminal !== false`。
为了与旧运行时保持兼容，可将缺失该字段视为终态。

## Prompt lifecycle

`session.prompt(text, options?)` 是主要的入口点。

行为：

1. 可选的命令/模板展开（`/` 命令、自定义命令、文件 slash 命令、prompt 模板）
2. 如果当前正在流式输出：
   - `streamingBehavior: "steer" | "followUp"` 决定 `prompt()` 的排队方式
   - 当省略 `deliverAs` 时，extension 的 `sendUserMessage(content)` 默认为 steer
   - 已排队的消息会被保留，而不是被丢弃
3. 如果处于空闲：
   - 校验 model + API key
   - 追加用户消息
   - 启动 agent turn

相关 API：

- `sendUserMessage(content, { deliverAs? })`
- `steer(text, images?)`
- `followUp(text, images?)`
- `sendCustomMessage({ customType, content, ... }, { deliverAs?, triggerTurn? })`
- `abort()`

## `AgentSession` lifecycle and disposal

当嵌入器对某个会话完全使用完毕时，调用 `await session.dispose()`。`dispose()` 会自行启动清理流程，并且是幂等的：重复或并发的调用会收到同一个 teardown promise，因此 shutdown 事件和被拥有的资源不会被排空两次。

`beginDispose()` 是同步的准入屏障，适用于那些必须在调用 `dispose()` 之前先 await 自身 teardown 的包装器。请在包装器的第一次 `await` 之前调用它；否则延迟的工作可能进入空档。它会立即将会话标记为 disposed，取消内存启动、标题生成和 auto-learn 捕获，清除已排队的 yield/aside，停止 advisor 运行时，分离 aside 投递，并拒绝新的 eval 执行。延迟的会话工作会检查 disposed 状态并被丢弃或跳过。`beginDispose()` 也是幂等的，但随后的 `dispose()` 调用仍然是完成异步清理所必需的。

```ts
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

async function closeEmbeddedSession(
  session: AgentSession,
  closeHostInputAndUi: () => Promise<void>,
): Promise<void> {
  session.beginDispose(); // no new deferred work may enter after this point
  await closeHostInputAndUi();
  await session.dispose();
}
```

在异步清理过程中，会话会记录并同步刷新其退出诊断，一次性发出 `session_shutdown`，停止 extension 的回退定时器，中止重试、压缩以及当前活动的 agent turn，并给 post-prompt 和 auto-learn 工作一个有限的时间窗口以完成结算。然后它会并发地拆除会话自有的异步任务、eval 内核、浏览器标签、原生 computer 会话、MCP 连接、advisor 状态以及 memory 状态。这些子系统排空操作是尽力而为的，并在适用的情况下有界；失败会被记录，但不会阻止剩余子系统的清理。

只有在能够向会话追加条目的工作都已结算之后，清理阶段才会清理一个空的已移动会话、关闭 `SessionManager`、关闭 provider 的会话状态、断开 agent 连接，并移除监听器。最终的持久化清理或 `SessionManager.close()` 产生的失败会使共享的清理 promise 被 reject；单个 provider 会话关闭失败则只会被记录。

## Tools and extension integration

### Built-ins and filtering

- 内置工具来自 `createTools(...)` 和 `BUILTIN_TOOLS`。
- `toolNames` 用于请求具名工具，并可以启用那些默认被禁用的工具；它本身**不是**一个允许列表。
- 设置 `restrictToolNames: true` 以将会话限制为 `toolNames` 中所列的名字。限制会话默认会禁用环境 MCP、extensions、自定义命令和 LSP。
- 在限制会话中，除非 `allowRestrictedCustomTools: true` 且其名称也出现在 `toolNames` 中，否则 SDK 提供的 `customTools` 会被排除。
- 隐藏工具（例如 `yield`）除非被选项要求，否则是按需启用的。

```ts
const { session } = await createAgentSession({
  toolNames: ["read", "grep", "glob", "write"],
  restrictToolNames: true,
  requireYieldTool: true,
});
```

### Extensions

- `extensions`：内联的 `ExtensionFactory[]`
- `additionalExtensionPaths`：加载额外的 extension 文件
- `disableExtensionDiscovery`：禁用环境扫描；显式路径和内联工厂仍会被加载
- `preloadedExtensions`：复用由同一会话所属进程提前加载的 extension 集合。永远不要将已加载的 extension 实例从一个父进程传给另一个会话；请使用 `preloadedExtensionPaths`，以便每个会话获得自己的 `ExtensionAPI` 绑定。

### Runtime tool set changes

`AgentSession` 支持运行时激活更新：

- `getActiveToolNames()`
- `getAllToolNames()`
- `setActiveToolsByName(names)`
- `refreshMCPTools(mcpTools)`

系统提示会重建以反映激活工具的变化。

## Discovery helpers

当你希望获得部分控制而又无需重建内部发现逻辑时，请使用这些：

- `discoverAuthStorage(agentDir?)`
- `discoverExtensions(cwd?)`
- `discoverSkills(cwd?, _agentDir?, settings?)`
- `discoverContextFiles(cwd?, _agentDir?, disabledExtensions?)`
- `discoverPromptTemplates(cwd?, agentDir?)`
- `discoverSlashCommands(cwd?)`
- `discoverCustomTSCommands(cwd?, agentDir?)`
- `discoverMCPServers(cwd?)`
- `buildSystemPrompt(options?)`

## Subagent-oriented options

对于构建编排器的 SDK 消费者（类似于 task executor 流程）：

- `outputSchema`：将结构化输出期望传入工具上下文
- `outputSchemaMode`：选择宽松或严格结构化输出执行
- `requireYieldTool`：强制包含 `yield` 工具
- `taskDepth`：用于嵌套 task 会话的递归深度上下文
- `parentTaskPrefix`：用于嵌套 task 输出的工件命名前缀

这些对于普通的单 agent 嵌入是可选的。

## `createAgentSession()` return value

```ts
type CreateAgentSessionResult = {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
  mcpManager?: MCPManager;
  modelFallbackMessage?: string;
  lspServers?: Array<{
    name: string;
    status: "connecting" | "ready" | "error" | "available";
    fileTypes: string[];
    error?: string;
  }>;
  eventBus: EventBus;
};
```

仅当你的嵌入器提供工具/extension 应当调用的 UI 能力时，才使用 `setToolUIContext(...)`。

## Startup performance

`createAgentSession()` 运行两项后台优化，以使 I/O 与其余会话设置重叠进行：

- **Model-host preconnect.** 一旦模型被解析，SDK 就会发出一次尽力而为的 `fetch.preconnect(model.baseUrl)`，以便到 provider 主机的 DNS + TCP + TLS + HTTP/2 与 extension/skill 加载、工具 registry 构建和 system-prompt 组装并行进行。第一次真正的 `fetch(...)` 随后复用这个热连接，在跨洲跳跃（例如住宅 IP → `api.anthropic.com`）上可节省 100–300 ms。实现位于 `packages/coding-agent/src/sdk.ts` 的 `preconnectModelHost()` 中。如果 `fetch.preconnect` 不可用（非 Bun 运行时）或调用抛出，该优化会被静默跳过——绝不会是硬性依赖。适用于所有模式（interactive、print、RPC、ACP）。
- **Conditional LSP warmup.** 启动期 LSP 服务器（由 `discoverStartupLspServers(cwd)` 返回的那些）只有在**同时**满足以下条件时才会被预热：
  - 会话选项上 `enableLsp !== false`，**并且**
  - `options.hasUI === true`（交互式 TUI），**并且**
  - `lsp.lazy` 设置被禁用（其默认值为 `true`）。

  当 `lsp.lazy` 启用时（默认值），在启动时根本不会启动任何 language server；每个 server 都会在首次使用时冷启动，即当 agent 调用 `lsp` 工具，或 edit/write 触及一个扩展名匹配 server `fileTypes` 的文件时。Print / script / RPC / ACP 调用（`hasUI=false`）无论设置如何都会跳过预热：它们不渲染预热状态指示器，并且通常在 language server 稳定之前就已经完成，因此为它们预热只会让 CPU 在解析巨大的 `initialize` 响应上与 LLM 流消费者并发地耗费资源，并使可感知的延迟产生抖动。真正需要 LSP server 的工具仍然会通过 `getOrCreateClient()` 按需启动一个——只是跳过了 _startup_ 预热。所返回的 `lspServers` 字段在 `CreateAgentSessionResult` 中仍会被填充：在 lazy 模式下，UI 会话仍会识别 server（不派生任何进程）并以状态 `"available"` 报告，以便欢迎界面和 `/status` 能够列出它们；它仅在 `enableLsp === false` 或 `hasUI === false` 时才是 `undefined`。

## Minimal controlled embed example

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const settings = Settings.isolated({
  "compaction.enabled": true,
  "retry.enabled": true,
});

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  settings,
  sessionManager: SessionManager.inMemory(),
  toolNames: ["read", "grep", "glob", "edit", "write"],
  enableMCP: false,
  enableLsp: true,
});

session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Find all TODO comments in this repo and propose fixes.");
await session.dispose();
```
