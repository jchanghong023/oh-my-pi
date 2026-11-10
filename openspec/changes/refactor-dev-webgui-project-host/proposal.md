# Proposal

## Why

本 change 是 [refactor-dev-webgui-requirement-intake](../refactor-dev-webgui-requirement-intake/proposal.md) 完整 Dev 重构提案的一部分。当前 `personal-commands` 的 Dev 条款需要对齐新需求模型、四阶段、人工 PR 和共享工作流。WebGUI 仅作为完整前端复制来源，不修改其实现或需求合同；持久多项目设置及长期需求整理均在替换后的 Dev 内实现。

## What Changes

- 本文件承载 `personal-commands` 的 3 项 MODIFIED 和 4 项 ADDED 需求操作，共 7 项，满足包内单 change 不超过十项的格式限制；新增 Dev 个人级模型／追加提示词设置及独立 Skill 设计入口，不修改 WebGUI 正式入口、项目选择或多会话需求。
- 全部结论、适用边界、替换关系及尚未确定事项以[总提案](../refactor-dev-webgui-requirement-intake/proposal.md)及本组增量共同定义。
- 本组必须整体审阅和交付。退役旧条款不等于删掉其普通 OMP 能力、用户数据或未受影响的原生边界，不交付只有删除规则的中间版本。
- 当前按总提案的第一阶段约束，仅调整 Dev 前端原型与相关需求文档；不生成 design/tasks，不接 OMP 或真实配置读写，不迁移或归档旧状态，不恢复后端业务或软件验收。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `personal-commands`: 完整对齐总提案中相应领域的最终行为；本 change 的确切需求项见配套 `specs/personal-commands/spec.md`。

## Impact

- 后续实现先完整复制 WebGUI 前端代码替换旧 Dev 前端，再修改 Dev 副本与必要 Dev 宿主集成；原 WebGUI 前后端、入口、协议、构建配置和正式资源保持不变，保留其他既有规则。
- 本文件不直接修改 `openspec/specs/` 权威基线，只有明确批准后的原生同步/归档才形成新基线。
