# Fork 运行默认值

## Purpose

本规格规定个人 fork 相对上游的运行默认值，集中维护工具启用、启动向导、输入区预测、显示及语言等设置的缺省行为。用户已有配置、环境变量与本次启动的显式配置仍按既有优先级生效，不因默认值维护而改写已有配置。

## Requirements

### Requirement: 默认设置

OMP MUST 应用下列设置的缺省值；显式配置和环境变量仍按原优先级覆盖。纯默认值统一在本节维护；`tools.approvalMode` 的默认值归[审批策略](../approval-policy/spec.md)，此处不重复。

#### Scenario: 默认设置的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

保持以下 fork 默认值：

- `recap.enabled=false`
- `commit.enabled=false`：`/commit` 与 eval `commit` 选择性提交默认关闭；显式开启后沿用上游行归属、私有索引构建及“合并／变基等操作进行中拒绝提交”的行为。
- `providers.thinkingProbe=false`：未知模型的思考能力探测默认关闭，不为内网、自有 Provider 或自定义模型额外发送探测请求；显式开启后沿用上游探测、持久化与等级收敛行为。
- `async.maxJobs=32`；后台任务的硬上限及计数边界见下文。
- 欢迎区的既有使用提示、「提示：」徽标、「新功能」标签与字体提醒保留简体中文；其余内置 TUI 文案及原文保留边界见[英文 TUI 界面与中文启动提示](../tui-presentation/spec.md#requirement-英文-tui-界面与中文启动提示)。
- `startup.setupWizard=false`：不因 setupVersion 落后于当前版本而自动运行或加载完整设置向导；见[全平台轻量启动](../fork-runtime/spec.md#requirement-全平台轻量启动)。
- `startup.checkUpdate=false`：默认不查询 OMP 新版本；仅普通交互启动可显式开启。`OMP_OFFLINE` 始终跳过检查，不影响手动更新。
- `marketplace.autoUpdate=off`：默认不自动刷新市场目录、检查或升级插件；普通模式可显式开启，`OMP_OFFLINE` 仍只允许手动更新。详见[插件市场更新](../fork-runtime/spec.md#requirement-插件市场更新)。
- `statusLine.compactThinkingLevel=false`
- `composer.shape=box`（Rounded Box）
- `composer.predictions=true`：所有平台、普通与 offline 启动均默认启用上游输入区预测；沿用当前模型生成下一条消息建议、Tab／右方向键插入但不发送及额外用量计入 `/stats` 的行为。用户显式配置 `false` 时保持关闭，不改写已有配置。
- `theme.dark=titanium`：普通与 offline 启动均与上游一致，使用 Titanium 内置原配色；仅在未显式配置时生效，不迁移或覆盖已保存的主题选择。`theme.light=light` 保持不变。
- `display.showTurnTime=true`
- `terminal.programStatus`：普通模式默认开启，offline 默认关闭 OSC 7501 程序状态通知；用户显式配置优先，不改写已有配置文件。
- 界面显示默认采用 `compact`，完整行为与验收见[界面显示模式](../tui-presentation/spec.md)。
- `lsp.enabled=false`：普通与 offline 启动均默认关闭 LSP。显式配置为 `true` 时按上游规则启用；显式 `--no-lsp` 仅关闭本次运行，优先于保存的设置。SDK 等非 CLI 宿主的会话级 LSP 控制不变。
- **CLI 默认 `--no-extensions`**：所有平台、普通与 offline 的 CLI 启动均跳过扩展自动发现，不加载用户、项目或插件中自动发现的扩展。默认或显式关闭扩展自动发现时仍加载全部 bundled TypeScript custom commands（含 `/review`、`/annotate`、`/green`），不探测或遍历用户／项目 custom command 目录；`restrictToolNames === true` 的限制会话仍不加载任何 custom commands。显式 `-e`／`--extension`、`--hook` 和可信扩展白名单仍按现有规则加载；Skills、规则、上下文文件和 MCP 不因本默认值被一并关闭，不改写用户配置。
- **默认不扫描 Claude 插件**：所有平台、普通与 offline 启动默认跳过 Claude 插件注册表及插件缓存发现，不为插件发现读取 `enabledPlugins`；沿用现有来源启用机制显式恢复，OMP 原生插件和明确指定的插件目录不受影响，完整边界见下文。
- `mnemopi.embeddingVariant=multilingual`
- `stt.language=zh-CN`；本地 Whisper 与云端转录的区域标签归一化为基语言，如 `zh-CN`→`zh`。

#### Scenario: 默认设置的可观察行为

- **WHEN** 普通运行设置没有显式配置或环境变量覆盖
- **THEN** 应用本节列明的缺省值；CLI 的 LSP 启动行为单独按「默认参数覆盖已保存的 LSP 启用配置」场景验收。

#### Scenario: 输入区预测默认开启且允许显式关闭

- **WHEN** 用户未配置 `composer.predictions`
- **THEN** 输入区预测默认启用，正常完成一轮后按上游条件请求预测并在空输入区展示有效建议；没有有效预测时不显示。
- **WHEN** 用户显式设置 `composer.predictions=false`
- **THEN** 不请求或展示输入区预测；默认值变更不覆盖该选择。

#### Scenario: 普通模式默认报告程序状态，offline 默认不报告

- **WHEN** 普通模式未显式配置 `terminal.programStatus`，或用户在任一模式显式设置 `terminal.programStatus=true`
- **THEN** 交互式终端按既有行为探测 OSC 7501 支持并报告运行状态。
- **WHEN** offline 模式未显式配置 `terminal.programStatus`，或用户在任一模式显式设置 `terminal.programStatus=false`
- **THEN** 不发起 OSC 7501 探测或报告运行状态，不改写已保存配置。

### Requirement: CLI 默认轻量启动参数

交互、print 与 RPC 启动 MUST 在首次参数解析和扩展参数重新解析中默认应用 `--no-extensions`，不要求 shell alias、配置文件或用户手动补参数。ACP 沿用上游扩展发现默认值，并尊重显式的 `--no-extensions`。

#### Scenario: 默认跳过自动扩展并保留显式扩展

- **WHEN** 非 ACP CLI 不携带 `--no-extensions` 启动，存在用户或项目自动扩展，并显式指定 `-e <path>`
- **THEN** 不扫描或执行自动扩展，仅加载明确指定的扩展；扩展参数重新解析、工具和命令注册沿用现有行为，不丢失显式路径。

#### Scenario: 关闭自动发现仍保留内置命令

- **WHEN** 普通或 offline CLI 默认启动，或显式关闭扩展自动发现
- **THEN** 真实 RPC 命令广告与 TUI 补全均可见 `/review`、`/annotate`、`/green`，RPC 来源为 `custom`。
- **AND** 不探测或遍历用户／项目 TypeScript custom command 目录，不执行其中的模块；不因恢复内置命令而启用其他自动扩展。

#### Scenario: 限制会话不加载 custom commands

- **WHEN** SDK 以 `restrictToolNames === true` 创建会话
- **THEN** 无论扩展自动发现是否关闭，custom commands 均为空，不执行外部命令模块。

#### Scenario: 非 CLI 宿主保留原有命令发现与覆盖语义

- **WHEN** 非限制宿主调用现有 custom command loader，省略 `discover` 或传入 `true`
- **THEN** 沿用原有外部目录发现、用户／项目覆盖 bundled 命令及外部同名冲突处理；公开 `discoverCustomTSCommands()` 保留默认发现语义。

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
