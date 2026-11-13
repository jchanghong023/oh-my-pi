import { PROTOTYPE_BACKEND } from "./backend.js";
import { proposalVersion } from "../domain.js";
import { proposalDependencyMaterialIssue } from "../sr-dependencies.js";
import { proposalRevisionBlocker } from "../domain.js";
import { ensurePrototypeProposalMr, isPrototypeProposalDeliveryAction, validatePrototypeProposalDeliveryAction } from "./proposal-delivery.js";
import { createPrototypeEvent } from "./events.js";
import { applyPrototypeSrDeliveryAction, isPrototypeSrDeliveryAction, prototypeSrDeliveryFiles, prototypeSrDefaultCommit, validatePrototypeSrDeliveryAction } from "./sr-delivery.js";

import { freezePrototypeRequirement } from "./requirement-freeze.js";
import { requirementFreezeIssue } from "../domain.js";
import { repositoryDevelopment, srStartBlocker } from "../domain.js";
import { applyIrAcceptanceAction, isIrAcceptanceAction, validateIrAcceptanceAction } from "./ir-acceptance.js";

import { prototypeRecoveryScenario, prototypeSessionReadIssue, prototypeMaterialIssue, clearPrototypeMaterialIssue, consumePrototypeOperationFailure } from "./recovery.js";
import { readPrototypeAgentModelBinding } from "./agent-models.js";
import { stageMaterialBlocker } from "../domain.js";
import { readPrototypeProposalPrHandoff } from "./proposal-pr-handoff.js";
import { createPrototypeRequirementsReview, prototypeReviewSessions, prototypeReviewModelBindings } from "./requirements-review.js";
import { requirementsReviewStartBlocker, requirementsReviewReadyBlocker, requirementsReviewBlocker, requirementsReviewCurrent, requirementsReviewInputs, proposalViewedIndex } from "../domain.js";
import { getEmployeeId, isEmployeeId } from "../identity.js";
import { prototypeChangeRoot, prototypeSpecPath, prototypeProposalLocation } from "./proposal-storage.js";
import { hasCurrentProposalSolution } from "../domain.js";
import { prototypeProposalDependencies, prototypeProposalSolution } from "./proposal-flow.js";
import { developmentMaterials, requirementMaterials } from "./materials.js";
import { checkPrototypeProjectDirectory, checkPrototypeDevelopmentDirectory } from "./project-directories.js";
import { readPrototypeProjectSettings, addPrototypeProject, updatePrototypeSharedProjectRoot, checkPrototypeSharedProjectDirectory, readPrototypeDevelopmentRoot, savePrototypeDevelopmentRoot } from "./project-settings.js";
import { readPrototypeProjectReleases, addPrototypeRelease } from "./project-releases.js";
import type {
  AIReqAction, AIReqMaterialView, AIReqNativeSessionRef, AIReqOperationReceipt, AIReqRequirementGroup, AIReqProposalMergeScenario,
  AIReqSelection, AIReqStageMaterial, AIReqSystemRequirement, AIReqWorkflowResult, AIReqWorkflowStage, AIReqWorkflowView,
} from "../types.js";

