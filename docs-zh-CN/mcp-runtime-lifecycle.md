# MCP 运行时生命周期

本文档介绍在 coding-agent 运行时中，MCP 服务器是如何被发现、连接、暴露为工具、刷新以及拆解的。

## 生命周期一览

1. **SDK 启动**会启动 MCP 发现（除非 MCP 被禁用）：无头/SDK 会话会等待 `discoverAndLoadMCPTools()`；交互式会话（`hasUI: true`）会预先创建管理器，并把 `discoverAndConnect()` 推迟到会话激活之后。
2. **发现**（`loadAllMCPConfigs`）从能力源解析 MCP 服务器配置，过滤被禁用/项目/Exa 条目，并在启用内置浏览器 prelude 时过滤浏览器 MCP 服务器，同时保留来源元数据。
3. **管理器连接阶段**（`MCPManager.connectServers`）并行启动每个服务器的连接 + `tools/list`。
4. **快速启动闸门**最多等待 250ms，然后可能返回：
   - 完全加载的 `MCPTool`，
   - 每个服务器的失败，
   - 或为仍在进行中的服务器提供缓存的 `DeferredMCPTool`。
5. **SDK 接线**把 MCP 工具合并到该会话的运行时工具注册表。
6. **连接后增强**以尽力而为的方式加载资源、资源模板、提示词以及可选的资源订阅。
7. **活动会话**通过管理器回调接收迟到的工具变更；`/mcp reload` 执行 `disconnectAll` + 重新发现 + `session.refreshMCPTools`，而传输关闭和 `/mcp reconnect` 则走逐服务器重连路径。
8. **拆解**发生在显式断开管理器时，并在所属 `AgentSession` 被释放时自动发生；被借用的父管理器不会被子代理断开。

## 发现与加载阶段

### 来自 SDK 的入口路径

`createAgentSession()`（位于 `src/sdk.ts`）在 `enableMCP` 为 true（默认）时执行 MCP 启动。共有两条路径：

- **无头/SDK**（无 UI、未提供管理器）：等待 `discoverAndLoadMCPTools(cwd, { ... })`，并把返回的工具合并到启动时的 `customTools` 集合中。
- **交互式/TUI**（`hasUI: true`、未提供管理器）：立即构造 `MCPManager`（含缓存 + 认证存储），把 `discoverAndConnect()` 推迟到会话存在后启动的后台任务，然后通过 `session.refreshMCPTools(...)` 绑定工具（如果会话在连接中途被拆解，则释放该管理器）。

两条路径都会：

- 传入 `authStorage`、缓存存储、`mcp.enableProjectConfig`，以及基于 `browser.enabled` prelude 设置的浏览器 MCP 过滤，
- 始终设置 `filterExa: true`，
- 记录每个服务器的加载/连接错误，
- 把管理器存入 `toolSession.mcpManager` 以及会话结果。

如果 `enableMCP` 为 false，则完全跳过 MCP 发现。

### 配置发现与过滤

`loadAllMCPConfigs()`（`src/mcp/config.ts`）通过能力发现加载规范的 MCP 服务器条目，然后转换为遗留的 `MCPServerConfig`。

过滤行为：

- `enableProjectConfig: false` 会移除项目级条目（`_source.level === "project"`）。
- `enabled: false` 的条目会被抑制，除非当前激活 profile 的用户级 `enabledServers` 白名单列出了它们；用户级 `disabledServers` 黑名单始终会抑制同名条目。
- 默认会过滤掉 Exa 服务器，并提取 API key 用于原生 Exa 工具集成，除非配置显式请求原生集成未提供的 Exa 工具（`web_fetch_exa`、`web_search_advanced_exa`）；当 `filterBrowser` 为 true 时，会过滤掉浏览器自动化 MCP 服务器。

结果同时包含 `configs` 和 `sources`（后续用于 provider 标记的元数据）。

### 发现层面的失败行为

`discoverAndLoadMCPTools()` 区分两类失败：

- **发现硬失败**（`manager.discoverAndConnect` 抛出异常，通常来自配置发现）：返回空的工具集以及一个合成的错误 `{ path: ".mcp.json", error }`。
- **逐服务器的运行时/连接失败**：管理器返回带 `errors` 映射的部分成功；其他服务器继续。

因此，即使个别 MCP 服务器失败，启动也不会让整个 agent 会话失败。

## 管理器状态模型

`MCPManager` 用相互独立的注册表跟踪运行时生命周期：

