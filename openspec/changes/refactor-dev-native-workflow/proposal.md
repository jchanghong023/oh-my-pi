# Proposal：AIReq 最新需求对齐 — spec-driven-orchestration

## Why

本文件属于[AIReq 需求总提案](../refactor-dev-webgui-requirement-intake/proposal.md)，按用户最新确认的规则更新，替换冲突的旧流程表述。

## What Changes

- 本组 `spec-driven-orchestration` 共 8 项需求操作，配套见 [规格文件](specs/spec-driven-orchestration/spec.md)。
- AIReq 只负责需求、四 Agent 评审、方案、人员排期、提案分支与代码证据进度；实际编码在平台外完成，删除单 IR 锁、SR 名额、个人目录准入、冻结及验收归档流水线要求。
- 保留本能力不冲突的原生生命周期、会话、材料与设置边界；确切要求以配套规格和当前权威基线为准。
- 完整部署、目录、角色与流程见[最新 AIReq 说明](../../../docs-zh-CN/spec-driven-orchestration.md)。

## Capabilities

### Modified Capabilities

- `spec-driven-orchestration`：与本组总提案和对应权威基线保持一致。

## Impact

本轮仅文档及独立原型，不修改正式后端或运行时，不执行真实 Git、OpenSpec 同步／归档或数据库迁移；原型内存与固定回复不代表真实服务实现或验收，历史证据仍限原范围。
