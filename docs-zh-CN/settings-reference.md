# 设置参考（全部配置项）

本页列出可以出现在 `config.yml` 中的**全部**配置项：类型、默认值、功能说明与可选值；每个配置项一个条目，可选值每个一行。内容来自 `packages/coding-agent/src/config/settings-schema.ts` 中的 `SETTINGS_SCHEMA`（共 480 项），与 `/settings` 面板和 `omp config list` 使用同一份 schema。

- 每个键就是 `config.yml` 中的嵌套路径（如 `theme.dark`、`tools.approvalMode`），无缩写；键必须与 schema 完全一致：写 `theme.dark`，而不是 `theme`。
- 优先级、存储位置、写入方式与合并规则见 [Settings（设置）](./settings.md)；配置发现与解析机制见 [Config usage（配置发现与解析）](./config-usage.md)。
- 运行时查看当前生效值：`omp config list`；机器可读输出：`omp config list --json`。
- 模型与凭据、环境变量相关配置见 [Providers](./providers.md)、[Models](./models.md)、[Environment variables](./environment-variables.md)；`tools.approval`（按工具名记录审批策略）与 `bash.patterns` 的用法见 [Settings](./settings.md) 与 [Approval mode](./approval-mode.md)。
- 本文是 schema 的静态快照：schema 增删配置项、修改默认值或枚举后，需要按 `SETTINGS_SCHEMA` 重新生成本页。

## 图例

- **类型**：`string` 字符串 · `boolean` 布尔 · `number` 数字 · `enum` 枚举（可选值见条目内的「可选值」列表） · `array` 数组（更高优先级层覆盖时整体替换、不追加；`config set` 需传 JSON 数组） · `record` 键-值对象（`config set` 需传 JSON 对象）。
- **默认值**：`—（未设默认值）` 表示该键在 schema 中没有默认值，`config.yml` 未配置时读到的值为 `undefined`。
- **作用**：一句话说明该配置项配置/控制什么功能（开关、参数、顺序、UI 行为、后端选择等）。
- **可选值**：每个条目都有该行。enum 的每个可选值一行；boolean 为 `true`/`false`（每行一个）；`string`/`number`/`array`/`record` 标注「无固定枚举」（自由输入，由运行时或对应功能校验）；个别设置的选项由运行时动态提供（如已安装的主题/扩展列表）。
- **凭据**：敏感字段；`omp config list` 的人类可读输出中会被脱敏为 `********`。
- **条件**：该设置仅在所列条件成立时生效（如依赖开关开启）。
- **有序**：数组中的顺序有意义（如回退顺序），合并时不做追加合并。

## 无 UI 面板的配置项

以下配置项不在 `/settings` 面板中展示，但可以直接写入 `config.yml`（部分由设置向导、命令行或运行时功能读取）。共 122 项。



### `setupVersion`

- **作用**：设置迁移的当前 schema 版本号，用于触发一次性升级逻辑。
- **类型**：`number`
- **默认值**：`0`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `auth.broker.url`

- **作用**：远端 `omp auth-broker serve` 凭据代理服务地址（隐藏 UI，env 优先）。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：无说明。（源码注释：Auth broker — 通过远程 `omp auth-broker serve` 代理凭据。隐藏在 UI 中，通过环境变量或手动编辑 config.yml 填充。环境变量 `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` 优先，以便按机器覆盖。）

- **可选值**：任意字符串（无固定枚举）

### `auth.broker.token`

- **作用**：访问远端凭据代理的令牌（凭据，隐藏 UI，env 优先）。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **凭据**：是（`config list` 时脱敏）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `shellPath`

- **作用**：覆盖执行工具调用时使用的默认 shell 可执行文件路径（推断）。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `extensions`

- **作用**：加载的扩展名列表（推断）。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `enabledModels`

- **作用**：在模型选择器中显示并允许使用的模型白名单（推断）。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `disabledProviders`

- **作用**：被禁用、不会出现在选择器中的 provider id 黑名单（推断）。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `disabledExtensions`

- **作用**：即使已加载也要禁用的扩展名黑名单（推断）。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `modelRoles`

- **作用**：role 名到具体模型 id 的映射表，覆盖默认角色绑定（推断）。
- **类型**：`record`
- **默认值**：`{}`
- **功能**：无说明

- **可选值**：任意键值对象（无固定枚举）

### `modelTags`

- **作用**：模型标签元数据（推断）。
- **类型**：`record`
- **默认值**：`{}`
- **功能**：无说明

- **可选值**：任意键值对象（无固定枚举）

### `modelProviderOrder`

- **作用**：provider 在模型选择器中的展示/遍历顺序（推断）。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `cycleOrder`

- **作用**：模型循环键（`smol`/`default`/`slow` 等）切换时的迭代顺序。
- **类型**：`array`
- **默认值**：`["smol","default","slow"]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `statusLine.leftSegments`

- **作用**：状态行左侧按顺序展示的段（id 列表）。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `statusLine.rightSegments`

- **作用**：状态行右侧按顺序展示的段（id 列表）。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `statusLine.segmentOptions`

- **作用**：按段 id 覆写各段的渲染选项（推断）。
- **类型**：`record`
- **默认值**：`{}`
- **功能**：无说明

- **可选值**：任意键值对象（无固定枚举）

### `images.urls.options`

- **作用**：按图片后端覆写其运行参数（推断）。
- **类型**：`record`
- **默认值**：`{}`
- **功能**：无说明

- **可选值**：任意键值对象（无固定枚举）

### `images.urls.credentials`

- **作用**：各图片托管后端的访问凭据（按后端名索引的 key/value 表）。
- **类型**：`record`
- **默认值**：`{}`
- **凭据**：是（`config list` 时脱敏）
- **功能**：无说明

- **可选值**：任意键值对象（无固定枚举）

### `tui.maxInlineImageColumns`

- **作用**：内联图片在终端中所占的最大列宽（推断）。
- **类型**：`number`
- **默认值**：`100`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `tui.maxInlineImageRows`

- **作用**：单张内联图片在终端中所占的最大行数（推断）。
- **类型**：`number`
- **默认值**：`20`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `tui.maxInlineImages`

- **作用**：单次输出中可同时内联显示的最大图片数量（推断）。
- **类型**：`number`
- **默认值**：`8`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `retry.enabled`

- **作用**：是否在请求/工具失败时启用自动重试（推断）。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明。（源码注释：Retries）

- **可选值**：
  - `true`
  - `false`

### `retry.baseDelayMs`

- **作用**：自动重试的初始退避基数（毫秒）。
- **类型**：`number`
- **默认值**：`500`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `stt.language`

- **作用**：语音转写时使用的 BCP-47 语言代码。
- **类型**：`string`
- **默认值**：`"en"`
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `compaction.reserveTokens`

- **作用**：压缩时为响应预留的 token 预算（未设则回退到比例预算）。
- **类型**：`number`
- **默认值**：—（未设默认值）
- **功能**：无说明。（源码注释：无默认值——未设置的 reserve 告诉压缩层用户从未选择过，小窗口恢复可换用比例式 reserve（见 resolveBudgetReserveTokens）。若在此处物化为 16384，会让每个会话看起来都已被显式配置。）

- **可选值**：任意数字（无固定枚举）

### `compaction.keepRecentTokens`

- **作用**：压缩后保留在上下文中的最近消息 token 数量（推断）。
- **类型**：`number`
- **默认值**：`20000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `compaction.autoContinue`

- **作用**：压缩后是否自动继续会话而不要求用户确认（推断）。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `compaction.remoteEndpoint`

- **作用**：把压缩任务卸载到的远端压缩服务地址（推断）。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `compaction.v2RetainedMessageBudget`

- **作用**：v2 流式压缩在内存中保留的消息 token 上限（推断）。
- **类型**：`number`
- **默认值**：`64000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `branchSummary.reserveTokens`

- **作用**：分支摘要生成时为摘要预留的 token 预算（推断）。
- **类型**：`number`
- **默认值**：`16384`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.enabled`

- **作用**：旧版本地记忆开关（仅迁移兼容，应改用 memory.backend）。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：无说明。（源码注释：Memories 旧版本地记忆启用标志，仅为向后兼容迁移而保留。隐藏在 UI 中——用户应改用 `memory.backend`。）

- **可选值**：
  - `true`
  - `false`

### `memories.maxRolloutsPerStartup`

- **作用**：启动时一次性处理的会话 rollout 数量上限（推断）。
- **类型**：`number`
- **默认值**：`64`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.maxRolloutAgeDays`

- **作用**：参与记忆提炼的 rollout 最大存活天数（推断）。
- **类型**：`number`
- **默认值**：`30`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.minRolloutIdleHours`

- **作用**：rollout 在闲置多少小时后才有资格被记忆流水线处理（推断）。
- **类型**：`number`
- **默认值**：`12`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.threadScanLimit`

- **作用**：每条记忆任务扫描的会话消息条目上限（推断）。
- **类型**：`number`
- **默认值**：`300`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.maxRawMemoriesForGlobal`

- **作用**：注入到全局上下文的原始记忆条数上限（推断）。
- **类型**：`number`
- **默认值**：`200`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.stage1Concurrency`

- **作用**：记忆流水线 stage1（抽取/分类）阶段并行任务数（推断）。
- **类型**：`number`
- **默认值**：`8`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.stage1LeaseSeconds`

- **作用**：stage1 任务的工作租约时长（推断）。
- **类型**：`number`
- **默认值**：`120`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.stage1RetryDelaySeconds`

- **作用**：stage1 任务失败后的重试退避秒数（推断）。
- **类型**：`number`
- **默认值**：`120`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.phase2LeaseSeconds`

- **作用**：记忆流水线 stage2（合成/精炼）任务的工作租约时长（推断）。
- **类型**：`number`
- **默认值**：`180`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.phase2RetryDelaySeconds`

- **作用**：stage2 任务失败后的重试退避秒数（推断）。
- **类型**：`number`
- **默认值**：`180`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.phase2HeartbeatSeconds`

- **作用**：stage2 worker 向协调器上报存活心跳的间隔秒数（推断）。
- **类型**：`number`
- **默认值**：`30`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.rolloutPayloadPercent`

- **作用**：rollout 负载在所选模型上下文预算中的占比上限。
- **类型**：`number`
- **默认值**：`0.7`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.phase1InputTokenLimit`

- **作用**：记忆流水线一阶段抽取的逐会话输入 token 上限。
- **类型**：`number`
- **默认值**：`4000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.fallbackTokenLimit`

- **作用**：模型未声明有限上下文窗口时回退的 token 预算。
- **类型**：`number`
- **默认值**：`16000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `memories.summaryInjectionTokenLimit`

- **作用**：注入系统提示的摘要与捕获经验共享的近似 token 上限。
- **类型**：`number`
- **默认值**：`5000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `autolearn.minToolCalls`

- **作用**：自动学习提示前一轮工具调用次数的最低门槛。
- **类型**：`number`
- **默认值**：`5`
- **功能**：无说明（源码注释：Config-file-only knob (numbers without `options` are hidden from the UI).）

- **可选值**：任意数字（无固定枚举）

### `mnemopi.retainEveryNTurns`

- **作用**：Mnemopi 后端两次自动 retain 写入之间的最少用户轮次间隔。
- **类型**：`number`
- **默认值**：`4`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `mnemopi.recallLimit`

- **作用**：注入提示词块的回查记忆最大数量。
- **类型**：`number`
- **默认值**：`8`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `mnemopi.recallContextTurns`

- **作用**：回查查询中包含的先前用户限定轮次数。
- **类型**：`number`
- **默认值**：`3`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `mnemopi.recallMaxQueryChars`

- **作用**：组合回查查询的最大字符长度。
- **类型**：`number`
- **默认值**：`4000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `mnemopi.injectionTokenLimit`

- **作用**：Mnemopi 记忆提示词注入的近似 token 预算。
- **类型**：`number`
- **默认值**：`5000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `mnemopi.debug`

- **作用**：Mnemopi 后端失败时的调试日志开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `hindsight.bankIdPrefix`

- **作用**：Hindsight 派生 bank id 时附加的前缀字符串。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `hindsight.bankMission`

- **作用**：Hindsight 新建 bank 时使用的使命说明。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `hindsight.retainMission`

- **作用**：Hindsight retain 写入时绑定的使命说明。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `hindsight.retainEveryNTurns`

- **作用**：Hindsight 自动 retain 写入之间的最少用户轮次间隔。
- **类型**：`number`
- **默认值**：`3`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `hindsight.retainOverlapTurns`

- **作用**：Hindsight 跨会话 retain 时的重叠轮次数。
- **类型**：`number`
- **默认值**：`2`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `hindsight.retainContext`

- **作用**：Hindsight retain 关联的上下文来源标识（推断）。
- **类型**：`string`
- **默认值**：`"omp"`
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `hindsight.recallBudget`

- **作用**：Hindsight 回查的预算档位（low/mid/high）。
- **类型**：`enum`
- **默认值**：`"mid"`
- **功能**：无说明
- **可选值**：
  - `low`
  - `mid`
  - `high`

### `hindsight.recallMaxTokens`

- **作用**：Hindsight 单次回查返回内容的最大 token 数。
- **类型**：`number`
- **默认值**：`1024`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `hindsight.recallContextTurns`

- **作用**：Hindsight 回查查询中包含的先前用户限定轮次数。
- **类型**：`number`
- **默认值**：`1`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `hindsight.recallMaxQueryChars`

- **作用**：Hindsight 组合回查查询的最大字符长度。
- **类型**：`number`
- **默认值**：`800`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `hindsight.recallTypes`

- **作用**：Hindsight 回查启用的事件类型集合（如 world、experience）。
- **类型**：`array`
- **默认值**：`["world","experience"]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `hindsight.debug`

- **作用**：Hindsight 后端调试日志开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `hindsight.requestTimeoutMs`

- **作用**：Hindsight 通用 HTTP 请求超时（毫秒）。
- **类型**：`number`
- **默认值**：`30000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `hindsight.reflectTimeoutMs`

- **作用**：Hindsight reflect 接口的超时（毫秒）。
- **类型**：`number`
- **默认值**：`120000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `hindsight.recallTimeoutMs`

- **作用**：Hindsight recall 接口的超时（毫秒）。
- **类型**：`number`
- **默认值**：`30000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `hindsight.retainTimeoutMs`

- **作用**：Hindsight retain 接口的超时（毫秒）。
- **类型**：`number`
- **默认值**：`60000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `hindsight.mentalModelRefreshIntervalMs`

- **作用**：Hindsight 心智模型后台刷新间隔（毫秒）。
- **类型**：`number`
- **默认值**：`300000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `hindsight.mentalModelMaxRenderChars`

- **作用**：Hindsight 心智模型渲染的最大字符数。
- **类型**：`number`
- **默认值**：`16000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `bashInterceptor.patterns`

- **作用**：把常见 shell 命令重定向到专用工具的正则规则列表。
- **类型**：`array`
- **默认值**：`[{"pattern":"^\\s*(cat|head|tail|less|more)\\s+","tool":"read","message":"Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files."},{"pattern":"^\\s*(grep|rg|ripgrep|ag|ack)\\s+","tool":"grep","message":"Use the `grep` tool instead of grep/rg. It respects .gitignore and provides structured output."},{"pattern":"^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)","tool":"glob","message":"Use the `glob` tool instead of find/fd. It respects .gitignore and is faster for glob patterns."},{"pattern":"^\\s*sed\\s+(-i|--in-place)","tool":"edit","message":"Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching."},{"pattern":"^\\s*perl\\s+.*-[pn]?i","tool":"edit","message":"Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching."},{"pattern":"^\\s*awk\\s+.*-i\\s+inplace","tool":"edit","message":"Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching."},{"pattern":"^\\s*(echo|printf|cat\\s*<<)\\s+(?:(?:[^\"'>]|\"[^\"]*\"|'[^']*')|(?<!\\|)>{1,2}\\|?\\s*(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))*(?<!\\|)>{1,2}\\|?\\s*(?!(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))[$\\w./~\"'-]","tool":"write","message":"Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation."},{"pattern":"^\\s*nohup\\s+|(?<!&)\\&\\s*$","tool":"hub","message":"Use the `hub` tool (`op:\"start\"`) instead of nohup or background shell syntax so the process stays observable and managed."},{"pattern":"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:dev|start)(?:\\s|$)|(?:vite|next\\s+dev|nuxt\\s+dev|nodemon|lldb|gdb|tail\\s+-f)(?:\\s|$)|docker\\s+compose\\s+up(?!.*(?:\\s-d(?:\\s|$)|--detach))(?:\\s|$))","tool":"hub","message":"Use the `hub` tool (`op:\"start\"`) for services, watchers, and debuggers so other omp instances can observe and control them."},{"pattern":"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?\\S+|cargo\\s+watch|watchexec|pytest|vitest|jest|tsc)(?:.|\\n)*(?:--watch|-w)(?:\\s|$)","tool":"hub","message":"Use the `hub` tool (`op:\"start\"`) for watch mode so its output, input, and lifecycle stay managed."}]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `shellMinimizer.settingsPath`

- **作用**：shell 输出最小化器外部配置文件的路径（推断）。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `shellMinimizer.only`

- **作用**：仅对匹配这些模式启用最小化的白名单。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `shellMinimizer.except`

- **作用**：在最小化中排除的匹配模式黑名单。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `shellMinimizer.maxCaptureBytes`

- **作用**：shell 输出捕获阶段的最大字节数。
- **类型**：`number`
- **默认值**：`4194304`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `shellMinimizer.legacyFilters`

- **作用**：是否启用旧版最小化过滤行为（推断）。
- **类型**：`boolean`
- **默认值**：—（未设默认值）
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `eval.autoBackground.thresholdMs`

- **作用**：eval 工具自动转入后台运行前同步等待的毫秒阈值。
- **类型**：`number`
- **默认值**：`60000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `inspect_image.enabled`

- **作用**：旧版图像检查工具开关（仅迁移兼容，应改用 inspect_image.mode）。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：无说明（源码注释：Legacy boolean kept only for back-compat migration to `inspect_image.mode`\n(see config/settings.ts). Hidden from UI.）

- **可选值**：
  - `true`
  - `false`

### `async.maxJobs`

- **作用**：进程内并发异步任务的最大数量。
- **类型**：`number`
- **默认值**：`100`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `bash.autoBackground.thresholdMs`

- **作用**：Bash 工具自动转入后台运行前同步等待的毫秒阈值。
- **类型**：`number`
- **默认值**：`60000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `task.disabledAgents`

- **作用**：子代理系统中被禁用的代理名称列表。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `task.agentModelOverrides`

- **作用**：按代理名覆盖子代理使用的模型（推断）。
- **类型**：`record`
- **默认值**：`{}`
- **功能**：无说明

- **可选值**：任意键值对象（无固定枚举）

### `task.agentPrewalk`

- **作用**：按代理名（on/off/模型模式）覆盖子代理 prewalk 行为：先在常规模型上规划，再首次编辑/写入时交接给更便宜的 prewalk 目标。
- **类型**：`record`
- **默认值**：`{}`
- **功能**：无说明

- **可选值**：任意键值对象（无固定枚举）

### `task.agentAdvisor`

- **作用**：按代理名（on/off/模型模式）覆盖子代理 advisor 配对，显式模式会作为子会话的 `modelRoles.advisor`。
- **类型**：`record`
- **默认值**：`{}`
- **功能**：无说明

- **可选值**：任意键值对象（无固定枚举）

### `skills.enabled`

- **作用**：技能（Skills）子系统的总开关。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明（源码注释：Skills）

- **可选值**：
  - `true`
  - `false`

### `skills.enableCodexUser`

- **作用**：是否扫描用户级 Codex 技能源（`~/.codex/skills`）。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `skills.enableClaudeUser`

- **作用**：是否扫描用户级 Claude 技能源（`~/.claude/skills`）。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `skills.enableClaudeProject`

- **作用**：是否扫描项目级 Claude 技能源（cwd 向上递归的 `.claude/skills`）。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `skills.enablePiUser`

- **作用**：是否启用用户级原生（native/Pi）技能源（推断）。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `skills.enablePiProject`

- **作用**：是否启用项目级原生（native/Pi）技能源（推断）。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `skills.enableAgentsUser`

- **作用**：是否扫描用户级 OMP 原生 agents 技能源（`~/.agents/skills`）。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `skills.enableAgentsProject`

- **作用**：是否扫描项目级 OMP 原生 agents 技能源（`.agents/skills`）。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `skills.customDirectories`

- **作用**：追加扫描的自定义技能目录列表（非递归 `*/SKILL.md`，优先级高于同名内建来源）。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `skills.ignoredSkills`

- **作用**：按 glob 模式从加载结果中排除的技能名称。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `skills.includeSkills`

- **作用**：技能白名单（glob 模式；空数组表示不限制，按来源开关生效）。
- **类型**：`array`
- **默认值**：`[]`
- **功能**：无说明

- **可选值**：任意字符串数组（无固定枚举）

### `searxng.token`

- **作用**：SearXNG 实例的 bearer 认证令牌（凭据，Basic 凭据优先于它）。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **凭据**：是（`config list` 时脱敏）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `searxng.basicUsername`

- **作用**：SearXNG Basic 认证用户名（与 basicPassword 配对使用，遵循 RFC 7617）。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `searxng.basicPassword`

- **作用**：SearXNG Basic 认证密码（凭据，与 basicUsername 配对使用）。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **凭据**：是（`config list` 时脱敏）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `searxng.categories`

- **作用**：SearXNG 搜索请求附加的逗号分隔分类过滤项。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `searxng.engines`

- **作用**：SearXNG 搜索使用的引擎白名单（逗号分隔的引擎名或 bang 快捷方式，发送为 `engines=` 参数）。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `searxng.language`

- **作用**：SearXNG 搜索的语言代码（如 `en`、`zh-CN`）。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `searxng.safesearch`

- **作用**：SearXNG 安全搜索级别（0=关闭 / 1=中度 / 2=严格）。
- **类型**：`number`
- **默认值**：—（未设默认值）
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `commit.mapReduceEnabled`

- **作用**：提交信息生成时是否对超过阈值的差异启用按文件 map-reduce 分析。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `commit.mapReduceThreshold`

- **作用**：触发 map-reduce 模式的差异包含文件 token 累计阈值。
- **类型**：`number`
- **默认值**：`5000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `commit.mapBatchTokenBudget`

- **作用**：map-reduce 单个 map 批次允许的最大 prompt token 数。
- **类型**：`number`
- **默认值**：`16000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `commit.cacheEnabled`

