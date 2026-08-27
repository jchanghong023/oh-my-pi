# `/tree` 命令参考

`/tree` 打开交互式 **会话树**（Session Tree）导航器，让你可以跳转到当前会话文件中的任意条目并从该位置继续。

这是文件内的叶子节点移动，而不是新的会话导出。

## `/tree` 的作用

- 基于当前会话条目构建树（`SessionManager.getTree()`）
- 打开 `TreeSelectorComponent`，提供键盘导航、过滤与搜索
- 选中后调用 `AgentSession.navigateTree(targetId, { summarize, customInstructions })`
- 从新的叶子路径重建可见聊天
- 选中 user/custom 消息时，可选择性地预填编辑器文本

主要实现位置：

- `src/slash-commands/builtin-registry.ts`（`/tree`、`/branch` 命令路由）
- `src/modes/controllers/input-controller.ts`（按键绑定，连按两次 Esc 的行为）
- `src/modes/controllers/selector-controller.ts`（树界面启动 + 摘要提示流程）
- `src/modes/components/tree-selector.ts`（导航、过滤、搜索、标签、渲染）
- `src/session/agent-session.ts`（`navigateTree` 叶子切换 + 可选摘要）
- `src/session/session-manager.ts`（`getTree`、`branch`、`branchWithSummary`、`resetLeaf`、标签持久化）

## 打开方式

以下任意一种都会打开同一个选择器：

- `/tree`
- `app.session.tree` 动作的已配置按键绑定
- 编辑器为空时连按两次 Esc，且 `doubleEscapeAction = "tree"`（默认）
- 当 `doubleEscapeAction = "tree"` 时使用 `/branch`（会路由到树选择器，而不是仅 user 的分支选择器）

## 树界面模型

树由会话条目的父节点指针（`id` / `parentId`）渲染而成。

- 子节点按时间戳升序排序
- 包含当前活跃叶子的分支在选择器中排在最前；其他历史记录仍可访问
- 活跃分支（根到叶子的路径）用项目符号标记
- 标签以 `[label]` 形式渲染在节点文本之前
- 缺失父节点、自父条目以及显式 null 父节点都会成为根节点；多个根节点共享一个虚拟分支根

```text
树视图示例（活跃路径用 • 标记）：

├─ user: "Start task"
│  └─ assistant: "Plan"
│     ├─ • user: "Try approach A"
│     │  └─ • assistant: "A result"
│     │     └─ • [milestone] user: "Continue A"
│     └─ user: "Try approach B"
│        └─ assistant: "B result"
```

选择器围绕当前选中项重新居中，最多显示：

- `max(5, floor(terminalHeight / 2))` 行

## 树选择器内的按键绑定

- `Up` / `Down`：移动选中项（循环）
- `Alt+Up` / `Alt+Down`：跳转到上/下一个 user 或 assistant 轮次
- `Page Up` / `Page Down`，或 `Left` / `Right`：翻页
- `Home` / `End`：第一个/最后一个可见项
- `Enter`：选中节点
- `Shift+Enter`：进行摘要并切换，但不打开摘要选择提示
- `Esc`：若有搜索则清除搜索；否则关闭选择器
- `Ctrl+C`：关闭选择器
- 输入：追加到搜索关键词
- `Backspace`：删除搜索字符
- `Shift+L`：搜索为空时编辑/清除标签
- `Ctrl+O`：向前循环切换过滤器
- `Shift+Ctrl+O`：向后循环切换过滤器
- `Alt+D/T/U/L/A`：直接跳转到指定过滤器

## 过滤与搜索语义

初始模式来自 `treeFilterMode`（默认 `default`）。各模式按以下顺序循环：

1. `default`
2. `no-tools`
3. `user-only`
4. `labeled-only`
5. `all`

### `default`

显示对话节点以及任何未被显式抑制的条目类型。它会隐藏以下设置/记账类条目类型：

- `label`
- `custom`
- `model_change`
- `thinking_level_change`

其他没有专门渲染的条目类型（例如 service-tier、title、credential-pin、reset 以及 mode 条目）在当前代码中可能会显示为空白行。

### `no-tools`

与 `default` 相同，另外隐藏 `toolResult` 消息。

### `user-only`

仅显示 role 为 `user` 的 `message` 条目。

### `labeled-only`

仅显示当前解析到标签的条目。

### `all`

会话树中的所有内容，包括记账/custom 条目。

### 仅含工具调用的 assistant 节点行为

只包含工具调用（没有规范文本）的 assistant 消息在每种过滤模式下都会被隐藏，包括 `all`，除非：

- 消息为 error/aborted（`stopReason` 既不是 `stop` 也不是 `toolUse`），或
- 它是当前叶子节点

### 搜索行为

- 查询按空格分词
- 匹配为模糊（子序列）且不区分大小写（`fuzzyMatch`）
- 所有 token 必须匹配（AND 语义）
- 可搜索的文本包括标签、role 以及类型特定内容（消息文本、分支摘要文本、custom 类型、工具命令片段等）

