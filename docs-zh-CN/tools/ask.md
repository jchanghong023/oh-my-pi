# ask

> 向交互式用户请求一个或多个选项选择器或自由形式的回答。

## 源码
- 入口：`packages/coding-agent/src/tools/ask.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/ask.md`
- 关键协作者：
  - `packages/coding-agent/src/config/settings-schema.ts` — `ask.timeout` / `ask.notify` 默认值
  - `packages/tui/src/theme/theme.ts` — 供 TUI 渲染使用的复选框与单选按钮字形
  - `packages/tui/src/render/index.ts` — 状态行渲染

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `questions` | `Question[]` | 是 | 一个或多个问题。空数组会被 schema 拒绝，运行时也会被防护。 |

### `Question`

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 在多问题结果中使用的稳定标识符。 |
| `question` | `string` | 是 | 向用户展示的提示文本。 |
| `options` | `{ label: string; description?: string; preview?: string }[]` | 是 | 选择器的可选项。`description` 是解释性文本；`preview` 为富 ask 对话框提供可选的富预览内容。不强制最小/最大数量。运行时会添加自己的控件；调用方不得使用保留标签 `Other (type your own)`、`Chat about this` 或 `Next →`。 |
| `header` | `string` | 否 | 富 ask 对话框使用的可选短显示标签。选择器回退实现会忽略它。 |
| `multi` | `boolean` | 否 | 启用多选模式。默认：`false`。 |
| `recommended` | `number` | 否 | 从零开始的推荐/默认选项索引。无效索引在选择时会被忽略；回退选择器会用 ` (Recommended)` 标记一个有效的单选选项。 |

## 输出
- 一次性返回的结果。
- `content[0].text` 是纯文本：
  - 单个问题：所选答案/自定义答案，外加可选的 `User added note: ...`
  - 多个问题：`User answers:`，其后每个 `id` 一行
  - 富对话框聊天重定向：`User chose to chat about this instead of answering...`
- `details`：
  - 单个问题：`{ question, options, multi, selectedOptions, customInput?, note?, timedOut? }`
  - 多个问题：`{ results: QuestionResult[] }`；每一项包含 `id`、`question`、`options`、`multi`、`selectedOptions`，以及可选的 `customInput`、`note` 和 `timedOut`
  - 聊天重定向：`{ chatRedirect: true, questions: string[] }`
- 取消与无头场景会抛出异常，而不是返回结构化的成功结果。该工具不会流式发送更新。

## 流程
1. `AskTool.createIf()` 仅在 `session.hasUI` 为 true 时注册这个可发现的工具；无头会话永远拿不到它。
2. `execute()` 还需要 `context.hasUI` 和 `context.ui`；若缺失，它会中止上下文并抛出 `ToolAbortError("Ask tool requires interactive mode")`。
3. 它从设置中读取 `ask.timeout`，把秒换算成毫秒（`0` 禁用超时），并在计划模式启用期间完全禁用超时。
4. 如果 `ask.notify` 不是 `off`，它会发送终端通知：`Waiting for input`。当 `speech.enabled` 为 true 时，它还会在打开对话框之前把所有问题文本发送给 vocalizer。
5. 当 UI 提供 `askDialog` 时，该工具会打开一个富多问题表单。富选项会收到 `header`、`description` 和 `preview`；结果可能包含一条答案备注，或选择对话框的 `Chat about this` 重定向。
6. 否则，它对每个问题使用选择器/编辑器回退：
   - 单选列表加上 `Other (type your own)`
   - 多选复选框循环，在适用时加上 `Done selecting`，再加上 `Other (type your own)`
7. 在回退的多问题模式中，左/右方向键处理逻辑会向后/向前移动并保留此前的答案。最后一个问题在选择后自动前进。
8. 如果在给出答案之前触发超时，回退实现会自动选中有效的推荐选项，否则选中第一个选项；结果文本会带上 ` (auto-selected after timeout)`，并设置 `details.timedOut`。富对话框会报告它自己的 `timedOut` 答案。
9. 如果用户在没有超时的情况下取消，`execute()` 会中止工具上下文并抛出 `ToolAbortError("Ask tool was cancelled by the user")`。
10. 成功时，它会格式化人类可读的文本以及结构化的 `details`；TUI 渲染器使用 `details` 进行富结果显示。

