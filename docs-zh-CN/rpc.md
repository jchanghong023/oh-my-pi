# RPC 协议参考

RPC 模式通过 stdio 运行编码代理，采用以换行符分隔的 JSON 协议。

- **stdin**：命令（`RpcCommand`）、扩展 UI 响应以及宿主工具的更新/结果
- **stdout**：ready 帧、命令响应（`RpcResponse`）、会话/代理事件、扩展 UI 请求、宿主工具的请求/取消

主要实现：

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`

## 启动

```bash
omp --mode rpc [regular CLI options]
```

行为说明：

- RPC 模式拒绝 `@file` CLI 参数。
- RPC 模式默认禁用自动会话标题生成，以避免额外的模型调用。
- RPC/ACP 宿主默认值覆盖任务隔离/执行、内存、advisor、tier、async-job 以及 bash 自动后台设置。仅当某项配置未显式设置时才会应用；项目/全局配置、`--config` 以及隔离设置仍以更高优先级为准。Todo 设置不会被宿主默认值覆盖。
- 进程在扩展发现之前就占用 stdin，然后按行解析非空的 JSONL 输入。格式错误的 JSON 会发出可恢复的 `command: "parse"` 失败，但不会终止循环。
- 启动时会先写入一个 `ready` 帧，再开始处理命令。该帧声明所支持的协议版本以及传输限制。
- 当 stdin 关闭时，挂起的扩展 UI、宿主工具和宿主 URI 请求将被拒绝；已接受的命令会排空，会话被释放，进程以退出码 `0` 退出。
- 响应/事件以每行一个 JSON 对象的格式写入。

## 传输与帧格式

协议 v1 的 stdout 帧是单个 JSON 对象后接 `\n`。服务器将每个物理 stdout 帧上限限制为 1 MiB。入站命令始终是单个未分块的 JSONL 对象；客户端应将它们控制在已声明的物理帧限制之内。

初始的 ready 帧使用协议 v1，并声明可选的无损传输：

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "supportedProtocolVersions": [1, 2],
  "maxFrameBytes": 1048576,
  "maxReassembledFrameBytes": 67108864
}
```

支持协议 v2 的客户端应立即发送：

```json
{ "id": "protocol-1", "type": "negotiate_protocol", "protocolVersion": 2 }
```

在收到成功响应后，超大 stdout 对象会作为不间断的 `rpc_chunk` 帧序列进行无损发送。每个 chunk 携带原始 UTF-8 JSON 对象的一段 base64 片段：

```json
{
  "type": "rpc_chunk",
  "chunkId": "rpc-1",
  "index": 0,
  "count": 7,
  "byteLength": 1600042,
  "data": "eyJ0eXBlIjoicmVzcG9uc2UiLC4uLn0="
}
```

客户端必须校验 `chunkId`、`index`、`count` 和 `byteLength`，拒绝交错或中断的序列，强制执行已声明的重组上限，按索引顺序拼接解码后的字节，将其作为严格的 UTF-8 解码，并将结果解析为单个 JSON 对象。从 `@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame` 导出的 TypeScript `RpcFrameDecoder` 实现了此校验。捆绑的 TypeScript 和 Python `RpcClient` 实现会在 ready 帧声明 v2 时自动协商 v2。

旧版客户端可以忽略新增的 ready 字段并继续使用 v1。V1 对超大输出仍保留有界回退行为。超过 v2 重组上限的帧仍会显式失败；大型历史 API 应使用分页，而不是依赖任意大的逻辑帧。

### 出站帧类别（stdout）