## 选择结果（重要）

`navigateTree` 根据所选条目类型计算新的叶子行为：

### 选择 `user` 消息

- 新叶子变为所选条目的 `parentId`
- 根 user 消息将叶子重置为根
- 文本和图片附件被重建为可编辑草稿
- 选择器仅在编辑器当前为空时才会写入该草稿

### 选择 `custom_message`

- 普通 custom 消息使用与 user 消息相同的父叶子规则和文本预填逻辑
- `skill-prompt` custom 消息不可编辑；选中时与其他非 user 条目一样，落在该节点上

### 选择过去的 `ask` 工具结果

- 交互式 `/tree` 重新打开原始问题界面，而不是复用旧答案
- 取消则树保持不变
- 新答案作为兄弟 tool result 追加，保留旧答案分支，然后 agent 从该处恢复
- 如果遗留/损坏的数据无法恢复原始问题，则选择回退为普通的叶子移动

### 选择其他节点

- 新叶子变为所选节点 id
- 编辑器不会预填

### 选择当前叶子

- 通常以 `Already at this point` 关闭
- 当前叶子的 `ask` 结果仍允许重新回答流程

```text
选择决策（简化版）：

selected node
   │
   ├─ current leaf (not ask result)? ──> close selector (no-op)
   │
   ├─ ask tool result? ──> re-answer as a sibling branch when questions are recoverable
   │
   ├─ user or ordinary custom message? ──> leaf := parentId (or root)
   │                                         + prefill only into an empty editor
   │
   └─ otherwise ──> leaf := selected node id
                    + no editor prefill
```

## 切换时的摘要流程

摘要提示由 `branchSummary.enabled` 控制（默认 `false`）。`Shift+Enter` 会无视提示设置直接请求摘要；需要可用的模型和 provider 凭据。

当启用提示时，普通 Enter 提供：

- `No summary`
- `Summarize`
- `Summarize with custom prompt`

流程细节：

- 摘要提示中按 Escape 会重新打开树选择器
- 取消自定义 prompt 会返回摘要选择
- 摘要过程中，UI 显示加载器，并将 Esc 绑定到 `abortBranchSummary()`
- 如果摘要中止，则重新打开树选择器且不应用移动

`navigateTree` 内部行为：

- 刷新挂起的 bash 输出并验证目标
- 从旧叶子到共同祖先收集被放弃的分支条目
- 发出可取消的 `session_before_tree`；扩展可提供所请求的摘要
- 仅在请求、需要摘要的条目存在且未提供 hook 摘要时运行默认摘要器
- 按需应用 `branchWithSummary(...)`、`branch(newLeafId)` 或 `resetLeaf()`
- 重建模型上下文、检查点/回退状态、advisor 状态、todos 以及受历史重写影响的 provider 会话
- 发出 `session_tree`，如果处理器可能追加了条目则再次重建

如果请求了摘要但没有可摘要的内容，则导航在不添加摘要条目的情况下继续。

## 标签

树界面中的标签编辑调用 `appendLabelChange(targetId, label)`。

- 非空标签设置/更新解析后的标签
- 空标签清除标签
- 标签以 append-only 的 `label` 条目形式存储
- 树节点显示解析后的标签状态，而不是原始 label 条目历史

## `/tree` 与相邻操作的对比

| Operation | Scope                                            | Result                                                                                                                                                   |
| --------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tree`   | Current session file                             | Moves leaf to selected point (same file)                                                                                                                 |
| `/branch` | Usually current session file -> new session file | By default branches from selected **user** message into a new session file; if `doubleEscapeAction = "tree"`, `/branch` opens tree navigation UI instead |
| `/fork`   | Whole current session                            | Duplicates session into a new persisted session file                                                                                                     |
| `/resume` | Session list                                     | Switches to another session file                                                                                                                         |

关键区别：`/tree` 是单个会话文件内的导航/重新定位工具。`/branch`、`/fork` 和 `/resume` 都会改变会话文件上下文。

## 操作者工作流

### 不丢失当前分支，从更早的 user prompt 重新运行

1. `/tree`
2. 搜索/选中更早的 user 消息
3. 选择 `No summary`（如需要也可摘要）
4. 在编辑器中编辑预填的文本
5. 提交

效果：在同一会话文件中，从所选位置长出新分支。

### 带着上下文面包屑离开当前分支

1. 启用 `branchSummary.enabled`
2. `/tree` 并选中目标节点
3. 选择 `Summarize`（或自定义 prompt）

效果：在目标位置附加一个 `branch_summary` 条目，然后继续。

### 查看隐藏的记账条目

1. `/tree`
2. 按 `Alt+A`（all）
3. 搜索 `model`、`thinking`、`custom` 或标签

效果：检查完整的内部时间线，而不仅仅是对话节点。

### 为后续跳转添加书签式的关键节点

1. `/tree`
2. 移动到目标条目
3. `Shift+L` 并设置标签
4. 之后使用 `Alt+L`（`labeled-only`）快速跳转

效果：在持久的分支地标之间快速导航。
