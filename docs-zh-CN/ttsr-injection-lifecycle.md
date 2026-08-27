# TTSR 注入生命周期

本文档介绍当前 Time Traveling Stream Rules (TTSR) 运行时路径，覆盖规则发现、流中断、重试注入、扩展通知以及会话状态处理。

## 实现文件

- [`../src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`../src/export/ttsr.ts`](../packages/coding-agent/src/export/ttsr.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/ttsr-coordinator.ts`](../packages/coding-agent/src/session/ttsr-coordinator.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/prompts/system/ttsr-interrupt.md`](../packages/coding-agent/src/prompts/system/ttsr-interrupt.md)
- [`../src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`../src/extensibility/extensions/types.ts`](../packages/coding-agent/src/extensibility/extensions/types.ts)
- [`../src/extensibility/hooks/types.ts`](../packages/coding-agent/src/extensibility/hooks/types.ts)
- [`../src/extensibility/custom-tools/types.ts`](../packages/coding-agent/src/extensibility/custom-tools/types.ts)
- [`../src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)

## 1. 发现源与规则注册

在会话创建时，`createAgentSession()` 加载已发现的规则，构造 `TtsrManager`，并通过 `bucketRules(...)` 对规则进行分桶：

```ts
const ttsrSettings = settings.getGroup("ttsr");
const ttsrManager = new TtsrManager(ttsrSettings);
const rulesResult = await loadCapability<Rule>(ruleCapability.id, { cwd });
const { rulebookRules, alwaysApplyRules } = bucketRules(
  rulesResult.items,
  ttsrManager,
  {
    builtinRules: ttsrSettings.builtinRules,
    disabledRules: ttsrSettings.disabledRules,
  },
);
```

`bucketRules(...)` 会丢弃 `ttsr.disabledRules` 中列出的名称，当 `ttsr.builtinRules === false` 时丢弃内嵌的 `builtin-defaults` 规则，注册被接受的 TTSR 规则，然后将其余规则路由到 always-apply/rulebook 两个桶中。

### 注册前去重行为

`loadCapability("rules")` 按 `rule.name` 进行去重，采用 first-wins 语义（提供方优先级高的优先）。被遮蔽的重复项会在 TTSR 注册之前被移除。

### `TtsrManager.addRule()` 行为

以下情况会跳过注册：

- TTSR 被禁用（`ttsr.enabled === false`）
- 同时缺少 `rule.condition`（正则）和 `rule.astCondition`（ast-grep 模式），或每个正则条件都无法编译且不存在非空的 AST 条件
- 此管理器中已注册了同名的 `rule.name` 规则
- 解析后的规则 scope 排除了所有被监听的流

无效的正则条件和不可达的 scope 会被记录为警告并忽略，会话启动继续进行。AST 解析/匹配失败在尝试匹配时会被记录，并视为未匹配。如果 TTSR 规则定义了 `globs`，这些 globs 会被编译为用于匹配的全局文件路径门控。

在未显式指定 `scope` 的情况下，规则会监听助手文本和所有工具参数，但不会监听思考。显式 scope 标记可以启用 `text`、`thinking`、任意工具（`tool`/`toolcall`）、具名工具，以及可选的逐工具路径 globs。

### AST 条件（`astCondition`）

AST 条件仅在工具参数流上求值，且仅限于那些暴露重建后的 `matcherDigest` 或逐文件 `matcherEntries` 的工具，并仅在候选路径提供了可用于语言推断的文件扩展名时执行。内建的 edit/write 工具提供了这些接口，但协调器会从当前激活的工具泛化地解析它们。

快照是承载源码的 payload，而非整个未来文件：除非调用重复出现，否则预存在的目标内容不可见。当前的编辑模式为 replace 形式暴露 `new_string`，为 JSON patch、hashline 和 apply-patch 形式暴露新增行，为 create 形式暴露完整内容；write 暴露其整个 `content`。多文件 hashline/apply-patch 调用会被拆分为独立的 `{ path, digest }` 条目，因此 AST 语言、路径 scope/globs、缓冲区和匹配都是按文件进行的。匹配通过原生 `astMatch` 以 Smart 严格性在内存中完成。

### 设置开关

`TtsrSettings.enabled` 控制管理器：当 `ttsr.enabled === false` 时，`addRule()` 拒绝注册，且 `checkDelta()`/`checkSnapshot()`/`checkAstSnapshot()`/`hasRules()`/`hasAstRules()` 全部返回空/false，因此不会运行任何匹配。

设置项缺省时的管理器默认值：

| Setting         | Default                                          |
| --------------- | ------------------------------------------------ |
| `enabled`       | `true`                                           |
| `contextMode`   | `"discard"`                                      |
| `interruptMode` | `"always"`                                       |
| `repeatMode`    | `"once"`                                         |
| `repeatGap`     | `10` completed turns                             |
| `builtinRules`  | `true` (consumed by `bucketRules`, not matching) |
| `disabledRules` | `[]` (consumed by `bucketRules`, not matching)   |

## 2. 流监听器生命周期

TTSR 检测由 `AgentSession.#handleAgentEvent` 委托给会话拥有的 `TtsrCoordinator`。

### 回合开始

在 `turn_start` 时，流缓冲区被重置：

- `ttsrManager.resetBuffer()`

### 流进行中（`message_update`）

当助手更新到达且存在规则时：

- 监听 `text_delta`、`thinking_delta` 和 `toolcall_delta`
- 按来源或工具调用流键隔离缓冲区
- 如果当前工具暴露了逐文件 `matcherEntries`，则将每个文件作用域的缓冲区替换为其 digest 并调用 `checkSnapshot`；否则，在可用时使用单个 `matcherDigest` 快照，回退时通过 `checkDelta` 追加原始 delta
- 当 AST 规则存在时，对同一份重建的逐文件或单一快照运行 `checkAstSnapshot`；同一流键的连续相同快照会被跳过

`checkDelta()`/`checkSnapshot()` 遍历已注册规则，并返回所有通过 scope、全局路径 glob、正则条件和重复策略检查的匹配规则。`checkAstSnapshot()` 应用相同的 scope/路径/重复门控，根据候选文件路径推断语言，然后测试每个候选规则的 AST 模式。正则和 AST 匹配数组馈入相同的触发决策处理器。

## 3. 触发决策与立即中止路径

每条规则的 `interruptMode` 在存在时会覆盖全局设置：

- `always` 中断任何匹配的来源
- `prose-only` 仅中断 text/thinking 匹配
- `tool-only` 仅中断工具匹配
- `never` 从不中断

如果没有匹配规则触发中断，处理将遵循下文针对各来源的延迟路径。

当存在一条或多条匹配规则且至少有一条匹配规则允许中断时：

1. 匹配规则去重后存入协调器的待处理注入集合。
2. 设置 abort-pending 标志并创建 TTSR resume gate。
3. 立即调用 `agent.abort()`。对于工具匹配，中止原因会被限定为该工具调用 id，以便兄弟调用接收到独立的 `TTSR interrupt on another tool call` 原因。
4. 异步（fire-and-forget）发出 `ttsr_triggered`。
5. 通过 post-prompt 任务调度器调度重试工作，延迟 50ms，并标记当前 prompt generation 和一个重试 token。

中止不会被扩展回调阻塞。

## 4. 重试调度、contextMode 与提醒注入

在 50ms 超时之后，调度任务首先验证其重试 token、prompt generation、abort-pending 状态以及目标助手消息是否仍然是最新的。如果任何检查失败，它会清除待处理 TTSR 状态并解析 resume gate 而不重试。否则它会：

1. 清除 abort-pending 标志和逐工具提醒桶
2. 读取 `ttsrManager.getSettings().contextMode`
3. 如果 `contextMode === "discard"`，使用 `agent.replaceMessages(...slice(0, targetAssistantIndex))` 丢弃目标的部分助手输出
4. 使用 `ttsr-interrupt.md` 从待处理规则构建注入内容
5. 追加一条隐藏的运行时自定义消息，并持久化一条匹配的 `custom_message` 条目，包含 `customType: "ttsr-injection"` 和 `details.rules`
6. 通过 `ttsr_injection` 条目标记/持久化这些规则名称，并调用 `agent.continue()` 以重试生成

模板 payload 为：

```xml
<system-interrupt reason="rule_violation" rule="{{name}}" path="{{path}}">
...
:{{content}}
</system-interrupt>
```

待处理注入在内容生成之后被清除。

### `contextMode` 对部分输出的行为

- `discard`：部分/被中止的助手消息在重试前被移除。
- `keep`：部分助手输出保留在会话状态中；提醒会追加在其之后。

### 非中断匹配

非中断匹配按 `matchContext.source` 拆分：

- **`source === "tool"`（tool-source 匹配）**。规则被分桶到 `TtsrCoordinator.#perToolInjections`，以匹配的工具调用的 `id` 为键，并在内存中立即标记为已注入。**没有**延迟的后续回合，也不会中止流。当工具实际产生结果时，`afterToolCall` 钩子会在 `ctx.result.content` 之前前置一个渲染后的 `ttsr-tool-reminder.md` 块（在工具自身内容之前插入的单个 `text` 块），并持久化一个包含已使用规则名称的 `ttsr_injection` 条目。模板 payload 为：

  ```xml
  <system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
  ...
  {{content}}
  </system-reminder>
  ```

- **`source === "text"` / `"thinking"`（prose-source 匹配）**。规则在待处理注入中排队。在一次成功的、无错误、未被中止的助手消息之后，`TtsrCoordinator` 通过 `agent.followUp()` 将隐藏的 `ttsr-injection` 自定义消息排队，并在 1ms 后调度继续。这些延迟的非中断 prose 匹配不会发出 `ttsr_triggered`；该事件仅为实际的中断路径以及非中断的逐工具提醒发出。

在一个匹配批次内，每条规则恰好附加到一个兄弟工具调用：如果多个兄弟调用可以满足同一条规则，则第一个被认领的桶获胜。多个不同的规则仍然可以折叠到同一个工具调用上。

#### 对工具作者和转录阅读者的影响

- 工具自身的 `toolResult` 内容被原样保留；提醒作为额外的引导文本块被**前置**。假设 `content[0]` 是工具主要输出的渲染器必须扫描过去任何以 `<system-reminder reason="rule_violation"` 开头的块（或基于包装标签进行过滤），以找到真实的 payload。
- 提醒是工具结果的内联内容，而非独立的 `custom_message`/`ttsr-injection` 条目。查找 tool-source 规则上的非中断 TTSR 活动的转录阅读者必须检查工具结果（以及持久化的 `ttsr_injection` 条目列表），而不仅仅是合成的注入条目。
- 单个工具结果可以承载多个规则的提醒，这些提醒以渲染模板之间的空行连接。
- 如果助手消息在匹配的工具运行之前以 `stopReason === "aborted"` 或 `"error"` 结束，则待处理的逐工具桶会被清除，且不会持久化 `ttsr_injection` 条目。匹配时的内存注入记录**不会**回滚：在 `once` 模式下，它在会话重新加载之前一直保持被抑制；在 `after-gap` 模式下，在配置的已完成回合数之后它再次变得有资格触发。因为未送达的匹配未被持久化，重新加载也会使其再次有资格触发。

## 5. 重复策略与间隔逻辑

`TtsrManager` 跟踪 `#messageCount` 以及每条规则的 `lastInjectedAt`。

### `repeatMode: "once"`

一条规则在拥有注入记录之后只能触发一次。

### `repeatMode: "after-gap"`

一条规则仅在以下情况下可以重新触发：

- `messageCount - lastInjectedAt >= repeatGap`

`messageCount` 在 `turn_end` 时递增，因此间隔以已完成的回合而非流片段为单位度量。

## 6. 事件发出与扩展/钩子接口

### 会话事件

`AgentSessionEvent` 包含：

```ts
{ type: "ttsr_triggered"; rules: Rule[] }
```

### 扩展运行器

`#emitSessionEvent()` 将事件路由至：

- 扩展监听器（`ExtensionRunner.emit({ type: "ttsr_triggered", rules })`）
- 本地会话订阅者

### 钩子与自定义工具类型

- 扩展 API 暴露 `on("ttsr_triggered", ...)`
- 钩子 API 暴露 `on("ttsr_triggered", ...)`
- 自定义工具接收 `onSession({ reason: "ttsr_triggered", rules })`

### 交互模式渲染差异

交互模式使用 `session.isTtsrAbortPending` 来抑制在 TTSR 中断期间将中止的助手停止原因显示为可见错误，并在事件到达时渲染 `TtsrNotificationComponent`。

## 7. 持久化与恢复状态（当前实现）

`SessionManager` 持久化已注入的规则状态：

- 条目类型：`ttsr_injection`
- 追加 API：`appendTtsrInjection(ruleNames)`
- 查询 API：`getInjectedTtsrRules()`
- 上下文重建包含 `SessionContext.injectedTtsrRules`

`TtsrManager` 通过 `restoreInjected(ruleNames)` 支持恢复。

当前运行时连接：

- 中断注入会追加一条带有 `customType: "ttsr-injection"` 的隐藏 `custom_message`，并追加一个 `ttsr_injection` 条目
- 延迟的非中断 prose-source 注入在其排队的自定义消息到达 `message_end` 时被标记/持久化
- 非中断的 tool-source 匹配在分桶时在内存中标记，然后仅在匹配工具的结果产生后从 `afterToolCall` 持久化
- `createAgentSession()` 将 `existingSession.injectedTtsrRules` 恢复到管理器中

因此，注入规则的抑制从当前分支路径恢复。持久化存储名称而非原始回合年龄：`restoreInjected()` 将每条恢复的规则记录在消息计数零处。在 `repeatMode: "after-gap"` 下，恢复后的规则在重新开始计数的 `repeatGap` 个已完成回合后变得有资格触发，而与重新加载之前经过了多少回合无关。

## 8. 竞态边界与顺序保证

### 中止与重试回调

- 从 TTSR 处理器视角看，中止是同步的（立即调用 `agent.abort()`）
- 重试通过定时器延迟（`50ms`）
- 扩展通知是异步的，故意不在中止/重试调度之前 await

### 同一流窗口内的多次匹配

`checkDelta()` 返回该作用域缓冲区当前匹配的所有有资格规则。待处理注入在注入前按规则名称去重。

### 中止与继续之间

在定时器窗口期间，状态可能发生变化。重试受重试 token、prompt generation、中止状态和目标消息身份保护；过时的任务会清除待处理状态并解析其 gate。`agent.continue()` 失败会被捕获并同样解析该 gate。

## 9. 边界情况汇总

- 无效的 `condition` 正则：以警告跳过；其他条件/规则继续。
- 在能力层的重复规则名称：优先级较低的重复项在注册前被遮蔽。
- 在管理器层的重复名称：第二次注册被忽略。
- `ttsr.disabledRules`：列出的名称在 TTSR 注册之前被丢弃，且不会通过 always-apply/rulebook 桶暴露。
- `ttsr.builtinRules: false`：内嵌的 `builtin-defaults` 规则在 TTSR 注册之前被丢弃；用户/项目规则仍会加载。
- TTSR 规则上的 `globs` 要求至少有一个候选文件路径匹配其规范化路径或 basename。
- 默认 scope 监听文本和工具，不监听思考。
- `contextMode: "keep"`：部分违规输出可以在提醒重试之前保留在上下文中。
- `interruptMode: "never"`：prose-source 匹配会在成功的助手消息之后排队一个延迟的隐藏注入；tool-source 匹配通过 `afterToolCall` 钩子将一个内联的 `<system-reminder>` 折叠到匹配的工具调用的 `toolResult` 内容中（无流中中止，无独立的后续回合）。
- 当父助手消息以 `stopReason === "aborted"` 或 `"error"` 结束时，tool-source 非中断桶被清除。它们匹配时的内存抑制保持，直到重复策略允许再次触发（或重新加载丢弃未持久化的记录）。
- 重复-间隔依赖于 `turn_end` 处的回合计数递增；重新加载后，恢复的注入年龄重新从零开始。
