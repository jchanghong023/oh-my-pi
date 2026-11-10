import { readPrototypeProjectSettings } from "./project-settings.js";

/** IR/SR 仅为界面映射；文件遵循 OpenSpec change/capability 结构。 */
export function prototypeChangeId(irId: string): string {
 const samples: Record<string, string> = { "ir-auth": "add-account-access", "ir-dashboard": "add-team-dashboard", "ir-mobile": "add-mobile-workbench", "ir-mobile-offline": "add-mobile-offline", "draft-automation": "add-automation-workflows", "draft-notification": "add-team-notifications", "draft-mobile-search": "add-mobile-search" };
 return samples[irId] ?? irId;
}
export function prototypeChangeRoot(irId: string): string { return `openspec/changes/${prototypeChangeId(irId)}`; }
export function prototypeCapabilityName(srId: string): string { return srId.replace(/^(proposal-)?sr-/, ""); }
export function prototypeSpecPath(irId: string, srId: string): string { return `${prototypeChangeRoot(irId)}/specs/${prototypeCapabilityName(srId)}/spec.md`; }

// 仅用于路径展示，不连接数据库、不创建目录或文件。
export function prototypeProposalLocation(projectId: string, proposalId: string, employeeId: string) {
 const project = readPrototypeProjectSettings().projects.find(item => item.id === projectId);
 if (!project) throw new Error("提案所属项目不存在。");
 return { projectName: project.storageName ?? project.name, employeeId,
  directory: `/tmpdata/DFT_LAB/omp/${project.storageName}/${employeeId}/${proposalId}/` };
}