## 模式 / 变体
- 单个问题：返回扁平化的 `details` 字段。
- 多个问题：返回 `details.results[]`；回退实现允许用方向键向后/向前导航，而富 UI 会呈现完整表单。
- 单选：一个选项或自定义输入。
- 多选：切换选择项或自定义输入。在回退实现中，`Done selecting` 仅在向前导航未激活且至少选中一个选择项时出现。
- 富 ask 对话框：支持按问题设置的 header、选项预览、答案备注，以及一个 `Chat about this` 重定向。提交非空的自定义答案会前进到下一个问题，或在单个多选问题时进入复核；已勾选的选择项会被保留。当单个单选问题是唯一的问题时，它仍会立即提交。
- 自定义编辑器：粘贴后按 Enter 会提交粘贴的文本，包括两者同时到达的情况。提交会等待进行中的剪贴板读取；取消会丢弃待交付的剪贴板内容。
- 选择器/编辑器回退：支持标签/描述，但不支持 header、预览、备注或聊天重定向。

## 副作用
- 用户可见的提示 / 交互式 UI
  - 当 UI 提供富表单 API 时使用 `context.ui.askDialog(...)`；否则使用选择器/编辑器回退。
  - 通过 `context.ui.select(...)` 打开一个选择对话框。
  - 对 `Other` 通过 `context.ui.editor(...)` 打开一个文本编辑器对话框。
  - 除非 `ask.notify=off`，否则发送终端通知。
  - 当 `speech.enabled=true` 时通过 vocalizer 朗读问题文本。
- 会话状态
  - 读取计划模式状态以禁用超时。
  - 在无头使用或用户取消时调用 `context.abort()`。
- 后台工作 / 取消
  - 用 `untilAborted(...)` 包装 UI 等待，使中止信号能中断挂起的对话框。

## 限制与上限
- `questions` 必须至少包含 1 项。未知字段会被拒绝，因为 `AskTool.strict=true`。
- `ask.timeout` 默认为 `0` 秒（禁用）；配置的非零值以秒为单位。计划模式始终禁用它。
- 提示词指引说提供 2–5 个选项，但代码只要求 `options` 数组字段，并不强制最小或最大长度。
- 选项标签不得等于运行时保留标签 `Other (type your own)`、`Chat about this` 或 `Next →`。
- 回退超时只适用于选项选择器；一旦用户选择 `Other`，编辑器就没有超时。
- `AskTool.concurrency = "exclusive"`：该工具在其工具批中单独运行，因为选择器/编辑器 UI 界面是共享的，并发的 `ask` 调用会互相覆盖。
- 调用渲染器会为显示而规范化不完整或畸形的流式参数：裸字符串选项会变成标签，不可用的问题/选项条目会被省略。执行阶段仍会收到经过 schema 校验的输入。

## 错误
- 缺少交互式 UI：抛出 `ToolAbortError("Ask tool requires interactive mode")`。
- 用户在没有超时的情况下取消选择器/编辑器：抛出 `ToolAbortError("Ask tool was cancelled by the user")`。
- 输入期间的中止信号：转换为 `ToolAbortError("Ask input was cancelled")`。
- 运行时的空 `questions` 会返回文本错误载荷而不是抛出异常：`Error: questions must not be empty`。
- 富对话框契约违规（结果数量、id 或顺序错误）会抛出 `Error`。

## 备注
- `recommended` 只是 UI/默认提示；无效索引会被忽略。当不存在有效推荐时，超时回退使用第一个选项。
- 在回退单选模式下，返回的 `selectedOptions` 值会去掉末尾追加的 ` (Recommended)` 后缀。
- 多选结果按 `Set` 插入顺序保留选择顺序，而不是任意切换后的原始选项顺序。
- 选项标签与提示文本会原样返回到 `details` 中。描述/预览/header 只用于指导呈现，不会被复制进结果的 details 中。
- `/tree` 可以从一次持久化的 `ask` 调用中恢复 schema 有效的原始 `questions`，并重新打开它以创建一个同级答案分支；畸形的历史参数会以失败关闭方式处理。
