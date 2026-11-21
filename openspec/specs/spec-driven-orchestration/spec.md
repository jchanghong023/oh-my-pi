# spec-driven-orchestration

## Purpose

维护 OMP 内置 OpenSpec、Superpowers 与 JCH 技能，以及原生实施与验证能力的行为边界。

## Requirements

### Requirement: 包内技能发现与资源兼容

OMP MUST 复用既有技能发现、补全、按需读取与资源授权。

#### Scenario: 技能发现与资源兼容的详细边界

- **WHEN** 会话发现、手动调用或读取包内技能与命令资源
- **THEN** 以下发现范围、资源授权及兼容约束适用：

| 范围                                               | 技能                                                                                                                                                    | 规则                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通会话及其子代理仅手动调用 | 所有包内固定上游 Superpowers 技能，包括 `using-superpowers` | 不出现在模型自动发现索引，保留用户显式调用 |
| 普通会话及其子代理可通过原生机制发现与调用 | 随 OMP 内置的 OpenSpec 2.0 Skill | 任意工作目录均 MUST 通过既有发现与补全提供技能名称及描述，正文按需读取，通过原生 `/skill:<name>` 显式调用并沿用资源授权和同名用户／项目资源覆盖机制，无须先安装 Skill。实际 CLI 调用统一为 `omp openspec ...`，工具声明及兼容性说明使用同一入口；仅适配宿主交付、发现与执行入口，不将正文改写为需求专用工作流，不限制为旧五项或排除 apply，不改变上游通用工作流、artifact 依赖、校验、同步及归档语义 |
| 普通会话仅手动调用 | `jch-grill-me` | 保留原资源和显式调用，不默认发现 |
| 普通会话仅手动调用 | `jch-grill-todo` | 独立的 OMP 本地技能，复用 JCH 包内资源与原生 `/skill:jch-grill-todo` 链路；访谈确认一致后另询生成许可，在当前工作目录生成符合格式的自包含 `.todo.md` Markdown 任务清单，不依赖执行器知识，不自动执行，不改变 `jch-grill-me` |
| 普通会话及其子代理可通过原生机制发现与调用 | `jch-codebase-design` | 复用 JCH 包内资源与原生 `/skill:jch-codebase-design`、`skill://` 链路；仅适配技能名称，正文、描述及 Agent 元数据与上游一致，保留完整配套材料，不添加手动调用限制，不扩大当前任务权限 |

普通会话及其子代理 MUST 通过原生机制提供全部 12 项内置 OpenSpec Skill：`openspec-apply-change`、`openspec-archive-change`、`openspec-bulk-archive-change`、`openspec-continue-change`、`openspec-explore`、`openspec-ff-change`、`openspec-new-change`、`openspec-onboard`、`openspec-propose`、`openspec-sync-specs`、`openspec-update-change`、`openspec-verify-change`。模型自动发现索引默认仅展示 core 六项：`openspec-propose`、`openspec-explore`、`openspec-apply-change`、`openspec-update-change`、`openspec-sync-specs`、`openspec-archive-change`；其余六项 MUST 通过包内资源的 `disable-model-invocation: true` 仅保留手动调用，沿用现有显式调用及资源读取授权，不新增 profile 过滤或配置。全部技能均保留原生补全、按需读取、路径授权及 `/skill:<name>` 调用，用户／项目同名覆盖优先级不变，MUST NOT 删除非 core 技能或恢复旧五项白名单。可发现或可读取不等于获准执行，模型实际使用仍 MUST 遵循原生调用授权与当前工具权限。

包内 Superpowers 的发现范围仅适用于包内资源；同名非包内自定义技能继续遵循既有发现、调用与优先级规则，不被此例外覆盖。用户显式调用包内技能仍沿用原生调用及授权规则。

普通 OpenSpec MUST 复用上述原生 Skill 入口，不再交付或注册包内 `commands/opsx-*` 文件命令，不保留 `/opsx-*` 别名，不另建命令分发表。任意目录可发现技能不等于获准自动初始化项目；项目尚未初始化时，Agent 自选技能 MUST 退出该工作流并正常答复，用户显式请求 OpenSpec 时 MUST 等待用户显式授权运行 `omp openspec init`，不得因发现或读取 Skill 自动创建 `openspec/` 目录。

