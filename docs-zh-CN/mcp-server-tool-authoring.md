# MCP server and tool authoring

本文档介绍 MCP 服务器定义如何在 coding-agent 中成为可调用的 `mcp__*` 工具，以及在配置无效、重复、被禁用或需要鉴权时操作者应当预期的行为。

## Architecture at a glance

```text
Config sources (.omp/.claude/.cursor/.vscode/mcp.json, mcp.json, etc.)
  -> discovery providers normalize to canonical MCPServer
  -> capability loader dedupes by server name (higher provider priority wins)
  -> loadAllMCPConfigs applies user enablement overrides and suppresses disabled servers
  -> MCPManager connects/listTools (with auth/header/env resolution)
  -> manager best-effort loads resources/prompts and subscribes to resource updates when enabled
  -> MCPTool/DeferredMCPTool bridge exposes tools as mcp__<server>_<tool>
  -> AgentSession.refreshMCPTools replaces live MCP tools immediately
```

## 1) Server config model and validation

`src/mcp/types.ts` 定义了 MCP 配置编写者和运行时所用的创作形态：

- `stdio`（当 `type` 缺失时的默认值）：需要 `command`，可选 `args`、`env`、`cwd`
- `http`：需要 `url`，可选 `headers`
- `sse`：需要 `url`，可选 `headers`（为兼容性保留）
- 共享字段：`enabled`、`timeout`、`requestIdFormat`（`"number"` 或 `"string"`）、`auth`、`oauth`

`validateServerConfig()`（`src/mcp/config.ts`）强制执行传输层基础检查：

- 拒绝同时设置 `command` 和 `url` 的配置
- 为 stdio 要求提供 `command`
- 为 http/sse 要求提供 `url`
- 拒绝未知的 `type`

`config-writer.ts` 在 add/update 操作中应用此验证，同时校验服务器名称：

- 非空
- 最多 100 个字符
- 仅允许 `[a-zA-Z0-9_.:-]`（冒号允许带命名空间的插件服务器名称，例如 `cloudflare:cloudflare-api`）

### Transport pitfalls

- 省略 `type` 表示 stdio。如果你本意是 HTTP/SSE 但省略了 `type`，那么 `command` 就成为必需项。
- `sse` 选择旧版协议修订版 2024-11-05 的 HTTP+SSE 传输：一个持久的 GET 流提供一个 `endpoint` 事件，其 URL 接收 JSON-RPC POST。它与 `"http"` 的 Streamable HTTP 传输是不同的。
- 出于生态兼容性，出站 JSON-RPC 请求 ID 默认使用递增的数字。仅当服务器需要旧的 snowflake 字符串行为时才设置 `requestIdFormat: "string"`；在发现阶段，无效值会被警告并被忽略。
- 验证是结构性的，并不检查可达性：语法合法的 URL 在连接时仍然可能失败。

## 2) Discovery, normalization, and precedence

### Capability-based discovery

`loadAllMCPConfigs()`（`src/mcp/config.ts`）通过 `loadCapability(mcpCapability.id)` 加载规范的 `MCPServer` 项。

随后，capability 层（`src/capability/index.ts`）会：

1. 按优先级顺序加载提供者
2. 按 `server.name` 去重（先到者获胜 = 优先级最高）
3. 校验去重后的项

结果：跨来源的重复服务器名称不会被合并。只会保留一个定义；低优先级的重复项被屏蔽。

### `.mcp.json` and related files

`src/discovery/mcp-json.ts` 中的专用回退提供者读取项目根目录下的 `mcp.json` 和 `.mcp.json`（低优先级）。

实际上，MCP 服务器也来自优先级更高的提供者（例如原生的 `.omp/...` 以及特定工具的配置目录）。编写建议如下：

- 若要显式控制，优先使用 `.omp/mcp.json`（项目）或 `~/.omp/agent/mcp.json`（用户）。
- 当你需要回退兼容性时，使用根目录的 `mcp.json` / `.mcp.json`。
- 在多个来源中复用同一个服务器名称会产生优先级屏蔽，而非合并。

### Normalization behavior

`convertToLegacyConfig()`（`src/mcp/config.ts`）将规范的 `MCPServer` 映射为运行时 `MCPServerConfig`。

关键行为：

- 传输方式推断为 `server.transport ?? (command ? "stdio" : url ? "http" : "stdio")`
- `requestIdFormat` 会被保留；省略意味着使用数字 ID
- 出现在当前 profile 用户 `disabledServers` 列表中的名称始终会被抑制；`enabled === false` 的服务器会被抑制，除非同一份用户配置将其列入 `enabledServers`
- 存在时，可选字段会被保留

### Environment expansion during discovery

OMP 原生的 MCP 配置（`.omp/mcp.json`、`~/.omp/agent/mcp.json` 以及它们的 `.mcp.json` 变体）在转换为运行时配置之前，会递归展开 `${VAR}` 和 `${VAR:-default}` 占位符。它也接受 `enabled` 的布尔/字符串形式（`true`、`false`、`1`、`0`）和 `timeout` 的数字字符串。`requestIdFormat` 仅接受 `"number"` 或 `"string"`；其他值会被警告并回退到数字 ID。

