# todo

> 对会话 todo 列表应用一次变更,并返回文本摘要以及完整的 phase/task 状态。

## 来源
- 入口:`packages/coding-agent/src/tools/todo.ts`
- 模型侧提示:`packages/coding-agent/src/prompts/tools/todo.md`
- 主要协作者:
  - `packages/coding-agent/src/tools/index.ts` — 注册工具、暴露会话钩子、控制可用性。
  - `packages/coding-agent/src/modes/controllers/event-controller.ts` — 工具完成后更新可见的 todo UI。
  - `packages/coding-agent/src/session/agent-session.ts` — 存储缓存的 phase、在会话恢复时移除已完成/已丢弃的任务、发出失败提醒。
  - `packages/coding-agent/src/modes/controllers/todo-command-controller.ts` — `/todo` 命令路径、自定义条目持久化、转录提醒注入。
  - `packages/coding-agent/src/tools/render-utils.ts` — 渲染器树的折叠预览上限。

## 输入

params 对象**就是**单个 op —— 判别字段及其属性位于顶层(没有 `ops` 数组包装)。

| Op | 必填字段 | 可选字段 | 效果 |
| --- | --- | --- | --- |
| `init` | `list` **或** 扁平的 `items` | `phase`(为扁平 `items` 形式命名 phase;默认为 `Tasks`) | 替换整个列表 —— 使用 `list` 时,采用给定的 phase;使用扁平 `items` 数组时,合成一个 phase。每个新任务在规范化前都以 `pending` 状态开始。 |
| `start` | `task` | 无 | 将一个任务标记为 `in_progress`;其他任何 `in_progress` 任务会被降级为 `pending`。 |
| `done` | `task` 或 `phase` 或两者皆无 | 无 | 将目标任务、目标 phase 或所有任务标记为 `completed`。 |
| `drop` | `task` 或 `phase` 或两者皆无 | 无 | 将目标任务、目标 phase 或所有任务标记为 `abandoned`。 |
| `block` | `task` 或 `phase` | `reason` | 将可操作的目标任务标记为 `blocked`;已完成/已丢弃的任务保持关闭状态。`reason` 中的空白会被合并为一行。 |
| `unblock` | `task` 或 `phase` | 无 | 将被阻塞的目标任务恢复为 `pending` 并清除其阻塞原因。 |
| `rm` | `task` 或 `phase` 或两者皆无 | 无 | 移除目标任务、清空该 phase 的任务列表,或清空所有任务列表。 |
| `append` | `phase`、`items` | 无 | 向 phase 追加新的 `pending` 任务;若 phase 不存在则创建。 |
| `view` | 无 | 无 | 回显当前列表。`view` 调用是只读的:不进行规范化,不写入状态。 |

### 字段

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `op` | `"init" \| "start" \| "done" \| "rm" \| "drop" \| "block" \| "unblock" \| "append" \| "view"` | schema 中必填 | 操作判别符。执行时,仅在无歧义的 `list`/`items` 负载下才会补全缺失的 op(见 Flow)。 |
| `list` | `{ phase: string; items: string[] }[]` | 用于 `init`(除非给出扁平 `items` 列表) | 完整替换负载。每个 `items` 数组具有 `minItems: 1`。 |
| `task` | `string` | 用于 `start`;用于针对任务的 `done`/`drop`/`block`/`unblock`/`rm` | 精确匹配任务内容。 |
| `phase` | `string` | 用于 `append`;用于针对 phase 的 `done`/`drop`/`block`/`unblock`/`rm`;扁平 `init` 时可选 | 精确匹配 phase 名称,但 `append` 会惰性创建缺失的 phase,扁平 `init` 会合成一个(默认为 `Tasks`)。 |
| `items` | `string[]` | 用于 `append`;或作为扁平 `init` 负载 | 要追加的任务,或扁平 `init` 的完整任务列表。特定 op 的验证要求至少一项;不相关 op 上的多余空数组在 schema 上合法但会被忽略。 |
| `reason` | `string` | 否 | `block` 的可选阻塞原因;规范化为单行去除首尾空白的形式。 |

## 输出
该工具返回单次调用的 `AgentToolResult`:

- `content`:一个文本部分,包含来自 `formatSummary(...)` 的摘要。
  - 无错误的空最终状态:`Todo list cleared.`(纯 `view` 调用时为 `Todo list is empty.`)。
  - 非空最终状态:剩余项目列表、当前 phase 进度,然后是按 phase 的树形结构。
  - 如果 op 产生验证/运行时错误,摘要以 `Errors: ...` 开头,结果被标记为 `isError: true`;变更被丢弃 —— 返回和持久化的状态保持在调用前的列表。
- `details`:
  - `phases: TodoPhase[]`
  - `storage: "session" | "memory"`
  - `completedTasks?: TodoCompletionTransition[]` 当任务在调用期间从非完成状态变为 `completed` 时
  - `op?: TodoOperation` 标识已解析的操作,包括后来产生特定 op 错误的变更;在 schema 验证失败和旧版转录条目中不存在。

`TodoPhase` / `TodoItem` 状态模型:

- `TodoPhase`:`{ name: string, tasks: TodoItem[] }`
- `TodoItem`:`{ content: string, status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked", blocker?: string }`

TUI 渲染器(`todoToolRenderer`)将调用和结果合并为一个转录块,并将 phase 渲染为树形结构。折叠转录预览将树项数限制为 `PREVIEW_LIMITS.COLLAPSED_ITEMS`(`8`)。

## 流程
1. `TodoTool.execute(...)` 从 `session.getTodoPhases?.() ?? []` 克隆当前缓存的 phase(`packages/coding-agent/src/tools/todo.ts`)。
2. `resolveTodoParams(...)` 验证原始的单一 op 负载。由于该工具启用了 `lenientArgValidation`,仅在形状无歧义时才可能补全缺失的 `op`:非空 `list` 意味着 `init`;非空 `items` 加上 `phase` 意味着 `append`;单独的非空 `items` 仅在没有 phase 存在时才意味着 `init`。模糊的目标字段和所有其他 schema 失败返回 `Invalid todo arguments: ...`。
3. `applyParams(...)` 通过 `applyEntry(...)` 应用已解析的 op。
4. 每个 op 修改工作中的 phase 数组:
   - `initPhases(...)` 从头开始重建列表。
   - `start` 通过精确的 `content` 解析任务,将所有其他 `in_progress` 任务降级为 `pending`,然后将目标标记为 `in_progress`。
   - `done` / `drop` 使用 `getTaskTargets(...)` 来定位一个任务、一个 phase 或每个任务。
   - `block` 需要任务或 phase 目标。它仅将 `pending`、`in_progress` 或已经是 `blocked` 的目标标记为阻塞,保留已完成/已丢弃的任务;重复的 block 可以替换或清除原因。
   - `unblock` 需要任务或 phase 目标,仅将阻塞目标更改为 `pending`。
   - `rm` 移除一个任务、清空一个 phase 的 `tasks`,或清空所有 phase 的任务数组。
   - `appendItems(...)` 解析或创建目标 phase,并推送新的 `pending` 任务,除非任何地方已经存在相同的任务内容。
5. 缺失的任务/phase 引用和特定 op 的失败记录在 `errors` 数组中;任何错误都会在最后丢弃该 op 的变更。
6. 成功变更后,`normalizeInProgressTask(...)` 强制执行单活跃任务不变量:
   - 如果多个任务为 `in_progress`,只有第一个保持活跃,其余变为 `pending`;
   - 如果没有任务为 `in_progress`,则按 phase/task 顺序将第一个 `pending` 任务自动提升为 `in_progress`;
   - 被阻塞的任务会被跳过,因此当所有未完成的工作都被阻塞时,列表可能没有活跃任务。
7. `execute(...)` 仅在 op 没有错误且不是 `view` 时,通过 `session.setTodoPhases?.(...)` 存储更新后的 phase;失败的 op 会被丢弃。当 `session.getSessionFile()` 存在时,`storage` 为 `"session"`,否则为 `"memory"`。
8. `getCompletionTransitions(...)` 比较之前和更新后的 phase(失败的或 `view` 调用会跳过);新完成的任务在 `details.completedTasks` 中返回。
9. 详情包括成功时或特定 op 失败时已解析的 `op`,包括从省略输入推断的 op。无法通过 schema 验证的负载在 op 可用之前返回。
10. 代理运行时在 `packages/coding-agent/src/session/agent-session.ts` 中监视 `todo` 工具结果;成功的结果会刷新缓存的 todos,失败的结果会注入一个隐藏的下轮提醒,告诉模型在重试之前 todo 进度不可见。
11. 事件控制器在成功时根据 `result.details.phases` 更新可见的 todo UI,或在出错时显示警告(`packages/coding-agent/src/modes/controllers/event-controller.ts`)。

