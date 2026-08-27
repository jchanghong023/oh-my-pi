# memory_edit

> 通过 id 更新、忘记或使 Mnemopi 长期记忆失效。

## Source
- 入口：`packages/coding-agent/src/tools/memory-edit.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/memory-edit.md`
- 后端协作者：`packages/coding-agent/src/mnemopi/state.ts`（`editScopedMemory(...)`）

## Registration / Visibility
- 工具元数据：`approval = "read"`、`strict = true`、`loadMode = "discoverable"`，尽管成功的调用会修改本地记忆。
- 注册要求 `memory.backend = "mnemopi"`；对于 `"off"`、`"local"` 和 `"hindsight"`，该工具不存在。
- 在具有显式工具列表的无限制会话中，注册会自动为 Mnemopi 包含 `memory_edit`。受限列表不会被扩展。
- 在普通的 `tools.xdev` 会话中，可发现的内置工具可能以 `xd://memory_edit` 形式呈现；显式请求的工具仍为顶层。
- 执行是同步且单次完成的，没有进度回调或取消参数。

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `op` | `"update" \| "forget" \| "invalidate"` | Yes | 要应用的编辑操作。 |
| `id` | `string` | Yes | 由 `recall` 返回的记忆 id。 |
| `content` | `string` | No | 用于 `update` 的替换记忆文本。 |
| `importance` | `number` | No | 用于 `update` 的替换 importance；被限制在 `0..1`。 |
| `replacement_id` | `string` | No | 为 `invalidate` 记录的替代记忆 id。 |

## Outputs
- `content[0].type = "text"`
- 成功的修改会渲染 `Memory <id> updated|deleted|invalidated in bank <bank> (<store>).`
- 未知或操作不合格的 id 渲染 `Memory <id> was not found...`；这是一个状态为 `not_found` 的正常结果。
- 事实 id 渲染 `Memory <id> is a read-only fact...; it cannot be edited. Read it with memory://<id>.`；这是一个状态为 `not_editable` 的正常结果。
- `details` 是 `{ status, bank?, store? }`，其中 status 是 `"updated" | "deleted" | "invalidated" | "not_found" | "not_editable"`，当解析到某行时 store 是 `"working" | "episodic" | "fact"`。

## Flow
1. `MemoryEditTool.createIf(...)` 仅在 `memory.backend == "mnemopi"` 时才暴露该工具。
2. `execute(...)` 获取 `session.getMnemopiSessionState()`，如果后端未初始化则失败。
3. `update` 要求 `content` 或 `importance` 至少有其一。
4. `importance` 在后端调用之前被限制在 `0..1`。
5. 工具调用 `state.editScopedMemory(op, id, { content, importance, replacementId })`。
6. 后端按此顺序搜索去重后的 retain、recall 和 global 目标。它返回第一个成功可编辑的结果，否则返回第一个已解析但不合格的结果，否则返回 `not_found`。
7. 工具渲染返回的状态，并将后端结果原样通过 `details` 传递。

## Modes / Variants
- `update` 替换 working memory 的文本和/或 importance。内容替换是整体的，而非补丁。
- `forget` 永久删除 working memory 的行。
- `invalidate` 软性替代 working 或 episodic 行，并可记录 `replacement_id`。
- 事实行可读但不可变；每个操作都返回 `not_editable`。
- 针对 episodic id 的 `update`/`forget` 返回 `not_found` 及其 bank/store 位置，因为这些操作仅支持 working memory。

## Side Effects
- 文件系统：修改包含已解析行的本地 Mnemopi SQLite 数据库，该行可能位于 retain、recall、shared 或安全发现的 legacy bank。
- 网络：无；编辑操作不会调用 embedding 或 extraction 提供者。
- 会话状态：读取活动会话的作用域 Mnemopi 状态；它不会重写已注入的 `<memories>` 上下文。

## Limits & Caps
- 可用性要求 `memory.backend = "mnemopi"`；Hindsight 和本地文件后端的记忆不暴露此工具。
- `id` 必须直接提供；该工具不按内容搜索。
- Recall 预览默认上限为 500 个字符。在 `update` 之前始终获取 `read memory://<id>`；该 URL 在相同作用域的 bank 中解析完整行。
- 既没有 `content` 也没有 `importance` 的 `update` 会在任何后端写入之前被拒绝。
- 超出 `0..1` 的 `importance` 值会被限制而非拒绝。

## Errors
- 当工具已暴露但会话状态缺失时，抛出 `Mnemopi backend is not initialised for this session.`。
- 对于空更新，抛出 `memory_edit update requires content or importance.`。
- 缺失的、针对 update/forget 的 episodic，以及 fact id 是正常结果而非抛出的错误；检查 `details.status`。
- `read memory://<id>` 在没有作用域 bank 包含该行时抛出 `Mnemopi memory <id> not found`。

## Notes
- 在每次更新之前读取完整的 `memory://<id>` 行。将裁剪的 recall 预览复制到 `content` 会删除未显示的尾部内容。
- 对于其历史仍可能有用的过时 working/episodic 记忆，优先使用 `invalidate`。
- 仅当 working memory 行应被硬删除时才使用 `forget`。
