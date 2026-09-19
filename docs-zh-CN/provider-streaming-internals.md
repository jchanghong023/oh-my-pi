# Provider 流式内部机制

本文档说明 token/tool 流式传输如何在 `@oh-my-pi/pi-ai` 中被规范化，然后经由 `@oh-my-pi/pi-agent-core` 和 `coding-agent` 的会话事件进行传播。

## 端到端流程

1. `streamSimple()`（`packages/ai/src/stream.ts`）映射通用选项并分派到 provider 流函数。重量级的内置实现通过 `packages/ai/src/providers/register-builtins.ts` 中的懒加载包装访问；轻量的路由包装保持即时加载。
2. Provider 流函数将 provider 原生的流事件转换为统一的 `AssistantMessageEvent` 序列。当前的内置实现包括 Anthropic、OpenAI Responses/Completions/Codex/Azure Responses、Google Gemini/Gemini CLI/Vertex、Bedrock Converse、Ollama、Cursor、Devin、pi-native gateway 传输，外加 GitLab Duo、GitLab Duo Workflow、Kimi 和 Synthetic 包装器，以及通过扩展注册的自定义 API。（xAI Grok 没有专用包装器：`xai-oauth` 和 API-key `xai` 模型都是目录规格，带 `api: "openai-responses"`，位于 `https://api.x.ai/v1`，走共享的 OpenAI Responses 路径并带目录级 compat。）
3. 每个 provider 将事件推入 `AssistantMessageEventStream`（`packages/ai/src/utils/event-stream.ts`），它提供：
   - 异步迭代，用于增量更新
   - `result()`，用于获取最终的 `AssistantMessage`
4. 懒加载的转发包装应用首进度和空闲看门狗。合成的 `start` 事件不计入首进度；provider 可以用 `trackLocalWork()` 标记服务端请求的本地工作，使该工作看起来不像停滞的流。
5. `agentLoop`（`packages/agent/src/agent-loop.ts`）消费这些事件，变更进行中的 assistant 状态，并发出携带原始 `assistantMessageEvent` 的 `message_update` 事件。
6. `AgentSession`（`packages/coding-agent/src/session/agent-session.ts`）订阅 agent 事件、持久化消息、驱动扩展钩子，并应用会话行为（重试、压缩、TTSR、流式编辑中止检查）。

## `@oh-my-pi/pi-ai` 中的统一流契约

所有 provider 发出相同的形态（`packages/ai/src/types.ts` 中的 `AssistantMessageEvent`）：

- `start`
- 内容块生命周期三元组：
  - 文本：`text_start` → `text_delta`\* → `text_end`
  - 思考：`thinking_start` → `thinking_delta`\* → `thinking_end`
  - 工具调用：`toolcall_start` → `toolcall_delta`\* → `toolcall_end`
- 完整的图片块：`image_end`
- 终止事件：
  - `done`，带有 `reason: "stop" | "length" | "toolUse"`
  - 或 `error`，带有 `reason: "aborted" | "error"`

`AssistantMessageEventStream` 保证：

- `done` 或 `error` 事件会将 `result()` 解析为该事件的最终 assistant 消息
- `fail(error)` 改为拒绝迭代和 `result()`；没有最终结果时 `end()` 会拒绝 `result()`，而不是让它保持挂起
- 事件按推送顺序立即投递给消费者（不批处理、不合并）

## Delta 节流行为

`AssistantMessageEventStream` 本身不再对 delta 事件进行节流或合并 —— 每个 provider 事件都按推送原样投递。每个 delta 的成本控制已移至工具调用参数解析：provider 累积部分 JSON，并通过 `parseStreamingJsonThrottled()`（`packages/utils/src/json-parse.ts`）重新解析，该函数会跳过重新解析，直到至少有 `STREAMING_JSON_PARSE_MIN_GROWTH`（256）个新字节到达，从而将流中段的解析代价从二次方限定为线性。在工具调用边界的最终解析是无条件且权威的。

不存在 provider 背压：provider 仍然全速产出，本地流则进行排队。

