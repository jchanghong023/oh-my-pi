import { proposalVersion, proposalDeliveryCurrent, hasCurrentProposalSolution, requirementsReviewBlocker } from "../domain.js";
import { proposalDependencyMaterialIssue } from "../sr-dependencies.js";
import { readPrototypeProposalPrHandoff } from "./proposal-pr-handoff.js";
import type { DevAction, DevRequirementGroup, DevWorkflowView } from "../types.js";
import { prototypeProposalDiscussionAllowed } from "./backend.js";

export type PrototypeProposalDeliveryAction = Extract<DevAction, { type: "confirmProposal" | "publishProposal" | "markRequirementsPrSubmitted" | "markRequirementsMerged" }>;

export function isPrototypeProposalDeliveryAction(action: DevAction): action is PrototypeProposalDeliveryAction {
 return ["confirmProposal", "publishProposal", "markRequirementsPrSubmitted", "markRequirementsMerged"].includes(action.type);
}
export function validatePrototypeProposalDeliveryAction(view: DevWorkflowView, group: DevRequirementGroup, action: PrototypeProposalDeliveryAction): void {
 if (!prototypeProposalDiscussionAllowed()) throw new Error("当前 Web 仅支持只读查看提案，请使用团队 Web 进行需求确认与入库操作。");
 const blocker = requirementsReviewBlocker(group);
 if (blocker) throw new Error(blocker);
 const dependencyIssue = proposalDependencyMaterialIssue(group, view.materials);
 if (dependencyIssue) throw new Error(dependencyIssue);
 if (group.proposalStage !== "solution" || !hasCurrentProposalSolution(group)) throw new Error("请先完成当前需求版本的方案。");
 const handoff = readPrototypeProposalPrHandoff(group);
 if (!handoff.ready) throw new Error(handoff.blockers.join("；"));
 if (!group.files.every(file => view.materials.some(material => material.projectId === group.projectId && material.irId === group.id && material.path === file.path && material.sha256 === file.sha256 && material.size === file.size && material.valid && material.content !== undefined && !material.error))) throw new Error("当前提案材料缺失、读取失败或版本不一致，不能确认、推送或核验合并。");
 if (action.type === "confirmProposal") {
  if (group.status !== "solution-ready" || action.version !== proposalVersion(group)) throw new Error("确认页面对应旧版本，请重新查看当前 IR、全部 SR 与方案后确认。");
  return;
 }
 const delivery = group.proposalDelivery;
 if (!delivery || !proposalDeliveryCurrent(group) || action.candidate !== delivery.candidate) throw new Error("提案版本已变化，旧确认、推送与 PR 已失效，请重新确认当前版本。");
 if (action.type === "publishProposal") {
  if (group.status !== "solution-ready") throw new Error("请在登记人工 PR 前演示提交与推送。");
  return;
 }
 if (delivery.pushedCandidate !== action.candidate) throw new Error("请先演示提交并推送当前已确认候选，再登记人工 PR。");
 if (action.type === "markRequirementsPrSubmitted") {
  if (group.status !== "requirements-pr") throw new Error("请先推送提案分支，再记录人工创建的 PR 地址。");
  const url = new URL(action.url);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("请输入有效 PR 地址。");
  return;
 }
 if (group.status !== "requirements-pr" || !group.requirementsPr || delivery.prCandidate !== action.candidate || !action.defaultBranchFilesConfirmed) throw new Error("人工 PR 登记后，须按当前候选和完整文件版本演示核验合并，才能正式入库。");
}