1. Ready 帧（`{ type: "ready" }`）
2. `RpcResponse`（`{ type: "response", ... }`）
3. `AgentSessionEvent` 对象（`agent_start`、`message_update` 等）
4. `RpcExtensionUIRequest`（`{ type: "extension_ui_request", ... }`）
5. 宿主工具的请求/取消（`host_tool_call`、`host_tool_cancel`）
6. 宿主 URI 的请求/取消（`host_uri_request`、`host_uri_cancel`）
7. 扩展错误（`{ type: "extension_error", extensionPath, event, error }`）
8. 可用命令更新（`{ type: "available_commands_update", commands }`），在启动时以及命令元数据变更时发出
9. 提示词生命周期提示（`{ type: "prompt_result", id?, agentInvoked }`），用于稍后解析但未调用代理的已调度提示词
10. 子代理帧（`subagent_lifecycle`、`subagent_progress`、`subagent_event`），由 `set_subagent_subscription` 控制
11. 内建斜杠命令的旁路通道（`command_output`、`session_info_update`、`config_update`）

### 入站帧类别（stdin）

1. `RpcCommand`
2. `RpcExtensionUIResponse`（`{ type: "extension_ui_response", ... }`）
3. 宿主工具的更新/结果（`host_tool_update`、`host_tool_result`）
4. 宿主 URI 结果（`host_uri_result`）

## 请求/响应关联

所有命令都接受可选的 `id?: string`。

- 如果提供了 `id`，正常的命令响应会回显相同的 `id`。
- `RpcClient` 依赖此机制来解析挂起的请求。

来自运行时的重要边界行为：

- 未知命令的响应会以 `id: undefined` 发出（即使请求带有 `id`）。
- 格式错误的 JSON 以及同步派发失败会以 `command: "parse"` 且 `id: undefined` 发出。处理已识别命令时发生的异常会以该命令的 `type` 和 `id` 发出失败响应。
- `prompt` 和 `abort_and_prompt` 会立即返回成功，然后如果异步提示词调度失败，可能稍后会发出带有**相同** id 的错误响应。
- `prompt` 成功响应可能包含 `data.agentInvoked`。`false` 表示提示词已在本地完成，没有启动代理轮次；`true` 表示提示词产生了代理生命周期事件；若省略，则宿主必须依赖会话事件来判断完成。
- `abort_and_prompt` 当前不发出 `data.agentInvoked` 或 `prompt_result`；宿主应将其视为旧式的 abort-then-schedule 路径，并依赖会话事件或相同 id 的调度错误。

## 命令模式（标准）

`RpcCommand` 定义于 `packages/coding-agent/src/modes/rpc/rpc-types.ts`：

### 提示词

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "new_session", parentSession?: string }`

### 协议

- `{ id?, type: "negotiate_protocol", protocolVersion: 2 }`

### 状态

- `{ id?, type: "get_state" }`
- `{ id?, type: "set_fast_mode", enabled: boolean }`
- `{ id?, type: "get_available_commands" }`
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`
- `{ id?, type: "set_host_uri_schemes", schemes: RpcHostUriSchemeDefinition[] }`
- `{ id?, type: "set_subagent_subscription", level: "off" | "progress" | "events" }`
- `{ id?, type: "get_subagents" }`
- `{ id?, type: "get_subagent_messages", subagentId?: string, sessionFile?: string, fromByte?: number }`

### 模型

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`

### 思考

- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`

### 队列模式

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### 压缩

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`

### 重试

- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`

### Bash

- `{ id?, type: "bash", command: string }`
- `{ id?, type: "abort_bash" }`

`bash` 是并发派发的：RPC 服务器在 shell 命令运行期间会继续读取命令，
因此在长时间运行的 `bash` 期间发送的 `abort_bash`（或任何其他命令）
无需等待其自行完成即可被处理。`bash` 响应会在命令完成时发出；
宿主通过 `id` 进行关联。并发命令之间的顺序不作保证——客户端必须
按 `id`（而非按发出顺序）来匹配响应。

