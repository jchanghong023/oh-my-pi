# spec-driven-orchestration

## Purpose

维护独立 OMP 技能与 Dev 编排的边界，以及用户确认的 Dev 全流程。

> 状态：用户已确认的最新 Dev 需求基线。本次仅更新文档；现有代码和原型尚未按本规则完成实现或验收。

## Requirements

### Requirement: 包内技能发现与资源兼容

OMP MUST 复用既有发现、补全、按需读取与资源授权，不因 Dev 工作流改变独立技能行为。

#### Scenario: 技能发现与资源兼容的详细边界

- **WHEN** 会话发现、手动调用或读取包内技能与命令资源
- **THEN** 以下发现范围、资源授权及兼容约束适用：

| 范围                                               | 技能                                                                                                                                                    | 规则                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通会话及其子代理、Dev 业务需求／评审／方案及其后代仅手动调用 | 所有包内固定上游 Superpowers 技能，包括 `using-superpowers`                                                                                             | 不出现在模型自动发现索引，保留用户显式调用；Dev 获授权的计划、执行及 IR 验收会话与其适用递归子代理可自动发现并按需读取                                                                                                                                                                                                                                                                                                                                                     |
| 普通模型可发现                                     | 固定上游 OpenSpec `core` 中五项技能：`openspec-propose`、`openspec-explore`、`openspec-update-change`、`openspec-sync-specs`、`openspec-archive-change` | 以包内固定上游 `init --tools oh-my-pi --profile core` 在隔离默认配置下生成的 `SKILL.md` 为基准，生成时按 core 集合解析可选工作流分支；CLI 调用统一写为 `omp openspec ...`，同步工具声明及兼容性说明，并仅为独立需求流程适配正文和描述。同步保留原生行为，归档只检查需求完整性及原生格式，不要求实施或软件验证。任意目录提供名称与描述，正文按需读取，通过原生 `/skill:<name>` 调用；`openspec-apply-change` 及其他非所列技能不注册、不提供手动调用 |
| 普通会话仅手动调用                                 | `jch-grill-me`                                                                                                                                          | 保留原资源和显式调用，不默认发现；Dev 业务需求 Agent 必须自动注入，业务需求评审 Agent 依独立检查职责读取确认材料，固定职责及访谈停止规则置于技能正文之后                                                                                                                                                                                                                                                                                                                                                         |

包内 Superpowers 的发现范围仅适用于包内资源；同名非包内自定义技能继续遵循既有发现、调用与优先级规则，不被此例外覆盖。用户显式调用包内技能仍沿用原生调用及授权规则；Dev 阶段技能注入、资源授权和工具权限不因发现范围变化而扩大，打开 `/dev` 网页本身不授予阶段资源权限。

配套五项 `/opsx-propose`、`/opsx-explore`、`/opsx-update`、`/opsx-sync`、`/opsx-archive` MUST 在任意工作目录通过既有文件 slash-command 发现、补全及执行链路提供。五份命令文件以同一次固定上游 `init --tools oh-my-pi --profile core` 在隔离默认配置下生成的 `.omp/commands/opsx-*.md` 为基准，CLI 调用统一写为 `omp openspec ...`，正文和描述仅按独立需求流程适配；同步保留原生行为，归档只检查需求完整性及原生格式。命令使用既有参数展开、扩展禁用及同名用户／项目命令覆盖机制；不另建分发表、不自动执行 init、不向用户项目复制文件，不注册 `/opsx-apply` 或其他可选工作流命令，也不改变 `/dev` 的阶段权限或批准边界。