- `#connections: Map<string, MCPServerConnection>` — 完全连接的服务器。
- `#pendingConnections: Map<string, Promise<MCPServerConnection>>` — 握手中。
- `#pendingToolLoads: Map<string, Promise<{ connection, serverTools }>>` — 已初始化、其 `tools/list` 仍在进行中的连接。
- `#tools: CustomTool[]` — 暴露给调用方的当前 MCP 工具视图，保持稳定的名称顺序。
- `#sources: Map<string, SourceMeta>` — 即使连接完成之前也存在的 provider/来源元数据。
- `#pendingReconnections: Map<string, Promise<MCPServerConnection | null>>` — 传输掉线或显式重连之后正在进行的重连。
- `#serverConfigs: Map<string, MCPServerConfig>` — 保留的原始未解析配置，以便重连时能重新解析凭据而不泄露已解析的 token。
- `#reconnectHistory: Map<string, number[]>` 加上 `#epoch` — 逐服务器的崩溃窗口统计，以及使存活时间超过全局断开的重连尝试失效的机制。
- 监听器/回调状态，包括一个有界的待处理通知 FIFO 以及被跟踪的资源订阅/刷新。

`getConnectionStatus(name)` 从这些映射派生状态：

- 如果在 `#connections` 中则为 `connected`，
- 如果存在进行中的连接、进行中的工具加载或进行中的重连则为 `connecting`，
- 否则为 `disconnected`。

## 连接建立与启动时序

### 逐服务器的连接流水线

对于 `connectServers()` 中的每个已发现服务器：

1. 存储/更新来源元数据，
2. 如果已连接/正在进行/正在重连则跳过，
3. 校验传输字段（`validateServerConfig`），
4. 保存未解析的配置以便将来重连，
5. 解析托管 OAuth 凭据以及 env/header 的 shell 替换（`#resolveAuthConfig`），
6. 调用 `connectToServer(name, resolvedConfig)`，并传入管理器的通知/请求处理器，
7. 接好 HTTP OAuth 刷新以及传输 `onClose` 的重连处理，
8. 调用 `listTools(connection)`，
9. 以尽力而为的方式缓存工具定义（`MCPToolCache.set`），
10. 在工具加载后以尽力而为的方式加载资源、资源模板、提示词和订阅。

`connectToServer()` 行为（`src/mcp/client.ts`）：

- 创建 stdio 或 HTTP/SSE 传输，
- 使用协议版本 `2025-11-25` 执行 MCP `initialize`，并声明 `roots` 能力，
- 应答服务器到客户端的 `ping` 和 `roots/list` 请求；不支持的请求方法返回 JSON-RPC `-32601`，
- 在任何后续会话流量之前发送 `notifications/initialized`，
- 对于 Streamable HTTP，仅在 `notifications/initialized` 之后才启动后台 SSE 监听器，
- 超时优先级为 `OMP_MCP_TIMEOUT_MS`、`config.timeout`，然后是 30s；`0` 禁用客户端侧超时，
- 初始化失败时关闭传输。

### 快速启动闸门 + 延迟回退

`connectServers()` 等待以下两者之间的竞速：

- 所有连接/工具加载任务都已落定，以及
- `STARTUP_TIMEOUT_MS = 250`。

250ms 之后：

- 成功的任务成为活动的 `MCPTool`，
- 被拒绝的任务产生逐服务器的错误，
- 仍在进行中的任务：
  - 如果有可用的缓存工具定义（`MCPToolCache.get`），则用它们创建 `DeferredMCPTool`，
  - 否则在启动时不贡献任何工具；它们保持在途，后台续接在连接/列表完成后通过 `#onToolsChanged` 注册其工具（慢速服务器不再阻塞启动 — issue #2100）。

这是一种混合启动模型：有缓存时用延迟句柄快速返回，没有缓存时则在后台延迟注册。

### 后台完成行为

每个进行中的 `toolsPromise` 还带有一个后台续接，它最终会：

- 替换管理器状态中该服务器的工具切片，并恢复稳定的名称排序，
- 调用 `#onToolsChanged`，让活动会话可以重新绑定迟到的工具，
- 写入缓存，
- 仅在启动之后记录迟到的失败（`allowBackgroundLogging`）。

## 工具暴露与活动会话可用性

### 启动时的注册

`discoverAndLoadMCPTools()` 把管理器工具转换为 `LoadedCustomTool[]`，并装饰路径（在已知时为 `mcp:<server> via <providerName>`）。

随后 `createAgentSession()` 把这些工具推入 `customTools`，后者被包装并以 `mcp__<server>_<tool>` 这样的名称加入运行时工具注册表。