### 会话

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`
- `{ id?, type: "handoff", customInstructions?: string }`

### 消息

- `{ id?, type: "get_messages" }`
- `{ id?, type: "get_messages_page", cursor?: string, limit?: number }`

`get_messages_page` 返回一个稳定的按时间顺序的页面，其中包含 `messages`、`totalMessages`，以及在还有更多消息时的 `nextCursor`（不透明字符串）。游标与会话 ID、持久化的叶子节点和消息数量绑定。如果会话在请求之间发生变化，服务器会拒绝过期的游标，并拒绝在会话正在流式传输或压缩时启动分页遍历。失败的页面请求在错误响应中带有机器可读的 `code`——`session_busy`（会话正在流式传输或压缩中）或 `stale_cursor`（游标背后的快照已变更，例如在两次分页之间有后台 bash 追加了消息）——以便客户端无需匹配错误消息文本即可做出反应。每个页面最多包含 256 条消息，通常保持在 v1 物理帧上限之下。v1…

捆绑的 TypeScript `RpcClient.getMessages()` 和 Python `RpcClient.get_messages()` 在协商 v2 后会自动排空这个分页端点。连接到 v1 服务器时，它们仍保留旧式的单一命令；无论遇到 `session_busy` 还是 `stale_cursor`，它们都会丢弃部分页面并回退到旧式的尽力而为快照。直接的 `getMessagesPage()` 和 `get_messages_page()` 调用仍然保持严格，增量式宿主绝不会在不知情的情况下混合不同的快照。

### 登录

- `{ id?, type: "get_login_providers" }`
- `{ id?, type: "login", providerId: string }`

## 响应模式

所有命令结果都使用 `RpcResponse`：

- 成功：`{ id?, type: "response", command: <command>, success: true, data?: ... }`
- 失败：`{ id?, type: "response", command: string, success: false, error: string, code?: string }`

数据负载因命令而异，定义于 `rpc-types.ts`。

### `prompt` 负载

`prompt` 在命令被接受后即被确认，而不是在模型轮次结束后：

```json
{
  "id": "req_1",
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": { "agentInvoked": false }
}
```

`data.agentInvoked: false` 是仅在本地完成的提示词的完成信号，包括那些产生输出但未启动代理轮次的斜杠命令。`data.agentInvoked: true` 表示提示词产生了代理生命周期事件；这些事件可能根据命令路径在 prompt 响应之前或之后发出。较旧的运行时可能省略 `data`；此时宿主应依赖 `agent_end`、自定义消息完成或 `prompt_result`。

当一个提示词被立即接受但稍后解析为仅在本地完成时，会发出 `prompt_result`：

```json
{ "type": "prompt_result", "id": "req_1", "agentInvoked": false }
```

仅在本地完成的斜杠命令可能在通过 `data.agentInvoked: false` 或稍后的 `prompt_result` 完成之前发出 `command_output` 帧。它们不会发出 `agent_end`。

### `get_state` 负载

`tokensPerSecond` 在可获得输出吞吐时为数字，否则为
`null`。`fastModeEnabled` 报告会话设置，而
`fastModeActive` 报告实际计算出的激活状态。对于 Fireworks，
`providers.fireworksTier: priority` 是一项独立于 `/fast` 系列
设置的 provider 级设置，因此对于不支持的 Fireworks 模型，
`fastModeActive` 可能仍为 `true`。

对于直接的 Anthropic，provider 拒绝 `speed: "fast"` 时会使用
一个粘性回退，其作用域为已解析的端点和精确的模型：即使
`fastModeEnabled` 仍为 `true`，`fastModeActive` 也可能为
`false`。显式调用 `set_fast_mode` 启用即表示重试意图，
并清除该回退，以便重新发起 provider 尝试。

```json
{
  "model": { "provider": "...", "id": "..." },
  "thinkingLevel": "off|minimal|low|medium|high|xhigh|max",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "all|one-at-a-time",
  "followUpMode": "all|one-at-a-time",
  "interruptMode": "immediate|wait",
  "sessionFile": "...",
  "sessionId": "...",
  "sessionName": "...",
  "fastModeEnabled": false,
  "tokensPerSecond": null,
  "fastModeActive": false,
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "todoPhases": [
    {
      "id": "phase-1",
      "name": "Todos",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the tool surface",
          "status": "in_progress"
        }
      ]
    }
  ],
  "systemPrompt": ["..."],
  "dumpTools": [
    {
      "name": "read",
      "description": "Read files and URLs",
      "parameters": {}
    }
  ],
  "contextUsage": {
    "tokens": 1100,
    "contextWindow": 200000,
    "percent": 0.55
  }
}
```

### `set_fast_mode` 负载

`set_fast_mode` 更改会话是否启用快速模式。请求为：

```json
{ "id": "req_fast_on", "type": "set_fast_mode", "enabled": true }
```

成功时，`data` 始终同时包含 `enabled` 和 `active`。这是
实际计算出的值：`enabled` 报告会话设置，`active` 报告
产生的激活状态，包括任何 provider 级别的 Fireworks
priority 设置：

对于直接的 Anthropic，显式启用还会在粘性拒绝回退之后
重新发起 provider 尝试，即使快速模式已经处于启用状态。

```json
{
  "id": "req_fast_on",
  "type": "response",
  "command": "set_fast_mode",
  "success": true,
  "data": { "enabled": true, "active": true }
}
```

在没有 service-tier 系列的模型上启用快速模式将失败，并
返回以下精确错误：

```json
{
  "id": "req_fast_on",
  "type": "response",
  "command": "set_fast_mode",
  "success": false,
  "error": "Fast mode is unavailable for the current model."
}
```

禁用快速模式是幂等的，包括在不支持的模型上也是如此。它
作为 off/no-op 结果成功，但禁用 `/fast` 不会覆盖
provider 级别的设置，因此成功禁用并不保证
`active: false`。例如，对于不支持的
`fireworks/deepseek-v4-flash` 模型和 `providers.fireworksTier: priority`，
响应报告会话设置为已禁用，而 provider priority
会保持计算出的激活状态为 true：

```json
{
  "id": "req_fast_off",
  "type": "response",
  "command": "set_fast_mode",
  "success": true,
  "data": { "enabled": false, "active": true }
}
```

对应的 `get_state` 结果报告相同的计算状态：

```json
{
  "fastModeEnabled": false,
  "fastModeActive": true
}
```

### `set_todos` 负载

替换当前会话的内存 todo 状态，并返回规范化后的阶段列表：

```json
{
  "id": "req_2",
  "type": "set_todos",
  "phases": [
    {
      "id": "phase-1",
      "name": "Evaluation",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the read tool surface",
          "status": "in_progress"
        },
        {
          "id": "task-2",
          "content": "Exercise edit operations",
          "status": "pending"
        }
      ]
    }
  ]
}
```

这对于希望在首次提示词之前预先植入计划的宿主很有用。

### `set_host_tools` 负载

替换 RPC 服务器可通过 stdio 回调使用的当前宿主自有工具集：

```json
{
  "id": "req_3",
  "type": "set_host_tools",
  "tools": [
    {
      "name": "echo_host",
      "label": "Echo Host",
      "description": "Echo a value from the embedding host",
      "parameters": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"],
        "additionalProperties": false
      }
    }
  ]
}
```

响应负载为：

```json
{
  "toolNames": ["echo_host"]
}
```

这些工具会在下一次模型调用之前被添加到活动会话的工具注册表中。重新发送 `set_host_tools` 会替换先前的宿主自有工具集。

定义还接受 `hidden?: boolean` 和
`loadMode?: "essential" | "discoverable"`。显式指定的模式优先。若省略，已知属于 essential 的内建名称保持为 `"essential"`；其他宿主工具默认为 `"discoverable"`。响应中的 `toolNames` 列出已注册名称。

### `set_host_uri_schemes` 负载

替换 RPC 服务器应对其进行读/写分发的当前宿主自有 URL scheme 集：

```json
{
  "id": "req_4",
  "type": "set_host_uri_schemes",
  "schemes": [
    {
      "scheme": "db",
      "description": "Virtual db row files",
      "writable": true,
      "immutable": false
    }
  ]
}
```

响应负载为：

```json
{
  "schemes": ["db"]
}
```

Scheme 在传输中不区分大小写，并在发送响应之前被规范化为小写。重新发送 `set_host_uri_schemes` 会替换整个先前的集合——未出现在新列表中的 scheme 将被注销。

`security://` 保留给 OMP 的、与生产者无关的软件安全资源存储使用。RPC 宿主不能注册或覆盖该 scheme。