- **作用**：是否缓存提交信息生成的推理结果。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `commit.cacheTtlDays`

- **作用**：提交信息推理缓存的有效天数（0 表示不过期）。
- **类型**：`number`
- **默认值**：`14`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `commit.changelogMaxDiffChars`

- **作用**：单次 changelog 生成请求喂入的差异最大字符数（超出按长变更截断）。
- **类型**：`number`
- **默认值**：`120000`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `dev.autoqaPush.token`

- **作用**：自动 QA grievance 推送的 bearer 令牌（凭据）。
- **类型**：`string`
- **默认值**：—（未设默认值）
- **凭据**：是（`config list` 时脱敏）
- **功能**：无说明

- **可选值**：任意字符串（无固定枚举）

### `dev.autoqaConsent`

- **作用**：自动 QA grievance 推送的用户同意状态（`unset`/`granted`/`denied`）。
- **类型**：`enum`
- **默认值**：`"unset"`
- **功能**：无说明
- **可选值**：
  - `unset`
  - `granted`
  - `denied`

### `gc.blobs`

- **作用**：`omp gc` 是否执行 blob 清理子动作（删除未被任何会话 JSONL 引用的 `<sha256>[.<ext>]` 文件）。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `gc.archive`

- **作用**：`omp gc` 是否执行冷会话归档子动作（gzip 超过 `coldArchiveAfterDays` 的冷会话）。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `gc.wal`

- **作用**：`omp gc` 是否对 history/model SQLite 跑 WAL checkpoint 子动作。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：无说明

- **可选值**：
  - `true`
  - `false`

### `gc.coldArchiveAfterDays`

- **作用**：会话被视作冷会话、允许归档的最小年龄（天）。
- **类型**：`number`
- **默认值**：`30`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `gc.retainNewestGlobal`

- **作用**：全局始终保留的最新会话数（免于归档）。
- **类型**：`number`
- **默认值**：`20`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `gc.retainNewestPerCwd`

- **作用**：按工作目录始终保留的最新会话数（与全局保留数同时满足才免于归档）。
- **类型**：`number`
- **默认值**：`10`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `thinkingBudgets.minimal`

- **作用**：`minimal` 思考档位对应的 token 预算。
- **类型**：`number`
- **默认值**：`1024`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `thinkingBudgets.low`

- **作用**：`low` 思考档位对应的 token 预算。
- **类型**：`number`
- **默认值**：`2048`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `thinkingBudgets.medium`

- **作用**：`medium` 思考档位对应的 token 预算。
- **类型**：`number`
- **默认值**：`8192`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `thinkingBudgets.high`

- **作用**：`high` 思考档位对应的 token 预算。
- **类型**：`number`
- **默认值**：`16384`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `thinkingBudgets.xhigh`

- **作用**：`xhigh` 思考档位对应的 token 预算。
- **类型**：`number`
- **默认值**：`32768`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）

### `thinkingBudgets.max`

- **作用**：`max` 思考档位对应的 token 预算（顶层档位，通常由 `ultrathink` 触发）。
- **类型**：`number`
- **默认值**：`32768`
- **功能**：无说明

- **可选值**：任意数字（无固定枚举）


## Interaction（交互）


共 44 项。


### `autoResume` — Auto Resume

- **作用**：启动时自动恢复当前目录下最近一次会话
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在当前目录自动恢复最近的会话。

- **可选值**：
  - `true`
  - `false`

### `power.sleepPrevention` — Sleep Prevention

- **作用**：会话活跃期间的 macOS 防睡眠策略（caffeinate 等级）
- **类型**：`enum`
- **默认值**：`"idle"`
- **功能**：在会话活跃期间阻止 macOS 睡眠。每个级别是累积的——会包含所有更低级别的标志。（源码注释：macOS power assertions（caffeinate flags）。在其他平台无效。）
- **可选值**：
  - `off` — 不阻止任何睡眠
  - `idle` — 会话打开期间保持系统清醒（caffeinate -i）
  - `display` — 同时阻止显示器进入空闲睡眠（caffeinate -i -d）
  - `system` — 在交流电源下阻止所有系统睡眠并声明用户活跃（caffeinate -i -d -s -u）

### `git.enabled` — Enable Git Integration

- **作用**：TUI 中是否展示 git 分支、状态与 PR 元数据
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在 TUI 中显示 git 分支、状态与 PR 信息，并监听仓库元数据。

- **可选值**：
  - `true`
  - `false`

### `steeringMode` — Steering Mode

- **作用**：Agent 工作期间排队消息的处理方式（一次性 vs 全部）
- **类型**：`enum`
- **默认值**：`"one-at-a-time"`
- **功能**：在智能体工作期间如何处理排队的消息。

- **可选值**：
  - `all`
  - `one-at-a-time`

### `followUpMode` — Follow-Up Mode

- **作用**：一轮结束后追加 follow-up 消息的派发方式
- **类型**：`enum`
- **默认值**：`"one-at-a-time"`
- **功能**：一轮完成后如何排空跟进消息。

- **可选值**：
  - `all`
  - `one-at-a-time`

### `interruptMode` — Interrupt Mode

- **作用**：steering 消息打断正在执行工具的时机
- **类型**：`enum`
- **默认值**：`"immediate"`
- **功能**：steering 消息在何时中断工具执行。

- **可选值**：
  - `immediate`
  - `wait`

### `loop.mode` — Loop Mode

- **作用**：`/loop` 两次迭代之间对上下文的处理（重提交 / 压缩 / 新会话）
- **类型**：`enum`
- **默认值**：`"prompt"`
- **功能**：`/loop` 迭代之间在重新提交提示前发生什么。
- **可选值**：
  - `prompt` — 把提示作为跟进消息重新提交（当前行为）
  - `compact` — 压缩会话上下文，然后重新提交提示
  - `reset` — 开启一个新会话，然后重新提交提示

### `doubleEscapeAction` — Double-Escape Action

- **作用**：编辑器为空时双击 Escape 触发的动作（树/分支/无）
- **类型**：`enum`
- **默认值**：`"tree"`
- **功能**：在编辑器为空时连按两次 Escape 触发的动作。

- **可选值**：
  - `branch`
  - `tree`
  - `none`

### `treeFilterMode` — Session Tree Filter

- **作用**：打开会话树时的默认过滤模式
- **类型**：`enum`
- **默认值**：`"default"`
- **功能**：打开会话树时的默认过滤模式。

- **可选值**：
  - `default`
  - `no-tools`
  - `user-only`
  - `labeled-only`
  - `all`

### `autocompleteMaxVisible` — Autocomplete Items

- **作用**：自动补全下拉框中可见项的最大数量
- **类型**：`number`
- **默认值**：`10`
- **功能**：自动补全下拉框中显示的最大条目数（3-20）。
- **可选值**：
  - `3` — 3 items
  - `5` — 5 items
  - `7` — 7 items
  - `10` — 10 items
  - `15` — 15 items
  - `20` — 20 items

### `spelling.typoDetection` — Typo Detection (macOS)

- **作用**：是否用 macOS 字典标记提示词中的拼写错误
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：使用当前 macOS 词典在拼写错误的提示词下加标记。
- **条件**：`macOS` 为真时适用

- **可选值**：
  - `true`
  - `false`

### `spelling.autocomplete` — Word Autocomplete (macOS)

- **作用**：是否在编辑时提供 macOS 字典的 Tab 接受式补全
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在编辑框中显示 macOS 词典的单词补全提示，按 Tab 接受。
- **条件**：`macOS` 为真时适用

- **可选值**：
  - `true`
  - `false`

### `spelling.autocorrect` — Autocorrect (macOS)

- **作用**：是否对高置信度拼写自动纠错
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在单词完成后应用高置信度的 macOS 拼写纠正。
- **条件**：`macOS` 为真时适用

- **可选值**：
  - `true`
  - `false`

### `emojiAutocomplete` — Emoji Autocomplete

- **作用**：是否启用 `:name:` 短码与文本表情的 emoji 补全
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：从 `:name:` 短代码推荐 emoji，并展开 `:D`、`:-)` 等文字表情。

- **可选值**：
  - `true`
  - `false`

### `paste.largeMenuThreshold` — Large Paste Menu

- **作用**：触发大粘贴菜单（包裹代码块/XML/存文件）的行数阈值
- **类型**：`number`
- **默认值**：`100`
- **功能**：当粘贴达到这么多行时，提供包裹为代码块、包裹为 XML 标签或保存到文件的菜单。设为 0 关闭菜单（大粘贴仍会折叠为 `[Paste]` 标记）。
- **可选值**：
  - `0` — Off
  - `100` — 100 lines
  - `250` — 250 lines
  - `500` — 500 lines
  - `1000` — 1000 lines

### `startup.quiet` — Quiet Startup

- **作用**：是否跳过欢迎屏与启动状态消息
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：跳过欢迎界面与启动状态信息。

- **可选值**：
  - `true`
  - `false`

### `startup.showSplash` — Show Startup Splash

- **作用**：正常交互启动时是否显示完整动画启动页
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在普通交互式启动（不重跑 setup）时显示完整的动画 setup 启动页。开启 Quiet Startup 时仍会隐藏。

- **可选值**：
  - `true`
  - `false`

### `startup.setupWizard` — Setup Wizard

- **作用**：是否显示新加入的引导步骤（每版本一次）
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在每个 setup 版本中针对新增的引导步骤仅展示一次。

- **可选值**：
  - `true`
  - `false`

### `startup.checkUpdate` — Check for Updates

- **作用**：启动时是否检查 omp 更新
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启动时检查 omp 更新。

- **可选值**：
  - `true`
  - `false`

### `update.channel` — Update Channel

- **作用**：`omp update` 与启动更新检查使用的更新通道
- **类型**：`enum`
- **默认值**：`"stable"`
- **功能**：`omp update` 和启动时更新检查所使用的更新通道。
- **可选值**：
  - `stable` — Stable
  - `canary` — Canary

### `marketplace.autoUpdate` — Marketplace Auto-Update

- **作用**：启动时对插件更新的处理策略（关闭/通知/自动）
- **类型**：`enum`
- **默认值**：`"notify"`
- **功能**：启动时检查插件更新。
- **可选值**：
  - `off` — 不检查插件更新
  - `notify` — 启动时检查，有更新时通知
  - `auto` — 启动时检查并自动安装更新

### `startup.changelogMode` — Startup Changelog

- **作用**：启动时更新日志的展示形式（摘要/完整/隐藏）
- **类型**：`enum`
- **默认值**：`"summary"`
- **功能**：选择更新说明以摘要、完整详情还是隐藏的形式开始显示。
- **可选值**：
  - `summary` — 显示发布与变更数量，并提示 `/changelog`
  - `expanded` — 完整显示最近的发布说明
  - `hidden` — 启动时不显示发布说明

### `magicKeywords.enabled` — Magic Keywords

- **作用**：是否启用 ultrathink、orchestrate、workflowz、fullsend 等魔法关键词
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：为独立的 `ultrathink`、`orchestrate`、`workflowz`、`fullsend` 关键字启用隐藏提示。

- **可选值**：
  - `true`
  - `false`

### `magicKeywords.ultrathink` — Ultrathink Keyword

- **作用**：独立的 `ultrathink` 关键词是否触发最大自动思考与提示
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：允许独立的 `ultrathink` 请求最大自动思考并附加其隐藏提示。

- **可选值**：
  - `true`
  - `false`

### `magicKeywords.orchestrate` — Orchestrate Keyword

- **作用**：独立的 `orchestrate` 关键词是否触发多 Agent 编排提示
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：允许独立的 `orchestrate` 附加其隐藏的多智能体编排提示。

- **可选值**：
  - `true`
  - `false`

### `magicKeywords.workflow` — Workflow Keyword

- **作用**：独立的 `workflowz` 关键词是否触发 eval workflow 提示
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：允许独立的 `workflowz` 附加其隐藏的 eval workflow 提示。

- **可选值**：
  - `true`
  - `false`

### `magicKeywords.fullsend` — Fullsend Keyword

- **作用**：独立的 `fullsend` 关键词是否触发最快且经过验证的执行策略
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：允许独立的 `fullsend` 在不受成本或 token 限制的前提下优先最快的完整、正确、已验证交付；预计同速时优先委派，以子智能体的干净上下文作为质量决胜因素。

- **可选值**：
  - `true`
  - `false`

### `completion.notify` — Completion Notification

- **作用**：Agent 结束一轮时是否发送通知
- **类型**：`enum`
- **默认值**：`"on"`
- **功能**：在智能体完成一轮时进行通知。（源码注释：Notifications。）

- **可选值**：
  - `on`
  - `off`

### `error.notify` — Error Notification

- **作用**：Agent 因错误停止时是否发送通知
- **类型**：`enum`
- **默认值**：`"off"`
- **功能**：在智能体因错误停止时进行通知。

- **可选值**：
  - `on`
  - `off`

### `ask.timeout` — Ask Timeout

- **作用**：`ask` 工具无应答时自动选择推荐项的秒数（0 禁用）
- **类型**：`number`
- **默认值**：`0`
- **功能**：经过这么多秒后自动选择 ask 工具的推荐选项（设为 0 关闭）。
- **可选值**：
  - `0` — Disabled
  - `15` — 15 seconds
  - `30` — 30 seconds
  - `60` — 60 seconds
  - `120` — 120 seconds

### `ask.notify` — Ask Notification

- **作用**：`ask` 工具等待用户输入时是否发送通知
- **类型**：`enum`
- **默认值**：`"on"`
- **功能**：在 ask 工具等待输入时进行通知。

- **可选值**：
  - `on`
  - `off`

### `recap.enabled` — Idle Recap

- **作用**：终端空闲时是否生成 LLM 简明进度回顾
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在终端空闲一段时间后，由 LLM 生成一段当前进展的简要回顾。

- **可选值**：
  - `true`
  - `false`

### `recap.idleSeconds` — Idle Recap Delay

- **作用**：触发空闲回顾前需空闲的秒数
- **类型**：`number`
- **默认值**：`240`
- **功能**：空闲多久后显示 idle recap。
- **可选值**：
  - `60` — 1 minute
  - `120` — 2 minutes
  - `240` — 4 minutes
  - `300` — 5 minutes
  - `600` — 10 minutes

### `collab.relayUrl` — Relay URL

- **作用**：`/collab` 使用的 wss 中继地址
- **类型**：`string`
- **默认值**：`"wss://my.omp.sh"`
- **功能**：`/collab` 使用的 relay（`wss://host[:port]`）。（源码注释：Collab。）

- **可选值**：任意字符串（无固定枚举）

### `collab.webUrl` — Web UI URL

- **作用**：`/collab` 链接打开的浏览器 UI 地址
- **类型**：`string`
- **默认值**：`""`
- **功能**：`/collab` 链接使用的浏览器 UI；为空时从 `collab.relayUrl` 推导；显式 `http://` 仅限 localhost。

- **可选值**：任意字符串（无固定枚举）

### `collab.displayName` — Display Name

- **作用**：协作中向其他参与者展示的显示名
- **类型**：`string`
- **默认值**：`""`
- **功能**：向其他 collab 参与者显示的名称（默认：操作系统用户名）。

- **可选值**：任意字符串（无固定枚举）

### `share.serverUrl` — Share Server

- **作用**：`/share` 上传与查看会话所用的服务端基址
- **类型**：`string`
- **默认值**：`"https://my.omp.sh/s"`
- **功能**：`/share` 使用的分享查看/上传基地址（加密 blob 上传与查看；链接形式为 `<base>/<id>#<key>`）。

- **可选值**：任意字符串（无固定枚举）

### `share.store` — Share Store

- **作用**：`/share` 上传加密会话 blob 的后端（加密 blob / GitHub gist）
- **类型**：`enum`
- **默认值**：`"blob"`
- **功能**：`/share` 把加密会话 blob 上传到何处。
- **可选值**：
  - `blob` — 上传到 share server（无需 GitHub 账号；规避 gist API 限流）
  - `gist` — 推送到私密 gist（需要已认证的 `gh`），失败时回退到 share server

### `share.redactSecrets` — Share Secret Redaction

- **作用**：`/share` 快照上传前是否运行密钥混淆
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在 `/share` 快照上传前对其运行 secret 混淆器（使用 `secrets.*` 配置）。

- **可选值**：
  - `true`
  - `false`

### `stt.enabled` — Speech-to-Text

- **作用**：是否启用麦克风语音转文字输入
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：启用通过麦克风进行语音转文字输入。（源码注释：Speech-to-text。）

- **可选值**：
  - `true`
  - `false`

### `stt.modelName` — Speech Model

- **作用**：本地语音转文字所用的模型（Parakeet/Whisper 各级）
- **类型**：`enum`
- **默认值**：`"parakeet"`
- **功能**：本机端侧语音模型。Parakeet TDT v3（sherpa-onnx）是 SoTA 默认；Whisper base/small/large-v3-turbo 档位（transformers.js）以体积换取多语言覆盖。首次使用时下载。
- **可选值**：
  - `fast` — Whisper base，多语言。最小最快、精度最低。适合低资源机器。
  - `balanced` — Whisper small，多语言。比 Fast 更准，CPU/内存占用仍较轻。
  - `turbo` — Whisper large-v3-turbo，99 种语言。语言覆盖最广，下载大且较慢。
  - `parakeet` — NVIDIA Parakeet TDT 0.6B v3，25 种语言。Open ASR Leaderboard 榜首——精度最佳、解码远快于其他。默认。

### `stt.submitTrigger` — Speech-to-Text Submit Trigger

- **作用**：语音听写自动提交的触发条件（永不/松开/句末/说 submit）
- **类型**：`enum`
- **默认值**：`"never"`
- **功能**：选择语音听写何时自动提交：从不、松手时（2+ 词）、松手且语句完整、或当我说 "submit" 时。
- **可选值**：
  - `never` — 从不自动提交；把听写内容插入并停留在编辑器中
  - `release` — 松手时若语句包含 2 个及以上单词则提交，以避免误发
  - `release-complete` — 松手时若语句以句末标点（. ? ! 等）结尾则提交
  - `say-submit` — 若语句以包含 `submit` 的词结尾则提交（提交前去掉该词）

### `tools.approval` — Tool Approval Policies

- **作用**：逐工具的审批策略覆写（allow/prompt/deny）
- **类型**：`record`
- **默认值**：`{}`
- **功能**：按工具细分的审批策略。设为 `allow` 自动通过、`prompt` 强制确认、`deny` 拒绝。在任何审批模式下都会生效。（源码注释：Tool approval policies。）

- **可选值**：任意键值对象（无固定枚举）

### `tools.approvalMode` — Tool Approval

- **作用**：工具调用的默认审批模式（始终询问/写/全放）
- **类型**：`enum`
- **默认值**：`"yolo"`
- **功能**：工具调用的默认审批行为。"Always ask" 仅自动批准只读工具；"Write" 自动批准读取与工作区写入类工具；"Yolo" 自动批准所有层级，用户策略仍可拦截。
- **可选值**：
  - `always-ask` — 自动批准只读工具；写入与 exec 工具需要确认
  - `write` — 自动批准只读与写入工具；exec 工具（如 bash、eval、browser、task）需要确认
  - `yolo` — 自动批准读取、写入与 exec 工具；用户策略仍可要求确认或阻止调用

### `features.unexpectedStopDetection` — Unexpected Stops

- **作用**：Agent 无可见消息停止时的自动恢复策略（机械重试/小模型分类）
- **类型**：`enum`
- **默认值**：`"mechanical"`
- **功能**：在助手在没有可见消息的情况下停止时自动恢复。Smart 模式还会用一个小模型对纯文本停止进行分类。
- **可选值**：
  - `none` — 禁用
  - `mechanical` — 重试那些没有可见助手消息的停止；不包含工具调用（默认）
  - `smart` — Mechanical 模式 + 用小模型对纯文本停止进行分类


## Model（模型）


共 52 项。


### `advisor.enabled` — Enable Advisor

- **作用**：启用顾问副模型（advisor 角色）被动审查每一轮并注入提示
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes.

- **可选值**：
  - `true`
  - `false`

### `prewalk.enabled` — Enable Prewalk

- **作用**：用强模型制定计划后切到轻量模型执行实现的预走开关
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：Start on the active model, then switch to a fast/cheap model (default the 'smol' role) at the first edit/write after the plan nudge's todo list exists — the strong model plans, commits the todos, and starts the implementation before handing off. Overridable per session with --prewalk / --no-prewalk.

- **可选值**：
  - `true`
  - `false`

### `advisor.syncBacklog` — Advisor Sync Backlog

- **作用**：顾问落后 N 轮时暂停主代理以等待追平的回退深度
- **类型**：`enum`
- **默认值**：`"off"`
- **功能**：Pause the main agent for up to 30 seconds if the advisor falls behind by this many turns. Off disables catch-up delays.
- **可选值**：
  - `off`
  - `1`
  - `3`
  - `5`
- **条件**：`advisorEnabled` 为真时适用

### `advisor.immuneTurns` — Advisor Immune Turns

- **作用**：顾问刚打断后多少轮内改为非打断式路由的免打扰回合数
- **类型**：`number`
- **默认值**：`3`
- **功能**：After an advisor concern or blocker interrupts, route further concerns/blockers non-interruptingly for this many primary turns.
- **可选值**：
  - `0` — Allow every concern/blocker to interrupt.
  - `1` — 1 turn
  - `2` — 2 turns
  - `3` — Default.
  - `4` — 4 turns
  - `5` — 5 turns
- **条件**：`advisorEnabled` 为真时适用

### `modelRoleStorage` — Model Role Storage

- **作用**：模型选择器的角色绑定写入全局配置还是项目配置
- **类型**：`enum`
- **默认值**：`"global"`
- **功能**：Where model selector role assignments are saved
- **可选值**：
  - `global`
  - `project`

### `images.describeForTextModels` — Describe Images for Text Models

- **作用**：无视觉模型收到图片时改由视觉模型生成描述并注入的降级
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：When an image is attached to a model without vision support, save it under local:// and inject a description from a vision-capable model instead of dropping it

- **可选值**：
  - `true`
  - `false`

### `images.urls.enabled` — Serve Images as URLs

