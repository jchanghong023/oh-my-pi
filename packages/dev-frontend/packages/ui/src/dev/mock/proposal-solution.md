> 原型静态 design.md 样例。未调用模型、修改文件、提交 PR 或验证 Git。

## Context

输入是本 change 的 proposal.md、全部 `specs/<capability>/spec.md` 与业务讨论。先在提案临时工作区生成方案，由评审需求的开发人员确认后提交需求 PR。

## Goals / Non-Goals

- 覆盖全部能力规格中的业务规则、异常与验收场景。
- 复用已有聊天、导航与服务边界。
- 本方案不授权代码开发、真实文件操作或自动归档。

## Decisions

采用 OpenSpec 原有 change 结构，proposal.md 映射 IR，每个能力 spec.md 映射一个 SR，design.md 覆盖整份 change。能力 spec.md 内可以有多条 Requirement 和 Scenario。

## 架构与模块

界面负责选择和展示，Agent 整理业务或方案产物，宿主在后续实现中负责临时目录归属、版本校验和需求 PR。共享项目目录仅供只读参考，生成目标是提案固定临时工作区。

## 文件与函数（设计示例，非实际改动清单）

| 模块 | 文件／函数职责 | 需求对应 |
| --- | --- | --- |
| 需求展示 | material-pane：按 change 路径展示 proposal/spec/design | 全部 SR 的材料归属 |
| 版本校验 | validateProposalVersion：比对本轮需求与 design 绑定版本 | 防止旧方案提交 |
| PR 交接 | prepareRequirementChange：将确认的 change 文件带入对应仓库需求分支 | PR 提交和默认分支核对 |

具体业务模块、接口和函数签名应由开发人员依据所选项目代码确认；本静态示例不代表已完成真实代码分析。

## Risks / Trade-offs

业务规则不明时明确列出卡点，由开发人员填写原因并打回业务补充。保留旧 design.md，但标记失效；需求更新后需重新确认本轮方案，不能仅凭文件存在提交 PR。

## Migration Plan

需求 PR 包含同一 change 的 proposal.md、全部 `specs/<capability>/spec.md` 与有效 design.md。开发人员在 PR 准备时把确认版本带入对应仓库的可写分支；合并前仍是提案。合并后核对默认分支同路径文件与版本才转正，仍保留在 changes/，不归档、不标记实现完成。

## Open Questions

待业务澄清的问题必须记录并处理后再确认方案。本例无实际项目分析结论，真实阻塞项需后续确认。
