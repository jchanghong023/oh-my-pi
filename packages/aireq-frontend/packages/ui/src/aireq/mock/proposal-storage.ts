import { readPrototypeProjectSettings } from "./project-settings.js";

/** IR/SR 仅为界面映射；文件遵循 OpenSpec change/capability 结构。 */
export function prototypeChangeId(irId: string): string {
 const samples: Record<string, string> = { "ir-export": "add-report-export", "ir-notifications": "add-notification-center", "ir-audit-archive": "add-operation-audit", "ir-auth": "add-account-access", "ir-dashboard": "add-team-dashboard", "ir-mobile": "add-mobile-workbench", "ir-mobile-offline": "add-mobile-offline", "draft-automation": "add-automation-workflows", "draft-notification": "add-team-notifications", "draft-mobile-search": "add-mobile-search" };
 return samples[irId] ?? irId;
}
export function prototypeChangeRoot(irId: string): string { return `openspec/changes/${prototypeChangeId(irId)}`; }
export function prototypeCapabilityName(srId: string): string { return srId.replace(/^(proposal-)?sr-/, ""); }
export function prototypeSpecPath(irId: string, srId: string): string { return `${prototypeChangeRoot(irId)}/specs/${prototypeCapabilityName(srId)}/spec.md`; }

// 每个 IR 记录同一 OMP 项目 dir；材料以 change-id 区分，不创建每提案目录。仅内存样例。
export function prototypeProposalLocation(projectId: string, employeeId: string) {
 const project = readPrototypeProjectSettings().projects.find(item => item.id === projectId);
 if (!project) throw new Error("提案所属项目不存在。");
 return { projectName: project.storageName ?? project.name, employeeId,
  directory: project.root };
}
