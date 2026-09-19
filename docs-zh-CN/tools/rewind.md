# rewind

> 通过裁剪探索性上下文并保留一份精炼报告，来结束一个活跃的检查点。

## 源码
- 入口：`packages/coding-agent/src/tools/checkpoint.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/rewind.md`
- 关键协作者：
  - `packages/coding-agent/src/session/agent-session.ts` — 校验待处理的 rewind 状态、执行实际的 rewind，并注入保留的报告。
  - `packages/coding-agent/src/session/session-manager.ts` — 为已持久化的会话树创建分支，并追加持久化的 summary/report 条目。
  - `packages/coding-agent/src/session/session-context.ts` — `buildSessionContext()` 在重建上下文时，将持久化的 `branch_summary` 条目转换为 LLM 可见的 `branchSummary` 消息。
  - `packages/coding-agent/src/tools/index.ts` — 注册该工具，并共用 `checkpoint.enabled` 开关。

## 注册 / 可见性
- 工具元数据：`approval = "read"`、`strict = true`、`loadMode = "discoverable"`。执行是单次的；rewind 副作用会被延后应用，而不是作为进度更新流式输出。
- 注册要求 `checkpoint.enabled = true`（默认 `false`）。
- 启用后，顶层会话会收到该工具。子代理默认不会发现它，但可以通过显式的 `tools:`/requested-tools 列表收到它。
- `checkpoint` 和 `rewind` 是一对安全工具：在特性启用时显式请求其中任意一个，都会自动包含另一个。
- 在普通的 `tools.xdev` 会话中，可发现的内置工具可能以 `xd://rewind` 的形式呈现；显式请求的工具仍保持在顶层。

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `report` | `string` | 是 | 调查发现。`execute()` 会先对其 trim，并拒绝 trim 后为空的结果。 |

## 输出
该工具返回单个文本结果，外加结构化详情：

- 文本正文：
  - `Rewind requested.`
  - `Report captured for context replacement.`
- `details`：
  - `report: string` — trim 后的报告文本
  - `rewound: true`

返回的工具结果并不是最终的 rewind。`AgentSession` 会等到 `turn_end`，然后异步应用 rewind 副作用。

## 流程
1. `packages/coding-agent/src/tools/index.ts` 中的工具注册会强制检查 `checkpoint.enabled` 以及顶层/显式子代理可见性规则。`RewindTool.createIf()` 本身总是会构造该工具。
2. 没有活跃检查点时，`execute()` 会区分两种状态：
   - 存在一份保留的已完成 rewind：`ToolError("Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.")`
   - 不存在已完成的 rewind：`ToolError("No active checkpoint. Create a checkpoint before calling rewind.")`
3. 它会对 `params.report` 执行 trim；若为空，则抛出 `ToolError("Report cannot be empty.")`。
4. 它返回一个 `toolResult()`，其中带有 `details.report`，并将 `details.rewound = true`。
5. 在 rewind 工具结果成功时，`AgentSession` 会从 `details.report` 或第一个文本内容块中提取报告，并存入 `#pendingRewindReport`。
6. 在 `turn_end` 时，`#extractRewindReport()` 会找到待处理或已成功的 rewind 结果，并调用 `#applyRewind()`。
7. `#applyRewind()` 首先调用 `sessionManager.branchWithSummary(checkpointEntryId, report, { startedAt })`，在检查点分支点记录一条 `branch_summary`。如果该条目不再能解析，它会记录一条警告，改为从 root 创建分支。
8. 它追加一条隐藏的、被持久化的 `rewind-report` 自定义消息。其内容由 `prompts/system/rewind-report.md` 渲染而来：它会告知下一轮检查点已经完成、不要再调用 `rewind`，并附上这份报告；details 中包含 `{ report, startedAt, rewoundAt }`。
9. 它设置 `#lastCompletedRewind`，从新的活跃分支重建显示/LLM 会话上下文，并同时替换本轮活跃的消息数组和 `agent.state.messages`。因此，探索性分支和成功的 rewind 工具结果都不会出现在下一次 provider 调用中。
10. 它会重置 advisor 会话状态（同时保留成本），从新分支同步 todo 状态，并关闭那些历史被改写的 provider 会话。
11. 最后它会清除 `#checkpointState` 和 `#pendingRewindReport`。在之后的恢复或树导航中，持久化的保留报告会重新水合 `#lastCompletedRewind`。

