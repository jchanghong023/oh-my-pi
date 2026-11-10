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
export const PROTOTYPE_SKILL_DESIGN_EXAMPLES = [
	{ id: "api", label: "接口评审", draft: PROTOTYPE_SKILL_DESIGN_SAMPLE },
	{ id: "docs", label: "文档整理", draft: {
		name: "organize-project-docs", goal: "整理分散的项目文档，形成可追溯的交接说明",
		when: "用户需要归纳项目资料、整理交接文档或梳理已有决定时使用。",
		inputs: "用户提供的文档、会议记录及明确的整理范围。",
		outputs: "输出背景、已确定事项、待确认问题和资料索引，每项重要结论标明来源。",
		boundaries: "不编造业务决定，不覆盖原始资料；没有来源的说法标为待确认。",
		references: "先列出资料清单，再按主题归纳并保留来源路径，报告矛盾和缺失。",
		example: "输入两份对上线时间说法不一致的记录，输出冲突说明及待确认责任人，不自行选择日期。", notes: [],
	} },
	{ id: "code", label: "代码检查", draft: {
		name: "review-code-changes", goal: "检查代码变更中的缺陷和回归风险",
		when: "用户请求代码审查，或希望在提交前检查当前改动时使用。",
		inputs: "当前变更、相关调用代码、项目约定和已有验证结果。",
		outputs: "按影响排序列出可复现的问题，给出文件位置、触发条件、影响和修正建议。",
		boundaries: "只审查，不直接修改代码；风格偏好与真实缺陷分开，未运行的测试明确标注。",
		references: "先理解调用关系和约束，再检查异常分支、边界输入及现有测试覆盖。",
		example: "输入空集合处理的改动，检查是否会在读取首项时抛错，并给出复现输入。", notes: [],
	} },
	{ id: "workflow", label: "固定流程", draft: {
		name: "prepare-release-handoff", goal: "按固定检查清单准备版本交接材料",
		when: "用户明确要求整理发布前交接材料时使用。",
		inputs: "本次范围、变更清单、实际测试记录和已有部署说明。",
		outputs: "产出变更摘要、验证结果、风险与回退说明，并列出缺失材料及责任人。",
		boundaries: "只准备材料，不执行发布、推送或平台审批；缺失结果不标为通过。",
		references: "核对交付范围，整理实际证据，检查风险与回退步骤，最后交由人员确认。",
		example: "测试报告缺失时，交接清单显示待补充，不根据代码已提交推断测试通过。", notes: [],
	} },
] satisfies { id: string; label: string; draft: PrototypeSkillDesignDraft }[];
export type PrototypeSkillDesignField = (typeof SKILL_DESIGN_FIELDS)[number]["id"];
export interface PrototypeSkillSuggestion {
	id: string;
	field: PrototypeSkillDesignField;
	label: string;
	addition: string;
	status: "pending" | "applied" | "ignored";
}
const suggestionExamples: Omit<PrototypeSkillSuggestion, "status">[] = [
	{ id: "boundaries", field: "boundaries", label: "边界与不适用场景", addition: "信息不足时先列出待确认项，不自行补齐事实。" },
	{ id: "outputs", field: "outputs", label: "期望结果与成功标准", addition: "结果区分已确认事实、待核实项和未执行的验证，重要结论注明依据。" },
	{ id: "example", field: "example", label: "真实例子或失败情况", addition: "输入不足时，先说明缺少哪些资料和下一步需要用户补充什么，不声称任务已完成。" },
];
export function prototypeSkillSuggestions(draft: PrototypeSkillDesignDraft): PrototypeSkillSuggestion[] {
	return suggestionExamples.filter(item => !draft[item.field].includes(item.addition)).map(item => ({ ...item, status: "pending" }));
}
export function prototypeSkillName(draft: PrototypeSkillDesignDraft): string {
	return draft.name.trim() || PROTOTYPE_SKILL_DESIGN_EXAMPLES.find(example => example.draft.goal === draft.goal)?.draft.name
		|| (draft.goal.toLowerCase().includes("接口") || draft.goal.toLowerCase().includes("api") ? "review-api-changes" : "project-skill");
}
const drafts = new Map<string, PrototypeSkillDesignDraft>();
const suggestions = createPrototypeEvent<string>();
export const onPrototypeSkillDesignSupplement = suggestions.event;
export function prototypeSkillDesignSession(projectId: string): string { return `prototype-skill-design:${projectId}`; }
export function readPrototypeSkillDesign(sessionId: string): PrototypeSkillDesignDraft { return structuredClone(drafts.get(sessionId) ?? emptyDraft); }
export function savePrototypeSkillDesignDraft(sessionId: string, value: PrototypeSkillDesignDraft): void { drafts.set(sessionId, structuredClone(value)); }
export function prototypeSkillDesignReply(sessionId: string, message: string): string {
	const draft = readPrototypeSkillDesign(sessionId);
	draft.notes.push(message);
	savePrototypeSkillDesignDraft(sessionId, draft);
	suggestions.fire(sessionId);
	const missing = SKILL_DESIGN_FIELDS.filter(field => field.required && !draft[field.id].trim()).map(field => field.label);
	return chatTemplate.replace("{{goal}}", draft.goal || "尚未填写，可先在上方说明要解决的任务。")
		.replace("{{missing}}", missing.length ? `还需要补充：${missing.join("、")}。` : "四项核心信息已填写，可以生成预览，并进一步检查适用边界和验证例子。");
}
export function renderPrototypeSkillDesign(name: string, draft: PrototypeSkillDesignDraft): string {
	const values: Record<string, string> = { ...draft, name, description: JSON.stringify(draft.when.trim().replace(/\s+/g, " ")), notes: draft.notes.length ? draft.notes.map(note => `- ${note}`).join("\n") : "暂无补充。" };
	return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key]?.trim() || "待补充，可在补充讨论中继续完善。");
}