## 事件流模式

RPC 模式从 `AgentSession.subscribe(...)` 转发 `AgentSessionEvent` 对象。

常见事件类型：

- `agent_start`、`agent_end`
- `turn_start`、`turn_end`
- `message_start`、`message_update`、`message_end`
- `tool_execution_start`、`tool_execution_update`、`tool_execution_end`
- `auto_compaction_start`、`auto_compaction_end`
- `auto_retry_start`、`auto_retry_end`
- `retry_fallback_applied`、`retry_fallback_succeeded`
- `model_changed`、`thinking_level_changed`
- `ttsr_triggered`
- `todo_reminder`、`todo_auto_clear`
- `irc_message`、`notice`、`goal_updated`

扩展运行器错误单独以以下形式发出：

```json
{
  "type": "extension_error",
  "extensionPath": "...",
  "event": "...",
  "error": "..."
}
```

`message_update` 在 `assistantMessageEvent` 中包含流式增量（文本/思考/工具调用增量）。

`agent_end` 具有以下会话级别的形状（除可选的遥测字段外）：

```ts
{
  type: "agent_end";
  messages: AgentMessage[];
  isTerminal?: boolean;
}
```

`isTerminal: false` 表示维护或异步交付已调度了更多工作，
因此会话会在其真正的最终结算之前继续运行。只有当 `isTerminal !== false` 时，才应将 `agent_end` 视为运行完成；该字段是可选的，因此来自较旧运行时的（其中该字段缺失的）帧仍与终止状态兼容。