服务器和工具的名称组件会被转为小写，并规范化为字母/下划线。如果两个不同的来源产生了相同的运行时名称，OMP 会记录该冲突，并基于原始的服务器/工具身份保留一个确定性的胜出者，因此重连顺序不会改变归属。

### 工具调用

- `MCPTool` 通过已连接的 `MCPServerConnection` 调用工具。
- `DeferredMCPTool` 在调用前等待 `waitForConnection(server)`；这允许缓存工具在连接就绪之前就存在。
- 两者都会针对可重试的连接失败尝试一次重连 + 单次重试。
- 结构化的工具结果认证挑战可以触发已配置的认证处理器、重连以及一次重试。交互式模式会把它接到 `/mcp` OAuth 控制器；没有处理器时，该挑战仍作为 MCP 错误。

两者都返回结构化的工具输出，并把其余传输/工具错误转换为 `MCP error: ...` 工具内容（abort 仍是 abort）。

## 刷新/重载路径（启动时 vs 活动重载）

### 初始启动路径

- 在 `sdk.ts` 中进行一次性的发现/加载，
- 工具在初始会话工具注册表中完成注册。

### 交互式重载与活动变更路径

`/mcp reload`（`src/modes/controllers/mcp-command-controller.ts`）会：

1. `mcpManager.disconnectAll()`，
2. 清除陈旧的 MCP 提示词命令，
3. 使用与启动时相同的项目/Exa/浏览器过滤器调用 `mcpManager.discoverAndConnect()`，
4. 调用 `session.refreshMCPTools(mcpManager.getTools())`。

`session.refreshMCPTools()`（`src/session/agent-session.ts`）会移除所有 `mcp__` 工具，重新包装最新的 MCP 工具，并重新激活该工具集，使变更无需重启即可生效。所属的 SDK 会话还会安装 `setOnToolsChanged`，因此迟到的初始连接、服务器 `tools/list_changed` 通知、重连和断开都能触发同样的重新绑定。显式的 `/mcp reconnect <name>` 会在管理器重连完成后执行最后一次刷新。

## 服务器发起的通知

MCP 服务器可以在 `initialize` 完成后的任意时刻推送 JSON-RPC 通知帧。传输通过 `onNotification` 暴露它们；管理器分两条路径扇出：

1. 针对已知方法的**内部刷新**：
   - `notifications/tools/list_changed` → `refreshServerTools`
   - `notifications/resources/list_changed` → `refreshServerResources`
   - `notifications/resources/updated` → `#onResourcesChanged`（仅针对当前已订阅的 URI）
   - `notifications/prompts/list_changed` → `refreshServerPrompts`
2. **监听器扇出**：每条通知（已知的和服务器自定义的都包括）都会在任何内部刷新之后投递。`MCPManager.addNotificationListener(listener)` 返回一个取消订阅函数；多个监听器之间具有独立的错误隔离。

如果没有附加监听器，管理器会缓冲最多 100 帧，溢出时丢弃最旧的帧，然后在第一个附加的监听器上排空该 FIFO。`sdk.ts` 注册了一个逐会话监听器，它桥接到扩展运行器的 `mcp_notification` 事件，事件内容为 `{ server, method, params }`；扩展运行器自身也有一个有界的启动缓冲。监听器和防抖计时器会通过会话事后清理释放。

## 健康状态、重连与部分失败行为

当前运行时行为由连接事件驱动：

- 管理器/客户端中**没有自主轮询的健康监视器**。
- **自动重连接在 `transport.onClose` 上**，用于受管连接。
- 重连以退避方式重试（`500`、`1000`、`2000`、`4000` ms），重新加载工具，并在成功时通知使用方。当 30s 内重连调用超过 5 次时，崩溃风暴熔断器会暂停该服务器的自动重连；手动 `/mcp reconnect` 会重置该历史。
- 遇到可重试连接错误的工具调用也会尝试一次重连 + 重试。
- 重连也可以通过 `/mcp reconnect <name>` 或范围更大的 `/mcp reload` 显式发起。

在运维层面：

- 一个服务器失败不会移除健康服务器的工具，
- 连接/列表失败按服务器隔离，
- 重连期间陈旧工具可能仍然可见；如果恢复失败，调用会报告 MCP 错误，
- 工具缓存、资源/提示词加载、订阅和后台更新都是尽力而为（记录警告/错误，不做硬性停止）。

## 拆解语义

### 服务器级拆解

