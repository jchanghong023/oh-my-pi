import { MATERIAL_KIND_LABELS } from "../domain.js";
import { prototypeChangeRoot, prototypeSpecPath, prototypeCapabilityName } from "./proposal-storage.js";
import type { AIReqMaterialView, AIReqStageMaterial, AIReqWorkflowStage } from "../types.js";

const stageByKind: Record<Exclude<AIReqStageMaterial["kind"], "solution">, AIReqWorkflowStage> = {
  plan: "planning", completion: "executing", ut: "executing", st: "executing", delivery: "pr",
};
export function prototypeMaterial(input: Omit<AIReqMaterialView, "sha256" | "size" | "valid">): AIReqMaterialView {
  const content = input.content ?? "";
  return { ...input, sha256: `sample:${input.path}`, size: new TextEncoder().encode(content).length, valid: true };
}
export function requirementMaterials(projectId: string, irId: string, title: string, rows: { id: string; title: string; dependencySrIds?: string[] }[]): AIReqMaterialView[] {
  return [prototypeMaterial({ projectId, irId, kind: "ir", path: `${prototypeChangeRoot(irId)}/proposal.md`, content: `# ${title}

## Why
本需求围绕「${title}」，统一${rows.map(row => `「${row.title}」`).join("、")}的业务边界与反馈。使用者应能理解当前状态、下一步操作以及发生异常后的恢复方式。

## What Changes
${rows.map(row => `- ${row.title}：详见 specs/${prototypeCapabilityName(row.id)}/spec.md。`).join("\n")}

## Capabilities

### New Capabilities
${rows.map(row => `- ${prototypeCapabilityName(row.id)}: ${row.title}`).join("\n")}

### Modified Capabilities
无。

## Impact
- 影响范围：当前项目的相关界面与会话能力。
- 提案材料先在共享临时工作区整理，需求 PR 合并后转为正式需求。
- 涉及需求文档、交互边界及对应模块的实现与验证。` }),
  ...rows.map(row => prototypeMaterial({ projectId, irId, srId: row.id, kind: "sr", path: prototypeSpecPath(irId, row.id), content: `# ${row.title}

稳定 SR ID：${row.id}

## ADDED Requirements

### Requirement: ${row.title}
系统 MUST 展示与当前项目和需求一致的内容，并保持明确的查看上下文。

#### Scenario: 查看当前需求
- **WHEN** 用户选择本能力对应的 SR
- **THEN** 展示此 spec.md 的完整行为、规则与验收场景
- **AND** 不自动推进阶段或发送消息

#### Scenario: 没有可展示内容
- **WHEN** 当前查询无结果或材料缺失
- **THEN** 显示明确空态，不以其他项目的数据替代

### Requirement: 取消与返回
系统 MUST 允许用户取消未提交操作并保留原查看位置。

#### Scenario: 取消操作
- **WHEN** 用户取消弹窗或返回已有会话
- **THEN** 不改变需求状态，不触发实际执行` }))];
}
export function developmentMaterials(projectId: string, irId: string, srId: string, title: string, round = 1): AIReqMaterialView[] {
  const sections: Record<Exclude<AIReqStageMaterial["kind"], "solution">, string> = {
    plan: `## 工作分解\n| 步骤 | 内容 | 状态 |\n| --- | --- | --- |\n| 1 | 核对「${title}」的边界与验收标准 | 已整理 |\n| 2 | 实现主流程及错误恢复 | 进行中 |\n| 3 | 补充验证证据并复查 | 待处理 |\n\n## 验证范围\n主流程、权限边界、失败恢复及与关联模块的交互。\n\n## 依赖与交付\n依赖项满足后继续实施，交付时核对开发分支与默认分支的差异。`,
    completion: `## 变更范围\n围绕「${title}」核对实现、配置及关联接口。\n\n## 待确认事项\n- 核对当前开发分支的修改范围。\n- 补齐异常路径与回归验证证据。\n- 合入前检查需求和方案的一致性。`,
    ut: `## 单元验证记录\n| 验证项 | 预期行为 | 状态 |\n| --- | --- | --- |\n| 主流程 | 满足系统需求中的验收条件 | 待验证 |\n| 权限边界 | 无权限时明确提示且不改变数据 | 待验证 |\n| 失败恢复 | 失败后保留当前输入并支持重试 | 待验证 |\n\n运行结果、耗时与覆盖率待执行后补充。`,
    st: `## 系统验证范围\n1. 在当前项目与 Release 下打开对应需求。\n2. 核对主流程、异常状态和关联模块。\n3. 检查切换上下文后材料和操作是否一致。\n\n## 验证状态\n待补充执行记录与验收结果。`,
    delivery: `## 交付信息\nRelease：release-2026-11\nSR：${srId}\n\n## 合入检查\n- 需求与方案文档保持一致。\n- 代码修改和验证证据覆盖完成标准。\n- 核对开发分支、默认分支及 PR 状态。\n\n## 后续跟踪\n记录遗留事项和回滚条件，合入后继续检查发布及验收状态。`,
  };
  return (Object.keys(stageByKind) as Exclude<AIReqStageMaterial["kind"], "solution">[]).map(kind => prototypeMaterial({
    projectId, irId, srId, kind, stage: stageByKind[kind], round, path: `development/${irId}/${srId}/round-${round}/${kind}.md`,
    content: `# ${title} · ${MATERIAL_KIND_LABELS[kind]}\n\n${sections[kind]}`,
  }));
}
