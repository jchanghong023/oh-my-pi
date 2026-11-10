import { developmentMaterials, requirementMaterials } from "./materials.js";
import { checkPrototypeProjectDirectory } from "./project-directories.js";
import { readPrototypeProjectSettings, addPrototypeProject } from "./project-settings.js";
import { readPrototypeProjectReleases, addPrototypeRelease } from "./project-releases.js";
import type {
  DevAction, DevMaterialView, DevNativeSessionRef, DevOperationReceipt, DevRequirementGroup,
  DevSelection, DevStageMaterial, DevSystemRequirement, DevWorkflowResult, DevWorkflowStage, DevWorkflowView,
} from "./types.js";

export const DEFAULT_SELECTION: DevSelection = { projectId: "demo-aurora", irId: "ir-auth", srId: "sr-auth" };
export const PROTOTYPE_WORKSPACE_IDENTITY = "dev-ui-prototype";
export const PROTOTYPE_RELEASE_ID = "release-2026-11";
const createdAt = "2026-11-10T09:00:00.000Z";
const stages: DevWorkflowStage[] = ["solution", "planning", "executing", "pr"];
const phaseSessions = { solution: "demo-solution", planning: "demo-planning", executing: "demo-executing", pr: "demo-pr" };
function sessionRef(projectId: string, irId: string, phase: DevNativeSessionRef["phase"], srId?: string, preferred?: string): DevNativeSessionRef {
  const sessionId = preferred ?? `${projectId}-${irId}-${srId ?? "ir"}-${phase}`;
  return { projectId, irId, ...(srId ? { srId } : {}), sessionId, sessionFile: `/demo/sessions/${sessionId}.jsonl`, role: phase, phase, round: 1 };
}
function receipt(type: string, revision: number, irId?: string, srId?: string): DevOperationReceipt {
  return { operationId: `sample-operation-${revision}`, commandDigest: `sample:${type}:${revision}`, type,
    status: "completed", startedAt: createdAt, completedAt: createdAt, revision, irId, srId,
    steps: [{ name: "prototype", at: createdAt, detail: `前端样例：${type}。仅展示本地 UI 状态，未执行 OMP、Git、模型、测试或真实审批。` }] };
}
function group(projectId: string, id: string, title: string, rows: DevSystemRequirement[], draft = false): DevRequirementGroup {
  const materials = requirementMaterials(projectId, id, title, rows);
  const files = materials.map(({ path, sha256, size }) => ({ path, sha256, size }));
  const digest = `sample-digest:${projectId}:${id}`;
  const requirementsSession = sessionRef(projectId, id, "requirements", undefined,
    projectId === "demo-aurora" && id === "ir-auth" ? "demo-requirements" : undefined);
  return { id, projectId, releaseId: PROTOTYPE_RELEASE_ID, title, documentPath: `requirements/${id}/IR.md`,
    origin: "local", status: draft ? "draft" : "frozen", revision: 1, srIds: rows.map(row => row.id), files,
    sessions: [requirementsSession], createdAt, worktree: { path: `/demo/worktrees/${projectId}/${id}`, branch: `demo/requirements/${id}`, baseCommit: "sample-base" },
    snapshot: { version: 1, projectId, irId: id, title, srs: rows.map(({ id: srId, title: srTitle, documentPath }) => ({ id: srId, title: srTitle, documentPath })),
      documentPath: `requirements/${id}/IR.md`, files, digest },
    ...(!draft ? {
      confirmation: { operationId: `sample-confirm-${id}`, snapshotDigest: digest, confirmedAt: createdAt },
      review: { id: `sample-review-${id}`, snapshotDigest: digest, passed: true,
        report: "前端审核展示样例：需求边界、拆分关系和交互资料齐全。此记录不是实际审核结论，真实审核留待后续 OMP 对接阶段。",
        reviewer: { sessionId: `sample-reviewer-${id}`, role: "reviewer" as const, sourceProjectId: projectId, imported: true as const }, createdAt },
    } : {}),
  };
}
function systemRequirement(projectId: string, irId: string, id: string, title: string, stage?: DevWorkflowStage, completed = false, preferred = false): DevSystemRequirement {
  const materials = developmentMaterials(projectId, irId, id, title);
  const sessions = stage || completed ? stages.map(phase => sessionRef(projectId, irId, phase, id,
    preferred && phase === stage ? phaseSessions[phase] : undefined)) : [];
  return { id, projectId, irId, title, documentPath: `requirements/${irId}/${id}/SR.md`,
    status: completed ? "completed" : stage ? "developing" : "pending", stage, round: stage || completed ? 1 : 0,
    sessions, approvals: [], materials: stage || completed ? materials.map(item => ({
      path: item.path, sha256: item.sha256, size: item.size, stage: item.stage!, kind: item.kind as DevStageMaterial["kind"], round: 1, valid: true,
    })) : [], materialDigest: stage || completed ? `sample-materials:${id}` : undefined,
    ...(stage || completed ? { worktree: { path: `/demo/worktrees/${projectId}/${id}`, branch: `demo/${id}`, baseCommit: "sample-base" } } : {}),
    ...(stage === "pr" || completed ? { codePr: { url: `https://example.invalid/demo/pulls/${completed ? "42" : "41"}`, sourceBranch: `demo/${id}`,
      targetBranch: "main", recordedAt: createdAt, platformVerified: false as const } } : {}),
  };
}
export function createPrototypeWorkflow(): DevWorkflowView {
  const personalSettings = readPrototypeProjectSettings();
  const srs = [
    systemRequirement("demo-aurora", "ir-auth", "sr-auth", "统一登录与会话管理", "solution", false, true),
    systemRequirement("demo-aurora", "ir-auth", "sr-session", "会话恢复与设备管理", "planning", false, true),
    systemRequirement("demo-aurora", "ir-auth", "sr-permissions", "角色权限与访问边界", "executing", false, true),
    systemRequirement("demo-aurora", "ir-auth", "sr-audit", "操作审计与交付", "pr", false, true),
    systemRequirement("demo-aurora", "ir-auth", "sr-onboarding", "首次登录引导（已完成示例）", undefined, true),
    systemRequirement("demo-aurora", "ir-dashboard", "sr-dashboard", "指标概览与趋势卡片"),
    systemRequirement("demo-aurora", "ir-dashboard", "sr-dashboard-filters", "筛选器与空态"),
    systemRequirement("demo-mobile", "ir-mobile", "sr-mobile-navigation", "移动导航与项目切换", "solution"),
    systemRequirement("demo-mobile", "ir-mobile", "sr-mobile-notifications", "通知列表与阅读状态", "executing"),
    systemRequirement("demo-mobile", "ir-mobile", "sr-mobile-profile", "个人资料卡片（已完成示例）", undefined, true),
    systemRequirement("demo-mobile", "ir-mobile-offline", "sr-mobile-offline", "离线提示与重新进入"),
  ];
  const groups = [group("demo-aurora", "ir-auth", "账号与权限体验", srs.filter(sr => sr.irId === "ir-auth")),
    group("demo-aurora", "ir-dashboard", "团队数据总览", srs.filter(sr => sr.irId === "ir-dashboard")),
    group("demo-mobile", "ir-mobile", "移动协作工作台", srs.filter(sr => sr.irId === "ir-mobile")),
    group("demo-mobile", "ir-mobile-offline", "移动端离线体验", srs.filter(sr => sr.irId === "ir-mobile-offline"))];
  const drafts = [group("demo-aurora", "draft-automation", "自动化工作流探索", [], true), group("demo-mobile", "draft-mobile-search", "移动搜索体验草稿", [], true)];
  for (const item of [...groups, ...drafts]) item.releaseId = readPrototypeProjectReleases(item.projectId)[0]?.id ?? "";
  const materials = [...groups, ...drafts].flatMap(item => requirementMaterials(item.projectId, item.id, item.title, srs.filter(sr => sr.irId === item.id)));
  materials.push(...srs.filter(sr => sr.status !== "pending").flatMap(sr => developmentMaterials(sr.projectId, sr.irId, sr.id, sr.title)));
  return { version: 1, revision: 12, ...personalSettings, releases: readPrototypeProjectReleases(), currentProjectId: DEFAULT_SELECTION.projectId,
    groups, drafts, srs, materials, operations: [receipt("需求样例整理", 1, "ir-auth"), receipt("方案样例准备", 2, "ir-auth", "sr-auth"),
      receipt("计划样例准备", 3, "ir-auth", "sr-session"), receipt("验证报告展示", 4, "ir-auth", "sr-permissions"),
      receipt("交付信息展示", 5, "ir-auth", "sr-audit"), receipt("完成状态展示", 6, "ir-auth", "sr-onboarding"),
      receipt("需求样例整理", 7, "ir-dashboard"), receipt("草稿样例创建", 8, "draft-automation"),
      receipt("移动工作台样例", 9, "ir-mobile", "sr-mobile-navigation"), receipt("离线体验草稿", 10, "ir-mobile-offline")],
    sessions: [...groups, ...drafts].flatMap(item => item.sessions).concat(srs.flatMap(sr => sr.sessions)),
    selected: { projectId: "demo-aurora", irId: "ir-auth" }, running: [], changes: materials.map(item => ({
      path: item.path, sha256: item.sha256, size: item.size, projectId: item.projectId, irId: item.irId, srId: item.srId, status: "M（样例）",
    })),
  };
}
let state = createPrototypeWorkflow();
export function getPrototypeWorkflow(selection: DevSelection = DEFAULT_SELECTION): DevWorkflowView {
  const projectId = selection.projectId ?? DEFAULT_SELECTION.projectId;
  const personalSettings = readPrototypeProjectSettings();
  return { ...state, projects: personalSettings.projects, currentProjectId: projectId,
    activeSrId: state.srs.find(item => item.projectId === projectId && item.status === "developing")?.id,
    releases: readPrototypeProjectReleases(projectId), groups: state.groups.filter(item => item.projectId === projectId),
    drafts: state.drafts.filter(item => item.projectId === projectId), srs: state.srs.filter(item => item.projectId === projectId),
    materials: state.materials.filter(item => item.projectId === projectId),
    sessions: state.sessions.filter(item => item.projectId === projectId),
    operations: state.operations.filter(item => !item.irId || [...state.groups, ...state.drafts].some(group => group.projectId === projectId && group.id === item.irId)),
    changes: state.changes?.filter(item => item.projectId === projectId),
    selected: selection.irId && projectId ? { projectId, irId: selection.irId, ...(selection.srId ? { srId: selection.srId } : {}) } : undefined,
  };
}
export function getPrototypeSession(selection: DevSelection = DEFAULT_SELECTION): DevNativeSessionRef | undefined {
  const view = getPrototypeWorkflow(selection);
  const sr = view.srs.find(item => item.id === selection.srId && item.irId === selection.irId);
  if (selection.srId && (!sr?.stage || sr.status === "completed")) return;
  return view.sessions.find(item => item.irId === selection.irId && item.srId === selection.srId && item.phase === (sr?.stage ?? "requirements") && (!sr || item.round === sr.round));
}
export function getPrototypeMaterial(selection: DevSelection, path: string): DevMaterialView | undefined {
  return getPrototypeWorkflow(selection).materials.find(item => item.irId === selection.irId && item.path === path && (!item.srId || item.srId === selection.srId));
}
/** Small UI-only transitions, not backend workflow approvals or an execution engine. */
export function applyPrototypeAction(action: DevAction, selection: DevSelection): DevWorkflowResult {
  if (action.type === "createLocalDraft" || action.type === "createBrowserDraft" || action.type === "importPackage") {
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
  state = structuredClone(state);
  const projectId = action.projectId ?? selection.projectId ?? "demo-aurora";
  let irId = action.irId ?? selection.irId;
  const srId = action.srId ?? selection.srId;
  let selectedProjectId = projectId;
  const currentGroup = [...state.groups, ...state.drafts].find(item => item.id === irId && item.projectId === projectId);
  const sr = state.srs.find(item => item.id === srId && item.irId === irId && item.projectId === projectId);
  const operation = receipt(action.type, ++state.revision, irId, srId);
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
    case "createRelease":
      addPrototypeRelease({ id: `demo-release-${state.revision}`, projectId, title: action.title.trim(), createdAt });
      state.releases = readPrototypeProjectReleases();
      break;
    case "createLocalDraft": case "createBrowserDraft": case "importPackage": {
      irId = `draft-demo-${state.revision}`;
      const item = group(projectId, irId, action.type === "importPackage" ? "导入材料预览（样例，未解析 ZIP）" : "新需求讨论（样例）", [], true);
      item.origin = action.type === "createBrowserDraft" ? "browser" : action.type === "importPackage" ? "import" : "local";
      item.releaseId = action.releaseId;
      state.drafts.push(item); state.sessions.push(...item.sessions);
      state.materials.push(...requirementMaterials(projectId, irId, item.title, []));
      operation.irId = irId;
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
    case "confirmRequirements":
      if (currentGroup?.snapshot) {
        currentGroup.status = "confirmed";
        currentGroup.confirmation = { operationId: operation.operationId, snapshotDigest: currentGroup.snapshot.digest, confirmedAt: createdAt };
        currentGroup.review = { id: `sample-review-${state.revision}`, snapshotDigest: currentGroup.snapshot.digest, passed: true,
          report: "前端交互样例：已切换为确认状态，未执行实际审核或调用模型。", reviewer: { sessionId: "sample-reviewer", role: "reviewer", sourceProjectId: projectId, imported: true }, createdAt };
        state.drafts = state.drafts.filter(item => item !== currentGroup);
        if (!state.groups.includes(currentGroup)) state.groups.push(currentGroup);
      }
      break;
    case "markRequirementsPrSubmitted": case "markCodePrSubmitted": {
      const fact = { url: action.url, sourceBranch: sr?.worktree?.branch ?? currentGroup?.worktree?.branch ?? "demo/sample", targetBranch: "main", recordedAt: createdAt, platformVerified: false as const };
      if (action.type === "markCodePrSubmitted" && sr) sr.codePr = fact;
      else if (currentGroup) { currentGroup.requirementsPr = fact; currentGroup.status = "requirements-pr"; }
      break;
    }
    case "markRequirementsMerged": if (currentGroup) currentGroup.status = "frozen"; break;
    case "markCodeMerged": if (sr) sr.status = "completed"; break;
    case "startSr": case "approveStage": case "backStage":
      if (sr) {
        const next = action.type === "startSr" ? "solution" : action.type === "backStage" ? action.stage : stages[Math.min(stages.indexOf(sr.stage ?? "solution") + 1, stages.length - 1)]!;
        sr.stage = next; sr.status = "developing"; sr.round = 1;
        sr.worktree ??= { path: `/demo/worktrees/${projectId}/${sr.id}`, branch: `demo/${sr.id}`, baseCommit: "sample-base" };
        let session = sr.sessions.find(item => item.phase === next);
        if (!session) { session = sessionRef(projectId, sr.irId, next, sr.id); sr.sessions.push(session); state.sessions.push(session); }
        if (!sr.materials.length) {
          const materials = developmentMaterials(projectId, sr.irId, sr.id, sr.title);
          state.materials.push(...materials);
          sr.materials = materials.map(item => ({ path: item.path, sha256: item.sha256, size: item.size, kind: item.kind as DevStageMaterial["kind"], stage: item.stage!, round: 1, valid: true }));
        }
        sr.materialDigest = `sample-materials:${sr.id}`;
      }
      break;
    case "publishMaterials":
      operation.steps.push({ name: "prototype-publication", at: createdAt, detail: `前端样例：选择 ${action.paths.length} 份材料，备注“${action.message}”；未 commit、push 或发布。` });
      break;
    case "stop": state.running = []; break;
  }
  state.operations.push(operation);
  return { operationId: operation.operationId, projectId: selectedProjectId, revision: state.revision, irId, srId,
    status: "completed", receipt: operation, deletion: operation.deletion,
    view: getPrototypeWorkflow({ projectId: selectedProjectId, irId, srId }) };
}
export function prototypeRequirementDownload(selection: DevSelection): Blob {
  const materials = getPrototypeWorkflow(selection).materials.filter(item => item.irId === selection.irId && (item.kind === "ir" || item.kind === "sr"));
  return new Blob([materials.map(item => `${item.path}\n\n${item.content ?? ""}`).join("\n\n---\n\n")], { type: "text/markdown;charset=utf-8" });
}
