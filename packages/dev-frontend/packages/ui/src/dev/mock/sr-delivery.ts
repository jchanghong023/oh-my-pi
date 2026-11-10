import { getPrototypeEmployeeId } from "./employee.js";
import { prototypeDirectoryIssue } from "./recovery.js";
import { prototypeMaterial } from "./materials.js";
import { prototypeCapabilityName, prototypeChangeRoot } from "./proposal-storage.js";
import { prototypeStageView } from "./stage-gates.js";
import type { DevAction, DevFileVersion, DevRequirementGroup, DevSelection, DevSrDelivery, DevSystemRequirement, DevWorkflowView } from "./types.js";
import deliveryGuide from "./sr-delivery-guide.md?raw";

export const SR_DELIVERY_LABELS = { prepared: "待合并前验证", verified: "合并前验证通过（演示）", "implementation-issue": "验证未通过，待修复", "git-conflict": "Git 冲突，等待人工", "requirement-conflict": "需求冲突，等待人工" };
export function isPrototypeSrDeliveryAction(action: DevAction): boolean {
  return ["prepareSrDelivery", "publishSrDelivery", "verifySrDelivery", "resolveSrDeliveryConflict", "simulateSrDefaultBranchUpdate", "markCodePrSubmitted", "markCodeMerged"].includes(action.type);
}
export function prototypeSrDefaultCommit(view: DevWorkflowView, projectId: string): string {
  const repositoryId = view.projects.find(project => project.id === projectId)?.repositoryId ?? projectId;
  return view.repositoryHeads?.[repositoryId] ?? `sample-default-${repositoryId}`;
}
export function prototypeSrDeliveryFiles(sr: DevSystemRequirement, candidate: string): DevSrDelivery["files"] {
  const capability = prototypeCapabilityName(sr.id);
  return ([{ category: "code", path: `src/${capability}/index.ts` }, { category: "test", path: `test/${capability}.test.ts` }, { category: "spec", path: `openspec/specs/${capability}/spec.md` }] as const).map(file => ({ ...file, sha256: `sample:${candidate}:${file.path}`, size: 128 }));
}
export function prototypeSrMergeVerified(sr: DevSystemRequirement, defaultBranch = sr.codePr?.targetBranch ?? "main"): boolean {
  const merge = sr.codeMerge;
  const required = prototypeSrDeliveryFiles(sr, "merged");
  return sr.status === "completed" && Boolean(merge?.commit && merge.branch === defaultBranch && required.every(file => merge.files.some(item => item.path === file.path && item.sha256 && item.size >= 0)));
}
function versions(files: DevFileVersion[]): string {
  return JSON.stringify(files.map(({ path, sha256, size }) => ({ path, sha256, size })).sort((a, b) => a.path.localeCompare(b.path)));
}
export function prototypeSrDeliveryInputBlocker(view: DevWorkflowView, sr: DevSystemRequirement): string | undefined {
  const kinds = ["completion", "ut", "st", "delivery"];
  const files = sr.materials.filter(item => item.valid && item.round === sr.round && kinds.includes(item.kind));
  if (!kinds.every(kind => files.some(file => file.kind === kind))) return "请先补齐本轮完成报告、UT、ST 和交付说明样例。";
  if (!sr.materialDigest || files.some(file => !view.materials.some(material => material.path === file.path && material.projectId === sr.projectId && material.srId === sr.id && material.valid && !material.error && material.content !== undefined && material.sha256 === file.sha256 && material.size === file.size))) return "交付输入缺失、不可读或版本过期，请恢复或重新生成当前材料。";
}
export function prototypeSrDeliveryBlocker(view: DevWorkflowView, sr: DevSystemRequirement, requireVerification = true): string | undefined {
  const delivery = sr.delivery;
  if (!delivery) return "请先准备代码、测试和规格更新的同一 PR 交付清单。";
  const input = prototypeSrDeliveryInputBlocker(view, sr);
  if (input) return input;
  const files = sr.materials.filter(item => item.valid && item.round === sr.round && ["completion", "ut", "st", "delivery"].includes(item.kind));
  if (delivery.round !== sr.round || delivery.inputDigest !== sr.materialDigest || versions(delivery.inputs) !== versions(files)) return "交付材料已变化，请重新准备交付并验证新候选。";
  if (versions(delivery.files) !== versions(prototypeSrDeliveryFiles(sr, delivery.candidate)) || !prototypeSrDeliveryFiles(sr, delivery.candidate).every(expected => delivery.files.some(file => file.path === expected.path && file.category === expected.category))) return "交付清单必须同时包含本 SR 的代码、测试和正式规格更新，不能单独交付其中一类。";
  if (delivery.sourceSpec !== sr.documentPath || delivery.sourceChange !== prototypeChangeRoot(sr.irId)) return "交付来源与当前 Change／SR 不一致，请重新准备。";
  const manifest = view.materials.find(item => item.path === delivery.manifestPath && item.valid);
  if (!manifest?.content || manifest.error) return "交付清单不可读取，请恢复材料后继续。";
  if (delivery.defaultCommit !== prototypeSrDefaultCommit(view, sr.projectId)) return "默认分支已变化，请重新对齐并验证当前候选。";
  if (delivery.humanResolution && ["git-conflict", "requirement-conflict"].includes(delivery.status)) return "人工处理已记录，请重新准备交付并验证。";
  if (requireVerification && (delivery.status !== "verified" || delivery.verification?.candidate !== delivery.candidate || delivery.verification.defaultCommit !== delivery.defaultCommit)) return SR_DELIVERY_LABELS[delivery.status];
}
export function validatePrototypeSrDeliveryAction(view: DevWorkflowView, sr: DevSystemRequirement | undefined, action: DevAction, selection: DevSelection): void {
  if (!isPrototypeSrDeliveryAction(action)) return;
  if (!sr || sr.status !== "developing" || sr.stage !== "pr" || !prototypeStageView(sr, selection).isCurrent) throw new Error("仅当前 SR 的实际交付 PR 阶段可以操作，历史只读。");
  if (sr.developerEmployeeId !== getPrototypeEmployeeId()) throw new Error("仅当前 SR 开发人可以准备、验证或登记交付。");
  if (!sr.worktree?.path || !sr.developmentRoot) throw new Error("原开发工作区记录缺失，不能换用其他目录。");
  const issue = prototypeDirectoryIssue(sr.worktree.path);
  if (issue) throw new Error(issue);
  if (!view.sessions.some(item => item.sessionId === sr.sessions.find(session => session.phase === "pr" && session.round === sr.round)?.sessionId)) throw new Error("当前交付会话不可读，请恢复原记录。");
  if (action.type === "prepareSrDelivery") {
    const input = prototypeSrDeliveryInputBlocker(view, sr);
    if (input) throw new Error(input);
    if ((sr.delivery?.status === "git-conflict" || sr.delivery?.status === "requirement-conflict") && !sr.delivery.humanResolution) throw new Error("冲突必须交人工处理，不能由 Agent 自动继续。");
  }
  if (action.type === "verifySrDelivery") {
    if (!sr.delivery || sr.delivery.status !== "prepared" || action.candidate !== sr.delivery.candidate || action.defaultCommit !== sr.delivery.defaultCommit || action.defaultCommit !== prototypeSrDefaultCommit(view, sr.projectId)) throw new Error("候选或默认分支已变化，请重新准备后验证；重复结果不能推进。");
    const input = prototypeSrDeliveryBlocker(view, sr, false); if (input) throw new Error(input);
  }
  if (action.type === "resolveSrDeliveryConflict" && ((!sr.delivery || !["git-conflict", "requirement-conflict"].includes(sr.delivery.status)) || !action.note.trim() || !action.scopeUnchanged)) throw new Error("请记录人工处理结果，并确认不改变冻结需求或方案；业务变化须重新提案。");
  if (action.type === "publishSrDelivery" || action.type === "markCodePrSubmitted" || action.type === "markCodeMerged") {
    const blocker = prototypeSrDeliveryBlocker(view, sr); if (blocker) throw new Error(blocker);
    if (action.type === "publishSrDelivery" && (action.candidate !== sr.delivery!.candidate || sr.delivery!.pushedCandidate === action.candidate)) throw new Error("只能提交并推送当前已验证候选。");
    if (action.type === "markCodePrSubmitted" && sr.delivery!.pushedCandidate !== sr.delivery!.candidate) throw new Error("请先提交并推送当前已验证候选，再登记人工 PR。");
    if (action.type === "markCodePrSubmitted" && !/^https?:\/\/[^\s]+$/.test(action.url.trim())) throw new Error("请输入人工创建的有效 PR 链接。");
    if (action.type === "markCodeMerged" && (!sr.codePr || sr.delivery!.prCandidate !== sr.delivery!.candidate || action.candidate !== sr.delivery!.candidate || !action.filesConfirmed)) throw new Error("请先登记当前候选的 PR，并核对默认分支同时包含代码、测试和规格；链接本身不能完成 SR。");
  }
}
export function applyPrototypeSrDeliveryAction(view: DevWorkflowView, group: DevRequirementGroup, sr: DevSystemRequirement, action: DevAction): void {
  const repositoryId = view.projects.find(project => project.id === sr.projectId)!.repositoryId;
  if (action.type === "simulateSrDefaultBranchUpdate") {
    view.repositoryHeads ??= {}; view.repositoryHeads[repositoryId] = `sample-default-update-${view.revision}`;
  }
  if (action.type === "prepareSrDelivery") {
    if (sr.delivery) { sr.deliveryHistory ??= []; sr.deliveryHistory.push(structuredClone(sr.delivery)); }
    const candidate = `sample-${sr.id}-candidate-${view.revision}`;
    const files = prototypeSrDeliveryFiles(sr, candidate);
    const inputs = sr.materials.filter(item => item.valid && item.round === sr.round && ["completion", "ut", "st", "delivery"].includes(item.kind));
    const manifestPath = `development/${sr.irId}/${sr.id}/round-${sr.round}/delivery-package-${view.revision}.md`;
    sr.delivery = { candidate, round: sr.round, defaultCommit: prototypeSrDefaultCommit(view, sr.projectId), inputDigest: sr.materialDigest!, inputs: structuredClone(inputs), files, manifestPath, sourceChange: prototypeChangeRoot(group.id), sourceSpec: sr.documentPath, status: "prepared" };
    view.materials.filter(item => item.projectId === sr.projectId && item.srId === sr.id && item.kind === "sr-delivery-package").forEach(item => { item.valid = false; });
    view.materials.push(prototypeMaterial({ projectId: sr.projectId, irId: sr.irId, srId: sr.id, stage: "pr", round: sr.round, kind: "sr-delivery-package", path: manifestPath, content: `# ${sr.title}：实现、测试与规格更新\n\n> 静态交付清单，不是实际 Git diff、测试或推送结果。\n\n## PR 标题\n${sr.title}：实现、测试与规格更新\n\n## 同一 PR 的文件\n${files.map(file => `- ${file.category}：${file.path}`).join("\n")}\n\n## 来源与版本\nChange：${prototypeChangeRoot(group.id)}\n\nSR：${sr.id} · 增量规格：${sr.documentPath}\n\n冻结版本：${group.freeze?.snapshotDigest}\n\n候选：${candidate}\n\n对齐默认分支：${sr.delivery.defaultCommit}\n\n${deliveryGuide}` }));
  }
  if (action.type === "verifySrDelivery") {
    sr.delivery!.status = action.outcome === "passed" ? "verified" : action.outcome;
    sr.delivery!.verification = action.outcome === "passed" ? { candidate: sr.delivery!.candidate, defaultCommit: sr.delivery!.defaultCommit, checkedAt: new Date().toISOString() } : undefined;
  }
  if (action.type === "resolveSrDeliveryConflict") sr.delivery!.humanResolution = { note: action.note.trim(), employeeId: getPrototypeEmployeeId(), resolvedAt: new Date().toISOString() };
  if (action.type === "publishSrDelivery") sr.delivery!.pushedCandidate = action.candidate;
  if (action.type === "markCodePrSubmitted") sr.delivery!.prCandidate = sr.delivery!.candidate;
}
