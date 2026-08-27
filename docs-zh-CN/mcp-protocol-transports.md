# MCP 协议与传输层内部机制

本文档介绍 coding-agent 如何实现 MCP JSON-RPC 消息传递,以及协议关注点与传输关注点是如何分离的。

## 范围

涵盖:

- JSON-RPC 请求/响应与通知流程
- 服务器到客户端的请求处理(`ping`、`roots/list`)
- stdio 和 HTTP/SSE 传输的请求关联与生命周期
- 超时、取消与认证刷新行为
- 错误传播与畸形负载处理
- 传输选择边界(`stdio` vs `http` vs `sse`)
- 哪些重连/重试职责属于传输层,哪些属于 manager/tool-bridge 层

不涵盖扩展编写用户体验或命令 UI。

## 实现文件

- [`src/mcp/types.ts`](../packages/coding-agent/src/mcp/types.ts)
- [`src/mcp/transports/stdio.ts`](../packages/coding-agent/src/mcp/transports/stdio.ts)
- [`src/mcp/transports/http.ts`](../packages/coding-agent/src/mcp/transports/http.ts)
- [`src/mcp/transports/sse.ts`](../packages/coding-agent/src/mcp/transports/sse.ts)
- [`src/mcp/transports/index.ts`](../packages/coding-agent/src/mcp/transports/index.ts)
- [`src/mcp/json-rpc.ts`](../packages/coding-agent/src/mcp/json-rpc.ts)
- [`src/mcp/client.ts`](../packages/coding-agent/src/mcp/client.ts)
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts)

## 分层边界

### 协议层(JSON-RPC + MCP 方法)

- 消息结构在 `types.ts` 中定义(`JsonRpcRequest`、`JsonRpcNotification`、`JsonRpcResponse`、`JsonRpcMessage`)。
- MCP 客户端逻辑(`client.ts`)决定方法顺序与会话握手:
  1. `initialize` 请求
  2. `notifications/initialized` 通知,在任何后续会话流量之前发送
  3. 对于 Streamable HTTP 传输,在 initialize 响应建立任何 session id 之后,启动可选的后台 SSE 监听器
  4. 调用方法如 `tools/list`、`tools/call`

### 传输层(`MCPTransport`)

`MCPTransport` 抽象了传递与生命周期:

- `request(method, params, options?) -> Promise<T>`
- `notify(method, params?) -> Promise<void>`
- `close()`
- `connected`
- 可选回调: `onClose`、`onError`、`onNotification`、`onRequest`

传输实现负责成帧与 I/O 细节:

- `StdioTransport`:子进程 stdio 上的换行符分隔 JSON
- `HttpTransport`:基于 POST 的 Streamable HTTP JSON-RPC,支持可选的 SSE 响应/监听
- `LegacySseTransport`:协议修订版 2024-11-05 HTTP+SSE,具有持久 GET 流以及从 `endpoint` 事件中发现的 POST 端点

### Manager/Client 连接

`connectToServer()` 始终为标准的服务器到客户端请求安装 `onRequest` 处理器。`MCPManager` 为托管连接安装通知处理器、HTTP 类 OAuth 服务器的 OAuth 刷新钩子,以及 `onClose` 重连处理。

## 传输选择

`client.ts:createTransport()` 根据配置选择传输:

- `type` 省略或 `"stdio"` -> `createStdioTransport`
- `"http"` -> `createHttpTransport`
- `"sse"` -> `createSseTransport`

`"sse"` 使用遗留的 HTTP+SSE 传输:它使用 GET 打开配置的 URL,读取 `endpoint` 事件的纯文本 URL/路径,将 JSON-RPC 请求 POST 到该端点,并在该流上接收 JSON-RPC 响应。

## JSON-RPC 消息流与关联

## 请求 ID

