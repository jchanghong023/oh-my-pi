# Proposal：AIReq 最新权威需求对齐

## Why

AIReq 最新权威边界为 AI 驱动的需求管理与代码证据进度跟踪：自然语言 IR／SR、四 Agent 评审、方案依赖、人员排期、平台托管提案分支及后台自动转正。实际开发在平台外完成，旧单仓库单 IR、两个 SR 名额、个人目录准入、首个 SR 冻结、计划／执行／IR 验收和最终归档流水线不再适用。

## What Changes

- 本次用户明确授权更新需求文档，因此同时更新 `openspec/specs/` 对应 AIReq 基线与本组配套增量，不能继续标记为尚待用户批准的新需求；文档获确认不等于代码已实现。
- 权威规则见[当前工作台规格](../../specs/aireq-browser-workbench/spec.md)及[最新 AIReq 说明](../../../docs-zh-CN/spec-driven-orchestration.md)。本轮只改文档与独立原型，不改正式后端或运行时，不执行 Git 提交推送、OpenSpec 同步／归档或数据库迁移。
- 一个项目一个仓库，一个 IR 一个 Change，SR 对应能力 spec.md，共享 design.md；提案先在 `/tmpdata/DFT_LAB/omp/{project_name}/{原提交人工号}/{提案id}/` 生成。
- 工号为一个小写 a–z 字母加八位数字，仅作操作标识；各 Web 使用其所有者的 Token，仅所有者为 `j00808874` 的 Web 提供提案讨论，其他 Web 只读资料，不接管聊天。
- 需求评审为三个不同模型同轮同版独立并行只读检查，第四个 Agent 综合来源和分歧；四份报告完整后由人工判断，不按投票、评分或标签自动通过／阻断，不增加裁决表单。需求更新使旧报告及决定失效。
- 方案 Agent 明确各 SR 实现思路、稳定 SR 依赖、原因、可并行关系及不确定项；需业务补充时人工粘贴意见直接返回业务 Agent，重评后重新确认方案，不编制编码任务计划。
- 当前 IR、全部 SR、方案经人工逐文件确认后平台才从最新默认分支创建推送提案分支并提供 PR 内容；人工在 Git 网页创建、评审、合并，平台不自动创建／合并 PR、不依赖 PR API 或个人目录。
- 后台仅按提案已合入默认分支且文档完整两个条件自动转正并创建各 SR 分支，兼容 merge／squash／rebase，不要求 PR 地址、人工通知或再次批准，不归档或提前同步未实现规格。
- 正文、验收、方案及稳定 SR 依赖入 Git；项目、Release、状态、人员、建议／人工排期、进度及必要会话引用经固定 18321 的 `omp aireq_db` 服务入唯一共享数据库，不各 Web 直接打开 NFS SQLite；个人配置、Token 和聊天正文不入业务库。
- 管理员分配 IR 负责人，管理员或负责人调整 SR 人员、排期及有依据的进度，其他人只读。保留 AI 原建议及人工记录，依赖和人员冲突只提醒，不构成执行锁或转正门槛，不单列工时。
- 正式需求为大表格与同页报告，不挂载开发聊天或执行动作。进度基于代码证据，未合入最高 99%，已合入且全部条件满足才可自动 100%，AI 不确定允许人工依据证据判断；IR 为全部 SR 算术平均，全部完成才完成。
- 设置只登记远程仓库及默认分支，不要求个人／共享目录；配置全员可看，只有当前 Web 所有者可改。导航删除自由会话和正在开发区域，保留自动化独立演示、只读材料与 Skill 设计，普通 OMP／WebGUI 保持不变。

### 1.1 分阶段实施与当前临时状态

当前仍为独立前端原型评审阶段，文档与原型按上述边界对齐。原型对话、四路报告、Git 合入、排期和进度均为明确标注的内存演示，刷新恢复样例，不证明真实模型、Git、数据库、后台或多人权限已实现。

本轮不运行 build、lint、tests 或 formatter；父任务可统一进行实际浏览器交互观察，并分别报告浏览器版本、入口及操作范围。后续真实对接与软件验收需单独授权，不能以历史门禁、构建或原型观察替代。

### 配套变更

每个 change 最多 10 个 requirement 操作，保留原分组。退役清单仅记录被替换的旧标题，已批准基线以当前 `openspec/specs/` 为准，不重复执行删除；不删除普通能力、用户文件或历史，不做旧状态迁移。

| Change | 能力 | 操作数 |
| --- | --- | --- |
| [refactor-dev-webgui-requirement-intake](../refactor-dev-webgui-requirement-intake/proposal.md) | `aireq-requirement-intake` | 8 |
| [refactor-dev-webgui-workbench-retirement](../refactor-dev-webgui-workbench-retirement/proposal.md) | `aireq-browser-workbench` | 10 |
| [refactor-dev-webgui-workbench](../refactor-dev-webgui-workbench/proposal.md) | `aireq-browser-workbench` | 10 |
| [refactor-dev-native-stage-retirement](../refactor-dev-native-stage-retirement/proposal.md) | `spec-driven-orchestration` | 10 |
| [refactor-dev-native-state-retirement](../refactor-dev-native-state-retirement/proposal.md) | `spec-driven-orchestration` | 10 |
| [refactor-dev-native-workflow](../refactor-dev-native-workflow/proposal.md) | `spec-driven-orchestration` | 8 |
| [refactor-dev-webgui-project-host](../refactor-dev-webgui-project-host/proposal.md) | `personal-commands` | 7 |

## Capabilities

### New Capabilities

- `aireq-requirement-intake`：共享提案、需求评审、技术方案及正式入库；本次按用户确认建立对应权威规格。

### Modified Capabilities

- `aireq-browser-workbench`：提案三栏、正式需求表格与同页报告、无编码执行导航、演示及真实证据边界。
- `spec-driven-orchestration`：需求 Agent、原生生命周期、文档与共享元数据、需求分支及代码证据完成条件。
- `personal-commands`：AIReq 入口、配置归属、远程仓库设置及现有需求角色，保持普通 OMP／WebGUI。

## Impact

本轮仅修改 Markdown 文档及独立演示原型，不修改正式后端、运行时、提示词资源、schema 或数据库，不执行真实 Git 或同步归档；历史实现／验收证据保留原范围，不能覆盖当前新增要求。