独立 `omp openspec init [path]` MUST 仅负责项目初始化与配置，不向项目或用户目录安装、复制、链接、更新或清理 Skill／旧命令，也不迁移或删除用户已有 Skill、命令及其他 Agent 目录。该边界 MUST 由初始化实现本身保证，不依赖宿主强制追加 `--tools=none`；仅服务交付的工具探测、工具选择及参数不再属于初始化合同。项目路径校验、必要目录结构、配置与语言上下文、目标路径解析、重复初始化及已有配置保护与原生错误语义 MUST 保留。新项目默认 schema MUST 为上游 `spec-driven`，MUST NOT 注入 mini；已有配置及 change 不自动覆盖、转换或迁移，显式 schema 选择仍遵循原生规则。内置 Skill 不以初始化为安装前提，随 OMP 版本交付。

普通 `omp openspec ...` 入口 MUST 使用上游通用 `spec-driven` 工作流及其原生产物依赖和校验语义，显式选择 schema 时仍遵循原生解析规则。MUST NOT 注入私有 schema／context、使用需求专用目录桥接或删减通用工作流要求的 design／tasks 等产物。现有用户配置及 change 不因默认 schema 变化而自动转换或迁移。

内置 OpenSpec 的 Skill 与运行资源 MUST 随 OMP 发行版本更新，不通过 `omp openspec update` 安装、刷新或迁移。经职责核对，撤销 Skill／命令交付、profile 同步、旧产物迁移及独立安装升级链后，update 没有必须保留的独立项目职责，因此 MUST 移除该 CLI 入口及专属实现；同步清除公开导出、补全、帮助、配置侧自动应用调用和更新提示中的旧入口，不保留兼容别名、无操作成功或“已是最新”响应。调用 `omp openspec update` MUST 按正常未知命令返回非零退出码，不修改用户已有 Skill、命令、配置或 change；不得为替代它新增运行时自动下载或自升级机制。共享配置、模板及安全工具仅在确无剩余消费者时删除，不因本条改变其他通用 CLI 业务语义。`openspec-update-change` 是维护需求材料的业务 Skill，MUST 保留，不属于被移除的安装更新命令。

Superpowers MUST 仅交付 OMP 原生技能发现与脚本执行需要的固定版本资源：完整 `skills/`、`LICENSE` 和用于 ESM 语义及版本读取的根 `package.json`。NEVER 交付其他宿主专属插件、扩展、bootstrap hooks、安装入口及其品牌图片；后续上游同步同样遵循此边界，不整仓复制。所交付技能正文、引用材料和运行脚本保留上游原始内容，所有包内 Superpowers `SKILL.md` 均增加并持续保留 `disable-model-invocation: true`；根 `package.json` 删除指向未交付宿主资源的 `main`、`pi` 注册及专属包关键字。不为 OMP 改写工具名称、子代理名称或脚本调用，依赖宿主提供的能力及实际可用性不改变上游基线。

#### Scenario: 普通会话发现

- **WHEN** 用户启动普通会话或重载技能
- **THEN** 所有包内 Superpowers 技能均不出现在普通会话及其子代理的模型自动发现索引，但保留用户显式调用并遵循原生宿主授权
- **AND** 同名非包内自定义技能仍按既有发现、调用和优先级规则生效

#### Scenario: 初始化不重复安装内置资源

