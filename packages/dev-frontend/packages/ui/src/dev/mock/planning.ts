import type { DevSrPlanning, DevSrPlanningInput, DevWorkflowView } from "../types.js";
import { getEmployeeId, isEmployeeId } from "../identity.js";
import { getPrototypeWorkflow, prototypeWorkflowChanges } from "./workflow.js";
import { withPrototypeProgress } from "./progress.js";
import { hasCurrentProposalSolution } from "../domain.js";
import { prototypeSrSolutionAnalysis } from "./proposal-flow.js";

const manualPlans = new Map<string, DevSrPlanning>();
const samples: Record<string, DevSrPlanningInput> = {
  "sr-auth": { developerEmployeeId: "j00808875", plannedStart: "2026-11-11T09:00", plannedEnd: "2026-11-13T18:00" },
  "sr-session": { developerEmployeeId: "j00808876", plannedStart: "2026-11-11T09:00", plannedEnd: "2026-11-12T18:00" },
  "sr-permissions": { developerEmployeeId: "j00808875", plannedStart: "2026-11-16T09:00", plannedEnd: "2026-11-17T18:00" },
  "sr-audit": { plannedStart: "2026-11-18T09:00", plannedEnd: "2026-11-20T18:00" },
  "sr-onboarding": { developerEmployeeId: "j00808877", plannedStart: "2026-11-09T09:00", plannedEnd: "2026-11-10T18:00" },
  "proposal-sr-resource-booking": { plannedStart: "2026-11-16T09:00", plannedEnd: "2026-11-18T18:00" },
  "proposal-sr-booking-notification": { plannedStart: "2026-11-19T09:00", plannedEnd: "2026-11-20T18:00" },
};

/** 固定建议夹具，不调用 AI 或接入人员日历。人员与时间不写入需求文档。 */
export function withPrototypePlanning(view: DevWorkflowView): DevWorkflowView {
  const eligible = [...view.groups, ...view.drafts.filter(hasCurrentProposalSolution)];
  return { ...view, srs: view.srs.map(sr => {
    const group = eligible.find(item => item.id === sr.irId && item.projectId === sr.projectId);
    if (!group) return sr;
    const suggestion = samples[sr.id] ?? { plannedStart: "2026-11-16T09:00", plannedEnd: "2026-11-18T18:00" };
    const saved = manualPlans.get(`${sr.projectId}:${sr.irId}:${sr.id}`);
    return { ...sr, solutionAnalysis: prototypeSrSolutionAnalysis(group, sr.id), planning: structuredClone(saved ?? { ...suggestion, suggestion, source: "ai", assumptions: "AI 建议样例：项目时区 Asia/Shanghai；计划起点为 2026-11-16 09:00（已有正式需求沿用历史样例）。依赖顺序仅作建议，未接入真实人员日历、请假或其他项目占用；未分配人员需人工确认，不代表已确认可用。" }) };
  }) };
}

export async function updatePrototypeSrPlanning(projectId: string, irId: string, srId: string, input: DevSrPlanningInput): Promise<void> {
  const view = withPrototypePlanning(withPrototypeProgress(getPrototypeWorkflow({ projectId })));
  const group = [...view.groups, ...view.drafts].find(item => item.id === irId);
  const sr = view.srs.find(item => item.id === srId && item.irId === irId);
  const actor = getEmployeeId();
  if (!group || !sr?.planning) throw new Error("SR 排期不存在，请先完成当前版本的方案分析。");
  if (view.drafts.some(item => item.id === irId) && !hasCurrentProposalSolution(group)) throw new Error("当前方案已失效，请完成本轮方案后再调整排期。");
  if (actor !== "j00808874" && actor !== group.ownerEmployeeId) throw new Error("只有管理员或 IR 负责人可调整开发安排。");
  if (input.developerEmployeeId && !isEmployeeId(input.developerEmployeeId)) throw new Error("开发人员工号须为一个小写字母后接 8 位数字。");
  for (const value of [input.plannedStart, input.plannedEnd]) {
    if (value && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}+08:00`)))) throw new Error("请填写有效的计划日期和时间。");
  }
  if (Boolean(input.plannedStart) !== Boolean(input.plannedEnd)) throw new Error("请同时填写开始和结束时间，或同时清空以取消排期。");
  if (input.plannedStart && input.plannedEnd && input.plannedEnd <= input.plannedStart) throw new Error("计划结束时间必须晚于开始时间。");
  // 依赖只读，调整排期不得改写 Git 文档或依赖事实；冲突由界面持续提示。
  manualPlans.set(`${projectId}:${irId}:${srId}`, { ...sr.planning, ...input, source: "manual", updatedBy: actor, updatedAt: new Date().toISOString() });
  prototypeWorkflowChanges.fire();
}