`src/discovery/mcp-json.ts` 中的独立回退提供者读取项目根目录下的 `mcp.json` 和 `.mcp.json`，展开相同的 `${...}` 占位符，并对 `enabled`/`timeout` 进行类型检查而不会强转字符串值。它应用相同的 `requestIdFormat` 校验。

无效的 `enabled`/`timeout` 值会被忽略并发出警告，而不是使整个文件失败。

## 3) Auth and runtime value resolution

`MCPManager.prepareConfig()`/`#resolveAuthConfig()`（`src/mcp/manager.ts`）是连接前的最后一遍处理。

### OAuth credential injection

对于 `http`/`sse` 服务器，`auth: { type: "oauth", credentialId: "..." }`
块是可选的。OMP 在解析时，会优先采用明确的任意或旧式 credential ID。
托管的、profile 范围的
`mcp_oauth:profile:<profile>:<url>` ID 仅在其 profile 处于活跃
且其 URL 与服务器的展开后或字面 URL 匹配时被接受；不匹配则被忽略。
如果所接受的明确 ID 解析失败——或者根本不存在 `auth`
块——OMP 会在由展开后和字面服务器 URL 派生的确定性 ID 下查找凭证。
这些按 URL 索引的凭证限定于当前活跃 profile，因此共享的、仅含定义的服务器条目可以使用每个 profile 独立存储的 OAuth 凭证。

大小写不敏感的、显式配置的 `Authorization` 头会
抑制该按 URL 索引的回退。`stdio` 服务器没有可绑定的 URL：
其显式的任意或旧式 credential ID 必须解析成功，按 URL 索引、
profile 范围的 ID 会被忽略。

当查找成功时：

- `http`/`sse`：注入 `Authorization: Bearer <access_token>` 头
- `stdio`：注入 `OAUTH_ACCESS_TOKEN` 环境变量

如果没有解析到凭证，OMP 在不注入 OAuth 值的情况下进行连接。
刷新或凭证解析失败会被记录；在可能的情况下，OMP
会继续使用现有的访问令牌。

### Header/env value resolution

在连接之前，manager 通过 `resolveConfigValue()`（`src/config/resolve-config-value.ts`）解析 stdio 的 `env` 值以及 HTTP/SSE 的 `headers` 值：

- 以 `!` 开头的值 => 执行 shell 命令，使用去除首尾空白的 stdout（已缓存）
- 失败、超时或仅有空白字符的命令会产生 `undefined`，因此该条目会被省略
- 否则，先将该值视为环境变量名（`process.env[name]`），回退到字面值

操作上的注意事项：拼写错误的 `!` 密钥命令可能悄无声息地移除该 header/env 条目，从而产生下游的 401/403 或服务器启动失败。拼写错误的环境变量名会按字面值发送，除非该字面值恰好对服务器有意义。

## 4) Tool bridge: MCP -> agent-callable tools

`src/mcp/tool-bridge.ts` 将 MCP 工具定义转换为 `CustomTool`。

### Naming and collision domain

工具名按如下方式生成：

```text
mcp__<sanitized_server_name>_<sanitized_tool_name>
```

规则：

- 转为小写
- 非 `[a-z_]` 字符变为 `_`
- 重复的下划线合并
- 工具名中多余的 `<server>_` 前缀会被移除一次
- 超过 64 个字符的名称会保留可读前缀，并附加 `_` 以及对完整未截断生成名计算 `Bun.hash()` 所得的前 8 位 base-36 字符

不同的原始名称仍可能规范化为相同的标识符（例如
`my-server` 和 `my.server` 都会规范化为类似形式）。在注册到注册表之前，`deduplicateMCPToolsByName()` 通过按字典序比较原始的 `<server-name>\0<tool-name>` 源键来选择一个确定性的胜出者。失败的源会被记录并省略，因此重连或发现顺序不会改变归属。

### Schema mapping

`tool-bridge.ts` 在将每个 MCP `inputSchema` 注册为 `CustomTool` schema 之前，会先通过 `normalizeSchemaForMCP()` 对其进行处理。

### Outbound argument normalization

在实时工具或延迟工具发送 `tools/call` 之前，bridge 按以下顺序对调用的参数进行规范化：

1. 顶层的非对象值、`null` 以及数组都会变成空的参数对象。
2. 除非 MCP 工具自身的 `inputSchema.properties` 声明了 `i`，否则由 harness 注入的 intent 字段 `i` 会被移除。
3. 对于 MCP schema 中已声明但未列入 `required` 的属性，当其值为 `undefined`、空字符串或空非数组对象时会被省略。必需属性、未声明属性、`0`、`false`、`null` 以及数组（包括空数组）会被保留。
4. 字符串值会在嵌套对象和数组中递归遍历。可解析的 `local://` 文件 URL 会变为外部 MCP 服务器可读取的真实文件系统路径。当没有活动的本地文件解析器，或该 URL 表示的是目录/根而非文件时，保留原始字符串；无效、缺失或转义错误的本地文件 URL 在规范化阶段就会失败，不会到达 `tools/call`。

