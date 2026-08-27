# Session 树形架构（当前）

参考：[session.md](./session.md)

本文描述当前 Session 树的导航机制：内存中的树模型、叶子节点移动规则、分支行为，以及扩展/事件集成。

## 本子系统是什么

Session 以仅追加的 entry 日志形式存储，但运行时行为基于树形结构：

- 每个非 header entry 都包含 `id` 和 `parentId`。
- 当前位置是 `SessionManager` 中的 `leafId`。
- 追加 entry 始终在当前叶子节点下创建子节点。
- 分支**不会**重写历史；它只改变下一次追加前叶子节点指向的位置。

关键文件：

- `src/session/session-manager.ts` — 树数据模型、遍历、叶子节点移动、分支/Session 提取
- `src/session/session-context.ts` — `buildSessionContext` 上下文重建（已解析的 root→leaf LLM 上下文、压缩/分支摘要重放）
- `src/session/agent-session.ts` — `/tree` 导航流程、摘要、hook/事件触发
- `src/modes/components/tree-selector.ts` — 交互式树形 UI 行为与过滤
- `src/modes/controllers/selector-controller.ts` — `/tree` 与 `/branch` 的选择器编排
- `src/slash-commands/builtin-registry.ts` — 命令路由（`/tree`、`/branch`）
- `src/modes/controllers/input-controller.ts` — 双击 Escape 行为以及 `app.session.tree`/`app.session.fork` 键位绑定
- `src/session/messages.ts` — 将 `branch_summary`、`compaction` 和 `custom_message` entry 转换为 LLM 上下文消息

## `SessionManager` 中的树数据模型

运行时索引存放在 `SessionEntryIndex` 辅助对象中，作为 `#index` 保存在 `SessionManager` 上，与 journal 数组 `#entries` 保持同步：

- `#entriesById: Map<string, SessionEntry>` — 任意 entry 的快速查找
- `#children: Map<string | null, SessionEntry[]>` — parent→children 邻接表
- `#labels: Map<string, string>` — 按目标 entry id 解析的 label
- `#leaf: string | null` — 树中的当前位置
- `#usage` — 累计用量统计

树 API：

- `getBranch(fromId?)` 通过 parent 链接回溯到 root，返回 root→node 路径
- `getTree()` 返回 `SessionTreeNode[]`（`entry`、`children`、`label`）
  - parent 链接转换为 children 数组
  - 缺失 parent 的 entry 视为 root
  - children 按时间戳从旧到新排序
- `getChildren(parentId)` 返回直接子节点
- `getLabel(id)` 从索引的 `#labels` map 解析当前 label

`getTree()` 是运行时投影；持久化仍为仅追加的 JSONL entry。

## 叶子节点移动语义

共有三种叶子节点移动原语：

1. `branch(entryId)`
   - 校验 entry 存在
   - 设置 `leafId = entryId`
   - 不写入新 entry

2. `resetLeaf()`
   - 设置 `leafId = null`
   - 下一次追加将创建新的 root entry（`parentId = null`）

3. `branchWithSummary(branchFromId, summary, details?, fromExtension?)`
   - 接受 `branchFromId: string | null`
   - 设置 `leafId = branchFromId`
   - 将 `branch_summary` entry 作为该叶子的子节点追加
   - 当 `branchFromId` 为 `null` 时，`fromId` 持久化为 `"root"`

## `/tree` 导航行为（同一 Session 文件）

`AgentSession.navigateTree()` 是导航，不是文件分叉。

流程：

1. 校验目标并计算被放弃的路径（`collectEntriesForBranchSummary`）。
2. 对于可恢复原始问题的交互式 `ask` 工具结果选择，在不修改树的情况下返回 `reopenAsk` 请求。选择器重新打开问题 UI，然后再次以替换结果调用 `navigateTree`；第二次调用会在原答案的 parent 处追加一个新的兄弟 `toolResult`。
3. 使用 `TreePreparation` 触发 `session_before_tree`。
4. 可选地对被放弃的 entry 进行摘要（hook 提供的摘要或内置摘要器）。
5. 计算新的叶子目标：
   - 选中 **user** 消息：叶子移动到其 parent，并返回消息文本及图片附件，用于编辑器草稿恢复
   - 选中非 skill-prompt 注入的 **custom_message**：遵循相同的 parent/prefill 规则（仅文本）
   - 选中 skill-prompt custom message 或任何其他 entry：leaf = 所选 entry id