每个传输都拥有 `RequestIdAllocator`。出站 ID 默认为从 `1` 开始的单调递增整数,这与更广泛的 MCP 生态系统以及 Apple 的 `xcrun mcpbridge` 等服务器一致。服务器配置可以设置 `requestIdFormat: "string"` 以使用抗冲突的 `Snowflake.next()` 字符串。ID 仍然是传输本地的关联令牌。

## Stdio 关联路径

- 出站请求被序列化为一个 JSON 对象 + `\n`。
- `#pendingRequests: Map<id, {resolve,reject}>` 存储进行中的请求。
- 读取循环解析 stdout 的 JSONL 并调用 `#handleMessage`。
- 如果入站消息具有匹配的 `id`,请求解析/拒绝。
- 如果入站消息具有 `method` 而没有 `id`,则被视为通知并发送到 `onNotification`。
- 如果入站消息同时具有 `method` 和 `id`,则被视为服务器到客户端的请求,并通过 `onRequest` 响应;如果没有处理器,传输以 JSON-RPC `-32601 Method not found` 响应。

未知的响应 ID 会被忽略(不拒绝,不调用错误回调)。

## HTTP 关联路径

- 出站请求是带有 JSON 正文和生成 `id` 的 HTTP `POST`。
- 非 SSE 响应路径:解析一个 JSON-RPC 响应并返回 `result`/在 `error` 时抛出。
- SSE 响应路径(`Content-Type: text/event-stream`):流式传输事件,返回第一个 `id` 匹配预期请求 ID 且具有 `result` 或 `error` 的消息。
- 具有 `method` 且没有 `id` 的 SSE 消息被视为通知。
- 同时具有 `method` 和 `id` 的 SSE 消息被视为服务器到客户端的请求,并以 POST 的 JSON-RPC 响应进行应答。

如果 SSE 流在匹配响应之前结束,请求将以 `No response received for request ID ...` 失败。在捕获到匹配响应之后,传输在后台排出剩余的 SSE 消息。

## 通知

客户端通过 `transport.notify(...)` 发出 JSON-RPC 通知。

- Stdio:通过 `writeFrame()` 将通知帧写入 stdin(`jsonrpc`、`method`、`params`)以及换行符。同步写入失败将关闭传输并抛出;异步 `FileSink` 拒绝被中和,因为通知没有可拒绝的响应 Promise。
- HTTP:发送没有 `id` 的 POST 正文;成功接受任何 `2xx` 响应,包括 `202 Accepted`。

服务器发起的通知通过传输的 `onNotification` 公开;`MCPManager` 使用已知的 MCP 列表/更新通知,并可以通过自己的回调转发所有通知。

## Stdio 传输内部

## 生命周期与状态转换

- 初始状态: `connected=false`,`process=null`,pending map 为空
- `connect()`:
  - 使用配置的 command/args/env/cwd 生成子进程
  - 标记为已连接
  - 启动 stdout 读取循环(`readJsonl`)
  - 启动 stderr 循环(读取/丢弃;目前保持静默)
- `close()`:
  - `#handleClose()`:标记为已断开,拒绝所有待处理请求(`Transport closed`),发出 `onClose`
  - 终止子进程
  - 在不等待的情况下分离读取循环(它可能无限期挂起)

如果读取循环意外退出,`finally` 触发 `#handleClose()`,该函数执行相同的待处理请求拒绝和关闭回调。

## 超时与取消

每个请求:

- 超时来自 `resolveMCPTimeoutMs`: `OMP_MCP_TIMEOUT_MS` 环境变量覆盖,否则为 `config.timeout ?? 30000`;`0` 表示禁用
- 可选的 `AbortSignal`(来自调用方)
- abort 和 timeout 都会拒绝待处理的 Promise 并清理其 map 条目;结算后忽略迟到的写入拒绝

取消仅在本地生效:传输不会向服务器发送协议级取消通知。

## 畸形负载处理

在读取循环中:

- 每个解析的 JSONL 行在 `try/catch` 中传递给 `#handleMessage`
- 畸形/无效消息处理异常被丢弃(注释 `Skip malformed lines`)
- 循环继续,因此一条错误消息不会终止连接

