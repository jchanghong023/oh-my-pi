# Proposal：Dev 最新权威需求对齐

## Why

用户最新确认的流程作为 Dev 权威需求：共享长期 Web、标准 OpenSpec 提案、同仓库单 IR、默认最多两个依赖就绪 SR 并行、代码与测试及规格同 PR、IR 整体验收及最终修复／归档 PR。此前四阶段／八阶段、每工号单 SR、代码合入即结束、共享 JSON、提案合入立即冻结等冲突规则不再适用。

## What Changes

- 本次用户明确授权更新需求文档，因此同时更新 `openspec/specs/` 对应 Dev 基线与本组配套增量，不能继续标记为尚待用户批准的新需求；文档获确认不等于代码已实现。
- 完整规则和后续实现依据见[最新 Dev 流程说明](../../../docs-zh-CN/spec-driven-orchestration.md)。本次只改文档，不改原型、代码、运行数据，不执行提案同步／归档、迁移或提交推送，不生成实施任务表。
- 一个项目一个仓库；一个 IR 一个 Change；SR 对应能力增量 `spec.md`，共享 `design.md` 明确方案、顺序与依赖。先在 `/tmpdata/DFT_LAB/omp/{project_name}/{原提交人工号}/{提案id}/` 临时工作区生成标准 OpenSpec 文件。
- A 运行长期服务并共用其模型 Token，访问者只填 `j` 加 8 位数字工号，格式检查不代表认证。所有项目使用唯一共享数据库 `/tmpdata/DFT_LAB/omp/omp_dev_sqlite.db`。项目、Release 与按工号绑定的个人开发目录共享登记；共享项目路径只读。
- 业务需求 Agent 之后必须经过业务需求评审；不通过补充，争议交人。开发人员接手后由方案 Agent 确定技术方案和 SR 依赖；需要业务信息时打回补充。提交开发接手不要求方案，提案 PR 前必须方案完成并人工确认。不增加“待评审”状态。
- 提案 PR 由 AI 提交／推送分支并提供标题与正文，人工创建、评审、合并并告知；核对默认分支包含确认材料后成为正式提案，显示在正式需求导航，尚不代表实现／归档，也不提前同步未实现规格。
- 同仓库同时一个开发 IR，该 IR 内依赖就绪的独立 SR 默认最多并行两个，不按工号限制一个 SR。每个 SR 从其开发人的已有 Git 开发目录，以启动时最新默认分支创建固定独立分支／worktree。前置 PR 真实合并后，后继 SR 才就绪。
- 首个 SR 开始冻结 IR／全部 SR 正文及确认方案；变化重新提案。执行阶段不设方案 Agent。准备中、等待评审与合并仍占 SR 名额；SR 完成只释放 SR 名额，仓库 IR 占用持续到最终验收归档 PR 合并核验。
- Superpowers 提供计划／开发／测试／代码审查方法，OMP 唯一管理执行及状态，使用原生测试／审查子代理。六个核心职责为业务需求、业务需求评审、方案、计划、执行、IR 验收；模型和追加提示词仍存 A 的现有 OMP 配置目录，仅新建会话采用新设置，不增加提示词预览。
- SR PR 同时提交代码、测试与对应已实现规格；合并前对齐最新默认分支并重跑受影响验证。需求冲突与 Git 合并冲突交人，普通实现问题由 Agent 修复。
- 全部 SR 合并后 IR 验收 Agent 整体验收，修复实现问题并复验。最终候选包括修复，合并前默认分支变化需复核；修复和归档放最后一个 PR，无修复时可只归档。归档只移动 Change，不再次同步规格。人工合并并经平台核验后 IR 完成、释放仓库。
- 保留不冲突的原生 OMP／WebGUI 边界、桌面浏览器目标、自由会话、导航和材料控件、独立 Skill 设计、历史只读、版本确认、错误恢复及不自动删工作区等要求。长期共享 Dev 服务按最新多人部署规则访问，不沿用 Dev 仅本机的旧假设；WebGUI 本轮不改。

### 1.1 分阶段实施与当前临时状态

当前仍为独立前端原型评审阶段。本次仅文档更新，现有原型尚有每工号单 SR、合入冻结、缺少 IR 验收等旧行为，不能拿样例或历史测试证明本轮需求已实现。后续原型与实现须另行按最新基线对齐，详见[原型说明](../../../packages/dev-frontend/README.md)。

### 配套变更

每个 change 最多 10 个 requirement 操作，保留原分组。退役清单仅记录被替换的旧标题，已批准基线以当前 `openspec/specs/` 为准，不重复执行删除；不删除普通能力、用户文件或历史，不做旧状态迁移。

| Change | 能力 | 操作数 |
| --- | --- | --- |
| [refactor-dev-webgui-requirement-intake](../refactor-dev-webgui-requirement-intake/proposal.md) | `dev-requirement-intake` | 8 |
| [refactor-dev-webgui-workbench-retirement](../refactor-dev-webgui-workbench-retirement/proposal.md) | `dev-browser-workbench` | 10 |
| [refactor-dev-webgui-workbench](../refactor-dev-webgui-workbench/proposal.md) | `dev-browser-workbench` | 10 |
| [refactor-dev-native-stage-retirement](../refactor-dev-native-stage-retirement/proposal.md) | `spec-driven-orchestration` | 10 |
| [refactor-dev-native-state-retirement](../refactor-dev-native-state-retirement/proposal.md) | `spec-driven-orchestration` | 10 |
| [refactor-dev-native-workflow](../refactor-dev-native-workflow/proposal.md) | `spec-driven-orchestration` | 8 |
| [refactor-dev-webgui-project-host](../refactor-dev-webgui-project-host/proposal.md) | `personal-commands` | 7 |

## Capabilities

### New Capabilities

- `dev-requirement-intake`：共享提案、需求评审、技术方案及正式入库；本次按用户确认建立对应权威规格。

### Modified Capabilities

- `dev-browser-workbench`：多 SR 导航、冻结、受限并行、人工 PR 与最终验收归档。
- `spec-driven-orchestration`：原生运行时、Superpowers、共享状态、依赖和完整 IR 生命周期。
- `personal-commands`：Dev 入口、服务账号配置与六个职责，保留普通 OMP／WebGUI。

## Impact

当前仅更新 Markdown 文档。上述变化是后续原型和真实实现的依据，不修改任何代码、静态样例、提示词资源、schema 或数据库；历史实现／验收证据保留其原范围，不覆盖新增要求。
