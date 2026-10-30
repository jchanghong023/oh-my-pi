# Spec Delta

## ADDED Requirements

### Requirement: CodeAgent 在提交消息和标题生成中的回退

OMP MUST 对 CodeAgent 的 commit 消息及会话标题生成恢复审查基线的上游失败、重试和候选回退行为；该选择不修改既有对话、压缩摘要与 handoff 的认证轮换限制。

#### Scenario: commit 快速生成失败
- **WHEN** CodeAgent 的 commit 消息快速生成请求失败
- **THEN** MUST 按上游既有流程处理该失败和后续分析／回退，不得因本次新增的 CodeAgent terminal 标记提前终止整个生成流程。

#### Scenario: 会话标题候选失败
- **WHEN** CodeAgent 的会话标题生成候选认证、请求或结果解析失败
- **THEN** MUST 按上游既有候选、重试和回退规则继续或结束，不得仅因该 Provider 而新增停止候选链的例外。
