import { SKILL_DESIGN_FIELDS } from "../skill-design-fields.js";
import type { DevSkillDesignDraft } from "../types.js";
import template from "./skill-design-template.md?raw";
import chatTemplate from "./skill-design-chat.md?raw";
import { createPrototypeEvent } from "./events.js";

const emptyDraft: DevSkillDesignDraft = { name: "", goal: "", when: "", inputs: "", outputs: "", boundaries: "", references: "", example: "", notes: [] };
export const PROTOTYPE_SKILL_DESIGN_SAMPLE: DevSkillDesignDraft = {
	name: "review-api-changes",
	goal: "评审接口变更，识别向后兼容性问题",
	when: "用户请求评审 API 变更、接口 PR，或检查向后兼容性时使用。",
	inputs: "当前 Git diff、接口定义、受影响调用方及相关测试。",
	outputs: "按严重程度列出问题，包含文件和行号、影响、依据与修改建议；区分已确认问题和待核实项。",
	boundaries: "只分析，不修改代码。纯文档排版不触发；缺少接口变更时说明不适用。",
	references: "先阅读项目现有接口规范，核对请求、响应、错误码及相关测试，不假定未提供的客户端行为。",
	example: "输入：删除响应中的必填字段。期望：指出受影响调用方，并提出兼容过渡建议；没有证据时列为待核实。",
	notes: [],
};
export function prototypeSkillName(draft: DevSkillDesignDraft): string {
	return draft.name.trim() || (draft.goal.toLowerCase().includes("接口") || draft.goal.toLowerCase().includes("api") ? "review-api-changes" : "project-skill");
}
const drafts = new Map<string, DevSkillDesignDraft>();
const supplements = createPrototypeEvent<string>();
export const onPrototypeSkillDesignSupplement = supplements.event;
export function prototypeSkillDesignSession(projectId: string): string { return `prototype-skill-design:${projectId}`; }
export function readPrototypeSkillDesign(sessionId: string): DevSkillDesignDraft { return structuredClone(drafts.get(sessionId) ?? emptyDraft); }
export function savePrototypeSkillDesignDraft(sessionId: string, value: DevSkillDesignDraft): void { drafts.set(sessionId, structuredClone(value)); }
export function prototypeSkillDesignReply(sessionId: string, message: string): string {
	const draft = readPrototypeSkillDesign(sessionId);
	draft.notes.push(message);
	savePrototypeSkillDesignDraft(sessionId, draft);
	supplements.fire(sessionId);
	const missing = SKILL_DESIGN_FIELDS.filter(field => field.required && !draft[field.id].trim()).map(field => field.label);
	return chatTemplate.replace("{{goal}}", draft.goal || "尚未填写，可先在上方说明要解决的任务。")
		.replace("{{missing}}", missing.length ? `还需要补充：${missing.join("、")}。` : "四项核心信息已填写，可以生成预览，并进一步检查适用边界和验证例子。");
}
export function renderPrototypeSkillDesign(name: string, draft: DevSkillDesignDraft): string {
	const values: Record<string, string> = { ...draft, name, description: JSON.stringify(draft.when.trim().replace(/\s+/g, " ")), notes: draft.notes.length ? draft.notes.map(note => `- ${note}`).join("\n") : "暂无补充。" };
	return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key]?.trim() || "待补充，可在补充讨论中继续完善。");
}