### 可用命令

`get_available_commands` 返回 `{ commands }`，同样的数组在启动时以及命令元数据变更后通过 `available_commands_update` 帧进行推送。每个命令都有 `name`、`source`，以及可选的 `aliases`、`description`、`input.hint` 和 `subcommands`。

### 子代理订阅

子代理转发默认为 `"off"`。`set_subagent_subscription` 可选择：

- `"off"`：不转发子代理帧
- `"progress"`：生命周期和进度帧
- `"events"`：生命周期、进度以及完整的子代理事件帧

`get_subagents` 返回按子代理索引和 id 排序的注册表快照。`get_subagent_messages` 通过 `subagentId` 或 `sessionFile` 选择一个转录；`fromByte` 支持增量读取。其结果包含 `sessionFile`、`fromByte`、`nextByte`、`reset`、原始转录 `entries` 以及转换后的 `messages`。如果 `fromByte` 超过当前文件大小，读取将从字节零重新开始，并报告 `reset: true`。

## 提示词/队列并发与顺序

这是最重要的运行行为。

### 立即确认与完成

`prompt` 和 `abort_and_prompt` 被**立即确认**：

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
```

这意味着：

- 命令被接受 != 运行完成
- 代理轮次仅在 `isTerminal !== false` 的 `agent_end` 帧上完成
- 仅在本地完成的提示词通过响应上的 `data.agentInvoked: false` 或通过稍后的 `prompt_result` 完成

### 流式传输期间

`AgentSession.prompt()` 在主动流式传输期间要求 `streamingBehavior`：

- `"steer"` => 排队的转向消息（中断路径）
- `"followUp"` => 排队的后续消息（轮次后路径）

在流式传输期间若省略，则 prompt 失败。

### 队列默认值

来自 `packages/agent/src/agent.ts` 的默认值：

- `steeringMode`：`"one-at-a-time"`
- `followUpMode`：`"one-at-a-time"`
- `interruptMode`：`"immediate"`

### 模式语义

- `set_steering_mode` / `set_follow_up_mode`
  - `"one-at-a-time"`：每轮出队一条排队的消息
  - `"all"`：一次出队整个队列
- `set_interrupt_mode`
  - `"immediate"`：工具执行在工具调用之间检查转向；挂起的转向可中止本轮中剩余的工具调用
  - `"wait"`：将转向推迟到轮次完成

## 扩展 UI 子协议

RPC 模式下的扩展使用请求/响应 UI 帧。

### 出站请求

`RpcExtensionUIRequest`（`type: "extension_ui_request"`）方法：

- `select`、`confirm`、`input`、`editor`、`cancel`
  - `select` 将标签保存在 `options: string[]` 中，并在任一选项带有
    description 时，发出一个按位置对齐的
    `optionDetails: Array<{ description?: string }>` 数组。不渲染
    description 的宿主可以继续单独使用 `options`。
- `notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`
- `open_url`（由 RPC 登录流程发出）

运行时说明：

- RPC 模式禁用了自动会话标题生成，`setTitle` UI
  请求默认也会被抑制，因为大多数宿主没有有意义的终端标题表面。
  设置 `PI_RPC_EMIT_TITLE=1` 可选择重新启用该 UI 事件。

示例：

```json
{
  "type": "extension_ui_request",
  "id": "123",
  "method": "confirm",
  "title": "Confirm",
  "message": "Continue?",
  "timeout": 30000
}
```

### 入站响应

`RpcExtensionUIResponse`（`type: "extension_ui_response"`）：

- `{ type: "extension_ui_response", id: string, value: string }`
- `{ type: "extension_ui_response", id: string, confirmed: boolean }`
- `{ type: "extension_ui_response", id: string, cancelled: true, timedOut?: boolean }`

如果对话框具有超时，则在超时/中止触发时，RPC 模式会解析为默认值。

## 宿主工具子协议

RPC 宿主可通过发送 `set_host_tools` 向代理暴露自定义工具，
然后通过同一传输来提供执行请求。

### 出站请求

当代理希望宿主执行其中一个工具时，RPC 模式会发出：

```json
{
  "type": "host_tool_call",
  "id": "host_1",
  "toolCallId": "toolu_123",
  "toolName": "echo_host",
  "arguments": { "message": "hello" }
}
```

如果工具执行稍后被中止，RPC 模式会发出：

```json
{
  "type": "host_tool_cancel",
  "id": "host_cancel_1",
  "targetId": "host_1"
}
```

### 入站更新与完成

宿主可以选择性地流式推送进度：

```json
{
  "type": "host_tool_update",
  "id": "host_1",
  "partialResult": {
    "content": [{ "type": "text", "text": "working" }]
  }
}
```

完成时使用：

```json
{
  "type": "host_tool_result",
  "id": "host_1",
  "result": {
    "content": [{ "type": "text", "text": "done" }]
  }
}
```

在 `host_tool_result` 上设置顶层 `isError: true` 可拒绝挂起的宿主工具调用，并将返回的文本内容作为工具错误呈现。

## 宿主 URI 子协议

RPC 宿主还可以拥有自定义的 URL scheme（虚拟文件）。在
`set_host_uri_schemes` 之后，每次对 `<scheme>://…` 的读取
以及（当注册为 `writable` 时）对 `<scheme>://…` 的写入
都会通过同一传输反弹回宿主。