如果底层流解析器抛出,`onError` 被调用(在仍然连接时),然后连接关闭。

## 断开/失败行为

当进程退出或流关闭时:

- 所有进行中的请求被拒绝并返回 `Transport closed`
- 不会自动重启或重连
- 上层必须通过创建新传输来重连

## 背压/流式说明

- `request()` 故意**不** await `stdin.write()` 或 `flush()`: await 完整的管道可能使异步函数在返回响应 Promise 之前陷入困境,从而阻止其 timeout/abort 拒绝到达调用方。同步抛出和异步 write/flush 拒绝反而会拒绝该待处理的响应 Promise。`notify()` 通过 `writeFrame()` 写入,后者检测同步失败但中和异步 EPIPE 拒绝。
- 传输中没有显式队列或高水位管理。
- 入站处理是流驱动的(`for await` 遍历 `readJsonl`),一次解析一条消息。

## Streamable HTTP 传输内部

## 生命周期与连接语义

HTTP 传输具有逻辑连接状态,但请求路径在每个 HTTP 调用上是无状态的:

- `connect()` 设置 `connected=true`(无 socket/会话握手)
- 通过 `Mcp-Session-Id` 标头进行可选的服务器会话跟踪
- `close()` 可选择使用 `Mcp-Session-Id` 发送 `DELETE`,中止 SSE 监听器,发出 `onClose`

因此 `connected` 意味着"传输可用",而不是"已建立持久流"。

## Session 标头行为

- 在 POST 响应上,如果存在 `Mcp-Session-Id` 标头,传输会存储它。
- 后续请求/通知包括 `Mcp-Session-Id`。
- `close()` 尝试使用 HTTP DELETE 终止服务器会话;终止失败会被忽略。

## 超时、取消与认证刷新

对于 `request()`:

- 超时使用 `AbortController` 通过 `createMCPTimeout`(`OMP_MCP_TIMEOUT_MS` 覆盖,否则为 `config.timeout ?? 30000`;`0` 表示禁用)
- 外部 signal(如果提供)通过 `AbortSignal.any([...])` 合并
- AbortError 处理区分调用方中止与超时

对于 `notify()`:

- 超时使用具有相同已解析超时的内部 `AbortController`
- 传输接口上没有外部 abort 选项

对于由 `MCPManager` 管理的 HTTP 类 OAuth 配置,如果令牌刷新返回替换标头,则出站请求和尽力而为的服务器请求响应在 `HTTP 401`/`403` 时重试一次。

## HTTP 错误传播

在非 OK 响应上:

- 响应文本包含在抛出的错误中(`HTTP <status>: <text>`)
- 如果存在,来自 `WWW-Authenticate` 和 `Mcp-Auth-Server` 的认证提示将被附加

在 JSON-RPC 错误对象上:

- 抛出 `MCP error <code>: <message>`

畸形 JSON 正文(`response.json()` 失败)作为解析异常传播。

## SSE 行为与模式

存在两条 SSE 路径:

1. **每请求 SSE 响应**(`#parseSSEResponse`)
   - 当 POST 响应内容类型为 `text/event-stream` 时使用
   - 消费流直到找到匹配的响应 id
   - 可以在同一流中处理交错的通知

2. **后台 SSE 监听器**(`startSSEListener()`)
   - 用于服务器发起的通知和服务器到客户端请求的可选 GET 监听器
   - `connectToServer()` 在 `notifications/initialized` 通知之后为 Streamable HTTP 传输启动它
   - 监听器启动等待最多一秒,或对非常小的请求超时更短;`timeout: 0` / `OMP_MCP_TIMEOUT_MS=0` 禁用该启动截止时间
   - 如果 GET 返回 `405`、另一个非 OK 状态、无正文或超时,则监听器静默地自我禁用

## 畸形负载与断开处理

SSE JSON 解析错误从 `readSseJson` 抛出并拒绝请求/监听器。