## 模式 / 变体
### 状态转换

| 当前状态 | `start` | `done` | `drop` | `block` | `unblock` | `rm` | `append` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `pending` | 目标变为 `in_progress` | `completed` | `abandoned` | `blocked` | 无变化 | 移除 | 新任务以 `pending` 状态进入 |
| `in_progress` | 目标保持 `in_progress`;非目标的活跃任务变为 `pending` | `completed` | `abandoned` | `blocked` | 无变化 | 移除 | 状态无变化 |
| `blocked` | 若为目标可设为 `in_progress` | `completed` | `abandoned` | 保持阻塞;原因可更改 | `pending`,原因被清除 | 移除 | 状态无变化 |
| `completed` | 若为目标可设回 `in_progress` | 保持 `completed` | 若为目标则变为 `abandoned` | 无变化 | 无变化 | 移除 | 状态无变化 |
| `abandoned` | 若为目标可设回 `in_progress` | 若为目标则变为 `completed` | 保持 `abandoned` | 无变化 | 无变化 | 移除 | 状态无变化 |

规范化随后在 op 运行后重新应用单活跃任务规则。

### Op 目标定位规则
- `done`、`drop`、`rm`:
  - 设置 `task`:影响一个内容精确匹配的任务。
  - 否则设置 `phase`:影响该精确名称 phase 中的每个任务。
  - 否则:影响每个 phase 中的每个任务。
- `block` 和 `unblock` 使用相同的任务或 phase 查找,但拒绝省略的目标。
- `append` 是唯一会创建缺失 phase 的 op。
- `init` 完全丢弃之前的 phase。

### Markdown 往返辅助函数
同一文件还暴露了 `/todo` 使用的非工具辅助函数:
- `phasesToMarkdown(...)` 将 phase 序列化为标题加复选框列表项(`[ ]`、`[/]`、`[x]`、`[-]`、`[!]`)。阻塞原因保留在末尾的 `<!-- blocker: ... -->` 注释中。
- `markdownToPhases(...)` 解析该格式,将孤立任务默认为 `Todos` phase,也接受 `>` 作为 `in_progress`、`~` 作为 `abandoned`,恢复阻塞原因,并运行相同的规范化步骤。

## 副作用
- 文件系统
  - 工具本身不涉及。
- 会话状态(转录、内存、作业、检查点、注册表)
  - 通过 `setTodoPhases` 修改会话 todo 缓存。
  - `storage` 报告会话是否有后备会话文件,但工具本身不会附加自定义会话条目。
  - 成功的工具结果消息携带 `details.phases`;`getLatestTodoPhasesFromEntries(...)` 稍后可以从这些转录条目重建状态。
  - 失败的 `todo` 结果会使 `agent-session` 排队一个隐藏的下轮提醒(`customType: "todo-error-reminder"`)。
- 用户可见的提示 / 交互式 UI
  - 转录块由 `todoToolRenderer` 渲染并与调用行合并。
  - `event-controller` 根据成功结果更新可见的 todo 面板。
  - 出错时,`event-controller` 显示 `Todo update failed...`;可见面板在后续成功调用之前可能保持陈旧。
  - `/todo expand` 在 sticky HUD 中显示每个 phase 和任务;`/todo collapse` 恢复其有界预览。两者都仅用于显示,不会改变 todo 状态。
- 后台工作 / 取消
  - 会话级别的 `completed`/`abandoned` 任务自动清除已被移除(计时器在工具调用之间修改规范的 phase);TUI todo 小部件在 `tasks.todoClearDelay` 后仍会清除已关闭的条目(仅显示,`packages/coding-agent/src/modes/interactive-mode.ts`)。

