import type { AIReqProgressAnalysis, AIReqWorkflowView } from "../types.js";
import { getEmployeeId, isEmployeeId } from "../identity.js";
import { getPrototypeWorkflow, prototypeWorkflowChanges } from "./workflow.js";

const samples: Record<string, { percent: number; merged?: boolean; certain?: boolean }> = {
  "sr-auth": { percent: 72 }, "sr-session": { percent: 99, certain: true },
  "sr-permissions": { percent: 35 }, "sr-onboarding": { percent: 100, merged: true, certain: true },
  "sr-export": { percent: 94, merged: true },
  "sr-notification-inbox": { percent: 100, merged: true, certain: true },
  "sr-audit-retention": { percent: 100, merged: true, certain: true },
  "sr-mobile-navigation": { percent: 60 }, "sr-mobile-notifications": { percent: 40 },
  "sr-mobile-profile": { percent: 100, merged: true, certain: true },
};
const owners = new Map<string, string>([["demo-aurora:ir-auth", "j00808875"], ["demo-aurora:ir-notifications", "j00808876"], ["demo-mobile:ir-mobile", "j00808875"]]);
const reports = new Map<string, AIReqProgressAnalysis>();

/** 固定的代码证据样例；不调用模型，不查询远程仓库，不推断真实开发结果。 */
export function withPrototypeProgress(view: AIReqWorkflowView): AIReqWorkflowView {
  const formal = new Set(view.groups.map(group => group.id));
  return {
    ...view,
    groups: view.groups.map(group => ({ ...group, ownerEmployeeId: owners.get(`${group.projectId}:${group.id}`) })),
    drafts: view.drafts.map(group => ({ ...group, ownerEmployeeId: undefined })),
    srs: view.srs.map(sr => {
      if (!formal.has(sr.irId)) return sr;
      const key = `${sr.projectId}:${sr.id}`;
      let progress = reports.get(key);
      if (!progress) {
        const sample = samples[sr.id];
        if (!sample) return sr;
        const analysedAt = "2026-11-11T01:30:00.000Z";
        progress = {
          percent: sample.percent, merged: sample.merged ?? false, certain: sample.certain ?? false,
          branch: sr.trackingBranch?.name ?? `sr/${sr.id}`, analysedAt, codeVersion: `sample-${sr.id}-head`, defaultVersion: "sample-main-20261111",
          implemented: sample.percent > 0 ? [`${sr.title}：样例差异已覆盖主要处理路径。`] : [],
          remaining: sample.percent === 100 || sample.certain ? [] : sample.percent === 0 ? ["尚无独立开发提交，等待开发者推送指定 SR 分支。"] : ["异常路径及部分验收行为仍缺少充分代码或测试证据。"],
          issues: sample.percent === 100 ? [] : sample.percent === 0 ? [{ title: "尚未开始开发", detail: "当前没有可用于判断实现的新增提交证据。" }] : sample.certain ? [{ title: "等待合入默认分支", detail: "分支实现的样例审查已通过；尚未合入，进度最高 99%。" }] : [{ title: "验收证据待补充", detail: "需关注失败恢复和边界行为；当前证据不足以确认全部完成。" }],
          activity: sample.percent > 0 ? [{ commit: `sample-${sr.id}-head`, message: `${sr.title}：最新代码活动（样例）`, at: "2026-11-11T01:00:00.000Z" }] : [],
        };
        reports.set(key, progress);
      }
      return { ...sr, progress: structuredClone(progress) };
    }),
  };
}
export async function assignPrototypeIrOwner(projectId: string, irId: string, employeeId: string): Promise<void> {
  if (!getPrototypeWorkflow({ projectId }).groups.some(group => group.projectId === projectId && group.id === irId)) throw new Error("提案不设置负责人；转为正式需求后再分配。");
  if (getEmployeeId() !== "j00808874") throw new Error("只有管理员可分配需求负责人。");
  if (!isEmployeeId(employeeId)) throw new Error("工号须为一个小写字母后接 8 位数字。");
  const view = getPrototypeWorkflow({ projectId });
  if (![...view.groups, ...view.drafts].some(group => group.id === irId)) throw new Error("IR 不存在。");
  owners.set(`${projectId}:${irId}`, employeeId);
  prototypeWorkflowChanges.fire();
}
export async function updatePrototypeSrProgress(projectId: string, irId: string, srId: string, percent: number, reason: string): Promise<void> {
  const view = withPrototypeProgress(getPrototypeWorkflow({ projectId }));
  const group = view.groups.find(item => item.id === irId);
  const sr = view.srs.find(item => item.id === srId && item.irId === irId);
  const employeeId = getEmployeeId();
  if (employeeId !== "j00808874" && (!group?.ownerEmployeeId || employeeId !== group.ownerEmployeeId)) throw new Error("只有管理员或该 IR 负责人可以调整进度。");
  if (!sr?.progress) throw new Error("SR 分析记录不存在。");
  if (!Number.isInteger(percent) || percent < 0 || percent > (sr.progress.merged ? 100 : 99)) throw new Error(sr.progress.merged ? "进度须为 0～100 的整数。" : "尚未合入默认分支，最高只能设为 99%，不能确认完成。");
  if (!reason.trim()) throw new Error("请填写人工判断依据。");
  reports.set(`${projectId}:${srId}`, { ...sr.progress, percent, manual: { employeeId, reason: reason.trim(), at: new Date().toISOString() } });
  prototypeWorkflowChanges.fire();
}
