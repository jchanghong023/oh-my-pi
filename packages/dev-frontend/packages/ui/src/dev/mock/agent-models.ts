export interface PrototypeAgentModel {
	id: string;
	name: string;
	nameEn: string;
	description: string;
	descriptionEn: string;
	model: string;
	reasoning: string;
}

export interface PrototypeAgentModelSettings {
	defaultModel: string;
	agents: PrototypeAgentModel[];
}

export const PROTOTYPE_AGENT_MODELS = [
	{ id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", provider: "Anthropic" },
	{ id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", provider: "Anthropic" },
	{ id: "openai/gpt-5.2", name: "GPT-5.2", provider: "OpenAI" },
	{ id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", provider: "DeepSeek" },
	{ id: "opencode/beam-free", name: "Beam Free", provider: "OpenCode Go" },
];

const sampleSettings: PrototypeAgentModelSettings = {
	defaultModel: "anthropic/claude-sonnet-4.5",
	agents: [
		{ id: "requirements", name: "业务需求 Agent", nameEn: "Requirements Agent", description: "澄清业务目标，整理 IR 与 SR。", descriptionEn: "Clarify business goals and organize requirements.", model: "openai/gpt-5.2", reasoning: "high" },
		{ id: "requirements-review", name: "需求评审 Agent", nameEn: "Requirements Review Agent", description: "审查业务需求 Agent 的产物，检查需求完整性、一致性与可验收性。", descriptionEn: "Review the Requirements Agent's output for completeness, consistency and verifiability.", model: "anthropic/claude-opus-4.5", reasoning: "high" },
		{ id: "solution", name: "方案 Agent", nameEn: "Solution Agent", description: "分析技术选型，设计实现方案。", descriptionEn: "Evaluate technical choices and design a solution.", model: "anthropic/claude-opus-4.5", reasoning: "high" },
		{ id: "planning", name: "计划 Agent", nameEn: "Planning Agent", description: "拆分任务，安排依赖与验证步骤。", descriptionEn: "Break down tasks, dependencies and verification steps.", model: "inherit", reasoning: "default" },
		{ id: "execution", name: "执行 Agent", nameEn: "Execution Agent", description: "按计划组织实施与验证，处理反馈并整理完成报告和 PR 材料。", descriptionEn: "Coordinate implementation and verification, address feedback, and prepare completion reports and PR materials.", model: "anthropic/claude-sonnet-4.5", reasoning: "medium" },
	],
};

// 原型配置只存在于本页内存，离开设置后可读回；刷新页面恢复样例。
let savedSettings = structuredClone(sampleSettings);
export function readPrototypeAgentModels(): PrototypeAgentModelSettings {
	return structuredClone(savedSettings);
}
export function savePrototypeAgentModels(settings: PrototypeAgentModelSettings): void {
	savedSettings = structuredClone(settings);
}
export function createPrototypeAgentModelSamples(): PrototypeAgentModelSettings {
	return structuredClone(sampleSettings);
}
