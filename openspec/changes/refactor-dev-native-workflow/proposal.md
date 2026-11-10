# Proposal：Dev 最新需求对齐 — spec-driven-orchestration

## Why

本文件属于[Dev 需求总提案](../refactor-dev-webgui-requirement-intake/proposal.md)，按用户最新确认的规则更新，替换冲突的旧流程表述。

## What Changes

- 本组 `spec-driven-orchestration` 共 8 项需求操作，配套见 [规格文件](specs/spec-driven-orchestration/spec.md)。
- 统一采用同仓库单 IR、默认最多两个依赖就绪 SR 并行、首个 SR 启动冻结、人工提案 PR、SR 代码／测试／规格同 PR、IR 验收与最终修复／归档 PR；归档只移动目录，不再次同步规格。
- 保留本能力不冲突的原生生命周期、会话、材料与设置边界；确切要求以配套规格和当前权威基线为准。
- 完整部署、目录、角色与流程见[最新 Dev 说明](../../../docs-zh-CN/spec-driven-orchestration.md)。

## Capabilities

### Modified Capabilities

- `spec-driven-orchestration`：与本组总提案和对应权威基线保持一致。

## Impact

本轮仅更新文档，已同步用户确认的 `openspec/specs/` Dev 需求，不表示实现或验收通过。不改原型、代码、静态数据或运行状态；不执行 Git 提交／推送、OpenSpec 同步／归档或数据库迁移。原型未对齐项见[运行说明](../../../packages/dev-frontend/README.md)。