- **WHEN** 用户运行 `omp openspec init [path]`，包括非 TTY、已检测到工具或重复初始化
- **THEN** 仅建立原生初始化所需的 `openspec/` 目录及配置，新项目默认使用 `spec-driven`，不因检测到工具而选择或交付 Skill／命令，不触碰已有 Skill、自定义命令或其他 Agent 目录
- **AND** 保留 `--language`、`--` 后目标路径、已有配置保护及重复初始化语义；旧 Store 配置遵循[不支持的项目字段规则](#scenario-不支持的项目字段无例外)。
- **AND** 非 TTY 不要求选择交付工具；必要业务输入沿用现有配置／显式参数或返回明确错误，不擅自选择语言、覆盖配置或改变原生错误语义

### Requirement: 内置 OpenSpec 中文产物上下文

OMP MUST 在 OpenSpec 的统一产物指令出口提供内置中文语言约束，适用于所有新旧项目及内置、自定义 schema，无须修改项目配置。生成文档的正文 MUST 使用简体中文；项目上下文中的其他语言要求不得覆盖此内置规则。MUST 保留 OpenSpec 必需的英文结构标题、SHALL/MUST 关键字、文件名、路径及代码标识符。

内置语言约束 MUST 与项目原有有效上下文合并，不覆盖项目的其他约束，不写回配置或改写已有文档。MUST NOT 为此改写 12 项 Skill、原始 docs 目录、初始化默认值或 apply／archive 操作上下文。

#### Scenario: 无语言配置的新旧项目创建文档

- **WHEN** 用户在未配置语言的新项目或已有项目获取任意产物生成指令
- **THEN** 指令上下文包含内置中文语言约束，适用于 proposal、specs、design、tasks 及自定义 schema 的产物，不要求重做初始化或修改项目配置

#### Scenario: 项目上下文及原生格式保留

- **WHEN** 项目已有有效 context、artifact rules 或自定义 schema
- **THEN** 产物上下文保留原项目约束并加入内置中文语言要求，原有规则、模板、路径和依赖不变；项目配置文件及已有产物不被改写


### Requirement: 普通 OpenSpec 仅使用本地项目根

普通 OpenSpec MUST 仅使用最近的本地项目根，不从外部 Store 继承或回退。已移除的 Store 入口不得修改或迁移用户数据。

#### Scenario: 最近本地项目根隔离

- **WHEN** 从项目根或其多级子目录运行普通 OpenSpec 命令
- **THEN** 选择从当前目录向上最近的含 `openspec/` 的目录（包括当前目录），而非 `openspec/` 本身；嵌套项目不串入相邻项目。
- **AND** `planningHome`、`changeRoot`、`artifactPaths`、`actionContext` 等有效路径与编辑范围 MUST 基于实际本地项目，不能硬编码为启动目录。
- **AND** 不读取项目 Store 指针、注册表、Store 元数据或全局 `defaultStore` 路由，不以 Git origin 推测或回退到外部 Store。

#### Scenario: 找不到本地项目根

- **WHEN** 运行普通 OpenSpec 命令，且从当前目录向上找不到任何含 `openspec/` 的目录
- **THEN** 查询命令按原规则失败，不创建 `openspec/` 或其他项目材料，也不回退到外部 Store。
- **AND** 允许将当前目录作为隐式根的显式写命令仍遵循各自的授权和目标路径规则，不扩大 Skill 初始化授权。

#### Scenario: 已移除的 Store 入口不写文件

- **WHEN** 调用 `omp openspec store`，或向命令传入 `--store`／`--store-path`
- **THEN** 按正常未知命令／参数非零退出，不写文件、不提示选择 Store、不忽略参数后继续、不保留兼容别名，也不报告无操作成功；JSON 调用不将人类提示混入结构化 stdout。
- **AND** 不删除、改写、清理或自动迁移用户已有 Store 仓库、注册表、元数据、全局配置、项目材料、自定义 Skill 或缓存。

#### Scenario: 不支持的项目字段无例外

- **WHEN** OpenSpec 命令（包括 `init`）读取到含 `store` 或 Store `references` 字段的项目配置，无论字段值是否为空、是否已有本地 `openspec/`
- **THEN** MUST 明确报不支持且不写文件，不忽略后继续，不解析旧值或指针、不读取外部 Store 或旧系统状态、不覆盖、迁移或清理用户数据。

#### Scenario: 保留独立的本机目录与诊断能力

- **WHEN** 用户使用 Workset、`context` 或 `doctor`
- **THEN** Workset 继续提供 create／list／show／remove／open、普通目录成员、排序、保存视图和打开工具，不改变成员目录。`context`、`doctor` 保留本地项目、配置与规划目录职责，不提供 Store 健康检查、跨 Store 引用或远程拉取指引。
- **AND** 不改变普通 OMP、Superpowers 或 JCH 的能力及权限边界。

### Requirement: 包内 Superpowers 脚本执行入口

OMP MUST 通过 `omp superpowers <relative-script> [args...]` 提供包内技能脚本入口，只运行随包交付的脚本，不执行工作区任意脚本。

#### Scenario: 只运行包内清单内脚本

- **WHEN** 用户运行 `omp superpowers <relative-script> [args...]`
- **THEN** 只接受随包脚本清单中存在且位于 `skills/` 下的相对路径；其他路径 MUST 报“不是包内技能脚本”并拒绝执行
- **AND** 脚本参数原样透传

#### Scenario: 运行环境与外部工具

- **WHEN** 运行包内 JavaScript 或 shell 脚本
- **THEN** JavaScript MUST 由 OMP 内嵌的 Bun 执行，不依赖外部 Node；shell 脚本 MUST 要求 Bash 与 POSIX 工具，Unix 使用可用的 `bash`，Windows 使用 Git for Windows 的 Bash，WSL 的 `bash` 不适用；缺少 Bash MUST 报固定错误并失败
- **AND** MUST 在 PATH 前置包内运行时目录（Windows 另加所用 Bash 及其 POSIX 工具目录），并设置 `BRAINSTORM_DIR` 指向工作区下的 `.superpowers/brainstorm`
- **AND** Graphviz 等外部工具由脚本自行解析，其真实退出状态随脚本透传，不预先替换或伪造

#### Scenario: 缺参与帮助的退出码

- **WHEN** 未提供脚本参数，或提供 `-h`／`--help`
- **THEN** 缺参 MUST 把用法写入 stderr 并以退出码 2 结束；`-h`／`--help` MUST 把用法写入 stdout 并以退出码 0 结束
- **AND** 脚本的 stdout、stderr 与退出码 MUST 原样透传；入口自身异常（例如 Bash 缺失或脚本不存在）MUST 写入 stderr 并以退出码 1 结束

#### Scenario: 中断转为脚本中止

- **WHEN** 脚本执行期间收到 SIGINT 或 SIGTERM
- **THEN** MUST 转为中止信号并等待脚本结束，再按实际结果退出；不得遗留子进程，也不得把中断报成成功


### Requirement: Markdown 需求权威探测

普通 OMP 沿用既有 Markdown 文档时 MUST 明确资料来源。

#### Scenario: 普通 OMP 资料探测
- **WHEN** 普通 OMP 独立文档流程沿用旧 Markdown 目录探测
- **THEN** 保留原候选目录、歧义报错、真实读取失败和递归文件版本校验，不自动迁移或改写原文

### Requirement: 普通 OMP 原生实施能力保持独立

普通 OMP 的实施、验证、审查、原生子代理和包内资源授权 MUST 保持既有行为。

#### Scenario: 原生入口实施需求
- **WHEN** 开发者在普通 OMP 或 TUI 中实施需求
- **THEN** 沿用各入口的原生权限、技能、任务及验证规则

#### Scenario: 原生实施会话能力和技能授权存续
- **WHEN** 已获授权的原生实施会话或其递归实施后代工作、保活续聊或恢复
- **THEN** 沿用原生配置、可用性和权限提供工具及已配置能力，包括可用的 `web_search`、`eval`、LSP、MCP、扩展和自定义工具，不以固定精简名单裁剪；`wait` 等待真实子任务，结束前结清自有递归工作
- **AND** 原生明确授予的技能读取授权持续到会话释放，不因首次任务返回而提前撤销；不得绕过用户批准、项目规则、报告后只读或停止边界

### Requirement: 内置执行代理具备必要原生能力

内置 `spec-executor` MUST 保留实施已批准计划、计划内验证、独立审查及等待所需的原生能力，遵守自身原生权限与获批范围。

#### Scenario: 原生委派实施和独立审查
- **WHEN** 普通 OMP 使用 `spec-executor` 实施获批计划且未达到原生派生限制
- **THEN** 其工具 MUST 包含原生 task，可委派实施子代理与独立 reviewer，适用异步工作可使用原生 wait 等待真实结果；验证仅执行获授权的计划内验证
- **AND** 缺少权限或必需能力时报告阻塞，不伪报实施、验证或审查完成；其他只读或显式受限代理保持自身边界