独立 `omp openspec init` MUST 复用固定上游初始化实现，但由 OMP 封装层固定使用 `--tools=none`：技能和命令已内置，不再交互选择工具，也不在用户项目或全局目录生成技能和命令；显式传入 `--tools` 也不得重新启用生成。目录、配置、目标路径、语言及原生错误处理保持不变，不主动删除已有技能和命令。独立 OpenSpec 默认 schema 为 `mini`；现有 change 及显式选择的 schema 不强制转换，原生 `spec-driven` 资源仍保留。`update` 及其余 CLI 能力遵循固定上游；`omp-spec` 是供 Dev 使用的独立需求 schema，Dev 业务需求阶段只生成获授权的 proposal／增量规格，技术方案阶段生成共享 design.md（含 SR 顺序与依赖），其他阶段及原有写入、用户批准和验收边界不变。

Superpowers 的技能、上游插件及扩展保留固定版本原始文件，所有包内 Superpowers `SKILL.md` 均增加 `disable-model-invocation: true`；未来同步或更新上游资源时同样保留该字段。不为 OMP 改写工具名称、子代理名称或脚本调用。依赖宿主提供的能力及实际可用性不改变上游基线。

#### Scenario: 普通会话发现

- **WHEN** 用户启动普通会话或重载技能
- **THEN** 所有包内 Superpowers 技能均不出现在普通会话及其子代理的模型自动发现索引，但保留用户显式调用；Dev 业务需求、业务需求评审、方案代理及其后代同样不可自动发现；计划、执行及 IR 验收依其阶段权限使用 Superpowers 方法，原生宿主与 Dev 阶段授权边界仍适用

#### Scenario: 执行阶段递归发现

- **WHEN** Dev 获授权的计划、执行、IR 验收代理或其适用子代理发现或按技能引用读取包内 Superpowers 资源
- **THEN** 可自动发现全部包内 Superpowers 技能并按需读取，恢复执行会话及递归子代理同样适用；不改变阶段自动注入内容、工具权限或获批范围
- **AND** 同名非包内自定义技能仍按既有优先级生效，不因 Dev 阶段的包内可见性改变

#### Scenario: 初始化不重复安装内置资源

- **WHEN** 用户运行 `omp openspec init [path]`，包括已检测到工具、显式指定工具或重复初始化
- **THEN** 仅执行原生项目初始化，建立必要的 `openspec/` 目录及配置，不生成技能和命令；保留已有自定义命令及配置，仍支持 `--language` 和 `--` 后的目标路径


### Requirement: Dev 需求 schema 固定为包内 omp-spec

OMP MUST 把 `omp-spec` 的唯一来源固定为随包内置 schema；项目或用户同名覆盖 MUST 被拒绝，不得静默改用另一套 Dev 工作流。

#### Scenario: 解析来源必须是包内 schema

- **WHEN** Dev 初始化新流程、需求阶段读取 OpenSpec 指令，或需求校验与归档前确认 schema
- **THEN** schema 解析结果 MUST 声明来源为包内，且其实际路径按真实路径比较等于随包内置的 `omp-spec` 目录，两者同时满足才可继续
- **AND** 不得接受工作区或用户目录中的同名 schema，也不得为通过检查而复制、改写或移动内置 schema

#### Scenario: 外部覆盖阻断流程

- **WHEN** `omp-spec` 被项目级或用户级 schema 覆盖，或解析结果来源不是包内
- **THEN** MUST 拒绝并阻断初始化、需求校验与归档，报错说明外部 schema 遮蔽了内置 schema，且须在不修改已有 change 的前提下解决冲突
- **AND** 不创建 change、不迁移或转换已有 change、不回退为其他 schema，也不报告成功


### Requirement: 包内 Superpowers 脚本执行入口

OMP MUST 通过 `omp superpowers <relative-script> [args...]` 提供包内技能脚本入口，只运行随包交付的脚本，不执行工作区任意脚本。

#### Scenario: 只运行包内清单内脚本

- **WHEN** 用户运行 `omp superpowers <relative-script> [args...]`
- **THEN** 只接受随包脚本清单中存在且位于 `skills/` 下的相对路径；其他路径 MUST 报“不是包内技能脚本”并拒绝执行
- **AND** 脚本参数原样透传，不解释为 Dev 命令或阶段操作

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

