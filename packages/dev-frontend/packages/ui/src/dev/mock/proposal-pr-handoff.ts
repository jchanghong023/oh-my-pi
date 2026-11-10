import { prototypeRequirementsReviewBlocker } from "./requirements-review.js";
import { getPrototypeEmployeeId } from "./employee.js";
import { hasCurrentProposalSolution } from "./proposal-flow.js";
import { prototypeChangeId, prototypeChangeRoot } from "./proposal-storage.js";
import { normalizePrototypeProjectPath, prototypeProjectDirectories } from "./project-directories.js";
import { readPrototypeDevelopmentRoot, readPrototypeProjectSettings } from "./project-settings.js";
import type { DevProject, DevRequirementGroup } from "./types.js";

export type PrototypePrHandoffScenario = "current" | "missing-directory" | "wrong-repository" | "change-conflict" | "stale-version";
export interface PrototypePrHandoffFile {
 path: string;
 sourcePath: string;
 targetPath: string;
 version: string;
 digest: string;
}
export interface PrototypePrHandoff {
 ready: boolean;
 blockers: string[];
 employeeId: string;
 sourceDirectory: string;
 targetDirectory?: string;
 branch: string;
 targetBranch: string;
 changeRoot: string;
 files: PrototypePrHandoffFile[];
}
export interface PrototypePrHandoffInput {
 group: DevRequirementGroup;
 project?: DevProject;
 developmentRoot?: string;
 developmentDirectory?: { path: string; repositoryRoot?: string; git: boolean };
 employeeId: string;
 scenario?: PrototypePrHandoffScenario;
}

/** 只推导内存样例；不读取目录、执行 Git 或把样例检查当作真实仓库事实。 */
export function derivePrototypeProposalPrHandoff(input: PrototypePrHandoffInput): PrototypePrHandoff {
 const { group, project, employeeId, scenario = "current" } = input;
 const changeRoot = prototypeChangeRoot(group.id);
 const sourceDirectory = group.proposalLocation?.directory ?? "";
 const targetDirectory = scenario === "missing-directory" ? undefined : input.developmentRoot;
 const blockers: string[] = [];
 const reviewBlocker = prototypeRequirementsReviewBlocker(group);
 if (reviewBlocker) blockers.push(reviewBlocker);
 if (!project || project.id !== group.projectId) blockers.push("提案所属项目不可用，请重新选择项目。");
 if (!sourceDirectory) blockers.push("缺少提案固定临时工作区，不能确定交接来源。");
 if (!targetDirectory) blockers.push("当前工号尚未配置此项目的个人开发目录，请先到项目与 Release 设置中配置。");
 else if (project && normalizePrototypeProjectPath(targetDirectory) === normalizePrototypeProjectPath(project.root)) blockers.push("共享项目目录只读，不能作为需求 PR 的写入目标。");
 else if (!input.developmentDirectory || !input.developmentDirectory.git || normalizePrototypeProjectPath(input.developmentDirectory.path) !== normalizePrototypeProjectPath(targetDirectory)) blockers.push("个人开发目录未通过演示 Git 目录检查，不能继续交接。");
 else if (scenario === "wrong-repository" || !project || input.developmentDirectory.repositoryRoot !== project.root) blockers.push("个人开发目录与本提案项目不是同一 Git 仓库，不能把文件带入错误项目。");
 if (!hasCurrentProposalSolution(group) || scenario === "stale-version") blockers.push("当前需求文件不完整或 design.md 对应旧需求版本，请完成并确认本轮方案后再提交。");
 if (scenario === "change-conflict") blockers.push(`目标仓库已存在同名 ${changeRoot}（冲突示例），需先核对归属与版本，不能直接覆盖。`);
 const sourceRoot = sourceDirectory.replace(/\/$/, "");
 const targetRoot = targetDirectory?.replace(/\/$/, "");
 const files = group.files.map(file => ({
  path: file.path,
  sourcePath: sourceRoot ? `${sourceRoot}/${file.path}` : "来源未确定",
  targetPath: targetRoot ? `${targetRoot}/${file.path}` : "目标未配置",
  version: file.path.endsWith("/design.md") ? `方案第 ${group.proposalSolution?.round ?? group.proposalRound ?? 1} 轮` : `需求快照 ${group.snapshot?.digest ?? "未生成"}`,
  digest: file.sha256,
 }));
 return { ready: blockers.length === 0, blockers, employeeId, sourceDirectory,
  targetDirectory, branch: `dev/requirements/${prototypeChangeId(group.id)}`, targetBranch: project?.defaultBranch ?? "未确定", changeRoot, files };
}

export function readPrototypeProposalPrHandoff(group: DevRequirementGroup, scenario: PrototypePrHandoffScenario = "current"): PrototypePrHandoff {
 const employeeId = getPrototypeEmployeeId();
 const developmentRoot = readPrototypeDevelopmentRoot(group.projectId, employeeId);
 const project = readPrototypeProjectSettings().projects.find(item => item.id === group.projectId);
 const developmentDirectory = prototypeProjectDirectories().find(item => item.path === developmentRoot);
 return derivePrototypeProposalPrHandoff({ group, employeeId, project, developmentRoot, developmentDirectory, scenario });
}
