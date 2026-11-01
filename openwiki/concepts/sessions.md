---
type: "参考"
title: "会话、上下文和持久化"
openwiki_generated: true
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-11-01T02:46:50.031Z
sources:
  - id: openwiki-source-ca80b74df138bdc1bef5cc82
    resource: repo://packages/agent/src/agent.ts
  - id: openwiki-source-1d770863aa37635ae350aa7a
    resource: repo://packages/coding-agent/src/session/session-manager.ts
  - id: openwiki-source-66485680584ef1419da537e2
    resource: repo://packages/coding-agent/test/session-manager-atomic-rewrite-race.test.ts
generated: { by: "openwiki/0.0.0-unknown", at: "2026-11-01T02:46:50.031Z" }
---


# 会话、上下文和持久化

会话需要区分两类状态：Agent 的运行时 `AgentState`（当前消息、队列、循环是否忙碌）是进程内状态；Coding Agent 的 `SessionManager` 则把会话记录为有序的 `SessionEntry` 日志，并提供读取、分支和存储操作。重启后恢复的是持久化日志及其选定分支，不是原进程中的队列、正在执行的工具或异步任务。

## 运行时消息与持久日志

Agent 的 agent loop 负责处理消息和工具调用；`steer()` 与 `followUp()` 把新输入交给不同队列，前者可在当前执行过程中影响控制流，后者在当前轮次之后继续。队列策略由 steering/follow-up mode 决定；忙碌时直接启动另一轮不是并发安全的替代方案，应使用队列接口。`AgentBusyError` 明确表达了这一边界。

Session 层的 `SessionManager` 通过 append 日志保存消息、初始化、模型变化、压缩、分支摘要等不同类型的 entry。入口不是把整段对话覆盖写成单一 transcript：日志条目包含父/叶节点关系，允许恢复历史选择与从旧节点创建分支。`SessionLoader` 解析文件、迁移版本并解析外置 blob 引用，`SessionManager` 再据此构造当前上下文；持久化格式与发给模型的消息列表因此并不相同。

<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering. Fix the diagram source and restore the mermaid fence. Parser error: Parse error on line 10: ...加入当前控制流 Queue->>Loop: 按队列策略取消息 L Expecting '+', '-', '()', 'ACTOR', got 'loop' -->
```text
sequenceDiagram
    participant User as 用户
    participant Agent as Agent 运行时
    participant Queue as 消息队列
    participant Loop as Agent loop
    participant Manager as SessionManager
    participant Log as 会话日志
    User->>Agent: 提交输入
    Agent->>Queue: 入队或加入当前控制流
    Queue->>Loop: 按队列策略取消息
    Loop->>Manager: 记录会话条目
    Manager->>Log: 追加持久化 entry
    Log-->>Manager: 后续加载日志
    Manager-->>Loop: 构造恢复上下文
```

图示运行时消息处理与日志恢复的边界；具体是否每个运行时事件都落盘，取决于 Session 层的调用点。

## 恢复、分支和压缩

会话日志中的 entry 形成树状历史：叶节点标识当前选定路径，branch 操作可从指定 entry 创建另一条路径，而不是抹掉既有日志。恢复测试覆盖会话 resume；分支后上下文从选定路径构建。会话文件加载还负责版本迁移和异常/不完整数据的读取处理。

压缩是上下文预算管理，不等同于删除会话历史。Agent 的 compaction 子系统生成供后续模型调用使用的较短上下文；Session 层记录压缩相关 entry，使历史仍可追踪。因而“存储事实”是原始 entry 与压缩记录，“运行中状态”是本轮实际提交给模型的经过筛选、转换的消息。`Agent` 的 `convertToLlm` 默认仅保留 LLM 可用角色并排除 refusal 消息，`transformContext` 可在转换前裁剪或注入内容。

## 并发与失败边界

持久化写入不是无条件安全的多写者合并。存储层提供 `SessionWriteConflictError`，原子重写竞态测试专门验证冲突条件；调用方需识别冲突并重试或重新加载，不能假设并发 rewrite 会静默合并。日志 append 与整文件 rewrite 的保证也不可混为一谈。

关闭或中断时，运行中工具、队列和模型流可能尚未完成；持久日志可保存已经提交的条目，但不能保证未提交的运行时副作用自动回滚。恢复逻辑根据日志和停止信息处理不完整尾部及未配对工具调用。操作上应把“已写入日志”视为恢复依据，而非把 UI 当前显示或内存队列视为持久事实。

## 相关实现与验证

- [运行时架构](../architecture/runtime.md) 描述 Agent loop 与执行边界。
- [Zcode 集成](../integrations/zcode.md) 说明会话能力在产品集成中的使用。
- [编排工作流](../workflows/orchestration.md) 涉及并发任务与会话交互。
- 代表性测试：`packages/coding-agent/test/agent-session-resume.test.ts`、`packages/coding-agent/test/session-manager-atomic-rewrite-race.test.ts`。
