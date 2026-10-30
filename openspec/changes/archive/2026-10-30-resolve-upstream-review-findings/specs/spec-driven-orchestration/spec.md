# Spec Delta

## ADDED Requirements

### Requirement: 内置执行代理具备必要原生能力

OMP MUST 为内置 `spec-executor` 提供完成已批准执行阶段委派、验证、独立审查及等待所需的适用原生能力，同时保留阶段权限与获批范围限制。

#### Scenario: 委派实施和独立审查
- **WHEN** `spec-executor` 被用于实施获批计划且未达到原生派生限制
- **THEN** 其可用工具 MUST 包含原生 `task`，使其能够派发实施子代理和独立 `reviewer`；适用异步工作 MUST 可使用原生 `wait` 等待真实结果。
- **AND** 验证能力 MUST 能执行获授权的计划内验证；缺少权限或其他必需能力时 MUST 报告阻塞，不能伪报实施、验证或审查完成。
- **AND** 需求、方案、计划阶段的只读权限与其他显式受限代理的边界保持不变。
