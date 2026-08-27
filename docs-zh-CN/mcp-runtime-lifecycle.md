# MCP runtime lifecycle

本文档介绍在 coding-agent runtime 中 MCP 服务器是如何被发现、连接、暴露为工具、刷新以及拆解的。

## Lifecycle at a glance

1. **SDK startup** 启动 MCP 发现（除非 MCP 被禁用）：headless/SDK 会话会 `await discoverAndLoadMCPTools()`；interactive 会话（`hasUI: true`）会立即创建 manager，并将 `discoverAndConnect()` 延迟到会话激活后再执行。
2. **Discovery** （`loadAllMCPConfigs`）从 capability 源解析 MCP server configs，过滤掉被禁用/项目/Exa 的条目，并在启用内置 browser tool 时过滤掉 browser MCP servers，同时保留 source 元数据。
3. **Manager connect phase** （`MCPManager.connectServers`）并行启动每个服务器的 connect + `tools/list`。
4. **Fast startup gate** 最长等待 250ms，然后可能返回：
   - 已完整加载的 `MCPTool`，
   - 每个服务器的失败信息，
   - 或针对仍处于 pending 状态的服务器的缓存 `DeferredMCPTool`。
5. **SDK wiring** 将 MCP tools 合并到会话的 runtime tool registry 中。
6. **Post-connect enrichment** 以 best-effort 方式加载 resources、resource templates、prompts 以及可选的 resource subscriptions。
7. **Live session** 通过 manager 回调接收迟到的工具变更；`/mcp reload` 执行 `disconnectAll` + 重新发现 + `session.refreshMCPTools`，而 transport close 和 `/mcp reconnect` 则使用 per-server reconnect 路径。
8. **Teardown** 在显式的 manager 断开时发生，并在所属的 `AgentSession` 被释放时自动发生；被借用的父级 manager 不会被子 agent 断开。

## Discovery and load phase

### Entry path from SDK

`createAgentSession()` 在 `src/sdk.ts` 中，当 `enableMCP` 为 true（默认）时执行 MCP 启动。共有两条路径：

- **Headless/SDK**（无 UI，未提供 manager）：`await discoverAndLoadMCPTools(cwd, { ... })`，并将返回的 tools 合并到启动时的 `customTools` 集合中。
- **Interactive/TUI**（`hasUI: true`，未提供 manager）：立即构造 `MCPManager`（包含 cache + auth storage），将 `discoverAndConnect()` 延迟到会话创建后启动的后台任务中执行，然后通过 `session.refreshMCPTools(...)` 绑定 tools（如果会话在连接中途被拆解，则释放 manager）。

两条路径都会：

- 传入 `authStorage`、cache storage、`mcp.enableProjectConfig`，以及基于 `browser.enabled` 设置的 browser-MCP 过滤，
- 始终设置 `filterExa: true`，
- 记录每个服务器的 load/connect 错误，
- 将 manager 存储到 `toolSession.mcpManager` 以及会话结果中。

如果 `enableMCP` 为 false，则完全跳过 MCP discovery。

### Config discovery and filtering

`loadAllMCPConfigs()`（`src/mcp/config.ts`）通过 capability discovery 加载规范的 MCP server items，然后转换为遗留的 `MCPServerConfig`。

过滤行为：

- `enableProjectConfig: false` 会移除项目级条目（`_source.level === "project"`）。
- `enabled: false` 的条目会被抑制，除非当前 profile 的用户 `enabledServers` allowlist 显式启用了它们；用户 `disabledServers` denylist 始终会抑制同名条目。
- 默认会过滤掉 Exa servers，并提取 API key 用于 native Exa tool 集成，除非 config 明确请求 native integration 未提供的 Exa tools（`web_fetch_exa`、`web_search_advanced_exa`）；当 `filterBrowser` 为 true 时，会过滤掉 browser automation MCP servers。

结果同时包含 `configs` 和 `sources`（后续用于 provider 标记的元数据）。

### Discovery-level failure behavior

`discoverAndLoadMCPTools()` 区分两类失败：

- **Discovery hard failure**（`manager.discoverAndConnect` 抛出异常，通常来自 config discovery）：返回一个空的 tool 集以及一个合成的错误 `{ path: ".mcp.json", error }`。
- **Per-server runtime/connect failure**：manager 返回带有 `errors` 映射的部分成功结果；其他服务器继续。

因此，即使个别 MCP server 失败，也不会让整个 agent session 启动失败。

## Manager state model

`MCPManager` 使用独立的注册表跟踪 runtime 生命周期：

