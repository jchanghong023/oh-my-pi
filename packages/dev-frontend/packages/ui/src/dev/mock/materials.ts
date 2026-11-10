import type { DevMaterialView, DevStageMaterial, DevWorkflowStage } from "./types.js";

const disclaimer = "> 阶段性前端原型 · 以下全部为可纳入 Git 的样例数据，不代表代码执行、测试通过、审核或交付验收。后续经确认再对接真实 OMP。";
const stageByKind: Record<DevStageMaterial["kind"], DevWorkflowStage> = {
  solution: "solution", plan: "planning", completion: "executing", ut: "executing", st: "executing", delivery: "pr",
};
export const MATERIAL_KIND_LABELS = {
  ir: "业务需求 IR", sr: "系统需求 SR", solution: "技术方案", plan: "开发计划",
  completion: "开发完成报告", ut: "单元测试 UT", st: "系统测试 ST", delivery: "交付说明", attachment: "参考资料",
};
export function prototypeMaterial(input: Omit<DevMaterialView, "sha256" | "size" | "valid">): DevMaterialView {
  const content = input.content ?? "";
  return { ...input, sha256: `sample:${input.path}`, size: new TextEncoder().encode(content).length, valid: true };
}
export function requirementMaterials(projectId: string, irId: string, title: string, rows: { id: string; title: string }[]): DevMaterialView[] {
  return [prototypeMaterial({ projectId, irId, kind: "ir", path: `requirements/${irId}/IR.md`, content: `# ${title}\n\n${disclaimer}\n\n## 背景与目标\nAurora 团队希望在统一工作台中完成需求讨论、拆分、阶段切换与只读材料查阅，减少跨页面寻找上下文。\n\n## 用户场景\n1. 产品负责人选择项目与 Release，查看正式 IR 和草稿。\n2. 开发者进入 SR，比较技术方案、开发计划与验证资料。\n3. 评审者复制或下载材料，将引用带入原聊天输入框后手动发送。\n\n## 功能范围\n${rows.map((row, index) => `${index + 1}. ${row.title}（${row.id}）`).join("\n")}\n\n## 交互验收目标（尚未真实验收）\n- 导航、材料与当前项目/IR/SR 归属一致。\n- 阶段选择清晰，历史材料保持只读。\n- 带入讨论只准备未发送草稿，不触发模型。\n\n## 本阶段边界\n仅前端内存演示；刷新页面恢复样例。真实身份、仓库、审批、测试与 OMP 对接留待用户确认后的阶段。` }),
  ...rows.map(row => prototypeMaterial({ projectId, irId, srId: row.id, kind: "sr", path: `requirements/${irId}/${row.id}/SR.md`, content: `# ${row.title}\n\n${disclaimer}\n\n关联 IR：${title}（${irId}）\n\n## 交互需求\n- 展示当前阶段、状态、材料清单与操作历史。\n- 与同一项目的需求讨论保持清楚的上下文边界。\n- 提供空态、长文本、取消和返回操作。\n\n## 示例输入\n项目 ${projectId} / SR ${row.id}，使用团队默认演示设置。\n\n## 预期展示\n需求摘要、只读文档和未发送讨论草稿；不读写任何真实业务数据。\n\n## 后续真实验收\n确认原型后再以实际 OMP 行为、仓库事实与验证报告为准。` }))];
}
export function developmentMaterials(projectId: string, irId: string, srId: string, title: string): DevMaterialView[] {
  const sections: Record<DevStageMaterial["kind"], string> = {
    solution: `## 方案概述\n复用当前复制版 WebGUI 的 Root、导航、右侧标签页与聊天输入框，通过前端样例提供连贯的交互。\n\n## 展示结构\n- 需求导航：项目 → Release → IR → SR。\n- 工作区：当前 SR 对话、阶段按钮和操作记录。\n- 右侧材料：IR、SR、方案、计划、完成报告、UT、ST、交付说明。\n\n## 取舍\n采用小型内存状态而不是业务引擎，不模拟后端审批权威；不创建第二套输入框。\n\n## 风险与边界\n样例状态不证明生产可用性。真实鉴权、网络失败与仓库并发必须在后续对接阶段设计和验收。`,
    plan: `## 工作分解\n| 步骤 | 内容 | 演示负责人 | 展示状态 |\n| --- | --- | --- | --- |\n| 1 | 明确需求边界与导航层级 | 林悦 / 产品 | 样例已整理 |\n| 2 | 复用原界面并补全样例资料 | 陈明 / 前端 | 样例进行中 |\n| 3 | 交互走查与反馈整理 | 周宁 / 体验 | 样例待评审 |\n\n## 交互走查清单\n项目切换、Release 切换、草稿选择、四阶段材料、复制下载、取消弹窗与带入讨论。\n\n## 后续阶段\n用户确认前端后再实施真实 OMP 接口与端到端验收；本文件不表示这些任务已经实施。`,
    completion: `## 样例变更摘要\n展示需求与阶段导航、只读资料、协作示例和本地设置。\n\n## 样例文件清单\n- ui/navigation/requirement-tree.tsx\n- ui/materials/material-pane.tsx\n- ui/session/discussion.tsx\n\n## 未执行事项\n未调用模型，未操作 Git，未运行构建、UT 或 ST，未提交真实 PR。\n\n## 真实完成判据\n需以后续阶段的实际代码审查、运行记录和用户验收为准。`,
    ut: `## UT 报告展示样例（未执行）\n| 用例 | 预期行为 | 样例展示 |\n| --- | --- | --- |\n| UT-01 | 切换项目只展示对应 IR | 通过（示例值） |\n| UT-02 | 复制材料保持正文完整 | 通过（示例值） |\n| UT-03 | 取消对话框不改变选择 | 通过（示例值） |\n| UT-04 | 带入讨论不自动发送 | 待真实验证 |\n\n运行命令：未执行。耗时与覆盖率：未采集。以上不是测试结果。`,
    st: `## ST 场景展示样例（未执行）\n1. 打开 Aurora 项目，选择 2026.11 Release。\n2. 从账号与权限 IR 进入不同阶段 SR。\n3. 在右侧阅读方案、计划与验证报告，返回需求对话。\n4. 选择移动端项目，检查列表与资料上下文。\n\n## 预期体验\n保留现有界面结构，导航与正文一致，操作可以取消，无真实网络或模型请求。\n\n## 验证状态\n这里仅提供报告排版和场景样例，尚未运行系统测试，不能据此宣称验收通过。`,
    delivery: `## 交付展示样例\nRelease：release-2026-11\nSR：${srId}\n\n## 交付内容\n阶段性前端原型界面与独立样例数据，用于跨机器走查 UI/UX。\n\n## PR 信息\n示例 PR 链接和分支仅用于展示，不代表存在真实远端提交或合入。\n\n## 使用与反馈\n刷新后恢复初始样例。记录导航、文案、布局和材料体验反馈。\n\n## 下一阶段\n用户确认后对接真实 OMP，既有业务目标和真实验收标准不取消。`,
  };
  return (Object.keys(stageByKind) as DevStageMaterial["kind"][]).map(kind => prototypeMaterial({
    projectId, irId, srId, kind, stage: stageByKind[kind], path: `development/${irId}/${srId}/${kind}.md`,
    content: `# ${title} · ${MATERIAL_KIND_LABELS[kind]}\n\n${disclaimer}\n\n${sections[kind]}`,
  }));
}
