# Proposal：旧 AIReq 条款退役记录 — spec-driven-orchestration

## Why

本文件属于[AIReq 需求总提案](../refactor-dev-webgui-requirement-intake/proposal.md)，按用户最新确认的规则更新，替换冲突的旧流程表述。

## What Changes

- 本组 `spec-driven-orchestration` 共 10 项需求操作，配套见 [规格文件](specs/spec-driven-orchestration/spec.md)。
- 退役旧开发阶段与权限条款；当前 AIReq 仅管理需求、四 Agent 评审、方案、人员排期、提案分支和代码证据进度，不编码、不设执行名额或验收归档流水线。
- 配套 REMOVED 标题仅保留旧条款替换清单；权威基线已按用户本次授权更新，不应重复删除或据此迁移旧状态。
- 完整部署、目录、角色与流程见[最新 AIReq 说明](../../../docs-zh-CN/spec-driven-orchestration.md)。

## Capabilities

### Modified Capabilities

- `spec-driven-orchestration`：与本组总提案和对应权威基线保持一致。

## Impact

本轮仅文档及独立原型，不修改正式后端或运行时，不执行真实 Git、OpenSpec 同步／归档或数据库迁移；退役清单不删除用户文件、不迁移历史状态，普通 OMP 能力保持原边界。
