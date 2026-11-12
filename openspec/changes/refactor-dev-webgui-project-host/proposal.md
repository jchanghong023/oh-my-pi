# Proposal：Dev 最新需求对齐 — personal-commands

## Why

本文件属于[Dev 需求总提案](../refactor-dev-webgui-requirement-intake/proposal.md)，按用户最新确认的规则更新，替换冲突的旧流程表述。

## What Changes

- 本组 `personal-commands` 共 7 项需求操作，配套见 [规格文件](specs/personal-commands/spec.md)。
- 仅保留需求管理角色、Web 所有者配置边界及远程仓库设置；平台托管提案分支，合入且文档完整后台自动转正，不要求个人目录、不提供计划／执行／IR 验收角色或开发名额。
- 保留本能力不冲突的原生生命周期、会话、材料与设置边界；确切要求以配套规格和当前权威基线为准。
- 完整部署、目录、角色与流程见[最新 Dev 说明](../../../docs-zh-CN/spec-driven-orchestration.md)。

## Capabilities

### Modified Capabilities

- `personal-commands`：与本组总提案和对应权威基线保持一致。

## Impact

本轮仅文档及独立原型，不修改正式宿主、后端或运行时，不执行真实 Git、OpenSpec 同步／归档或数据库迁移；原型设置只保存内存，不证明真实权限、配置、仓库或共享服务可用。