## Provider 规范化细节

## Anthropic（`anthropic-messages`）

来源：`packages/ai/src/providers/anthropic.ts`

规范化要点：

- `message_start` 初始化用量（input/output/cache tokens）
- `content_block_start` 映射为 text/thinking/toolcall 起始
- `content_block_delta` 映射：
  - `text_delta` → `text_delta`
  - `thinking_delta` → `thinking_delta`
  - `input_json_delta` → `toolcall_delta`
  - `signature_delta` 仅更新 `thinkingSignature`（不产生事件）
- `content_block_stop` 发出对应的 `*_end`
- `message_delta.stop_reason` 通过 `mapStopReason()` 映射

工具调用参数流式传输：

- 每个工具块携带内部 `partialJson`
- 每个 JSON delta 追加到 `partialJson`
- 追加 delta 时通过 `parseStreamingJsonThrottled()` 重新解析 `arguments`（仅在新增 ≥256 字节后重新解析）
- `toolcall_end` 再解析一次，然后去除 `partialJson`

## OpenAI Responses 系列（`openai-responses`、`openai-codex-responses`、`azure-openai-responses`）

来源：`packages/ai/src/providers/openai-responses.ts`、`openai-codex-responses.ts` 和 `azure-openai-responses.ts`

规范化要点：

- `response.output_item.added` 启动 reasoning/text/function-call/custom-tool 块
- 推理摘要事件（`response.reasoning_summary_text.delta`）和原始推理事件（`response.reasoning_text.delta`）变为 `thinking_delta`
- output/refusal delta 变为 `text_delta`
- `response.function_call_arguments.delta` 和 `response.custom_tool_call_input.delta` 变为 `toolcall_delta`
- `response.output_item.done` 发出 `thinking_end` / `text_end` / `toolcall_end`
- `response.completed` 将状态映射为停止原因和用量；`response.failed` / SDK `error` 事件抛出到包装器的终止 `error` 路径

工具调用参数流式传输：

- 与 Anthropic 相同的 `partialJson` 累积模式，用于函数调用 JSON 参数
- 自定义工具以原始字符串输入流式传输，并将最终参数暴露为 `{ input: <raw> }`
- 仅发送 `response.function_call_arguments.done` 的 provider 仍会填充最终参数
- 工具调用 ID 被规范化为 `"<call_id>|<item_id>"`

## Google Generative AI（`google-generative-ai`）

来源：`packages/ai/src/providers/google.ts`（轻量请求包装）和 `google-shared.ts`（`streamGoogleGenAI`，共享的 chunk-to-block 转换）

规范化要点：

- 迭代 `candidate.content.parts`
- 文本 part 由 `isThinkingPart(part)` 拆分为 thinking 与 text
- 块转换在启动新块前关闭前一个块
- `part.functionCall` 被视为完整的工具调用（立即发出 start/delta/end）
- 完成原因由 `google-shared.ts` 中的 `mapStopReason()` 映射

工具调用参数流式传输：

- 函数调用参数以结构化对象形式到达，而非增量 JSON 文本
- 实现发出一个合成的 `toolcall_delta`，其中包含 `JSON.stringify(arguments)`
- 此路径下 Google 不需要部分 JSON 解析器

## 部分工具调用 JSON 的累积与恢复

共享行为使用 `parseStreamingJson()` / `parseStreamingJsonThrottled()`（`packages/utils/src/json-parse.ts`）：

1. 尝试 `JSON.parse`
2. 回退到内部的 `RelaxedJson` 解析器（relaxed/repairing），用于不完整片段
3. 如果两者都失败，返回 `{}`

含义：

- 格式错误或被截断的参数 delta 不会立即使流处理崩溃
- 进行中的 `arguments` 可能暂时为 `{}`
- 由于解析会在缓冲区增长时重试（流中段被节流为 ≥256 字节的增长步进），后续有效的 delta 可以恢复结构化参数
- 最终的 `toolcall_end` 在发出之前再执行一次解析尝试

## 停止原因与传输/运行时错误

