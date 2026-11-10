# dev-requirement-intake

## Purpose

维护最新 Dev 业务流程、职责和边界。

> 状态：用户已确认的最新 Dev 需求基线。本次仅更新文档；现有代码和原型尚未按本规则完成实现或验收。

## Requirements

### Requirement: Release、IR、SR 的职责与稳定关系

系统 MUST 按项目／仓库、Release、IR、SR 组织需求。一个项目 MUST 对应一个仓库，一个 IR MUST 对应一个 OpenSpec Change；IR 包含一个或多个 SR，每个 SR 对应该 Change 的一个能力 spec.md，共用一个 design.md。稳定 ID、change-id 和能力路径 MUST 不随显示标题或查看人改变。

#### Scenario: 标准 OpenSpec 文件映射
- **WHEN** 创建和拆分提案
- **THEN** 使用 openspec/changes/<change-id>/proposal.md 表达 IR，specs/<capability>/spec.md 表达每个 SR，design.md 表达整份技术方案、架构、模块、文件、函数职责及 SR 顺序／依赖
- **AND** 一个能力规格可以包含多条 Requirement／Scenario；不为每条 Requirement 再造 SR，不另发明 IR.md、SR.md 或方案 JSON 正式格式；同名 Change 冲突交人处理，不覆盖

#### Scenario: Release 和仓库身份
- **WHEN** 添加项目、Release 或个人开发 clone
- **THEN** Release 只组织交付范围，不代替分支；同仓库的不同 clone／worktree 关联同一项目身份，不用目录别名或重复登记绕过仓库级占用

### Requirement: 共享 Web 的统一提案入口

账号 A MUST 在机器 A 以自己的账号长期运行 OMP Web 并使用 A 的模型 Token；约 200 位同事通过浏览器输入工号进入，无需密码，仅检查工号格式。提案全员可见，Dev 业务元数据 MUST 全 Web 共享。

#### Scenario: 工号与凭据分开
- **WHEN** 同事 B 输入 j 开头、后接 8 位数字的工号进入
- **THEN** 记录操作人工号；模型及服务凭据仍属于 A，不把工号格式检查视为本人验证，不要求 B 自行运行 OMP 或提供 Token

#### Scenario: 临时工作区与唯一数据库
- **WHEN** 业务需求、需求评审或方案 Agent 整理文件
- **THEN** 先在 /tmpdata/DFT_LAB/omp/{project_name}/{原提交人工号}/{提案id}/ 内生成 openspec/changes/<change-id>/，项目代码和已实现规格仅作只读参考；不默认在项目目录生成或初始化
- **AND** 全部项目共用 /tmpdata/DFT_LAB/omp/omp_dev_sqlite.db；路径、项目／Release、提案状态、评审、版本和操作记录在同一服务下共享，查看人变化不改原提交人目录，不导出／导入需求包建立副本

### Requirement: 需求讨论必须审查实质内容

业务需求 Agent MUST 澄清目标、范围、规则、异常和验收行为，整理 IR 与完整 SR；业务需求评审 Agent MUST 检查这些产物，指出具体问题和依据。不通过 MUST 返回补充，不能用格式齐全或 Agent 自称通过代替内容评审和人工决定。

#### Scenario: 需求评审反馈与重评
- **WHEN** 评审发现遗漏、冲突、重复或不可验证要求
- **THEN** 给出引用到 proposal／能力 spec 的问题和依据，业务需求 Agent 补充后对当前版本重新评审；旧版本意见不能作为新版本已通过证据
- **AND** 反复不通过、意见冲突或范围争议交人裁决，不无限循环；人工裁决及依据单独记录，不伪造 Agent 通过结果

#### Scenario: 会话和职责
- **WHEN** 在同一提案中选择 IR 或任意 SR
- **THEN** 共用当前提案阶段的业务需求或方案会话；需求评审专门审业务产物，不替代方案／代码审查；原生聊天由 OMP 管理，不按 SR 复制需求讨论正文

### Requirement: 提案状态与讨论阶段分离

需求讨论和技术方案 MUST 是提案的两个阶段，与草稿、方案完成、PR 待合并、正式提案等状态分开。提交需求评审 MUST 不要求已有方案；通过需求评审及必要人工裁决后，才形成可进入方案阶段的需求版本，不新增“待评审”业务状态。提交人和接手开发人 MUST 分开记录。

