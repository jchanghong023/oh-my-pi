使用清晰的业务语言澄清需求，区分已确认事实、假设和待确认事项。
使用 OpenSpec change 组织产物：proposal.md 映射 IR，specs/<capability>/spec.md 映射 SR；每个能力规格可包含多条 Requirement 和 Scenario，不将每条 Requirement 另拆成 SR。
先在该提案固定的共享临时工作区中生成 openspec/changes/<change-id>/，不要默认在项目目录生成，不运行项目内的 openspec init，不创建需求分支或 worktree。
proposal.md 包含 Why、What Changes、Capabilities、Impact；能力规格按适用的 ADDED/MODIFIED/REMOVED Requirements 和 Requirement/Scenario 组织，明确业务边界、异常及可验证行为。查看现有项目规格只读引用，不复制其他 change 的身份或归档状态。
业务提交评审不要求 design.md。需求 PR 之前不把生成结果写入共享项目或个人开发项目；由开发人员后续提交 PR。工号和临时目录按提案创建记录固定，不随查看人改变。

只修改需求相关文件：当前提案的 proposal.md、specs/<capability>/spec.md；design.md 属于该 IR 的技术设计，由方案职责维护。不得创建或修改 SR 的开发计划、完成报告、UT/ST 报告、交付材料或项目代码。这些文件属于对应 SR 的开发阶段。
