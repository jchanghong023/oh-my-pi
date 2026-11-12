*技术方案样例 · 未读取真实项目代码。*

## Context

输入是本 change 的 proposal.md、全部 `specs/<capability>/spec.md` 与业务讨论。先在提案临时工作区生成方案；人确认当前 IR、全部 SR 和方案后，由平台创建提案分支、提交推送，再由人到 Git 网页创建、评审和合并需求 PR。方案参与记录不构成独占讨论权限。

## Goals / Non-Goals

- 覆盖全部能力规格中的业务规则、异常与验收场景。
- 复用已有聊天、导航与服务边界。
- 本方案不授权代码开发、真实文件操作或自动归档。

## Decisions

采用 OpenSpec change 结构，proposal.md 映射 IR，每个能力 spec.md 映射一个 SR，design.md 覆盖整份 change 的实现思路与技术取舍。能力 spec.md 内可以有多条 Requirement 和 Scenario，不维护依赖。工期预估、假设、依赖及原因唯一记录在同目录 sr-dependencies.json；design.md 只引用，不重复清单。

## 材料目录（示意）

```text
openspec/changes/<change-id>/
├── proposal.md           # IR 业务需求
├── specs/
│   └── <capability>/spec.md  # SR 规格
├── design.md             # 当前技术方案
└── sr-dependencies.json  # SR 依赖、工期预估及假设
```

## 架构与模块

界面负责选择和展示，Agent 整理业务或方案产物，宿主在后续实现中负责临时目录归属、版本校验和需求分支管理。项目只配置远程仓库和默认分支，平台按需拉取内部工作副本作为只读参考；无需个人开发目录，生成目标是提案固定临时工作区。

## 文件与函数（设计示例，非实际改动清单）

| 模块 | 文件／函数职责 | 需求对应 |
| --- | --- | --- |
| 需求展示 | material-pane：按 change 路径独立展示 proposal/spec/design 与 JSON 依赖材料 | 全部 SR 的材料归属 |
| 版本校验 | validateProposalVersion：比对本轮需求与两个方案产物的绑定版本 | 防止旧方案提交 |
| PR 交接 | prepareRequirementChange：将确认的 change 文件带入对应仓库需求分支 | PR 提交和默认分支核对 |

具体业务模块、接口和函数签名应由开发人员依据所选项目代码确认；本静态示例不代表已完成真实代码分析。

## Risks / Trade-offs

逐 SR 说明实现思路与待确认事项；前置依赖及原因从 sr-dependencies.json 读取，可并行范围由其依赖图推导。依赖顺序不等于开发者可用性；缺少人员日历、请假、其他项目占用或真实代码依据时，必须明确建议的假设，不声称已完成资源协调。

建议开始和结束时间、人员分配和人工调整在文档外的开发安排卡片展示，目标存储为业务数据库。方案正文与依赖提交仓库，不单列工时；修改人员和时间不改文档版本、不新增入库审批。原型卡片与文档分析来自同一份样例，不代表真实 AI 输出。

业务规则不明时明确列出卡点，由开发人员填写原因并打回业务补充。保留旧 design.md 与 sr-dependencies.json，但一同标记失效；需求更新后需重新确认本轮两个产物。JSON 缺失、无效或过期不得回退旧图，不能沿用确认或提交 PR。

## Migration Plan

需求 PR 包含同一 change 的 proposal.md、全部 `specs/<capability>/spec.md`、有效 design.md 与 sr-dependencies.json。人工逐文件确认当前版本后，平台从最新默认分支创建提案分支、提交并推送，人工在 Git 网页创建、评审和合并 PR。后台检查提案分支已合入默认分支且上述文档完整、JSON 有效，便自动转正并创建、推送各 SR 分支；不要求个人目录、PR 链接或人工通知。转正保留 JSON 工期预估和依赖，随后再安排负责人、开发人员和起止日期，新 SR 进度为 0%；仍保留在 changes/，不归档、不标记代码完成。AIReq 仅跟踪后续代码证据，不执行开发、测试或修复。

## Open Questions

待业务澄清的问题必须记录并处理后再确认方案。本例无实际项目分析结论，真实阻塞项需后续确认。
