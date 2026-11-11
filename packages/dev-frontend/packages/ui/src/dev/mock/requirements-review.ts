import { requirementsReviewInputs } from "../domain.js";
import { readPrototypeAgentModelBinding } from "./agent-models.js";
import type { DevRequirementGroup, DevReview } from "../types.js";
import initialReport from "./requirements-review-open.md?raw";
import approvedReport from "./requirements-review-approved.md?raw";
import updatedReport from "./requirements-review-updated.md?raw";


/** 静态评审演示；只返回投影数据，状态仍由共享 workflow action 写入。 */
export function createPrototypeRequirementsReview(group: DevRequirementGroup, employeeId: string, seedPassed = false): DevReview {
 const supplemented = seedPassed || Boolean(group.requirementSupplements?.some(item => item.round === (group.proposalRound ?? 1)));
 const round = group.proposalRound ?? 1;
 return {
  id: `sample-requirements-review:${group.projectId}:${group.id}:${round}:${group.revision}`,
  snapshotDigest: group.snapshot?.digest ?? "sample-missing-snapshot",
  inputFiles: structuredClone(requirementsReviewInputs(group) ?? []),
  passed: supplemented,
  modelConfig: readPrototypeAgentModelBinding("requirements-review"),
  report: seedPassed ? approvedReport : supplemented ? updatedReport : initialReport,
  requestedBy: employeeId,
  round,
  findings: supplemented ? [] : [{
   id: "sample-missing-exception-behavior",
   level: "blocking",
   message: "补充关键异常场景的触发条件、可观察结果和恢复行为。",
   documentPath: group.snapshot?.srs[0]?.documentPath ?? group.documentPath,
  }, {
   id: "sample-capability-coverage",
   level: "suggestion",
   message: "核对 Capabilities 与各能力 Requirement／Scenario 的覆盖关系。",
   documentPath: group.documentPath,
  }],
  reviewer: {
   projectId: group.projectId,
   irId: group.id,
   sessionId: `sample-requirements-reviewer:${group.id}:${round}:${group.revision}`,
   sessionFile: `/demo/sessions/requirements-review-${group.id}-${round}-${group.revision}.jsonl`,
   role: "reviewer",
   phase: "requirements",
   modelConfig: readPrototypeAgentModelBinding("requirements-review"),
   round,
  },
  createdAt: new Date().toISOString(),
 };
}
