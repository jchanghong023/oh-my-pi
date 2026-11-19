# Spec Delta

## MODIFIED Requirements

### Requirement: 独立 OpenSpec 与原生能力边界

OMP MUST 保留独立 OpenSpec、Superpowers、JCH 及普通会话能力；接受需求材料不代表实施或软件验收。

#### Scenario: 独立原生能力的职责与来源

- **WHEN** 用户使用独立能力
- **THEN** 以下职责、来源及授权边界适用：
   - 独立内置 OpenSpec 通过 `omp openspec` 封装固定上游 1.15.0，不要求另装 OpenSpec，不只复制说明文字，不依赖开发机绝对路径；除默认 schema 和 `init` 的技能及命令生成适配外，CLI、模板工厂及解析、校验、同步、合并、归档等底层能力 MUST 保持上游行为。原生 `spec-driven` schema 和资源保留可用。
   - 固定来源为 OpenSpec 1.15.0、Superpowers 7.0.1（`2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`）；JCH `jch-grill-me` 的真实 `SKILL.md` 和 `agents/openai.yaml` 一并交付并绑定来源修订；固定版本不代表平台验收通过。
   - 独立 OpenSpec 只维护需求，不实施或验证软件。普通 bug 修复若预期行为未变，不强制修改需求或新建 change。普通代码实施、原生 task／reviewer、独立 Team／Goal、SDK、TUI 与其他宿主保持原语义。

#### Scenario: 独立需求维护

- **WHEN** 用户请求维护需求
- **THEN** 默认 `mini` schema 只生成 proposal 与 specs 两类需求文档，可含多个能力的增量规格，不生成 design 或 tasks，不实施或验证软件。实际写入范围及授权由用户和项目规则确定，需求接受不代表软件已实现
- **AND** 用户自行实施和验证后显式请求同步或归档；同步沿用原生 OpenSpec，同步及归档不绕过原生校验，归档只检查需求材料完整性及原生格式，不以代码实施、任务完成或软件验证作为门禁，不使用 `--no-validate` 或直接移动目录伪造归档
- **AND** 现有 change 和显式选择的 schema 不强制转换；原生 `spec-driven` 仍可显式使用，不删除或裁剪其资源