Provider 的停止原因会被映射为规范化的 `stopReason`：

- Anthropic：`end_turn`→`stop`，`max_tokens`→`length`，`tool_use`→`toolUse`，safety/refusal 这类情况→`error`
- OpenAI Responses：`completed`→`stop`，`incomplete`→`length`，`failed/cancelled`→`error`
- Google：`STOP`→`stop`，`MAX_TOKENS`→`length`，safety/prohibited/malformed-function-call 类→`error`

错误语义分为两个阶段：

1. **模型完成语义**（provider 报告的完成原因/状态）
2. **传输/运行时失败**（网络/客户端/解析器/中止异常）

如果 provider 流抛出异常或发出失败信号，每个 provider 包装器都会捕获它并发出终止 `error` 事件，其中：

- 当 abort signal 已设置时 `stopReason = "aborted"`
- 否则 `stopReason = "error"`
- `errorMessage = finalizeErrorMessage(error, rawRequestDump)`（`packages/ai/src/utils/http-inspector.ts`），它会包装 `formatErrorMessageWithRetryAfter()` 并附加任何已捕获的 HTTP 错误响应体 / 原始请求转储（`cursor` 包装器直接调用 `formatErrorMessageWithRetryAfter()`）

## 畸形 chunk / SSE 解析失败行为

OpenAI Completions/Responses 路径使用仓库内的 HTTP+SSE 传输 `postOpenAIStream()`（`packages/ai/src/utils/openai-http.ts`），它通过 `readSseJson()` 解码帧，并取代了 `openai` SDK 客户端。Anthropic 使用仓库内的 `AnthropicMessagesClient`（`packages/ai/src/providers/anthropic-client.ts`）；Google 路径和 Codex SSE 回退路径通过 `readSseJson()` 直接读取 SSE，而 websocket Codex 帧则经由同一事件处理器规范化。

当前实现中观察到的行为：

- 格式错误的 SSE 帧或 chunk JSON 会表现为异常或流 `error` 事件
- 格式错误的 Codex SSE JSON/帧会从本地 SSE 读取器抛出
- provider 不会从单个格式错误的 chunk 恢复。根据 provider 以及是否已发出任何重放不安全输出，对于瞬态传输或格式错误信封的失败，可能会启动一次有界的、provider 自行负责的请求重试，重新发起全新尝试。
- provider 自行负责的恢复还包括有界的空补全重试（OpenAI Responses、OpenAI Completions、Anthropic、Google native/Vertex、Gemini CLI 和 Ollama），以及能力回退，例如在去掉被拒绝的 strict-tool 字段后重试
- Codex 只能在发出重放不安全输出之前从 websocket 回退到 SSE
- `AgentSession` 单独处理消息级别的自动重试；它不会从失败的 chunk 重放流

## 取消边界

取消是分层的：

- AI provider 请求：`options.signal` 被传入 provider 客户端的流调用。
- Provider 包装器：在流循环之后，已中止的 signal 会强制走错误路径（`"Request was aborted"`）。
- Agent 循环：在处理每个 provider 事件之前检查 `signal.aborted`，并可以从最新的部分内容合成一条已中止的 assistant 消息。
- Session/agent 控制：`AgentSession.abort()` -> `agent.abort()` -> 共享 abort controller 取消。

工具执行取消与模型流取消是分开的：

- 工具运行器使用 `AbortSignal.any([agentSignal, steeringAbortSignal])`
- steering 中断可以中止剩余的工具执行，同时保留已生成的工具结果

## 背压边界

在 provider SDK 流和下游消费者之间不存在硬性背压机制：

- `EventStream` 使用无最大大小的内存队列
- 经过节流的部分 JSON 重新解析降低了每个 delta 的 CPU 成本，但不会减慢 provider 摄入速度
- 如果消费者显著滞后，排队的事件可能会一直增长直到完成

当前设计在响应速度和简单顺序方面优先于有界缓冲的流控。

## 流事件如何呈现为 agent/session 事件