- **作用**：把外发图片发布为短链接而非内联 base64 的总开关
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：Publish outgoing images through the configured backend chain and send URL-fetching providers short URLs instead of inline base64. Falls back to inline automatically when every backend or a provider fetch fails

- **可选值**：
  - `true`
  - `false`

### `images.urls.backends` — Image URL Backends

- **作用**：发布图片到公网时按序尝试的后端链路
- **类型**：`array`
- **默认值**：`["provider-files","tailscale","cloudflared","litterbox"]`
- **功能**：Ordered destinations tried when publishing images for provider access
- **可选值**：
  - `imgur` — Uploads require either an Imgur access token or client ID.
  - `imageshack` — The API requires a paid subscription.
  - `flickr` — image-host
  - `chevereto` — self-hosted
  - `vgyme` — image-host
  - `dropbox` — cloud-files
  - `ftp` — file-transfer
  - `onedrive` — cloud-files
  - `google-drive` — cloud-files
  - `puush` — The public service is defunct; a replacement endpoint is required.
  - `box` — cloud-files
  - `amazon-s3` — s3
  - `google-cloud-storage` — object-storage
  - `azure-storage` — object-storage
  - `backblaze-b2` — Configure either native B2 application keys or S3-compatible access keys.
  - `owncloud` — webdav
  - `mediafire` — The public API is deprecated; a replacement endpoint is required.
  - `sendspace` — The public discovery API is deprecated; a replacement endpoint is required.
  - `localhostr` — The public service is offline; a replacement endpoint is required.
  - `lambda` — The public service is offline; a replacement endpoint is required.
  - `pomf` — pomf
  - `uguu` — Public uploads expire after approximately three hours.
  - `seafile` — cloud-files
  - `s-ul` — file-host
  - `lobfile` — The public service is offline; a replacement endpoint is required.
  - `transfer-sh` — The defunct public endpoint is blocked; a self-hosted replacement is required.
  - `plik` — self-hosted
  - `shared-folder` — filesystem
  - `catbox` — anonymous-host
  - `litterbox` — Uploads are temporary.
  - `0x0` — Public uploads expire after a retention window determined by file size.
  - `tmpfiles` — Public uploads are temporary.
  - `discord` — messaging
  - `provider-files` — Provider file references are API-local rather than public image URLs.
  - `direct` — local-serving
  - `cloudflared` — tunnel
  - `ngrok` — tunnel
  - `tailscale` — tunnel
  - `ssh` — tunnel
  - `command` — external-command
  - `localhost-run` — tunnel
  - `pinggy` — tunnel
  - `devtunnel` — The devtunnel CLI must be logged in locally.
  - `zrok` — The local zrok environment must be enabled.
  - `bore` — tunnel
  - `named-cloudflared` — tunnel
  - `r2` — s3
  - `tigris` — s3
  - `minio` — s3
  - `garage` — s3
- **有序**：是（顺序有意义）

### `images.urls.command` — Image Upload Command

- **作用**：command 后端使用的外部上传命令模板（占位符替换文件名/扩展名）
- **类型**：`string`
- **默认值**：`—（未设默认值）`
- **功能**：Argv template for the command backend; {file} is the image path, {mime}/{ext} optional. The last URL printed on stdout is used (e.g. pasta -b -f {file})

- **可选值**：任意字符串（无固定枚举）

### `images.urls.publicBaseUrl` — Image URL Public Base

- **作用**：本地图片服务对外可访问的基础 URL（直连或 SSH 反向转发所需）
- **类型**：`string`
- **默认值**：`—（未设默认值）`
- **功能**：Externally reachable base URL fronting the blob server (required for ssh, optional for direct)

- **可选值**：任意字符串（无固定枚举）

### `images.urls.ttlHours` — Image URL Lifetime (hours)

- **作用**：本地图片链接在最后一次发送后的存活小时数（0 表示随代理常驻）
- **类型**：`number`
- **默认值**：`72`
- **功能**：Serving window for locally hosted image URLs, measured from the last time a conversation sent them; resuming a conversation re-arms the window at the same link. 0 keeps links alive while the broker runs

- **可选值**：任意数字（无固定枚举）

### `images.urls.bindHost` — Image URL Bind Host

- **作用**：本地图片服务绑定的监听地址（回环给隧道，0.0.0.0 给直连）
- **类型**：`string`
- **默认值**：`"127.0.0.1"`
- **功能**：Host the blob server binds to; loopback for tunnels, 0.0.0.0 for direct serving

- **可选值**：任意字符串（无固定枚举）

### `images.urls.sshTarget` — Image URL SSH Target

- **作用**：SSH 反向端口转发所使用的 user@host 目标
- **类型**：`string`
- **默认值**：`—（未设默认值）`
- **功能**：user@host destination for the ssh reverse forward

- **可选值**：任意字符串（无固定枚举）

### `images.urls.sshRemotePort` — Image URL SSH Remote Port

- **作用**：SSH 反向转发中远端 Web 服务对外监听的端口
- **类型**：`number`
- **默认值**：`8787`
- **功能**：Remote listen port of the ssh reverse forward that your web server proxies to

- **可选值**：任意数字（无固定枚举）

### `defaultThinkingLevel` — Thinking Level

- **作用**：支持思考的模型的默认推理深度档位
- **类型**：`enum`
- **默认值**：`"high"`
- **功能**：Reasoning depth for thinking-capable models
- **可选值**：
  - `minimal`
  - `low`
  - `medium`
  - `high`
  - `xhigh`
  - `max`
  - `auto`

### `hideThinkingBlock` — Hide Thinking Blocks

- **作用**：在助手回复中隐藏思考块的展示开关
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：Hide thinking blocks in assistant responses

- **可选值**：
  - `true`
  - `false`

### `proseOnlyThinking` — Prose Only Thinking

- **作用**：思考摘要中省略代码块并替换成省略号（仅保留散文）
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：Omit code blocks from thinking summaries and replace them with an ellipsis

- **可选值**：
  - `true`
  - `false`

### `omitThinking` — Omit Thinking summaries

- **作用**：请求上游提供商在响应里完全省略思考摘要（依提供商支持）
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：Instruct upstream providers to completely omit thinking summaries from responses (where supported)

- **可选值**：
  - `true`
  - `false`

### `externalThinking` — External Thinking

- **作用**：使用私有外部草稿区作为思考笔记（关闭 GPT/Claude/Gemini 官方推理）
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：Private scratchpad; not shown to user. Disables supported GPT, Claude, and Gemini reasoning

- **可选值**：
  - `true`
  - `false`

### `model.loopGuard.enabled` — Loop Guard

- **作用**：对模型推理与正文流启用自动循环检测的总开关
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：Enable automatic stream loop detection for model reasoning and prose

- **可选值**：
  - `true`
  - `false`

### `model.loopGuard.checkAssistantContent` — Loop Guard Scan Prose

- **作用**：循环检测是否同时扫描助手散文输出（而非仅思考日志）
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：Apply loop guard to assistant prose messages in addition to thinking logs

- **可选值**：
  - `true`
  - `false`

### `model.loopGuard.toolCallReminder` — Loop Guard Tool-Call Reminder

- **作用**：Gemini 推理长时间只规划不调工具时插入提醒的开关
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：When a Gemini reasoning stream emits many consecutive planning headers without calling a tool, interrupt it and inject a reminder to issue a tool call (requires Loop Guard)

- **可选值**：
  - `true`
  - `false`

### `model.toolCallLoopGuard.enabled` — Tool-Call Loop Guard

- **作用**：跨回合检测相同工具重复调用并注入纠正的开关
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：Detect consecutive identical tool calls across turns and inject a corrective steer

- **可选值**：
  - `true`
  - `false`

### `model.toolCallLoopGuard.threshold` — Tool-Call Loop Threshold

- **作用**：触发工具调用循环纠正所需的连续相同调用次数
- **类型**：`number`
- **默认值**：`5`
- **功能**：Consecutive identical tool calls required before the corrective steer is injected

- **可选值**：任意数字（无固定枚举）

### `model.toolCallLoopGuard.exemptTools` — Tool-Call Loop Exempt Tools

- **作用**：豁免于跨回合工具调用循环检测的工具名清单
- **类型**：`array`
- **默认值**：`["hub"]`
- **功能**：Tool names that may repeat consecutively without triggering the cross-turn loop guard

- **可选值**：任意字符串数组（无固定枚举）

### `inlineToolDescriptors` — Inline Tool Descriptors

- **作用**：把工具描述直接渲染进系统提示并从工具 schema 剥离以避免重复
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once. Auto enables this for Gemini models and disables it otherwise
- **可选值**：
  - `auto`
  - `on`
  - `off`

### `includeModelInPrompt` — Include Model in Prompt

- **作用**：在系统提示中向代理暴露当前所用模型标识
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：Surface the active model identifier in the system prompt so the agent knows which model it is

- **可选值**：
  - `true`
  - `false`

### `includeWorkspaceTree` — Include Workspace Tree

- **作用**：在系统提示中渲染工作区目录树（会破坏跨会话提示缓存）
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：Render the workspace directory tree in the system prompt. WARNING: This can bust prompt caching across sessions when files are modified.

- **可选值**：
  - `true`
  - `false`

### `personality` — Personality

- **作用**：写入系统提示人格段落的沟通风格预设
- **类型**：`enum`
- **默认值**：`"default"`
- **功能**：Communication style rendered into the system prompt's personality block
- **可选值**：
  - `default`
  - `friendly`
  - `pragmatic`
  - `none`

### `temperature` — Temperature

- **作用**：采样温度（-1 表示沿用提供商默认值）
- **类型**：`number`
- **默认值**：`-1`
- **功能**：Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)
- **可选值**：
  - `-1` — Use provider default
  - `0` — Deterministic
  - `0.2` — Focused
  - `0.5` — Balanced
  - `0.7` — Creative
  - `1` — Maximum variety

### `topP` — Top P

- **作用**：核采样截断阈值（-1 表示沿用提供商默认值）
- **类型**：`number`
- **默认值**：`-1`
- **功能**：Nucleus sampling cutoff (0-1, -1 = provider default)
- **可选值**：
  - `-1` — Use provider default
  - `0.1` — Very focused
  - `0.3` — Focused
  - `0.5` — Balanced
  - `0.9` — Broad
  - `1` — No nucleus filtering

### `topK` — Top K

- **作用**：仅从概率最高的 K 个 token 中采样（-1 表示沿用提供商默认值）
- **类型**：`number`
- **默认值**：`-1`
- **功能**：Sample from top-K tokens (-1 = provider default)
- **可选值**：
  - `-1` — Use provider default
  - `1` — Greedy top token
  - `20` — Focused
  - `40` — Balanced
  - `100` — Broad

### `minP` — Min P

- **作用**：采样允许的最小概率阈值（-1 表示沿用提供商默认值）
- **类型**：`number`
- **默认值**：`-1`
- **功能**：Minimum probability threshold (0-1, -1 = provider default)
- **可选值**：
  - `-1` — Use provider default
  - `0.01` — Very permissive
  - `0.05` — Balanced
  - `0.1` — Strict

### `presencePenalty` — Presence Penalty

- **作用**：对已出现过的 token 施加出现惩罚（-1 表示沿用提供商默认值）
- **类型**：`number`
- **默认值**：`-1`
- **功能**：Penalty for introducing already-present tokens (-1 = provider default)
- **可选值**：
  - `-1` — Use provider default
  - `0` — No penalty
  - `0.5` — Mild novelty
  - `1` — Encourage novelty
  - `2` — Strong novelty

### `repetitionPenalty` — Repetition Penalty

- **作用**：对重复出现的 token 施加的重复惩罚（-1 表示沿用提供商默认值）
- **类型**：`number`
- **默认值**：`-1`
- **功能**：Penalty for repeated tokens (-1 = provider default)
- **可选值**：
  - `-1` — Use provider default
  - `0.8` — Allow repetition
  - `1` — No penalty
  - `1.1` — Mild penalty
  - `1.2` — Balanced
  - `1.5` — Strong penalty

### `textVerbosity` — Text Verbosity

- **作用**：OpenAI Responses / Codex 响应的详细程度档位
- **类型**：`enum`
- **默认值**：`"medium"`
- **功能**：OpenAI Responses and Codex response verbosity (low, medium, or high)
- **可选值**：
  - `low`
  - `medium`
  - `high`

### `tier.openai` — Service Tier — OpenAI

- **作用**：OpenAI 与 OpenAI 家族模型的服务层级（service_tier）
- **类型**：`enum`
- **默认值**：`"none"`
- **功能**：Processing tier for OpenAI / OpenAI-Codex requests, and OpenAI-family models routed via OpenRouter (none = omit). Sent as `service_tier`.
- **可选值**：
  - `none`
  - `auto`
  - `default`
  - `flex`
  - `scale`
  - `priority`

### `tier.anthropic` — Service Tier — Anthropic

- **作用**：直接调用 Claude 时的服务层级（priority 即 fast 模式）
- **类型**：`enum`
- **默认值**：`"none"`
- **功能**：Processing tier for Claude requests. `priority` realizes fast mode (`speed: "fast"`) on supported direct Anthropic models; ignored on Bedrock/Vertex Claude and via OpenRouter.
- **可选值**：
  - `none`
  - `priority`

### `tier.google` — Service Tier — Google

- **作用**：Gemini（AI Studio + Vertex）请求的服务层级
- **类型**：`enum`
- **默认值**：`"none"`
- **功能**：Processing tier for Gemini (Google AI Studio + Vertex) requests, and Google-family models routed via OpenRouter (none = omit). Sent as the top-level `serviceTier` field.
- **可选值**：
  - `none`
  - `flex`
  - `priority`

### `tier.subagent` — Service Tier — Subagent

- **作用**：派生的 task/eval 子代理沿用的服务层级（inherit 跟随主代理实时档位）
- **类型**：`enum`
- **默认值**：`"inherit"`
- **功能**：Service Tier for spawned task/eval subagents. Inherit = match the main agent's live per-family tiers (tracks /fast); pick a value to apply it to whichever family the subagent's model belongs to.
- **可选值**：
  - `inherit`
  - `none`
  - `auto`
  - `default`
  - `flex`
  - `scale`
  - `priority`

### `tier.advisor` — Service Tier — Advisor

- **作用**：顾问模型所使用的服务层级
- **类型**：`enum`
- **默认值**：`"none"`
- **功能**：Service Tier for the advisor model. None = standard processing; Inherit = match the main agent's live per-family tiers; pick a value to apply it to the advisor model's family.
- **可选值**：
  - `inherit`
  - `none`
  - `auto`
  - `default`
  - `flex`
  - `scale`
  - `priority`
- **条件**：`advisorEnabled` 为真时适用

### `retry.maxRetries` — Retry Attempts

- **作用**：API 错误时的最大重试次数
- **类型**：`number`
- **默认值**：`10`
- **功能**：Maximum retry attempts on API errors
- **可选值**：
  - `1` — 1 retry
  - `2` — 2 retries
  - `3` — 3 retries
  - `5` — 5 retries
  - `10` — 10 retries

### `retry.maxDelayMs` — Max Retry Delay

- **作用**：两次重试之间的最大等待毫秒数（0 表示不设上限，依赖配额恢复）
- **类型**：`number`
- **默认值**：`300000`
- **功能**：Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows). 0 disables the ceiling — to let the session auto-resume through provider-stated quota resets.

- **可选值**：任意数字（无固定枚举）

### `retry.modelFallback` — Retry Model Fallback

- **作用**：重试恢复时允许切换到已配置回退模型的总开关
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：Allow retry recovery to switch to configured fallback models

- **可选值**：
  - `true`
  - `false`

### `retry.usageAwareFallback` — Usage-Aware Fallback

- **作用**：依据 coding-plan 配额报告优先同 provider 账户再回退的感知策略
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：Use reliable coding-plan quota reports to prefer same-provider accounts, then configured fallback models, before a hard usage limit. Ordinary configured API keys are excluded.

- **可选值**：
  - `true`
  - `false`

### `retry.usageReservePct` — Reserve Margin

- **作用**：剩余配额低于该百分比即视为接近上限的回退保护阈值
- **类型**：`number`
- **默认值**：`10`
- **功能**：Treat a coding-plan model as near its limit below this remaining percentage. Unknown or unmapped usage keeps the primary model.
- **可选值**：
  - `5` — Act only when nearly exhausted
  - `10` — Balanced safety margin
  - `15` — Conservative
  - `20` — Early protection
  - `25` — Very conservative
- **条件**：`usageAwareFallbackEnabled` 为真时适用

### `retry.usageReservePolicy` — Reserve Policy

- **作用**：同 provider 账户全部进入保留区时的处理策略（确认/自动/拒绝）
- **类型**：`enum`
- **默认值**：`"confirm"`
- **功能**：What to do when every same-provider coding-plan account is inside the reserve margin.
- **可选值**：
  - `confirm`
  - `auto`
  - `fail-closed`
- **条件**：`usageAwareFallbackEnabled` 为真时适用

### `retry.fallbackChains` — Retry Fallback Chains

- **作用**：按模型角色、选择器或 provider 通配符配置的有序回退链映射
- **类型**：`record`
- **默认值**：`{}`
- **功能**：JSON object mapping model roles, model selectors ("provider/model-id"), or provider wildcards ("provider/*") to ordered fallback selectors, e.g. {"default":["openai/gpt-4o-mini"],"google-antigravity/*":["google/*","google-vertex/*"]}. Model-oriented keys apply whenever that model/provider is active, regardless of role; a "provider/*" entry keeps the failing model's id and swaps the provider. An id-prefixed wildcard ("openrouter/google/*") re-prefixes the failing model's bare id (google-antigravity/gemini-x -> openrouter/google/gemini-x) and, used as a key, matches only that provider's ids under the prefix.

- **可选值**：任意键值对象（无固定枚举）

### `retry.fallbackRevertPolicy` — Fallback Revert Policy

- **作用**：触发回退后何时切回主模型的策略（冷却结束或永不）
- **类型**：`enum`
- **默认值**：`"cooldown-expiry"`
- **功能**：When to return to the primary model after a fallback
- **可选值**：
  - `cooldown-expiry`
  - `never`

### `providers.anthropic.serverSideFallback` — Anthropic Server-Side Fallback (Fable 5)

- **作用**：Claude Fable 5/Mythos 5 被安全分类器拦截时由 Anthropic 端回退到 Opus 4.8
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：When a Claude Fable 5 / Mythos 5 request is blocked by Anthropic's safety classifier, retry it on Claude Opus 4.8 server-side (Anthropic `server-side-fallback-2026-06-01` beta). Opt-in — leaving this off preserves the pre-fallback behavior for every request.

- **可选值**：
  - `true`
  - `false`

### `providers.autoThinkingModel` — Auto Thinking Model

- **作用**：`auto` 思考档位所用的难度分类器（在线 TINY 角色或本地小模型）
- **类型**：`enum`
- **默认值**：`"online"`
- **功能**：Difficulty classifier for the `auto` thinking level: online (the TINY role from /models, else smol) by default, or a local on-device model
- **可选值**：
  - `online`
  - `qwen3-1.7b`
  - `llama3.2:3b`
  - `gemma-3-1b`
  - `qwen2.5-1.5b`
  - `lfm2-1.2b`
- **条件**：`autoThinkingActive` 为真时适用

### `providers.autoThinkingMaxEffort` — Auto Thinking Ceiling

- **作用**：`auto` 分类器可解析到的最高推理档位上限
- **类型**：`enum`
- **默认值**：`"xhigh"`
- **功能**：Highest effort the `auto` classifier may resolve. `xhigh` keeps the classifier one tier below the top, so only an explicit `ultrathink` reaches `max`; `max` lets a turn the classifier judges exceptional bill the top tier on models that expose it.
- **可选值**：
  - `xhigh`
  - `max`
- **条件**：`autoThinkingActive` 为真时适用


## Providers（提供方）


共 39 项。


### `providers.maxInFlightRequests` — Max In-Flight Requests

- **作用**：按 provider id 维度限制共享同一配置根的本地 OMP 进程并发 LLM 请求数（性能调优）
- **类型**：`record`
- **默认值**：`{}`
- **功能**：按 provider id（如 `openai` 或 `anthropic`）的最大并发 LLM 请求数，在共享该 config root 的本地 OMP 进程间共用。未列出的 provider 不设上限。

- **可选值**：任意键值对象（无固定枚举）

### `providers.openai-codex.codeMode` — Codex Code Mode

- **作用**：Codex Code Mode 路由开关，控制 code_mode_only 模型（GPT-5.6）走 eval 工具集
- **类型**：`enum`
- **默认值**：`"off"`
- **功能**：将 Codex `code_mode_only` 模型（GPT-5.6）路由到 eval。直接工具有 eval、ask、todo、yield、think、checkpoint 和 rewind。其他会话工具请用 eval 单元。对应 codex-rs 的 Code Mode。`auto` 跟随模型目录标志。
- **可选值**：
  - `off` — 关闭 Code Mode 路由
  - `on` — 始终将 Codex `code_mode_only` 模型路由到 eval
  - `auto` — 跟随模型目录标志决定是否启用

### `providers.openai-codex.codeModeDirectTools` — Codex Code Mode Direct Tools

- **作用**：Codex Code Mode 模式下补充暴露给模型直接调用的工具列表
- **类型**：`array`
- **默认值**：`[]`
- **功能**：Codex Code Mode 的额外直接工具。标准直接工具为 eval、ask、todo、yield、think、checkpoint 和 rewind。

- **可选值**：任意字符串数组（无固定枚举）

### `secrets.enabled` — Hide Secrets

- **作用**：对已配置的密钥做混淆、并对发往 AI provider 的凭据形 token 进行脱敏
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在向 AI provider 发送前混淆已配置的 secrets，并对形如凭据的 token 做脱敏。

- **可选值**：
  - `true`
  - `false`

### `providers.ollama-cloud.maxConcurrency` — Ollama Cloud Max Concurrency

- **作用**：单进程内 Ollama Cloud 子代理运行的最大并发数（0 表示不限）
- **类型**：`number`
- **默认值**：`3`
- **功能**：每个进程的最大并发 Ollama Cloud 子代理运行数；`0` 表示禁用该 provider 的专属限制。

- **可选值**：任意数字（无固定枚举）

### `providers.webSearchOrder` — Web Search Provider Order