## 模式 / 变体
- 普通 rewind：检查点条目存在；会话历史从该确切条目开始分支。
- 回退 rewind：当前会话树中缺少检查点条目 ID；rewind 从 root 创建分支并记录一条警告。
- 延后的 turn-end 应用：工具结果只是请求 rewind；分支与上下文替换发生在周围的 assistant 轮次结束之后。
- 恢复的检查点：活跃已持久化分支上一个尚未完成但成功的检查点工具结果会重新水合检查点状态，使进程恢复后仍可执行 rewind。

## 副作用
- 会话状态（转录、记忆、任务、检查点、注册表）
  - 从检查点分支加上保留的 summary/report 重建活跃对话历史；它不会恢复文件或进程状态。
  - 添加一条隐藏的自定义消息 `rewind-report`，其中携带渲染后的恢复指引和该报告。
  - 记录 `#lastCompletedRewind`，清除活跃检查点与待处理报告，重置 advisor，重新同步 todo 状态，并关闭因历史改写而失效的 provider 会话。
  - 把持久化的会话 leaf 重新定位到检查点分支点，并追加新的会话条目。
- 文件系统
  - 通过常规的 `SessionManager` 追加持久化，把新的 `branch_summary` 和 `custom_message` 条目持久化到会话 `.jsonl` 文件中。
  - 会话文件在会话目录中命名为 `<ISO-timestamp-with-:-and-.-replaced>_<uuidv7>.jsonl`；未传入覆盖项时，默认目录选择为 `~/.omp/agent/sessions/<encoded-cwd>/`。
- 用户可见的提示词 / 交互式 UI
  - 在 turn-end 应用之前，工具结果可见。
  - 当上下文被重建时，持久化的 `branch_summary` 成为 LLM 可见的 `branchSummary` 消息；压缩渲染会把它呈现为 user 角色的 `<summary>` 块。
  - 隐藏的 `rewind-report` 自定义消息会成为下一次 provider 调用的 developer 角色保留指引。
- 后台工作 / 取消
  - rewind 应用被延后到 `turn_end`。不存在单独的 job 对象或取消句柄。

## 限制与上限
- 可用性受 `checkpoint.enabled` 开关控制，默认为 `false`。
- 子代理需要显式的 requested-tools 条目；请求任意一个检查点工具都会自动包含与之配对的那一个。
- 一个会话最多只有一个活跃检查点；没有办法命名或在多个检查点之间做选择。
- 报告文本在 `trim()` 之后必须非空。
- rewind 只恢复活跃对话/会话树上下文；不存在文件、产物、blob、进程或 git 的恢复路径。
- 持久化的报告/summary 内容受全局会话持久化上限 `MAX_PERSIST_CHARS = 500_000` 约束。

## 错误
- `ToolError("Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.")` — 当活跃分支中已包含保留的完成记录时抛出。
- `ToolError("No active checkpoint. Create a checkpoint before calling rewind.")` — 当既没有活跃检查点也没有已完成的 rewind 时抛出。
- `ToolError("Report cannot be empty.")` — 当 trim 后的报告为空时抛出。
- 应用期间缺少检查点条目 ID 不会使已完成的工具调用失败；`#applyRewind()` 会记录 `Rewind branch checkpoint missing, falling back to root`，并从 root 创建分支。

## 备注
- 检查点选择是隐式的。`rewind` 始终指向单个 `#checkpointState`——它来自最后一次未完成且成功的 `checkpoint` 的捕获或重新水合；不存在检查点列表、标签或 ID 参数。
- 被恢复的状态是活跃对话/会话树上下文：
  - 持久化分支被重置到 `checkpointEntryId` 或 root 回退
  - 被放弃的探索路径的分支摘要
  - 保留的 `rewind-report` 自定义消息
  - 从该分支重建的内存中消息
- 不恢复：
  - 文件系统或 git 状态
  - `packages/coding-agent/src/session/artifacts.ts` 下的产物
  - `packages/coding-agent/src/session/blob-store.ts` 下的 blob 存储有效载荷
  - `packages/coding-agent/src/session/history-storage.ts` 中的提示词历史行
  - `packages/coding-agent/src/session/agent-storage.ts` 中的 auth 或其他 agent 存储
- 不存在并发编辑的协调。rewind 既不会合并、也不会回滚代码或会话相邻的外部状态。
- rewind 不会破坏已持久化的会话历史。`branchWithSummary()` 会追加一条新的 `branch_summary` 条目并移动 leaf；被放弃的条目仍留在 `.jsonl` 日志中，但会离开活跃分支。
