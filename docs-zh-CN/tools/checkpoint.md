# checkpoint

> 标记当前顶层对话状态，以便后续的 `rewind` 可以将探索性上下文折叠为一份报告。

## 源码
- 入口：`packages/coding-agent/src/tools/checkpoint.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/checkpoint.md`
- 关键协作者：
  - `packages/coding-agent/src/session/agent-session.ts` — 在工具成功执行后捕获活跃的检查点。
  - `packages/coding-agent/src/session/session-manager.ts` — 持久化常规的会话条目流；而不是活跃的检查点标记。
  - `packages/coding-agent/src/tools/index.ts` — 注册该工具，并以 `checkpoint.enabled` 作为门槛控制其启用。
  - `packages/coding-agent/src/config/settings-schema.ts` — 定义默认禁用的特性开关。

## 注册 / 可见性
- 工具元数据：`approval = "read"`、`strict = true`、`loadMode = "discoverable"`。执行是单次的；该工具不会以进度更新的形式流式输出。
- 注册要求 `checkpoint.enabled = true`（默认 `false`）。
- 启用时，顶层会话会获得该工具。子代理默认不会发现它，但可以通过显式的 `tools:`/requested-tools 列表获得。
- `checkpoint` 和 `rewind` 是一对安全工具：在特性启用时，显式请求其中任意一个名称，注册都会自动包含另一个。
- 在普通的 `tools.xdev` 会话中，可发现的内置工具可能会以 `xd://checkpoint` 的形式呈现；显式请求的工具仍保持顶层形式。

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `goal` | `string` | 是 | 调查目标。schema 要求该项必填，并在工具结果中原样回显；实现不会对其执行 trim，也不会拒绝空字符串。 |

## 输出
该工具返回单个文本结果以及结构化的 `details`：

- 文本正文：
  - `Checkpoint created.`
  - `Goal: <goal>`
  - `Run your investigation, then call rewind with a concise report.`
- `details`：
  - `goal: string`
  - `startedAt: string` — 在 `CheckpointTool.execute()` 内创建的 ISO 时间戳

不会返回检查点 ID、artifact URI、作业句柄、文件路径或恢复令牌。

## 流程
1. `packages/coding-agent/src/tools/index.ts` 中的工具注册强制实施 `checkpoint.enabled` 以及顶层/显式子代理的可见性规则。`CheckpointTool.createIf()` 本身总是会构造该工具。
2. 当 `session.getCheckpointState?.()` 已被设置时，`CheckpointTool.execute()` 会以 `ToolError("Checkpoint already active.")` 拒绝嵌套的检查点。
3. 它创建 `startedAt = new Date().toISOString()` 并返回常规的 `toolResult()` 载荷。该工具方法本身不会改动检查点状态。
4. 在之后检查点工具结果成功的事件上，`AgentSession` 会捕获三个运行时字段：
   - `checkpointMessageCount` — 当前的 `agent.state.messages.length`，此时检查点工具结果已经被追加
   - `checkpointEntryId` — `sessionManager.getEntries().at(-1)?.id ?? null`，即检查点时刻最后一条已持久化的会话条目 ID
   - `startedAt` — 从工具 details 复制而来，或重新生成
5. `AgentSession` 将该对象存入 `#checkpointState`，清除 `#pendingRewindReport`，并清除先前的 `#lastCompletedRewind`。
6. 在恢复、会话切换或会话树导航时，`#rehydrateCheckpointRewindState()` 会扫描当前已持久化的分支。最近一次成功、且其后没有保留的 rewind 报告的检查点，会重建活跃检查点的边界与守卫。

## 副作用
- 会话状态（对话记录、内存、任务、检查点、注册表）
  - 在内存中设置 `AgentSession.#checkpointState`。
  - 将检查点边界记录为消息计数加上已持久化的检查点工具结果条目 ID。
  - 常规的成功工具结果条目就足以在恢复后重建未完成的检查点；不存在单独的检查点标记条目。
  - 启用随后的 settle 守卫：如果存在活跃检查点且没有待处理的 rewind 报告，`#enforceRewindBeforeYield()` 会注入一条 developer 角色的警告，并安排另一个轮次。
- 用户可见的提示词 / 交互式 UI
  - 工具结果会告诉模型在调查结束后调用 `rewind`。
  - 如果代理先尝试 `yield`，`AgentSession` 会注入：

```text
<system-warning>
You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.
</system-warning>
```

## 限制与上限
- 可用性由 `checkpoint.enabled` 控制，默认 `false`。
- 每个会话或子代理只允许存在一个活跃检查点。
- 子代理需要显式的 requested-tools 条目；请求任意一个检查点工具都会自动包含它的姊妹工具。
- 检查点状态不会作为专用条目持久化。它由活跃分支上成功的检查点工具结果条目重建，包括在进程恢复之后。
- 会话持久化适用于常规的检查点工具调用/结果消息。全局会话持久化截断阈值为 `packages/coding-agent/src/session/session-persistence.ts` 中的 `MAX_PERSIST_CHARS = 500_000`。

## 错误
- `ToolError("Checkpoint already active.")` — 当先前的检查点尚未被 rewind 或清除时抛出。
- 工具主体没有局部的 `try/catch`；意外异常会向外传播。

## 备注
- 尽管摘要字符串为 `Create a git-based checkpoint to save and restore session state`，该实现并不调用 git，也不会对文件系统状态做快照。
- 捕获的状态仅为对话/会话元数据：
  - 内存中的消息计数
  - 会话树中已持久化的检查点工具结果条目 ID
  - 时间戳
- 不捕获：
  - 工作树内容或已暂存的变更
  - artifact 或 blob-store 内容
  - 来自 `packages/coding-agent/src/session/history-storage.ts` 的 SQLite 提示词历史行
  - 来自 `packages/coding-agent/src/session/agent-storage.ts` 的认证或代理记录