- **作用**：web_search 工具的 provider 优先级排序（未列出的仍按默认顺序回退）
- **类型**：`array`
- **默认值**：`[]`
- **有序**：是（顺序有意义）
- **功能**：`web_search` 工具的优先 provider；未列出的 provider 之后保持其默认顺序。
- **可选值**：
  - `perplexity` — 配置了凭据时使用；显式选择时回退到匿名搜索
  - `gemini` — 通过 Gemini 的 Google Search grounding（使用 `google-gemini-cli` 或 `google-antigravity` OAuth）
  - `anthropic` — Claude 原生 `web_search` 工具（使用 Anthropic OAuth 或 `ANTHROPIC_API_KEY`）
  - `codex` — OpenAI 原生 `web_search`（通过 `/login openai-codex` 使用 ChatGPT OAuth）
  - `xai` — 通过 xAI Responses API 的 Grok Web 搜索（通过 `/login xai-oauth` 使用 SuperGrok/X Premium+ OAuth，或 `XAI_API_KEY`）
  - `zai` — 调用 Z.AI `webSearchPrime` MCP
  - `exa` — 通过 `/login exa` 或 `EXA_API_KEY`；支持通过 MCP 的显式无 key 回退
  - `tinyfish` — 需要 `TINYFISH_API_KEY`
  - `jina` — 需要 `JINA_API_KEY`
  - `kagi` — 需要 `KAGI_API_KEY` 及 Kagi Search API beta 访问权限
  - `tavily` — 需要 `TAVILY_API_KEY`
  - `firecrawl` — 设置 `FIRECRAWL_API_KEY` 时使用 Firecrawl API；否则回退到无 key 模式
  - `brave` — 需要 `BRAVE_API_KEY`
  - `kimi` — Kimi Code 搜索（需要通过 `KIMI_SEARCH_API_KEY`/`MOONSHOT_SEARCH_API_KEY` 或 `/login kimi-code` 提供的 Kimi Code Console key；不是 `MOONSHOT_API_KEY`）
  - `parallel` — 需要 `PARALLEL_API_KEY`
  - `synthetic` — 需要 `SYNTHETIC_API_KEY`
  - `searxng` — 需要 `SEARXNG_ENDPOINT` 或 `searxng.endpoint`
  - `startpage` — 无凭据抓取 Startpage（Google 支持）的结果；可能遇到机器人校验
  - `duckduckgo` — 无凭据尽力回退；在数据中心/共享出口 IP 上可能遇到机器人校验
  - `ecosia` — 无凭据、基于浏览器的 Ecosia（Google 支持）结果抓取
  - `google` — 无凭据、基于浏览器的回退；较慢且可能遇到机器人校验
  - `mojeek` — 无凭据、基于浏览器的 Mojeek 独立索引抓取
  - `public` — 并行查询所有无凭据引擎并合并去重结果

### `providers.webSearchExclude` — Excluded Web Search Providers

- **作用**：web_search 永远不使用的 provider 黑名单（含回退路径也禁用）
- **类型**：`array`
- **默认值**：`[]`
- **功能**：`web_search` 永不使用的 provider，即使作为回退也不行。
- **可选值**：
  - `perplexity` — 配置了凭据时使用；显式选择时回退到匿名搜索
  - `gemini` — 通过 Gemini 的 Google Search grounding（使用 `google-gemini-cli` 或 `google-antigravity` OAuth）
  - `anthropic` — Claude 原生 `web_search` 工具（使用 Anthropic OAuth 或 `ANTHROPIC_API_KEY`）
  - `codex` — OpenAI 原生 `web_search`（通过 `/login openai-codex` 使用 ChatGPT OAuth）
  - `xai` — 通过 xAI Responses API 的 Grok Web 搜索（通过 `/login xai-oauth` 使用 SuperGrok/X Premium+ OAuth，或 `XAI_API_KEY`）
  - `zai` — 调用 Z.AI `webSearchPrime` MCP
  - `exa` — 通过 `/login exa` 或 `EXA_API_KEY`；支持通过 MCP 的显式无 key 回退
  - `tinyfish` — 需要 `TINYFISH_API_KEY`
  - `jina` — 需要 `JINA_API_KEY`
  - `kagi` — 需要 `KAGI_API_KEY` 及 Kagi Search API beta 访问权限
  - `tavily` — 需要 `TAVILY_API_KEY`
  - `firecrawl` — 设置 `FIRECRAWL_API_KEY` 时使用 Firecrawl API；否则回退到无 key 模式
  - `brave` — 需要 `BRAVE_API_KEY`
  - `kimi` — Kimi Code 搜索（需要通过 `KIMI_SEARCH_API_KEY`/`MOONSHOT_SEARCH_API_KEY` 或 `/login kimi-code` 提供的 Kimi Code Console key；不是 `MOONSHOT_API_KEY`）
  - `parallel` — 需要 `PARALLEL_API_KEY`
  - `synthetic` — 需要 `SYNTHETIC_API_KEY`
  - `searxng` — 需要 `SEARXNG_ENDPOINT` 或 `searxng.endpoint`
  - `startpage` — 无凭据抓取 Startpage（Google 支持）的结果；可能遇到机器人校验
  - `duckduckgo` — 无凭据尽力回退；在数据中心/共享出口 IP 上可能遇到机器人校验
  - `ecosia` — 无凭据、基于浏览器的 Ecosia（Google 支持）结果抓取
  - `google` — 无凭据、基于浏览器的回退；较慢且可能遇到机器人校验
  - `mojeek` — 无凭据、基于浏览器的 Mojeek 独立索引抓取
  - `public` — 并行查询所有无凭据引擎并合并去重结果

### `providers.webSearchTimeoutSeconds` — Web Search Timeout

- **作用**：单个 web_search provider 单次请求的硬超时（秒），超时后切到下一回退
- **类型**：`number`
- **默认值**：`60`
- **功能**：每个 provider 搜索传输的硬超时（秒），超时后 `web_search` 推进到下一个回退，最大 300。
- **可选值**：
  - `30` — 30 seconds
  - `60` — 1 minute
  - `120` — 2 minutes
  - `180` — 3 minutes
  - `300` — 5 minutes

### `providers.webSearchGeminiModel` — Gemini web_search model

- **作用**：Gemini Google Search grounding 调用的模型 ID（默认 gemini-2.5-flash）
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：用于 Gemini Google Search grounding 的模型 ID。默认 `gemini-2.5-flash`。

- **可选值**：任意字符串（无固定枚举）

### `providers.antigravityEndpoint` — Antigravity Endpoint Mode

- **作用**：google-antigravity provider 的端点路由策略（生产/沙箱/自动故障转移）
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：`google-antigravity` provider（chat、search、image、discovery）的端点路由策略。
- **可选值**：
  - `auto` — 尝试 production 端点，遇到 5xx/429 时回退到 sandbox
  - `production` — 仅强制使用 production 端点
  - `sandbox` — 仅强制使用 sandbox 端点

### `providers.imageOrder` — Image Provider Order

- **作用**：图像生成 provider 的优先级排序
- **类型**：`array`
- **默认值**：`[]`
- **有序**：是（顺序有意义）
- **功能**：图像生成的优先 provider；未列出的 provider 跟随当前会话的 provider 及内置顺序。
- **可选值**：
  - `openai` — `OPENAI_API_KEY`（`gpt-image-2`）或当前 GPT 模型；回退到已连接的 Codex 订阅
  - `openai-codex` — 使用已连接的 Codex / ChatGPT 订阅，无需 `OPENAI_API_KEY`
  - `antigravity` — 需要 `google-antigravity` OAuth
  - `xai` — 需要 xAI Grok OAuth 或 `XAI_API_KEY`
  - `gemini` — 需要 `GEMINI_API_KEY`
  - `openrouter` — 需要 `OPENROUTER_API_KEY`
  - `deepinfra` — 需要 `DEEPINFRA_API_KEY`

### `providers.fireworksTier` — Fireworks Tier

- **作用**：Fireworks 请求的 serving 路径（standard / 付费 priority 高可靠）
- **类型**：`enum`
- **默认值**：`"standard"`
- **功能**：Fireworks 请求的服务路径。Priority 发送 `service_tier: "priority"`，峰值流量下可靠性更高、单价更高；Standard 不发送。Fast（`-fast`）模型忽略该选项——Fast 是独立的服务路径。
- **可选值**：
  - `standard` — 默认服务路径（不发送 `service_tier`）
  - `priority` — Priority 服务路径：更高可靠性、溢价按 token 定价

### `live.voice` — Live Voice

- **作用**：Codex 实时语音会话使用的嗓音
- **类型**：`enum`
- **默认值**：`"sol"`
- **功能**：Codex 支持的实时语音会话所使用的语音。
- **可选值**：
  - `arbor` — Arbor
  - `breeze` — Breeze
  - `cove` — Cove
  - `ember` — Ember
  - `juniper` — Juniper
  - `maple` — Maple
  - `sol` — Sol
  - `spruce` — Spruce
  - `vale` — Vale

### `providers.tts` — Text-to-Speech Provider

- **作用**：tts 工具的后端选择（本地 Kokoro / xAI Grok Voice / DeepInfra）
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：`tts` 工具的后端：本地端侧神经 TTS（Kokoro-82M）、xAI Grok Voice 或 DeepInfra speech。
- **可选值**：
  - `auto` — 优先使用本地端侧 TTS；当存在凭据时将 `.mp3` 输出路由到 xAI
  - `local` — 端侧神经 TTS（Kokoro-82M）；输出为 WAV/PCM16
  - `xai` — 需要 xAI Grok OAuth 或 `XAI_API_KEY`；MP3 或 WAV
  - `deepinfra` — 需要 `DEEPINFRA_API_KEY`；MP3 或 WAV

### `tts.localModel` — Local TTS Model

- **作用**：本地 TTS 后端使用的神经语音模型（当前为 Kokoro-82M）
- **类型**：`enum`
- **默认值**：`"kokoro"`
- **功能**：本地 TTS 后端使用的端侧神经 TTS 模型（Kokoro-82M）。
- **可选值**：
  - `kokoro` — Kokoro-82M 神经 TTS——端侧 SOTA 质量，多语音，完全本地

### `tts.localVoice` — Local TTS Voice

- **作用**：本地 TTS 后端使用的 Kokoro 嗓音（美式/英式，男声/女声）
- **类型**：`enum`
- **默认值**：`"af_heart"`
- **功能**：本地 TTS 后端使用的 Kokoro 语音（美式/英式，女声/男声）。
- **可选值**：
  - `af_heart` — Heart (American female)
  - `af_bella` — Bella (American female)
  - `af_nicole` — Nicole (American female)
  - `af_aoede` — Aoede (American female)
  - `af_kore` — Kore (American female)
  - `af_sarah` — Sarah (American female)
  - `am_michael` — Michael (American male)
  - `am_fenrir` — Fenrir (American male)
  - `am_puck` — Puck (American male)
  - `bf_emma` — Emma (British female)
  - `bm_george` — George (British male)
  - `bm_fable` — Fable (British male)

### `speech.enabled` — Speech Vocalization

- **作用**：把助手输出通过扬声器朗读出来的开关
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在流式输出过程中通过扬声器朗读助手的回复。

- **可选值**：
  - `true`
  - `false`

### `speech.mode` — Speech Vocalization Mode

- **作用**：语音朗读的范围（全部内容 / 仅助手消息 / 仅最终回复）
- **类型**：`enum`
- **默认值**：`"assistant"`
- **功能**：朗读范围：`all` = 助手消息 + 思维；`assistant` = 仅消息；`yield` = 仅每轮结束时的最终消息。
- **可选值**：
  - `all` — All (messages + thinking)
  - `assistant` — Assistant messages
  - `yield` — Final message only

### `speech.enhanced` — Enhanced Speech Rewriting

- **作用**：朗读前用 tiny 模型把输出改写为自然口语文（去掉链接、Markdown）
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：合成前用 tiny/smol 模型把助手输出改写为自然口语化散文（描述代码、省略链接和 Markdown）。失败时回退到机械式清理。

- **可选值**：
  - `true`
  - `false`

### `speech.voice` — Speech Vocalization Voice

- **作用**：朗读助手输出时使用的 Kokoro 嗓音
- **类型**：`enum`
- **默认值**：`"af_heart"`
- **功能**：朗读助手输出时使用的 Kokoro 语音。
- **可选值**：
  - `af_heart` — Heart (American female)
  - `af_bella` — Bella (American female)
  - `af_nicole` — Nicole (American female)
  - `af_aoede` — Aoede (American female)
  - `af_kore` — Kore (American female)
  - `af_sarah` — Sarah (American female)
  - `am_michael` — Michael (American male)
  - `am_fenrir` — Fenrir (American male)
  - `am_puck` — Puck (American male)
  - `bf_emma` — Emma (British female)
  - `bm_george` — George (British male)
  - `bm_fable` — Fable (British male)

### `providers.tinyModel` — Tiny Model

- **作用**：用于生成会话标题的 TINY 模型（在线角色或本地端侧模型）
- **类型**：`enum`
- **默认值**：`"online"`
- **功能**：会话标题模型：默认 `online`（来自 `/models` 的 TINY 角色，否则 `@smol`），或本地端侧模型。
- **可选值**：
  - `online` — 在线标题生成：TINY 模型角色（在 `/models` 中设置）若已分配则使用它，否则使用在线回退（commit 角色，然后 `@smol`）。不下载本地模型、不做端侧推理
  - `lfm2-350m` — 推荐的本地模型；速度/质量平衡最佳，缓存约 212 MB
  - `qwen3-0.6b` — 最稳健的本地选项；首次加载较慢，缓存约 500 MB
  - `gemma-270m` — 最小可用的本地选项；质量较低、缓存占用最小
  - `qwen2.5-0.5b` — 平衡的本地回退；质量与缓存占用适中
  - `lfm2-700m` — 质量最高的本地选项；比 LFM2 350M 更大且更慢

### `providers.tinyModelDevice` — Tiny Model Device

- **作用**：本地 tiny 模型推理的 ONNX 执行后端（CPU/GPU/Metal/CUDA 等）
- **类型**：`enum`
- **默认值**：`"default"`
- **功能**：本地 tiny 模型（标题 + 内存）的 ONNX 执行提供者。Default 仅使用 CPU 推理。环境变量 `PI_TINY_DEVICE` 覆盖此设置。
- **可选值**：
  - `default` — default
  - `gpu` — gpu
  - `cpu` — cpu
  - `metal` — metal
  - `webgpu` — webgpu
  - `cuda` — cuda
  - `dml` — dml
  - `coreml` — coreml
  - `auto` — auto
  - `wasm` — wasm
  - `webnn` — webnn
  - `webnn-gpu` — webnn-gpu
  - `webnn-cpu` — webnn-cpu
  - `webnn-npu` — webnn-npu

### `providers.tinyModelDtype` — Tiny Model Precision

- **作用**：本地 tiny 模型推理的 ONNX 量化精度（q4/q8/fp16 等，越低越快）
- **类型**：`enum`
- **默认值**：`"default"`
- **功能**：本地 tiny 模型的 ONNX 量化/精度。Default 使用各模型自带的 dtype（q4）；精度更低则更快，更高则更忠实。环境变量 `PI_TINY_DTYPE` 覆盖此设置。
- **可选值**：
  - `default` — default
  - `q4` — q4
  - `q4f16` — q4f16
  - `q8` — q8
  - `fp16` — fp16
  - `fp32` — fp32
  - `int8` — int8
  - `uint8` — uint8
  - `bnb4` — bnb4
  - `q2` — q2
  - `q2f16` — q2f16
  - `q1` — q1
  - `q1f16` — q1f16
  - `auto` — auto

### `providers.unexpectedStopModel` — Unexpected Stop Model

- **作用**：Smart 模式下判定异常停止所用的分类器模型（在线或本地端侧）
- **类型**：`enum`
- **默认值**：`"online"`
- **条件**：`unexpectedStopSmart` 为真时适用
- **功能**：Smart 异常停止检测的分类器：默认 `online`（来自 `/models` 的 TINY 角色，否则 smol），或本地端侧模型。
- **可选值**：
  - `online` — 使用在线模型：来自 `/models` 的 TINY 角色（若已设置），否则 `@smol`。无本地模型下载或端侧推理
  - `qwen3-1.7b` — 本地推理已禁用：`onnxruntime-node` 无法运行该 ONNX 导出的 RotaryEmbedding 缓存更新
  - `llama3.2:3b` — 更大的 Llama 3.2 选项，可用于本地内存/分类器任务；质量潜力更高，但磁盘/RAM/延迟成本更高
  - `gemma-3-1b` — 整合/去重最佳；占用更小，但提取时会泄漏一些闲聊
  - `qwen2.5-1.5b` — 提取粒度最佳（原子事实）；整合能力较弱
  - `lfm2-1.2b` — 加载最快；全面的全能选手，提取标签略噪

### `providers.kimiApiFormat` — Kimi API Format

- **作用**：Kimi Code provider 的 API 协议格式（OpenAI / Anthropic / 跟随模型声明）
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：Kimi Code provider 的 API 格式（auto 跟随实时模型元数据）。
- **可选值**：
  - `auto` — 使用模型服务端声明的协议
  - `openai` — `api.kimi.com`
  - `anthropic` — `api.moonshot.ai`

### `providers.openaiWebsockets` — OpenAI WebSockets

- **作用**：OpenAI Codex 模型是否强制走 WebSocket（auto/on/off）
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：OpenAI Codex 模型的 WebSocket 策略（auto 用模型默认，on 强制开启，off 禁用）。
- **可选值**：
  - `auto` — 使用模型/provider 默认的 WebSocket 行为
  - `off` — 为 OpenAI Codex 模型禁用 WebSocket
  - `on` — 为 OpenAI Codex 模型强制启用 WebSocket

### `providers.cacheRetention` — Prompt Cache Retention

- **作用**：透传给支持 provider（Anthropic/Bedrock/OpenRouter/OpenAI）的 prompt cache 保留策略
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：转发到支持 prompt cache 保留的 provider（Anthropic、Bedrock、OpenRouter、OpenAI）的缓存保留设置。
- **可选值**：
  - `auto` — Provider 默认——Anthropic 保持 5m 条目，由空闲 keep-alive 刷新保持温热；`PI_CACHE_RETENTION` 仍然适用
  - `short` — Short (5m)：最便宜的 cache 写入；Anthropic 在空闲时通过有界 keep-alive 刷新保持条目温热
  - `long` — Long (1h)：支持 1h TTL 时使用；写入更贵，不发 keep-alive 刷新请求
  - `none` — Off：禁用 prompt 缓存与缓存亲和路由

### `providers.streamFirstEventTimeoutSeconds` — Stream First Event Timeout

- **作用**：模型流式首事件的等待超时（-1 用默认，0 关闭看门狗）
- **类型**：`number`
- **默认值**：`-1`
- **功能**：等待首个模型流事件的秒数；`-1` 使用 provider/环境默认值，`0` 禁用看门狗。
- **可选值**：
  - `-1` — Auto：使用 provider 默认值和 `PI_*` 超时环境变量
  - `0` — Off：禁用首事件超时
  - `300` — 5 minutes
  - `600` — 10 minutes
  - `1800` — 30 minutes

### `providers.streamIdleTimeoutSeconds` — Stream Idle Timeout

- **作用**：模型流在两个事件之间允许的最大静默秒数（-1 用默认，0 关闭看门狗）
- **类型**：`number`
- **默认值**：`-1`
- **功能**：模型流在事件间允许保持静默的秒数；`-1` 使用 provider/环境默认值，`0` 禁用看门狗。
- **可选值**：
  - `-1` — Auto：使用 provider 默认值和 `PI_*` 超时环境变量
  - `0` — Off：禁用空闲超时
  - `300` — 5 minutes
  - `600` — 10 minutes
  - `1800` — 30 minutes

### `providers.openrouterVariant` — OpenRouter Routing

- **作用**：追加到 OpenRouter 模型 ID 上的默认路由后缀（nitro/floor/online/exacto）
- **类型**：`enum`
- **默认值**：`"default"`
- **功能**：追加到 OpenRouter 模型 ID 的默认路由变体后缀（当 selector 已指定变体时会被覆盖）。
- **可选值**：
  - `default` — Default：不加后缀；使用 OpenRouter 默认路由
  - `nitro` — `:nitro`：优先吞吐量/最低延迟
  - `floor` — `:floor`：优先选择最便宜的可用 provider
  - `online` — `:online`：启用 OpenRouter 的 web search 插件
  - `exacto` — `:exacto`：精选的高质量 provider（仅对部分模型有定义）

### `providers.fetch` — Fetch Provider

- **作用**：fetch/read URL 工具的 reader 后端优先级（native / trafilatura / lynx / parallel / jina）
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：`fetch`/read URL 工具的 reader 后端优先级。
- **可选值**：
  - `auto` — Auto：优先级 native > trafilatura > lynx > parallel > jina
  - `native` — Native：进程内 HTML→Markdown 转换器（始终可用）
  - `trafilatura` — Trafilatura：通过 uv/pip 自动安装
  - `lynx` — Lynx：需要系统安装 lynx 包
  - `parallel` — Parallel：需要 `PARALLEL_API_KEY`
  - `jina` — Jina：使用 `r.jina.ai` reader（`JINA_API_KEY` 可选）

### `codexResets.autoRedeem` — Codex Auto-Redeem Saved Resets

- **作用**：Codex 速率限制触底时是否自动消耗已保存的 reset 额度
- **类型**：`enum`
- **默认值**：`"unset"`
- **功能**：自动消费已保存的 Codex 速率限制重置：当一轮卡住且没有其他账号可接管时，恢复被耗尽的 5h 或 weekly 窗口封禁的账号，并挽回即将过期的 credits。unset 在首次消费前询问，yes 不询问直接消费，no 禁用两项检查。
- **可选值**：
  - `unset` — Unset：检查资格，然后在首次消费已保存的重置前询问
  - `yes` — Yes：不经提示直接消费符合资格的已保存重置
  - `no` — No：不运行已保存重置的自动消费检查

### `codexResets.minBlockedMinutes` — Codex Auto-Redeem Min Block

- **作用**：自动消耗 reset 所需的最小剩余封禁时间（避免短等待消耗稀缺额度）
- **类型**：`number`
- **默认值**：`60`
- **功能**：仅当自然解除封禁（已耗尽 5h/weekly 窗口中最近的重置）至少在这么多分钟后才自动消费（不要为省下短暂的等待而花掉稀缺的 credit）。调高（如 360）可忽略仅 5h 窗口的封禁。

