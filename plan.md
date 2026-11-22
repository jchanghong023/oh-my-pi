# Goal Autopilot 无人值守：最小实现方案

## 目标与范围

启动 `/goal-autopilot <目标>` 即明确授权 OMP 全程执行本次目标所需的操作，不再逐项询问。目标执行不依赖用户在场：本地审批由 OMP 自动处理；`ask` 静默显示原生表单，60 秒无人提交就按超时规则继续。普通 `/goal`、原生交互式 `ask` 和用户主动触发的管理确认不变。

## `ask` 怎么答

在 [`AskTool.execute`](packages/coding-agent/src/tools/ask.ts#L480) 复用原生 HTML `<form>`、宿主表单和超时链路。只有当前 Autopilot 运行发起的 `ask` 使用 **60 秒**超时；不改全局 `ask.timeout`，不发送等待提醒或语音播报。

| 情况 | 返回主模型的结果 |
| --- | --- |
| 用户在超时前提交 | 原生用户答案。 |
| 超时，存在可用的显式推荐，并通过表单校验 | 提交推荐值，并沿用超时结果标记；不当作用户提交。 |
| 超时，没有可用的显式推荐，或推荐未填齐必填项 | 返回固定工具回执：「`ask` 等待 60 秒，未收到用户答复。按本次 `/goal-autopilot` 启动时授予的全程授权，自主决策并推进当前目标，不要重复提问。」 |
| 用户取消、停止或目标运行已失效 | 沿用原生取消语义，不把取消当作超时，不发送固定回执。 |

显式推荐来自 radio／checkbox 的 `checked`、`<option selected>` 或可见字段的显式预填；单选下拉框的隐式首项和隐藏字段本身都不算推荐。不额外调用模型，不把固定回执填进字段，不伪造用户答复，也不通过 `ask` 授予工具权限。

## 审批怎么处理

`/goal-autopilot` 命令本身就是本目标的全程授权，不要求用户在目标中再逐条列出工具、命令或对象。现有审批点仍按最终执行参数判定：当前目标运行发起的 OMP 本地 `prompt` 以启动授权批准本次调用，包括普通确认及 `guarded` 等本地风险提示；不弹审批框。启动授权不是全局 `yolo`，不留下会话外授权，也不把显式 `deny`、外部强制验证或缺失凭据变成通过。确实无法执行时报告原因，不在执行中等待用户。

在 [`ExtensionToolWrapper`](packages/coding-agent/src/extensibility/extensions/wrapper.ts#L359) 的最终审批点和 [Eval prelude](packages/coding-agent/src/eval/preludes.ts#L149) 等独立本地确认入口使用同一目标运行授权；只对由该运行发起的调用生效。`cfg://` 等独立入口也不得等待用户：属于当前运行且可由启动授权满足的本地确认自动处理，否则立即返回具体原因。手动 `/crawl`、`/tree` 重答和普通 `/goal` 不继承该授权。审计标记 `goal-autopilot`，不记成用户点选，也不生成等待用户的记录。

## 生命周期与规格

- 复用当前会话的 `autoOrchestrate`。在主代理发起调用时绑定目标运行归属；打开表单前和超时提交前复核，避免旧调用借用新目标。暂停、停止、替换或预算耗尽后不提交旧运行的超时结果。不增加设置、命令、调度器或持久化模式字段。
- 更新 [`goal-autopilot` 权威规格](openspec/specs/goal-autopilot/spec.md) 的自动审批和超时回执边界，并在 [`fork-maintenance`](openspec/specs/fork-maintenance/spec.md) 明确活跃 Autopilot 的超时例外。同步 coding-agent 未发布 changelog；只核对内网快启，禁止修改 `docs-zh-CN/quick-start-intranet.md`。普通宿主的表单协议、默认值、超时和取消语义不变。

## 验收

复用[真实 TUI 测试载具](packages/coding-agent/test/goals/goal-autopilot-tui.e2e.test.ts)。只提交一次启动命令：普通与 `guarded` 本地确认都无需用户点击，并产生可观察副作用；显式拒绝和外部强制门禁无副作用，且不等待用户。`ask` 静默显示原生表单，期限内提交仍走原路径；无人输入时，60 秒到期后有显式推荐则返回推荐，没有可用推荐则返回固定回执，不能用隐式首项冒充推荐。取消、停止或替换不产生旧运行的超时回执；普通 `/goal`、手动 `/crawl` 和 `/tree` 重答保留原有交互。