`agentLoop.streamAssistantResponse()` 将 `AssistantMessageEvent` 桥接到 `AgentEvent`：

- 在 `start` 上：推入占位 assistant 消息并发出 `message_start`
- 在块事件上（`text_*`、`thinking_*`、`image_end`、`toolcall_*`）：更新最后一条 assistant 消息，并以原始 `assistantMessageEvent` 发出 `message_update`
- 在终止事件上（`done`/`error`）：从 `response.result()` 解析最终消息，发出 `message_end`

随后 `AgentSession` 消费这些事件以执行会话级行为：

- TTSR 监视 `message_update.assistantMessageEvent` 中的 `text_delta`、`thinking_delta` 和 `toolcall_delta`
- 流式编辑守卫检查 `edit` 调用的 `toolcall_delta`/`toolcall_end`，并可提前中止
- 持久化在 `message_end` 写入最终化消息
- 自动重试检查 assistant 的 `stopReason === "error"` 以及 `errorMessage` 启发式

## 统一职责与 provider 特定职责

统一（公共契约）：

- 事件形态（`AssistantMessageEvent`）
- 最终结果提取（`done`/`error`）
- 即时的按序事件投递
- agent/session 事件传播模型

Provider 特定（未完全抽象）：

- 上游事件分类与映射逻辑
- 停止原因翻译表
- 工具调用 ID 约定
- reasoning/thinking 块语义与签名
- 用量 token 语义与可用性时序
- 各 API 的消息转换约束

## 实现文件

- [`../../ai/src/stream.ts`](../packages/ai/src/stream.ts) — provider 分派、选项映射、API key/session 接线、自定义 API 分派以及 provider 特定的凭据处理。
- [`../../ai/src/utils/event-stream.ts`](../packages/ai/src/utils/event-stream.ts) — 通用流队列与最终结果解析。
- [`../../utils/src/json-parse.ts`](../packages/utils/src/json-parse.ts) — 用于流式工具参数的部分 JSON 解析。
- [`../../ai/src/providers/anthropic.ts`](../packages/ai/src/providers/anthropic.ts) — Anthropic 事件转换和工具 JSON delta 累积。
- [`../../ai/src/providers/openai-responses.ts`](../packages/ai/src/providers/openai-responses.ts)、[`openai-shared.ts`](../packages/ai/src/providers/openai-shared.ts)、[`openai-codex-responses.ts`](../packages/ai/src/providers/openai-codex-responses.ts)、[`azure-openai-responses.ts`](../packages/ai/src/providers/azure-openai-responses.ts) — Responses 系列事件转换和状态映射。
- [`../../ai/src/providers/google.ts`](../packages/ai/src/providers/google.ts)、[`google-gemini-cli.ts`](../packages/ai/src/providers/google-gemini-cli.ts)、[`google-vertex.ts`](../packages/ai/src/providers/google-vertex.ts) — Gemini 流 chunk-to-block 转换的各变体。
- [`../../ai/src/providers/google-shared.ts`](../packages/ai/src/providers/google-shared.ts) — Gemini 完成原因映射和共享转换规则。
- [`../../ai/src/providers/amazon-bedrock.ts`](../packages/ai/src/providers/amazon-bedrock.ts)、[`openai-completions.ts`](../packages/ai/src/providers/openai-completions.ts)、[`ollama.ts`](../packages/ai/src/providers/ollama.ts)、[`cursor.ts`](../packages/ai/src/providers/cursor.ts)、[`pi-native-client.ts`](../packages/ai/src/providers/pi-native-client.ts) — 使用相同事件契约的其他内置流适配器。
- [`../../ai/src/providers/register-builtins.ts`](../packages/ai/src/providers/register-builtins.ts) 和 [`../../ai/src/utils/idle-iterator.ts`](../packages/ai/src/utils/idle-iterator.ts) — 懒加载 provider 转发、首进度/空闲看门狗以及感知本地工作的停滞处理。
- [`../../agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts) — provider 流消费和 `message_update` 桥接。
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — 流式更新、中止、重试和持久化的会话级处理。
