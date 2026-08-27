# `/handoff` 生成流水线

本文档描述编码代理如何实现 `/handoff`：触发路径、一次性生成、会话内压缩提交、持久化以及 UI 行为。

## 范围

涵盖：

- 交互式 `/handoff` 命令分发
- `AgentSession.handoff()` → `SessionMaintenance.handoff()` 生命周期
- `SessionHandoff.generateDocument(...)` 与 `generateHandoffFromContext(...)` 的请求形态及兼容性重试
- 交接文档如何作为压缩条目提交
- 成功、取消和失败时的 UI 行为

不涵盖：

- 通用的树导航/分支内部机制
- 会话命令（`/new`、`/fork`、`/resume`）

## 实现文件

- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`src/session/session-handoff.ts`](../packages/coding-agent/src/session/session-handoff.ts)
- [`src/session/session-maintenance.ts`](../packages/coding-agent/src/session/session-maintenance.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`packages/agent/src/compaction/compaction.ts`](../packages/agent/src/compaction/compaction.ts)
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)

## 触发路径

1. `/handoff` 在内置斜杠命令注册表中声明，可选内联提示 `[focus instructions]`。
2. 注册表的 TUI 处理器清空编辑器并调用 `handleHandoffCommand(customInstructions?)`。
3. `CommandController.handleHandoffCommand` 在当前响应流式传输时拒绝，然后统计 `type === "message"` 条目。
4. 如果数量 `< 2`，则发出警告 `Nothing to hand off (no messages yet)` 并返回。

同一最小内容守卫也存在于 `SessionMaintenance.handoff()` 内，并在违反时抛出。RPC 在流式传输期间会单独拒绝交接。直接 SDK 调用方必须避免在活动响应期间调用会话方法。

## 端到端生命周期

### 1) 准备提交

`AgentSession.handoff()` 委托给 `SessionMaintenance.handoff(customInstructions?, options?)`：

- 当手动或自动维护处于活动状态时抛出 `Compaction already in progress`，并取消任何后台的推测压缩。
- 读取当前分支，验证至少两条消息条目，并使用交接方法设置运行 `prepareCompaction(...)` 以计算 `firstKeptEntryId` 和 `tokensBefore`；空准备（例如刚压缩完后）会抛出 `Nothing to hand off (already compacted)`。

### 2) 生成文档

`SessionHandoff.generateDocument(customInstructions?, options?)` 负责生成与中止控制器（`isGeneratingHandoff`）：

- 需要选定模型以及该模型的 API key/resolver。
- 通过**与实时回合相同的旁路请求流水线**构建交接请求，与临时回合共享：
  1. 渲染交接提示（`renderHandoffPrompt(...)` 可选 focus，在密钥混淆之后）并将其作为代理归属的 `user` 消息追加到 `agent.state.messages` 的快照中。
  2. 使用 `convertMessagesToLlm(...)` 转换快照（会话 `transformContext`、LLM 转换和混淆）。
  3. 使用 `agent.buildSideRequestContext(llmMessages, baseSystemPrompt)` 构建 provider `Context`——归一化的工具和 provider-context 转换与循环一致。基础系统提示是固定的，因此提交的摘要不会继承每回合的 `before_agent_start` 覆盖。
  4. 使用实时 provider 缓存 key、唯一旁路 `sessionId`（`<sid>:side:<snowflake>`）、service tier/payload 钩子、`preferWebsockets: false`、`initiatorOverride: "agent"` 以及中止信号构建简单流选项。
- 混淆最终的 provider context 并通过宿主侧流传输调用 `generateHandoffFromContext(...)`。
- 对返回的交接文本进行去混淆。
- 对于具有 `compaction.handoffSaveToDisk` 的自动触发生成，在会话的 artifacts 目录下写入带时间戳的 `handoff-*.md` 制品。

`generateHandoffFromContext(...)` 位于 `packages/agent/src/compaction/compaction.ts` 中，紧邻摘要生成。它对调用方构建的 `Context` 发出 OTEL 仪表化的 `completeSimple` 等价一次性调用，使用钳制的压缩推理和 `toolChoice: "none"` 覆盖提供的流选项。