- **可选值**：任意数字（无固定枚举）

### `codexResets.keepCredits` — Codex Auto-Redeem Reserve

- **作用**：自动消耗 reset 时保底保留的额度数量（即将过期的额度不受此限）
- **类型**：`number`
- **默认值**：`0`
- **功能**：自动消费后保留的已保存重置数不低于此值（0 表示最后一个 credit 也可能自动消费）。即将过期的 credit 豁免——保留会过期的 credit 一无所获。

- **可选值**：任意数字（无固定枚举）

### `codexResets.salvageHorizonHours` — Codex Reset Salvage Horizon

- **作用**：在 reset 即将过期前多少小时自动消耗以救回额度（0 关闭该逻辑）
- **类型**：`number`
- **默认值**：`12`
- **功能**：当已保存的 Codex 重置将在这么多小时内过期，且任一聊天窗口（5h 或 weekly）有可观的用量可恢复时，自动消费该重置（0 禁用过期回收）。

- **可选值**：任意数字（无固定枚举）

### `provider.appendOnlyContext` — Append-Only Context

- **作用**：开启 append-only 消息日志以最大化 provider 前缀缓存命中（DeepSeek/Xiaomi/Anthropic 等）
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：缓存系统提示词 + 工具规范，并保留仅追加的消息日志，让 provider 前缀缓存（DeepSeek、Xiaomi/SGLang、Anthropic）以最大命中率命中。Auto 为已知的前缀缓存 provider 启用。
- **可选值**：
  - `auto` — Auto：为已知的前缀缓存 provider 启用（推荐）
  - `on` — On：始终启用仅追加上下文
  - `off` — Off：禁用仅追加上下文

### `exa.enabled` — Exa

- **作用**：启用 Exa 网络搜索 provider
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用 Exa Web 搜索 provider。

- **可选值**：
  - `true`
  - `false`

### `exa.searchDelayMs` — Exa Search Delay

- **作用**：Exa 搜索请求之间的最小间隔毫秒数（0 关闭节流）
- **类型**：`number`
- **默认值**：`1000`
- **功能**：Exa Web 搜索请求之间的最小间隔（毫秒）；设为 0 禁用节流。

- **可选值**：任意数字（无固定枚举）

### `searxng.endpoint` — SearXNG Endpoint

- **作用**：自托管 SearXNG 实例的 Base URL（用于 web 搜索）
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：用于 Web 搜索的自托管 SearXNG 实例的 Base URL。

- **可选值**：任意字符串（无固定枚举）


## Appearance（外观）


共 34 项。


### `theme.dark` — Dark Theme

- **作用**：深色终端背景下的主题名称（运行时可选）。
- **类型**：`string`
- **默认值**：`"dark-terminal"`
- **功能**：终端背景为深色时使用的主题。（源码注释：Theme）
- **可选值**：
  - （可选值由运行时动态提供，如已安装的主题/扩展列表）

### `theme.light` — Light Theme

- **作用**：浅色终端背景下的主题名称（运行时可选）。
- **类型**：`string`
- **默认值**：`"light"`
- **功能**：终端背景为浅色时使用的主题
- **可选值**：
  - （可选值由运行时动态提供，如已安装的主题/扩展列表）

### `symbolPreset` — Symbol Preset

- **作用**：图标与符号的字形集（Unicode / Nerd Font / ASCII）。
- **类型**：`enum`
- **默认值**：`"unicode"`
- **功能**：图标与符号的字形集（Unicode、Nerd Font 或 ASCII）
- **可选值**：
  - `unicode` — 标准符号（默认）
  - `nerd` — 需要 Nerd Font
  - `ascii` — 最大兼容性

### `colorBlindMode` — Color-Blind Mode

- **作用**：差异新增色用蓝替代绿的色觉无障碍开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：diff 新增部分用蓝色替代绿色

- **可选值**：
  - `true`
  - `false`

### `composer.shape` — Composer Shape

- **作用**：输入编辑器与状态栏的视觉布局形态（运行时可选）。
- **类型**：`string`
- **默认值**：`"band"`
- **功能**：输入编辑器与状态行的视觉布局。（源码注释：Composer）
- **可选值**：
  - （可选值由运行时动态提供，如已安装的主题/扩展列表）

### `statusLine.preset` — Status Line Preset

- **作用**：状态栏的内置预设组合（默认 / 极简 / 紧凑 / 完整 / Nerd / ASCII / 自定义）。
- **类型**：`enum`
- **默认值**：`"default"`
- **功能**：预置的状态行配置。（源码注释：Status line）
- **可选值**：
  - `default` — 模型、路径、git、上下文、tokens、cost
  - `minimal` — 仅路径与 git
  - `compact` — 模型、git、cost、context
  - `full` — 含时间在内的全部段
  - `nerd` — 用 Nerd Font 图标呈现最多信息
  - `ascii` — 不使用特殊字符
  - `custom` — 用户自定义段

### `statusLine.separator` — Status Line Separator

- **作用**：状态栏各分段之间的分隔符样式（powerline / 斜杠 / 竖线等）。
- **类型**：`enum`
- **默认值**：`"powerline-thin"`
- **功能**：段与段之间分隔符的样式
- **可选值**：
  - `powerline` — 实心箭头（Nerd Font）
  - `powerline-thin` — 细箭头（Nerd Font）
  - `slash` — 正斜杠
  - `pipe` — 竖线
  - `block` — 实心方块
  - `none` — 仅空格
  - `ascii` — 大于号

### `statusLine.contextLine` — Context-Reactive Line

- **作用**：左右分段之间那条线如何反映上下文用量（仅 box 形态下）。
- **类型**：`enum`
- **默认值**：`"embedded"`
- **功能**：左右段之间线条反映上下文使用情况的方式（仅 box composer 有效）
- **可选值**：
  - `off` — 实心强调线，无上下文反馈
  - `percentage` — 已用部分用强调色显示，其余暗化
  - `annotated` — 百分比，并在 speculative 与 auto-compaction 边界处加刻度
  - `embedded` — 在标注线上嵌入上下文百分比与窗口

### `statusLine.sessionAccent` — Session Accent

- **作用**：用会话名配色绘制编辑器边框与状态栏空隙的开关。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：编辑器边框与状态行间隙使用会话名称颜色

- **可选值**：
  - `true`
  - `false`

### `statusLine.transparent` — Transparent Status Line

- **作用**：状态栏改用终端默认背景而非主题色的开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：状态行使用终端默认背景，而非主题的 `statusLineBg`。Powerline 端帽会因此被丢弃，因为它们需要对比色填充来衔接周围终端

- **可选值**：
  - `true`
  - `false`

### `statusLine.compactThinkingLevel` — Compact Thinking Level

- **作用**：将思考等级以单个图标附在模型名后，省去 ` · <level>` 后缀。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：将思考等级显示为模型名上的单个图标，而非单独的 ` · <level>` 后缀

- **可选值**：
  - `true`
  - `false`

### `statusLine.showHookStatus` — Show Hook Status

- **作用**：在状态栏下方显示 hook 状态消息的开关。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在状态行下方显示 hook 状态消息

- **可选值**：
  - `true`
  - `false`

### `terminal.showImages` — Show Inline Images

- **作用**：在终端内联渲染图片的能力开关（条件：终端支持图像协议）。
- **类型**：`boolean`
- **默认值**：`true`
- **条件**：`hasImageProtocol` 为真时适用
- **功能**：在终端中以内联方式渲染图像。（源码注释：Images and terminal）

- **可选值**：
  - `true`
  - `false`

### `images.autoResize` — Auto-Resize Images

- **作用**：把大图缩放到 2000×2000 以提升模型端兼容性的开关。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：将大图缩放至最大 2000x2000 以提升模型兼容性

- **可选值**：
  - `true`
  - `false`

### `images.blockImages` — Block Images

- **作用**：阻止任何图片被发送至 LLM 提供方的开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：禁止将图像发送给 LLM provider

- **可选值**：
  - `true`
  - `false`

### `tui.resizeScrollback` — Resize Scrollback

- **作用**：终端尺寸稳定后刷新已保留滚动历史的方式（追加 / 重建 / 保留）。
- **类型**：`enum`
- **默认值**：`"rebuild"`
- **功能**：已稳定的终端尺寸调整如何刷新保留在终端回滚中的记录行
- **可选值**：
  - `append` — 在保留的历史下方以新宽度重放记录
  - `rebuild` — 清空终端全部回滚，再按当前宽度重放一次记录
  - `preserve` — 仅重绘视口，历史按旧宽度保留换行

### `terminal.showProgress` — Native Terminal Progress

- **作用**：代理运行中是否向终端发出 OSC 9;4 不定进度提示。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在 agent 或上下文维护运行时发出 OSC 9;4 不定进度

- **可选值**：
  - `true`
  - `false`

### `tui.textSizing` — Large Headings (Kitty)

- **作用**：在 Kitty 终端用 OSC 66 将 Markdown H1 放大为 2 倍的开关（推断）。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：使用 Kitty 的 OSC 66 文本尺寸协议以 2x 比例渲染 Markdown H1 标题。仅在 Kitty 终端生效，其他终端忽略。默认关闭

- **可选值**：
  - `true`
  - `false`

### `tui.renderMermaid` — Render Mermaid Diagrams

- **作用**：把 Mermaid 代码块渲染为 ASCII 示意图的开关。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：将 Mermaid 围栏代码块渲染为 ASCII 图

- **可选值**：
  - `true`
  - `false`

### `tui.codexResetFireworks` — Codex Reset Fireworks

- **作用**：Codex 每周用量重置/新增银行重置时顶部烟花庆祝动效的开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在 Codex 每周用量意外重置及新增已存 saved reset 时，播放覆盖顶部三分之一的烟花效果，直至按 Escape

- **可选值**：
  - `true`
  - `false`

### `tui.titleState` — Terminal Title Run State

- **作用**：在终端标题分隔符上显示代理运行状态（旋转/等待/轮到你）的开关。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在终端标题分隔符中显示 agent 运行状态——工作中显示动画旋转图标（Windows 上是静态 `:`），轮到你时显示 `>`，agent 等待你时显示 `!`

- **可选值**：
  - `true`
  - `false`

### `tui.hyperlinks` — Terminal Hyperlinks

- **作用**：路径与 URL 是否以 OSC 8 终端超链接包裹（off / auto / always）。
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：用 OSC 8 超链接包裹路径与 URL，以支持终端原生点击打开（auto：探测支持；off：永不；always：无条件）
- **可选值**：
  - `off`
  - `auto`
  - `always`

### `tui.mobile` — Mobile Layout

- **作用**：切换到紧凑版移动端终端布局的开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：使用紧凑的移动端终端布局

- **可选值**：
  - `true`
  - `false`

### `tui.tight` — Tight Layout

- **作用**：去除终端输出左右各 1 字符水平内边距的紧凑布局开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：移除终端输出左右各 1 个字符的水平内边距

- **可选值**：
  - `true`
  - `false`

### `display.shimmer` — Shimmer

- **作用**：工作/加载消息的动画风格（经典余弦波 / KITT 扫描条 / 关闭）。
- **类型**：`enum`
- **默认值**：`"classic"`
- **功能**：工作/加载消息的动画样式
- **可选值**：
  - `classic` — 跨文本扫过的柔和余弦波
  - `kitt` — 1982《霹雳车》红色扫描灯左右往返
  - `disabled` — 无动画，静态暗色文字

### `display.smoothStreaming` — Smooth Streaming

- **作用**：让助手文本与流式工具输入按到达节奏平滑显示的开关。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在分块到达时平滑地展现助手文本与流式工具输入

- **可选值**：
  - `true`
  - `false`

### `display.hideToolActivity` — Hide Tool Activity

- **作用**：在会话记录中隐藏模型发起的工具调用与结果的开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在记录中隐藏模型发起的工具调用与结果

- **可选值**：
  - `true`
  - `false`

### `display.showTokenUsage` — Show Token Usage

- **作用**：在助手消息上显示本轮 token 用量的开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在助手消息上显示每轮 token 用量

- **可选值**：
  - `true`
  - `false`

### `display.showTurnTime` — Show Turn Time

- **作用**：在助手消息用量行显示本轮 prompt 到 yield 的总耗时开关。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在助手消息的使用行上显示从 prompt 到 yield 的总耗时（含工具调用）

- **可选值**：
  - `true`
  - `false`

### `display.cacheMissMarker` — Cache Miss Marker

- **作用**：在 prompt 缓存未命中的助手轮次后显示分隔标记的开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在该轮请求未命中（miss）prompt cache 的助手轮次后显示分隔线

- **可选值**：
  - `true`
  - `false`

### `display.collapseCompacted` — Collapse Compacted History

- **作用**：在实时记录中把压缩前历史折叠到摘要分隔符之后的开关。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在实时记录中将压缩前历史折叠在摘要分隔线之后；关闭则在每个压缩点保留完整记录与分隔线

- **可选值**：
  - `true`
  - `false`

### `showHardwareCursor` — Show Hardware Cursor

- **作用**：为 IME 兼容性显示真实硬件光标的开关。
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：显示终端光标以支持 IME

- **可选值**：
  - `true`
  - `false`

### `tui.imeSafeCursor` — IME-Safe Prompt Layout

- **作用**：将提示符底边框拆到独立行，避开 macOS IME 预编辑位移的开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：将 prompt 的底边框移至独立行，避免 macOS IME 预编辑使其错位

- **可选值**：
  - `true`
  - `false`

### `task.showResolvedModelBadge` — Show Resolved Model Badge

- **作用**：在任务小组件状态栏显示各子代理实际所用模型 ID 的开关。
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在 task 控件状态行中显示每个子代理实际使用的模型 ID

- **可选值**：
  - `true`
  - `false`


## Tools（工具）


共 59 项。


### `tools.artifactSpillThreshold` — Artifact Spill Threshold (KB)

- **作用**：超过该体积的工具输出将被溢出为 artifact 文件
- **类型**：`number`
- **默认值**：`50`
- **功能**：超过此大小的工具输出会保存为 artifact，尾部保留在行内。
- **可选值**：
  - `1` — ~250 tokens
  - `2.5` — ~625 tokens
  - `5` — ~1.25K tokens
  - `10` — ~2.5K tokens
  - `20` — ~5K tokens
  - `30` — ~7.5K tokens
  - `50` — Default; ~12.5K tokens
  - `75` — ~19K tokens
  - `100` — ~25K tokens
  - `200` — ~50K tokens
  - `500` — ~125K tokens
  - `1000` — ~250K tokens

### `tools.artifactTailBytes` — Artifact Tail Size (KB)

- **作用**：输出溢出为 artifact 时，内联保留的尾部字节数
- **类型**：`number`
- **默认值**：`20`
- **功能**：输出溢出到 artifact 时保留在行内的尾部内容大小。
- **可选值**：
  - `1` — ~250 tokens
  - `2.5` — ~625 tokens
  - `5` — ~1.25K tokens
  - `10` — ~2.5K tokens
  - `20` — Default; ~5K tokens
  - `50` — ~12.5K tokens
  - `100` — ~25K tokens
  - `200` — ~50K tokens

### `tools.artifactHeadBytes` — Artifact Head Size (KB)

- **作用**：输出溢出为 artifact 时，内联保留的头部字节数（中间省略）
- **类型**：`number`
- **默认值**：`20`
- **功能**：输出溢出到 artifact 时，与尾部一起保留在行内的头部内容大小（中间省略）。设为 0 禁用——仅保留尾部。
- **可选值**：
  - `0` — Disabled; tail-only truncation
  - `1` — ~250 tokens
  - `2.5` — ~625 tokens
  - `5` — ~1.25K tokens
  - `10` — ~2.5K tokens
  - `20` — Default; ~5K tokens
  - `50` — ~12.5K tokens
  - `100` — ~25K tokens
  - `200` — ~50K tokens

### `tools.outputMaxColumns` — Output Column Cap

- **作用**：流式工具输出每行的字节上限（超出后省略截断）
- **类型**：`number`
- **默认值**：`768`
- **功能**：流式工具输出（bash、python、js eval）和 `read` 的单行字节上限。超过此宽度的行会被省略号截断；直到下一个换行符为止的剩余字节被丢弃。设为 0 禁用。
- **可选值**：
  - `0` — No per-line cap
  - `256` — Tight
  - `512`
  - `768` — Default
  - `1024`
  - `2048`
  - `4096` — Loose

### `tools.artifactTailLines` — Artifact Tail Lines

- **作用**：输出溢出为 artifact 时，内联保留的尾部行数
- **类型**：`number`
- **默认值**：`500`
- **功能**：输出溢出到 artifact 时保留在行内的尾部最大行数。
- **可选值**：
  - `50` — ~250 tokens
  - `100` — ~500 tokens
  - `250` — ~1.25K tokens
  - `500` — Default; ~2.5K tokens
  - `1000` — ~5K tokens
  - `2000` — ~10K tokens
  - `5000` — ~25K tokens

### `todo.enabled` — Todos

- **作用**：是否启用 todo 工具进行任务跟踪
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用 todo 工具进行任务跟踪。（源码注释：Todo tool）

- **可选值**：
  - `true`
  - `false`

### `todo.reminders` — Todo Reminders

- **作用**：是否在停止前提醒模型完成待办
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在停止前提醒 agent 完成 todos。

- **可选值**：
  - `true`
  - `false`

### `todo.remindersMax` — Todo Reminder Limit

- **作用**：对未完成 todo 的最大提醒次数
- **类型**：`number`
- **默认值**：`3`
- **功能**：放弃之前 todo 提醒的最大次数。
- **可选值**：
  - `1`
  - `2`
  - `3`
  - `5`

### `todo.eager` — Create Todos Automatically

- **作用**：首条消息后自动创建 todo 列表的力度
- **类型**：`enum`
- **默认值**：`"default"`
- **功能**：在首条消息后多大力度地推动自动创建 todo 列表。
- **可选值**：
  - `default` — Model decides; no automatic todo list
  - `preferred` — Suggests a todo list on the first message (reminder, not forced)
  - `always` — Forces a comprehensive todo list on the first message

### `glob.enabled` — Glob

- **作用**：是否启用 glob 工具进行文件名匹配查找
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用 glob 工具进行基于 glob 的文件查找。（源码注释：Grep, glob, and AST tools）

- **可选值**：
  - `true`
  - `false`

### `grep.enabled` — Grep

- **作用**：是否启用 grep 工具进行正则内容搜索
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用 grep 工具进行正则内容搜索。

- **可选值**：
  - `true`
  - `false`

### `grep.contextBefore` — Grep Context Before

- **作用**：grep 命中前显示的上下文行数
- **类型**：`number`
- **默认值**：`1`
- **功能**：每个 grep 匹配项之前的上下文行数。
- **可选值**：
  - `0`
  - `1`
  - `2`
  - `3`
  - `5`

### `grep.contextAfter` — Grep Context After

- **作用**：grep 命中后显示的上下文行数
- **类型**：`number`
- **默认值**：`3`
- **功能**：每个 grep 匹配项之后的上下文行数。
- **可选值**：
  - `0`
  - `1`
  - `2`
  - `3`
  - `5`
  - `10`

### `astGrep.enabled` — AST Grep

- **作用**：是否启用 ast_grep 工具进行结构化 AST 搜索
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：启用 ast_grep 工具进行结构化 AST 搜索。

- **可选值**：
  - `true`
  - `false`

### `astEdit.enabled` — AST Edit

- **作用**：是否启用 ast_edit 工具进行结构化 AST 重写
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用 ast_edit 工具进行结构化 AST 重写。

- **可选值**：
  - `true`
  - `false`

### `debug.enabled` — Debug

- **作用**：是否启用 DAP 协议的 debug 工具
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用 debug 工具以进行基于 DAP 的调试。

- **可选值**：
  - `true`
  - `false`

### `launch.enabled` — Launch

- **作用**：是否启用 launch 工具监管项目级长时进程
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用 launch 工具以管理共享的长时间运行的项目进程。

- **可选值**：
  - `true`
  - `false`

### `speechgen.enabled` — Speech Generation

- **作用**：是否启用 TTS 语音文件合成工具
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：启用 tts 工具以进行设备端（Kokoro）或 xAI Grok Voice 语音文件合成。

- **可选值**：
  - `true`
  - `false`

### `generate_image.enabled` — Generate Image

- **作用**：是否启用文本生成/编辑图片工具（推断）
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：启用 generate_image 工具（文生图与编辑）。当 tools.xdev 开启时作为 xd:// 设备暴露。

- **可选值**：
  - `true`
  - `false`

### `inspect_image.mode` — Inspect Image

- **作用**：是否在模型缺乏原生视觉输入时暴露 inspect_image 视觉理解工具
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：控制 inspect_image 工具，该工具将图像理解委托给支持视觉的模型。`auto` 仅在当前模型没有原生图像输入时暴露；`on` 始终暴露；`off` 永不暴露。
- **可选值**：
  - `auto` — Auto (only for models without vision)
  - `on` — On
  - `off` — Off

### `computer.enabled` — Computer

- **作用**：是否启用宿主机桌面控制工具（截图、输入、可达性）
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：启用可脚本化的宿主机桌面控制工具（截图、输入、可访问性）。

- **可选值**：
  - `true`
  - `false`

### `computer.display` — Computer Display

- **作用**：桌面截图是拼接所有显示器还是指定某个显示器
- **类型**：`string`
- **默认值**：`"all"`
- **功能**：合成所有显示器或选择一个原生显示器 id。

- **可选值**：任意字符串（无固定枚举）

### `computer.maxWidth` — Computer Screenshot Width

- **作用**：桌面截图的最大拼接宽度（像素）
- **类型**：`number`
- **默认值**：`3840`
- **功能**：合成截图的最大宽度（像素）。

- **可选值**：任意数字（无固定枚举）

### `computer.maxHeight` — Computer Screenshot Height

- **作用**：桌面截图的最大拼接高度（像素）
- **类型**：`number`
- **默认值**：`2400`
- **功能**：合成截图的最大高度（像素）。

- **可选值**：任意数字（无固定枚举）

### `inspect_image.timeoutMs` — Inspect Image Timeout

