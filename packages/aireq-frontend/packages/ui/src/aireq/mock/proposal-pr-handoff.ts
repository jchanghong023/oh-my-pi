import type { AIReqPrHandoff, AIReqPrHandoffInput, AIReqPrHandoffScenario, AIReqRequirementGroup } from "../types.js";
import { hasCurrentProposalSolution, requirementsReviewBlocker } from "../domain.js";
import { getEmployeeId } from "../identity.js";
import { prototypeChangeRoot } from "./proposal-storage.js";
import { readPrototypeProjectSettings } from "./project-settings.js";

/** 仅推导平台托管仓库的交接样例，不创建分支或访问文件系统。 */
export function derivePrototypeProposalPrHandoff(input: AIReqPrHandoffInput): AIReqPrHandoff {
 const { group, project, employeeId, scenario = "current" } = input;
 const changeRoot = prototypeChangeRoot(group.id);
 const sourceDirectory = group.proposalLocation?.directory ?? "";
 const branch = `ir/${group.id}`;
 const blockers: string[] = [];
 const reviewBlocker = requirementsReviewBlocker(group);
 if (reviewBlocker) blockers.push(reviewBlocker);
 if (!project || project.id !== group.projectId || !project.repositoryUrl || !project.defaultBranch) blockers.push("请先配置提案所属项目的 Git 仓库和默认分支。");
 if (!sourceDirectory) blockers.push("提案所属 OMP 项目目录记录缺失。");
 else if (project && sourceDirectory !== project.root) blockers.push("提案记录的 OMP 项目目录与所属项目不匹配。");
 if (scenario === "wrong-repository") blockers.push("目标仓库与提案所属项目不匹配，不能推送。");
 if (!hasCurrentProposalSolution(group) || scenario === "stale-version") blockers.push("请先完成当前需求版本的方案设计，再创建提案分支并提交推送。");
 if (scenario === "change-conflict") blockers.push(`目标仓库存在同名 ${changeRoot}，不能覆盖其他提案。`);
 return {
  ready: blockers.length === 0, blockers, employeeId, sourceDirectory, branch,
  repositoryUrl: project?.repositoryUrl, targetBranch: project?.defaultBranch ?? "未配置", changeRoot,
  files: group.files.map(file => ({ path: file.path, sourcePath: `${sourceDirectory.replace(/\/$/, "")}/${file.path}`, targetPath: `${branch}:${file.path}`, version: file.path.endsWith("/design.md") || file.path.endsWith("/sr-dependencies.json") ? `方案第 ${group.proposalSolution?.round ?? 1} 轮` : `需求快照 ${group.snapshot?.digest ?? "未生成"}`, digest: file.sha256 })),
 };
}
export function readPrototypeProposalPrHandoff(group: AIReqRequirementGroup, scenario: AIReqPrHandoffScenario = "current"): AIReqPrHandoff {
 return derivePrototypeProposalPrHandoff({ group, employeeId: getEmployeeId(), project: readPrototypeProjectSettings().projects.find(project => project.id === group.projectId), scenario });
}