如果 provider 因仅支持自动工具选择而拒绝显式 `toolChoice: "none"`，则函数会使用 `toolChoice: "auto"` 重试一次。工具仍保留以兼容缓存前缀，但返回的工具调用块会被忽略；仅连接文本块。

```ts
await generateHandoffFromContext(context, model, {
  streamOptions,
  completeImpl,
  telemetry,
  thinkingLevel,
});
```

`generateHandoff(messages, …)` 仍向下游调用方导出。它从 `systemPrompt`、`tools` 和 `convertToLlm` 构造基本 context，然后委托给 `generateHandoffFromContext`；coding-agent 使用 context 感知函数，以便宿主转换、混淆、侧流路由和缓存 key 与实时回合匹配。

重要的生成属性：

- 请求共享实时 provider 缓存前缀，因为 `Context` 由与循环相同的转换 + 归一化流水线构建，并使用回合使用的相同 `promptCacheKey` 路由。
- 交接指令是尾随的 `user` 消息，而非开发者消息，因此缓存前缀与先前回合保持一致（尾随消息是唯一的分叉点）。
- `toolChoice: "none"` 防止在普通 provider 上有意派发工具；兼容性重试仅在显式工具选择被拒绝后才使用 `"auto"`。
- 返回的助手内容被过滤为文本块，并用 `\n` 连接；工具调用块被忽略。
- 兼容性重试后 `stopReason === "error"` 会抛出生成错误。

捕获直接来自一次性响应；不涉及代理循环事件或最新助手消息扫描。

### 3) 取消检查

显式用户取消抛出 `Error("Handoff cancelled")`。由 harness 发起的 abort 会保留提供的 reason，或在没有提供时显示 `Handoff aborted by session`。生成结果为空/仅空白的手动交接抛出 `Handoff generation produced no content`；自动交接返回 `undefined`，以便维护可以推进到下一个配置方法。

- 调用方信号中止交接控制器并转发其 reason
- `completeSimple(...)` 接收中止信号
- 直接 `abortHandoff()` 或无 reason 的调用方信号被规范化为 `Error("Handoff cancelled")`
- harness abort reason 和 provider 失败（包括 provider `AbortError`）按原样显示

`SessionHandoff.generateDocument()` 始终在 `finally` 中清除中止控制器。

### 4) 作为压缩条目提交

如果生成了文本且未被中止，`SessionMaintenance.handoff()` 在**当前**会话上提交文档：

1. 将文档包装为压缩摘要：`upsertFileOperations(document, readFiles, modifiedFiles, …)` 追加来自准备阶段文件操作的累积 `<files>` 标签；`{ readFiles, modifiedFiles }` 成为条目 `details`。
2. 追加常规 `CompactionEntry`（`appendCompaction(summary, undefined, firstKeptEntryId, tokensBefore, details, false, undefined)`）。
3. 重建显示 context，替换实时代理消息，重新锚定统计（`rebaseAfterCompaction`），重置 plan 引用、advisor 运行时（`"handoff"`）和 todo 阶段，并关闭其历史被重写的 provider 会话。
4. 发出 `session_compact` 扩展钩子及已保存条目。
5. 返回 `{ document, savedPath? }`。

会话 id、会话文件、转录回滚和 provider 提示缓存 key 均未更改。来自 `firstKeptEntryId` 起的最近历史按原样保留，与其他压缩方法完全相同；只有摘要前缀被文档替换。

### 自动交接

无论上下文维护方法顺序如何，手动 `/handoff` 均可工作。要自动使用此流水线，请在 `compaction.methodOrder` 中包含 `handoff`（默认顺序为 `remote`、`snapcompact`、`handoff`、`shake`、`soft`）。正常的阈值触发交接将文档生成推迟到 post-prompt 任务；pre-prompt、mid-turn 和 `incomplete` 恢复则内联运行。输入 `overflow` 跳过交接生成，因为请求会携带相同的过大输入——但已在准备的推测交接结果在 overflow 恢复期间仍可应用。

异步压缩（`compaction.asyncEnabled`）也可以在 pre-threshold 带中推测生成交接文档，并在跨过阈值时立即提交；参见 `docs/compaction.md`。

如果自动生成未返回文档，则维护推进到下一个配置方法。`compaction.handoffSaveToDisk` 默认为 `false`；启用时，仅自动触发的交接会写入额外的 markdown 制品。

## 控制器/UI 行为

