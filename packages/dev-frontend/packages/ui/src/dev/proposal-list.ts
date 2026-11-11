import { proposalProgressIndex } from "./domain.js";
import type { DevOperationReceipt, DevRequirementGroup } from "./types.js";

export const PROPOSAL_PHASE_OPTIONS = [
 { id: "all", title: "全部阶段" },
 { id: "0", title: "业务需求" },
 { id: "1", title: "需求评审" },
 { id: "2", title: "技术方案" },
 { id: "3", title: "需求入库" },
];

/** Current presentation phase, independent of the selected historical discussion. */
export function proposalPhaseLabel(group: DevRequirementGroup): string {
 return PROPOSAL_PHASE_OPTIONS[proposalProgressIndex(group) + 1]!.title;
}

export function proposalProcessingHint(group: DevRequirementGroup): string {
 const phase = proposalProgressIndex(group);
 if (phase === 3) return "入库中";
 if (phase === 1) return group.review?.humanDecision ? "已人工通过" : "待人工判断";
 if (group.returnFeedback && !group.returnFeedback.resumedAt) return "待业务补充";
 if (phase === 2) return group.status === "solution-ready" ? "待入库" : "方案中";
 return "业务需求";
}

export function proposalCreatedTime(group: DevRequirementGroup): number {
 return Date.parse(group.createdAt) || 0;
}

/** Only recorded workflow facts contribute; viewing a proposal never updates its order. */
export function proposalUpdatedTime(group: DevRequirementGroup, operations: DevOperationReceipt[]): number {
 let latest = proposalCreatedTime(group);
 const include = (value?: string) => {
  if (value) latest = Math.max(latest, Date.parse(value) || 0);
 };
 include(group.developerHandoff?.submittedAt);
 include(group.developerAcceptance?.acceptedAt);
 include(group.review?.createdAt);
 for (const review of group.reviewHistory ?? []) include(review.createdAt);
 for (const decision of group.requirementsDecisions ?? []) {
  include(decision.createdAt);
  include(decision.review.createdAt);
 }
 for (const supplement of group.requirementSupplements ?? []) include(supplement.createdAt);
 include(group.returnFeedback?.returnedAt);
 include(group.returnFeedback?.resumedAt);
 for (const feedback of group.returnFeedbackHistory ?? []) {
  include(feedback.returnedAt);
  include(feedback.resumedAt);
 }
 include(group.proposalSolution?.generatedAt);
 include(group.confirmation?.confirmedAt);
 include(group.proposalDelivery?.confirmedAt);
 include(group.proposalDelivery?.pushedAt);
 for (const delivery of group.proposalDeliveryHistory ?? []) {
  include(delivery.confirmedAt);
  include(delivery.pushedAt);
 }
 include(group.requirementsPr?.recordedAt);
 include(group.merge?.checkedAt);
 for (const revision of group.proposalRevisions ?? []) {
  include(revision.startedAt);
  include(revision.completedAt);
  include(revision.merge.checkedAt);
  include(revision.requirementsPr?.recordedAt);
  include(revision.delivery?.confirmedAt);
  include(revision.delivery?.pushedAt);
  include(revision.review?.createdAt);
 }
 for (const operation of operations) {
  if (operation.irId !== group.id) continue;
  include(operation.startedAt);
  include(operation.completedAt);
  for (const step of operation.steps) include(step.at);
 }
 return latest;
}
