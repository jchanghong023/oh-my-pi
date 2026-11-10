import type { SkillSummary } from "@zcode/shared";
import detail from "./skills-detail.md?raw";

export const PROTOTYPE_SKILLS: SkillSummary[] = [
	{ id: "prototype-writing-plans", name: "writing-plans", description: "开发计划编写：组织实施步骤、修改范围和验证安排（原型样例）。", body: detail, path: "/demo/user/.omp/agent/skills/writing-plans/SKILL.md", scope: "user", enabled: true },
	{ id: "prototype-subagent-development", name: "subagent-driven-development", description: "子代理驱动开发：组织实施任务及独立审查（原型样例）。", body: detail, path: "/demo/user/.omp/agent/skills/subagent-driven-development/SKILL.md", scope: "user", enabled: true },
	{ id: "prototype-verification", name: "verification-before-completion", description: "完成前验证：核对实际执行结果、证据和未验证事项（原型样例）。", body: detail, path: "/demo/user/.omp/agent/skills/verification-before-completion/SKILL.md", scope: "user", enabled: true },
];

const designedSkills = new Map<string, SkillSummary[]>();
export function readPrototypeSkills(workspacePath?: string): SkillSummary[] {
	return structuredClone([...PROTOTYPE_SKILLS, ...(workspacePath ? designedSkills.get(workspacePath) ?? [] : [])]);
}
export function savePrototypeDesignedSkill(workspacePath: string, name: string, description: string, body: string): string {
	if (readPrototypeSkills(workspacePath).some(skill => skill.name === name)) throw new Error("此项目或已加载目录中已有同名技能，请修改技能标识。");
	const path = `${workspacePath}/.omp/skills/${name}/SKILL.md`;
	const skill: SkillSummary = { id: `prototype-designed:${workspacePath}:${name}`, name, description, body, path, scope: "workspace", enabled: true };
	designedSkills.set(workspacePath, [...(designedSkills.get(workspacePath) ?? []), skill]);
	return path;
}