- 请求 SSE 解析错误拒绝活动请求。
- 后台监听器错误触发 `onError`(AbortError 除外),并且在仍然连接时已建立的监听器结束会触发 `onClose`,以便 manager 可以重连。
- 传输本身不会重启监听器;托管连接可以通过 manager `onClose` 处理重连。

## 遗留 HTTP+SSE 传输内部

`LegacySseTransport` 实现 MCP 协议修订版 2024-11-05:

- `connect()` 使用 `GET Accept: text/event-stream` 打开配置的 URL。
- 第一个 `endpoint` 事件是控制数据,而不是 JSON;其 `data` 值针对配置的 URL 进行解析,并存储为 JSON-RPC POST 端点。
- `request()` 和 `notify()` 将 JSON-RPC 帧 POST 到发现的端点。
- JSON-RPC 响应、通知和服务器到客户端请求从 `event: message` 流事件中读取,并按请求 id 进行关联。
- 如果流结束,待处理请求将失败并返回 `Transport closed: legacy SSE stream closed`;托管连接可以通过 `onClose` 重连。

## `json-rpc.ts` 实用工具与传输抽象

`src/mcp/json-rpc.ts` 提供 `callMCP()` 和 `parseSSE()` 帮助器,用于直接 HTTP MCP 调用(由 Exa 集成使用),而不是 `MCPClient`/`MCPManager` 使用的 `MCPTransport` 抽象。

与 `HttpTransport` 的显著差异:

- 首先解析整个响应文本,然后提取第一个 `data: ` 行(`parseSSE`),具有 JSON 回退
- 可选调用方 `AbortSignal`(`CallMcpOptions`),未提供时具有硬编码 60 秒 `AbortSignal.timeout` 默认值;没有 session-id 处理,没有传输生命周期
- 返回原始 JSON-RPC 信封对象

此路径轻量但不如完整传输实现健壮。

## 重试/重连职责

## 传输层

当前的传输实现**不**会:

- 重试普通失败请求,但当连接 `onAuthError` 时,HTTP 类传输的单次 OAuth 刷新重试除外
- 在 stdio 进程退出后重连
- 自行重连 SSE 监听器
- 在断开后重新发送进行中的请求

它们会快速失败并传播错误。

## Manager/Tool-Bridge 层

`MCPManager` 为托管连接连接 `transport.onClose`,并在传输意外关闭时运行 `reconnectServer(name)`。重连会拆除陈旧连接、重新解析 auth/config 值、带退避重试(`500`、`1000`、`2000`、`4000` 毫秒)、重新加载工具,并在重连期间保留陈旧工具。

`MCPTool` 和 `DeferredMCPTool` 还会在工具调用期间对可重试的连接错误尝试一次重连 + 重试。这是工具可用性恢复,而不是传输级重试。

## 失败场景汇总

- **畸形 stdio 消息行**:被丢弃;流继续。
- **Stdio 流/进程结束**:传输关闭;待处理请求被拒绝为 `Transport closed`;manager 托管连接触发重连。
- **HTTP 非 2xx**:request/notify 抛出 HTTP 错误;托管 OAuth 请求可以在 401/403 上刷新认证并重试一次。
- **无效 JSON 响应**:解析异常传播。
- **遗留 SSE 流结束**:待处理请求失败并返回 `Transport closed: legacy SSE stream closed`;manager 托管连接触发重连。
- **SSE 在没有匹配 id 的情况下结束**:请求失败并返回 `No response received for request ID ...`。
- **超时**:传输特定的超时错误。
- **调用方中止**:AbortError/原因从调用方 signal 传播(在该方法接受一个 signal 的位置)。

## 实际边界规则

如果关注点是消息结构、id 关联或 MCP 方法排序,则属于协议/客户端逻辑。

如果关注点是成帧(JSONL vs HTTP/SSE)、流解析、fetch/spawn 生命周期、超时时钟或连接拆除,则属于传输实现。