- `#connections: Map<string, MCPServerConnection>` — 完全连接的服务器。
- `#pendingConnections: Map<string, Promise<MCPServerConnection>>` — 握手进行中。
- `#pendingToolLoads: Map<string, Promise<{ connection, serverTools }>>` — 已初始化但 `tools/list` 仍在进行的连接。
- `#tools: CustomTool[]` — 暴露给调用方的当前 MCP tool 视图，按稳定的 name 顺序维护。
- `#sources: Map<string, SourceMeta>` — 即使在 connect 完成前也保留 provider/source 元数据。
- `#pendingReconnections: Map<string, Promise<MCPServerConnection | null>>` — 在 transport 断开或显式 reconnect 之后正在进行的重连。
- `#serverConfigs: Map<string, MCPServerConfig>` — 保留的原始未解析 configs，以便 reconnect 时能重新解析凭据而不泄露已解析的 token。
- `#reconnectHistory: Map<string, number[]>` 与 `#epoch` — 每个服务器的 crash-window 计数以及使超出全局 disconnect 生命周期的 reconnect 尝试失效的机制。
- listener/callback 状态，包括一个有界 pending-notification FIFO 以及被跟踪的 resource subscriptions/refreshes。

`getConnectionStatus(name)` 从这些映射派生状态：

- 如果在 `#connections` 中则为 `connected`，
- 如果存在 pending connect、pending tool load 或 pending reconnect 则为 `connecting`，
- 否则为 `disconnected`。

## Connection establishment and startup timing

### Per-server connect pipeline

对于 `connectServers()` 中每个被发现的 server：

1. 存储/更新 source 元数据，
2. 如果已经 connected/pending/reconnecting 则跳过，
3. 校验 transport 字段（`validateServerConfig`），
4. 保存未解析的 config 以便可能的 reconnect，
5. 解析托管的 OAuth 凭据以及 env/header 的 shell 替换（`#resolveAuthConfig`），
6. 使用 manager 的 notification/request handler 调用 `connectToServer(name, resolvedConfig)`，
7. 接入 HTTP OAuth refresh 以及 transport 的 `onClose` reconnect 处理，
8. 调用 `listTools(connection)`，
9. 以 best-effort 方式缓存 tool 定义（`MCPToolCache.set`），
10. 在 tools 加载完成后，以 best-effort 方式加载 resources、resource templates、prompts 以及 subscriptions。

`connectToServer()` 行为（`src/mcp/client.ts`）：

- 创建 stdio 或 HTTP/SSE transport，
- 使用协议版本 `2025-11-25` 执行 MCP `initialize`，并声明 `roots` capability，
- 应答 server-to-client 的 `ping` 和 `roots/list` 请求；不支持的 request method 返回 JSON-RPC `-32601`，
- 在任何后续会话流量之前发送 `notifications/initialized`，
- 对于 Streamable HTTP，仅在 `notifications/initialized` 之后才启动后台 SSE listener，
- timeout 优先级为 `OMP_MCP_TIMEOUT_MS`，然后是 `config.timeout`，最后是 30s；`0` 表示禁用客户端侧 timeout，
- 在 init 失败时关闭 transport。

### Fast startup gate + deferred fallback

`connectServers()` 等待以下两者的竞争结果：

- 所有 connect/tool-load 任务都已 settled，
- 以及 `STARTUP_TIMEOUT_MS = 250`。

250ms 之后：

- 已完成的任务变为活跃的 `MCPTool`，
- 被拒绝的任务产生 per-server 错误，
- 仍 pending 的任务：
  - 如果存在缓存的 tool 定义（`MCPToolCache.get`），则使用它们创建 `DeferredMCPTool`，
  - 否则在启动时不贡献任何 tools；它们保持在飞行中，并由后台 continuation 在 connect/list 完成后通过 `#onToolsChanged` 注册它们的 tools（慢速 server 不再阻塞启动 — issue #2100）。

这是一种混合启动模型：在有缓存时快速返回并附带 deferred handles；在没有缓存时则通过后台延迟注册。

### Background completion behavior

每个 pending 的 `toolsPromise` 还附带一个最终会执行以下操作的后台 continuation：

- 替换 manager 状态中该 server 的 tool 切片，并恢复稳定的 name 排序，
- 调用 `#onToolsChanged`，以便 live session 可以重新绑定迟到的 tools，
- 写入缓存，
- 仅在 startup 之后记录迟到的失败（`allowBackgroundLogging`）。

## Tool exposure and live-session availability

### Startup registration

`discoverAndLoadMCPTools()` 将 manager 的 tools 转换为 `LoadedCustomTool[]`，并在已知时装饰路径（`mcp:<server> via <providerName>`）。

