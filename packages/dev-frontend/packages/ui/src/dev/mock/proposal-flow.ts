import type { DevRequirementGroup, DevMaterialView, DevSrSolutionAnalysis, DevSystemRequirement } from "../types.js";
import { parallelSrIds, readSrDependencies } from "../sr-dependencies.js";
import { prototypeMaterial } from "./materials.js";
import { prototypeChangeRoot } from "./proposal-storage.js";
import solution from "./proposal-solution.md?raw";

/** Fixture inputs seed the JSON once; every dependency consumer reads that material. */
export function prototypeProposalDependencies(group: DevRequirementGroup, rows: DevSystemRequirement[]): DevMaterialView {
 return prototypeMaterial({ projectId: group.projectId, irId: group.id, kind: "solution", stage: "solution", round: group.proposalRound ?? 1, path: `${prototypeChangeRoot(group.id)}/sr-dependencies.json`, content: JSON.stringify({ srs: group.srIds.map(srId => ({ srId, prerequisites: (rows.find(row => row.id === srId)?.dependencySrIds ?? []).map(id => ({ srId: id, reason: "需要先稳定前置 SR 提供的业务结果与接口约定，再实现当前能力。" })) })) }, null, 2) });
}

export function prototypeProposalSolution(group: DevRequirementGroup): DevMaterialView {
 const name = (id: string) => `${id} · ${group.snapshot?.srs.find(sr => sr.id === id)?.title ?? id}`;
 return prototypeMaterial({ projectId: group.projectId, irId: group.id, kind: "solution", stage: "solution", round: group.proposalRound ?? 1, path: `${prototypeChangeRoot(group.id)}/design.md`, content: `# ${group.title} · 技术设计 · design.md\n\n${solution}\n\n## SR 实现思路（样例）\n${group.srIds.map(id => {
  const analysis = prototypeSrSolutionAnalysis(group, id);
  return `### ${name(id)}\n\n实现思路：${analysis.approach}\n\n待确认事项：${analysis.uncertainties.join("；")}`;
 }).join("\n\n")}\n\n## 依赖权威与开发安排\n\n前置依赖与原因仅见同目录 [sr-dependencies.json](./sr-dependencies.json)，可并行关系由该依赖图推导，本文件不重复清单。两个方案产物同轮生成、失效、逐文件确认并随同一提案 PR 评审。人员分配与计划开始、结束时间属于数据库元数据，不写入方案文件；排期调整不改变依赖。原型材料仅保存在页面内存，不写入真实文件。` });
}

export function prototypeSrSolutionAnalysis(group: DevRequirementGroup, srId: string): DevSrSolutionAnalysis {
 const result = readSrDependencies(group);
 const title = group.snapshot?.srs.find(sr => sr.id === srId)?.title ?? srId;
 const prerequisites = result.document?.srs.find(row => row.srId === srId)?.prerequisites ?? [];
 return {
  approach: srId === "proposal-sr-resource-booking" ? "复用现有资源查询与预约接口，在提交前校验时段冲突，并统一展示冲突与失败反馈。" : srId === "proposal-sr-booking-notification" ? "订阅预约成功与取消结果，复用通知通道展示状态；对重复事件去重，并保留投递失败反馈。" : `围绕「${title}」复用既有模块，按验收条件补齐正常、异常与恢复路径；接口和数据边界以项目代码核对结果为准。`,
  dependencyReason: result.issue ?? (prerequisites.map(item => `${item.srId}：${item.reason}`).join("；") || "sr-dependencies.json 记录无前置依赖，可独立安排。"),
  parallelSrIds: parallelSrIds(group, srId),
  uncertainties: [...(result.issue ? [result.issue] : []), "以上为方案分析样例，未读取真实项目代码；接口复用与跨 SR 修改冲突待人工核对"],
 };
}
