import { readPrototypeProjectSettings } from "./project-settings.js";

// 仅用于路径展示，不连接数据库、不创建目录或文件。
export function prototypeProposalLocation(projectId: string, proposalId: string, employeeId: string) {
 const project = readPrototypeProjectSettings().projects.find(item => item.id === projectId);
 if (!project) throw new Error("提案所属项目不存在。");
 return { projectName: project.storageName, employeeId,
  directory: `/tmpdata/DFT_LAB/omp/${project.storageName}/${employeeId}/${proposalId}/` };
}
