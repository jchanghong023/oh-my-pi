# 非压缩自动重试策略

本文档描述由 `AgentSession` 协调、并由 `TurnRecovery` 实现的标准 API 错误重试路径。

它显式排除了通过自动压缩进行的上下文溢出恢复。溢出由压缩逻辑处理，并在 [`compaction.md`](./compaction.md) 中单独记录。

## 实现文件

- [`../packages/coding-agent/src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../packages/coding-agent/src/session/turn-recovery.ts`](../packages/coding-agent/src/session/turn-recovery.ts) — 重试分类、退避、凭据轮换以及模型回退
- [`../packages/coding-agent/src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)
- [`../packages/coding-agent/src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)
- [`../packages/coding-agent/src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`../packages/coding-agent/src/modes/rpc/rpc-mode.ts`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [`../packages/coding-agent/src/modes/rpc/rpc-client.ts`](../packages/coding-agent/src/modes/rpc/rpc-client.ts)
- [`../packages/coding-agent/src/modes/rpc/rpc-types.ts`](../packages/coding-agent/src/modes/rpc/rpc-types.ts)

## 与压缩的边界范围

重试与压缩从同一个 `agent_end` 路径进行检查，但二者有意分离：

1. `agent_end` 检查最后一条助手消息。
2. `TurnRecovery.isRetryableError(...)` 在普通压缩恢复之前运行。
3. 如果启动了重试，该轮将跳过压缩检查。
4. 上下文溢出错误被 `AIError.isContextOverflow(...)` 排除在重试分类之外。
5. 因此溢出会进入 `SessionMaintenance.checkCompaction(...)`，而不是走标准重试。

因此：过载/限流/服务器/网络类故障使用本重试策略；上下文窗口溢出使用压缩恢复。

## 重试分类

`TurnRecovery.isRetryableError(...)` 需要同时满足以下所有条件：

- 助手 `stopReason === "error"`
- 消息**不是**上下文溢出
- 满足以下条件之一：
  - 停止是分类器拒绝（`stopDetails.type` 为 `"refusal"` 或 `"sensitive"`）
  - 错误是陈旧的 OpenAI Responses 重放失败
  - 归一化后的 `AIError` 分类为可重试（包括瞬态传输/提供商失败和使用上限）

重试分类通过 `AIError.classifyMessage(...)` 运行，使用已持久化的 `errorId`/status（如果存在），并通过可识别提供商的文本分类进行增强。它并不仅仅是正则策略，不过遗留的/纯字符串型提供商失败仍使用文本分类。

陈旧重放与可重试错误分支还要求流**尚未**发出重放不安全输出。非空可见文本、图像、工具调用以及 Anthropic 服务器工具块会阻止重放。仅包含思考内容或仅包含空白字符的中间片段可以安全丢弃并重试。分类器拒绝同样要经过该重放安全检查。

当前可重试的类别包括：

- 瞬态传输/信封故障，包括 `message_start` 之前的 Anthropic 流信封失败
- 过载/提供商返回错误用语
- 速率限制 / 使用上限 / 请求过多
- 类 HTTP 服务器状态码：429、500、502、503、504
- 服务不可用 / 服务器内部错误
- 提供商建议的重试用语，包括 OpenAI `retry your request` 失败
- 网络/连接/套接字失败、连接被拒/关闭、上游连接/在返回头部前被重置、socket hang up、超时/timed out、fetch failed、terminated、重试延迟用语，以及意外的套接字关闭消息

归一化分类器通过结构化标志/状态和可识别提供商的文本模式来识别上述瞬态类别。分类器拒绝仍然是独立的类型化 `stopDetails` 决策。

除了 `isRetryableError(...)`，在没有用户、释放或流式编辑保护中止进行时，普通的空中止也可以进入同一重试引擎。工具调用已有匹配结果的中断轮次也可以安全地继续：失败的助手/工具结果序列会被保留，从而不会重放已完成的副作用。已解析的流停滞和 HTTP/2 流重置（`NGHTTP2_INTERNAL_ERROR`、`NGHTTP2_REFUSED_STREAM`、`HTTP2StreamReset`）使用相同的“保留并继续”路径。Cursor 空闲停滞恢复会在每个已发出工具调用都有结果之后继续；Connect 流在空闲中止时已经关闭。HTTP/2 RST 同样如此：流已经死了。

重试状态由 `TurnRecovery` 拥有：

- 重试尝试计数器（`0` 表示空闲）
- 重试生命周期 Promise 与其 resolver
- 重试退避中止控制器

流程（`#handleRetryableError`）：

1. 读取 `retry` 设置组，当重试被禁用时停止（固有的 Fireworks Fast 一次性回退到基础模型除外）。
2. 增加重试尝试次数，并在首次尝试时创建共享的重试生命周期 Promise。
3. 判断当前模型的重试预算是否已耗尽。
4. 对错误进行分类，解析重试时机，并计算带上限并加入抖动的退避：`min(retry.baseDelayMs * 2^(attempt-1), 8000ms) * (75–100% 抖动)`。陈旧的 OpenAI Responses 重放错误会重置 provider 会话并使用 `0` 延迟。
5. 对于使用上限，立即应用一次成功的凭据切换或已储备的 Codex 重置；否则等待提供商提示与下一个暂时被屏蔽的同级凭据中较早出现的时机。
6. 在允许的情况下，查阅已配置的模型回退链。切换使用 `0` 延迟；分类器拒绝仅在应用了回退时才会继续。
7. 如果当前模型的重试预算已耗尽，则停止，除非找到了回退模型。回退模型会获得全新的重试预算。
8. 如果最终延迟超过 `retry.maxDelayMs` 且没有发生凭据/模型切换，则直接发出最终失败而不进入睡眠。
9. 发出 `auto_retry_start`，记录可恢复错误，并将失败的助手从活动上下文中移除，除非这是已解析的中断工具轮次。
10. 在支持中止的情况下睡眠，然后通过后置提示任务调度器为同一提示生成调度 `agent.continue()`。

### 哪些情况会重置重试计数器

`#retryAttempt` 在以下情况下重置为 `0`：

- 重试开始后，第一条成功的、非错误、非中止的助手消息（发出 `auto_retry_end { success: true }`）
- 在退避睡眠期间重试被取消
- 超出最大重试次数的路径
- 超出最大延迟的路径
- 分类器拒绝或硬错误，且未应用回退模型
- 后续错误在没有重试或压缩延续的情况下结束

重试 Promise 在链路结束时被解析并清除。

## 退避与最大尝试次数语义

设置：

- `retry.enabled`（默认 `true`）
- `retry.maxRetries`（默认 `10`）
- `retry.baseDelayMs`（默认 `500`）
- `retry.maxDelayMs`（默认 `300000`，5 分钟；`<= 0` 禁用快速失败上限）

尝试编号：

- 尝试计数器在最大次数检查前递增
- start 事件使用当前尝试次数（从 1 开始）
- 超出最大次数的 end 事件上报 `attempt: this.#retryAttempt - 1`（最后尝试的重试次数）

使用默认设置、在加入抖动之前的退避序列：

- 尝试 1：500 ms
- 尝试 2：1000 ms
- 尝试 3：2000 ms
- 尝试 4：4000 ms
- 尝试 5+：8000 ms

实际的本地睡眠为标称值的 75–100%，与 Anthropic 风格的重试抖动一致，以避免并发会话同步重试。

延迟覆盖输入可以来自已解析的重试头部（`retry-after-ms`、`retry-after`、`x-ratelimit-reset-ms`、`x-ratelimit-reset`）或使用上限退避。凭据/模型回退切换将延迟设为 `0`；否则解析出的提示可以延长带上限的本地延迟。如果计算出的延迟大于 `retry.maxDelayMs` 且没有成功的切换，则重试立即以最终错误结束，而不进入睡眠。

## 中止机制

### 显式重试中止

`abortRetry()`：

- 中止 `#retryAbortController`（如果存在）
- 解析重试 Promise（`#resolveRetry()`），从而解除 await 等待

如果中止发生在睡眠期间，捕获路径会发出：

- `auto_retry_end { success: false, finalError: "Retry cancelled" }`
- 重置尝试计数与控制器

### 全局操作中止的交互

`abort()` 在中止当前 agent 流之前调用 `abortRetry()`。这保证了当用户发起通用中止时，重试退避会被取消。

### TUI 交互

在 `auto_retry_start` 时，EventController（`#handleAutoRetryStart`）：

- 停止工作加载动画并清空状态容器
- 渲染一个 `retryLoader`，文本为：`Retrying (attempt/maxAttempts) in Ns… (esc to cancel)`

`Esc` 取消基于实时会话状态而非已替换的处理器分发：输入控制器会检查 `viewSession.isRetrying` 并调用 `viewSession.abortRetry()`（连同其压缩/交接中止检查一起）。

在 `auto_retry_end`（`#handleAutoRetryEnd`）时，它会停止并清除 `retryLoader` 与状态容器。

## 流式与提示完成行为

`prompt()` 最终在 `agent.prompt(...)` 返回后等待 `#waitForPostPromptRecovery()`；该循环会与 TTSR 恢复和延迟的后置提示任务一起等待重试生命周期 Promise。

效果：

- 一次提示调用在任何已启动的重试链结束（成功/失败/取消）之前不会完全解析
- 重试生命周期属于同一次逻辑提示执行的边界

这可以防止调用方过早地将正在重试的轮次视为已完成。

## 控制项：设置与 RPC

### 配置开关

定义在设置 schema 的 retry 组下：

- `retry.enabled`
- `retry.maxRetries`
- `retry.baseDelayMs`
- `retry.maxDelayMs`
- `retry.modelFallback`（默认 `true`；控制是否启用重试时的模型回退切换）
- `retry.fallbackChains`
- `retry.fallbackRevertPolicy`（默认 `"cooldown-expiry"`；`"never"` 禁用自动恢复）
- `retry.usageAwareFallback`（默认 `false`；对支持的 coding-plan 用量报告运行预检查）
- `retry.usageReservePct`（默认 `10`；剩余配额保留阈值）
- `retry.usageReservePolicy`（默认 `"confirm"`；也支持 `"auto"` 和 `"fail-closed"`）

会话中的程序化开关：

- `setAutoRetryEnabled(enabled)` 写入 `retry.enabled`
- `autoRetryEnabled` 读取 `retry.enabled`
- `isRetrying` 报告重试生命周期 Promise 是否处于活动状态

### RPC 控制

RPC 命令接口：

- `set_auto_retry` → `session.setAutoRetryEnabled(command.enabled)`
- `abort_retry` → `session.abortRetry()`

客户端辅助方法：

- `RpcClient.setAutoRetry(enabled)`
- `RpcClient.abortRetry()`

## 事件发送与失败呈现

会话级重试事件：

- `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage, errorId? }`
- `auto_retry_end { success, attempt, finalError?, recoveredErrors? }`
- `retry_fallback_applied { from, to, role }`
- `retry_fallback_succeeded { model, role }`

传播：

- 通过 `AgentSession.subscribe(...)` 发送
- 作为扩展事件转发给扩展运行器
- 在 RPC 模式下，直接以 JSON 事件对象形式转发（`session.subscribe(event => output(event))`）
- 在 TUI 中，由 `EventController` 消费以驱动加载动画/错误 UI

最终失败呈现：

- 在超出最大次数、超过最大延迟或被取消时，`auto_retry_end.success === false`
- TUI 显示：`Retry failed after N attempts: <finalError>`
- 扩展/钩子接收具有相同字段的 `auto_retry_end`
- RPC 消费者在 stdout 流上接收相同的事件对象

## 永久停止条件

当以下任一情况发生时，重试会停止并且不会自动继续：

- `retry.enabled` 为 false
- 错误未被分类为可重试
- 错误为上下文溢出（委托给压缩路径）
- 超出最大重试次数且没有可用的回退模型
- 提供商请求的延迟超过 `retry.maxDelayMs` 且没有可用的凭据/模型切换
- 用户取消重试（`abort_retry` 或在重试加载动画期间按 `Esc`）
- 全局中止（`abort`）先取消重试

在计数器重置之后，新的重试链仍可在后续的可重试错误上启动。

## 操作注意事项

- 分类使用归一化的 `AIError` 标志/状态以及可识别提供商的文本回退；它不仅限于结构化错误，也不限于单独的正则匹配。
- 重试在重新继续之前会从**运行时上下文**中剥离失败的助手错误，但会话历史仍保留该错误条目。
- `RpcSessionState` 当前暴露 `autoCompactionEnabled`，但不暴露 `autoRetryEnabled` 字段；RPC 调用方必须自行跟踪其开关状态，或通过其他 API 查询设置。
- 模型回退变更会追加临时的 `model_change` 条目，并可能在主模型冷却到期后根据 `retry.fallbackRevertPolicy` 恢复为主模型。
- 当 `retry.modelFallback` 和 `retry.usageAwareFallback` 同时启用时，使用量感知的回退会在提供商请求之前运行。未知/未映射的使用量采用开放失败策略。在保留阈值处，`"confirm"` 会向交互式会话询问并在被拒绝时保留当前模型；没有确认 UI 的会话会自动应用一个已配置的可用回退。`"auto"` 会在不询问的情况下应用可用回退。`"fail-closed"` 会在保留或已耗尽的使用量上拒绝调用，而不是消耗它或选择回退。其他策略下的已耗尽使用量会应用可用回退而不进行保留确认。