6. 应用叶子移动：
   - 带摘要：`branchWithSummary(newLeafId, ...)`
   - 无摘要且 `newLeafId === null`：`resetLeaf()`
   - 其他情况：`branch(newLeafId)`
7. 从新叶子重建 agent 上下文，重置分支作用域的 todo/advisor/checkpoint 状态，关闭其历史被重写的 Codex provider session，并触发 `session_tree`。

重要：摘要 entry 附加在**新的导航位置**，而不是被放弃分支的尾部。

## `/branch` 行为（默认配置下新建 Session 文件）

`/branch` 与 `/tree` 通常不同：

- `/tree` 在当前 Session 文件内导航。
- `/branch` 打开用户消息选择器，并创建新的 Session 分支文件（或在非持久化模式下进行内存中的替换）。

默认的用户面向 `/branch` 流程（`SelectorController.showUserMessageSelector` → `AgentSession.branch`）：

- 分支源必须是 **user 消息**。
- 所选的用户文本及图片附件会恢复到编辑器草稿中。
- 若所选用户消息是 root（`parentId === null`）：通过 `newSession({ parentSession: previousSessionFile })` 启动新 Session，携带先前的 Session 标题及标题来源。
- 其他情况：调用 `createBranchedSession(selectedEntry.parentId)` 在所选 prompt 边界处分叉历史。

配置注意：当 `doubleEscapeAction=tree` 时，`/branch` 注册项打开与 `/tree` 相同的树形选择器；因此选择会使用 `navigateTree()` 并停留在当前文件中。这不仅仅是 `AgentSession.branch()` 的另一种 UI。

`SessionManager.createBranchedSession(leafId)` 细节：

- 通过 `getBranch(leafId)` 构建 root→leaf 路径；若缺失则抛出错误。
- 排除已复制路径中的现有 `label` entry。
- 根据已解析的 label map（`labelsInEffect()`）为路径中保留的 entry 重建新的 label entry。
- 持久化模式：写入新的 JSONL 文件并将 manager 切换到该文件；返回新文件路径。
- 内存模式：替换内存中的 entry；返回 `undefined`。

## 上下文重建与 summary/custom 集成

`buildSessionContext()`（位于 `session-context.ts`，通过 `SessionManager.buildSessionContext()` 暴露）解析活动的 root→leaf 路径，并构建有效的 LLM 上下文状态：

- 在路径上追踪最新的 configured/effective thinking、role-model、per-family service-tier、mode/data 以及注入的 TTSR 状态。
- 处理路径上最新的 compaction：
  - 首先发出 compaction 摘要
  - 从 `firstKeptEntryId` 重放到 compaction 点的保留消息
  - 然后重放 compaction 后的消息
- 将 `branch_summary` 和 `custom_message` entry 包含为 `AgentMessage` 对象。

随后 `session/messages.ts` 将这些消息类型映射为模型输入：

- `branchSummary` 与 `compactionSummary` 变为 user 角色的模板化上下文消息
- `custom`/`hookMessage` 变为 developer 角色的内容消息（通过 agent-core 的 `convertMessageToLlm`）

因此，树形移动通过改变活动的叶子路径来改变上下文，而不是修改旧的 entry。

## Label 与树形 UI 行为

Label 持久化：

- `appendLabelChange(targetId, label?)` 在当前叶子链上写入 `label` entry。
- `#labels`（位于 `SessionEntryIndex` 中）会立即更新（set 或 delete）。
- `getTree()` 将当前 label 解析到每个返回的节点上。

树形选择器行为（`tree-selector.ts`）：

- 将树展平用于导航，保留活动路径高亮，并优先展示活动分支。
- 支持的过滤模式：`default`、`no-tools`、`user-only`、`labeled-only`、`all`。
  - `default` 会隐藏 `label`、`custom`、`model_change` 和 `thinking_level_change`；它并非一个完整的"隐藏所有内部 entry"过滤器。
- 支持针对已渲染语义内容的自由文本搜索。
- `Shift+L` 打开内联 label 编辑，并通过 `appendLabelChange` 写入。

命令路由：

- `/tree` 始终打开树形选择器。
- `/branch` 通常打开用户消息/文件分支选择器。在 `doubleEscapeAction=tree` 时，它打开树形选择器并改为执行同文件导航。