`createAgentSession()` 随后将这些 tools 推入 `customTools`，后者会被包装并以 `mcp__<server>_<tool>` 这样的名字加入 runtime tool registry。

Server 和 tool 名称组件会统一小写并规范化为字母/下划线。如果两个不同的来源产生了相同的 runtime name，OMP 会记录冲突并根据原始 server/tool 标识保留一个确定性的胜出者，从而确保 reconnect 顺序不会改变归属。

### Tool calls

- `MCPTool` 通过一个已连接的 `MCPServerConnection` 调用 tool。
- `DeferredMCPTool` 在调用前会等待 `waitForConnection(server)`；这允许缓存在连接就绪之前就已存在。
- 两者都会针对可重试的 connection failure 尝试一次 reconnect + single retry。
- 一个结构化的 tool-result auth challenge 可以触发已配置的 auth handler、reconnect 以及一次 retry。interactive 模式会将其接入 `/mcp` OAuth controller；没有 handler 时，challenge 将作为 MCP 错误保持不变。

两者都返回结构化的 tool output，并将其余的 transport/tool 错误转换为 `MCP error: ...` tool content（abort 仍保持为 abort）。

## Refresh/reload paths (startup vs live reload)

### Initial startup path

- 在 `sdk.ts` 中执行一次性的 discovery/load，
- tools 在初始的会话 tool registry 中完成注册。

### Interactive reload and live-change paths

`/mcp reload`（`src/modes/controllers/mcp-command-controller.ts`）执行：

1. `mcpManager.disconnectAll()`，
2. 清理过期的 MCP prompt commands，
3. 使用与启动时相同的 project/Exa/browser 过滤器调用 `mcpManager.discoverAndConnect()`，
4. 调用 `session.refreshMCPTools(mcpManager.getTools())`。

`session.refreshMCPTools()`（`src/session/agent-session.ts`）移除所有 `mcp__` tools，重新包装最新的 MCP tools，并重新激活该 tool 集合，以便在不重启的情况下应用变更。所属的 SDK session 还会安装 `setOnToolsChanged`，因此迟到的初始连接、服务器 `tools/list_changed` 通知、reconnects 以及 disconnects 都能触发同样的重新绑定。显式的 `/mcp reconnect <name>` 会在 manager reconnect 完成后执行最后一次 refresh。

## Server-initiated notifications

MCP 服务器可以在 `initialize` 完成之后的任意时刻推送 JSON-RPC notification 帧。transport 通过 `onNotification` 暴露这些帧；manager 沿两条路径进行扇出：

1. **Internal refresh** 针对已知 method：
   - `notifications/tools/list_changed` → `refreshServerTools`
   - `notifications/resources/list_changed` → `refreshServerResources`
   - `notifications/resources/updated` → `#onResourcesChanged`（仅针对当前已订阅的 URI）
   - `notifications/prompts/list_changed` → `refreshServerPrompts`
2. **Listener fanout**：在完成任何 internal refresh 之后，每条通知（包括已知的和服务器自定义的）都会被分发。`MCPManager.addNotificationListener(listener)` 返回一个 unsubscribe 函数；多个 listener 之间具有独立的错误隔离。

如果没有 listener 附加，manager 会缓冲最多 100 帧，溢出时丢弃最旧的帧，然后在该 FIFO 上第一个附加进来的 listener 上排空。`sdk.ts` 注册了一个 per-session listener，它桥接到 extension runner 的 `mcp_notification` 事件，事件内容为 `{ server, method, params }`；extension runner 自身也拥有一个有界的启动缓冲区。listener 和 debounce 计时器会在会话的 postmortem cleanup 中被释放。

## Health, reconnect, and partial failure behavior

当前 runtime 行为由 connection 事件驱动：

- manager/client 中**没有自主轮询的 health monitor**。
- **自动 reconnect 被接入 `transport.onClose`**，用于托管连接。
- Reconnect 使用回退重试（`500`、`1000`、`2000`、`4000` ms），重新加载 tools，并在成功时通知使用者。当 30s 内出现超过 5 次 reconnect 尝试时，crash-storm 熔断器会挂起该 server 的自动 reconnect；手动 `/mcp reconnect` 会重置该历史记录。
- 遇到可重试 connection 错误的 tool call 也会尝试一次 reconnect + retry。
- Reconnect 也可以通过 `/mcp reconnect <name>` 或范围更广的 `/mcp reload` 显式发起。

运行时行为：

- 单个 server 失败不会移除健康 server 的 tools，
- connect/list 失败在每个 server 上是隔离的，
- 在尝试 reconnect 期间，过时的 tools 可能会保持可见；调用在恢复失败时返回 MCP 错误，
- tool cache、resource/prompt 加载、subscriptions 以及后台更新都是 best-effort（会记录 warning/error，不会硬性中断）。

