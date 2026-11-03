---
description: '使用developer-test-agent完成DT任务，比如生成单元测试、修复测试问题、提升覆盖率或审查断言质量'
---

你必须将用户的请求委托给 `developer-test-agent:developer-test-agent`，通过以下方式之一：

1. **Agent 工具**（推荐）：调用 Agent 工具，设置 `subagent_type: "developer-test-agent:developer-test-agent"`，将用户原始请求原样传入 prompt。
2. **Task 工具**：通过 TaskCreate 创建任务，然后启动 Agent 并设置 `subagent_type: "developer-test-agent:developer-test-agent"`，将任务分配给它。

## 规则

- **禁止**自行执行单元测试工作（读取源码、编写测试、修复测试等），必须委托给 `developer-test-agent:developer-test-agent`。
- 使用 Agent 工具时，设置 `subagent_type: "developer-test-agent:developer-test-agent"`，将用户完整原始请求作为 prompt 传入，不得改写、解释或预处理。
- Agent 完成后，向用户简要总结结果。
- **禁止使用 Team 模式**：不得使用 `TeamCreate` 创建团队，不得在 Agent 调用中传入 `team_name` 参数，任务执行必须且只能通过 `TaskCreate` 创建独立任务 + `Agent`（无 `team_name`）串行调度。

## 调用示例

```
Agent(
  subagent_type: "developer-test-agent:developer-test-agent",
  prompt: "<用户原始请求原文>"
)
```
