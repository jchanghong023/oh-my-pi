# 解析设备运行时

待处理的预览与计划审批并不使用 `resolve` 工具。它们通过纯文本 `write` 调用完成，目标是 `packages/coding-agent/src/tools/resolve.ts` 中实现的虚拟 `xd://` 设备：

- `xd://resolve` —— 应用待处理的暂存预览；正文 = 一句话原因
- `xd://reject` —— 丢弃待处理的暂存预览；正文 = 一句话原因
- `xd://propose` —— 在计划模式处于激活状态时提交一份计划以供审批；正文 = 计划 slug（`local://<slug>-plan.md` 中的 `<slug>`）

这些是内部 URL，而非文件系统路径。`read xd://resolve`、`read xd://reject` 与 `read xd://propose` 会返回一行使用提示。已完成的设备写入会携带 `details.xdev` 元数据；消费者通过 `writeDeviceDispatch()` 与 `resolveDispatchDetails()` 恢复内部结果。

## 预览流程

预览生产者通过 `queueResolveHandler(...)` 调用，并传入 `apply(reason)` 以及可选的 `reject(reason)` 回调。每个预览在 `ToolChoiceQueue` 中都会获得一个唯一的待处理调用方 ID，因此堆叠的预览之间不会相互覆盖。

当某个预览处于待处理状态时，`AgentSession.nextToolChoiceDirective()` 会返回一条软性约束：

- `toolName: "write"`
- `satisfies: isPreviewResolutionToolCall`
- 来自 `resolve-device-reminder.md` 的提示

模型通过向 `xd://resolve` 或 `xd://reject` 写入来遵循该约束。任何其他写入都无法解析该预览，并会被软性约束生命周期跳过或升级处理。

调度过程会通过 `runResolveInvocation(...)` 调用待处理队列的头部项。

- 一次成功的应用或丢弃会精确消费该待处理调用方一次。
- 若 apply 抛出异常，同一预览会被重新注册，以便模型在修复原因后拒绝或重试。
- 在没有待处理动作时执行 reject 会以 `Nothing to reject; no pending action remains.` 成功完成。
- 在没有待处理动作时执行 resolve 会抛出异常。
- apply 回调中的常规错误会变为 `ToolError("Apply failed: ...")`；已有的 `ToolError` 会被原样保留。

## 计划审批

计划模式会通过 `setPlanProposalHandler(...)` 安装一个独立的提案处理器。

- 交互式模式将 `PlanApprovalDetails` 交给计划审查 UI。
- ACP 模式运行 elicitation/审批并发出模式更新。
- PlanYolo 自动审批并切换到执行目标。

`xd://propose` 会将写入的 slug 分发给已安装的计划提案处理器，并且仅在计划模式处于激活状态时有效。

## 为何 `write` 一定可用

由于预览与计划审批都依赖于 `write`，因此只要需要，harness 都会保持 `write` 可用：

- `createTools(...)` 在存在可延迟工具（如 `ast_edit`）时会自动追加 `write`。
- `createAgentSession(...)` 在存在可延迟工具或启用计划模式时，会保持 `write` 已注册。

## 自定义工具

自定义工具仍然通过 `pushPendingAction(...)` 来暂存预览；加载器会将其转发至 `queueResolveHandler(...)`。除了面向模型的定稿步骤之外，自定义工具的预览 API 保持不变：随后应通过向 `xd://resolve` 或 `xd://reject` 写入纯文本来完成，而不是通过 `resolve` 工具调用。
