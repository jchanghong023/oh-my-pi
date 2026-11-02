# Fork 运行默认值

## Purpose

本规格规定个人 fork 相对上游的运行默认值，集中维护工具启用、启动向导、输入区预测、显示及语言等设置的缺省行为。用户已有配置、环境变量与本次启动的显式配置仍按既有优先级生效，不因默认值维护而改写已有配置。

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
- `async.maxJobs=32`；后台任务的硬上限及计数边界见下文。
- 欢迎界面的使用提示、字体提醒与提示／新功能标签采用简体中文，展示边界见[简体中文用户界面](../tui-presentation/spec.md)。
- `startup.setupWizard=false`：不因 setupVersion 落后于当前版本而自动运行或加载完整设置向导；全平台启动减负与取消自动更新检查的边界见[全平台轻量启动](../fork-runtime/spec.md#requirement-全平台轻量启动)。
- `statusLine.compactThinkingLevel=false`
- `composer.shape=box`（Rounded Box）
- `composer.predictions=true`：所有平台、普通与 offline 启动均默认启用上游输入区预测；沿用当前模型生成下一条消息建议、Tab／右方向键插入但不发送及额外用量计入 `/stats` 的行为。用户显式配置 `false` 时保持关闭，不改写已有配置。
- `theme.dark=titanium`：普通与 offline 启动均与上游一致，使用 Titanium 内置原配色；仅在未显式配置时生效，不迁移或覆盖已保存的主题选择。`theme.light=light` 保持不变。
- `display.showTurnTime=true`
- `terminal.programStatus`：所有平台的 offline（`OMP_OFFLINE`）进程默认 `false`，避免不兼容终端把 OSC 7501 程序状态序列显示为文本；普通模式仍默认 `true`。用户显式配置优先，不改写已有配置文件。
- 界面显示默认采用 `compact`，完整行为与验收见[界面显示模式](../tui-presentation/spec.md)。
- **CLI 默认 `--no-lsp`**：所有平台、普通与 offline 的 CLI 启动均按 `--no-lsp` 语义执行，即使已保存 `lsp.enabled=true`，本次会话仍禁用 LSP 工具、自动格式化、诊断、文件通知及启动预热，不改写配置文件。`lsp.enabled` 的缺省值仍为 `false`；SDK 等非 CLI 宿主的显式 LSP 控制保持原有语义，不新增开关或别名。
- **CLI 默认 `--no-extensions`**：所有平台、普通与 offline 的 CLI 启动均跳过扩展自动发现，不加载用户、项目或插件中自动发现的扩展。显式 `-e`／`--extension`、`--hook` 和可信扩展白名单仍按现有规则加载；Skills、规则、上下文文件和 MCP 不因本默认值被一并关闭，不改写用户配置。
- **默认不扫描 Claude 插件**：所有平台、普通与 offline 启动默认跳过 Claude 插件注册表及插件缓存发现，不为插件发现读取 `enabledPlugins`；沿用现有来源启用机制显式恢复，OMP 原生插件和明确指定的插件目录不受影响，完整边界见下文。
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

#### Scenario: offline 默认不发送程序状态序列

- **WHEN** offline 进程未显式配置 `terminal.programStatus`
- **THEN** 该设置解析为 `false`，交互式运行状态变化不发送 OSC 7501 程序状态序列；不要求用户额外创建或修改配置文件。
- **WHEN** 普通模式未显式配置该设置
- **THEN** 仍解析为 `true`，沿用既有程序状态通知行为。

#### Scenario: 程序状态通知尊重显式配置

- **WHEN** 用户在 offline 模式显式设置 `terminal.programStatus=true`
- **THEN** 按既有行为发送程序状态通知，默认值不覆盖该选择。
- **WHEN** 用户显式设置 `terminal.programStatus=false`
- **THEN** 普通与 offline 模式均保持关闭，默认值变化不改写已保存配置。

### Requirement: CLI 默认轻量启动参数

OMP CLI MUST 在首次参数解析和扩展参数重新解析中默认应用 `--no-lsp`、`--no-extensions`，不要求 shell alias、配置文件或用户手动补参数；交互、print、RPC 与 ACP 启动使用同一默认值。

#### Scenario: 默认参数覆盖已保存的 LSP 启用配置

- **WHEN** CLI 不携带 `--no-lsp` 启动，且用户配置 `lsp.enabled=true`
- **THEN** 本次会话仍不注册 LSP 工具、不发现或预热语言服务器，不执行自动格式化、诊断及 LSP 文件通知；保留已保存配置，非 CLI 宿主不被强制关闭。

#### Scenario: 默认跳过自动扩展并保留显式扩展

- **WHEN** CLI 不携带 `--no-extensions` 启动，存在用户或项目自动扩展，并显式指定 `-e <path>`
- **THEN** 不扫描或执行自动扩展，仅加载明确指定的扩展；扩展参数重新解析、工具和命令注册沿用现有行为，不丢失显式路径。

### Requirement: Claude 插件发现默认关闭

OMP MUST 默认跳过 Claude 插件来源的文件系统发现，而非扫描后再隐藏结果；不新增用户配置项、环境开关或 CLI 参数。

#### Scenario: 默认启动不访问 Claude 插件来源

- **WHEN** 任一平台普通或 offline 启动、创建或恢复会话，且未显式启用 Claude 插件来源
- **THEN** 不读取或探测 Claude 配置目录中的 `plugins/installed_plugins.json`，不遍历其插件缓存，不为解析插件启停状态读取用户或项目 `enabledPlugins` 配置层。
- **AND** 启动预加载、Skills、MCP、规则、命令、工具及子代理等共享发现路径均遵守该边界；Claude 注册表损坏、缺失或不可读时不产生插件发现警告。
- **AND** `CLAUDE_CONFIG_DIR` 仅指定路径，不能单独启用插件发现；本要求不关闭普通 `.claude` 目录来源或公司模型配置的既有读取。

#### Scenario: 保留原生与明确指定的插件

- **WHEN** OMP 用户或项目插件注册表中已有插件，或用户显式传入 `--plugin-dir <path>`
- **THEN** 沿用原有加载、项目优先级和去重行为；明确指定目录可以包含 Claude 格式 manifest，但不得顺带扫描 Claude 插件注册表及缓存。
- **AND** 显式 `-e`、`--hook`、可信扩展及非插件 Skills 来源保持各自规则，不因 Claude 插件默认关闭而被一并关闭。

#### Scenario: 显式启用与作用域隔离

- **WHEN** 用户通过现有 `enabledProviders` 启用 `claude-plugins`、其既有 `claude` 别名或通配来源，或显式请求该发现提供者
- **THEN** 按既有规则读取 Claude 插件及启停配置，`disabledProviders` 的显式禁用仍优先；显式管理目录请求可沿用原有的关闭来源查看能力。
- **AND** 按当前会话或发现作用域解析来源授权；同一目录由关闭切换到开启或反向切换时，不复用另一状态的插件根缓存。

### Requirement: 启动不检查 Python

OMP MUST NOT 在启动或创建、恢复会话时检查 Python 可用性，包括首次启动提示、工具注册预检及后台探测。是否注册 Eval MUST 仅依据已有后端启用设置；不新增跳过预检的选项。

#### Scenario: Python 缺失或解释器无法启动

- **WHEN** 启动 OMP 或创建、恢复主会话及子代理会话，且已启用 Python Eval
- **THEN** 不启动 Python 探测或预热，不等待解释器检查，也不因缺少 Python 隐藏 Eval 或弹出启动警告；普通与 offline、交互及非交互模式均适用。
- **WHEN** 实际执行 Python Eval
- **THEN** 才按既有规则检查解释器并按需启动内核；不可用时返回明确错误，不取消执行时校验。显式 `omp setup python --check` 仍可手动诊断。

### Requirement: 后台任务并发上限

每个根会话共享的后台任务管理器 MUST 将运行中任务的并发硬上限从 100 降为 32；`async.maxJobs` 可进一步降低上限，但显式配置高于 32 时 MUST NOT 突破 32。该限制适用于普通与 offline 启动，覆盖同一管理器承载的 eval `agent()` 及其他后台任务，不按工具入口分别分配名额。

#### Scenario: 默认限制与显式配置

- **WHEN** 用户未配置 `async.maxJobs`
- **THEN** 后台任务并发上限为 32。
- **WHEN** 用户显式配置 `async.maxJobs`
- **THEN** 沿用既有配置解析与优先级，并将后台任务并发上限限制在 32 以内；不改写已有配置文件。

#### Scenario: 达到后台任务上限

- **WHEN** 同一后台任务管理器中计入并发的运行中任务已达到有效上限
- **THEN** 沿用既有拒绝注册及错误反馈行为，不启动超限任务；排队任务不占运行名额，已完成、失败或取消的任务不占运行名额。
- **AND** 不改变 `task.maxConcurrency` 的独立子代理调度语义，也不新增排队机制。
