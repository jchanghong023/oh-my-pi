import { prototypeSrMergeVerified } from "./sr-delivery.js";
import { prototypeRequirementConfirmationIssue, prototypeRequirementFreezeIssue } from "./requirement-freeze.js";
import { readPrototypeDevelopmentRoot } from "./project-settings.js";
import { hasCurrentProposalSolution } from "./proposal-flow.js";
import type { DevRequirementGroup, DevRepositoryDevelopment, DevSystemRequirement, DevWorkflowView } from "./types.js";

export const PROTOTYPE_SR_PARALLEL_LIMIT = 2;
/** 按登记的仓库身份计算内存投影，不按查看工号或当前 Release 发放名额。 */
export function prototypeRepositoryDevelopment(view: DevWorkflowView, projectId: string): DevRepositoryDevelopment {
  const repositoryId = view.projects.find(project => project.id === projectId)?.repositoryId;
  const projectIds = new Set(view.projects.filter(project => repositoryId && project.repositoryId === repositoryId).map(project => project.id));
  const activeSrs = view.srs.filter(sr => projectIds.has(sr.projectId) && sr.status === "developing");
  const owners = view.groups.filter(group => projectIds.has(group.projectId) && group.acceptance?.status !== "completed" && (group.developmentStartedAt || activeSrs.some(sr => sr.projectId === group.projectId && sr.irId === group.id) || group.acceptance));
  return { repositoryId: repositoryId ?? "", limit: PROTOTYPE_SR_PARALLEL_LIMIT, activeSrs, owners: owners.map(group => ({ projectId: group.projectId, irId: group.id, title: group.title })) };
}

function dependencyGraphIssue(view: DevWorkflowView, group: DevRequirementGroup): string | undefined {
  const rows = view.srs.filter(sr => sr.projectId === group.projectId && sr.irId === group.id);
  const byId = new Map(rows.map(sr => [sr.id, sr]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function inspect(id: string): string | undefined {
    if (visiting.has(id)) return "SR 依赖存在循环，请修正提案方案并重新确认。";
    if (visited.has(id)) return;
    const sr = byId.get(id);
    if (!sr) return "SR 依赖引用了本 IR 之外或不存在的需求，请检查已确认方案。";
    visiting.add(id);
    for (const dependency of sr.dependencySrIds ?? []) { const issue = inspect(dependency); if (issue) return issue; }
    visiting.delete(id); visited.add(id);
  }
  for (const sr of rows) { const issue = inspect(sr.id); if (issue) return issue; }
}

export function prototypeSrStartBlocker(view: DevWorkflowView, group: DevRequirementGroup, sr: DevSystemRequirement): string | undefined {
  if (sr.status !== "pending") return "此 SR 已开始或完成，请继续原会话。";
  if (group.revising) return "正式提案正在修订；重新评审、确认并通过提案 PR 合并核验前禁止开发。";
  if (!view.groups.some(item => item.id === group.id && item.projectId === group.projectId) || !group.merge || !hasCurrentProposalSolution(group)) return "提案及确认方案尚未合并核验，不能开始开发。";
  const versionIssue = prototypeRequirementConfirmationIssue(group) ?? prototypeRequirementFreezeIssue(group);
  if (versionIssue) return versionIssue;
  if (group.acceptance?.status === "completed") return "此 IR 已完成；新的需求请重新提案。";
  if (group.acceptance) return "此 IR 已进入验收收尾，不能重开 SR 开发。";
  const occupancy = view.repositoryDevelopment ?? prototypeRepositoryDevelopment(view, group.projectId);
  const other = occupancy.owners.find(owner => owner.projectId !== group.projectId || owner.irId !== group.id);
  if (other) return `同仓库当前由「${other.title}」占用，最终验收与归档 PR 合并核验后才能开始另一个 IR。`;
  const graphIssue = dependencyGraphIssue(view, group);
  if (graphIssue) return graphIssue;
  const unresolved = (sr.dependencySrIds ?? []).map(id => view.srs.find(item => item.id === id && item.irId === group.id && item.projectId === group.projectId)).filter(item => !item || !prototypeSrMergeVerified(item, view.projects.find(project => project.id === item.projectId)?.defaultBranch));
  if (unresolved.length) return `等待前置 SR 合并并核验：${unresolved.map(item => item?.title ?? "缺失的 SR").join("、")}`;
  if (occupancy.activeSrs.length >= occupancy.limit) return `仓库并行名额已满（${occupancy.activeSrs.length}/${occupancy.limit}）；等待评审或合并的 SR 仍占用名额。`;
  if (!readPrototypeDevelopmentRoot(group.projectId)) return "请先在设置 → Dev 项目与 Release 中添加我的开发项目。";
}
