import type { DevFileVersion, DevMaterialView, DevStageMaterial, DevWorkflowStage, DevRequirementGroup, DevRequirementsDecision, DevRepositoryDevelopment, DevSelection, DevSystemRequirement, DevWorkflowView } from "./types.js";
import { getEmployeeId } from "./identity.js";

/** 业务评审只绑定 proposal 与全部增量 spec，技术 design 的生成不让业务评审过期。 */
export function requirementsReviewInputs(group: DevRequirementGroup): DevFileVersion[] | undefined {
 const rows = group.snapshot?.srs ?? [];
 if (!rows.length || rows.length !== group.srIds.length || !group.srIds.every(id => rows.some(sr => sr.id === id))) return;
 const root = group.documentPath.replace(/proposal\.md$/, "");
 const required = new Set([group.documentPath, ...rows.map(sr => sr.documentPath)]);
 const files = group.files.filter(file => file.path === group.documentPath || (file.path.startsWith(`${root}specs/`) && file.path.endsWith("/spec.md")));
 if (files.length !== required.size || new Set(files.map(file => file.path)).size !== required.size || !files.every(file => required.has(file.path))) return;
 return files.map(({ path, sha256, size }) => ({ path, sha256, size })).sort((a, b) => a.path.localeCompare(b.path));
}
export function requirementsReviewCurrent(group: DevRequirementGroup): boolean {
 const review = group.review;
 const files = requirementsReviewInputs(group);
 if (!review || !files || !review.inputFiles || review.snapshotDigest !== group.snapshot?.digest || review.round !== (group.proposalRound ?? 1)) return false;
 return sameFileVersions(files, review.inputFiles);
}

function sameFileVersions(files: DevFileVersion[], recordedFiles: DevFileVersion[]): boolean {
 const recorded = [...recordedFiles].sort((a, b) => a.path.localeCompare(b.path));
 return files.length === recorded.length && files.every((file, index) => file.path === recorded[index]?.path && file.sha256 === recorded[index]?.sha256 && file.size === recorded[index]?.size);
}

/** 人工处理绑定原始 AI 评审和材料；不是替代 AI 结论的通过凭证。 */
export function requirementsDecisionCurrent(group: DevRequirementGroup, decision: Pick<DevRequirementsDecision, "reviewId" | "snapshotDigest" | "inputFiles">): boolean {
 const files = requirementsReviewInputs(group);
 return Boolean(files && requirementsReviewCurrent(group) && decision.reviewId === group.review?.id
  && decision.snapshotDigest === group.snapshot?.digest && sameFileVersions(files, decision.inputFiles));
}
export function requirementsReviewBlocker(group: DevRequirementGroup): string | undefined {
 const files = requirementsReviewInputs(group);
 if (!files) return "请先补齐 IR 与至少一个 SR 的需求材料，再发起业务需求评审。";
 if (!group.review) return "尚未完成业务需求评审，请先检查当前需求版本。";
 if (!requirementsReviewCurrent(group)) return "需求版本已变化，旧评审已失效，请重新评审。";
 if (!group.review.passed || group.review.findings?.some(item => item.level === "blocking")) return "只读评审报告了问题，可直接向评审 Agent 询问；需要补充时返回业务 Agent 修改需求后重评。";
}

/** Opaque in-memory version, not a real Git commit or content hash. */
export function proposalVersion(group: DevRequirementGroup): string {
 return JSON.stringify({
  round: group.proposalRound ?? 1, digest: group.snapshot?.digest, title: group.title,
  srIds: [...group.srIds].sort(), solution: group.proposalSolution,
  files: [...group.files].sort((a, b) => a.path.localeCompare(b.path)),
 });
}
export function proposalDeliveryCurrent(group: DevRequirementGroup): boolean {
 return Boolean(group.proposalDelivery && hasCurrentProposalSolution(group) && group.proposalDelivery.version === proposalVersion(group));
}

