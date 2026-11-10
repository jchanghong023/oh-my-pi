import { prototypeProposalRevisionBlocker } from "./proposal-revision.js";
import { isPrototypeProposalDeliveryAction, prototypeProposalVersion, validatePrototypeProposalDeliveryAction } from "./proposal-delivery.js";
import { createPrototypeEvent } from "./events.js";
import { applyPrototypeSrDeliveryAction, isPrototypeSrDeliveryAction, prototypeSrDeliveryFiles, prototypeSrDefaultCommit, validatePrototypeSrDeliveryAction } from "./sr-delivery.js";
import { freezePrototypeRequirement, prototypeRequirementFreezeIssue } from "./requirement-freeze.js";
import { prototypeRepositoryDevelopment, prototypeSrStartBlocker } from "./development-admission.js";
import { applyIrAcceptanceAction, isIrAcceptanceAction, validateIrAcceptanceAction } from "./ir-acceptance.js";
import { prototypeRecoveryScenario, prototypeSessionReadIssue, prototypeMaterialIssue, clearPrototypeMaterialIssue, consumePrototypeOperationFailure } from "./recovery.js";
import { readPrototypeAgentModelBinding } from "./agent-models.js";
import { prototypeStageMaterialBlocker } from "./stage-gates.js";
import { readPrototypeProposalPrHandoff } from "./proposal-pr-handoff.js";
import { createPrototypeRequirementsReview, prototypeRequirementsReviewBlocker, prototypeRequirementsReviewCurrent, prototypeRequirementsReviewInputs } from "./requirements-review.js";
import { getPrototypeEmployeeId, isPrototypeEmployeeId } from "./employee.js";
import { prototypeChangeRoot, prototypeSpecPath, prototypeProposalLocation } from "./proposal-storage.js";
import { hasCurrentProposalSolution, prototypeProposalSolution } from "./proposal-flow.js";
import { developmentMaterials, requirementMaterials } from "./materials.js";
import { checkPrototypeProjectDirectory, checkPrototypeDevelopmentDirectory } from "./project-directories.js";
import { readPrototypeProjectSettings, addPrototypeProject, readPrototypeDevelopmentRoot, savePrototypeDevelopmentRoot } from "./project-settings.js";
import { readPrototypeProjectReleases, addPrototypeRelease } from "./project-releases.js";
import type {
  DevAction, DevMaterialView, DevNativeSessionRef, DevOperationReceipt, DevRequirementGroup,
  DevSelection, DevStageMaterial, DevSystemRequirement, DevWorkflowResult, DevWorkflowStage, DevWorkflowView,
} from "./types.js";

