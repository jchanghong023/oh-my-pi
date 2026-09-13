# context_notes

> 读取或整份替换当前分支的持久实验性上下文笔记。

## 来源

- 入口：`packages/coding-agent/src/tools/context-notes.ts`（`ContextNotesTool`）
- 面向模型的提示：`packages/coding-agent/src/prompts/tools/context-notes.md`
- 笔记投影：`packages/coding-agent/src/session/context-notes.ts`
- 注册：`packages/coding-agent/src/tools/index.ts`

## 注册 / 可见性

- 要求 `compaction.experimentalContextManagement = true`、会话未被销毁，且会话日志的 ID 与工具会话的所有者 ID 一致。
- 该设置默认为 `false`。在 `/settings` → Context → Compaction 中启用 **Notes-backed context windows (experimental)**，然后重启以更新可用工具集。
- 元数据：`strict = true`、`loadMode = "essential"`。不含 `text` 属性的调用请求读取审批；含该属性的调用请求写入审批。
- 基于笔记的 rollover 需要四个工具同时处于活动状态：`context_notes`、`new_context`、`read` 和 `grep`。

## 输入

| 字段   | 类型     | 必填 | 描述                                                                                                       |
| ------ | -------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `text` | `string` | 否   | 整份替换后的笔记。省略该字段表示读取；传空字符串表示清空。写入是替换可见笔记，而不是追加。                 |

## 输出

- 读取：返回最新的可见笔记文本；不存在时返回 `No context notes are stored for this session branch.`。details 中包含 `text`，笔记存在时还包含其 `entryId`。
- 写入：返回 `Context notes saved.`。details 中包含 `entryId`、保存的 `text`，以及其 UTF-8 字节数 `bytes`。

## 流程与副作用

1. 解析当前存活的属主日志并检查取消。
2. 读取时投影活动分支上最新的笔记修订。
3. 写入时校验字节上限，记录属主与分支叶节点，并等待磁盘准备完成。
4. 在追加 `experimental_context_notes` 自定义条目（`{ version: 1, text }`）之前，重新检查取消、会话所有权、功能可用性与分支叶节点。
5. 返回成功前 flush 日志。

最新的可见笔记会参与实验性上下文重建，并在 rollover 与磁盘恢复中保留。上下文重置会隐藏更早的笔记修订。清空笔记会追加一个空修订，不会删除更早的日志条目。

## 限制与错误

- 笔记上限：**16,384 UTF-8 字节**。超限写入在追加前即失败。请缩短笔记，并用 `read` 或 `grep` 通过 `history://current/full` 找回支撑细节。
- 已禁用、已销毁或属主不匹配的会话会以 `ToolError` 失败。
- 磁盘准备期间发生分支切换会拒绝写入，而不是存到另一条分支。
- 取消与持久化错误会传播给调用方。

rollover 见 [new_context](new-context.md)，实验性维护生命周期见 [Compaction 与分支摘要](../compaction.md)。
