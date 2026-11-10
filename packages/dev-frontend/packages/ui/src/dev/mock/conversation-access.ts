import { irAcceptanceVersionBlocker } from "./ir-acceptance.js";
import { prototypeStageView } from "./stage-gates.js";
import type { DevSelection, DevWorkflowView } from "./types.js";
import { getPrototypeEmployeeId } from "./employee.js";

/** 原型协作归属提示；输入工号不构成真实身份或权限校验。 */
export function prototypeConversationReadOnlyReason(view: DevWorkflowView | undefined, selection: DevSelection): string | undefined {
 if (!view || selection.freeSessionId) return;
 const proposal = view.drafts.find(item => item.id === selection.irId);
 if (proposal) {
  const phase = proposal.proposalStage ?? "requirements";
  if (selection.discussionPhase && selection.discussionPhase !== phase) return "正在查看另一讨论阶段的历史，只读。";
  if (proposal.status === "requirements-pr") return "需求 PR 已提交，当前版本只读；合并核对后进入正式需求。";
  if (phase === "solution") {
   const acceptance = proposal.developerAcceptance;
   if (!acceptance || acceptance.round !== (proposal.proposalRound ?? 1)) return "请先接手评审，再继续方案讨论。";
   if (acceptance.employeeId !== getPrototypeEmployeeId()) return `方案由 ${acceptance.employeeId} 接手，当前仅查看。`;
  }
  return;
 }
 if (selection.irAcceptance) {
  const acceptance = view.groups.find(item => item.id === selection.irId)?.acceptance;
  if (!acceptance) return "请先明确开始 IR 验收。";
  if (acceptance.status === "completed") return "IR 已完成，验收会话仅供只读查看。";
  if (acceptance.employeeId !== getPrototypeEmployeeId()) return `IR 验收由 ${acceptance.employeeId} 负责，当前仅查看。`;
  const group = view.groups.find(item => item.id === selection.irId)!;
  const versionIssue = irAcceptanceVersionBlocker(view, group);
  if (versionIssue) return versionIssue;
  if (acceptance.status === "pr-ready" || acceptance.status === "pr-submitted") return "最终候选已确认，当前只读；等待人工 PR 合并及结果核验。";
  return;
 }
 const formal = view.groups.find(item => item.id === selection.irId && item.projectId === selection.projectId);
 if (formal && !selection.srId) return formal.freeze ? "需求与方案已在首个 SR 开始时冻结；当前仅查看，变化须重新提案。" : "正式提案已入库但尚未冻结，当前材料与讨论仅供查看；开发前的修订仍须重新评审、确认并通过提案 PR。";
 const sr = view.srs.find(item => item.id === selection.srId && item.irId === selection.irId);
 if (sr?.status === "completed") return "该 SR 已完成，历史会话只读。";
 if (sr?.status === "developing" && sr.developerEmployeeId !== getPrototypeEmployeeId()) return `该 SR 由 ${sr.developerEmployeeId ?? "其他同事"} 开发，当前仅查看。`;
 if (sr?.status === "developing" && !prototypeStageView(sr, selection).isCurrent) return "当前查看的是历史或尚未开始的阶段，只读；返回当前阶段继续处理。";
}
