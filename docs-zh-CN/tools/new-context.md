# new_context

> 请求一个新的实验性上下文窗口，同时保留当前笔记与可恢复的分支历史。

## 来源

- 入口：`packages/coding-agent/src/tools/context-notes.ts`（`NewContextTool`）
- 面向模型的提示：`packages/coding-agent/src/prompts/tools/new-context.md`
- 请求消费：`packages/coding-agent/src/session/agent-session.ts`
- Rollover 生命周期：`packages/coding-agent/src/session/session-maintenance.ts`
- 注册：`packages/coding-agent/src/tools/index.ts`

## 注册 / 可见性

- 要求 `compaction.experimentalContextManagement = true`、会话未被销毁，且会话日志的 ID 与工具会话的所有者 ID 一致。
- 该设置默认为 `false`。在 `/settings` → Context → Compaction 中启用 **Notes-backed context windows (experimental)**，然后重启以更新可用工具集。
- 元数据：`approval = "write"`、`strict = true`、`loadMode = "essential"`。
- 基于笔记的 rollover 需要四个工具同时处于活动状态：`context_notes`、`new_context`、`read` 和 `grep`。不受支持的工具配置保持原有的压缩行为。

## 输入

空对象：`{}`。该工具不接受指令、笔记文本或目标会话 ID。请求 rollover 之前，先用 [context_notes](context-notes.md) 保存工作笔记。

## 输出

- 文本：`New context window requested.`
- details：`{ requested: true }`。

该结果只是确认收到请求。工具本身不会提交压缩边界，也不会同步重置对话。

## 流程与副作用

1. 校验属主会话并检查取消。
2. 返回本轮的 rollover 请求。
3. 属主代理消费成功的工具结果（包括写设备结果），并在下一次 provider 请求之前通过维护生命周期处理该请求。
4. 实验性生命周期提交一次普通压缩边界，不再生成额外的递归摘要。它用最新笔记与保留的近期消息重建活动上下文，同时原始日志条目仍可通过 `history://current/full` 取回。

显式的 `new_context` 请求会绕过自动的轮中阈值切换。rollover 仍取决于实验性能力与维护守卫；会话、分支、模型、取消与活动工具的变化都会在提交前重新校验。

## 限制与错误

- 已禁用、已销毁或属主不匹配的工具会话会以 `ToolError` 失败。
- 返回请求之前会检查取消。
- 维护生命周期负责取消、扩展 hook、并发压缩以及陈旧的会话或分支状态。工具请求成功不代表后续 rollover 一定提交。
- 该工具不会创建新会话、不改工作文件，也不删除原始日志历史。

自动 rollover、笔记提醒与手动压缩行为见 [Compaction 与分支摘要](../compaction.md)。
