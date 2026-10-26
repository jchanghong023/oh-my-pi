# model-and-skill-discovery

## Purpose

规定用户技能与共享技能发现、Codex 压缩模型选择等 fork 默认能力。用户和项目显式配置的优先级及同名来源规则保持原有边界。

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

### Requirement: Codex 压缩默认模型

OMP MUST 默认选择规定的 Codex 低思考模型；显式配置不被替换。

#### Scenario: Codex 压缩默认模型的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 压缩候选链（主模型自身、model role 兜底、最大上下文兜底，含 advisor 上下文维护的同名解析）里凡落到 `openai-codex` provider 的候选一律替换为 `openai-codex/gpt-6-luna` 后再参与认证与 remote 资格过滤；luna 不在可用模型中（未认证/被禁用）时保留原候选，不阻断压缩回退。服务器压缩（Responses V2 流式）因此也在 luna 上执行；preserve 数据的 provider 仍是 `openai-codex`，与主模型同 provider，原生回放不受影响。
- 显式配置的 `compactionModel`（models.json `modelOverrides`）不被替换：用户显式指定优先于本默认值。
- 以 `gpt-6-luna` 为压缩模型时，压缩请求的推理档位固定为 `low`（本地摘要、handoff、短摘要与 V2 流式服务器压缩共用同一生效点 `resolveCompactionEffort`），不继承会话当前档位——包括 high/max、未设置时的 high 默认与显式 Off。
- 仅约束压缩链路：主模型选择、主模型推理档位及其他 provider 的压缩行为不变；luna 作为主模型正常使用时档位不受影响（钉制只在压缩调用生效）。

#### Scenario: Codex 压缩默认模型的可观察行为

- **WHEN** 压缩候选为可用的 openai-codex 且用户未显式选择压缩模型
- **THEN** 默认选择规定的 Codex 低思考模型；显式配置不被替换

### Requirement: 默认压缩方法顺序

OMP MUST 使用 `remote → handoff → snapcompact → shake → soft` 作为缺省压缩方法回退顺序，仅将 handoff 调整到 snapcompact 之前；压缩参数和各方法实现保持不变。

#### Scenario: 未显式配置方法顺序

- **WHEN** 未配置 `compaction.methodOrder`
- **THEN** 远程压缩仍优先；远程不可用或失败时，在 handoff 可用的情况下先尝试 handoff，再回退到 snapcompact。

#### Scenario: 显式配置优先

- **WHEN** 用户或项目显式配置 `compaction.methodOrder`
- **THEN** 沿用既有配置优先级和显式顺序，不自动重排或改写配置文件。