export const DEFAULT_SELECTION: AIReqSelection = (prototypeRecoveryScenario === "proposal-intake" || prototypeRecoveryScenario === "proposal-feedback") ? { projectId: "demo-aurora", irId: "draft-notification" } : prototypeRecoveryScenario === "sr-delivery" ? { projectId: "demo-aurora", irId: "ir-auth", srId: "sr-auth" } : (prototypeRecoveryScenario === "requirements-review" || prototypeRecoveryScenario === "review-chat") ? { projectId: "demo-aurora", irId: "draft-automation" } : prototypeRecoveryScenario === "ir-acceptance" ? { projectId: "demo-aurora", irId: "ir-auth", irAcceptance: true } : prototypeRecoveryScenario === "empty-projects" ? {} : prototypeRecoveryScenario === "empty-releases" || prototypeRecoveryScenario === "empty-requirements" ? { projectId: "demo-aurora" } : prototypeRecoveryScenario === "missing-requirement" ? { projectId: "demo-aurora", irId: "removed-proposal" } : prototypeRecoveryScenario === "missing-sr" ? { projectId: "demo-aurora", irId: "ir-auth", srId: "removed-sr" } : { projectId: "demo-aurora", irId: "ir-auth", srId: "sr-auth" };
export const PROTOTYPE_WORKSPACE_IDENTITY = "aireq-ui-prototype";
export const PROTOTYPE_RELEASE_ID = "release-2026-11";
const createdAt = "2026-11-10T09:00:00.000Z";
const stages: AIReqWorkflowStage[] = ["planning", "executing", "pr"];
const phaseSessions: Partial<Record<AIReqWorkflowStage, string>> = { planning: "demo-planning", executing: "demo-executing", pr: "demo-pr" };
function sessionRef(projectId: string, irId: string, phase: AIReqNativeSessionRef["phase"], srId?: string, preferred?: string, round = 1): AIReqNativeSessionRef {
  const sessionId = preferred ?? `${projectId}-${irId}-${srId ?? "ir"}-${phase}${round > 1 ? `-round-${round}` : ""}`;
  return { projectId, irId, ...(srId ? { srId } : {}), sessionId, sessionFile: `/demo/sessions/${sessionId}.jsonl`, role: phase, phase, round, modelConfig: readPrototypeAgentModelBinding(phase === "executing" || phase === "pr" ? "execution" : phase) };
}
function receipt(type: string, revision: number, irId?: string, srId?: string): AIReqOperationReceipt {
  return { operationId: `sample-operation-${revision}`, commandDigest: `sample:${type}:${revision}`, type,
    status: "completed", startedAt: createdAt, completedAt: createdAt, revision, irId, srId,
    steps: [{ name: "prototype", at: createdAt, detail: `前端样例：${type}。仅展示本地 UI 状态，未执行 OMP、Git、模型、测试或真实审批。` }] };
}
function group(projectId: string, id: string, title: string, rows: AIReqSystemRequirement[], draft = false, proposerId = "j00808874"): AIReqRequirementGroup {
  const materials = requirementMaterials(projectId, id, title, rows);
  const files = materials.map(({ path, sha256, size }) => ({ path, sha256, size }));
  const digest = `sample-digest:${projectId}:${id}`;
  const requirementsSession = sessionRef(projectId, id, "requirements", undefined,
    projectId === "demo-aurora" && id === "ir-auth" ? "demo-requirements" : undefined);
  return { id, projectId, releaseId: PROTOTYPE_RELEASE_ID, title, documentPath: `${prototypeChangeRoot(id)}/proposal.md`,
    ...(draft ? { proposalLocation: prototypeProposalLocation(projectId, proposerId), proposalStage: "requirements" as const, proposalRound: 1 } : {
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
function systemRequirement(projectId: string, irId: string, id: string, title: string, stage?: AIReqWorkflowStage, completed = false, preferred = false): AIReqSystemRequirement {
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
      path: item.path, sha256: item.sha256, size: item.size, stage: item.stage!, kind: item.kind as AIReqStageMaterial["kind"], round: 1, valid: true,
    })) : [], materialDigest: stage || completed ? `sample-materials:${id}` : undefined,
    ...(stage || completed ? { worktree: { path: `${developmentRoot}/.worktrees/${id}`, branch: `demo/${id}`, baseCommit: "sample-base" } } : {}),
    ...(stage === "pr" || completed ? { codePr: { url: `https://example.invalid/demo/pulls/${completed ? "42" : "41"}`, sourceBranch: `demo/${id}`,
      targetBranch: "main", recordedAt: createdAt, platformVerified: false as const } } : {}),
  };
}
export function createPrototypeWorkflow(): AIReqWorkflowView {
  const sharedSettings = readPrototypeProjectSettings();
  if (!sharedSettings.projects.length) return { version: 1, revision: 0, projects: [], releases: [], groups: [], drafts: [], srs: [], materials: [], operations: [], sessions: [], running: [], changes: [] };
  const srs = [
    systemRequirement("demo-aurora", "ir-auth", "sr-auth", "统一登录与会话管理", "planning", false, false),
    systemRequirement("demo-aurora", "ir-auth", "sr-session", "会话恢复与设备管理", "planning", false, true),
    systemRequirement("demo-aurora", "ir-auth", "sr-permissions", "角色权限与访问边界"),
    systemRequirement("demo-aurora", "ir-auth", "sr-audit", "操作审计与交付"),
    systemRequirement("demo-aurora", "ir-auth", "sr-onboarding", "首次登录引导", undefined, true),
    systemRequirement("demo-aurora", "ir-dashboard", "sr-dashboard", "指标概览与趋势卡片"),
    systemRequirement("demo-aurora", "ir-dashboard", "sr-dashboard-filters", "筛选器与空态"),
    systemRequirement("demo-mobile", "ir-mobile", "sr-mobile-navigation", "移动导航与项目切换", "planning"),
    systemRequirement("demo-mobile", "ir-mobile", "sr-mobile-notifications", "通知列表与阅读状态", "executing"),
    systemRequirement("demo-mobile", "ir-mobile", "sr-mobile-profile", "个人资料卡片", undefined, true),
    systemRequirement("demo-aurora", "ir-export", "sr-export", "导出任务与下载", undefined, true),
    systemRequirement("demo-aurora", "ir-notifications", "sr-notification-inbox", "通知列表与阅读状态", undefined, true),
    systemRequirement("demo-aurora", "ir-audit-archive", "sr-audit-retention", "审计查询与留存", undefined, true),
    systemRequirement("demo-aurora", "draft-automation", "proposal-sr-trigger", "触发条件与执行范围"),
    systemRequirement("demo-aurora", "draft-automation", "proposal-sr-history", "执行记录与结果查看"),
    systemRequirement("demo-aurora", "draft-notification", "proposal-sr-notification", "通知范围与阅读状态"),
    systemRequirement("demo-aurora", "draft-report-export", "proposal-sr-report-export", "报表导出范围与下载反馈"),
    systemRequirement("demo-aurora", "draft-resource-booking", "proposal-sr-resource-booking", "资源预约时段与冲突提示"),
    systemRequirement("demo-aurora", "draft-resource-booking", "proposal-sr-booking-notification", "预约结果通知与失败反馈"),
    systemRequirement("demo-aurora", "draft-audit-subscription", "proposal-sr-audit-subscription", "审计订阅条件与投递记录"),
    systemRequirement("demo-mobile", "draft-mobile-search", "proposal-sr-search", "搜索条件与结果展示"),
    systemRequirement("demo-mobile", "ir-mobile-offline", "sr-mobile-offline", "离线提示与重新进入"),
  ];
  for (const sr of srs) sr.dependencySrIds = sr.id === "sr-permissions" ? ["sr-auth"] : sr.id === "sr-audit" ? ["sr-permissions", "sr-session"] : sr.id === "proposal-sr-booking-notification" ? ["proposal-sr-resource-booking"] : [];
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
    group("demo-aurora", "ir-export", "报表导出", srs.filter(sr => sr.irId === "ir-export")),
    group("demo-aurora", "ir-notifications", "通知中心", srs.filter(sr => sr.irId === "ir-notifications")),
    group("demo-aurora", "ir-audit-archive", "操作审计", srs.filter(sr => sr.irId === "ir-audit-archive")),
    group("demo-mobile", "ir-mobile", "移动协作工作台", srs.filter(sr => sr.irId === "ir-mobile")),
    group("demo-mobile", "ir-mobile-offline", "移动端离线体验", srs.filter(sr => sr.irId === "ir-mobile-offline"))];
  const reviewProposal = group("demo-aurora", "draft-report-export", "团队报表导出", srs.filter(sr => sr.irId === "draft-report-export"), true, "j00808875");
  const readyProposal = group("demo-aurora", "draft-resource-booking", "共享资源预约", srs.filter(sr => sr.irId === "draft-resource-booking"), true, "j00808877");
  const intakeProposal = group("demo-aurora", "draft-audit-subscription", "审计事件订阅", srs.filter(sr => sr.irId === "draft-audit-subscription"), true, "j00808875");
  const drafts = [group("demo-aurora", "draft-automation", "自动化工作流探索", srs.filter(sr => sr.irId === "draft-automation"), true),
    group("demo-aurora", "draft-notification", "团队通知与提醒", srs.filter(sr => sr.irId === "draft-notification"), true, "j00808876"),
    group("demo-mobile", "draft-mobile-search", "移动搜索体验", srs.filter(sr => sr.irId === "draft-mobile-search"), true, "j00808875"),
    reviewProposal, readyProposal, intakeProposal];
  drafts[1]!.proposalStage = "solution";
  drafts[1]!.sessions.push(sessionRef("demo-aurora", "draft-notification", "solution"));
  drafts[1]!.developerHandoff = { employeeId: "j00808876", submittedAt: "2026-11-10T09:30:00.000Z" };
  drafts[1]!.developerAcceptance = { employeeId: "j00808874", acceptedAt: "2026-11-10T09:35:00.000Z", round: 1 };
  drafts[1]!.createdAt = "2026-11-07T09:00:00.000Z";
  reviewProposal.createdAt = "2026-11-08T10:00:00.000Z";
  readyProposal.createdAt = "2026-11-09T11:00:00.000Z";
  intakeProposal.createdAt = "2026-11-06T08:00:00.000Z";
  for (const [proposal, employeeId, acceptedAt, generatedAt] of [
    [readyProposal, "j00808875", "2026-11-10T12:00:00.000Z", "2026-11-11T08:00:00.000Z"],
    [intakeProposal, "j00808877", "2026-11-10T14:00:00.000Z", "2026-11-10T15:00:00.000Z"],
  ] as const) {
    proposal.proposalStage = "solution";
    proposal.status = "solution-ready";
    proposal.sessions.push(sessionRef(proposal.projectId, proposal.id, "solution"));
    proposal.developerHandoff = { employeeId: proposal.proposalLocation!.employeeId, submittedAt: acceptedAt };
    proposal.developerAcceptance = { employeeId, acceptedAt, round: proposal.proposalRound! };
    proposal.srDependencyFile = prototypeProposalDependencies(proposal, srs.filter(sr => sr.projectId === proposal.projectId && sr.irId === proposal.id));
    const solution = prototypeProposalSolution(proposal);
    proposal.proposalSolution = { path: solution.path, employeeId, generatedAt, round: proposal.proposalRound!, valid: true, requirementsDigest: proposal.snapshot!.digest };
    proposal.files.push({ path: solution.path, sha256: solution.sha256, size: solution.size });
    proposal.files.push({ path: proposal.srDependencyFile.path, sha256: proposal.srDependencyFile.sha256, size: proposal.srDependencyFile.size });
  }
  // Match the existing confirm → push → manual PR actions; compute the candidate only
  // after all current requirement and solution file versions have been collected.
  const candidate = "sample-proposal-draft-audit-subscription-round-1";
  intakeProposal.proposalDelivery = {
    candidate, version: proposalVersion(intakeProposal), files: structuredClone(intakeProposal.files),
    confirmedBy: "j00808874", confirmedAt: "2026-11-10T16:00:00.000Z",
    pushedCandidate: candidate, pushedAt: "2026-11-10T16:10:00.000Z", prCandidate: candidate,
  };
  intakeProposal.confirmation = { operationId: "sample-confirm-draft-audit-subscription", snapshotDigest: intakeProposal.snapshot!.digest, confirmedAt: intakeProposal.proposalDelivery.confirmedAt };
  intakeProposal.requirementsPr = {
    url: "https://example.invalid/demo/pulls/43", sourceBranch: readPrototypeProposalPrHandoff(intakeProposal).branch,
    targetBranch: sharedSettings.projects.find(project => project.id === intakeProposal.projectId)!.defaultBranch,
    recordedAt: "2026-11-11T09:00:00.000Z", platformVerified: false,
  };
  intakeProposal.status = "requirements-pr";
  for (const item of [...groups, ...drafts]) {
    const rows = srs.filter(sr => sr.projectId === item.projectId && sr.irId === item.id);
    if (rows.some(sr => sr.startedAt)) item.developmentStartedAt = createdAt;
  }
  for (const item of [...groups, ...drafts]) item.releaseId = readPrototypeProjectReleases(item.projectId)[0]?.id ?? "";
  const materials = [...groups, ...drafts].flatMap(item => requirementMaterials(item.projectId, item.id, item.title, srs.filter(sr => sr.irId === item.id)));
  for (const item of [...groups, drafts[1]!, reviewProposal, readyProposal, intakeProposal]) item.review = createPrototypeRequirementsReview(item, "j00808874", true);
  drafts[1]!.review!.createdAt = "2026-11-09T09:00:00.000Z";
  reviewProposal.review!.passed = false; reviewProposal.review!.humanDecision = undefined;
  reviewProposal.review!.createdAt = "2026-11-10T11:00:00.000Z";
  readyProposal.review!.createdAt = "2026-11-10T11:30:00.000Z";
  intakeProposal.review!.createdAt = "2026-11-10T13:00:00.000Z";
  for (const item of groups) {
    item.srDependencyFile = prototypeProposalDependencies(item, srs.filter(sr => sr.projectId === item.projectId && sr.irId === item.id));
    const solution = prototypeProposalSolution(item);
    item.files.push({ path: solution.path, sha256: solution.sha256, size: solution.size });
    item.files.push({ path: item.srDependencyFile.path, sha256: item.srDependencyFile.sha256, size: item.srDependencyFile.size });
    item.merge = { commit: `sample-merged-${item.id}`, branch: "main", checkedAt: createdAt, files: structuredClone(item.files) };
    if (item.developmentStartedAt) freezePrototypeRequirement(item, "j00808874", item.developmentStartedAt);
  }
  if (prototypeRecoveryScenario === "proposal-feedback") {
    const proposal = drafts[1]!;
    proposal.proposalStage = "requirements"; proposal.proposalRound = 2;
    proposal.developerAcceptance = undefined; proposal.developerHandoff = undefined;
    proposal.returnFeedback = { employeeId: "j00808875", returnedAt: createdAt, reason: "方案 Agent 提问，开发暂时无法回答：\n1. 通知发送失败后，是否自动重试？重试次数和间隔由谁确定？\n2. 用户取消后，已发送的通知是否保留？\n请业务补充上述规则和验收行为，由业务 Agent 更新 IR／SR。" };
    proposal.sessions.push(sessionRef(proposal.projectId, proposal.id, "requirements", undefined, undefined, 2));
  }
  if (prototypeRecoveryScenario === "proposal-intake") {
    const proposal = drafts[1]!;
    proposal.srDependencyFile = prototypeProposalDependencies(proposal, srs.filter(sr => sr.projectId === proposal.projectId && sr.irId === proposal.id));
    const material = prototypeProposalSolution(proposal);
    proposal.status = "solution-ready";
    proposal.proposalSolution = { path: material.path, employeeId: "j00808874", generatedAt: createdAt, round: 1, valid: true, requirementsDigest: proposal.snapshot!.digest };
    proposal.files.push({ path: material.path, sha256: material.sha256, size: material.size });
    proposal.files.push({ path: proposal.srDependencyFile.path, sha256: proposal.srDependencyFile.sha256, size: proposal.srDependencyFile.size });
  }
  for (const proposal of drafts.filter(item => item.proposalStage === "solution" && !item.srDependencyFile)) {
    proposal.srDependencyFile = prototypeProposalDependencies(proposal, srs.filter(sr => sr.projectId === proposal.projectId && sr.irId === proposal.id));
    proposal.srDependencyFile.valid = false;
  }
  materials.push(...groups.map(prototypeProposalSolution), ...drafts.filter(item => item.proposalStage === "solution").map(prototypeProposalSolution));
  materials.push(...[...groups, ...drafts].flatMap(item => item.srDependencyFile ? [item.srDependencyFile] : []));
  materials.push(...srs.filter(sr => sr.status !== "pending").flatMap(sr => developmentMaterials(sr.projectId, sr.irId, sr.id, sr.title).filter(item => sr.materials.some(file => file.path === item.path))));
  if (prototypeRecoveryScenario === "review-chat") drafts[0]!.review = createPrototypeRequirementsReview(drafts[0]!, "j00808876");
  for (const group of [...groups, ...drafts]) {
    if (group.review) group.sessions.push(...prototypeReviewSessions(group.review));
  }
  const result: AIReqWorkflowView = { version: 1, revision: 12, ...sharedSettings, releases: readPrototypeProjectReleases(), currentProjectId: DEFAULT_SELECTION.projectId,
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
  // 同一 Release 五份共享 IR；验收样例来自其他 Web，不占当前 Web 的开发名额。
  const waiting = groups.find(item => item.id === "ir-export")!;
  waiting.ompWebId = "local-j00808875";
  const completed = groups.find(item => item.id === "ir-audit-archive")!;
  completed.ompWebId = "local-j00808877";
  applyIrAcceptanceAction(result, completed, { type: "startIrAcceptance" });
  applyIrAcceptanceAction(result, completed, { type: "generateIrAcceptanceReport", outcome: "passed" });
  applyIrAcceptanceAction(result, completed, { type: "prepareIrFinalPr" });
  applyIrAcceptanceAction(result, completed, { type: "publishIrFinalPr", candidate: completed.acceptance!.candidate });
  applyIrAcceptanceAction(result, completed, { type: "markIrFinalPrSubmitted", url: "https://example.invalid/demo/pulls/ir-audit-archive" });
  applyIrAcceptanceAction(result, completed, { type: "verifyIrFinalMerge", candidate: completed.acceptance!.candidate, filesConfirmed: true });
  const accepting = groups.find(item => item.id === "ir-notifications")!;
  accepting.ompWebId = "local-j00808876";
  applyIrAcceptanceAction(result, accepting, { type: "startIrAcceptance" });
  for (const [item, employeeId] of [[completed, "j00808877"], [accepting, "j00808876"]] as const) {
    item.acceptance!.employeeId = employeeId;
    item.acceptance!.worktree.path = `/demo/${employeeId}/aurora-console/.worktrees/${item.id}-acceptance`;
  }
  if (prototypeRecoveryScenario === "empty-releases" || prototypeRecoveryScenario === "empty-requirements") {
    result.groups = result.groups.filter(item => item.projectId !== "demo-aurora"); result.drafts = result.drafts.filter(item => item.projectId !== "demo-aurora");
    result.srs = result.srs.filter(item => item.projectId !== "demo-aurora"); result.materials = result.materials.filter(item => item.projectId !== "demo-aurora");
    result.sessions = result.sessions.filter(item => item.projectId !== "demo-aurora"); result.operations = []; result.changes = result.changes?.filter(item => item.projectId !== "demo-aurora");
  }
  return result;
}
let state = createPrototypeWorkflow();
// 正式 SR 的分支是平台已分配的必填映射；此处仅补齐初始内存样例，不在前端猜测。
for (const group of state.groups) {
  for (const sr of state.srs.filter(item => item.projectId === group.projectId && item.irId === group.id)) {
    sr.trackingBranch ??= { name: `sr/${sr.id}`, baseCommit: prototypeSrDefaultCommit(state, group.projectId), createdAt, pushedAt: createdAt };
  }
}
for (const sr of state.srs) if (sr.status === "developing") sr.ompWebId = "local-j00808874";
for (const group of state.groups) if (group.developmentStartedAt) group.ompWebId ??= "local-j00808874";
for (const group of state.drafts.filter(item => item.status === "requirements-pr" && hasCurrentProposalSolution(item))) {
  const candidate = `sample-pushed-${group.id}`;
  group.proposalDelivery = { candidate, version: proposalVersion(group), files: structuredClone(group.files), confirmedBy: group.developerAcceptance?.employeeId ?? "j00808874", confirmedAt: createdAt,
    pushedCandidate: candidate, pushedAt: createdAt, branch: { name: `ir/${group.id}`, baseCommit: prototypeSrDefaultCommit(state, group.projectId), createdAt, pushedAt: createdAt },
    mergeScenario: "unmerged", mergeCheck: { status: "waiting", message: "MR 已自动创建，等待人工评审合并与后台定时核验。" } };
  ensurePrototypeProposalMr(group);
}
export const prototypeWorkflowChanges = createPrototypeEvent<void>();
export function notifyPrototypeProjectSettingsChanged(): void {
  Object.assign(state, readPrototypeProjectSettings());
  prototypeWorkflowChanges.fire();
}
/** 仅写入内存样例；合入证据与文档完整性是自动入库的两项条件。 */
function completePrototypeProposal(group: AIReqRequirementGroup, checkedAt: string): void {
  const project = state.projects.find(item => item.id === group.projectId)!;
  const commit = `sample-proposal-merged-${state.revision}`;
  group.status = "formal";
  group.merge = { commit, branch: project.defaultBranch, checkedAt, files: structuredClone(group.files) };
  state.drafts = state.drafts.filter(item => item.id !== group.id || item.projectId !== group.projectId);
  if (!state.groups.some(item => item.id === group.id && item.projectId === group.projectId)) state.groups.push(group);
  group.revising = false;
  const revision = group.proposalRevisions?.at(-1);
  if (revision && !revision.completedAt) revision.completedAt = checkedAt;
  state.repositoryHeads ??= {};
  state.repositoryHeads[project.repositoryId] = commit;
  for (const sr of state.srs.filter(item => item.projectId === group.projectId && item.irId === group.id)) {
    sr.trackingBranch ??= { name: `sr/${sr.id}`, baseCommit: commit, createdAt: checkedAt, pushedAt: checkedAt };
  }
  freezePrototypeRequirement(group, "platform", checkedAt);
}

