import { readPrototypeAgentPrompts } from "./personalization.js";
import { requirementsReviewInputs } from "../domain.js";
import { readPrototypeAgentModelBinding } from "./agent-models.js";
import type { AIReqAgentModelBinding, AIReqNativeSessionRef, AIReqRequirementGroup, AIReqReview, AIReqReviewAgent, AIReqReviewAgentId } from "../types.js";
import reportA from "./requirements-review-a.md?raw";
import reportB from "./requirements-review-b.md?raw";
import reportC from "./requirements-review-c.md?raw";
import summary from "./requirements-review-summary.md?raw";

export function prototypeReviewModelBindings(): AIReqAgentModelBinding[] {
 const bindings = [readPrototypeAgentModelBinding("requirements-review-a"), readPrototypeAgentModelBinding("requirements-review-b"), readPrototypeAgentModelBinding("requirements-review-c"), readPrototypeAgentModelBinding("requirements-review")];
 if (new Set(bindings.slice(0, 3).map(binding => binding.modelKey)).size !== 3) throw new Error("评审 A、B、C 须配置三个不同模型；综合评审可独立选择模型。请由当前 Web 所有者在模型设置中调整。");
 return bindings;
}
export function prototypeReviewSessions(review: AIReqReview): AIReqNativeSessionRef[] {
 return review.agents?.map(agent => agent.session) ?? ("projectId" in review.reviewer ? [review.reviewer] : []);
}
/** Complete static reports, never model approval. Seeded history records a prior human decision. */
export function createPrototypeRequirementsReview(group: AIReqRequirementGroup, employeeId: string, seedPassed = false): AIReqReview {
 const round = group.proposalRound ?? 1;
 const id = `sample-requirements-review:${group.projectId}:${group.id}:${round}:${group.revision}`;
 const bindings = prototypeReviewModelBindings();
 const prompts = readPrototypeAgentPrompts().saved;
 const keys: AIReqReviewAgentId[] = ["a", "b", "c", "summary"];
 const reports = [reportA, reportB, reportC, summary];
 const agents: AIReqReviewAgent[] = keys.map((key, index) => ({
  id: key, name: key === "summary" ? "综合评审 Agent" : `评审 ${key.toUpperCase()}`, status: "completed", report: reports[index]!, promptSnapshot: prompts[bindings[index]!.role],
  session: { projectId: group.projectId, irId: group.id, sessionId: `sample-requirements-reviewer:${group.id}:${round}:${group.revision}:${key}`, sessionFile: `/demo/sessions/requirements-review-${group.id}-${round}-${group.revision}-${key}.jsonl`, role: "reviewer", phase: "requirements", modelConfig: bindings[index], round },
 }));
 return { id, snapshotDigest: group.snapshot?.digest ?? "sample-missing-snapshot", inputFiles: structuredClone(requirementsReviewInputs(group) ?? []), passed: seedPassed, agents,
  ...(seedPassed ? { humanDecision: { employeeId, decidedAt: new Date().toISOString(), reviewId: id } } : {}),
  modelConfig: bindings[3], report: summary, requestedBy: employeeId, round,
  findings: [{ id: "sample-exception-boundary", level: "suggestion", message: "综合意见保留异常边界建议与模型分歧，是否通过由人判断。", documentPath: group.snapshot?.srs[0]?.documentPath ?? group.documentPath }],
  reviewer: agents[3]!.session, createdAt: new Date().toISOString(),
 };
}
