import template from "./skill-design-template.md?raw";
import chatTemplate from "./skill-design-chat.md?raw";
import { createPrototypeEvent } from "./events.js";

export interface PrototypeSkillDesignDraft {
	name: string;
	goal: string; when: string; inputs: string; outputs: string;
	boundaries: string; references: string; example: string; notes: string[];
}
export const SKILL_DESIGN_FIELDS = [
	{ id: "goal", label: "要解决什么任务", hint: "用一句话描述核心目标。", placeholder: "例如：评审接口变更，找出兼容性问题", required: true },
	{ id: "when", label: "什么时候使用", hint: "说明适用场景，或给一句用户可能说的话。", placeholder: "例如：用户请求评审 API 变更或检查向后兼容性时", required: true },
	{ id: "inputs", label: "需要哪些输入", hint: "代码、文档、日志等；也可明确无需额外输入。", placeholder: "例如：当前 Git diff、接口定义和相关测试", required: true },
	{ id: "outputs", label: "期望结果与成功标准", hint: "需要什么产物，怎样判断它可用？", placeholder: "例如：按严重程度列出问题，附文件位置、影响和修改建议", required: true },
	{ id: "boundaries", label: "边界与不适用场景", hint: "说明不该做什么、哪些情况不适用。", placeholder: "例如：只分析，不修改代码；纯文档排版不触发", required: false },
	{ id: "references", label: "流程、规则或参考资料", hint: "已有模板、规范、工具或依赖。", placeholder: "例如：先阅读项目接口规范，再检查变更和测试", required: false },
	{ id: "example", label: "真实例子或失败情况", hint: "强烈建议给一个具体的输入和期望结果。", placeholder: "例如：删除必填响应字段时，指出受影响客户端及兼容方案", required: false },
] as const;
const emptyDraft: PrototypeSkillDesignDraft = { name: "", goal: "", when: "", inputs: "", outputs: "", boundaries: "", references: "", example: "", notes: [] };
export const PROTOTYPE_SKILL_DESIGN_SAMPLE: PrototypeSkillDesignDraft = {
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
export function prototypeSkillName(draft: PrototypeSkillDesignDraft): string {
	return draft.name.trim() || (draft.goal.toLowerCase().includes("接口") || draft.goal.toLowerCase().includes("api") ? "review-api-changes" : "project-skill");
}
const drafts = new Map<string, PrototypeSkillDesignDraft>();
const supplements = createPrototypeEvent<string>();
export const onPrototypeSkillDesignSupplement = supplements.event;
export function prototypeSkillDesignSession(projectId: string): string { return `prototype-skill-design:${projectId}`; }
export function readPrototypeSkillDesign(sessionId: string): PrototypeSkillDesignDraft { return structuredClone(drafts.get(sessionId) ?? emptyDraft); }
export function savePrototypeSkillDesignDraft(sessionId: string, value: PrototypeSkillDesignDraft): void { drafts.set(sessionId, structuredClone(value)); }
export function prototypeSkillDesignReply(sessionId: string, message: string): string {
	const draft = readPrototypeSkillDesign(sessionId);
	draft.notes.push(message);
	savePrototypeSkillDesignDraft(sessionId, draft);
	supplements.fire(sessionId);
	const missing = SKILL_DESIGN_FIELDS.filter(field => field.required && !draft[field.id].trim()).map(field => field.label);
	return chatTemplate.replace("{{goal}}", draft.goal || "尚未填写，可先在上方说明要解决的任务。")
		.replace("{{missing}}", missing.length ? `还需要补充：${missing.join("、")}。` : "四项核心信息已填写，可以生成预览，并进一步检查适用边界和验证例子。");
}
export function renderPrototypeSkillDesign(name: string, draft: PrototypeSkillDesignDraft): string {
	const values: Record<string, string> = { ...draft, name, description: JSON.stringify(draft.when.trim().replace(/\s+/g, " ")), notes: draft.notes.length ? draft.notes.map(note => `- ${note}`).join("\n") : "暂无补充。" };
	return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key]?.trim() || "待补充，可在补充讨论中继续完善。");
}