- **作用**：inspect_image 视觉模型调用的单次超时（毫秒）
- **类型**：`number`
- **默认值**：`300000`
- **功能**：inspect_image 视觉模型调用的单请求超时（毫秒）。当提供方停滞时会快速失败并返回超时错误，而不是阻塞到手动中止。设为 0 禁用超时。
- **可选值**：
  - `0` — Disabled
  - `60000` — 1 minute
  - `120000` — 2 minutes
  - `180000` — 3 minutes
  - `300000` — 5 minutes

### `checkpoint.enabled` — Checkpoint/Rewind

- **作用**：是否启用上下文检查点与回退工具
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：启用 checkpoint 和 rewind 工具进行上下文检查点。

- **可选值**：
  - `true`
  - `false`

### `fetch.enabled` — Read URLs

- **作用**：是否允许 read 工具抓取并解析 URL 内容
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：允许 read 工具获取并处理 URL。（源码注释：Fetching and browser）

- **可选值**：
  - `true`
  - `false`

### `vault.enabled` — Obsidian Vault

- **作用**：是否启用 vault:// 内部 URL 以读写 Obsidian 库
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：启用 vault:// 内部 URL，通过 Obsidian CLI 读写 Obsidian vault 内容。禁用时拒绝解析 vault://，且 system prompt 中会省略 vault:// 条目。

- **可选值**：
  - `true`
  - `false`

### `github.enabled` — GitHub CLI

- **作用**：是否启用 GitHub 仓库/Issue/PR/Actions 等操作工具
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：启用 github 工具（基于 op 的调度，用于 repo、issue、pr、diff、search、checkout、push 以及 Actions watch 工作流）。

- **可选值**：
  - `true`
  - `false`

### `github.cache.enabled` — GitHub View Cache

- **作用**：是否将渲染后的 Issue/PR 视图缓存到本地 SQLite
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在 `~/.omp/cache/github-cache.db` 中缓存渲染后的 issue/PR 视图输出，使重复读取免费。

- **可选值**：
  - `true`
  - `false`

### `github.cache.softTtlSec` — GitHub Cache Soft TTL

- **作用**：GitHub 视图缓存的软有效期（秒）
- **类型**：`number`
- **默认值**：`300`
- **功能**：在该时间窗口内，缓存的 issue/PR 视图行直接返回（秒；默认 5 分钟）。

- **可选值**：任意数字（无固定枚举）

### `github.cache.hardTtlSec` — GitHub Cache Hard TTL

- **作用**：GitHub 视图缓存的硬过期时间（秒）
- **类型**：`number`
- **默认值**：`604800`
- **功能**：超过 soft TTL 后直接返回缓存行并在后台刷新；超过 hard TTL 后丢弃（秒；默认 7 天）。

- **可选值**：任意数字（无固定枚举）

### `web_search.enabled` — Web Search

- **作用**：是否启用 web_search 工具获取实时联网结果
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用 web_search 工具以获取实时网页结果。

- **可选值**：
  - `true`
  - `false`

### `security.enabled` — Security

- **作用**：是否启用 OMP 原生安全扫描与 security:// 只读资源命名空间
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：启用 OMP 原生的安全扫描规划、执行以及只读的 security:// 资源命名空间。

- **可选值**：
  - `true`
  - `false`

### `ask.enabled` — Ask

- **作用**：是否启用 ask 工具向用户发起交互式提问
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用 ask 工具以与用户进行交互式问答。

- **可选值**：
  - `true`
  - `false`

### `browser.enabled` — Browser

- **作用**：是否启用 browser 工具进行脚本化 Chromium 自动化
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用 browser 工具以执行脚本化 Chromium 自动化（puppeteer）。

- **可选值**：
  - `true`
  - `false`

### `browser.cdpUrl` — Browser CDP URL

- **作用**：browser 工具默认附着的 HTTP CDP 发现端点
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：默认 HTTP CDP 发现端点（例如 `http://127.0.0.1:9222`），用于连接而非启动浏览器。工具调用时显式传入的 `app.cdp_url` 或 `app.path` 优先。

- **可选值**：任意字符串（无固定枚举）

### `browser.relay` — Browser Relay

- **作用**：是否通过 omp browser relay 驱动用户自己的 Chrome 标签
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：通过 omp browser relay 驱动你自己的 Chrome 标签页。只需安装一次扩展（`omp browser-relay install`）；relay 服务在 browser 工具需要时自动启动。优先级高于 Browser CDP URL；可通过 `PI_BROWSER_RELAY=0` 或 `PI_BROWSER_RELAY=1` 覆盖。

- **可选值**：
  - `true`
  - `false`

### `browser.relayUrl` — Browser Relay URL

- **作用**：omp browser relay 服务端点 URL
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：omp browser relay 端点（默认 `http://127.0.0.1:9224`）。

- **可选值**：任意字符串（无固定枚举）

### `browser.headless` — Headless Browser

- **作用**：browser 工具是否以无界面模式启动 Chromium
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：以 headless 模式启动浏览器（关闭以显示浏览器 UI）。

- **可选值**：
  - `true`
  - `false`

### `browser.cmux` — cmux Browser

- **作用**：可用时是否优先使用 cmux WKWebView 承载浏览器自动化
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：当 cmux 套接字可用时，使用 cmux WKWebView 表面进行浏览器自动化。可通过 `PI_BROWSER_CMUX=0` 或 `PI_BROWSER_CMUX=1` 覆盖。

- **可选值**：
  - `true`
  - `false`

### `browser.screenshotDir` — Screenshot Directory

- **作用**：browser 截图的保存目录（未设则走系统临时目录）
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：截图保存目录。若未设置，截图会写入临时文件。支持 `~`。例如：`~/Downloads`、`~/Desktop`、`/sdcard/Download`（Android）。

- **可选值**：任意字符串（无固定枚举）

### `tools.intentTracing` — Intent Tracing

- **作用**：是否要求模型在每次工具调用前先描述其意图
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：要求 agent 在每次工具调用执行前描述其意图。（源码注释：Tool execution）

- **可选值**：
  - `true`
  - `false`

### `tools.abortOnFabricatedResult` — Abort On Fabricated Tool Result

- **作用**：带内工具调用出现伪造结果时是否立即中止生成
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在使用 in-band 工具调用时，若模型在某轮中途开始幻觉工具结果，立即停止生成。禁用则会允许模型完成生成，并丢弃幻觉产生的后续部分。

- **可选值**：
  - `true`
  - `false`

### `tools.maxTimeout` — Max Tool Timeout

- **作用**：允许为任何工具设置的最大超时秒数（0 表示不限制）
- **类型**：`number`
- **默认值**：`0`
- **功能**：agent 可为任意工具设置的最大超时秒数（0 = 不限）。
- **可选值**：
  - `0` — No limit
  - `30` — 30 seconds
  - `60` — 60 seconds
  - `120` — 120 seconds
  - `300` — 5 minutes
  - `600` — 10 minutes

### `async.enabled` — Async Execution

- **作用**：是否启用后台 bash 命令与异步任务执行
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用异步 bash 命令与后台任务执行。（源码注释：Async jobs）

- **可选值**：
  - `true`
  - `false`

### `async.pollWaitDuration` — Max Poll Time

- **作用**：hub wait 单次轮询后台任务的最长等待策略
- **类型**：`enum`
- **默认值**：`"smart"`
- **功能**：`hub` wait 监听后台任务后返回当前状态前的等待时长。固定值表示每次都等待该时长。`smart` 自适应：起始 5s，并在连续等待时逐步延长（最多 5m），约一分钟无等待后重置为 5s。
- **可选值**：
  - `5s`
  - `10s`
  - `30s`
  - `1m`
  - `5m`
  - `smart` — Default — adaptive 5s→5m, resets when you stop polling

### `irc.timeoutMs` — IRC Timeout

- **作用**：hub 消息等待与 send await 的默认超时（毫秒）
- **类型**：`number`
- **默认值**：`120000`
- **功能**：hub 消息等待（含 `send await:true`）的默认超时（毫秒）；0 表示禁用超时。
- **可选值**：
  - `0` — Disabled
  - `30000` — 30 seconds
  - `60000` — 1 minute
  - `120000` — 2 minutes
  - `300000` — 5 minutes

### `tools.xdev` — xd:// Tools

- **作用**：是否将不常用工具挂载到 xd:// 设备而非顶层暴露
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：将不常用（可发现）的工具挂载到 xd:// 设备 URL，通过 read/write 驱动，而不是在每次请求中都附带其 schema。会话若显式授予 read 但省略 write，则通过仅设备的 write 传输挂载设备（仍然拒绝文件系统写入）。禁用则将所有启用的工具暴露在顶层。

- **可选值**：
  - `true`
  - `false`

### `tools.xdevDocs` — xd:// Prompt Docs

- **作用**：系统提示中内联哪些 xd:// 设备文档与 schema
- **类型**：`enum`
- **默认值**：`"builtins"`
- **功能**：选择在 system prompt 中内联哪些挂载设备的文档和 schema。Built-ins 保留核心工具内联，MCP 与扩展工具按需获取。
- **可选值**：
  - `inline` — Inline docs and schemas for every mounted device.
  - `builtins` — Inline built-in docs; fetch MCP and extension docs on demand.
  - `catalog` — List every device; fetch all docs on demand.

### `tools.xdevInlineDevices` — xd:// Inline Devices

- **作用**：在 Built-ins 模式下额外内联哪些动态设备（glob 匹配）
- **类型**：`array`
- **默认值**：`[]`
- **功能**：当 xd:// Prompt Docs 为 Built-ins Only 时，将名称匹配这些 glob 模式的动态设备内联（例如 `mcp__context_mode_*`）。Catalog Only 忽略该设置。

- **可选值**：任意字符串数组（无固定枚举）

### `mcp.enableProjectConfig` — MCP Project Config

- **作用**：是否从项目根加载 .mcp.json / mcp.json
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：从项目根目录加载 `.mcp.json` / `mcp.json`。（源码注释：MCP）

- **可选值**：
  - `true`
  - `false`

### `mcp.renderMarkdownResults` — MCP Markdown Results

- **作用**：是否将 MCP 非 JSON 文本结果按 Markdown 渲染到回显
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在 transcript 中将非 JSON 的 MCP 文本结果渲染为 Markdown。

- **可选值**：
  - `true`
  - `false`

### `mcp.notifications` — MCP Update Injection

- **作用**：是否把 MCP 资源更新注入到模型对话中
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：将 MCP 资源更新注入到 agent 对话中。

- **可选值**：
  - `true`
  - `false`

### `mcp.notificationDebounceMs` — MCP Notification Debounce

- **作用**：MCP 资源更新注入会话前的去抖窗口（毫秒）
- **类型**：`number`
- **默认值**：`500`
- **功能**：MCP 资源更新在注入对话前的去抖窗口（毫秒）。

- **可选值**：任意数字（无固定枚举）

### `tasks.todoClearDelay` — Todo Auto-Clear Delay

- **作用**：已完成或放弃的 todo 从面板移除前的延迟（秒）
- **类型**：`number`
- **默认值**：`60`
- **功能**：已完成或已放弃的 todo 从 todo 小组件移除前的延迟。
- **可选值**：
  - `0` — Instant
  - `60` — Default
  - `300`
  - `900`
  - `1800`
  - `3600`
  - `-1` — Never

### `extensionHandlers.toolCallTimeoutMs` — Tool Call Handler Timeout (ms)

- **作用**：扩展 tool_call 处理器的有效工作超时（毫秒）
- **类型**：`number`
- **默认值**：`30000`
- **功能**：扩展 `tool_call` handler 的有效正有限工作超时；非法值回落到 30000ms，等待 OMP 自有对话框的时间不计入。

- **可选值**：任意数字（无固定枚举）

### `dev.autoqa` — Auto QA

- **作用**：是否启用工具问题自动上报（xd://report_issue）
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：自动化工具问题上报（`xd://report_issue`）。默认开启；首次上报会请求同意，拒绝则在显式重新启用前关闭上报。

- **可选值**：
  - `true`
  - `false`

### `dev.autoqaPush.endpoint` — Auto QA Push Endpoint

- **作用**：接收 Auto QA JSON 报告的完整 URL
- **类型**：`string`
- **默认值**：`"https://qa.omp.sh/v1/grievances"`
- **功能**：接收 Auto QA JSON 报告的完整 URL（默认 `https://qa.omp.sh/v1/grievances`）。

- **可选值**：任意字符串（无固定枚举）


## Context（上下文）


共 28 项。


### `workspace.additionalDirectories` — Additional Workspace Dirs

- **作用**：每个会话额外包含的工作区根目录列表（多根工作区），由 /add-dir 与 /remove-dir 命令维护
- **类型**：`array`
- **默认值**：`[]`
- **功能**：为每个会话添加额外的 workspace 目录作为附加根（多根 workspace）。通过 `/add-dir` 和 `/remove-dir` 在线管理。路径相对于 cwd 解析；推荐使用绝对路径。代理会被告知这些根存在，并可对其执行 read/grep/glob。

- **可选值**：任意字符串数组（无固定枚举）

### `contextPromotion.enabled` — Auto-Promote Context

- **作用**：上下文溢出时升级到更大窗口模型而非触发压缩的开关
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：当上下文溢出时，提升到更大上下文的模型，而不是压缩。

- **可选值**：
  - `true`
  - `false`

### `extendedContext` — Extended Context

- **作用**：超过阈值按溢价计费时是否启用模型的长上下文窗口（如 GPT-5.6 1M）
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在超过阈值后额外计费的模型上使用付费的长上下文窗口（例如 GPT-5.6 1M 在 272K 以上输入按 2x 计费）；关闭则限制在标准定价窗口。

- **可选值**：
  - `true`
  - `false`

### `compaction.enabled` — Auto-Compact

- **作用**：上下文过大时自动压缩的主开关
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：当上下文过大时自动压缩。

- **可选值**：
  - `true`
  - `false`

### `compaction.midTurnEnabled` — Mid-Turn Compaction

- **作用**：在工具循环的安全边界处提前检查压缩阈值的开关
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在发起下一次 provider 请求前，于安全的中途工具循环边界检查阈值。

- **可选值**：
  - `true`
  - `false`

### `compaction.methodOrder` — Compaction Method Order

- **作用**：自动上下文维护方法的回退顺序，不可用或失败时顺延
- **类型**：`array`
- **默认值**：`["remote","snapcompact","handoff","shake","soft"]`
- **功能**：自动上下文维护的优先回退顺序；不可用或失败的方法会前进到下一个选择。
- **有序**：是（顺序有意义）
- **可选值**：
  - `remote` — 在当前活动路由支持时，使用 OpenAI 兼容的 provider 原生服务端压缩
  - `snapcompact` — 将历史归档为稠密位图图像，由当前活动视觉模型读回；不发起 LLM 调用
  - `handoff` — 生成 handoff 文档，并以其作为压缩摘要继续
  - `soft` — 不使用服务端压缩，由压缩模型就地总结
  - `shake` — 就地丢弃可恢复的重量级内容，不发起 LLM 调用

### `compaction.thresholdPercent` — Compaction Threshold

- **作用**：按上下文使用百分比触发压缩的阈值
- **类型**：`number`
- **默认值**：`-1`
- **功能**：上下文维护的百分比阈值；设为 Default 时使用旧的基于预留（reserve）的行为。
- **可选值**：
  - `default` — 旧的基于预留的阈值
  - `10` — 极早维护
  - `20` — 很早维护
  - `30` — 较早维护
  - `40` — 略早维护
  - `50` — 中点
  - `60` — 中等上下文使用率
  - `70` — 平衡
  - `75` — 略激进
  - `80` — 典型阈值
  - `85` — 激进的上下文使用率
  - `90` — 非常激进
  - `95` — 接近上下文上限

### `compaction.thresholdTokens` — Compaction Token Limit

- **作用**：按固定 token 数触发压缩的阈值（设置时覆盖百分比阈值）
- **类型**：`number`
- **默认值**：`-1`
- **功能**：上下文维护的固定 token 限制；设置后覆盖百分比阈值。
- **可选值**：
  - `default` — 使用基于百分比的阈值
  - `25000` — 200K 窗口的四分之一
  - `50000` — 200K 窗口的一半
  - `100000` — 200K 窗口的一半
  - `150000` — 200K 窗口的四分之三
  - `200000` — 完整标准上下文窗口
  - `300000` — 大型上下文窗口
  - `500000` — 超大上下文窗口

### `compaction.handoffSaveToDisk` — Save Handoff Docs

- **作用**：自动交接流程生成的交接文档是否落盘为 Markdown
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：将生成的 handoff 文档保存为 markdown 文件，供 auto-handoff 流程使用。

- **可选值**：
  - `true`
  - `false`

### `compaction.remoteStreamingV2Enabled` — Remote Compaction V2

- **作用**：兼容模型是否走 Responses 流式压缩协议 V2
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：对兼容的远程压缩模型使用 Responses 流式压缩。

- **可选值**：
  - `true`
  - `false`

### `compaction.asyncEnabled` — Async Compaction

- **作用**：阈值附近后台预生成摘要、跨阈值时直接切入的异步压缩开关
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在上下文接近压缩阈值时，后台投机性地进行总结；阈值越过后，将就绪的结果拼接入上下文。

- **可选值**：
  - `true`
  - `false`

### `compaction.idleEnabled` — Idle Compaction

- **作用**：会话空闲且 token 超出阈值时触发空闲压缩的开关
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：当 token 数超过阈值时，在空闲状态下压缩上下文。

- **可选值**：
  - `true`
  - `false`

### `compaction.idleThresholdTokens` — Idle Compaction Threshold

- **作用**：触发空闲压缩的 token 阈值
- **类型**：`number`
- **默认值**：`200000`
- **功能**：触发空闲压缩的 token 数。
- **可选值**：
  - `100000`
  - `200000`
  - `300000`
  - `400000`
  - `500000`
  - `600000`
  - `700000`
  - `800000`
  - `900000`

### `compaction.idleTimeoutSeconds` — Idle Compaction Delay

- **作用**：空闲多久后开始执行压缩的等待秒数
- **类型**：`number`
- **默认值**：`300`
- **功能**：空闲状态下，触发压缩前的等待秒数。
- **可选值**：
  - `60`
  - `120`
  - `300`
  - `600`
  - `1800`
  - `3600`

### `compaction.supersedeReads` — Supersede Stale Reads

- **作用**：同一文件再次读取时裁剪旧读取结果的陈旧读取淘汰开关
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：当同一文件被再次读取时，剪除较早的读取结果（具备缓存感知，每个回合运行）。

- **可选值**：
  - `true`
  - `false`

### `compaction.dropUseless` — Elide Uneventful Results

- **作用**：消费后裁剪无匹配/超时等无效工具结果的开关
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在被消费后，剪除在语境上被标记为无用的工具结果（无匹配、超时等待等）（具备缓存感知）。

- **可选值**：
  - `true`
  - `false`

### `snapcompact.systemPrompt` — Snapcompact System Prompt

- **作用**：将系统提示渲染为密集 PNG 图像以附在首条用户消息（仅视觉模型，省 token）
- **类型**：`enum`
- **默认值**：`"none"`
- **功能**：（实验性）将选中的系统提示文本渲染为稠密的 PNG 图像，并附加到首条用户消息（仅视觉模型）。节省 token；会损失被成像文本的提示缓存。
- **可选值**：
  - `none` — 保持系统提示为文本
  - `agents-md` — 仅在能节省 token 时，把已加载的上下文文件指令移入图像
  - `all` — 在能节省 token 时，把完整的系统提示移入图像

### `snapcompact.toolResults` — Snapcompact Tool Results

- **作用**：将历史大体积工具结果以密集 PNG 图像替代文本（仅视觉模型）
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：（实验性）将大量历史工具结果渲染为稠密 PNG 图像，而非文本（仅视觉模型）。在累积的 read/search 输出上节省 token。

- **可选值**：
  - `true`
  - `false`

### `tools.format` — Tool Calling Mode

- **作用**：工具调用暴露给模型的方式（自动 / 强制 provider 原生 / 强制某自有方言）
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：控制向模型暴露工具的方式。Auto 在所选模型未标记为不支持时使用 provider 原生工具调用，否则回退到 GLM 自有方言。Native 强制使用 provider 原生工具；其他值强制使用对应的命名自有方言。在会话开始时生效。
- **可选值**：
  - `auto` — 使用原生工具调用，除非已知模型不支持
  - `native` — 使用 provider 原生工具调用
  - `glm` — 使用 GLM 风格的带内工具调用
  - `hermes` — 使用 Hermes 风格的带内工具调用
  - `kimi` — 使用 Kimi 风格的带内工具调用
  - `xml` — 使用通用 XML 带内工具调用
  - `anthropic` — 使用 Anthropic 风格的带内工具调用
  - `deepseek` — 使用 DeepSeek 风格的带内工具调用
  - `harmony` — 使用 Harmony 风格的带内工具调用
  - `qwen3` — 使用 Qwen3 自有方言
  - `gemini` — 使用 Gemini 自有方言
  - `gemma` — 使用 Gemma 自有方言
  - `minimax` — 使用 MiniMax 自有方言

### `snapcompact.shape` — Snapcompact Shape

- **作用**：snapcompact 输出文本的框线形状（Auto 会按当前模型选最优）
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：snapcompact 用来打印文本的字符框形（压缩归档与内联成像）。Auto 为当前模型挑选调优过的框形。
- **可选值**：
  - `auto` — 为当前模型挑选调优过的框形，回退到其 provider 系列
  - `8x8r-bw` — unscii 方格字形，黑色墨水，每行重复打印一遍，并在浅色高亮带上
  - `8x8r-sent` — 重复栅格，墨水在句边界循环六种色调
  - `8x8u-bw` — 朴素的 unscii 方格字形，单次打印，黑色墨水
  - `8x8u-sent` — 朴素 unscii 方格字形，句调墨水
  - `6x6u-bw` — unscii 压缩到 6x6——最稠密可读字形、帧数最少，黑色墨水
  - `6x6u-sent` — 最稠密字形配句调墨水
  - `5x8-bw` — 原始 X.org 5x8 字形，位于 2576px 画布上，黑色墨水
  - `5x8-sent` — 原始 snapcompact 框形（shape 表之前的会话使用的样式）
  - `6x12-dim` — X.org 6x12 字形，黑色墨水，功能词以灰色淡化
  - `8x13-bw` — X.org 8x13 字形，黑色墨水
  - `8on16-bw` — 8x13 字形位于 16px 行距上，黑色墨水
  - `8on22-bw` — 8x13 字形位于 22px 行距上，黑色墨水（OpenAI/Google 默认）
  - `11on16-bw` — 8x13 字形位于 11px 步进（字距）上，黑色墨水（Anthropic 默认）
  - `silver16-bw` — 内嵌 Silver TrueType 字体，位于 16px 网格上，用于 CJK 等非拉丁文本
  - `doc-8on16-bw` — 两栏报纸式排版，8x13 字形位于 16px 行距上，黑色墨水
  - `doc-8on16-sent` — 两栏文档排版配句调墨水
  - `doc-8on16-sent-dim` — 两栏文档排版，句调墨水，功能词以灰色淡化
  - `dotmatrix` — 
  - `6x12-bw`
  - `6x12-bright`

