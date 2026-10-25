# Fork 运行默认值

## Purpose

本规格规定个人 fork 在用户主目录启动时的工作目录选择，以及 OpenTelemetry OTLP 导出的默认状态。用户已有配置与本次启动的显式配置仍按既有优先级生效。

## Requirements

### Requirement: 主目录会话默认可用

OMP MUST 在用户主目录 `~` 启动 CLI 时默认保留主目录作为会话工作目录，不自动切换到临时目录，也不要求传入 `--allow-home`。

#### Scenario: 未指定工作目录

- **WHEN** 用户直接从主目录启动 CLI
- **THEN** 会话工作目录保持为用户主目录。

### Requirement: OTLP 导出默认关闭

OMP MUST 将内置默认值设为 `telemetry.otlpExportEnabled=false`；未显式配置时，即使设置了 `OTEL_*` 导出端点，也不导出跟踪、日志或指标。此改动只调整缺省值，不写入用户配置。

#### Scenario: 配置端点但未开启导出

- **WHEN** 用户设置了 `OTEL_*` 导出端点，但未显式开启 OTLP 导出
- **THEN** OMP 不向已配置的接收端导出跟踪、日志或指标。

### Requirement: 默认设置

OMP MUST 列明的 JavaScript Eval、LSP 与其他默认值生效；显式配置和环境变量仍按原优先级覆盖。

#### Scenario: 默认设置的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

保持以下 fork 默认值：

- `recap.enabled=false`
- `title.generator=smol`：所有平台、普通与 offline 进程的自动会话标题优先使用与内置 `scout` 相同的 `@smol` 角色解析，随当前 smol 配置／预设变化，不固定模型 ID。smol 无法解析时直接使用当前会话模型；smol 请求失败、缺少凭证或未生成有效标题时，除非显式设置 `retry.modelFallback=false`，否则回退到当前会话模型；两者相同（含路由）只尝试一次，不插入 tiny／commit／default 或模型专属 fallback 链。不默认分叉主模型，也不预热无关 tiny 标题 Worker；保留取消及本地推理不回退付费模型的边界。重新规划触发的标题刷新共用此解析；显式 `title.generator=fork`／`tiny` 保持各自行为，`--no-title` 和手动命名优先，不改写已有配置。
- `debug.enabled=false`、`ida.enabled=false`、`archive.enabled=false`（普通与 offline 启动均默认关闭；已有配置和用户显式开启仍优先，不改写配置文件）。
- `eval.js=false`：所有平台、普通与 offline 启动均默认关闭 JavaScript Eval。默认工具 schema 和对应运行时说明只声明 Python；显式开启 JavaScript 后恢复该后端。未开启时拒绝 JavaScript 执行，显式开启后可实际执行。
- 主目录会话与 OTLP 导出的默认值及显式覆盖契约见 [主目录会话与 OTLP 默认值](#requirements)。
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
- `error.notify=on`（默认在 Agent 因错误停止时发送终端通知；实际呈现取决于终端支持）
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
