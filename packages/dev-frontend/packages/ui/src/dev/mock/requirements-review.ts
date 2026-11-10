import { readPrototypeAgentModelBinding } from "./agent-models.js";
import type { DevFileVersion, DevRequirementGroup, DevReview } from "./types.js";
import initialReport from "./requirements-review-open.md?raw";
import approvedReport from "./requirements-review-approved.md?raw";
import updatedReport from "./requirements-review-updated.md?raw";


/** 业务评审只绑定 proposal 与全部增量 spec，技术 design 的生成不让业务评审过期。 */
export function prototypeRequirementsReviewInputs(group: DevRequirementGroup): DevFileVersion[] | undefined {
 const rows = group.snapshot?.srs ?? [];
 if (!rows.length || rows.length !== group.srIds.length || !group.srIds.every(id => rows.some(sr => sr.id === id))) return;
 const root = group.documentPath.replace(/proposal\.md$/, "");
 const required = new Set([group.documentPath, ...rows.map(sr => sr.documentPath)]);
 const files = group.files.filter(file => file.path === group.documentPath || (file.path.startsWith(`${root}specs/`) && file.path.endsWith("/spec.md")));
 if (files.length !== required.size || new Set(files.map(file => file.path)).size !== required.size || !files.every(file => required.has(file.path))) return;
 return files.map(({ path, sha256, size }) => ({ path, sha256, size })).sort((a, b) => a.path.localeCompare(b.path));
}
export function prototypeRequirementsReviewCurrent(group: DevRequirementGroup): boolean {
 const review = group.review;
 const files = prototypeRequirementsReviewInputs(group);
 if (!review || !files || !review.inputFiles || review.snapshotDigest !== group.snapshot?.digest || review.round !== (group.proposalRound ?? 1)) return false;
 const recorded = [...review.inputFiles].sort((a, b) => a.path.localeCompare(b.path));
 return files.length === recorded.length && files.every((file, index) => file.path === recorded[index]?.path && file.sha256 === recorded[index]?.sha256 && file.size === recorded[index]?.size);
}
export function prototypeRequirementsReviewBlocker(group: DevRequirementGroup): string | undefined {
 if (!prototypeRequirementsReviewInputs(group)) return "请先补齐 IR 与至少一个 SR 的需求材料，再发起业务需求评审。";
 if (!group.review) return "尚未完成业务需求评审，请先检查当前需求版本。";
 if (!prototypeRequirementsReviewCurrent(group)) return "需求版本已变化，旧评审已失效，请重新评审。";
 if (!group.review.passed || group.review.findings?.some(item => item.level === "blocking")) return "业务需求评审未通过，请补充阻断问题并重新评审；业务争议交人工处理。";
}

/** 静态评审演示；只返回投影数据，状态仍由共享 workflow action 写入。 */
export function createPrototypeRequirementsReview(group: DevRequirementGroup, employeeId: string, seedPassed = false): DevReview {
 const supplemented = seedPassed || Boolean(group.requirementSupplements?.some(item => item.round === (group.proposalRound ?? 1)));
 const round = group.proposalRound ?? 1;
 return {
  id: `sample-requirements-review:${group.projectId}:${group.id}:${round}:${group.revision}`,
  snapshotDigest: group.snapshot?.digest ?? "sample-missing-snapshot",
  inputFiles: structuredClone(prototypeRequirementsReviewInputs(group) ?? []),
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
   sessionId: `sample-requirements-reviewer:${group.id}:${round}`,
   sessionFile: `/demo/sessions/requirements-review-${group.id}.jsonl`,
   role: "reviewer",
   phase: "requirements",
   round,
  },
  createdAt: new Date().toISOString(),
 };
}