## 树形操作的扩展与 hook 接入点

命令时的扩展 API（`ExtensionCommandContext`）：

- `branch(entryId)` — 创建分支 Session 文件；返回 `{ cancelled }`
- `navigateTree(targetId, { summarize? })` — 在当前树/文件内移动；返回 `{ cancelled }`

`HookCommandContext` 暴露相同的 `branch` 和 `navigateTree` 动作，但刻意省略了仅在扩展中使用的 Session 切换/重载/compaction 动作。

围绕树形导航的事件：

- `session_before_tree`
  - 接收 `TreePreparation`：
    - `targetId`
    - `oldLeafId`
    - `commonAncestorId`
    - `entriesToSummarize`
    - `userWantsSummary`
  - 可以取消导航
  - 可以提供用于替代内置摘要器的摘要 payload
  - 接收 abort `signal`（Escape 取消路径）
- `session_tree`
  - 发出 `newLeafId`、`oldLeafId`
  - 在创建了摘要时包含 `summaryEntry`
  - `fromExtension` 指示摘要来源

相邻但相关的生命周期 hook：

- `session_before_branch` / `session_branch` 用于 `/branch` 流程
- `session_before_compact`、`session.compacting`、`session_compact` 用于稍后影响树形上下文重建的 compaction entry

## 真实约束与边界情况

- `branch()` 不能以 `null` 为目标；针对首条 entry 之前的 root 状态，请使用 `resetLeaf()`。
- `branchWithSummary()` 支持 `null` 目标，并记录 `fromId: "root"`。
- 选择当前叶子通常为 no-op。交互式 `ask` 重新回答是例外：两阶段协议可能以当前 ask-result 叶子为目标，以重新打开或提交兄弟答案。
- 摘要需要可用的 model 与 API key；任一缺失都会在导航之前失败。
- 若摘要被中止，则取消导航，叶子保持不变。
- 内存 Session 永远不会从 `createBranchedSession` 返回分支文件路径，但其内存中的 entry 会被替换。
- 树形上下文重建包含 role models、configured/effective thinking、per-family service tiers、mode data 以及注入的 TTSR 状态；状态 entry 本身不会成为 LLM 消息。

## Plan 审批 Session 命名

当用户从 plan 模式（`InteractiveMode.#approvePlan`）批准一个 plan 时，调度路径会以该 plan 的 title 作为 Session 名称种子，确保最终生成的新 Session、保留的 Session 或压缩后的 Session 不会保持未命名状态。

触发条件：

- Plan 审批到达 `#approvePlan(...)`，且 `options.title` 由 plan 审批详情填充。
- 这适用于到达执行调度的每个审批选项。若审批时的 compaction 被显式取消，则不会调度执行，也不会到达命名块；下一个操作者回合会从已保留的 plan 引用继续。

命名来源：

- 规范化后的 plan title 通过 `humanizePlanTitle(title)`（`packages/coding-agent/src/plan-mode/approved-plan.ts`）进行人性化处理：
  - 将连续的 `-`/`_` 替换为单个空格
  - 去除首尾空白
  - 将首字符大写
  - 对于仅空白或仅分隔符的输入返回 `""`
- 仅当当前 Session 没有名称（`!sessionManager.getSessionName()`）时，才会应用该人性化后的名称。然后调用 `sessionManager.setSessionName(name, "auto")`，该调用同样会拒绝覆盖用户已命名的 Session。
- 成功应用后，终端标题（`setSessionTerminalTitle`）和编辑器边框颜色会被刷新以反映新名称。

示例（来自 `humanizePlanTitle`）：

- `migrate-mcp-loader` → `Migrate mcp loader`
- `fix_session_naming` → `Fix session naming`
- `foo--bar__baz` → `Foo bar baz`
- `RefactorRouter` → `RefactorRouter`（没有需要展开的分隔符）
- `""` / `"---"` → `""`（不应用名称）

## 仍存在的遗留兼容性

加载时仍会运行 Session 迁移：

- v1→v2 添加 `id`/`parentId`，并将 compaction 索引锚点转换为 id 锚点
- v2→v3 将遗留的 `hookMessage` role 迁移为 `custom`

迁移完成后，当前的运行时行为为 version-3 树形语义。
