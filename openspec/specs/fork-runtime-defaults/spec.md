# Fork 运行默认值

## Purpose

本规格规定个人 fork 的运行默认值。用户已有配置与本次启动的显式配置仍按既有优先级生效。

## Requirements

### Requirement: 默认设置

OMP MUST 列明的 JavaScript Eval、LSP 与其他默认值生效；显式配置和环境变量仍按原优先级覆盖。纯默认值统一在“默认设置”表中维护；`tools.approvalMode` 的默认值归[审批策略](../approval-policy/spec.md)，此处不重复。

#### Scenario: 默认设置的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

保持以下 fork 默认值：

- `recap.enabled=false`
- `debug.enabled=false`、`ida.enabled=false`、`archive.enabled=false`（普通与 offline 启动均默认关闭；已有配置和用户显式开启仍优先，不改写配置文件）。
- `eval.js=false`：所有平台、普通与 offline 启动均默认关闭 JavaScript Eval。默认工具 schema 和对应运行时说明只声明 Python；显式开启 JavaScript 后恢复该后端。未开启时拒绝 JavaScript 执行，显式开启后可实际执行。
- `ask.timeout=60` 秒；Goal 自动编排的超时答复见 [Goal 自动编排](../goal-autopilot/spec.md)。
- 欢迎界面的使用提示、字体提醒与提示／新功能标签采用简体中文，展示边界见[简体中文用户界面](../tui-presentation/spec.md)。
- `startup.setupWizard=false`：不因 setupVersion 落后于当前版本而自动运行设置向导。
- `statusLine.compactThinkingLevel=false`
- `composer.shape=box`（Rounded Box）
- `composer.predictions=true`：所有平台、普通与 offline 启动均默认启用上游输入区预测；沿用当前模型生成下一条消息建议、Tab／右方向键插入但不发送及额外用量计入 `/stats` 的行为。用户显式配置 `false` 时保持关闭，不改写已有配置。
- `theme.dark=dark-terminal`
- `display.showTurnTime=true`
- 界面显示默认采用 `compact`，完整行为与验收见[界面显示模式](../tui-presentation/spec.md)。
- **LSP 默认关闭**：将 `lsp.enabled` 的缺省值改为 `false`。所有平台、普通与 offline 启动，在用户未显式启用时，主会话及其 task 子代理均不启用 LSP；文件写入、编辑、移动和删除的自动格式化、诊断及 LSP 文件通知同样受关闭状态约束。
- `mnemopi.embeddingVariant=multilingual`
- `stt.language=zh-CN`；本地 Whisper 与云端转录的区域标签归一化为基语言，如 `zh-CN`→`zh`。

#### Scenario: 默认设置的可观察行为

- **WHEN** 用户未显式配置运行默认值
- **THEN** 列明的 JavaScript Eval、LSP 与其他默认值生效；显式配置和环境变量仍按原优先级覆盖

#### Scenario: 输入区预测默认开启且允许显式关闭

- **WHEN** 用户未配置 `composer.predictions`
- **THEN** 输入区预测默认启用，正常完成一轮后按上游条件请求预测并在空输入区展示有效建议；没有有效预测时不显示。
- **WHEN** 用户显式设置 `composer.predictions=false`
- **THEN** 不请求或展示输入区预测；默认值变更不覆盖该选择。
