# model-and-skill-discovery

## Purpose

规定用户技能与共享技能发现等 fork 默认能力。用户和项目显式配置的优先级及同名来源规则保持原有边界。

## Requirements

### Requirement: Codex 用户技能

OMP MUST 默认启用 Codex 用户技能发现。

#### Scenario: Codex 用户技能的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 将 `skills.enableCodexUser` 的缺省值改为 `true`，并在设置尚未初始化时也启用 `~/.codex/skills/*/SKILL.md` 发现。

#### Scenario: Codex 用户技能的可观察行为

- **WHEN** 未设置额外技能目录
- **THEN** 默认启用 Codex 用户技能发现

### Requirement: 团队共享技能目录

OMP MUST 按单层目录发现及优先级加载；禁用时执行侧不扫描，管理侧仍可重新启用。

#### Scenario: 团队共享技能目录的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 设置非空 `OMP_SKILLS_DIR` 后，将该目录作为附加技能根目录，沿用现有单层 `<目录>/<技能名>/SKILL.md` 扫描、校验、过滤、命名空间与去重机制；不要求配置文件，不下载、复制或同步技能。
- 共享目录优先于用户、项目及 `skills.customDirectories` 中的同名技能；共享版本取得原技能名，内容不同的低优先级版本沿用现有命名空间规则保留。执行发现与管理界面沿用同一 catalog 的命名与优先级规则；管理界面标明 `Shared` 来源，展示实际生效的裸名及保留的 namespace 版本，不另行产生一套名称或优先级。面板使用当前宿主会话的 `skills` 配置，不取其他会话最新绑定的全局配置。未设置、为空或目录不存在时保留原有技能发现行为。
- 该变量独立于 `OMP_OFFLINE`，在技能发现及刷新时生效；默认技能禁用、包含与排除规则继续有效。管理 catalog 保留禁用项、关闭来源及其诊断；执行侧在扫描前按启用来源过滤，不扫描关闭来源，也不向执行返回关闭来源的警告。通过现有 `/extensions` 启停并异步刷新执行侧技能列表、补全与可读内容；禁用项不可执行，但仍可在管理界面重新启用。启停沿用现有配置机制，不修改共享目录中的 `SKILL.md` 或其他 NFS 源文件，不新增共享写入或同步机制。
- 仅 Linux offline 的共享／自定义目录扫描不逐技能同步探测 `SKILL.md` 是否存在，直接走既有异步普通文件校验与内容读取；同轮加载按展开后的绝对目录去重，共享来源优先，不新增跨会话缓存或目录镜像。新增、删除及正文更新仍通过既有刷新失效机制生效，禁用和来源隔离保持。

#### Scenario: 团队共享技能目录的可观察行为

- **WHEN** 设置有效共享技能根或禁用该来源
- **THEN** 按单层目录发现及优先级加载；禁用时执行侧不扫描，管理侧仍可重新启用

### Requirement: 压缩触发的待输入预算

OMP MUST 把即将被自动消费的排队输入计入自动压缩的待输入预算，与直接 prompt 同口径，不改变阈值与方法顺序。

#### Scenario: 压缩触发的待输入预算的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 轮次文本结束（`willContinue=false`）时，若 agent loop 在 yield 边界会自动 drain 队列输入，则这些输入与直接 prompt 一样属于待输入预算：先按同一阈值判断是否需要自动压缩，再消费队列首条。仅在显式 hold（`queuedMessagesHeld`）时不消费，`followUpAutoDrain=false` 时 follow-up 队列保持排队；steering 在 stop 边界同样强制下一轮模型调用。
- 计算沿用直接 prompt 的 `max` 语义：provider usage 锚定估算加 pending 与本地估算加 pending 取较大者；排队输入未进入 prepared history 时，以 `pendingContextTokens` 参与已武装 speculation 的校验，阶段按 `pre_turn` 处理。
- 不改压缩阈值、方法顺序、触发判定和非排队路径行为；被取消、已释放或已结清的会话不因该预算额外压缩，消费顺序不变。

#### Scenario: 队列输入在自动压缩后消费

- **WHEN** 一轮结束且待消费队列非空，加入队列输入后超过自动压缩阈值
- **THEN** 先执行自动压缩，再消费队列首条，不把排队输入当作已在上文中的历史

### Requirement: 请求级上下文的独立计数

OMP MUST 用 `markPerCallContextMessage` 标记仅本次请求携带的消息并单独计数，只以增量形式计入当次调用的 prompt 估算，MUST NOT 让其混入后续压缩基线。

#### Scenario: 有 usage 锚点的请求级上下文