`disconnectServer(name)`：

- 移除进行中的连接/工具加载/重连条目、来源元数据、已保存的配置、重连历史以及资源刷新/订阅状态，
- 分离 `onClose`，使显式关闭不会触发重连，
- 若已连接则关闭传输，
- 按工具的精确 `mcpServerName` 归属移除工具（而不是按规范化后的名称前缀），并通知工具使用方，
- 在陈旧提示词命令需要移除时通知提示词使用方。

### 全局拆解与所有权

`disconnectAll()`：

- 递增生命周期 epoch，使稍后完成的重连尝试无法复活旧连接，
- 为所有活动传输分离 `onClose`，然后用 `Promise.allSettled` 关闭它们，
- 清空进行中的映射、来源、已保存的配置、连接、订阅、资源刷新、重连历史以及管理器工具。

顶层会话拥有自己创建的管理器。`AgentSession.dispose()` 会断开该所属管理器，清理超时为 3 秒，并记录清理失败；通过 `options.mcpManager` 获得管理器的子代理/会话借用父管理器，不会断开它。`/mcp reload` 在 `disconnectAll` 之后有意复用管理器对象，因此已安装的回调/监听器在下一个发现周期仍然可用。

## 失败模式与保证

| 场景 | 行为 | 硬失败 vs 尽力而为 |
| ---- | ---- | ---- |
| 发现抛出异常（能力/配置加载路径） | 加载器返回空工具 + 合成的 `.mcp.json` 错误 | 会话启动尽力而为 |
| 无效的服务器配置 | 跳过该服务器并记录校验错误条目 | 每个服务器尽力而为 |
| 连接超时/初始化失败 | 记录服务器错误；其他服务器继续 | 每个服务器尽力而为 |
| 启动时 `tools/list` 仍进行中且缓存命中 | 立即返回延迟工具 | 快速启动尽力而为 |
| 启动时 `tools/list` 仍进行中且无缓存 | 启动时没有工具；后台续接在就绪后通过 `#onToolsChanged` 注册它们 | 延迟注册尽力而为 |
| 后台工具加载迟到失败 | 在启动闸门之后记录 | 日志尽力而为 |
| 运行时传输掉线 | 管理器尝试重连；重连期间陈旧工具保留，后续调用可能重试一次或以 MCP 错误失败 | 自动恢复尽力而为 |
| 30s 内重连调用超过 5 次 | 熔断器关闭/移除陈旧连接，但保留已注册的工具；手动重连会重置该历史 | 自动重连暂停 |
| 所属会话被释放 | 等待所属管理器断开最多 3s；失败会被记录 | 有界尽力而为清理 |

## 公开 API 面

`src/mcp/index.ts` 重新导出客户端操作、配置加载器/写入器 API、加载器与管理器 API、OAuth 发现、工具桥接/缓存、HTTP 与 stdio 传输、协议类型，以及轻量级 HTTP 辅助函数 `callMCP`、`readMcpJsonRpcResponse` 和 `redactUrlForLog`。`src/sdk.ts` 将 `discoverMCPServers()` 暴露为 `discoverAndLoadMCPTools` 之上的便捷包装；它返回 `{ manager, tools, errors, connectedServers, exaApiKeys }`。

## 实现文件

- [`src/mcp/loader.ts`](../packages/coding-agent/src/mcp/loader.ts) — 加载器门面、发现错误规范化、`LoadedCustomTool` 转换。
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts) — 生命周期状态注册表、并行连接/列表流程、刷新/断开。
- [`src/mcp/client.ts`](../packages/coding-agent/src/mcp/client.ts) — 传输建立、初始化握手、列表/调用/断开。
- [`src/mcp/index.ts`](../packages/coding-agent/src/mcp/index.ts) — MCP 模块 API 导出。
- [`src/sdk.ts`](../packages/coding-agent/src/sdk.ts) — 启动到会话/工具注册表的接线。
- [`src/mcp/config.ts`](../packages/coding-agent/src/mcp/config.ts) — 管理器使用的配置发现/过滤/校验。
- [`src/mcp/tool-bridge.ts`](../packages/coding-agent/src/mcp/tool-bridge.ts) — `MCPTool` 与 `DeferredMCPTool` 的运行时行为。
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — `refreshMCPTools` 实时重新绑定。
- [`src/modes/controllers/mcp-command-controller.ts`](../packages/coding-agent/src/modes/controllers/mcp-command-controller.ts) — 交互式重载/重连流程。
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — 通过父管理器连接的子代理 MCP 代理。