普通 OMP 沿用既有 Markdown 文档时 MUST 明确资料来源；Dev MUST 只使用 OpenSpec 提案及已合入的规格作为本流程需求权威，不再自动从旧 requirements 目录建立另一套 Dev 需求基线。

#### Scenario: Dev 使用 OpenSpec
- **WHEN** Dev 新建提案或开始开发
- **THEN** 提案先在固定临时目录生成 openspec/changes/<change-id>/proposal.md、specs/<capability>/spec.md 与 design.md；开发读取已合入且确认版本，旧 docs-zh-CN/requirements、docs/requirements 或 requirements 可只读参考，不是并列权威、不要求存在

#### Scenario: 普通 OMP 资料探测
- **WHEN** 普通 OMP 独立文档流程沿用旧 Markdown 目录探测
- **THEN** 保留原候选目录、歧义报错、真实读取失败和递归文件版本校验，不自动迁移或改写原文；此能力不驱动 Dev 业务状态

### Requirement: Dev 阶段会话的强制运行默认值

OMP MUST 在所有 Dev 阶段会话上强制一组运行默认值，且只作用于该会话，不写回用户或项目配置。

#### Scenario: 编辑模式强制整文件替换

- **WHEN** Dev 建立任一阶段 Agent 会话，包括新建与恢复
- **THEN** `edit.mode` MUST 被覆盖为 `replace`（整文件替换），显式压过用户设置及按模型变体回退
- **AND** 该覆盖不改写持久配置，普通会话仍按原设置解析

#### Scenario: 文档与评审阶段关闭投机启动

- **WHEN** 业务需求、业务需求评审、方案或计划阶段会话执行其获授权的工具调用或派发任务
- **THEN** 工具与任务的投机启动 MUST 关闭，即使配置为开启
- **AND** 执行及 IR 验收实施会话沿用配置值；该关闭不改变阶段工具权限或阶段门禁


### Requirement: 执行会话保留原生能力和技能存续授权

Dev 执行 Agent 及其实施后代 MUST 保有适用的完整原生会话能力和包内 Superpowers，受原有获批范围、用户验收及生命周期守卫约束；需求、方案、计划阶段既有权限不变。

#### Scenario: 执行代理和递归实施后代使用原生工具

- **WHEN** 执行 Agent、IR 验收的修复会话或默认实施子代理及其递归实施后代在获批范围内工作
- **THEN** MUST 按普通原生会话的配置、可用性及适用权限提供原生工具和已配置能力，包括可用的 `knowledge_search`、`web_search`、`eval`、LSP、MCP、扩展及自定义工具，不以固定精简名单裁掉能力；`wait` 等待真实原生子任务结果，阶段切换须结清递归任务
- **AND** 能力可用不等于绕过用户批准、项目规则、报告后只读、收尾或停止边界；原生明确受限的其他代理仍遵守其自身限制，普通会话及非实施阶段不因本条扩大权限

#### Scenario: 存活子代理续聊读取技能

- **WHEN** 执行子代理首次任务结束后原生会话仍保活、空闲或经原生恢复，用户或获准工作继续该会话并按引用读取包内 Superpowers
- **THEN** 该会话及其递归执行后代仍可自动发现和按需读取全部包内 Superpowers；授权持续到相应原生会话释放，不因首次任务返回而提前撤销
- **AND** 不修改上游技能正文，不扩大未经授权阶段的技能发现或工具权限


### Requirement: 内置执行代理具备必要原生能力

OMP MUST 为内置 `spec-executor` 提供完成已批准执行阶段委派、验证、独立审查及等待所需的适用原生能力，同时保留阶段权限与获批范围限制。

#### Scenario: 委派实施和独立审查
- **WHEN** `spec-executor` 被用于实施获批计划且未达到原生派生限制
- **THEN** 其可用工具 MUST 包含原生 `task`，使其能够派发实施子代理和独立 `reviewer`；适用异步工作 MUST 可使用原生 `wait` 等待真实结果。
- **AND** 验证能力 MUST 能执行获授权的计划内验证；缺少权限或其他必需能力时 MUST 报告阻塞，不能伪报实施、验证或审查完成。
- **AND** 需求、方案、计划阶段的只读权限与其他显式受限代理的边界保持不变。