### 出站请求

当会话工具解析了一个宿主自有的 URL 时，RPC 模式会发出：

```json
{
  "type": "host_uri_request",
  "id": "uri_1",
  "operation": "read",
  "url": "db://users/42"
}
```

写入看起来与之相同，但使用 `"operation": "write"` 以及一个
额外的 `"content": "..."` 字段，用于携带完整的替换字节。

如果请求稍后被中止（调用方取消、会话结束），RPC 模式
会发出：

```json
{
  "type": "host_uri_cancel",
  "id": "uri_cancel_1",
  "targetId": "uri_1"
}
```

### 入站结果

对于成功读取：

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "content": "id=42\nname=Alice\n",
  "contentType": "text/plain",
  "notes": ["fresh from cache"],
  "immutable": false
}
```

对于成功写入，省略 content：

```json
{ "type": "host_uri_result", "id": "uri_1" }
```

若要拒绝请求，请设置 `isError: true` 并在 `error` 中填入
消息，或退回到使用 `content` 来提供文本形式的错误信息：

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "isError": true,
  "error": "row 42 not found"
}
```

### 约束

- 代理的 `edit` 工具不会针对宿主 URI 进行操作。希望修改虚拟
  文件的宿主应暴露 `write`，并让模型使用 `write` 工具配合替换内容。