因此服务器作者应当基于规范化后的 payload 进行校验，而不是假设模型生成的调用中出现的每个字段都会到达服务器。

### Execution mapping

`MCPTool.execute()` / `DeferredMCPTool.execute()`：

- 调用 MCP `tools/call`
- 将 MCP content 展平为可显示的文本
- 返回结构化详情（`serverName`、`mcpToolName`、提供者元数据）
- 将服务器上报的 `isError` 映射为 `Error: ...` 文本结果
- 对可重试的连接错误尝试重连 + 一次重试
- 将剩余的抛出式传输/运行时失败映射为 `MCP error: ...`
- 通过将 AbortError 转换为 `ToolAbortError` 来保留中止语义

## 5) Operator lifecycle: add/edit/remove and live updates

交互模式在 `src/modes/controllers/mcp-command-controller.ts` 中暴露 `/mcp`。

支持的操作：

- `add`（向导或快速添加）
- `remove` / `rm`
- `enable` / `disable`
- `test`
- `reauth` / `unauth`
- `reconnect`
- `reload`
- `resources`、`prompts`、`notifications`
- Smithery 搜索/登录/登出流程

配置写入是原子的（`writeMCPConfigFile`：临时文件 + 重命名）。

变更之后，控制器调用 `#reloadMCP()`：

1. `mcpManager.disconnectAll()`
2. `mcpManager.discoverAndConnect()`
3. `session.refreshMCPTools(mcpManager.getTools())`

`refreshMCPTools()` 会替换所有 `mcp__` 注册表条目，并立即重新激活最新的 MCP 工具集，因此变更无需重启会话即可生效。

### Mode differences

- **Interactive/TUI mode**：`/mcp` 提供应用内 UX（向导、OAuth 流程、连接状态文本、即时运行时重新绑定）。
- **SDK/headless integration**：`discoverAndLoadMCPTools()`（`src/mcp/loader.ts`）返回已加载的工具及每个服务器的错误；不提供 `/mcp` 命令 UX。

## 6) User-visible error surfaces

用户/操作者常见的错误字符串：

- add/update 验证失败：
  - `Invalid server config: ...`
  - `Server "<name>" already exists in <path>`
- quick-add 参数问题：
  - `Use either --url or -- <command...>, not both.`
  - `--token requires --url (HTTP/SSE transport).`
- 连接/测试失败：
  - `Failed to connect to "<name>": <message>`
  - 超时帮助文本建议增大 timeout
  - 针对 `401/403` 的鉴权帮助文本
- auth/OAuth 流程：
  - `Authentication required ... OAuth endpoints could not be discovered`
  - `OAuth flow timed out. Please try again.`
  - `OAuth authentication failed: ...`
- 使用被禁用的服务器：
  - `Server "<name>" is disabled. Run /mcp enable <name> first.`

发现阶段中的源 JSON 错误通常以警告/日志形式处理；config-writer 路径会抛出显式错误。

## 7) Practical authoring guidance

要在本代码库中进行稳健的 MCP 编写：

1. 保持服务器名称在所有 MCP-capable 配置源中全局唯一。
2. 优先选择在 MCP 工具名规范化后仍然不同的名称，以避免生成 `mcp__` 时的冲突。
3. 使用显式的 `type` 以避免意外的 stdio 默认值。
4. 当你需要覆盖已发现服务器的 `enabled: false` 时，使用当前 profile 用户的 `enabledServers` 列表；如果一个名称同时出现在两个列表中，`disabledServers` 始终优先。
5. 对于远程 OAuth 服务器，合法且显式的 `credentialId` 是可选的：仅含定义的 `http`/`sse` 条目可以使用绑定到相同 URL 的当前 profile 凭证。当必须抑制按 URL 索引的回退时，请使用显式的 `Authorization` 头。
6. 如果使用基于命令的密钥解析（`!cmd`），请确认命令输出稳定且非空。

## Implementation files

- [`src/mcp/types.ts`](../packages/coding-agent/src/mcp/types.ts)
- [`src/mcp/config.ts`](../packages/coding-agent/src/mcp/config.ts)
- [`src/mcp/config-writer.ts`](../packages/coding-agent/src/mcp/config-writer.ts)
- [`src/mcp/tool-bridge.ts`](../packages/coding-agent/src/mcp/tool-bridge.ts)
- [`src/discovery/mcp-json.ts`](../packages/coding-agent/src/discovery/mcp-json.ts)
- [`src/modes/controllers/mcp-command-controller.ts`](../packages/coding-agent/src/modes/controllers/mcp-command-controller.ts)
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts)
- [`src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`src/config/resolve-config-value.ts`](../packages/coding-agent/src/config/resolve-config-value.ts)
- [`src/mcp/loader.ts`](../packages/coding-agent/src/mcp/loader.ts)