### Requirement: 新 Dev 模块与普通 OMP 的隔离

Dev MUST 复用 OMP 原生会话、工具和生命周期，并保持普通 OMP、原 WebGUI、独立 OpenSpec／Superpowers 能力的既有行为。新业务只在 Dev 模块承载，不建立第二执行器、第二聊天库或跨旧流程兼容路径。

#### Scenario: 功能未启用和普通能力
- **WHEN** 使用普通 OMP／WebGUI 或独立技能
- **THEN** 不启动 Dev 业务、不注入 Dev 状态或冻结规则；已授权的新 Dev 需求不改变原 WebGUI 源码、入口、协议、构建和资源

#### Scenario: 进入退出和资源归属
- **WHEN** 显式进入或退出 Dev
- **THEN** 沿用原生准入、TUI 独占和自有任务结清；关闭网页不退出服务，退出不撤销需求、代码或 Git；不关闭其他实例的任务

### Requirement: 原生 Agent 与 Superpowers 职责

Dev MUST 使用业务需求、业务需求评审、方案、计划、执行和 IR 验收职责；SR 计划、开发、测试及代码审查 MUST 复用 Superpowers 方法和原生能力。OMP MUST 唯一管理会话、工具、任务、状态和递归子工作，不把 Superpowers 变成第二执行管理系统。

#### Scenario: 阶段职责和原生子代理
- **WHEN** 需求、方案或 SR 开发工作开始
- **THEN** 需求评审审业务产物，方案阶段解决技术设计和依赖；SR 从计划开始，技术测试／代码审查复用适用原生子代理，执行阶段不启动方案 Agent

#### Scenario: IR 验收与修复后复验
- **WHEN** 全部 SR 已合并
- **THEN** IR 验收 Agent 使用最新默认分支整体验收；实现问题可在获准范围内修复，修复后重跑受影响验证及 IR 整体验收，不以自身“已修复”代替验证或人工合并

### Requirement: 完整输入和确认版本交接

Agent MUST 使用所属 IR 的完整冻结需求、已确认方案、必要上下文和实际代码版本，不用摘要或不同轮次材料替代。阶段批准、需求评审和人工决定 MUST 绑定具体文件集合及版本。

#### Scenario: 依赖就绪和启动基点
- **WHEN** 启动一个 SR
- **THEN** 读取 design.md 声明的实施顺序和依赖，核对前置 SR 在默认分支的实际合并结果，获取最新默认分支并记录具体基点提交，之后不随浏览或轮次隐式改变该基点

#### Scenario: 材料与候选变化
- **WHEN** 需求、阶段材料、文件集合或最终验收候选发生变化
- **THEN** 旧确认不得用于新内容；未执行、失败和环境限制如实呈现，重复或过期请求在修改状态前拒绝

### Requirement: 冻结需求与已实现规格分开保护

首个 SR 开始后 MUST 在工具和集合层保护该 IR 的 proposal、全部增量 spec 及 design，不只依赖 UI 或提示词。按已确认增量更新正式规格和修复实现 MUST 不被误判为改写冻结需求。

#### Scenario: 开发和规格交付
- **WHEN** Agent 实施并准备 SR 代码 PR
- **THEN** 代码、测试及对应 openspec/specs/<capability>/spec.md 更新在同一 PR，保留来源 Change／SR 和版本映射；不为“同步规格”改写冻结 changes 文件或扩大业务范围

#### Scenario: 业务或方案变化
- **WHEN** 原需求或已确认方案不再适用
- **THEN** 暂停并重新提案；需求争议和 Git 合并冲突交人处理，普通实现问题由 Agent 修复并重新验证

### Requirement: 仓库、IR、SR、worktree 与会话绑定