### `branchSummary.enabled` — Branch Summaries

- **作用**：离开分支时提示生成分支摘要的开关
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：离开分支时提示进行总结。

- **可选值**：
  - `true`
  - `false`

### `ttsr.enabled` — TTSR

- **作用**：流式输出命中规则时打断代理的实时流规则（TTSR）总开关
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：当输出匹配规则模式时，在中途中断代理（Time-Traveling Stream Rules）。

- **可选值**：
  - `true`
  - `false`

### `ttsr.contextMode` — TTSR Context Mode

- **作用**：TTSR 命中时对已产生部分输出的处理方式
- **类型**：`enum`
- **默认值**：`"discard"`
- **功能**：TTSR 触发时，对部分输出的处理方式。
- **可选值**：
  - `discard`
  - `keep`

### `ttsr.interruptMode` — TTSR Interrupt Mode

- **作用**：流式中即时打断与完成后追加警告之间的触发时机
- **类型**：`enum`
- **默认值**：`"always"`
- **功能**：何时进行中途中断，何时在完成后注入警告。
- **可选值**：
  - `always` — 在 prose 和 tool 流上都中断
  - `prose-only` — 仅在 reply/thinking 匹配时中断
  - `tool-only` — 仅在工具调用参数匹配时中断
  - `never` — 从不中断；在完成后注入警告

### `ttsr.repeatMode` — TTSR Repeat Mode

- **作用**：单条规则在会话内仅触发一次还是按消息间隔重复触发
- **类型**：`enum`
- **默认值**：`"once"`
- **功能**：规则的重复方式：每个会话一次，或消息间隔后再次触发。
- **可选值**：
  - `once`
  - `after-gap`

### `ttsr.repeatGap` — TTSR Repeat Gap

- **作用**：同一条 TTSR 规则再次触发所需间隔的消息数
- **类型**：`number`
- **默认值**：`10`
- **功能**：规则可再次触发前需要经过的消息数。
- **可选值**：
  - `5`
  - `10`
  - `15`
  - `20`
  - `30`

### `ttsr.builtinRules` — Built-in Rules

- **作用**：是否随代理加载内置默认规则集（可用 disabledRules 单独禁用）
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：加载代理自带的默认规则（通过 `ttsr.disabledRules` 可逐条覆盖）。

- **可选值**：
  - `true`
  - `false`

### `ttsr.disabledRules` — Disabled Rules

- **作用**：完全忽略的规则名列表（同时作用于内置默认与用户自定义规则）
- **类型**：`array`
- **默认值**：`[]`
- **功能**：完全忽略的规则名（对内建默认规则与用户自定义规则均生效）。

- **可选值**：任意字符串数组（无固定枚举）


## Memory（记忆）


共 30 项。


### `memory.backend` — Memory Backend

- **作用**：记忆子系统后端选择（关闭 / 本地总结 / Mnemopi SQLite / Hindsight 远程）
- **类型**：`enum`
- **默认值**：`"off"`
- **功能**：在 off、本地摘要流水线、Mnemopi SQLite、Hindsight 远程记忆服务之间选择。（源码注释：选择本地 memories 流水线、Mnemopi 本地 SQLite、Hindsight 远程记忆或 off 的后端选择器；旧版 `memories.enabled` 标志仅作为迁移输入，参见 config/settings.ts。）
- **可选值**：
  - `off` — 不运行任何记忆子系统
  - `local` — 本地会话摘要流水线（memory_summary.md）
  - `hindsight` — Vectorize Hindsight 远程记忆服务
  - `mnemopi` — 本地 SQLite recall/retain 后端，可选启用 embeddings

### `autolearn.enabled` — Auto-Learn (experimental)

- **作用**：主开关：会话结束后自动触发经验沉淀与受管技能补全
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：代理停止后，提示其将经验沉淀到记忆中，并创建/增强隔离的托管 skill。（源码注释：Auto-Learn（实验性）：停止后通过 nudge 把经验写入记忆，并在 ~/.omp/agent/managed-skills 下创建/增强隔离的托管 skill。主开关默认关闭 → 零占用；子开关控制具体行为。）

- **可选值**：
  - `true`
  - `false`

### `autolearn.autoContinue` — Auto-run capture at stop

- **作用**：自动学习副开关：停止时是否额外多跑一轮私密的捕获回合
- **类型**：`boolean`
- **默认值**：`false`
- **条件**：`autolearnActive` 为真时适用
- **功能**：开启时，在停止时自动运行一次私有捕获回合（会消耗额外 token）。关闭时，仅保留常驻的 auto-learn 提示。

- **可选值**：
  - `true`
  - `false`

### `mnemopi.dbPath` — Mnemopi DB Path

- **作用**：Mnemopi 本地 SQLite 数据库路径（留空走默认记忆目录）
- **类型**：`string`
- **默认值**：—（未设默认值）
- **条件**：`mnemopiActive` 为真时适用
- **功能**：可选的 SQLite 数据库路径。默认为代理 memories 目录。（源码注释：Mnemopi 本地 SQLite 记忆后端。）

- **可选值**：任意字符串（无固定枚举）

### `mnemopi.bank` — Mnemopi Bank

- **作用**：Mnemopi 共享记忆库的基名（按项目作用域派生出本地库）
- **类型**：`string`
- **默认值**：—（未设默认值）
- **条件**：`mnemopiActive` 为真时适用
- **功能**：可选的共享 bank 基础名称。按项目的模式会从中派生出项目级 bank。

- **可选值**：任意字符串（无固定枚举）

### `mnemopi.scoping` — Mnemopi Scoping

- **作用**：Mnemopi 记忆的作用域（全局共享 / 按项目隔离 / 项目写+全局读）
- **类型**：`enum`
- **默认值**：`"per-project"`
- **条件**：`mnemopiActive` 为真时适用
- **功能**：global = 一个共享 bank；per-project = 按 cwd 隔离的 bank；per-project-tagged = 项目本地写入，同时 recall 时可看到全局记忆。
- **可选值**：
  - `global` — 所有项目共用一个 Mnemopi bank
  - `per-project` — 按 cwd basename 隔离的项目级 Mnemopi bank
  - `per-project-tagged` — 写入项目本地 bank，但合并项目与共享 recall 结果

### `mnemopi.embeddingVariant` — Embedding variant

- **作用**：Mnemopi 默认嵌入模型族（英文更强 / 多语言，切换会重建已有嵌入）
- **类型**：`enum`
- **默认值**：`"en"`
- **条件**：`mnemopiActive` 为真时适用
- **功能**：本地 embedding 模型族。en = 更强的英文模型；multilingual = 跨语言模型。切换后会在下次启动时重建已有记忆的 embedding。
- **可选值**：
  - `en` — BAAI/bge-base-en-v1.5（768 维），仅英文
  - `multilingual` — intfloat/multilingual-e5-large（1024 维），跨语言 recall

### `mnemopi.autoRecall` — Mnemopi Auto Recall

- **作用**：在每会话首轮自动召回本地 Mnemopi 记忆
- **类型**：`boolean`
- **默认值**：`true`
- **条件**：`mnemopiActive` 为真时适用
- **功能**：在每个会话的首轮把本地记忆 recall 到上下文中。

- **可选值**：
  - `true`
  - `false`

### `mnemopi.autoRetain` — Mnemopi Auto Retain

- **作用**：自动把完成的会话回合写入 Mnemopi 记忆库
- **类型**：`boolean`
- **默认值**：`true`
- **条件**：`mnemopiActive` 为真时适用
- **功能**：将已完成的会话轮次保留到本地 Mnemopi 记忆中。

- **可选值**：
  - `true`
  - `false`

### `mnemopi.polyphonicRecall` — Mnemopi Polyphonic Recall

- **作用**：开启四路召回（向量/图谱/事实/时序）并以 RRF 融合
- **类型**：`boolean`
- **默认值**：`false`
- **条件**：`mnemopiActive` 为真时适用
- **功能**：启用四路 recall（向量、图谱、事实、时间）并使用 reciprocal rank fusion 融合结果。

- **可选值**：
  - `true`
  - `false`

### `mnemopi.enhancedRecall` — Mnemopi Enhanced Recall

- **作用**：启用分级查询结果缓存以加速重复/相似召回
- **类型**：`boolean`
- **默认值**：`false`
- **条件**：`mnemopiActive` 为真时适用
- **功能**：为重复及相似的 recall 查询启用分层查询结果缓存。

- **可选值**：
  - `true`
  - `false`

### `mnemopi.proactiveLinking` — Mnemopi Proactive Linking

- **作用**：在写入新记忆时主动建立情景图谱中的关联边
- **类型**：`boolean`
- **默认值**：`false`
- **条件**：`mnemopiActive` 为真时适用
- **功能**：在存储新记忆时即摄入事件图谱，将其链接到相关实体和记忆。

- **可选值**：
  - `true`
  - `false`

### `mnemopi.noEmbeddings` — Mnemopi Disable Embeddings

- **作用**：强制仅用确定性 FTS 文本检索，跳过向量嵌入
- **类型**：`boolean`
- **默认值**：`false`
- **条件**：`mnemopiActive` 为真时适用
- **功能**：强制使用纯 FTS（确定性）recall，而非向量 embedding。

- **可选值**：
  - `true`
  - `false`

### `mnemopi.embeddingModel` — Mnemopi Embedding Model

- **作用**：覆盖默认的 Mnemopi 嵌入模型 id（高级）
- **类型**：`string`
- **默认值**：—（未设默认值）
- **条件**：`mnemopiActive` 为真时适用
- **功能**：高级选项：显式 embedding 模型 id，覆盖 variant。留空则使用 `mnemopi.embeddingVariant`。

- **可选值**：任意字符串（无固定枚举）

### `mnemopi.embeddingApiUrl` — Mnemopi Embedding API URL

- **作用**：Mnemopi 使用的 OpenAI 兼容嵌入服务地址
- **类型**：`string`
- **默认值**：—（未设默认值）
- **条件**：`mnemopiActive` 为真时适用
- **功能**：可选的、传递给 Mnemopi 的 OpenAI 兼容 embedding 端点。

- **可选值**：任意字符串（无固定枚举）

### `mnemopi.embeddingApiKey` — Mnemopi Embedding API Key

- **作用**：Mnemopi 嵌入服务的 API 密钥（凭据）
- **类型**：`string`
- **默认值**：—（未设默认值）
- **凭据**：是（`config list` 时脱敏）
- **条件**：`mnemopiActive` 为真时适用
- **功能**：传递给 Mnemopi 的可选 embedding API key。

- **可选值**：任意字符串（无固定枚举）

### `mnemopi.llmMode` — Mnemopi LLM Mode

- **作用**：Mnemopi LLM 抽取后端（关闭 / 在线 tiny / 远程 OpenAI 兼容）
- **类型**：`enum`
- **默认值**：`"smol"`
- **条件**：`mnemopiActive` 为真时适用
- **功能**：不使用 LLM、使用在线小模型（来自 /models 的 TINY 角色，否则为 @smol），或使用远程 OpenAI 兼容端点。
- **可选值**：
  - `none` — 禁用 Mnemopi 由 LLM 驱动的抽取
  - `smol` — 使用在线小模型（来自 /models 的 TINY 角色，否则为 @smol）
  - `remote` — 使用下方 Mnemopi 远程 LLM 设置

### `mnemopi.llmBaseUrl` — Mnemopi LLM Base URL

- **作用**：Mnemopi 远程模式下的 OpenAI 兼容 LLM 接口地址
- **类型**：`string`
- **默认值**：—（未设默认值）
- **条件**：`mnemopiActive` 为真时适用
- **功能**：Mnemopi 远程模式下的可选 OpenAI 兼容 LLM 端点。

- **可选值**：任意字符串（无固定枚举）

### `mnemopi.llmApiKey` — Mnemopi LLM API Key

- **作用**：Mnemopi 远程 LLM 的 API 密钥（凭据）
- **类型**：`string`
- **默认值**：—（未设默认值）
- **凭据**：是（`config list` 时脱敏）
- **条件**：`mnemopiActive` 为真时适用
- **功能**：Mnemopi 远程模式下的可选 LLM API key。

- **可选值**：任意字符串（无固定枚举）

### `mnemopi.llmModel` — Mnemopi LLM Model

- **作用**：Mnemopi 远程模式使用的 LLM 模型名
- **类型**：`string`
- **默认值**：—（未设默认值）
- **条件**：`mnemopiActive` 为真时适用
- **功能**：Mnemopi 远程模式下的可选 LLM 模型名称。

- **可选值**：任意字符串（无固定枚举）

### `hindsight.apiUrl` — Hindsight API URL

- **作用**：Hindsight 记忆服务地址（云端或自托管）
- **类型**：`string`
- **默认值**：`"http://localhost:8888"`
- **条件**：`hindsightActive` 为真时适用
- **功能**：Hindsight 服务器 URL（Cloud 或自托管）。（源码注释：Hindsight（https://hindsight.vectorize.io）。）

- **可选值**：任意字符串（无固定枚举）

### `hindsight.apiToken` — Hindsight API Token

- **作用**：访问鉴权 Hindsight 服务的 Bearer 令牌（凭据）
- **类型**：`string`
- **默认值**：—（未设默认值）
- **凭据**：是（`config list` 时脱敏）
- **条件**：`hindsightActive` 为真时适用
- **功能**：已认证 Hindsight 服务器使用的 Bearer token。

- **可选值**：任意字符串（无固定枚举）

### `hindsight.bankId` — Hindsight Bank ID

- **作用**：Hindsight 记忆库标识（默认按项目名）
- **类型**：`string`
- **默认值**：—（未设默认值）
- **条件**：`hindsightActive` 为真时适用
- **功能**：记忆 bank 标识符（默认：项目名称）。

- **可选值**：任意字符串（无固定枚举）

### `hindsight.scoping` — Hindsight Scoping

- **作用**：Hindsight 记忆作用域（全局共享 / 按项目隔离 / 共享+项目标签合并）
- **类型**：`enum`
- **默认值**：`"per-project-tagged"`
- **条件**：`hindsightActive` 为真时适用
- **功能**：global = 一个共享 bank；per-project = 按 cwd 隔离的 bank；per-project-tagged = 共享 bank 并附项目标签，使全局和项目记忆在 recall 时合并。
- **可选值**：
  - `global` — 共享 bank —— 所有项目看到相同的记忆
  - `per-project` — 按 cwd basename 隔离的 bank —— 项目之间互不可见
  - `per-project-tagged` — 共享 bank，保留内容带 `project:<cwd>` 标签。recall 时同时呈现项目与未打标签的全局记忆

### `hindsight.autoRecall` — Hindsight Auto Recall

- **作用**：在每会话首轮自动召回 Hindsight 记忆
- **类型**：`boolean`
- **默认值**：`true`
- **条件**：`hindsightActive` 为真时适用
- **功能**：在每个会话的首轮 recall 记忆。

- **可选值**：
  - `true`
  - `false`

### `hindsight.autoRetain` — Hindsight Auto Retain

- **作用**：按回合间隔与会话边界自动把对话写入 Hindsight
- **类型**：`boolean`
- **默认值**：`true`
- **条件**：`hindsightActive` 为真时适用
- **功能**：每隔 N 轮以及在会话边界保留（retain）转录内容。

- **可选值**：
  - `true`
  - `false`

### `hindsight.retainMode` — Hindsight Retain Mode

- **作用**：Hindsight 写入粒度（整会话单文档 / 按回合切片）
- **类型**：`enum`
- **默认值**：`"full-session"`
- **条件**：`hindsightActive` 为真时适用
- **功能**：full-session = 每个会话 upsert 一个文档；last-turn = 按轮次切片。
- **可选值**：
  - `full-session` — 每个会话 upsert 一个文档（推荐）
  - `last-turn` — 按轮次边界切片保留

### `hindsight.mentalModelsEnabled` — Hindsight Mental Models

- **作用**：启动时把 Hindsight 中已整理的心智模型读入开发者指令
- **类型**：`boolean`
- **默认值**：`true`
- **条件**：`hindsightActive` 为真时适用
- **功能**：在启动时将策划好的 reflect 摘要（mental models）读取到开发者指令中。只读取 bank 上已有模型，不写入。可与 `hindsight.mentalModelAutoSeed` 搭配，自动创建内置种子集。

- **可选值**：
  - `true`
  - `false`

### `hindsight.mentalModelAutoSeed` — Hindsight Mental Model Auto-Seed

- **作用**：会话启动时自动创建缺失的内置心智模型种子
- **类型**：`boolean`
- **默认值**：`true`
- **条件**：`hindsightActive` 为真时适用
- **功能**：在会话开始时，在 bank 上创建尚不存在的内置 mental models（project-conventions、project-decisions、user-preferences）。

- **可选值**：
  - `true`
  - `false`

### `providers.memoryModel` — Memory Model

- **作用**：Mnemopi 用于事实抽取与整合的 LLM（在线 tiny 或本地小型模型）
- **类型**：`enum`
- **默认值**：`"online"`
- **条件**：`mnemopiActive` 为真时适用
- **功能**：用于事实抽取与合并的 Mnemopi LLM：默认 online（来自 /models 的 TINY 角色，否则为 smol/remote），或本地端侧模型。
- **可选值**：
  - `online` — 使用在线模型：若设置了 /models 中的 TINY 角色则使用之，否则使用 @smol。不下载本地模型，不在端侧推理
  - `qwen3-1.7b` — 本地推理已禁用：onnxruntime-node 无法运行此 ONNX 导出的 RotaryEmbedding 缓存更新
  - `llama3.2:3b` — 用于本地记忆/分类任务的更大 Llama 3.2 选项；质量潜力更高，但磁盘/内存/延迟成本也更高
  - `gemma-3-1b` — 合并/去重效果最佳；占用更轻，但抽取时会泄漏少量闲聊内容
  - `qwen2.5-1.5b` — 抽取粒度最佳（原子事实）；合并能力较弱
  - `lfm2-1.2b` — 加载最快；综合表现稳定，抽取标签略噪


## Files（文件）


共 26 项。


### `edit.mode` — Edit Mode

- **作用**：编辑工具后端的选择（replace/patch/hashline/apply_patch 等变体）
- **类型**：`enum`
- **默认值**：`"hashline"`
- **功能**：选择编辑工具的变体（replace、patch、hashline 或 apply_patch）。（源码注释：编辑工具。）
- **可选值**：
  - `apply_patch`
  - `hashline`
  - `patch`
  - `replace`
  - `sloppy`

### `edit.fuzzyMatch` — Fuzzy Match

- **作用**：编辑匹配时是否接受高置信度的空白差异模糊匹配
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：对空白差异接受高置信度的模糊匹配。

- **可选值**：
  - `true`
  - `false`

### `edit.fuzzyThreshold` — Fuzzy Match Threshold

- **作用**：模糊匹配可接受的相似度阈值（0–1，越大越严格）
- **类型**：`number`
- **默认值**：`0.95`
- **功能**：接受模糊匹配的相似度阈值（0-1）。
- **可选值**：
  - `0.85` — 宽松
  - `0.90` — 中等
  - `0.95` — 默认
  - `0.98` — 严格

### `edit.streamingAbort` — Abort on Failed Preview

- **作用**：流式编辑过程中补丁预览失败时是否中止本次调用
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：当补丁预览失败时中止流式编辑工具调用。

- **可选值**：
  - `true`
  - `false`

### `edit.blockAutoGenerated` — Block Auto-Generated Files

- **作用**：是否拒绝编辑看起来由工具自动生成的文件（protoc、sqlc、swagger 等）
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：阻止编辑疑似自动生成的文件（如 protoc、sqlc、swagger 等）。

- **可选值**：
  - `true`
  - `false`

### `edit.enforceSeenLines` — Enforce Seen-Line Guard

- **作用**：拒绝锚定在历史 read/search 未完整展示过的行上的编辑
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：拒绝锚定在先前 read/search 未完整显示过的行上的编辑。

- **可选值**：
  - `true`
  - `false`

### `edit.blackbox.enabled` — Record Parse Regressions

- **作用**：编辑引入 AST 解析失败时是否记录完整的前后源码
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：当某次编辑导致 AST 解析失败时，记录编辑前后的完整源码。

- **可选值**：
  - `true`
  - `false`

### `edit.autoRepair.enabled` — Auto-Repair Parse Regressions

- **作用**：编辑破坏 AST 解析时是否让 smol 模型自动修复断点区域（重解析校验）
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：当编辑破坏文件的 AST 解析时，请求 smol 模型修复损坏区域（通过重新解析校验；失败则降级为告警）。

- **可选值**：
  - `true`
  - `false`

### `readLineNumbers` — Line Numbers

- **作用**：read 工具默认是否在输出前加行号
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：默认在 read 工具输出前添加行号。

- **可选值**：
  - `true`
  - `false`

### `read.defaultLimit` — Default Read Limit

- **作用**：read 未显式指定 limit 时返回的默认行数
- **类型**：`number`
- **默认值**：`300`
- **功能**：智能体调用 read 但未指定 limit 时返回的默认行数。
- **可选值**：
  - `200` — 200 lines
  - `300` — 300 lines
  - `500` — 500 lines
  - `1000` — 1000 lines
  - `5000` — 5000 lines

### `read.renderMarkdown` — Markdown Previews

- **作用**：是否把 Markdown 读取结果渲染为终端格式化的预览而非原始源码
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：将 Markdown 文件的 read 结果渲染为格式化后的终端 Markdown 预览，而非原始源码。

- **可选值**：
  - `true`
  - `false`

### `read.summarize.enabled` — Read Summaries

- **作用**：read 在无明确选择器时是否返回结构化代码摘要
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：当 read 未指定显式选择器时返回结构化的代码摘要。

- **可选值**：
  - `true`
  - `false`