export function proposalRevisionBlocker(view: DevWorkflowView, group: DevRequirementGroup): string | undefined {
 if (!view.groups.some(item => item.id === group.id && item.projectId === group.projectId) || !group.merge || !group.snapshot || group.status !== "formal") return "仅已入库且尚未开发的正式提案可以开始修订。";
 if (group.freeze || group.developmentStartedAt || group.acceptance || view.srs.some(sr => sr.projectId === group.projectId && sr.irId === group.id && sr.status !== "pending")) return "本 IR 已开始开发或冻结，不能修订原需求；业务或方案变化须重新提案。";
}

export const STAGE_MATERIAL_KINDS: Record<DevWorkflowStage, DevStageMaterial["kind"][]> = {
 solution: ["solution"], planning: ["plan"], executing: ["completion", "ut", "st"], pr: ["delivery"],
};
/** Inspect only the supplied material snapshot; this does not execute verification. */
export function stageMaterialBlocker(sr: DevSystemRequirement, materials: DevMaterialView[]): string | undefined {
 if (!sr.stage || !sr.materialDigest) return "尚无当前轮次的阶段材料，请先生成材料。";
 const files = sr.materials.filter(item => item.valid && item.stage === sr.stage && item.round === sr.round);
 if (!STAGE_MATERIAL_KINDS[sr.stage].every(kind => files.some(item => item.kind === kind))) return "当前阶段材料不完整，请先生成本轮材料。";
 if (files.some(file => !materials.some(item => item.projectId === sr.projectId && item.irId === sr.irId && item.srId === sr.id && item.path === file.path && item.valid && !item.error && item.content !== undefined && item.sha256 === file.sha256 && item.size === file.size))) return "材料版本已变化，请重新生成并确认本轮材料。";
}

export function deriveStageView(sr: DevSystemRequirement, selection: DevSelection) {
 const stage = selection.stage ?? sr.stage;
 const round = selection.stageRound ?? (stage === sr.stage ? sr.round : Math.max(0, ...sr.sessions.filter(item => item.phase === stage).map(item => item.round)));
 return { stage, round, isCurrent: sr.status === "developing" && stage === sr.stage && round === sr.round };
}

