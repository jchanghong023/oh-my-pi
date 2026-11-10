import { prototypeChangeRoot, prototypeSpecPath, prototypeCapabilityName } from "./proposal-storage.js";
import type { DevMaterialView, DevStageMaterial, DevWorkflowStage } from "./types.js";

const disclaimer = "> 阶段性前端原型 · 以下全部为可纳入 Git 的样例数据，不代表代码执行、测试通过、审核或交付验收。后续经确认再对接真实 OMP。";
const stageByKind: Record<DevStageMaterial["kind"], DevWorkflowStage> = {
  plan: "planning", completion: "executing", ut: "executing", st: "executing", delivery: "pr",
};
export const MATERIAL_KIND_LABELS = {
  "sr-delivery-package": "SR 交付清单与 PR 信息",
  "ir-acceptance-report": "IR 验收报告", "ir-final-pr": "最终 PR 信息",
  ir: "业务需求 IR", sr: "系统需求 SR", solution: "提案方案", plan: "开发计划",
  completion: "开发完成报告", ut: "单元测试 UT", st: "系统测试 ST", delivery: "交付说明", attachment: "参考资料",
};
export function prototypeMaterial(input: Omit<DevMaterialView, "sha256" | "size" | "valid">): DevMaterialView {
  const content = input.content ?? "";
  return { ...input, sha256: `sample:${input.path}`, size: new TextEncoder().encode(content).length, valid: true };
}
export function requirementMaterials(projectId: string, irId: string, title: string, rows: { id: string; title: string }[]): DevMaterialView[] {
  return [prototypeMaterial({ projectId, irId, kind: "ir", path: `${prototypeChangeRoot(irId)}/proposal.md`, content: `# ${title}

${disclaimer}

## Why
团队需要清晰的需求讨论、可验证的行为与材料归属，减少跨页面寻找上下文。

## What Changes
${rows.map(row => `- ${row.title}：详见 specs/${prototypeCapabilityName(row.id)}/spec.md。`).join("\n")}

## Capabilities

### New Capabilities
${rows.map(row => `- ${prototypeCapabilityName(row.id)}: ${row.title}`).join("\n")}

### Modified Capabilities
无。

## Impact
当前项目 ${projectId} 的相关界面与会话能力。提案阶段先在共享临时工作区整理本 change；需求 PR 合并核对后才成为正式需求。仅内存演示，不写入项目。` }),
  ...rows.map(row => prototypeMaterial({ projectId, irId, srId: row.id, kind: "sr", path: prototypeSpecPath(irId, row.id), content: `# ${row.title}

${disclaimer}

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
export function developmentMaterials(projectId: string, irId: string, srId: string, title: string, round = 1): DevMaterialView[] {
  const sections: Record<DevStageMaterial["kind"], string> = {
    plan: `## 工作分解\n| 步骤 | 内容 | 演示负责人 | 展示状态 |\n| --- | --- | --- | --- |\n| 1 | 明确需求边界与导航层级 | 林悦 / 产品 | 样例已整理 |\n| 2 | 复用原界面并补全样例资料 | 陈明 / 前端 | 样例进行中 |\n| 3 | 交互走查与反馈整理 | 周宁 / 体验 | 样例待走查 |\n\n## 交互走查清单\n项目切换、Release 切换、提案选择、三阶段开发材料、复制下载、取消弹窗与带入讨论。\n\n## 后续阶段\n用户确认前端后再实施真实 OMP 接口与端到端验收；本文件不表示这些任务已经实施。`,
    completion: `## 样例变更摘要\n展示需求与阶段导航、只读资料、协作示例和本地设置。\n\n## 样例文件清单\n- ui/navigation/requirement-tree.tsx\n- ui/materials/material-pane.tsx\n- ui/session/discussion.tsx\n\n## 未执行事项\n未调用模型，未操作 Git，未运行构建、UT 或 ST，未提交真实 PR。\n\n## 真实完成判据\n需以后续阶段的实际代码审查、运行记录和用户验收为准。`,
    ut: `## UT 报告展示样例（未执行）\n| 用例 | 预期行为 | 样例展示 |\n| --- | --- | --- |\n| UT-01 | 切换项目只展示对应 IR | 通过（示例值） |\n| UT-02 | 复制材料保持正文完整 | 通过（示例值） |\n| UT-03 | 取消对话框不改变选择 | 通过（示例值） |\n| UT-04 | 带入讨论不自动发送 | 待真实验证 |\n\n运行命令：未执行。耗时与覆盖率：未采集。以上不是测试结果。`,
    st: `## ST 场景展示样例（未执行）\n1. 打开 Aurora 项目，选择 2026.11 Release。\n2. 从账号与权限 IR 进入不同阶段 SR。\n3. 在右侧阅读方案、计划与验证报告，返回需求对话。\n4. 选择移动端项目，检查列表与资料上下文。\n\n## 预期体验\n保留现有界面结构，导航与正文一致，操作可以取消，无真实网络或模型请求。\n\n## 验证状态\n这里仅提供报告排版和场景样例，尚未运行系统测试，不能据此宣称验收通过。`,
    delivery: `## 交付展示样例\nRelease：release-2026-11\nSR：${srId}\n\n## 交付内容\n阶段性前端原型界面与独立样例数据，用于跨机器走查 UI/UX。\n\n## PR 信息\n示例 PR 链接和分支仅用于展示，不代表存在真实远端提交或合入。\n\n## 使用与反馈\n刷新后恢复初始样例。记录导航、文案、布局和材料体验反馈。\n\n## 下一阶段\n用户确认后对接真实 OMP，既有业务目标和真实验收标准不取消。`,
  };
  return (Object.keys(stageByKind) as DevStageMaterial["kind"][]).map(kind => prototypeMaterial({
    projectId, irId, srId, kind, stage: stageByKind[kind], round, path: `development/${irId}/${srId}/round-${round}/${kind}.md`,
    content: `# ${title} · ${MATERIAL_KIND_LABELS[kind]}\n\n${disclaimer}\n\n${sections[kind]}`,
  }));
}