## Teardown semantics

### Server-level teardown

`disconnectServer(name)`：

- 移除 pending connect/tool-load/reconnect 条目、source 元数据、保存的 config、reconnect history 以及 resource refresh/subscription 状态，
- 分离 `onClose`，使显式关闭不会触发 reconnect，
- 如果已连接则关闭 transport，
- 按其精确的 `mcpServerName` 所有者（而不是规范化的 name 前缀）移除 tools，并通知 tool 使用者，
- 当需要移除过时的 prompt commands 时，通知 prompt 使用者。

### Global teardown and ownership

`disconnectAll()`：

- 增加生命周期 epoch，使得晚于全局 disconnect 完成的 reconnect 尝试无法复活旧连接，
- 分离所有活跃 transport 的 `onClose`，然后使用 `Promise.allSettled` 关闭它们，
- 清空 pending maps、sources、保存的 configs、connections、subscriptions、resource refreshes、reconnect history 以及 manager tools。

顶层会话拥有它们创建的 manager。`AgentSession.dispose()` 会在 3 秒 cleanup 超时内 disconnect 所属的 manager，并记录 cleanup 失败；通过 `options.mcpManager` 被传入的子 agent/session 借用父级 manager，并且不会 disconnect 它。`/mcp reload` 在 `disconnectAll` 之后刻意复用 manager 对象，以便已安装的 callbacks/listeners 在下一次 discovery 周期中仍可用。

## Failure modes and guarantees

| Scenario                                             | Behavior                                                                                                                  | Hard fail vs best-effort       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Discovery throws (capability/config load path)       | Loader returns empty tools + synthetic `.mcp.json` error                                                                  | Best-effort session startup    |
| Invalid server config                                | Server skipped with validation error entry                                                                                | Best-effort per server         |
| Connect timeout/init failure                         | Server error recorded; others continue                                                                                    | Best-effort per server         |
| `tools/list` still pending at startup with cache hit | Deferred tools returned immediately                                                                                       | Best-effort fast startup       |
| `tools/list` still pending at startup without cache  | No tools at startup; background continuation registers them via `#onToolsChanged` when ready                              | Best-effort late registration  |
| Late background tool-load failure                    | Logged after startup gate                                                                                                 | Best-effort logging            |
| Runtime dropped transport                            | Manager attempts reconnect; stale tools remain while reconnecting and future calls may retry once or fail with MCP errors | Best-effort automatic recovery |
| More than 5 reconnect invocations within 30s         | Circuit breaker closes/removes the stale connection but leaves tools registered; manual reconnect resets the history      | Automatic reconnect suspended  |
| Owning session disposal                              | Owned manager disconnect is awaited for up to 3s; failure is logged                                                       | Bounded best-effort cleanup    |

## Public API surface

`src/mcp/index.ts` 重新导出了 client operations、config loader/writer APIs、loader 和 manager APIs、OAuth discovery、tool bridges/cache、HTTP 和 stdio transports、protocol types，以及 `callMCP`/`parseSSE`。`src/sdk.ts` 将 `discoverMCPServers()` 暴露为 `discoverAndLoadMCPTools` 的便捷包装器；它返回 `{ manager, tools, errors, connectedServers, exaApiKeys }`。

## Implementation files

- [`src/mcp/loader.ts`](../packages/coding-agent/src/mcp/loader.ts) — loader facade、discovery error 规范化、`LoadedCustomTool` 转换。
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts) — 生命周期状态注册表、并行 connect/list 流程、refresh/disconnect。
- [`src/mcp/client.ts`](../packages/coding-agent/src/mcp/client.ts) — transport 建立、initialize 握手、list/call/disconnect。
- [`src/mcp/index.ts`](../packages/coding-agent/src/mcp/index.ts) — MCP module API exports。
- [`src/sdk.ts`](../packages/coding-agent/src/sdk.ts) — 启动到 session/tool registry 的接线。
- [`src/mcp/config.ts`](../packages/coding-agent/src/mcp/config.ts) — manager 使用的 config discovery/filtering/validation。
- [`src/mcp/tool-bridge.ts`](../packages/coding-agent/src/mcp/tool-bridge.ts) — `MCPTool` 和 `DeferredMCPTool` 的运行时行为。
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — `refreshMCPTools` 实时重新绑定。
- [`src/modes/controllers/mcp-command-controller.ts`](../packages/coding-agent/src/modes/controllers/mcp-command-controller.ts) — interactive reload/reconnect 流程。
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — 通过父 manager 连接的子 agent MCP 代理。