## 限制与上限
- `init.list`:适用于单个 op(`todoSchema`)。params 对象正好携带一个 op。
- `init.list[*].items`:schema 级别 `minItems: 1`。
- 扁平的 `init.items` 和 `append.items`:共享的 schema 允许任何数组长度,但特定 op 的执行会拒绝缺失/空的列表。
- 渲染器折叠预览:`PREVIEW_LIMITS.COLLAPSED_ITEMS = 8`(`packages/coding-agent/src/tools/render-utils.ts`)。
- 执行时补全:仅针对上述无歧义的负载推断省略的 `op`;schema 本身仍然要求 `op`。
- 自动清除延迟:`tasks.todoClearDelay` 默认为 `60` 秒;`< 0` 禁用自动清除,`0` 立即清除。仅显示 —— 由 TUI 小部件应用(`packages/coding-agent/src/modes/interactive-mode.ts`);该设置在会话级别无效。
- 工具执行模式:`concurrency = "exclusive"`,`strict = true`,`loadMode = "discoverable"`。

## 错误
- 普通的错误 op 负载作为人类可读字符串累积在 `errors` 中;结果被标记为 `isError: true`,变更被丢弃 —— 返回和持久化的状态保持在调用前的列表。
- 错误字符串来自 `packages/coding-agent/src/tools/todo.ts` 中的辅助函数,包括:
  - `Missing list for init operation`
  - `Missing task content`
  - `Duplicate phase "..." in init list` / `Duplicate task "..." in init list`
  - `Task "..." not found` 在适用时带有额外的空列表提示,或者当缺失内容看起来像 ID 时提示任务通过内容(而非 `task-N` ID)引用
  - `Missing phase name`
  - `Phase "..." not found`
  - `Missing phase name for append operation`
  - `block requires a task or phase target`
  - `unblock requires a task or phase target`
  - `Missing items for append operation`
  - `Task "..." already exists`
- `todo` 调用携带单个 op;其中的任何错误都会丢弃该 op 所做的所有变更。
- 运行时级别的工具失败在工具主体之外处理:`agent-session` 注入隐藏的提醒,事件控制器警告用户可见的进度可能已过时。
- 幂等性因 op 而异:
  - `init` 是完全替换;重放相同负载会产生相同状态。
  - `start`、`done`、`drop`、`block` 和 `unblock` 在现有目标状态上实际上是幂等的,尽管 `start` 还会降级另一个活跃任务,重复的 `block` 可以更新其原因。
  - `rm` 对于有目标的删除不是幂等的:第二次调用会出错,因为任务或 phase 已不存在。
  - `append` 不是幂等的:重复的任务内容会被 `Task "..." already exists` 拒绝;`append` op 会预先验证,因此包含任何重复项的 op 不会追加任何内容。

## 备注
- 任务查找在工具内是精确的字符串相等比较。模型侧提示指出任务内容和 phase 名称是标识符,应保持唯一;`append` 全局强制任务唯一性,`init` 拒绝其负载中重复的 phase 名称和重复的任务内容。
- `findTaskByContent(...)` 返回跨 phase 的第一个匹配任务。重复的任务内容会使后续有目标的 op 产生歧义。
- `normalizeInProgressTask(...)` 在 op 之后运行一次,而非 op 期间。单个 op(例如 `init`)可以构建中间的无效状态并依赖最终规范化。
- `storage: "session"` 意味着该会话有会话文件后备;并不意味着此工具写入了持久的自定义条目。
- 重载持久化因路径而异:
  - 普通 `todo` 调用在转录工具结果详情中保留;
  - `/todo` 命令编辑还会附加 `customType: "user_todo_edit"` 条目,并向模型注入一条描述手动编辑的可见 `<system-reminder>` 开发者消息。
- 在会话恢复时,`AgentSession.#syncTodoPhasesFromBranch()` 在恢复缓存列表之前会剥离 `completed` 和 `abandoned` 任务。`/todo` 命令通过读取最新的转录/自定义条目状态来绕过这一点,以便历史已完成/已丢弃的任务仍对用户可见。
- 工具可用性由 `todo.enabled` 控制,当 `includeYield` 启用时,注册表会排除该工具,除非会话已预先武装 prewalk(`packages/coding-agent/src/tools/index.ts`)。
- 子代理不继承 `todo`;`packages/coding-agent/src/task/executor.ts` 也将其作为父级拥有的工具从活动集中过滤掉。例外(两个层级):预先武装 prewalk 的子代理保留它 —— prewalk 计划提示和 todo 网关要求子代理在交接之前提交自己的 todo 列表。
