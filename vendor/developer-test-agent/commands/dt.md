---
description: '使用developer-test-agent完成DT任务，比如生成单元测试、修复测试问题、提升覆盖率或审查断言质量'
---

将用户的完整原始请求委托给 `developer-test-agent`。

用户请求原文：

{{{rawArguments}}}

## 规则

- **禁止**自行执行单元测试工作（读取源码、编写测试、修复测试等），必须委托给 `developer-test-agent`。
- 调用 `task` 时，将用户完整原始请求原样放入 `task` 字段，不得改写、解释或预处理。
- 只启动一个任务，等待其完成后向用户简要总结结果；不得创建团队。
- 子代理返回缺失信息和待询问题时，用 `ask` 向用户收集答案，交回子代理或附上原请求重新委托；不得猜测或声称任务已完成。

## 调用示例

```json
{
  "context": "按用户请求执行单元测试任务",
  "tasks": [{
    "agent": "developer-test-agent",
    "task": "<用户原始请求原文>",
    "solutionSpace": "按用户原始请求执行单元测试任务"
  }]
}
```