export const PROPOSAL_STATUS_LABELS = { draft: "草稿", "solution-ready": "方案完成", "requirements-pr": "PR 待合并", formal: "正式提案", frozen: "开发已冻结", deleted: "已删除", reviewing: "评审中", confirmed: "已确认" };
export const IR_ACCEPTANCE_LABELS = { reviewing: "验收中", issues: "待修复", passed: "验收通过", "pr-ready": "最终 PR 待创建", "pr-submitted": "最终 PR 待合并", completed: "已完成" };
export const SR_DELIVERY_LABELS = { prepared: "待合并前验证", verified: "合并前验证通过", "implementation-issue": "验证未通过，待修复", "git-conflict": "Git 冲突，等待人工", "requirement-conflict": "需求冲突，等待人工" };
export const MATERIAL_KIND_LABELS = { ir: "IR 业务需求", sr: "SR 系统需求", solution: "提案方案", plan: "开发计划", completion: "完成报告", ut: "UT 报告", st: "ST 报告", delivery: "交付说明", attachment: "附件", "ir-acceptance-report": "IR 验收报告", "ir-final-pr": "最终 PR", "sr-delivery-package": "SR 交付清单" };
export function hasCurrentProposalSolution(group: DevRequirementGroup): boolean {
 const solution = group.proposalSolution;
 if (!solution?.valid || !group.snapshot?.digest || solution.round !== (group.proposalRound ?? 1) || solution.requirementsDigest !== group.snapshot.digest) return false;
 const root = group.documentPath.replace(/proposal\.md$/, "");
 return solution.path === `${root}design.md` && group.snapshot.srs.length === group.srIds.length && group.srIds.every(id => group.snapshot!.srs.some(sr => sr.id === id)) && [group.documentPath, ...group.snapshot.srs.map(sr => sr.documentPath), solution.path].every(path => group.files.some(file => file.path === path));
}
export function srDefaultCommit(view: DevWorkflowView, projectId: string): string | undefined {
 const repositoryId = view.projects.find(project => project.id === projectId)?.repositoryId;
 return repositoryId ? view.repositoryHeads?.[repositoryId] : undefined;
}
export function fileVersions(files: DevFileVersion[]): string { return JSON.stringify(files.map(({ path, sha256, size }) => ({ path, sha256, size })).sort((a,b) => a.path.localeCompare(b.path))); }
export function srDeliveryInputBlocker(view: DevWorkflowView, sr: DevSystemRequirement): string | undefined {
 const kinds = ["completion", "ut", "st", "delivery"];
 const files = sr.materials.filter(item => item.valid && item.round === sr.round && kinds.includes(item.kind));
 if (!kinds.every(kind => files.some(file => file.kind === kind))) return "请先补齐本轮完成报告、UT、ST 和交付说明。";
 if (!sr.materialDigest || files.some(file => !view.materials.some(material => material.path === file.path && material.projectId === sr.projectId && material.srId === sr.id && material.valid && !material.error && material.content !== undefined && material.sha256 === file.sha256 && material.size === file.size))) return "交付输入缺失、不可读或版本过期，请恢复或重新生成当前材料。";
}
export function srDeliveryBlocker(view: DevWorkflowView, sr: DevSystemRequirement, requireVerification = true): string | undefined {
 const delivery = sr.delivery;
 if (!delivery) return "请先准备代码、测试和规格更新的同一 PR 交付清单。";
 const issue = srDeliveryInputBlocker(view,sr); if (issue) return issue;
 const inputs = sr.materials.filter(item => item.valid && item.round === sr.round && ["completion", "ut", "st", "delivery"].includes(item.kind));
 if (delivery.round !== sr.round || delivery.inputDigest !== sr.materialDigest || fileVersions(delivery.inputs) !== fileVersions(inputs)) return "交付材料已变化，请重新准备交付并验证新候选。";
 if (!["code", "test", "spec"].every(category => delivery.files.some(file => file.category === category))) return "交付必须包含代码、测试与规格。";
 const manifest = view.materials.find(item => item.path === delivery.manifestPath && item.valid);
 if (!manifest?.content || manifest.error) return "交付清单不可读取，请恢复材料后继续。";
 if (delivery.sourceSpec !== sr.documentPath) return "交付来源与当前 SR 不一致。";
 if (delivery.humanResolution && ["git-conflict", "requirement-conflict"].includes(delivery.status)) return "人工处理已记录，请重新准备交付并验证。";
 const head = srDefaultCommit(view,sr.projectId); if (head && delivery.defaultCommit !== head) return "默认分支已变化，请重新对齐并验证当前候选。";
 if (requireVerification && (delivery.status !== "verified" || delivery.verification?.candidate !== delivery.candidate || delivery.verification.defaultCommit !== delivery.defaultCommit)) return SR_DELIVERY_LABELS[delivery.status];
}
function dependencies(value: Record<string, string[]>): string {
  return JSON.stringify(Object.keys(value).sort().map(id => [id, [...value[id]!].sort()]));
}
/** 文档确认与开发冻结是两个不同的版本事实；这里只检查调用方提供的版本事实。 */
export function requirementConfirmationIssue(group: DevRequirementGroup): string | undefined {
  const reviewBlocker = requirementsReviewBlocker(group);
  if (reviewBlocker) return reviewBlocker;
  if (!group.merge || !group.snapshot || !group.confirmation || group.confirmation.snapshotDigest !== group.snapshot.digest || fileVersions(group.files) !== fileVersions(group.merge.files)) return "已入库需求或方案的确认版本已变化，请重新评审、确认并通过提案 PR 合入后再开始。";
}
export function requirementFreezeIssue(group: DevRequirementGroup): string | undefined {
  const freeze = group.freeze;
  if (!freeze) return group.status === "frozen" || group.developmentStartedAt ? "开发冻结记录缺失，请恢复原版本；不能重新生成快照覆盖历史。" : undefined;
  if (group.status !== "frozen" || freeze.snapshotDigest !== group.snapshot?.digest || freeze.title !== group.title || fileVersions(freeze.files) !== fileVersions(group.files) || JSON.stringify(freeze.srIds) !== JSON.stringify(group.srIds) || dependencies(freeze.dependencies) !== dependencies(group.srDependencies ?? {})) return "冻结的 IR／SR、需求成员或确认方案已变化，请暂停并重新提案；不能沿用旧冻结版本推进。";
}