- **WHEN** 一次调用包含仅本次请求使用的消息，历史中存在 `TranscriptUsageAnchor`，锚点记录的总请求级计数不小于其按来源分项之和，且本次请求级消息都带来源
- **THEN** prompt 估算 MUST 以锚点用量为基础加请求级计数增量：增量增加时按本地计数并叠加估算余量，增量减少时只从锚点用量中扣除且不降到零以下
- **AND** 锚点之后追加的普通消息 MUST 本地计数并叠加同一余量（本地计数 + 向上取整的 1/10），每个本地计数的消息 MUST 额外计入 `MESSAGE_FRAMING_TOKENS`（16）
- **AND** 统计结果 MUST 写入该次 assistant 消息的 `perCallContextTokens`；每条请求级消息都带具名来源时，MUST 同时写入按来源分项的 `perCallContextTokensBySource`。

#### Scenario: 匿名变换或缺少锚点

- **WHEN** 锚点记录的总请求级计数大于其按来源分项之和、存在无来源的请求级消息，或没有可用锚点
- **THEN** MUST 退回本地全量估算：上下文总计数叠加估算余量，并按消息条数叠加 `MESSAGE_FRAMING_TOKENS`
- **AND** MUST NOT 依据已无法重建的锚点推断增量。

### Requirement: Judge 候选池的会话作用域

OMP MUST 在会话或项目配置了 `enabledModels` 时，把 judge 候选池限制在同一作用域内，作用域外模型不进入主候选或 fallback。

#### Scenario: Judge 候选池的会话作用域的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 自动 thinking、图片、文本等经 judge 角色发起的判定，其候选链先经当前会话/项目 `enabledModels`（与 `ModelControls.getAvailableModels`、Team 配置同一语义）过滤，再参与角色链解析；主候选与 fallback 均不得外呼作用域外的远端模型。
- 未配置 `enabledModels` 时保持原候选池不变；会话自身模型仍按既有 `withSessionFallback` 追加，不受该过滤影响。
- 该过滤只影响 judge 调用，不改变主模型选择、其他角色候选、压缩、标题或 Team 成员配置；也不改写用户配置或缓存结果。

#### Scenario: 作用域外模型不参与判定

- **WHEN** 会话配置的 `enabledModels` 不包含远端的 judge 默认模型
- **THEN** 判定请求使用作用域内候选或会话自身模型，不先请求作用域外模型

### Requirement: 逐输入元数据边界

入队输入 MUST 能携带逐输入的工具禁用清单、命令自动化来源标识与附件清单，且这些字段 MUST NOT 作为 Provider 选项发送。

#### Scenario: 输入附带禁用工具与附件

- **WHEN** 一条用户输入携带工具禁用清单、`sourceCommand.automationId` 或附件清单（引用、文件名、MIME、字节数等）
- **THEN** 该元数据 MUST 随运行时队列与 journal 保留，并用于本轮工具可用性与来源记录
- **AND** 元数据 MUST NOT 作为请求参数发送给模型 Provider
- **AND** 受限会话 MUST NOT 因这些字段放宽原有工具清单或授权边界。

### Requirement: 补全层级的模型角色解析

`completion()` 的层级只有 `smol`、`default`、`slow`；候选 MUST 按对应层级的模型角色解析，且只有 `slow` 会发送思考档位。

#### Scenario: 层级候选解析

- **WHEN** 以 `smol`、`default` 或 `slow` 层级调用补全
- **THEN** `smol`、`slow` 分别按模型角色 `@smol`、`@slow` 解析候选；`default` 优先使用会话当前模型，会话无当前模型时回落到 `@default` 角色
- **AND** `slow` 使用该角色配置的具体思考档位；配置为 `auto` 或未配置时，仅在支持推理的模型上请求其最高支持档
- **AND** `smol` 与 `default` MUST NOT 发送思考档位，也 MUST NOT 因用户配置的档位改变行为
- **AND** 启用模型回退时按既有重试回退链在层级主候选之后追加，回退项继承主候选的有效思考设置，不绕过层级角色语义。

### Requirement: 自动角色别名的来源保留

按 agent 配置解析模型覆盖时，OMP MUST 保留自动角色来源，使执行期解析仍能识别该选择来自自动角色。

#### Scenario: 子代理与 vibe 的模型覆盖

- **WHEN** 子代理或 vibe 启动按 agent 或任务配置解析模型覆盖，且匹配到自动角色别名
- **THEN** 解析结果 MUST 保留该自动角色来源（不展开成具体模型 ID）
- **AND** 执行期仍能据此识别来源，并沿用角色身份解析继承的重试回退链。