#### Scenario: 开发人员接手方案
- **WHEN** 开发人员明确接手已提交的提案
- **THEN** 记录接手工号、时间和轮次，与提交人记录分开；接手不等于需求评审通过，不自动生成方案或提交 PR

#### Scenario: 技术方案与实施依赖
- **WHEN** 需求版本已满足进入方案的条件
- **THEN** 方案 Agent 生成同一 Change 的 design.md，解决纯技术问题，明确 SR 顺序、前置依赖、可并行范围、技术取舍和验证安排
- **AND** 需要业务细节时交回业务需求 Agent，保留反馈并使旧方案失效；补充和重评后重新确认方案。执行阶段不再设置方案 Agent

### Requirement: 共享材料直接查看

系统 MUST 展示同一共享提案的 proposal.md、全部能力 spec.md、design.md、资料及评审记录，原生聊天正文仍由 OMP 管理。查看、复制或下载单份材料 MUST 不产生批准、执行或状态推进。

#### Scenario: 原格式与查看范围
- **WHEN** 选择 IR、SR 或方案
- **THEN** 分别默认查看 proposal.md、对应能力 spec.md 或 design.md，区分临时来源、仓库相对路径、版本和历史；没有材料如实显示，不用样例或其他需求替代

### Requirement: 方案完成后提交 PR，合并核对后转正

人工 MUST 确认需求和方案的当前版本；AI 随后将临时工作区的确认文件带入项目可写的提案分支，执行提交和推送并提供 PR 标题、正文。人工 MUST 创建、评审和合并 PR，再告知平台；平台核对默认分支实际文件及版本后才成为正式提案，不自动创建或合并 PR。

#### Scenario: 准备需求 PR
- **WHEN** 当前需求、方案及人工确认齐备
- **THEN** 提交同一 Change 的 proposal.md、全部能力 spec.md、design.md 及必要资料，不直接推默认分支，不把共享只读项目当个人开发目录；缺失、过期、仓库不符或同名冲突时阻塞

#### Scenario: 提交、合并通知与核对
- **WHEN** AI 已推送分支或人工告知 PR 已合并
- **THEN** 推送与 PR 创建／合并分别记录；人工通知后获取实际默认分支并核对目标提交和完整文件版本，兼容 merge／squash／rebase；只登记地址或勾选不能转正
- **AND** 需求 PR 合并只完成提案入库，不表示实现完成、不占用 SR 并行名额、不归档 Change，不把尚未实现的增量提升为已实现规格

### Requirement: 开发开始冻结整组需求与方案

首个 SR 实际开始开发时，系统 MUST 固定该 IR 的已确认 proposal、全部 SR 增量规格及 design 版本并冻结正文和成员关系；冻结适用于全部 Agent、子代理和写入工具。冻结后需求或已确认方案变化 MUST 暂停并重新提案，不在执行阶段重新启动方案 Agent 或解冻原 IR。

#### Scenario: 冻结时点与已确认版本
- **WHEN** 正式提案准备启动首个 SR
- **THEN** 核对已入库的确认版本并记录冻结快照，再进入 SR 开发；首个 SR 启动前的修订也须重新评审、人工确认并通过需求 PR，不能静默改已确认内容

#### Scenario: 冻结增量与正式规格同步分开
- **WHEN** SR 实现、测试和规格随代码 PR 交付
- **THEN** 冻结的 changes/<change-id>/proposal.md、specs 和 design 不被改写；允许按已确认增量更新 openspec/specs/<capability>/spec.md，记录来源 Change／SR
- **AND** 更新已实现规格不能扩张或改写冻结需求；需求冲突暂停交人决定，普通实现问题由 Agent 修复

### Requirement: 共享记录和个人开发目录的边界

共享项目路径 MUST 只读；开发人员按工号和项目登记服务端可访问的 Git 开发仓库，校验仓库对应关系和可写性。SR 的分支、worktree、基点和会话 MUST 在开始时固定，后续查看或修改个人目录不重绑已有工作。

#### Scenario: 不同同事接手和并行
- **WHEN** 同事开发已入库提案中的依赖就绪 SR
- **THEN** 读取同一共享需求版本，在自己的开发仓库创建该 SR 独立分支、worktree 和会话，遵守仓库单 IR 和默认 2 个 SR 上限，而不是按工号各自分配无限额名额
- **AND** 不复制来源人的绝对代码目录或聊天文件；元数据统一保存共享数据库，真实目录和 Git 操作失败如实保留