一个仓库 MUST 只允许一个开发中 IR；IR 内依赖就绪的不同 SR 默认最多并行 2 个，每个 SR 具有独立分支、worktree、Git index、会话及固定开发人。仓库身份 MUST 跨工号、clone 和目录别名统一，不能按 checkout 另发名额。

#### Scenario: 原子准入和名额
- **WHEN** 多个页面或同事同时启动 SR
- **THEN** 在共享状态中原子核对仓库当前 IR、SR 依赖、合并事实和并行上限，再保留名额并创建工作区；同一 SR 不能重复接手或创建 worktree
- **AND** 准备中、开发中及等待评审／合并的 SR 均占名额；不同仓库和提案讨论独立并行

#### Scenario: 工作区固定和只读查看
- **WHEN** 切换项目、Release、查看工号或修改个人开发目录
- **THEN** 已开始 SR 继续原 worktree 与会话；历史和他人工作只读查看，迟到事件更新原对象，缺失目录／会话记录明确阻塞，不选择其他样例替代

### Requirement: 真实工作结清与可恢复操作

操作 MUST 防重并校验阶段、开发人、轮次、材料和版本，分别保存文件、Git、人员决定和任务的真实结果。返回、停止、验收或退出前 MUST 结清目标主 Agent、递归子任务、工具、队列及适用 Goal，不影响其他并行 SR。

#### Scenario: 失败与重试
- **WHEN** 状态写入、commit 或 push 部分失败
- **THEN** 保留已成功步骤、提交和未发送输入，明确剩余工作，重试不重复提交或推进；不能以失败状态掩盖已接受工作，不强制覆盖或自动回滚其他 SR

#### Scenario: 浏览器与服务恢复
- **WHEN** 页面刷新、关闭、断线，或服务重启后恢复记录
- **THEN** 页面不拥有任务生命周期，不释放仓库／SR 占用；恢复只读持久事实并核对仍存活工作，不自动重放输入、合并通知或验收

### Requirement: 唯一共享数据库和部署交接

Dev MUST 在账号 A 长期服务中统一访问 /tmpdata/DFT_LAB/omp/omp_dev_sqlite.db，全部项目共用；浏览器不直接打开数据库，不按工号、项目或 clone 另造状态权威。配置、仓库和 worktree 可在现有共享存储上，不能凭共享路径假定进程自动迁移。

#### Scenario: 数据与时间
- **WHEN** 保存仓库 IR 占用、SR 依赖／名额、合并证据、验收或操作记录
- **THEN** 写同一共享数据库并事务化校验，关联项目、IR、SR 和版本；记录服务账号与操作人工号，服务端生成 UTC 时间，页面按北京时间显示

#### Scenario: 换机和持久占用
- **WHEN** 服务需要顺序换机或原宿主状态未知
- **THEN** 先结清并退出旧宿主，再读取原记录并核对任务；不按网页离线、PID 超时或新机器可见文件自动抢占，不新增跨宿主分布式执行器；共享存储和 SQLite 的实际部署兼容性由后续实现验证

### Requirement: IR 验收、最终 PR 与仓库释放

SR 合并 MUST 只结束该 SR 并释放其 SR 名额；IR 仓库占用 MUST 持续到全部 SR 合并、IR 整体验收及最终修复／归档 PR 合并核对后。最终归档 MUST 只移动 Change，不再次同步正式规格。

#### Scenario: 最终候选和默认分支变化
- **WHEN** IR 验收修复或最终 PR 准备提交
- **THEN** 基于最新默认分支记录验收基点，对包含全部修复的最终候选提交重跑受影响验证和整体验收；默认分支在合并前变化时重新核对影响并补充必要验证

#### Scenario: 人工最终合并后完成
- **WHEN** 人工合并最终 PR 并告知平台
- **THEN** 核对修复、已实现规格完整性、Change 移动及目标提交，才标记 IR 完成并释放仓库；无修复时允许归档单独成 PR，不自动删除 worktree、分支或历史