### `read.summarize.prose` — Prose Summaries

- **作用**：是否对 Markdown 与纯文本的 read 也生成结构化摘要
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：为 Markdown 和纯文本 read 返回结构化摘要。

- **可选值**：
  - `true`
  - `false`

### `read.summarize.minBodyLines` — Read Summary Body Lines

- **作用**：多行函数体或字面量达到此长度才在摘要中被折叠
- **类型**：`number`
- **默认值**：`4`
- **功能**：read 摘要折叠多行函数体或字面量前所需的最小行数。

- **可选值**：任意数字（无固定枚举）

### `read.summarize.minCommentLines` — Read Summary Comment Lines

- **作用**：多行块注释达到此长度才在摘要中被折叠
- **类型**：`number`
- **默认值**：`6`
- **功能**：read 摘要折叠多行块注释前所需的最小行数。

- **可选值**：任意数字（无固定枚举）

### `read.summarize.minTotalLines` — Read Summary Minimum File Length

- **作用**：小于此行数的文件直接逐行返回，不做结构化摘要
- **类型**：`number`
- **默认值**：`100`
- **功能**：总行数少于该值的文件按原文读取，不进行结构化摘要。

- **可选值**：任意数字（无固定枚举）

### `read.summarize.unfoldUntil` — Read Summary Unfold Target

- **作用**：BFS 展开可折叠段落直到摘要至少达到该行数（0 表示仅保留最外层省略）
- **类型**：`number`
- **默认值**：`50`
- **功能**：BFS 展开可省略的区段，直至摘要至少达到该可见行数。设为 0 时仅保留最外层省略。

- **可选值**：任意数字（无固定枚举）

### `read.summarize.unfoldLimit` — Read Summary Unfold Ceiling

- **作用**：BFS 展开时单次展开可见行数的硬上限（超出则跳过该段）
- **类型**：`number`
- **默认值**：`100`
- **功能**：BFS 展开过程中摘要大小的硬上限。某次展开若将导致可见行数超过该值则跳过（该区段保持折叠），并继续展开其余区段。

- **可选值**：任意数字（无固定枚举）

### `read.toolResultPreview` — Inline Read Previews

- **作用**：是否把 read 工具结果以内联预览形式直接渲染在对话流中
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：将 read 工具结果以内联形式渲染到记录中，而非以摘要行呈现。

- **可选值**：
  - `true`
  - `false`

### `lsp.enabled` — LSP

- **作用**：是否启用 lsp 工具提供定义、引用、诊断、重命名等代码智能
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用 lsp 工具以提供代码智能（定义、引用、诊断、重命名）。（源码注释：LSP。）

- **可选值**：
  - `true`
  - `false`

### `lsp.lazy` — Lazy LSP Startup

- **作用**：是否延迟到首次使用（lsp 工具或编辑对应文件）时再启动语言服务器
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在首次使用时（lsp 工具或编辑匹配的文件类型）才启动语言服务器，而非会话启动时。

- **可选值**：
  - `true`
  - `false`

### `lsp.shared` — Shared Language Servers

- **作用**：是否通过守护进程 broker 跨 omp 实例共享每个项目的语言服务器（不可用时回退私有实例）
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：通过守护进程 broker 在 omp 实例间共享每个项目一个语言服务器（不可用时回退为私有服务器）。

- **可选值**：
  - `true`
  - `false`

### `lsp.formatOnWrite` — Format on Write

- **作用**：写文件后是否通过 LSP 自动格式化代码
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：写入代码文件后通过 LSP 自动格式化。

- **可选值**：
  - `true`
  - `false`

### `lsp.diagnosticsOnWrite` — Diagnostics on Write

- **作用**：写代码文件后是否返回 LSP 诊断信息
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：写入代码文件后返回 LSP 诊断信息。

- **可选值**：
  - `true`
  - `false`

### `lsp.diagnosticsOnEdit` — Diagnostics on Edit

- **作用**：编辑代码文件后是否返回 LSP 诊断信息
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：编辑代码文件后返回 LSP 诊断信息。

- **可选值**：
  - `true`
  - `false`

### `lsp.diagnosticsDeduplicate` — Deduplicate Diagnostics

- **作用**：是否抑制同一文件已展示过的重复诊断，只显示新增或变化的诊断
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：抑制文件已显示过的编辑后 LSP 诊断，只呈现新增或变化的内容。

- **可选值**：
  - `true`
  - `false`


## Shell（终端）


共 17 项。


### `bash.enabled` — Bash

- **作用**：是否启用 bash 工具来执行 shell 命令
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用 bash 工具以执行 shell 命令。

- **可选值**：
  - `true`
  - `false`

### `bash.autoBackground.enabled` — Bash Auto-Background

- **作用**：是否自动将长时间运行的 bash 命令转入后台并延后返回结果
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：自动将长时间运行的 bash 命令转入后台执行，延后返回结果。

- **可选值**：
  - `true`
  - `false`

### `bash.patterns` — Bash Approval Patterns

- **作用**：bash 命令的有序审批规则列表（仅支持 `*` 通配符）
- **类型**：`array`
- **默认值**：`[]`
- **功能**：有序的 bash 命令审批规则数组；每项包含 `match` 与 `approval` 字段，仅支持 `*` 通配符。

- **可选值**：任意字符串数组（无固定枚举）

### `bashInterceptor.enabled` — Bash Interceptor

- **作用**：是否拦截已有专用工具负责的 shell 命令，改走专用工具
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：拦截已有专用工具的 shell 命令。（源码注释：Bash 拦截器。）

- **可选值**：
  - `true`
  - `false`

### `bash.direnv` — direnv Auto-Load

- **作用**：bash 会话是否自动加载仓库的 direnv/devenv `.envrc` 环境
- **类型**：`enum`
- **默认值**：`"auto"`
- **功能**：将会话所在仓库的 direnv/devenv `.envrc` 自动加载到 bash 会话中，免去手动执行 `direnv exec` 即可获得 devenv 工具与环境变量。遵守 direnv 的 allow 列表：未执行 `direnv allow` 的 `.envrc` 永远不会被执行。
- **可选值**：
  - `auto` — 自动检测并加载
  - `off` — 关闭自动加载

### `bash.direnvLoadTimeoutMs` — direnv Load Timeout (ms)

- **作用**：等待首次 `direnv export` 的最长时间（毫秒），超时则无 env 启动
- **类型**：`number`
- **默认值**：`30000`
- **功能**：等待首次 `direnv export` 的最长毫秒数（冷启动的 devenv shell 可能较慢）；超时后会话将在不带 direnv 环境的情况下运行。

- **可选值**：任意数字（无固定枚举）

### `shellMinimizer.enabled` — Shell Minimizer

- **作用**：是否压缩 git/npm/cargo 等命令的冗长输出再交给模型
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在返回给 agent 之前压缩（git、npm、cargo 等产生的）冗长 shell 输出。（源码注释：Shell 输出最小化器。）

- **可选值**：
  - `true`
  - `false`

### `shellMinimizer.sourceOutlineLevel` — Shell Minimizer Source Outline

- **作用**：对源码类 cat/read 输出的轮廓化压缩强度（默认/激进）
- **类型**：`enum`
- **默认值**：`"default"`
- **功能**：对 `cat`/`read` 读取的源文件所采用的轮廓提取模式：`default` 或 `aggressive`。
- **可选值**：
  - `default` — 默认轮廓模式
  - `aggressive` — 激进轮廓模式

### `eval.py` — Python Eval Backend

- **作用**：eval 工具是否允许把 Python cell 分发到 IPython 内核
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：允许 eval 工具将 Python 代码 cell 分发到 IPython 内核执行。（源码注释：各后端独立开关；随新后端发布继续追加，例如 `eval.ts`。）

- **可选值**：
  - `true`
  - `false`

### `eval.js` — JavaScript Eval Backend

- **作用**：eval 工具是否允许把 JavaScript cell 分发到进程内运行时
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：允许 eval 工具将 JavaScript 代码 cell 分发到进程内运行时执行。

- **可选值**：
  - `true`
  - `false`

### `eval.rb` — Ruby Eval Backend

- **作用**：eval 工具是否允许把 Ruby cell 分发到持久 Ruby 内核
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：允许 eval 工具将 Ruby 代码 cell 分发到常驻 Ruby 内核执行。

- **可选值**：
  - `true`
  - `false`

### `eval.jl` — Julia Eval Backend

- **作用**：eval 工具是否允许把 Julia cell 分发到持久 Julia 内核
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：允许 eval 工具将 Julia 代码 cell 分发到常驻 Julia 内核执行。

- **可选值**：
  - `true`
  - `false`

### `eval.autoBackground.enabled` — Eval Auto-Background

- **作用**：是否自动将长时间运行的 eval cell 转入后台并延后返回结果
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：自动将长时间运行的 eval cell 转入后台执行，延后返回结果。

- **可选值**：
  - `true`
  - `false`

### `python.kernelMode` — Python Kernel Mode

- **作用**：IPython 内核的复用模式（跨调用常驻或每次新建）
- **类型**：`enum`
- **默认值**：`"session"`
- **功能**：决定 IPython 内核在多次 eval 调用之间保持存活，还是每次调用都重新启动。（源码注释：运行时开关，由 eval 后端与 `/python` slash 命令消费。）
- **可选值**：
  - `session` — 跨调用保持内核存活
  - `per-call` — 每次调用启动新内核

### `python.interpreter` — Python Interpreter

- **作用**：指定 Python 解释器绝对路径；设置后跳过自动运行时探测
- **类型**：`string`
- **默认值**：`""`
- **功能**：可选的精确 Python 可执行文件路径。设置后将跳过自动的 Python 运行时探测。

- **可选值**：任意字符串（无固定枚举）

### `ruby.interpreter` — Ruby Interpreter

- **作用**：指定 Ruby 解释器绝对路径；设置后跳过自动运行时探测
- **类型**：`string`
- **默认值**：`""`
- **功能**：可选的精确 Ruby 可执行文件路径。设置后将跳过自动的 Ruby 运行时探测。

- **可选值**：任意字符串（无固定枚举）

### `julia.interpreter` — Julia Interpreter

- **作用**：指定 Julia 解释器绝对路径；设置后跳过自动运行时探测
- **类型**：`string`
- **默认值**：`""`
- **功能**：可选的精确 Julia 可执行文件路径。设置后将跳过自动的 Julia 运行时探测。

- **可选值**：任意字符串（无固定枚举）


## Tasks（任务）


共 28 项。


### `plan.enabled` — Plan Mode

- **作用**：开启只读规划模式，让会话先探查与规划再执行
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在执行前启用只读探索和规划的计划模式。（源码注释：Plan mode）

- **可选值**：
  - `true`
  - `false`

### `plan.defaultOnStartup` — Start in Plan Mode

- **作用**：每个新会话启动时默认直接进入规划模式
- **类型**：`boolean`
- **默认值**：`false`
- **条件**：`planModeEnabled` 为真时适用
- **功能**：在每个新会话开始时自动进入计划模式

- **可选值**：
  - `true`
  - `false`

### `goal.enabled` — Goal Mode

- **作用**：开启会话级目标模式与隐藏的 goal 工具
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：启用每个会话的目标模式以及隐藏的目标工具

- **可选值**：
  - `true`
  - `false`

### `goal.statusInFooter` — Goal Status in Footer

- **作用**：在状态栏目标指示器旁显示剩余 token 预算
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在状态栏的目标指示器旁显示 token 预算

- **可选值**：
  - `true`
  - `false`

### `goal.continuationModes` — Goal Continuation Modes

- **作用**：允许目标在会话轮次之间自动延续的运行模式列表
- **类型**：`array`
- **默认值**：`["interactive"]`
- **功能**：允许活动目标在轮次之间自动延续的运行模式

- **可选值**：任意字符串数组（无固定枚举）

### `title.refreshOnReplan` — Refresh Title on Replan

- **作用**：在 todo 初始化重排后刷新自动生成的会话标题（用户手设的标题保留）
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：在 todo 初始化重新规划后刷新生成的会话标题，除非该标题由用户设置

- **可选值**：
  - `true`
  - `false`

### `task.isolation.mode` — Isolation Mode

- **作用**：子代理隔离后端（auto 让 PAL 自动挑选最优：CoW 文件系统 → overlayfs/ProjFS → git worktree / 递归复制兜底）
- **类型**：`enum`
- **默认值**：`"none"`
- **功能**：子代理的隔离后端。`"auto"` 让原生 PAL 选择最佳可用后端（识别 CoW 的文件系统，然后是 overlayfs/ProjFS，最后回退到 git worktree / 递归复制）。（源码注释：Delegation）
- **可选值**：
  - `none` — 不进行隔离
  - `auto` — 由 PAL 选择最佳可用后端
  - `apfs` — macOS clonefile reflink（APFS）
  - `btrfs` — btrfs 子卷快照
  - `zfs` — ZFS 快照 + 克隆
  - `reflink` — Linux FICLONE 单文件 reflink
  - `overlayfs` — Linux 内核 overlay（或 fuse-overlayfs 回退）
  - `projfs` — Windows Projected File System
  - `block-clone` — Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE（NTFS/ReFS）
  - `rcopy` — 递归复制

### `task.isolation.apply` — Apply Isolated Changes

- **作用**：子代理成功后是否自动把隔离变更合回父工作区（关闭则保留 patch 或分支产物）
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：自动将成功的隔离任务变更应用到父工作区；禁用以保留 patch 或 branch 制品

- **可选值**：
  - `true`
  - `false`

### `task.isolation.merge` — Isolation Merge Strategy

- **作用**：把隔离子代理的改动合回父仓库的策略（patch 合并或分支合并）
- **类型**：`enum`
- **默认值**：`"patch"`
- **功能**：隔离任务变更的整合方式（patch 应用或分支合并）
- **可选值**：
  - `patch` — 合并 diff 并 git apply
  - `branch` — 每个任务一次提交，使用 `--no-ff` 合并

### `task.isolation.commits` — Isolation Commit Style

- **作用**：嵌套仓库提交信息的生成方式（固定模板或由 AI 根据 diff 生成）
- **类型**：`enum`
- **默认值**：`"generic"`
- **功能**：嵌套仓库变更的提交信息风格（通用或 AI 生成）
- **可选值**：
  - `generic` — 静态提交信息
  - `ai` — 由 diff 生成的 AI 提交信息

### `worktree.base` — Worktree Base Directory

- **作用**：代理管理 worktree 的根目录（任务隔离副本、github PR 检出、`omp worktree` 清理均位于此）
- **类型**：`string`
- **默认值**：—（未设默认值）
- **功能**：代理管理工作区的基目录——任务隔离副本、`github` PR checkout 以及 `omp worktree` 清理都位于此目录。未设置时使用 `~/.omp/wt`。必须是绝对路径或以 `~` 开头的相对路径；相对路径会被忽略。环境变量 `OMP_WORKTREE_DIR` 优先于此设置

- **可选值**：任意字符串（无固定枚举）

### `task.eager` — Prefer Task Delegation

- **作用**：把工作下放给子代理的强度（默认由模型决定 / 在系统提示中加强 / 提示加首轮委派提醒）
- **类型**：`enum`
- **默认值**：`"default"`
- **功能**：将工作下放给子代理的倾向程度
- **可选值**：
  - `default` — 由模型自行决定何时下放
  - `preferred` — 在系统提示中加入下放指引
  - `always` — 提示指引外加首轮下放提醒

### `task.batch` — Batch Task Calls

- **作用**：把 task 工具切换为批量形态（一次调用下发 tasks[]，每项派一名子代理，可逐项隔离并共享前置上下文）
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：将 task 工具切换为批量形式：一次调用承载 `{ context, tasks[] }`——每个条目对应一个子代理，可为每项指定 agent（默认使用会话的 spawn-policy agent）、可指定每项隔离，并要求一段共享 context 拼接到每项任务说明前。当 `async.enabled=true` 时，每个 spawn 作为独立的后台代理运行，遵循常规 idle/parked 生命周期；否则调用阻塞等待合并结果。禁用以恢复扁平的单 spawn schema

- **可选值**：
  - `true`
  - `false`

### `task.enableEffort` — Per-Task Effort

- **作用**：在 task 调用中暴露 effort 参数，允许每次委派时覆盖子代理的思考强度
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：在 task spawn 上暴露可选的 effort 参数，允许调用者覆盖每个子代理的思考级别

- **可选值**：
  - `true`
  - `false`

### `task.maxConcurrency` — Max Concurrent Tasks

- **作用**：同时在跑的子代理数量上限
- **类型**：`number`
- **默认值**：`32`
- **功能**：同时运行的子代理最大数量
- **可选值**：
  - `0` — Unlimited
  - `1` — 1 task
  - `2` — 2 tasks
  - `4` — 4 tasks
  - `8` — 8 tasks
  - `16` — 16 tasks
  - `32` — 32 tasks
  - `64` — 64 tasks

### `task.enableLsp` — LSP in Subagents

- **作用**：允许 task 派出的子代理使用 lsp 工具（默认关闭以控制开销）
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：允许通过 task 工具派生的子代理使用 lsp 工具。默认关闭以保持子代理轻量；当 LSP 感知的下放值得额外 token 时再启用

- **可选值**：
  - `true`
  - `false`

### `task.maxRecursionDepth` — Max Task Recursion

- **作用**：子代理可继续派生子代理的最大层数
- **类型**：`number`
- **默认值**：`2`
- **功能**：子代理派生自己的子代理的最大嵌套层数
- **可选值**：
  - `-1` — Unlimited
  - `0` — None
  - `1` — Single
  - `2` — Double
  - `3` — Triple

### `task.maxRuntimeMs` — Max Subagent Runtime

- **作用**：单个子代理的硬性 wall-clock 时长上限（ms），超时则正常中止并标记 timed out
- **类型**：`number`
- **默认值**：`0`
- **功能**：每个子代理的硬性时钟上限（毫秒）。`0` 禁用。作为纵深防御，应对推理层看门狗未捕获的 provider 端流挂起；触发时按正常子代理中止处理，reason 为 `timed out`
- **可选值**：
  - `0` — Unlimited
  - `300000` — 5 minutes
  - `900000` — 15 minutes
  - `1800000` — 30 minutes
  - `3600000` — 1 hour

### `task.agentIdleTtlMs` — Agent Idle TTL

- **作用**：空闲子代理在内存中保留多长时间后落盘 park（收到消息自动唤醒）
- **类型**：`number`
- **默认值**：`420000`
- **功能**：空闲子代理在内存中保持存活多久后被 park 到磁盘（毫秒）。parked 代理在被发消息或恢复时会自动唤醒。`0` 让空闲代理一直保持存活直到退出

- **可选值**：任意数字（无固定枚举）

### `task.softRequestBudget` — Soft Subagent Request Budget

- **作用**：每个子代理的软性请求次数上限（超出注入收尾提醒，达 1.5× 强制 yield）
- **类型**：`number`
- **默认值**：`200`
- **功能**：每个子代理的软请求预算（每次运行的 assistant 请求数）。超过时注入收尾提示（参见 `task.softRequestBudgetNotice`）；达到 1.5x 预算时强制停止运行，代理必须交还部分结果。`0` 禁用该保护。内建的 scout/sonic 代理有更低的内置预算上限，因此低于该上限的值仍对它们生效
- **可选值**：
  - `0` — Disabled
  - `90` — 90 requests
  - `150` — 150 requests
  - `200` — 200 requests

### `task.softRequestBudgetNotice` — Soft Request Budget Notice

- **作用**：子代理越过软性请求预算时是否注入一条提醒其尽快收尾的提示
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：当子代理超过其软请求预算时，注入一条收尾提示，要求其在 1.5x 强制 yield 之前结束工作

- **可选值**：
  - `true`
  - `false`

### `task.maxEffort` — Maximum Per-Spawn Effort

- **作用**：task 调用方 per-spawn effort 提示的最大允许档位（封顶防止越权上调思考强度）
- **类型**：`enum`
- **默认值**：`"max"`
- **功能**：task 工具每次 spawn effort 提示所允许的最大推理 effort。较低的值可防止调用者将子代理的 effort 提升超过此上限；默认值保留模型完整范围
- **可选值**：
  - `minimal`
  - `low`
  - `medium`
  - `high`
  - `xhigh`
  - `max`

### `task.prewalk` — Generic Task Prewalk

- **作用**：为内置通用 task 子代理启用 prewalk（先在主模型上规划与起步，首次编辑/写入时切到 smol）
- **类型**：`boolean`
- **默认值**：`false`
- **功能**：为内建通用 `task` 子代理启用 prewalk：在其解析后的模型上启动，先规划并开始实现，然后在首次编辑/写入时交接给 `smol` 角色。代理级覆写（`task.agentPrewalk`，从 /agents hub 配置）以及用户代理 `prewalk` frontmatter 始终生效，与此开关无关

- **可选值**：
  - `true`
  - `false`

### `skills.enableSkillCommands` — Skill Commands

- **作用**：把 skills 注册为 /skill:name 斜杠命令
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：将 skills 注册为 /skill:name 命令

- **可选值**：
  - `true`
  - `false`

### `commands.enableClaudeUser` — Claude User Commands

- **作用**：是否从 ~/.claude/commands/ 加载用户级 Claude 斜杠命令
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：从 `~/.claude/commands/` 加载命令。（源码注释：Commands）

- **可选值**：
  - `true`
  - `false`

### `commands.enableClaudeProject` — Claude Project Commands

- **作用**：是否从 .claude/commands/ 加载项目级 Claude 斜杠命令
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：从 `.claude/commands/` 加载命令

- **可选值**：
  - `true`
  - `false`

### `commands.enableOpencodeUser` — OpenCode User Commands

- **作用**：是否从 ~/.config/opencode/commands/ 加载用户级 OpenCode 斜杠命令
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：从 `~/.config/opencode/commands/` 加载命令

- **可选值**：
  - `true`
  - `false`

### `commands.enableOpencodeProject` — OpenCode Project Commands

- **作用**：是否从 .opencode/commands/ 加载项目级 OpenCode 斜杠命令
- **类型**：`boolean`
- **默认值**：`true`
- **功能**：从 `.opencode/commands/` 加载命令

- **可选值**：
  - `true`
  - `false`



---



> 维护：本页由 `SETTINGS_SCHEMA` 渲染生成。新增/修改配置项、默认值或枚举后，请按相同流程重新生成并核对条目数。