`CommandController.handleHandoffCommand` 行为：

- 当 `session.isStreaming` 时拒绝并发出警告（与 `/fork` 和 `/move` 行为一致）——用户必须完成或中止响应后才能交接。
- 显示状态加载器：`Generating handoff… (esc to cancel)`。
- 调用 `await session.handoff(customInstructions)`。
- 如果结果为 `undefined`：`showError("Handoff cancelled")`。
- 成功时：
  - 清除瞬态会话 UI 并重新渲染会话，此时会显示交接压缩分隔线
  - 失效状态行和编辑器边框
  - 重新加载 todos
  - 追加 `Context handed off and compacted in place`
  - 当结果包含 `savedPath` 时显示（手动 `/handoff` 通常没有）
- 异常时：
  - 如果 message 为 `"Handoff cancelled"`：`showError("Handoff cancelled")`
  - 否则：记录错误并调用 `showError("Handoff failed: <message>")`
- 在结束时停止加载器，清除状态容器，并请求渲染。

手动 `/handoff` 不会将生成的文档流式传输到聊天中。一次性请求运行期间会保持可取消的加载器可见，聊天在提交完成后重建。

## 取消语义

### 会话级取消原语

`AgentSession` 暴露：

- `abortHandoff()` → 中止生成控制器
- `isGeneratingHandoff` → 生成进行中时为 true

直接 `abortHandoff()` 将无 reason 的中止信号传递给 `completeSimple(...)`；生成将其规范化为 `Error("Handoff cancelled")`，命令控制器将其映射到取消 UI。`AgentSession.abort(...)` 则首先以其 harness reason（或 `Handoff aborted by session`）中止交接，因此后续压缩取消不能将该失败掩盖为用户取消。

### 交互式 `/handoff` 路径

`InputController` 的全局 `editor.onEscape` 处理器根据实时会话状态进行分派，而不是交换处理器：当 `isGeneratingHandoff` 为 true 时，按 Escape 调用 `session.abortHandoff()`，中止 `completeSimple(...)` 请求。

## 中止与失败的交接

当前 UI 分类：

- **中止/已取消**
  - 直接 `abortHandoff()`（交互式 Esc）触发 `"Handoff cancelled"`
  - 无 reason 的调用方信号也会触发 `"Handoff cancelled"`
  - UI 显示 `Handoff cancelled`
- **失败**
  - harness abort reason、空的手动生成或任何抛出的 provider 错误
  - UI 记录错误并显示 `Handoff failed: ...`

手动路径上的空生成会抛出；自动交接仅为其下一方法回退返回 `undefined`。

## 短会话和最小内容守卫

两个守卫防止低信号交接：

- UI 层（`handleHandoffCommand`）：对于 `< 2` 条消息条目，提前警告并返回
- 会话层（`SessionMaintenance.handoff()`）：将相同条件作为错误抛出

## 状态转换总结

高层状态流：

1. 由内置注册表分发的交互式斜杠命令。
2. 流式传输和消息计数预检守卫。
3. `prepareCompaction(...)` 计算切割点（`firstKeptEntryId`、`tokensBefore`）。
4. 创建生成控制器（`isGeneratingHandoff = true`）；`generateHandoffFromContext(...)` 发送一个缓存对齐的旁路请求，必要时进行一次 `"auto"` 工具选择兼容性重试。
5. 连接助手文本块；丢弃工具调用块；在本地恢复密钥占位符。
6. 如果缺少文本 → 手动抛出 / 自动返回 `undefined`；如果中止 → 取消错误。
7. 如果存在：追加 `CompactionEntry`，重建代理 context，重置 plan/advisor/todo 运行时状态，关闭被重写的 provider 会话，发出 `session_compact`。
8. 控制器重建聊天 UI 并宣布成功。
9. 生成控制器在 `finally` 中清除。

## 已知假设和限制

- 没有结构验证检查生成的 markdown 是否遵循所请求的章节格式。
- 手动交接没有流式可见性；显示可取消的加载器直到 UI 更新。
- 自动触发的制品写入失败会被记录，但不会导致交接失败。
- 由旧版本创建的会话可能仍包含来自先前新会话流水线的 `custom_message` 条目及 `customType: "handoff"`；它们按原样渲染并参与上下文。