export function setPrototypeProposalMergeScenario(projectId: string, irId: string, scenario: AIReqProposalMergeScenario): void {
  const group = state.drafts.find(item => item.projectId === projectId && item.id === irId);
  if (!group?.proposalDelivery?.pushedAt) throw new Error("请先完成方案并推送提案分支。");
  if (!["unmerged", "merged", "incomplete", "failed", "mr-closed"].includes(scenario)) throw new Error("未知 MR 检查情景。");
  group.proposalDelivery.mergeScenario = scenario;
  prototypeWorkflowChanges.fire();
}

/** 原型五秒时钟只读取显式预置的 Git 结果，不连接 Git、PR API 或模型。 */
export function pollPrototypeProposalMerges(): void {
  let checked = false;
  for (const group of [...state.drafts]) {
    const delivery = group.proposalDelivery;
    if (group.status !== "requirements-pr" || !delivery?.pushedAt || delivery.pushedCandidate !== delivery.candidate) continue;
    checked = true;
    const at = new Date().toISOString();
    const nextCheckAt = new Date(Date.now() + 5000).toISOString();
    const scenario = delivery.mergeScenario ?? "unmerged";
    if (scenario === "failed") {
      delivery.mergeCheck = { status: "failed", checkedAt: at, nextCheckAt, message: "查询 MR 或读取默认分支失败，保留最后结果，下一轮定时重试。" };
      continue;
    }
    const mr = group.requirementsPr;
    if (!mr?.number || delivery.prCandidate !== delivery.candidate) {
      delivery.mergeCheck = { status: "failed", checkedAt: at, nextCheckAt, message: "当前候选缺少平台创建的 MR 记录，保留提案，不转正。" };
      continue;
    }
    if (scenario === "mr-closed") {
      mr.status = "closed";
      delivery.mergeCheck = { status: "unmerged", checkedAt: at, nextCheckAt, message: "MR 已关闭且未合入，保留提案，不转正。" };
      continue;
    }
    if (scenario === "unmerged") {
      mr.status = "opened";
      delivery.mergeCheck = { status: "unmerged", checkedAt: at, nextCheckAt, message: "MR 已创建，等待人工评审、合并；后台按计划核验合入与材料完整性。" };
      continue;
    }
    mr.status = "merged";
    const expected = [group.documentPath, ...group.srIds.map(id => state.srs.find(sr => sr.projectId === group.projectId && sr.irId === group.id && sr.id === id)?.documentPath), group.proposalSolution?.path, group.srDependencyFile?.path];
    const complete = hasCurrentProposalSolution(group) && delivery.version === proposalVersion(group) && !proposalDependencyMaterialIssue(group, state.materials) && expected.length >= 4 && expected.every(path => path && state.materials.some(material => material.projectId === group.projectId && material.irId === group.id && material.path === path && material.valid && !material.error && Boolean(material.content?.trim())));
    if (scenario === "incomplete" || !complete) {
      delivery.mergeCheck = { status: "incomplete", checkedAt: at, nextCheckAt, message: "已发现合入，但 IR、SR 或方案文档不完整（样例），保留提案，下一轮继续检查。" };
      continue;
    }
    delivery.mergeCheck = { status: "merged", checkedAt: at, message: "提案分支已合入且需求文档完整（样例），自动入库并创建、推送各 SR 分支。" };
    const operation = receipt("后台核验提案合入与文档完整性，自动入库并推送 SR 分支（内存演示）", ++state.revision, group.id);
    operation.startedAt = at; operation.completedAt = at;
    completePrototypeProposal(group, at);
    state.operations.push(operation);
  }
  if (checked) { state.revision += 1; prototypeWorkflowChanges.fire(); }
}