- Scheme 对进程全局生效；`set_host_uri_schemes` 会替换
  先前的集合，注销任何未在新列表中出现的 scheme。
- Scheme 在注册之前被规范化为小写。
- 成功读取需要 `content`。`contentType` 默认为 `text/plain`，
  若提供，则为 `"text/plain"`、`"text/markdown"` 或
  `"application/json"`。结果级别的 `immutable` 会覆盖该次读取所
  注册 scheme 的对应值。

## 错误模型与可恢复性

### 命令级失败

失败为 `success: false`，并带有字符串 `error`。

```json
{
  "id": "req_2",
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: provider/model"
}
```

### 可恢复性预期

- 大多数命令失败都是可恢复的；进程保持存活。
- 格式错误的 JSONL / 解析循环异常会发出 `parse` 错误响应，并继续读取后续行。
- 为空的 `set_session_name` 会被拒绝（`Session name cannot be empty`）。
- 带有未知 `id` 的扩展 UI 响应会被忽略。
- 进程终止条件是 stdin 关闭，或在当前命令之后由扩展显式触发的关闭。

## 紧凑命令流

### 1) 提示词并流式传输

stdin：

```json
{ "id": "req_1", "type": "prompt", "message": "Summarize this repo" }
```

stdout 序列（典型）：

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
{ "type": "agent_start" }
{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "..." }, "message": { "role": "assistant", "content": [] } }
{ "type": "agent_end", "messages": [], "isTerminal": true }
```

### 2) 流式传输期间使用显式队列策略进行提示

stdin：

```json
{
  "id": "req_2",
  "type": "prompt",
  "message": "Also include risks",
  "streamingBehavior": "followUp"
}
```

### 3) 检查并调整队列行为

stdin：

```json
{ "id": "q1", "type": "get_state" }
{ "id": "q2", "type": "set_steering_mode", "mode": "all" }
{ "id": "q3", "type": "set_interrupt_mode", "mode": "wait" }
```

### 4) 扩展 UI 往返

stdout：

```json
{
  "type": "extension_ui_request",
  "id": "ui_7",
  "method": "input",
  "title": "Branch name",
  "placeholder": "feature/..."
}
```

stdin：

```json
{ "type": "extension_ui_response", "id": "ui_7", "value": "feature/rpc-host" }
```

## 客户端库

### TypeScript 辅助工具

`packages/coding-agent/src/modes/rpc/rpc-client.ts` 是一个便利性包装器，并非协议定义本身。

当前辅助工具的特性：

- 生成 `bun <cliPath> --mode rpc` 进程
- 通过生成的 `req_<n>` id 来关联响应
- 将已识别的核心 `AgentEvent` 类型分派给监听器
- 通过 `setCustomTools()` 支持宿主自有的自定义工具，并自动处理 `host_tool_call` / `host_tool_cancel`
- 包装常见的协议命令，包括 OAuth 的 `getLoginProviders()` / `login(...)`；对于辅助工具未包装的任何表面，请使用原始协议帧。

### Python 包

捆绑的 [`omp-rpc`](../python/omp-rpc/pyproject.toml) 发行版提供了基于进程的 Python 客户端。其导入包为 `omp_rpc`；包 API、类型化命令和事件、宿主工具/宿主 URI 辅助工具以及编排示例在 [`omp-rpc` README](../python/omp-rpc/README.md) 中维护。

```python
from omp_rpc import RpcClient

with RpcClient(provider="anthropic", model="claude-sonnet-4-5") as client:
    state = client.get_state()
    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

默认情况下，`RpcClient` 会启动 `omp --mode rpc`；通过传入 `command=[...]` 可拥有精确的子命令。它负责请求关联、类型化通知、v2 协商与 chunk 重组、消息分页、扩展 UI，以及宿主自有的工具和 URI scheme。Python 包拥有该客户端 API 和进程生命周期；本文档及 `rpc-types.ts` 仍为权威的线路契约。当客户端库未包装所需的表面时，请使用原始协议帧。
