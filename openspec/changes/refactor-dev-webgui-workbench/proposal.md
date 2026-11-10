# Proposal

## Why

本 change 是 [refactor-dev-webgui-requirement-intake](../refactor-dev-webgui-requirement-intake/proposal.md) 完整 Dev 重构提案的一部分。当前 `dev-browser-workbench` 仍包含与本轮最终确认的需求模型、四阶段、人工 PR、共享工作流及 WebGUI 使用方式冲突的旧条款，必须明确替换或退役，避免新增规则与旧八阶段同时生效。

## What Changes

- 本文件只承载 `dev-browser-workbench` 的 10 项 ADDED, MODIFIED 需求操作，满足包内单 change 不超过十项的格式限制。
- 全部结论、适用边界、替换关系及尚未确定事项以[总提案](../refactor-dev-webgui-requirement-intake/proposal.md)及本组增量共同定义。
- 本组必须整体审阅和交付。退役旧条款不等于删掉其普通 OMP 能力、用户数据或未受影响的原生边界，不交付只有删除规则的中间版本。
- 当前按[总提案的分阶段实施约束](../refactor-dev-webgui-requirement-intake/proposal.md#11-分阶段实施与当前临时状态)仅开发同一套 Dev 前端的 UI/UX 原型：假数据、独立入口及说明纳入仓库，不接 OMP 或真实后端；软件测试默认暂缓，另行明确授权的 fastcheck/fulltest 门禁维护可与原型设计并行。原型获用户确认后再恢复真实对接与最终验收。这是临时开发状态，不是将最终工作台改成纯前端产品，也不生成 design/tasks 或迁移、归档旧状态。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `dev-browser-workbench`: 完整对齐总提案中相应领域的最终行为；本 change 的确切需求项见配套 `specs/dev-browser-workbench/spec.md`。

## Impact

- 后续实现需结合本组所有增量更新对应前端、宿主或编排能力，保留其他既有规则。
- 本文件不直接修改 `openspec/specs/` 权威基线，只有明确批准后的原生同步/归档才形成新基线。
