import { irAcceptanceBlocker, irAcceptanceVersionBlocker, irAcceptanceReportBlocker, irFinalPackageBlocker, irFinalPackageVersion, srMergeVersion, fileVersions } from "../domain.js";
import { prototypeSrDefaultCommit } from "./sr-delivery.js";
import { readPrototypeAgentModelBinding } from "./agent-models.js";
import { getEmployeeId, isEmployeeId } from "../identity.js";
import { readPrototypeDevelopmentRoot } from "./project-settings.js";
import { prototypeChangeRoot } from "./proposal-storage.js";
import { prototypeMaterial } from "./materials.js";
import { prototypeDirectoryIssue } from "./recovery.js";
import type { DevAction, DevFileVersion, DevRequirementGroup, DevWorkflowView } from "../types.js";
import reportIssues from "./ir-acceptance-issues.md?raw";
import reportPassed from "./ir-acceptance-passed.md?raw";
import finalPr from "./ir-acceptance-final-pr.md?raw";

function repairFiles(group: DevRequirementGroup): DevFileVersion[] {
  const acceptance = group.acceptance!;
  return acceptance.hasFixes ? [`src/${group.id}/integration-fix.ts`, `test/${group.id}.integration.test.ts`].map(path => ({ path, sha256: `sample:${acceptance.candidate}:${path}`, size: 128 })) : [];
}
export function isIrAcceptanceAction(action: DevAction): boolean {
  return ["startIrAcceptance", "generateIrAcceptanceReport", "repairIrAcceptance", "prepareIrFinalPr", "restartIrAcceptance", "simulateIrDefaultBranchUpdate", "publishIrFinalPr", "markIrFinalPrSubmitted", "verifyIrFinalMerge"].includes(action.type);
}
export function validateIrAcceptanceAction(view: DevWorkflowView, group: DevRequirementGroup | undefined, action: DevAction): void {
  if (!isIrAcceptanceAction(action)) return;
  if (!isEmployeeId(getEmployeeId())) throw new Error("请先输入有效工号。");
  if (!group || !view.groups.some(item => item.id === group.id)) throw new Error("请选择正式 IR。提案阶段不能开始 IR 验收。");
  const blocker = irAcceptanceBlocker(view, group); if (blocker) throw new Error(blocker);
  const acceptance = group.acceptance;
  if (action.type === "startIrAcceptance") {
    if (acceptance) throw new Error("此 IR 已创建验收会话，请继续原会话。");
    const root = readPrototypeDevelopmentRoot(group.projectId); if (!root) throw new Error("请先添加我的开发项目目录。");
    const issue = prototypeDirectoryIssue(root); if (issue) throw new Error(issue);
    return;
  }
  if (!acceptance || acceptance.employeeId !== getEmployeeId()) throw new Error("仅本 IR 的验收开发人可以推进，其他人只读查看。");
  if (acceptance.status === "completed") throw new Error("IR 已完成，历史只读，不能重复发布或完成。");
  const directoryIssue = prototypeDirectoryIssue(acceptance.worktree.path); if (directoryIssue) throw new Error(directoryIssue);
  if (!view.sessions.some(item => item.sessionId === acceptance.session.sessionId)) throw new Error("原验收会话不可读取，请恢复后重试。");
  if (action.type === "simulateIrDefaultBranchUpdate") return;
  if (action.type === "restartIrAcceptance") {
    if (acceptance.status === "reviewing" && !irAcceptanceVersionBlocker(view, group)) throw new Error("当前已在验收中，无需重复开始。");
    return;
  }
  const versionIssue = irAcceptanceVersionBlocker(view, group); if (versionIssue) throw new Error(versionIssue);
  if (action.type === "generateIrAcceptanceReport" && acceptance.status !== "reviewing") throw new Error("当前不在整体验收阶段。");
  if (action.type === "repairIrAcceptance" && acceptance.status !== "issues") throw new Error("没有待修复的验收问题。");
  if (action.type === "prepareIrFinalPr") {
    if (acceptance.status !== "passed") throw new Error("请先完成当前候选的整体验收。");
    const reportIssue = irAcceptanceReportBlocker(view, group); if (reportIssue) throw new Error(reportIssue);
  }
  if (["publishIrFinalPr", "markIrFinalPrSubmitted", "verifyIrFinalMerge"].includes(action.type)) {
    const packageIssue = irFinalPackageBlocker(view, group); if (packageIssue) throw new Error(packageIssue);
    if (fileVersions(acceptance.archive!.fixes) !== fileVersions(repairFiles(group))) throw new Error("最终 PR 的修复及测试与验收候选不一致，请重新准备。");
  }
  if (action.type === "publishIrFinalPr" && (acceptance.status !== "pr-ready" || action.candidate !== acceptance.candidate || acceptance.pushedCandidate === acceptance.candidate)) throw new Error("仅提交并推送当前已确认的最终候选，不能重复发布。");
  if (action.type === "markIrFinalPrSubmitted" && (acceptance.status !== "pr-ready" || !/^https?:\/\/[^\s]+$/.test(action.url.trim()) || acceptance.pushedCandidate !== acceptance.candidate || acceptance.pushedPackageVersion !== acceptance.packageVersion)) throw new Error("请先提交、推送当前最终候选，再登记人工创建的 PR。");
  if (action.type === "verifyIrFinalMerge" && (acceptance.status !== "pr-submitted" || !acceptance.pr || !action.filesConfirmed || action.candidate !== acceptance.candidate || acceptance.prCandidate !== acceptance.candidate || acceptance.prPackageVersion !== acceptance.packageVersion || acceptance.pushedPackageVersion !== acceptance.packageVersion)) throw new Error("请核对当前候选的修复与完整归档结果，不能仅凭旧 PR 链接完成 IR。");
}
function remember(group: DevRequirementGroup): void {
  const acceptance = group.acceptance!;
  acceptance.history ??= [];
  acceptance.history.push({ candidate: acceptance.candidate, baseCommit: acceptance.baseCommit, status: acceptance.status, reportPath: acceptance.reportPath, finalPrPath: acceptance.finalPrPath, prUrl: acceptance.pr?.url });
}
export function applyIrAcceptanceAction(view: DevWorkflowView, group: DevRequirementGroup, action: DevAction): void {
  if (action.type === "startIrAcceptance") {
    const sessionId = `${group.projectId}-${group.id}-ir-acceptance`;
    const session = { projectId: group.projectId, irId: group.id, sessionId, sessionFile: `/demo/sessions/${sessionId}.jsonl`, phase: "ir-acceptance" as const, role: "ir-acceptance" as const, round: 1, modelConfig: readPrototypeAgentModelBinding("ir-acceptance") };
    group.sessions.push(session); view.sessions.push(session);
    const baseCommit = prototypeSrDefaultCommit(view, group.projectId);
    group.acceptance = { status: "reviewing", employeeId: getEmployeeId(), startedAt: new Date().toISOString(), session, baseCommit, candidate: "sample-ir-candidate-1", revision: 1, hasFixes: false, worktree: { path: `${readPrototypeDevelopmentRoot(group.projectId)}/.worktrees/${group.id}-acceptance`, branch: `demo/${group.id}-acceptance`, baseCommit } };
    return;
  }
  const acceptance = group.acceptance!;
  if (action.type === "simulateIrDefaultBranchUpdate") {
    const repositoryId = view.projects.find(project => project.id === group.projectId)!.repositoryId;
    view.repositoryHeads ??= {}; view.repositoryHeads[repositoryId] = `sample-ir-default-update-${view.revision}`;
  }
  if (action.type === "restartIrAcceptance") {
    remember(group);
    view.materials.filter(item => item.projectId === group.projectId && item.irId === group.id && ["ir-acceptance-report", "ir-final-pr"].includes(item.kind)).forEach(item => { item.valid = false; });
    acceptance.revision += 1; acceptance.candidate = `sample-ir-candidate-${acceptance.revision}`; acceptance.baseCommit = prototypeSrDefaultCommit(view, group.projectId); acceptance.status = "reviewing";
    acceptance.reportPath = undefined; acceptance.reportVersion = undefined; acceptance.reportCandidate = undefined; acceptance.reportBaseCommit = undefined; acceptance.srMergeVersion = undefined; acceptance.finalPrPath = undefined; acceptance.finalPrVersion = undefined; acceptance.archive = undefined; acceptance.packageVersion = undefined; acceptance.pushedCandidate = undefined; acceptance.pushedPackageVersion = undefined; acceptance.prCandidate = undefined; acceptance.prPackageVersion = undefined;
  }
  if (action.type === "generateIrAcceptanceReport" || action.type === "repairIrAcceptance") {
    const passed = action.type === "repairIrAcceptance" || action.outcome === "passed";
    if (action.type === "repairIrAcceptance") {
      remember(group); acceptance.hasFixes = true; acceptance.revision += 1; acceptance.candidate = `sample-ir-candidate-${acceptance.revision}`;
      view.materials.filter(item => item.projectId === group.projectId && item.irId === group.id && item.kind === "ir-acceptance-report").forEach(item => { item.valid = false; });
    }
    acceptance.status = passed ? "passed" : "issues"; acceptance.reportCandidate = acceptance.candidate; acceptance.reportBaseCommit = acceptance.baseCommit; acceptance.srMergeVersion = srMergeVersion(view, group);
    acceptance.reportPath = `development/${group.id}/acceptance/report-${acceptance.revision}.md`;
    const report = prototypeMaterial({ projectId: group.projectId, irId: group.id, kind: "ir-acceptance-report", path: acceptance.reportPath, content: `# ${group.title} · IR 验收报告\n\n> 静态演示，未执行真实验证。\n\n基点：${acceptance.baseCommit}\n\n候选：${acceptance.candidate}\n\n${passed ? reportPassed : reportIssues}` });
    view.materials.push(report); acceptance.reportVersion = { path: report.path, sha256: report.sha256, size: report.size };
  }
  if (action.type === "prepareIrFinalPr") {
    acceptance.status = "pr-ready";
    const root = prototypeChangeRoot(group.id);
    const targetRoot = `openspec/changes/archive/${new Date().toISOString().slice(0, 10)}-${root.split("/").at(-1)}`;
    acceptance.archive = { sourceRoot: root, targetRoot, skipSpecs: true, moves: group.freeze!.files.map(file => ({ sourcePath: file.path, path: `${targetRoot}/${file.path.slice(root.length + 1)}`, sha256: file.sha256, size: file.size })), fixes: repairFiles(group) };
    acceptance.packageVersion = irFinalPackageVersion(group);
    acceptance.finalPrPath = `development/${group.id}/acceptance/final-pr-${acceptance.revision}.md`;
    const material = prototypeMaterial({ projectId: group.projectId, irId: group.id, kind: "ir-final-pr", path: acceptance.finalPrPath, content: `# ${group.title}：${acceptance.hasFixes ? "整体验收修复与归档" : "整体验收归档"}\n\n> 静态演示，未提交、推送或创建真实 PR。\n\n候选：${acceptance.candidate}\n\n默认分支基点：${acceptance.baseCommit}\n\n## 最终修复与测试\n${acceptance.archive.fixes.map(file => `- ${file.path}`).join("\n") || "无需修复，仅归档。"}\n\n## 归档移动清单（不再同步规格）\n${acceptance.archive.moves.map(move => `- ${move.sourcePath} → ${move.path}（字节版本保持不变）`).join("\n")}\n\n${finalPr}` });
    view.materials.push(material); acceptance.finalPrVersion = { path: material.path, sha256: material.sha256, size: material.size };
  }
  if (action.type === "publishIrFinalPr") { acceptance.pushedCandidate = acceptance.candidate; acceptance.pushedPackageVersion = acceptance.packageVersion; }
  if (action.type === "markIrFinalPrSubmitted") {
    acceptance.status = "pr-submitted"; acceptance.prCandidate = acceptance.candidate; acceptance.prPackageVersion = acceptance.packageVersion;
    acceptance.pr = { url: action.url.trim(), sourceBranch: acceptance.worktree.branch, targetBranch: view.projects.find(project => project.id === group.projectId)!.defaultBranch, recordedAt: new Date().toISOString(), platformVerified: false };
  }
  if (action.type === "verifyIrFinalMerge") {
    acceptance.status = "completed";
    acceptance.archiveResult = { sourceAbsent: true, targetFiles: acceptance.archive!.moves.map(({ path, sha256, size }) => ({ path, sha256, size })), skipSpecs: true };
    acceptance.merge = { commit: `sample-merged-${acceptance.candidate}`, branch: acceptance.pr!.targetBranch, checkedAt: new Date().toISOString(), files: [...acceptance.archive!.fixes, ...acceptance.archiveResult.targetFiles] };
    const repositoryId = view.projects.find(project => project.id === group.projectId)!.repositoryId;
    view.repositoryHeads ??= {}; view.repositoryHeads[repositoryId] = acceptance.merge.commit;
  }
}