export const DEFAULT_SELECTION: DevSelection = prototypeRecoveryScenario === "sr-delivery" ? { projectId: "demo-aurora", irId: "ir-auth", srId: "sr-auth" } : prototypeRecoveryScenario === "requirements-review" ? { projectId: "demo-aurora", irId: "draft-automation" } : prototypeRecoveryScenario === "ir-acceptance" ? { projectId: "demo-aurora", irId: "ir-auth", irAcceptance: true } : prototypeRecoveryScenario === "empty-projects" ? {} : prototypeRecoveryScenario === "empty-releases" || prototypeRecoveryScenario === "empty-requirements" ? { projectId: "demo-aurora" } : prototypeRecoveryScenario === "missing-requirement" ? { projectId: "demo-aurora", irId: "removed-proposal" } : prototypeRecoveryScenario === "missing-sr" ? { projectId: "demo-aurora", irId: "ir-auth", srId: "removed-sr" } : { projectId: "demo-aurora", irId: "ir-auth", srId: "sr-auth" };
export const PROTOTYPE_WORKSPACE_IDENTITY = "dev-ui-prototype";
export const PROTOTYPE_RELEASE_ID = "release-2026-11";
const createdAt = "2026-11-10T09:00:00.000Z";
const stages: DevWorkflowStage[] = ["planning", "executing", "pr"];
const phaseSessions = { planning: "demo-planning", executing: "demo-executing", pr: "demo-pr" };
function sessionRef(projectId: string, irId: string, phase: DevNativeSessionRef["phase"], srId?: string, preferred?: string, round = 1): DevNativeSessionRef {
  const sessionId = preferred ?? `${projectId}-${irId}-${srId ?? "ir"}-${phase}${round > 1 ? `-round-${round}` : ""}`;
  return { projectId, irId, ...(srId ? { srId } : {}), sessionId, sessionFile: `/demo/sessions/${sessionId}.jsonl`, role: phase, phase, round, modelConfig: readPrototypeAgentModelBinding(phase === "executing" || phase === "pr" ? "execution" : phase) };
}
function receipt(type: string, revision: number, irId?: string, srId?: string): DevOperationReceipt {
  return { operationId: `sample-operation-${revision}`, commandDigest: `sample:${type}:${revision}`, type,
    status: "completed", startedAt: createdAt, completedAt: createdAt, revision, irId, srId,
    steps: [{ name: "prototype", at: createdAt, detail: `前端样例：${type}。仅展示本地 UI 状态，未执行 OMP、Git、模型、测试或真实审批。` }] };
}
function group(projectId: string, id: string, title: string, rows: DevSystemRequirement[], draft = false, proposerId = "j00808874"): DevRequirementGroup {
  const materials = requirementMaterials(projectId, id, title, rows);
  const files = materials.map(({ path, sha256, size }) => ({ path, sha256, size }));
  const digest = `sample-digest:${projectId}:${id}`;
  const requirementsSession = sessionRef(projectId, id, "requirements", undefined,
    projectId === "demo-aurora" && id === "ir-auth" ? "demo-requirements" : undefined);
  return { id, projectId, releaseId: PROTOTYPE_RELEASE_ID, title, documentPath: `${prototypeChangeRoot(id)}/proposal.md`,
    ...(draft ? { proposalLocation: prototypeProposalLocation(projectId, id, proposerId), proposalStage: "requirements" as const, proposalRound: 1 } : {
      proposalRound: 1, proposalSolution: { path: `${prototypeChangeRoot(id)}/design.md`, employeeId: "j00808874", generatedAt: createdAt, round: 1, valid: true, requirementsDigest: digest },
    }),
    origin: "local", status: draft ? "draft" : rows.some(row => row.startedAt) ? "frozen" : "formal", revision: 1, srIds: rows.map(row => row.id), files,
    sessions: [requirementsSession], createdAt, ...(!draft ? { worktree: { path: `/demo/worktrees/${projectId}/${id}`, branch: `demo/requirements/${id}`, baseCommit: "sample-base" } } : {}),
    snapshot: { version: 1, projectId, irId: id, title, srs: rows.map(({ id: srId, title: srTitle, documentPath }) => ({ id: srId, title: srTitle, documentPath })),
      documentPath: `${prototypeChangeRoot(id)}/proposal.md`, files, digest },
    ...(!draft ? {
      confirmation: { operationId: `sample-confirm-${id}`, snapshotDigest: digest, confirmedAt: createdAt },
      review: { id: `sample-review-${id}`, snapshotDigest: digest, passed: true,
        report: "前端审核展示样例：需求边界、拆分关系和交互资料齐全。此记录不是实际审核结论，真实审核留待后续 OMP 对接阶段。",
        reviewer: { sessionId: `sample-reviewer-${id}`, role: "reviewer" as const, sourceProjectId: projectId, imported: true as const }, createdAt },
    } : {}),
  };
}
function systemRequirement(projectId: string, irId: string, id: string, title: string, stage?: DevWorkflowStage, completed = false, preferred = false): DevSystemRequirement {
  const materials = developmentMaterials(projectId, irId, id, title).filter(item => completed || (stage && stages.indexOf(item.stage!) <= stages.indexOf(stage)));
  const owner = ({ "sr-auth": "j00808874", "sr-session": "j00808876", "sr-permissions": "j00808875", "sr-audit": "j00808877", "sr-mobile-navigation": "j00808875", "sr-mobile-notifications": "j00808876" } as Record<string, string>)[id] ?? "j00808874";
  const project = readPrototypeProjectSettings().projects.find(item => item.id === projectId)!;
  // 预置的已开始记录也固定当时的个人目录，不随当前查看人工号或后续设置变化。
  const developmentRoot = `/demo/${owner}/${project.storageName}`;
  const sessions = stage || completed ? stages.filter(phase => completed || (stage && stages.indexOf(phase) <= stages.indexOf(stage))).map(phase => sessionRef(projectId, irId, phase, id,
    preferred && phase === stage ? phaseSessions[phase] : undefined)) : [];
  return { id, projectId, irId, title, documentPath: prototypeSpecPath(irId, id),
    status: completed ? "completed" : stage ? "developing" : "pending", stage: completed ? "pr" : stage, round: stage || completed ? 1 : 0,
    ...(stage || completed ? { developerEmployeeId: owner, startedAt: createdAt, developmentRoot } : {}),
    sessions, approvals: [], materials: stage || completed ? materials.map(item => ({
      path: item.path, sha256: item.sha256, size: item.size, stage: item.stage!, kind: item.kind as DevStageMaterial["kind"], round: 1, valid: true,
    })) : [], materialDigest: stage || completed ? `sample-materials:${id}` : undefined,
    ...(stage || completed ? { worktree: { path: `${developmentRoot}/.worktrees/${id}`, branch: `demo/${id}`, baseCommit: "sample-base" } } : {}),
    ...(stage === "pr" || completed ? { codePr: { url: `https://example.invalid/demo/pulls/${completed ? "42" : "41"}`, sourceBranch: `demo/${id}`,
      targetBranch: "main", recordedAt: createdAt, platformVerified: false as const } } : {}),
  };
}
export function createPrototypeWorkflow(): DevWorkflowView {
  const sharedSettings = readPrototypeProjectSettings();
  if (!sharedSettings.projects.length) return { version: 1, revision: 0, projects: [], releases: [], groups: [], drafts: [], srs: [], materials: [], operations: [], sessions: [], running: [], changes: [] };
  const srs = [
    systemRequirement("demo-aurora", "ir-auth", "sr-auth", "统一登录与会话管理", "planning", false, false),
    systemRequirement("demo-aurora", "ir-auth", "sr-session", "会话恢复与设备管理", "planning", false, true),
    systemRequirement("demo-aurora", "ir-auth", "sr-permissions", "角色权限与访问边界"),
    systemRequirement("demo-aurora", "ir-auth", "sr-audit", "操作审计与交付"),
    systemRequirement("demo-aurora", "ir-auth", "sr-onboarding", "首次登录引导（已完成示例）", undefined, true),
    systemRequirement("demo-aurora", "ir-dashboard", "sr-dashboard", "指标概览与趋势卡片"),
    systemRequirement("demo-aurora", "ir-dashboard", "sr-dashboard-filters", "筛选器与空态"),
    systemRequirement("demo-mobile", "ir-mobile", "sr-mobile-navigation", "移动导航与项目切换", "planning"),
    systemRequirement("demo-mobile", "ir-mobile", "sr-mobile-notifications", "通知列表与阅读状态", "executing"),
    systemRequirement("demo-mobile", "ir-mobile", "sr-mobile-profile", "个人资料卡片（已完成示例）", undefined, true),
    systemRequirement("demo-aurora", "draft-automation", "proposal-sr-trigger", "触发条件与执行范围"),
    systemRequirement("demo-aurora", "draft-automation", "proposal-sr-history", "执行记录与结果查看"),
    systemRequirement("demo-aurora", "draft-notification", "proposal-sr-notification", "通知范围与阅读状态"),
    systemRequirement("demo-mobile", "draft-mobile-search", "proposal-sr-search", "搜索条件与结果展示"),
    systemRequirement("demo-mobile", "ir-mobile-offline", "sr-mobile-offline", "离线提示与重新进入"),
  ];
  for (const sr of srs) sr.dependencySrIds = sr.id === "sr-permissions" ? ["sr-auth"] : sr.id === "sr-audit" ? ["sr-permissions", "sr-session"] : [];
  if (prototypeRecoveryScenario === "sr-delivery") {
    const index = srs.findIndex(sr => sr.id === "sr-auth");
    srs[index] = { ...systemRequirement("demo-aurora", "ir-auth", "sr-auth", "统一登录与会话管理", "pr"), dependencySrIds: [] };
    srs[index]!.codePr = undefined;
  }
  if (prototypeRecoveryScenario === "proposal-freeze") {
    for (let index = 0; index < srs.length; index++) {
      const sr = srs[index]!;
      if (sr.irId === "ir-auth") srs[index] = { ...systemRequirement(sr.projectId, sr.irId, sr.id, sr.title.replace("（已完成示例）", "")), dependencySrIds: sr.dependencySrIds };
    }
  }
  if (prototypeRecoveryScenario === "parallel-admission") {
    const index = srs.findIndex(sr => sr.id === "sr-session");
    srs[index] = systemRequirement("demo-aurora", "ir-auth", "sr-session", "会话恢复与设备管理");
    srs[index]!.dependencySrIds = [];
    const independent = srs.findIndex(sr => sr.id === "sr-onboarding");
    srs[independent] = { ...systemRequirement("demo-aurora", "ir-auth", "sr-onboarding", "首次登录引导"), dependencySrIds: [] };
  }
  if (prototypeRecoveryScenario === "ir-acceptance") {
    for (let index = 0; index < srs.length; index++) {
      const sr = srs[index]!;
      if (sr.irId === "ir-auth") srs[index] = { ...systemRequirement(sr.projectId, sr.irId, sr.id, sr.title, undefined, true), dependencySrIds: sr.dependencySrIds };
    }
  }
  for (const sr of srs.filter(item => item.status === "completed")) sr.codeMerge = { commit: `sample-merged-${sr.id}`, branch: "main", checkedAt: createdAt, files: prototypeSrDeliveryFiles(sr, `sample-merged-${sr.id}`) };
  const groups = [group("demo-aurora", "ir-auth", "账号与权限体验", srs.filter(sr => sr.irId === "ir-auth")),
    group("demo-aurora", "ir-dashboard", "团队数据总览", srs.filter(sr => sr.irId === "ir-dashboard")),
    group("demo-mobile", "ir-mobile", "移动协作工作台", srs.filter(sr => sr.irId === "ir-mobile")),
    group("demo-mobile", "ir-mobile-offline", "移动端离线体验", srs.filter(sr => sr.irId === "ir-mobile-offline"))];
  const drafts = [group("demo-aurora", "draft-automation", "自动化工作流探索", srs.filter(sr => sr.irId === "draft-automation"), true),
    group("demo-aurora", "draft-notification", "团队通知与提醒", srs.filter(sr => sr.irId === "draft-notification"), true, "j00808876"),
    group("demo-mobile", "draft-mobile-search", "移动搜索体验", srs.filter(sr => sr.irId === "draft-mobile-search"), true, "j00808875")];
  drafts[1]!.proposalStage = "solution";
  drafts[1]!.sessions.push(sessionRef("demo-aurora", "draft-notification", "solution"));
  drafts[1]!.developerHandoff = { employeeId: "j00808876", submittedAt: "2026-11-10T09:30:00.000Z" };
  drafts[1]!.developerAcceptance = { employeeId: "j00808874", acceptedAt: "2026-11-10T09:35:00.000Z", round: 1 };
  for (const item of groups) {
    const rows = srs.filter(sr => sr.projectId === item.projectId && sr.irId === item.id);
    item.srDependencies = Object.fromEntries(rows.map(sr => [sr.id, sr.dependencySrIds ?? []]));
    if (rows.some(sr => sr.startedAt)) item.developmentStartedAt = createdAt;
  }
  for (const item of [...groups, ...drafts]) item.releaseId = readPrototypeProjectReleases(item.projectId)[0]?.id ?? "";
  const materials = [...groups, ...drafts].flatMap(item => requirementMaterials(item.projectId, item.id, item.title, srs.filter(sr => sr.irId === item.id)));
  for (const item of [...groups, drafts[1]!]) item.review = createPrototypeRequirementsReview(item, "j00808874", true);
  for (const item of groups) {
    const solution = prototypeProposalSolution(item);
    item.files.push({ path: solution.path, sha256: solution.sha256, size: solution.size });
    item.merge = { commit: `sample-merged-${item.id}`, branch: "main", checkedAt: createdAt, files: structuredClone(item.files) };
    if (item.developmentStartedAt) freezePrototypeRequirement(item, "j00808874", item.developmentStartedAt);
  }
  materials.push(...groups.map(prototypeProposalSolution));
  materials.push(...srs.filter(sr => sr.status !== "pending").flatMap(sr => developmentMaterials(sr.projectId, sr.irId, sr.id, sr.title).filter(item => sr.materials.some(file => file.path === item.path))));
  const result: DevWorkflowView = { version: 1, revision: 12, ...sharedSettings, releases: readPrototypeProjectReleases(), currentProjectId: DEFAULT_SELECTION.projectId,
    groups, drafts, srs, materials, repositoryHeads: Object.fromEntries(sharedSettings.projects.map(project => [project.repositoryId, `sample-default-${project.repositoryId}`])), operations: [receipt("需求样例整理", 1, "ir-auth"), receipt("提案方案已随需求合入（样例）", 2, "ir-auth"),
      receipt("计划样例准备", 3, "ir-auth", "sr-session"), receipt("验证报告展示", 4, "ir-auth", "sr-permissions"),
      receipt("交付信息展示", 5, "ir-auth", "sr-audit"), receipt("完成状态展示", 6, "ir-auth", "sr-onboarding"),
      receipt("需求样例整理", 7, "ir-dashboard"), receipt("草稿样例创建", 8, "draft-automation"),
      receipt("移动工作台样例", 9, "ir-mobile", "sr-mobile-navigation"), receipt("离线体验草稿", 10, "ir-mobile-offline")],
    sessions: [...groups, ...drafts].flatMap(item => item.sessions).concat(srs.flatMap(sr => sr.sessions)),
    selected: { projectId: "demo-aurora", irId: "ir-auth" }, running: [], changes: materials.map(item => ({
      path: item.path, sha256: item.sha256, size: item.size, projectId: item.projectId, irId: item.irId, srId: item.srId, status: "M（样例）",
    })),
  };
  if (prototypeRecoveryScenario === "empty-releases" || prototypeRecoveryScenario === "empty-requirements") {
    result.groups = result.groups.filter(item => item.projectId !== "demo-aurora"); result.drafts = result.drafts.filter(item => item.projectId !== "demo-aurora");
    result.srs = result.srs.filter(item => item.projectId !== "demo-aurora"); result.materials = result.materials.filter(item => item.projectId !== "demo-aurora");
    result.sessions = result.sessions.filter(item => item.projectId !== "demo-aurora"); result.operations = []; result.changes = result.changes?.filter(item => item.projectId !== "demo-aurora");
  }
  return result;
}
let state = createPrototypeWorkflow();
export const prototypeWorkflowChanges = createPrototypeEvent<void>();
export function getPrototypeWorkflow(selection: DevSelection = DEFAULT_SELECTION): DevWorkflowView {
  const projectId = selection.projectId ?? DEFAULT_SELECTION.projectId;
  const sharedSettings = readPrototypeProjectSettings();
  return { ...state, projects: sharedSettings.projects, currentProjectId: projectId,
    repositoryDevelopment: prototypeRepositoryDevelopment({ ...state, projects: sharedSettings.projects }, projectId ?? ""),
    releases: readPrototypeProjectReleases(projectId), groups: state.groups.filter(item => item.projectId === projectId),
    drafts: state.drafts.filter(item => item.projectId === projectId), srs: state.srs.filter(item => item.projectId === projectId),
    materials: state.materials.filter(item => item.projectId === projectId).map(item => prototypeMaterialIssue(item.path) ? { ...item, error: prototypeMaterialIssue(item.path), content: undefined } : item),
    sessions: state.sessions.filter(item => item.projectId === projectId && !prototypeSessionReadIssue(item.sessionId)),
    operations: state.operations.filter(item => !item.irId || [...state.groups, ...state.drafts].some(group => group.projectId === projectId && group.id === item.irId)),
    changes: state.changes?.filter(item => item.projectId === projectId),
    selected: selection.irId && projectId ? { projectId, irId: selection.irId, ...(selection.srId ? { srId: selection.srId } : {}) } : undefined,
  };
}
/** 提案内的 IR/SR 是查看目标；业务需求会话始终归属于整份提案。 */
export function resolvePrototypeSession(view: DevWorkflowView, selection: DevSelection): DevNativeSessionRef | undefined {
  if (!selection.irId) return;
  const projectId = selection.projectId ?? view.currentProjectId;
  const sr = view.srs.find(item => item.projectId === projectId && item.id === selection.srId && item.irId === selection.irId);
  if (selection.srId && !sr) return;
  if (selection.irAcceptance) return view.groups.find(item => item.id === selection.irId)?.acceptance?.session;
  const proposal = view.drafts.find(item => item.projectId === projectId && item.id === selection.irId);
  if (proposal) return proposal.sessions.filter(item => item.projectId === projectId && item.irId === proposal.id && !item.srId && item.phase === (selection.discussionPhase ?? proposal.proposalStage ?? "requirements")).sort((a, b) => b.round - a.round)[0];
  if (selection.srId && !sr?.stage) return;
  const phase = selection.stage ?? sr?.stage ?? "requirements";
  const candidates = view.sessions.filter(item => item.projectId === projectId && item.irId === selection.irId && item.srId === selection.srId && item.phase === phase);
  if (!sr) return candidates.sort((a, b) => b.round - a.round)[0];
  if (selection.stageRound !== undefined) return candidates.find(item => item.round === selection.stageRound);
  return candidates.sort((a,b) => b.round - a.round)[0];
}
export function getPrototypeSession(selection: DevSelection = DEFAULT_SELECTION): DevNativeSessionRef | undefined {
  return resolvePrototypeSession(getPrototypeWorkflow(selection), selection);
}
export function getPrototypeMaterial(selection: DevSelection, path: string): DevMaterialView | undefined {
  return getPrototypeWorkflow(selection).materials.find(item => item.irId === selection.irId && item.path === path && (!item.srId || item.srId === selection.srId));
}
/** Small UI-only transitions, not backend workflow approvals or an execution engine. */
export function applyPrototypeAction(action: DevAction, selection: DevSelection): DevWorkflowResult {
  if (consumePrototypeOperationFailure(action.type)) throw new Error("操作未完成（一次性故障样例）。内容和当前状态已保留，请明确重试。");
  if (action.type === "createProposal") {
    const projectId = action.projectId ?? selection.projectId ?? DEFAULT_SELECTION.projectId;
    if (!readPrototypeProjectReleases(projectId).some(release => release.id === action.releaseId)) {
      throw new Error("请选择当前项目的有效 Release。");
    }
  }
  if (action.type === "registerProject") {
    const check = checkPrototypeProjectDirectory(action.root, state.projects.map(item => item.root));
    if (!check.valid) throw new Error(check.error);
    if (!action.name.trim()) throw new Error("请输入项目名称。");
  }
  if (action.type === "createRelease") {
    const projectId = action.projectId ?? selection.projectId;
    if (!state.projects.some(item => item.id === projectId)) throw new Error("请选择已有项目。");
    if (!action.title.trim()) throw new Error("请输入 Release 名称。");
    if (readPrototypeProjectReleases(projectId).some(item => item.title.toLowerCase() === action.title.trim().toLowerCase())) {
      throw new Error("此项目中已存在同名 Release，请使用其他名称。");
    }
  }
  const targetProjectId = action.projectId ?? selection.projectId ?? DEFAULT_SELECTION.projectId;
  if (action.type === "setDevelopmentRoot") {
    const project = state.projects.find(item => item.id === targetProjectId);
    if (!project) throw new Error("请选择已有项目。");
    const check = checkPrototypeDevelopmentDirectory(action.root, project.root);
    if (!check.valid) throw new Error(check.error);
  }
  const targetSr = state.srs.find(item => item.projectId === targetProjectId && item.irId === (action.irId ?? selection.irId) && item.id === (action.srId ?? selection.srId));
  if (["startSr", "generateStageMaterials", "approveStage", "backStage", "markCodePrSubmitted", "markCodeMerged"].includes(action.type)) {
    if (!isPrototypeEmployeeId(getPrototypeEmployeeId())) throw new Error("请先输入有效工号。");
    if (!targetSr) throw new Error("请选择当前项目的有效 SR。");
    if (action.type === "startSr") {
      if (targetSr.status !== "pending") throw new Error("此 SR 已开始或完成，不能重复接手开发。");
      const formal = state.groups.find(group => group.projectId === targetProjectId && group.id === targetSr.irId);
      if (!formal) throw new Error("请选择正式需求中的 SR。");
      const blocker = prototypeSrStartBlocker(getPrototypeWorkflow({ projectId: targetProjectId }), formal, targetSr);
      if (blocker) throw new Error(blocker);
    } else {
      if (targetSr.developerEmployeeId !== getPrototypeEmployeeId()) throw new Error("当前 SR 由其他同事开发，可查看材料与讨论，不能代为推进或提交。");
      if (targetSr.status !== "developing") throw new Error("仅进行中的 SR 可以推进、返回或记录代码交付。");
    }
  }
  if (targetSr?.status === "developing" && ["generateStageMaterials", "approveStage", "backStage", "markCodePrSubmitted", "markCodeMerged", "stop"].includes(action.type)) {
    const activeSession = targetSr.sessions.find(item => item.phase === targetSr.stage && item.round === targetSr.round);
    if (!activeSession || prototypeSessionReadIssue(activeSession.sessionId)) throw new Error("当前阶段会话记录不可用，请重新读取原记录；不会新建替代会话。");
  }
  const viewingHistory = targetSr && ((selection.stage !== undefined && selection.stage !== targetSr.stage) || (selection.stageRound !== undefined && selection.stageRound !== targetSr.round));
  if (viewingHistory && ["generateStageMaterials", "approveStage", "backStage", "markCodePrSubmitted", "markCodeMerged", "stop"].includes(action.type)) throw new Error("当前查看的是历史或尚未开始的阶段，只读；请返回实际阶段操作。");
  if (action.type === "approveStage") {
    if (!targetSr || action.stage !== targetSr.stage || action.round !== targetSr.round || action.materialDigest !== targetSr.materialDigest || targetSr.stage === "pr") throw new Error("阶段、轮次或材料版本已变化，请刷新后确认当前阶段；重复或过期操作已拒绝。");
    const reason = prototypeStageMaterialBlocker(targetSr, getPrototypeWorkflow({ projectId: targetProjectId }).materials); if (reason) throw new Error(reason);
  }
  if (action.type === "generateStageMaterials" && (!targetSr || action.stage !== targetSr.stage || action.round !== targetSr.round)) throw new Error("只能生成实际阶段和当前轮次的材料。");
  if (action.type === "backStage" && (!targetSr?.stage || action.fromStage !== targetSr.stage || action.round !== targetSr.round || stages.indexOf(action.stage) >= stages.indexOf(targetSr.stage))) throw new Error("只允许从实际阶段返回之前的阶段；重复、过期或向前跳转已拒绝。");
  if (["markCodePrSubmitted", "markCodeMerged"].includes(action.type) && targetSr?.stage !== "pr") throw new Error("请在实际交付 PR 阶段记录代码交付。");
  if (action.type === "startSr") {
    const formal = state.groups.find(item => item.projectId === targetProjectId && item.id === (action.irId ?? selection.irId));
    if (!formal || !["formal", "frozen"].includes(formal.status) || !hasCurrentProposalSolution(formal) || !formal.merge) throw new Error("需求 PR 合并且默认分支包含需求与方案后，才能开始 SR 开发计划。");
  }
  if (action.type === "startSr" && !readPrototypeDevelopmentRoot(targetProjectId!)) {
    throw new Error("请先在设置 → Dev 项目与 Release 中添加本项目的个人开发项目路径。");
  }
  if (targetSr && ["generateStageMaterials", "approveStage", "backStage", "markCodePrSubmitted", "markCodeMerged", "stop"].includes(action.type) && targetSr.status !== "pending" && (!targetSr.worktree?.path || !targetSr.developmentRoot)) throw new Error("该 SR 的固定开发目录记录不完整，请先恢复原绑定；不会回落到共享项目目录。");
  if (targetSr && action.type === "stop" && targetSr.developerEmployeeId !== getPrototypeEmployeeId()) throw new Error("当前 SR 由其他同事开发，不能代为停止任务。");
  if (isPrototypeSrDeliveryAction(action)) validatePrototypeSrDeliveryAction(getPrototypeWorkflow({ projectId: targetProjectId }), targetSr, action, selection);
  const formalTarget = state.groups.find(item => item.projectId === targetProjectId && item.id === (action.irId ?? selection.irId));
  if (formalTarget && (["startSr", "generateStageMaterials", "approveStage", "backStage", "markCodePrSubmitted", "markCodeMerged"].includes(action.type) || isIrAcceptanceAction(action) || isPrototypeSrDeliveryAction(action))) {
    const issue = prototypeRequirementFreezeIssue(formalTarget);
    if (issue) throw new Error(issue);
  }
  const targetProposal = state.drafts.find(item => item.projectId === targetProjectId && item.id === (action.irId ?? selection.irId));
  const proposalAction = ["submitProposalReview", "acceptProposal", "runRequirementsReview", "generateRequirements", "supplementRequirements", "generateProposalSolution", "returnProposal", "recordRequirementsDecision"].includes(action.type) || isPrototypeProposalDeliveryAction(action);
  if (proposalAction) {
    if (!targetProposal) throw new Error("请选择需求提案，不能对正式需求重复执行提案动作。");
    if (!isPrototypeEmployeeId(getPrototypeEmployeeId())) throw new Error("请先输入有效工号。");
  }
  if (targetProposal && ["submitProposalReview", "acceptProposal", "generateProposalSolution", "markRequirementsPrSubmitted", "markRequirementsMerged"].includes(action.type)) {
    const blocker = prototypeRequirementsReviewBlocker(targetProposal);
    if (blocker) throw new Error(blocker);
  }
  if (action.type === "runRequirementsReview" && targetProposal && !prototypeRequirementsReviewInputs(targetProposal)) throw new Error("请先补齐 IR 与全部 SR 需求材料，不能对空提案生成通过记录。");
  if (action.type === "acceptProposal" && (targetProposal?.proposalStage !== "solution" || !targetProposal.developerHandoff || targetProposal.status === "requirements-pr")) throw new Error("请先提交评审，再由开发人员接手当前轮次。");
  if (action.type === "acceptProposal" && targetProposal?.developerAcceptance?.round === (targetProposal?.proposalRound ?? 1)) throw new Error("本轮提案已有接手开发人员，不能重复接手或覆盖他人的记录。");
  if (["generateProposalSolution", "returnProposal", "markRequirementsPrSubmitted"].includes(action.type) && (targetProposal?.developerAcceptance?.round !== (targetProposal?.proposalRound ?? 1) || targetProposal?.developerAcceptance?.employeeId !== getPrototypeEmployeeId())) throw new Error("请先由当前工号明确接手本轮提案；其他同事可查看，不能代为生成方案、打回或提交 PR。");
  if (action.type === "runRequirementsReview" && targetProposal?.status === "requirements-pr") throw new Error("PR 已提交，本轮仅支持提交 PR 前的需求评审。");
  if ((action.type === "generateRequirements" || action.type === "supplementRequirements") && (targetProposal?.proposalStage !== "requirements" || targetProposal.status !== "draft" || !action.note.trim())) throw new Error("请在业务需求阶段填写明确的需求内容。");
  if (action.type === "generateRequirements" && targetProposal?.srIds.length) throw new Error("本提案已有 SR，请补充当前需求，不重复生成或覆盖已有拆分。");
  if (action.type === "supplementRequirements" && !targetProposal?.srIds.length) throw new Error("请先生成 IR／SR，再补充需求。");
  if (action.type === "submitProposalReview" && (targetProposal?.status !== "draft" || targetProposal.proposalStage !== "requirements")) throw new Error("仅业务需求阶段的草稿可交给开发评审，无需预先生成方案。");
  if (action.type === "generateProposalSolution" && (!targetProposal?.srIds.length || targetProposal.proposalStage !== "solution" || !["draft", "solution-ready"].includes(targetProposal.status))) throw new Error("请先完成 IR／SR 并交给开发，在方案阶段生成方案。");
  if (action.type === "returnProposal" && (targetProposal?.proposalStage !== "solution" || targetProposal.status === "requirements-pr" || !action.reason.trim())) throw new Error("请在提交 PR 前填写业务需补充的细节，再打回提案。");
  if (isPrototypeProposalDeliveryAction(action) && targetProposal) validatePrototypeProposalDeliveryAction(getPrototypeWorkflow({ projectId: targetProjectId }), targetProposal, action);
  if (action.type === "recordRequirementsDecision") {
    if (targetProposal?.status !== "draft" || targetProposal.proposalStage !== "requirements" || !prototypeRequirementsReviewCurrent(targetProposal) || targetProposal.review?.id !== action.reviewId || targetProposal.snapshot?.digest !== action.snapshotDigest) throw new Error("裁决页面对应旧评审或非当前业务需求阶段，请重新查看当前评审。");
    if (!action.opinion.trim() || !action.result.trim()) throw new Error("请填写人工意见、裁决依据及处理结果。");
  }
  if (action.type === "beginProposalRevision") {
    if (!isPrototypeEmployeeId(getPrototypeEmployeeId())) throw new Error("请先输入有效工号。");
    if (!formalTarget) throw new Error("请选择已入库的正式提案。");
    const blocker = prototypeProposalRevisionBlocker(getPrototypeWorkflow({ projectId: targetProjectId }), formalTarget);
    if (blocker) throw new Error(blocker);
    if (!action.reason.trim()) throw new Error("请说明本次正式提案的修订原因。");
  }
  if (action.type === "deleteRequirement" && targetProposal?.proposalRevisions?.length) throw new Error("正式提案的修订必须保留原入库记录，不能作为普通草稿删除。");
  if (isIrAcceptanceAction(action)) validateIrAcceptanceAction(getPrototypeWorkflow({ projectId: targetProjectId }), state.groups.find(item => item.projectId === targetProjectId && item.id === (action.irId ?? selection.irId)), action);
  if (action.type === "deleteRequirement" && state.groups.some(item => item.projectId === targetProjectId && item.id === (action.irId ?? selection.irId) && (item.merge || item.developmentStartedAt))) throw new Error("已入库的正式提案须保留 Git 记录与历史，不能通过删除需求释放仓库。");
  state = structuredClone(state);
  const projectId = action.projectId ?? selection.projectId ?? "demo-aurora";
  let irId = action.irId ?? selection.irId;
  const srId = proposalAction || action.type === "beginProposalRevision" ? undefined : action.srId ?? selection.srId;
  let selectedProjectId = projectId;
  const currentGroup = [...state.groups, ...state.drafts].find(item => item.id === irId && item.projectId === projectId);
  const sr = state.srs.find(item => item.id === srId && item.irId === irId && item.projectId === projectId);
  const operation = receipt(action.type, ++state.revision, irId, srId);
  if (isPrototypeSrDeliveryAction(action)) applyPrototypeSrDeliveryAction(state, currentGroup!, sr!, action);
  if (isIrAcceptanceAction(action)) applyIrAcceptanceAction(state, currentGroup!, action);
  switch (action.type) {
    case "registerProject": {
      selectedProjectId = `demo-project-${state.revision}`;
      const check = checkPrototypeProjectDirectory(action.root, []);
      if (!check.valid) throw new Error(check.error);
      addPrototypeProject({ id: selectedProjectId, name: action.name.trim(), root: check.root, branch: check.directory.branch });
      Object.assign(state, readPrototypeProjectSettings());
      irId = undefined;
      break;
    }
    case "setDevelopmentRoot":
      savePrototypeDevelopmentRoot(projectId, action.root.trim().replace(/\/+$/, ""));
      break;
    case "createRelease":
      addPrototypeRelease({ id: `demo-release-${state.revision}`, projectId, title: action.title.trim(), createdAt });
      state.releases = readPrototypeProjectReleases();
      break;
    case "createProposal": {
      irId = `draft-demo-${state.revision}`;
      const item = group(projectId, irId, "新需求提案（样例）", [], true, getPrototypeEmployeeId());
      item.origin = "browser";
      item.releaseId = action.releaseId;
      state.drafts.push(item); state.sessions.push(...item.sessions);
      state.materials.push(...requirementMaterials(projectId, irId, item.title, []));
      operation.irId = irId;
      break;
    }
    case "beginProposalRevision": {
      const proposal = currentGroup!;
      proposal.proposalRevisions ??= [];
      proposal.proposalRevisions.push({
        reason: action.reason.trim(), employeeId: getPrototypeEmployeeId(), startedAt: new Date().toISOString(),
        snapshot: structuredClone(proposal.snapshot!), merge: structuredClone(proposal.merge!),
        materials: structuredClone(state.materials.filter(item => item.projectId === projectId && item.irId === irId)),
        requirementsPr: structuredClone(proposal.requirementsPr), delivery: structuredClone(proposal.proposalDelivery), review: structuredClone(proposal.review),
      });
      if (proposal.proposalDelivery) {
        proposal.proposalDeliveryHistory ??= [];
        proposal.proposalDeliveryHistory.push(structuredClone(proposal.proposalDelivery));
      }
      proposal.revising = true; proposal.status = "draft"; proposal.proposalStage = "requirements";
      proposal.proposalRound = (proposal.proposalRound ?? 1) + 1;
      proposal.revision += 1;
      proposal.snapshot!.digest = `sample-digest:${projectId}:${irId}:revision-${proposal.revision}`;
      proposal.merge = undefined; proposal.confirmation = undefined; proposal.requirementsPr = undefined; proposal.proposalDelivery = undefined;
      proposal.developerHandoff = undefined; proposal.developerAcceptance = undefined;
      if (proposal.proposalSolution) proposal.proposalSolution.valid = false;
      state.materials.filter(item => item.projectId === projectId && item.irId === irId && item.kind === "solution").forEach(item => { item.valid = false; });
      proposal.proposalLocation ??= prototypeProposalLocation(projectId, proposal.id, getPrototypeEmployeeId());
      const session = sessionRef(projectId, proposal.id, "requirements", undefined, undefined, proposal.proposalRound);
      proposal.sessions.push(session); state.sessions.push(session);
      state.groups = state.groups.filter(item => item.projectId !== projectId || item.id !== irId);
      state.drafts.push(proposal);
      operation.type = "正式提案进入修订，保留原入库版本并阻止 SR 开发（演示）";
      break;
    }
    case "deleteRequirement":
      state.groups = state.groups.filter(item => item.id !== irId || item.projectId !== projectId);
      state.drafts = state.drafts.filter(item => item.id !== irId || item.projectId !== projectId);
      state.srs = state.srs.filter(item => item.irId !== irId || item.projectId !== projectId);
      state.materials = state.materials.filter(item => item.irId !== irId || item.projectId !== projectId);
      state.sessions = state.sessions.filter(item => item.irId !== irId || item.projectId !== projectId);
      operation.deletion = { version: 1, operationId: operation.operationId, deletedAt: createdAt, manualCloseNeeded: false };
      break;
    case "submitProposalReview": {
      currentGroup!.proposalStage = "solution";
      currentGroup!.developerHandoff = { employeeId: getPrototypeEmployeeId(), submittedAt: new Date().toISOString() };
      currentGroup!.developerAcceptance = undefined;
      if (!currentGroup!.sessions.some(item => item.phase === "solution" && item.round === (currentGroup!.proposalRound ?? 1))) {
        const session = sessionRef(projectId, currentGroup!.id, "solution", undefined, undefined, currentGroup!.proposalRound ?? 1);
        currentGroup!.sessions.push(session); state.sessions.push(session);
      }
      operation.type = `由 ${getPrototypeEmployeeId()} 提交评审，进入方案阶段等待开发接手（原型）`;
      break;
    }
    case "acceptProposal":
      currentGroup!.developerAcceptance = { employeeId: getPrototypeEmployeeId(), acceptedAt: new Date().toISOString(), round: currentGroup!.proposalRound ?? 1 };
      operation.type = `开发人员 ${getPrototypeEmployeeId()} 接手本轮提案（原型）`;
      break;
    case "runRequirementsReview":
      if (currentGroup!.review) { currentGroup!.reviewHistory ??= []; currentGroup!.reviewHistory.push(structuredClone(currentGroup!.review)); }
      currentGroup!.revision += 1;
      currentGroup!.review = createPrototypeRequirementsReview(currentGroup!, getPrototypeEmployeeId());
      operation.type = "需求评审 Agent 检查 OpenSpec 需求产物（静态演示）";
      break;
    case "recordRequirementsDecision":
      currentGroup!.requirementsDecisions ??= [];
      currentGroup!.requirementsDecisions.push({
        reviewId: action.reviewId, snapshotDigest: action.snapshotDigest,
        inputFiles: structuredClone(prototypeRequirementsReviewInputs(currentGroup!)!),
        opinion: action.opinion.trim(), outcome: action.outcome, result: action.result.trim(),
        employeeId: getPrototypeEmployeeId(), createdAt: new Date().toISOString(), review: structuredClone(currentGroup!.review!),
      });
      operation.type = "单独记录人工争议意见与处理结果，不改写 AI 评审（演示）";
      break;
    case "generateRequirements":
    case "supplementRequirements": {
      const proposal = currentGroup!;
      const note = action.note.trim();
      if (action.type === "generateRequirements") {
        proposal.title = note.split("\n")[0]!.slice(0, 60);
        const rows = ["业务操作与结果展示", "异常处理与恢复"].map((title, index) =>
          systemRequirement(projectId, proposal.id, `sr-${proposal.id}-${index + 1}`, `${proposal.title} · ${title}`));
        proposal.srIds = rows.map(row => row.id);
        state.srs.push(...rows);
        state.materials = state.materials.filter(item => item.projectId !== projectId || item.irId !== irId || item.kind !== "ir");
        state.materials.push(...requirementMaterials(projectId, proposal.id, proposal.title, rows));
      }
      proposal.proposalRound = (proposal.proposalRound ?? 1) + 1;
      if (action.type === "supplementRequirements") {
        proposal.requirementSupplements ??= [];
        proposal.requirementSupplements.push({ note, employeeId: getPrototypeEmployeeId(), createdAt: new Date().toISOString(), round: proposal.proposalRound });
      }
      proposal.developerHandoff = undefined;
      proposal.developerAcceptance = undefined;
      proposal.confirmation = undefined;
      proposal.revision += 1;
      if (proposal.proposalSolution) proposal.proposalSolution.valid = false;
      const materials = state.materials.filter(item => item.projectId === projectId && item.irId === irId);
      for (const material of materials) {
        if (material.kind === "solution") material.valid = false;
        if (material.kind !== "ir" && material.kind !== "sr") continue;
        material.content = `${material.content ?? ""}\n\n## ${action.type === "generateRequirements" ? "业务需求描述" : "业务补充"}（原型演示）\n${note}`;
        material.size = new TextEncoder().encode(material.content).length;
        material.sha256 = `sample:${material.path}:revision-${proposal.revision}`;
      }
      proposal.files = materials.map(({ path, sha256, size }) => ({ path, sha256, size }));
      proposal.snapshot = {
        version: 1, projectId, irId: proposal.id, title: proposal.title, documentPath: proposal.documentPath,
        srs: state.srs.filter(row => row.projectId === projectId && row.irId === irId).map(({ id, title, documentPath }) => ({ id, title, documentPath })),
        files: structuredClone(proposal.files.filter(file => file.path !== proposal.proposalSolution?.path)),
        digest: `sample-digest:${projectId}:${irId}:revision-${proposal.revision}`,
      };
      operation.type = action.type === "generateRequirements" ? "根据输入生成 IR 与两个 SR（固定模板演示，未调用模型）" : `由 ${getPrototypeEmployeeId()} 补充 IR／SR，旧评审与方案需重新确认（原型）`;
      break;
    }
    case "generateProposalSolution": {
      const material = prototypeProposalSolution(currentGroup!);
      material.sha256 = `sample:${material.path}:revision-${state.revision}`;
      currentGroup!.proposalSolution = { path: material.path, employeeId: getPrototypeEmployeeId(), generatedAt: new Date().toISOString(), round: currentGroup!.proposalRound ?? 1, valid: true, requirementsDigest: currentGroup!.snapshot?.digest };
      currentGroup!.status = "solution-ready";
      state.materials = state.materials.filter(item => item.projectId !== projectId || item.irId !== irId || item.kind !== "solution");
      state.materials.push(material);
      currentGroup!.files = [...currentGroup!.files.filter(item => item.path !== material.path), { path: material.path, sha256: material.sha256, size: material.size }];
      operation.type = "开发人员完成提案方案（原型）";
      break;
    }
    case "returnProposal": {
      currentGroup!.proposalStage = "requirements"; currentGroup!.status = "draft";
      currentGroup!.proposalRound = (currentGroup!.proposalRound ?? 1) + 1;
      currentGroup!.developerAcceptance = undefined;
      currentGroup!.returnFeedback = { employeeId: getPrototypeEmployeeId(), returnedAt: new Date().toISOString(), reason: action.reason.trim() };
      if (currentGroup!.proposalSolution) currentGroup!.proposalSolution.valid = false;
      state.materials.filter(item => item.projectId === projectId && item.irId === irId && item.kind === "solution").forEach(item => { item.valid = false; });
      operation.type = "打回业务补充，旧方案失效（原型）";
      break;
    }
    case "confirmProposal": {
      const proposal = currentGroup!;
      if (proposal.proposalDelivery) {
        proposal.proposalDeliveryHistory ??= [];
        proposal.proposalDeliveryHistory.push(structuredClone(proposal.proposalDelivery));
      }
      proposal.proposalDelivery = {
        candidate: `sample-proposal-${state.revision}`, version: prototypeProposalVersion(proposal),
        files: structuredClone(proposal.files), confirmedBy: getPrototypeEmployeeId(), confirmedAt: new Date().toISOString(),
      };
      proposal.confirmation = { operationId: operation.operationId, snapshotDigest: proposal.snapshot!.digest, confirmedAt: proposal.proposalDelivery.confirmedAt };
      proposal.requirementsPr = undefined;
      operation.type = "人工确认当前 IR／全部 SR／方案版本（演示）";
      break;
    }
    case "publishProposal":
      currentGroup!.proposalDelivery!.pushedCandidate = action.candidate;
      currentGroup!.proposalDelivery!.pushedAt = new Date().toISOString();
      operation.type = "AI 提交并推送已确认的提案候选（仅内存演示）";
      break;
    case "markRequirementsPrSubmitted": case "markCodePrSubmitted": {
      const fact = { url: action.url, sourceBranch: action.type === "markRequirementsPrSubmitted" && currentGroup ? readPrototypeProposalPrHandoff(currentGroup).branch : sr?.worktree?.branch ?? currentGroup?.worktree?.branch ?? "demo/sample", targetBranch: state.projects.find(item => item.id === projectId)?.defaultBranch ?? "main", recordedAt: new Date().toISOString(), platformVerified: false as const };
      if (action.type === "markCodePrSubmitted" && sr) sr.codePr = fact;
      else if (currentGroup && action.type === "markRequirementsPrSubmitted") { currentGroup.requirementsPr = fact; currentGroup.proposalDelivery!.prCandidate = action.candidate; currentGroup.status = "requirements-pr"; }
      break;
    }
    case "markRequirementsMerged": if (currentGroup) {
      currentGroup.status = "formal";
      currentGroup.merge = { commit: `sample-merge-${state.revision}`, branch: state.projects.find(item => item.id === projectId)?.defaultBranch ?? "main", checkedAt: new Date().toISOString(), files: structuredClone(currentGroup.files) };
      state.drafts = state.drafts.filter(item => item.id !== currentGroup.id || item.projectId !== projectId);
      state.groups.push(currentGroup);
      currentGroup.revising = false;
      const revision = currentGroup.proposalRevisions?.at(-1);
      if (revision && !revision.completedAt) revision.completedAt = new Date().toISOString();
      operation.type = "演示提案 PR 合并及文件版本核对，正式入库但尚未冻结";
    } break;
    case "markCodeMerged": if (sr) {
      sr.status = "completed";
      const project = state.projects.find(item => item.id === projectId)!;
      sr.codeMerge = { commit: `sample-merged-${sr.delivery!.candidate}`, branch: project.defaultBranch, checkedAt: new Date().toISOString(), files: structuredClone(sr.delivery!.files) };
      state.repositoryHeads ??= {}; state.repositoryHeads[project.repositoryId] = sr.codeMerge.commit;
    } break;
    case "generateStageMaterials": {
      if (!sr?.stage) break;
      sr.materials.forEach(item => { if (item.stage === sr.stage && item.round === sr.round) item.valid = false; });
      state.materials.forEach(item => { if (item.srId === sr.id && item.projectId === sr.projectId && item.stage === sr.stage && item.round === sr.round) item.valid = false; });
      const generated = developmentMaterials(projectId, sr.irId, sr.id, sr.title, sr.round).filter(item => item.stage === sr.stage).map(item => ({ ...item, sha256: `sample:${item.path}:revision-${state.revision}` }));
      for (const item of generated) {
        clearPrototypeMaterialIssue(item.path);
        state.materials = state.materials.filter(old => !(old.projectId === projectId && old.path === item.path)); state.materials.push(item);
        sr.materials = sr.materials.filter(old => old.path !== item.path); sr.materials.push({ path: item.path, sha256: item.sha256, size: item.size, stage: sr.stage, kind: item.kind as DevStageMaterial["kind"], round: sr.round, valid: true });
      }
      sr.materialDigest = `sample-materials:${sr.id}:${sr.stage}:round-${sr.round}:revision-${state.revision}`;
      operation.type = "生成当前阶段材料样例（未执行模型或验证）";
      break;
    }
    case "startSr": case "approveStage": case "backStage":
      if (sr) {
        if (action.type === "approveStage") sr.approvals.push({ stage: sr.stage!, round: sr.round, operationId: operation.operationId, digest: sr.materialDigest!, files: structuredClone(sr.materials.filter(item => item.valid && item.stage === sr.stage && item.round === sr.round)), approvedAt: new Date().toISOString(), valid: true });
        const next = action.type === "startSr" ? "planning" : action.type === "backStage" ? action.stage : stages[stages.indexOf(sr.stage!) + 1]!;
        if (action.type === "backStage") {
          if (sr.delivery) { sr.deliveryHistory ??= []; sr.deliveryHistory.push(structuredClone(sr.delivery)); sr.delivery = undefined; }
          sr.round += 1;
          sr.materials.forEach(item => { if (stages.indexOf(item.stage) >= stages.indexOf(next)) item.valid = false; });
          state.materials.forEach(item => { if (item.projectId === projectId && item.srId === sr.id && item.stage && stages.indexOf(item.stage) >= stages.indexOf(next)) item.valid = false; });
          sr.approvals.forEach(item => { if (stages.indexOf(item.stage) >= stages.indexOf(next)) item.valid = false; });
          if (sr.codePr) { sr.codePrHistory ??= []; sr.codePrHistory.push(structuredClone(sr.codePr)); }
          sr.codePr = undefined;
        }
        sr.stage = next; sr.status = "developing";
        if (action.type === "startSr") { freezePrototypeRequirement(currentGroup!, getPrototypeEmployeeId(), new Date().toISOString()); sr.round = 1; sr.developerEmployeeId = getPrototypeEmployeeId(); sr.startedAt = new Date().toISOString(); sr.developmentRoot = readPrototypeDevelopmentRoot(projectId)!; }
        sr.worktree ??= { path: `${sr.developmentRoot}/.worktrees/${sr.id}`, branch: `demo/${sr.id}`, baseCommit: prototypeSrDefaultCommit(state, projectId) };
        let session = sr.sessions.find(item => item.phase === next && item.round === sr.round);
        if (!session) { session = sessionRef(projectId, sr.irId, next, sr.id, undefined, sr.round); sr.sessions.push(session); state.sessions.push(session); }
        sr.materialDigest = undefined;
      }
      break;
    case "stop":
      state.running = state.running.filter(item => item.projectId !== projectId || item.irId !== irId || (srId !== undefined && item.srId !== srId));
      break;
  }
  state.operations.push(operation);
  prototypeWorkflowChanges.fire();
  return { operationId: operation.operationId, projectId: selectedProjectId, revision: state.revision, irId, srId,
    status: "completed", receipt: operation, deletion: operation.deletion,
    view: getPrototypeWorkflow({ projectId: selectedProjectId, irId, srId }) };
}
