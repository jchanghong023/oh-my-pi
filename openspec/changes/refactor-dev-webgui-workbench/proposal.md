# Proposal：Dev 最新需求对齐 — dev-browser-workbench

## Why

本文件属于[Dev 需求总提案](../refactor-dev-webgui-requirement-intake/proposal.md)，按用户最新确认的规则更新，替换冲突的旧流程表述。

## What Changes

- 本组 `dev-browser-workbench` 共 10 项需求操作，配套见 [规格文件](specs/dev-browser-workbench/spec.md)。
- Dev 仅管理需求、四 Agent 评审、方案、人员排期、提案分支与代码证据进度；提案保留三栏，正式需求采用表格和同页报告，删除自由会话、开发阶段、名额、冻结锁及验收归档流水线。
- 保留本能力不冲突的原生生命周期、会话、材料与设置边界；确切要求以配套规格和当前权威基线为准。
- 完整部署、目录、角色与流程见[最新 Dev 说明](../../../docs-zh-CN/spec-driven-orchestration.md)。
- 本轮只改文档与独立原型，不运行 build、lint、tests 或 formatter；实际浏览器交互由父任务统一观察，后续真实对接及验收须单独授权。

## Capabilities

### Modified Capabilities

- `dev-browser-workbench`：与本组总提案和对应权威基线保持一致。

## Impact

本轮仅文档及独立原型，不修改正式后端或运行时，不执行真实 Git、OpenSpec 同步／归档或数据库迁移；样例回复、证据与 Git 结果须标注，不代表真实服务或发行验收。