export function repositoryDevelopment(view: DevWorkflowView, projectId: string, limit = 2): DevRepositoryDevelopment {
  const repositoryId = view.projects.find(project => project.id === projectId)?.repositoryId;
  const projectIds = new Set(view.projects.filter(project => repositoryId && project.repositoryId === repositoryId).map(project => project.id));
  const activeSrs = view.srs.filter(sr => projectIds.has(sr.projectId) && sr.status === "developing" && (!view.ompWebId || sr.ompWebId === view.ompWebId));
  const owners = view.groups.filter(group => projectIds.has(group.projectId) && (!view.ompWebId || group.ompWebId === view.ompWebId || activeSrs.some(sr => sr.irId === group.id)) && group.acceptance?.status !== "completed" && (group.developmentStartedAt || activeSrs.some(sr => sr.projectId === group.projectId && sr.irId === group.id) || group.acceptance));
  return { repositoryId: repositoryId ?? "", limit: limit, activeSrs, owners: owners.map(group => ({ projectId: group.projectId, irId: group.id, title: group.title })) };
}

function dependencyGraphIssue(view: DevWorkflowView, group: DevRequirementGroup): string | undefined {
  const rows = view.srs.filter(sr => sr.projectId === group.projectId && sr.irId === group.id && (!view.ompWebId || !sr.ompWebId || sr.ompWebId === view.ompWebId));
  const byId = new Map(rows.map(sr => [sr.id, sr]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function inspect(id: string): string | undefined {
    if (visiting.has(id)) return "SR 依赖存在循环，请修正提案方案并重新确认。";
    if (visited.has(id)) return;
    const sr = byId.get(id);
    if (!sr) return "SR 依赖引用了本 IR 之外或不存在的需求，请检查已确认方案。";
    visiting.add(id);
    for (const dependency of sr.dependencySrIds ?? []) { if (!byId.has(dependency) && view.srs.some(item => item.id === dependency && item.ompWebId && item.ompWebId !== view.ompWebId)) continue; const issue = inspect(dependency); if (issue) return issue; }
    visiting.delete(id); visited.add(id);
  }
  for (const sr of rows) { const issue = inspect(sr.id); if (issue) return issue; }
}

export function srStartBlocker(view: DevWorkflowView, group: DevRequirementGroup, sr: DevSystemRequirement): string | undefined {
  if (sr.status !== "pending") return "此 SR 已开始或完成，请继续原会话。";
  if (group.revising) return "正式提案正在修订；重新评审、确认并通过提案 PR 合并核验前禁止开发。";
  if (!view.groups.some(item => item.id === group.id && item.projectId === group.projectId) || !group.merge || !hasCurrentProposalSolution(group)) return "提案及确认方案尚未合并核验，不能开始开发。";
  const versionIssue = requirementConfirmationIssue(group) ?? requirementFreezeIssue(group);
  if (versionIssue) return versionIssue;
  if (group.acceptance?.status === "completed") return "此 IR 已完成；新的需求请重新提案。";
  if (group.acceptance) return "此 IR 已进入验收收尾，不能重开 SR 开发。";
  const occupancy = view.repositoryDevelopment ?? repositoryDevelopment(view, group.projectId);
  const other = occupancy.owners.find(owner => owner.projectId !== group.projectId || owner.irId !== group.id);
  if (other) return `本 OMP Web 内同仓库当前由「${other.title}」占用，最终验收与归档 PR 合并核验后才能开始另一个 IR。`;
  const graphIssue = dependencyGraphIssue(view, group);
  if (graphIssue) return graphIssue;
  const unresolved = (sr.dependencySrIds ?? []).map(id => view.srs.find(item => item.id === id && item.irId === group.id && item.projectId === group.projectId)).filter(item => !item || ((!view.ompWebId || !item.ompWebId || item.ompWebId === view.ompWebId) && !srMergeVerified(item, view.projects.find(project => project.id === item.projectId)?.defaultBranch)));
  if (unresolved.length) return `等待前置 SR 合并并核验：${unresolved.map(item => item?.title ?? "缺失的 SR").join("、")}`;
  if (occupancy.activeSrs.length >= occupancy.limit) return `本 OMP Web 内并行名额已满（${occupancy.activeSrs.length}/${occupancy.limit}）；等待评审或合并的 SR 仍占用名额。`;
}

export function srMergeVersion(view: DevWorkflowView, group: DevRequirementGroup): string {
  return JSON.stringify(view.srs.filter(sr => sr.projectId === group.projectId && sr.irId === group.id).sort((a, b) => a.id.localeCompare(b.id)).map(sr => [sr.id, sr.codeMerge?.commit, fileVersions(sr.codeMerge?.files ?? [])]));
}
export function irAcceptanceBlocker(view: DevWorkflowView, group: DevRequirementGroup): string | undefined {
  const srs = view.srs.filter(sr => sr.irId === group.id && sr.projectId === group.projectId);
  if (!group.merge) return "提案尚未合并核对。";
  if (!srs.length || srs.length !== group.srIds.length || group.srIds.some(id => !srs.some(sr => sr.id === id))) return "SR 集合缺失或与冻结需求不一致，不能开始验收。";
  const pending = srs.filter(sr => !srMergeVerified(sr, view.projects.find(project => project.id === sr.projectId)?.defaultBranch));
  if (pending.length) return `等待 ${pending.length} 个 SR 合并并核验：${pending.map(sr => sr.title).join("、")}`;
  const other = (view.repositoryDevelopment ?? repositoryDevelopment(view, group.projectId)).owners.find(item => item.irId !== group.id || item.projectId !== group.projectId);
  if (other) return `当前仓库由「${other.title}」占用，请先完成其开发和验收。`;
  return requirementFreezeIssue(group);
}
export function irAcceptanceVersionBlocker(view: DevWorkflowView, group: DevRequirementGroup): string | undefined {
  const acceptance = group.acceptance;
  if (!acceptance || acceptance.status === "completed") return;
  if (acceptance.baseCommit !== srDefaultCommit(view, group.projectId)) return "默认分支已变化，旧验收已失效；请重新对齐并验收。";
  if (acceptance.srMergeVersion && acceptance.srMergeVersion !== srMergeVersion(view, group)) return "SR 合并记录或规格版本已变化，请重新验收。";
  if (acceptance.reportCandidate && (acceptance.reportCandidate !== acceptance.candidate || acceptance.reportBaseCommit !== acceptance.baseCommit)) return "验收报告不属于当前候选版本，请重新验收。";
}
export function irAcceptanceReportBlocker(view: DevWorkflowView, group: DevRequirementGroup): string | undefined {
  const versionIssue = irAcceptanceBlocker(view, group) ?? irAcceptanceVersionBlocker(view, group);
  if (versionIssue) return versionIssue;
  const acceptance = group.acceptance;
  const report = view.materials.find(item => item.path === acceptance?.reportPath && item.irId === group.id && item.projectId === group.projectId && item.valid);
  if (!acceptance?.reportVersion || !report?.content || report.error || fileVersions([report]) !== fileVersions([acceptance.reportVersion])) return "当前候选验收报告缺失、不可读或版本已变化，请重新验收。";
}

export function srMergeVerified(sr: DevSystemRequirement, defaultBranch = sr.codePr?.targetBranch ?? "main"): boolean {
 const merge = sr.codeMerge;
 const capability = sr.id.replace(/^(proposal-)?sr-/, "");
 const paths = [`src/${capability}/index.ts`, `test/${capability}.test.ts`, `openspec/specs/${capability}/spec.md`];
 return sr.status === "completed" && Boolean(merge?.commit && merge.branch === defaultBranch && paths.every(path => merge.files.some(file => file.path === path && file.sha256 && file.size >= 0)));
}

export function irFinalPackageBlocker(view: DevWorkflowView, group: DevRequirementGroup): string | undefined {
  const reportIssue = irAcceptanceReportBlocker(view, group);
  if (reportIssue) return reportIssue;
  const acceptance = group.acceptance!;
  const archive = acceptance.archive;
  const root = group.documentPath.replace(/\/proposal\.md$/, "");
  if (!archive || !archive.skipSpecs || archive.sourceRoot !== root || !new RegExp(`^openspec/changes/archive/\\d{4}-\\d{2}-\\d{2}-${root.split("/").at(-1)}$`).test(archive.targetRoot)) return "归档清单无效：仅允许将当前 Change 移入原生归档目录，不再次同步规格。";
  const source = group.freeze?.files ?? [];
  if (!source.length || source.some(file => !file.path.startsWith(`${root}/`)) || archive.moves.length !== source.length || source.some(file => !archive.moves.some(move => move.sourcePath === file.path && move.path === `${archive.targetRoot}/${file.path.slice(root.length + 1)}` && move.sha256 === file.sha256 && move.size === file.size))) return "归档必须完整移动同一 Change，保持每个文件的内容版本；不能遗漏、覆盖其他提案或重新同步规格。";
  if (!acceptance.packageVersion || acceptance.packageVersion !== irFinalPackageVersion(group)) return "最终 PR 清单版本已变化，旧确认不可继续使用。";
  const material = view.materials.find(item => item.path === acceptance.finalPrPath && item.projectId === group.projectId && item.irId === group.id && item.valid);
  if (!material?.content || material.error || !acceptance.finalPrVersion || fileVersions([material]) !== fileVersions([acceptance.finalPrVersion])) return "最终 PR 信息缺失、不可读或版本已变化，请重新准备。";
}

/** Display ownership hints only; a browser employee ID is never authorization. */
export function conversationReadOnlyReason(view: DevWorkflowView | undefined, selection: DevSelection, access?: { proposalDiscussion?: boolean; codeDevelopment?: boolean }): string | undefined {
 if (!view || selection.freeSessionId) return;
 const proposal = view.drafts.find(item => item.id === selection.irId);
 if (proposal) {
  if (access?.proposalDiscussion === false) return "提案由 j00808874 的 OMP 管理。当前 Web 只读，请进入 A 的 Web 讨论或修改。";
  const phase = proposal.proposalStage ?? "requirements";
  if (selection.discussionPhase && selection.discussionPhase !== phase) return "正在查看另一讨论阶段的历史，只读。";
  if (proposal.status === "requirements-pr") return "需求 PR 已提交，当前版本只读；合并核对后进入正式需求。";
  if (phase === "solution") {
   const acceptance = proposal.developerAcceptance;
   if (!acceptance || acceptance.round !== (proposal.proposalRound ?? 1)) return "请先接手评审，再继续方案讨论。";
   if (acceptance.employeeId !== getEmployeeId()) return `方案由 ${acceptance.employeeId} 接手，当前仅查看。`;
  }
  return;
 }
 if (access?.codeDevelopment === false) return "改代码须启动自己的 omp dev_web，并配置自己的 Git 项目路径；此入口仅浏览正式需求。";
 if (selection.irAcceptance) {
  const acceptance = view.groups.find(item => item.id === selection.irId)?.acceptance;
  if (!acceptance) return "请先明确开始 IR 验收。";
  if (acceptance.status === "completed") return "IR 已完成，验收会话仅供只读查看。";
  if (acceptance.employeeId !== getEmployeeId()) return `IR 验收由 ${acceptance.employeeId} 负责，当前仅查看。`;
  const group = view.groups.find(item => item.id === selection.irId)!;
  const versionIssue = irAcceptanceVersionBlocker(view, group);
  if (versionIssue) return versionIssue;
  if (acceptance.status === "pr-ready" || acceptance.status === "pr-submitted") return "最终候选已确认，当前只读；等待人工 PR 合并及结果核验。";
  return;
 }
 const formal = view.groups.find(item => item.id === selection.irId && item.projectId === selection.projectId);
 if (formal && !selection.srId) return "正式需求已进入仓库，可在自己的 Web 和 Git 项目中自由修改、提交；这里显示入库资料。";
 const sr = view.srs.find(item => item.id === selection.srId && item.irId === selection.irId);
 if (sr?.status === "completed") return "该 SR 已完成，历史会话只读。";
 if (sr?.status === "developing" && sr.developerEmployeeId !== getEmployeeId()) return `该 SR 由 ${sr.developerEmployeeId ?? "其他同事"} 开发，当前仅查看。`;
 if (sr?.status === "developing" && !deriveStageView(sr, selection).isCurrent) return "当前查看的是历史或尚未开始的阶段，只读；返回当前阶段继续处理。";
}

export function irFinalPackageVersion(group: DevRequirementGroup): string {
 const acceptance = group.acceptance!;
 return JSON.stringify([acceptance.candidate, acceptance.baseCommit, acceptance.reportVersion, acceptance.srMergeVersion, acceptance.archive]);
}

/** 原型展示节点不另建 Agent：需求评审和人工入库都有独立的只读查看状态。 */
export function proposalProgressIndex(group: DevRequirementGroup, selection?: DevSelection): number {
 if (selection?.proposalEditing && group.proposalStage !== "solution") return 0;
 if (group.proposalStage === "requirements" && group.returnFeedback && !group.returnFeedback.resumedAt && !requirementsReviewCurrent(group)) return 0;
 if (group.status === "requirements-pr" || proposalDeliveryCurrent(group)) return 3;
 if (group.proposalStage === "solution") return 2;
 return requirementsReviewCurrent(group) ? 1 : 0;
}
export function proposalViewedIndex(group: DevRequirementGroup, selection: DevSelection): number {
 if (selection.proposalStep) return ["requirements", "requirements-review", "solution", "intake"].indexOf(selection.proposalStep);
 if (selection.discussionPhase === "requirements" && proposalProgressIndex(group, selection) > 1) return 0;
 return proposalProgressIndex(group, selection);
}

/** 提出人固定，当前处理责任按阶段变化；不是权限或自动分派系统。 */
export function proposalActorLabel(group: DevRequirementGroup): string {
 if (group.status === "requirements-pr" || proposalDeliveryCurrent(group)) return `入库开发 ${group.proposalDelivery?.confirmedBy ?? "待确认"}`;
 if (group.proposalStage === "solution") return hasCurrentProposalSolution(group) ? "具备个人 Web 和开发项目的开发人员入库" : `方案开发 ${group.developerAcceptance?.employeeId ?? "待确认"}`;
 if (requirementsReviewCurrent(group) && !requirementsReviewBlocker(group)) return group.returnFeedback ? `开发 ${group.returnFeedback.employeeId} 继续方案` : "开发人员进入方案";
 return `业务 ${group.proposalLocation?.employeeId ?? "提出人"} 补充需求`;
}