export function getPrototypeWorkflow(selection: AIReqSelection = DEFAULT_SELECTION): AIReqWorkflowView {
  const projectId = selection.projectId ?? DEFAULT_SELECTION.projectId;
  const sharedSettings = readPrototypeProjectSettings();
  return { ...state, ompWebId: PROTOTYPE_BACKEND.id, projects: sharedSettings.projects, currentProjectId: projectId,
    repositoryHeads: Object.fromEntries(sharedSettings.projects.map(project => [project.repositoryId, prototypeSrDefaultCommit(state, project.id)])),
    repositoryDevelopment: repositoryDevelopment({ ...state, ompWebId: PROTOTYPE_BACKEND.id, projects: sharedSettings.projects }, projectId ?? ""),
    releases: readPrototypeProjectReleases(projectId), groups: state.groups.filter(item => item.projectId === projectId),
    drafts: state.drafts.filter(item => item.projectId === projectId && (!item.pendingFirstMessage || item.id === selection.irId)), srs: state.srs.filter(item => item.projectId === projectId),
    materials: state.materials.filter(item => item.projectId === projectId).map(item => prototypeMaterialIssue(item.path) ? { ...item, error: prototypeMaterialIssue(item.path), content: undefined } : item),
    sessions: state.sessions.filter(item => item.projectId === projectId && !prototypeSessionReadIssue(item.sessionId)),
    operations: state.operations.filter(item => !item.irId || [...state.groups, ...state.drafts].some(group => group.projectId === projectId && group.id === item.irId)),
    changes: state.changes?.filter(item => item.projectId === projectId),
    selected: selection.irId && projectId ? { projectId, irId: selection.irId, ...(selection.srId ? { srId: selection.srId } : {}) } : undefined,
  };
}
/** 提案内的 IR/SR 是查看目标；业务需求会话始终归属于整份提案。 */
export function resolvePrototypeSession(view: AIReqWorkflowView, selection: AIReqSelection): AIReqNativeSessionRef | undefined {
  if (!selection.irId) return;
  const projectId = selection.projectId ?? view.currentProjectId;
  const sr = view.srs.find(item => item.projectId === projectId && item.id === selection.srId && item.irId === selection.irId);
  if (selection.srId && !sr) return;
  if (selection.irAcceptance) return view.groups.find(item => item.id === selection.irId)?.acceptance?.session;
  const proposal = view.drafts.find(item => item.projectId === projectId && item.id === selection.irId);
  if (proposal && !selection.srId && proposalViewedIndex(proposal, selection) === 1) {
    const reviewer = proposal.review?.agents?.find(agent => agent.id === (selection.reviewAgent ?? "summary"))?.session ?? proposal.review?.reviewer;
    return reviewer && "projectId" in reviewer ? reviewer : undefined;
  }
  if (proposal) return proposal.sessions.filter(item => item.projectId === projectId && item.irId === proposal.id && !item.srId && item.role !== "reviewer" && item.phase === (selection.discussionPhase ?? proposal.proposalStage ?? "requirements")).sort((a, b) => b.round - a.round)[0];
  if (selection.srId && !sr?.stage) return;
  const phase = selection.stage ?? sr?.stage ?? "requirements";
  const candidates = view.sessions.filter(item => item.projectId === projectId && item.irId === selection.irId && item.srId === selection.srId && item.phase === phase);
  if (!sr) return candidates.sort((a, b) => b.round - a.round)[0];
  if (selection.stageRound !== undefined) return candidates.find(item => item.round === selection.stageRound);
  return candidates.sort((a,b) => b.round - a.round)[0];
}
export function getPrototypeSession(selection: AIReqSelection = DEFAULT_SELECTION): AIReqNativeSessionRef | undefined {
  return resolvePrototypeSession(getPrototypeWorkflow(selection), selection);
}
export function getPrototypeMaterial(selection: AIReqSelection, path: string): AIReqMaterialView | undefined {
  return getPrototypeWorkflow(selection).materials.find(item => item.irId === selection.irId && item.path === path && (!item.srId || item.srId === selection.srId));
}
/** Small UI-only transitions, not backend workflow approvals or an execution engine. */
export function applyPrototypeAction(action: AIReqAction, selection: AIReqSelection, solutionDiscussion?: string): AIReqWorkflowResult {
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
  if (action.type === "setSharedProjectRoot") {
    if (getEmployeeId() !== "j00808874") throw new Error("只有管理员 j00808874 可修改共享项目路径。");
    const check = checkPrototypeSharedProjectDirectory(action.root, action.projectId);
    if (!check.valid) throw new Error(check.error);
  }
  if (action.type === "setDevelopmentRoot") {
    const project = state.projects.find(item => item.id === targetProjectId);
    if (!project) throw new Error("请选择已有项目。");
    const check = checkPrototypeDevelopmentDirectory(action.root, project.root);
    if (!check.valid) throw new Error(check.error);
  }
  const targetSr = state.srs.find(item => item.projectId === targetProjectId && item.irId === (action.irId ?? selection.irId) && item.id === (action.srId ?? selection.srId));
  if (["startSr", "generateStageMaterials", "approveStage", "backStage", "markCodePrSubmitted", "markCodeMerged"].includes(action.type)) {
    if (!isEmployeeId(getEmployeeId())) throw new Error("请先输入有效工号。");
    if (!targetSr) throw new Error("请选择当前项目的有效 SR。");
    if (action.type === "startSr") {
      if (targetSr.status !== "pending") throw new Error("此 SR 已开始或完成，不能重复接手开发。");
      const formal = state.groups.find(group => group.projectId === targetProjectId && group.id === targetSr.irId);
      if (!formal) throw new Error("请选择正式需求中的 SR。");
      const blocker = srStartBlocker(getPrototypeWorkflow({ projectId: targetProjectId }), formal, targetSr);
      if (blocker) throw new Error(blocker);
    } else {
      if (targetSr.developerEmployeeId !== getEmployeeId()) throw new Error("当前 SR 由其他同事开发，可查看材料与讨论，不能代为推进或提交。");
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
    const reason = stageMaterialBlocker(targetSr, getPrototypeWorkflow({ projectId: targetProjectId }).materials); if (reason) throw new Error(reason);
  }
  if (action.type === "generateStageMaterials" && (!targetSr || action.stage !== targetSr.stage || action.round !== targetSr.round)) throw new Error("只能生成实际阶段和当前轮次的材料。");
  if (action.type === "backStage" && (!targetSr?.stage || action.fromStage !== targetSr.stage || action.round !== targetSr.round || stages.indexOf(action.stage) >= stages.indexOf(targetSr.stage))) throw new Error("只允许从实际阶段返回之前的阶段；重复、过期或向前跳转已拒绝。");
  if (["markCodePrSubmitted", "markCodeMerged"].includes(action.type) && targetSr?.stage !== "pr") throw new Error("请在实际交付 PR 阶段记录代码交付。");
  if (action.type === "startSr") {
    const formal = state.groups.find(item => item.projectId === targetProjectId && item.id === (action.irId ?? selection.irId));
    if (!formal || !["formal", "frozen"].includes(formal.status) || !hasCurrentProposalSolution(formal) || !formal.merge) throw new Error("需求 PR 合并且默认分支包含需求与方案后，才能开始 SR 开发计划。");
  }
  if (action.type === "startSr" && !readPrototypeDevelopmentRoot(targetProjectId!)) {
    throw new Error("请先在设置 → AIReq 项目与 Release 中添加本项目的个人开发项目路径。");
  }
  if (targetSr && ["generateStageMaterials", "approveStage", "backStage", "markCodePrSubmitted", "markCodeMerged", "stop"].includes(action.type) && targetSr.status !== "pending" && (!targetSr.worktree?.path || !targetSr.developmentRoot)) throw new Error("该 SR 的固定开发目录记录不完整，请先恢复原绑定；不会回落到共享项目目录。");
  if (targetSr && action.type === "stop" && targetSr.developerEmployeeId !== getEmployeeId()) throw new Error("当前 SR 由其他同事开发，不能代为停止任务。");
  if (isPrototypeSrDeliveryAction(action)) validatePrototypeSrDeliveryAction(getPrototypeWorkflow({ projectId: targetProjectId }), targetSr, action, selection);
  const formalTarget = state.groups.find(item => item.projectId === targetProjectId && item.id === (action.irId ?? selection.irId));
  if (formalTarget && (["startSr", "generateStageMaterials", "approveStage", "backStage", "markCodePrSubmitted", "markCodeMerged"].includes(action.type) || isIrAcceptanceAction(action) || isPrototypeSrDeliveryAction(action))) {
    const issue = requirementFreezeIssue(formalTarget);
    if (issue) throw new Error(issue);
  }
  const targetProposal = state.drafts.find(item => item.projectId === targetProjectId && item.id === (action.irId ?? selection.irId));
  const proposalAction = ["submitProposalReview", "acceptProposal", "runRequirementsReview", "generateRequirements", "supplementRequirements", "generateProposalSolution", "returnProposal", "recordRequirementsDecision"].includes(action.type) || isPrototypeProposalDeliveryAction(action);
  if (proposalAction) {
    if (!targetProposal) throw new Error("请选择需求提案，不能对正式需求重复执行提案动作。");
    if (!isEmployeeId(getEmployeeId())) throw new Error("请先输入有效工号。");
  }
  if (targetProposal && ["submitProposalReview", "acceptProposal", "generateProposalSolution", "markRequirementsPrSubmitted", "markRequirementsMerged"].includes(action.type)) {
    const blocker = action.type === "acceptProposal" ? requirementsReviewReadyBlocker(targetProposal) : requirementsReviewBlocker(targetProposal);
    if (blocker) throw new Error(blocker);
  }
  if (action.type === "runRequirementsReview") {
    const blocker = targetProposal && requirementsReviewStartBlocker(targetProposal);
    if (blocker) throw new Error(blocker);
    prototypeReviewModelBindings();
  }
  if (action.type === "acceptProposal" && targetProposal?.review?.agents && (action.reviewId !== targetProposal.review.id || action.snapshotDigest !== targetProposal.review.snapshotDigest)) throw new Error("人工通过须绑定当前综合意见和需求版本，请刷新后重新判断。");
  if (action.type === "acceptProposal" && (targetProposal?.proposalStage !== "requirements" || targetProposal.status !== "draft")) throw new Error("请先完成当前需求版本的评审，再进入技术方案。");
  if (action.type === "acceptProposal" && targetProposal?.developerAcceptance?.round === (targetProposal?.proposalRound ?? 1)) throw new Error("本轮提案已有接手开发人员，不能重复接手或覆盖他人的记录。");
  if (action.type === "runRequirementsReview" && targetProposal?.status === "requirements-pr") throw new Error("PR 已提交，本轮仅支持提交 PR 前的需求评审。");
  if ((action.type === "generateRequirements" || action.type === "supplementRequirements") && (targetProposal?.proposalStage !== "requirements" || targetProposal.status !== "draft" || !action.note.trim())) throw new Error("请在业务需求阶段填写明确的需求内容。");
  if (action.type === "generateRequirements" && targetProposal?.srIds.length) throw new Error("本提案已有 SR，请补充当前需求，不重复生成或覆盖已有拆分。");
  if (action.type === "supplementRequirements" && !targetProposal?.srIds.length) throw new Error("请先生成 IR／SR，再补充需求。");
  if (action.type === "submitProposalReview" && (targetProposal?.status !== "draft" || targetProposal.proposalStage !== "requirements")) throw new Error("仅业务需求阶段的草稿可交给开发评审，无需预先生成方案。");
  if (action.type === "generateProposalSolution" && (!targetProposal?.srIds.length || targetProposal.proposalStage !== "solution" || !["draft", "solution-ready"].includes(targetProposal.status))) throw new Error("请先完成 IR／SR 并交给开发，在方案阶段生成方案。");
  if (action.type === "returnProposal" && (!targetProposal || targetProposal.status === "requirements-pr" || !["draft", "solution-ready"].includes(targetProposal.status) || !(targetProposal.proposalStage === "solution" || (targetProposal.proposalStage === "requirements" && requirementsReviewCurrent(targetProposal))) || !action.reason.trim())) throw new Error("请在当前需求评审或提交 PR 前的方案阶段填写业务需补充的细节，再打回提案。");
  if (isPrototypeProposalDeliveryAction(action) && targetProposal) validatePrototypeProposalDeliveryAction(getPrototypeWorkflow({ projectId: targetProjectId }), targetProposal, action);
  if (action.type === "recordRequirementsDecision") {
    if (targetProposal?.status !== "draft" || targetProposal.proposalStage !== "requirements" || !requirementsReviewCurrent(targetProposal) || targetProposal.review?.id !== action.reviewId || targetProposal.snapshot?.digest !== action.snapshotDigest) throw new Error("裁决页面对应旧评审或非当前业务需求阶段，请重新查看当前评审。");
    if (!action.opinion.trim() || !action.result.trim()) throw new Error("请填写人工意见、裁决依据及处理结果。");
  }
  if (action.type === "beginProposalRevision") {
    if (!isEmployeeId(getEmployeeId())) throw new Error("请先输入有效工号。");
    if (!formalTarget) throw new Error("请选择已入库的正式提案。");
    const blocker = proposalRevisionBlocker(getPrototypeWorkflow({ projectId: targetProjectId }), formalTarget);
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
    case "setSharedProjectRoot":
      updatePrototypeSharedProjectRoot(action.projectId, action.root);
      Object.assign(state, readPrototypeProjectSettings());
      break;
    case "setDevelopmentRoot":
      savePrototypeDevelopmentRoot(projectId, action.root.trim().replace(/\/+$/, ""));
      break;
    case "createRelease":
      addPrototypeRelease({ id: `demo-release-${state.revision}`, projectId, title: action.title.trim(), createdAt });
      state.releases = readPrototypeProjectReleases();
      break;
    case "createProposal": {
      const existing = action.clientDraftId ? state.drafts.find(item => item.pendingFirstMessage && item.clientDraftId === action.clientDraftId && item.projectId === projectId && item.releaseId === action.releaseId) : undefined;
      if (existing) { irId = existing.id; operation.irId = irId; break; }
      irId = `draft-demo-${state.revision}`;
      const item = group(projectId, irId, "新需求提案（样例）", [], true, getEmployeeId());
      item.origin = "browser";
      item.clientDraftId = action.clientDraftId;
      item.pendingFirstMessage = Boolean(action.clientDraftId);
      if (item.pendingFirstMessage) item.title = "未发送草稿";
      item.releaseId = action.releaseId;
      state.drafts.push(item); state.sessions.push(...item.sessions);
      if (!item.pendingFirstMessage) state.materials.push(...requirementMaterials(projectId, irId, item.title, []));
      operation.irId = irId;
      break;
    }
    case "beginProposalRevision": {
      const proposal = currentGroup!;
      proposal.proposalRevisions ??= [];
      proposal.proposalRevisions.push({
        reason: action.reason.trim(), employeeId: getEmployeeId(), startedAt: new Date().toISOString(),
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
      proposal.proposalLocation ??= prototypeProposalLocation(projectId, getEmployeeId());
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
    case "submitProposalReview":
      currentGroup!.developerHandoff = { employeeId: getEmployeeId(), submittedAt: new Date().toISOString() };
      currentGroup!.developerAcceptance = undefined;
      operation.type = `由 ${getEmployeeId()} 交给开发，保留业务需求阶段等待接手（原型）`;
      break;
    case "acceptProposal": {
      currentGroup!.review!.passed = true;
      currentGroup!.review!.humanDecision = { employeeId: getEmployeeId(), decidedAt: new Date().toISOString(), reviewId: currentGroup!.review!.id };
      currentGroup!.proposalStage = "solution";
      currentGroup!.developerHandoff ??= { employeeId: getEmployeeId(), submittedAt: new Date().toISOString() };
      currentGroup!.developerAcceptance = { employeeId: getEmployeeId(), acceptedAt: new Date().toISOString(), round: currentGroup!.proposalRound ?? 1 };
      if (!currentGroup!.sessions.some(item => item.phase === "solution" && item.round === (currentGroup!.proposalRound ?? 1))) {
        const session = sessionRef(projectId, currentGroup!.id, "solution", undefined, undefined, currentGroup!.proposalRound ?? 1);
        currentGroup!.sessions.push(session); state.sessions.push(session);
      }
      operation.type = `由 ${getEmployeeId()} 人工通过当前综合意见并进入技术方案（原型）`;
      break;
    }
    case "runRequirementsReview": {
      if (currentGroup!.review) { currentGroup!.reviewHistory ??= []; currentGroup!.reviewHistory.push(structuredClone(currentGroup!.review)); }
      currentGroup!.revision += 1;
      currentGroup!.review = createPrototypeRequirementsReview(currentGroup!, getEmployeeId());
      const reviewers = prototypeReviewSessions(currentGroup!.review);
      currentGroup!.sessions.push(...reviewers); state.sessions.push(...reviewers);
      operation.type = "三模型并行评审后由第四个 Agent 综合意见，等待人工判断（固定样例，未调用模型）";
      break;
    }
    case "recordRequirementsDecision":
      currentGroup!.requirementsDecisions ??= [];
      currentGroup!.requirementsDecisions.push({
        reviewId: action.reviewId, snapshotDigest: action.snapshotDigest,
        inputFiles: structuredClone(requirementsReviewInputs(currentGroup!)!),
        opinion: action.opinion.trim(), outcome: action.outcome, result: action.result.trim(),
        employeeId: getEmployeeId(), createdAt: new Date().toISOString(), review: structuredClone(currentGroup!.review!),
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
        proposal.requirementSupplements.push({ note, employeeId: getEmployeeId(), createdAt: new Date().toISOString(), round: proposal.proposalRound });
        if (proposal.returnFeedback && !proposal.returnFeedback.resumedAt) proposal.returnFeedback.resumedAt = new Date().toISOString();
      }
      proposal.developerHandoff = undefined;
      proposal.developerAcceptance = undefined;
      proposal.confirmation = undefined;
      proposal.revision += 1;
      if (proposal.proposalSolution) proposal.proposalSolution.valid = false;
      if (proposal.srDependencyFile) proposal.srDependencyFile.valid = false;
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
        files: structuredClone(proposal.files.filter(file => file.path !== proposal.proposalSolution?.path && file.path !== proposal.srDependencyFile?.path)),
        digest: `sample-digest:${projectId}:${irId}:revision-${proposal.revision}`,
      };
      operation.type = action.type === "generateRequirements" ? "根据输入生成 IR 与两个 SR（固定模板演示，未调用模型）" : `由 ${getEmployeeId()} 补充 IR／SR，旧评审与方案需重新确认（原型）`;
      break;
    }
    case "generateProposalSolution": {
      const dependencyFile = prototypeProposalDependencies(currentGroup!, state.srs.filter(sr => sr.projectId === projectId && sr.irId === irId), solutionDiscussion);
      dependencyFile.sha256 = `sample:${dependencyFile.path}:revision-${state.revision}`;
      currentGroup!.srDependencyFile = dependencyFile;
      const material = prototypeProposalSolution(currentGroup!, solutionDiscussion);
      material.sha256 = `sample:${material.path}:revision-${state.revision}`;
      currentGroup!.proposalSolution = { path: material.path, employeeId: getEmployeeId(), generatedAt: new Date().toISOString(), round: currentGroup!.proposalRound ?? 1, valid: true, requirementsDigest: currentGroup!.snapshot?.digest };
      currentGroup!.status = "solution-ready";
      currentGroup!.confirmation = undefined;
      state.materials = state.materials.filter(item => item.projectId !== projectId || item.irId !== irId || item.kind !== "solution");
      state.materials.push(material, dependencyFile);
      currentGroup!.files = [...currentGroup!.files.filter(item => item.path !== material.path && item.path !== dependencyFile.path), ...[material, dependencyFile].map(({ path, sha256, size }) => ({ path, sha256, size }))];
      operation.type = "方案 Agent 对话完成，同步技术方案、SR 依赖及工期预估（内存原型）";
      break;
    }
    case "returnProposal": {
      currentGroup!.proposalStage = "requirements"; currentGroup!.status = "draft";
      currentGroup!.proposalRound = (currentGroup!.proposalRound ?? 1) + 1;
      currentGroup!.developerAcceptance = undefined;
      currentGroup!.developerHandoff = undefined;
      currentGroup!.confirmation = undefined;
      if (currentGroup!.returnFeedback) { currentGroup!.returnFeedbackHistory ??= []; currentGroup!.returnFeedbackHistory.push(structuredClone(currentGroup!.returnFeedback)); }
      currentGroup!.returnFeedback = { employeeId: getEmployeeId(), returnedAt: new Date().toISOString(), reason: action.reason.trim() };
      if (currentGroup!.proposalSolution) currentGroup!.proposalSolution.valid = false;
      if (currentGroup!.srDependencyFile) currentGroup!.srDependencyFile.valid = false;
      state.materials.filter(item => item.projectId === projectId && item.irId === irId && item.kind === "solution").forEach(item => { item.valid = false; });
      operation.type = "开发粘贴待处理意见，直接返回业务 Agent 补充（原型）";
      break;
    }
    case "confirmProposal": {
      const proposal = currentGroup!;
      if (proposal.proposalDelivery) {
        proposal.proposalDeliveryHistory ??= [];
        proposal.proposalDeliveryHistory.push(structuredClone(proposal.proposalDelivery));
      }
      proposal.proposalDelivery = {
        candidate: `sample-proposal-${state.revision}`, version: proposalVersion(proposal),
        files: structuredClone(proposal.files), confirmedBy: getEmployeeId(), confirmedAt: new Date().toISOString(),
      };
      proposal.confirmation = { operationId: operation.operationId, snapshotDigest: proposal.snapshot!.digest, confirmedAt: proposal.proposalDelivery.confirmedAt };
      proposal.requirementsPr = undefined;
      operation.type = "人工确认当前 IR／全部 SR／方案版本（演示）";
      break;
    }
    case "publishProposal": {
      const group = currentGroup!;
      const delivery = group.proposalDelivery!;
      if (delivery.pushedCandidate === action.candidate && group.requirementsPr?.number && delivery.prCandidate === action.candidate) {
        operation.type = "当前候选已有 MR，复用既有记录，不重复创建（内存演示）";
        break;
      }
      const at = new Date().toISOString();
      delivery.branch ??= { name: readPrototypeProposalPrHandoff(group).branch, baseCommit: prototypeSrDefaultCommit(state, projectId), createdAt: at, pushedAt: at };
      delivery.pushedCandidate = action.candidate;
      delivery.pushedAt = at;
      ensurePrototypeProposalMr(group);
      delivery.mergeScenario = "unmerged";
      delivery.mergeCheck = { status: "waiting", nextCheckAt: new Date(Date.now() + 5000).toISOString(), message: "分支已推送并自动创建 MR，等待人工评审合并；后台定时核验，不需要登记地址或人工通知。" };
      group.status = "requirements-pr";
      operation.type = "确认材料后创建分支、提交推送、自动创建 MR 并开始后台定时核验（内存演示）";
      break;
    }
    case "markRequirementsPrSubmitted": case "markCodePrSubmitted": {
      const fact = { url: action.url, sourceBranch: action.type === "markRequirementsPrSubmitted" && currentGroup ? readPrototypeProposalPrHandoff(currentGroup).branch : sr?.worktree?.branch ?? currentGroup?.worktree?.branch ?? "demo/sample", targetBranch: state.projects.find(item => item.id === projectId)?.defaultBranch ?? "main", recordedAt: new Date().toISOString(), platformVerified: false as const };
      if (action.type === "markCodePrSubmitted" && sr) sr.codePr = fact;
      else if (currentGroup && action.type === "markRequirementsPrSubmitted") { currentGroup.requirementsPr = fact; currentGroup.proposalDelivery!.prCandidate = action.candidate; currentGroup.status = "requirements-pr"; }
      break;
    }
    case "markRequirementsMerged": if (currentGroup) {
      completePrototypeProposal(currentGroup, new Date().toISOString());
      operation.type = "提案合入且文档完整，转为正式需求并推送各 SR 分支（样例）";
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
        sr.materials = sr.materials.filter(old => old.path !== item.path); sr.materials.push({ path: item.path, sha256: item.sha256, size: item.size, stage: sr.stage, kind: item.kind as AIReqStageMaterial["kind"], round: sr.round, valid: true });
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
        if (action.type === "startSr") { freezePrototypeRequirement(currentGroup!, getEmployeeId(), new Date().toISOString()); sr.ompWebId = PROTOTYPE_BACKEND.id; currentGroup!.ompWebId = PROTOTYPE_BACKEND.id; sr.round = 1; sr.developerEmployeeId = getEmployeeId(); sr.startedAt = new Date().toISOString(); sr.developmentRoot = readPrototypeDevelopmentRoot(projectId)!; }
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

/** 只有首条消息实际进入会话后，待接纳条目才进入共享提案列表。 */
export function publishPrototypeProposalForSession(sessionId: string): void {
  const item = state.drafts.find(group => group.pendingFirstMessage && group.sessions.some(session => session.sessionId === sessionId));
  if (!item) return;
  item.pendingFirstMessage = false;
  if (item.title === "未发送草稿") item.title = "新需求提案 · 整理中（样例）";
  state.revision += 1;
  prototypeWorkflowChanges.fire();
}
