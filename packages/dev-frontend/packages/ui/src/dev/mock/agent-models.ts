import type { ModelSelection } from "@zcode/shared";
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
	{ id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", providerId: "prototype-anthropic", provider: "Anthropic" },
	{ id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", providerId: "prototype-anthropic", provider: "Anthropic" },
	{ id: "openai/gpt-5.2", name: "GPT-5.2", providerId: "prototype-openai", provider: "OpenAI" },
	{ id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", providerId: "prototype-deepseek", provider: "DeepSeek" },
	{ id: "opencode/beam-free", name: "Beam Free", providerId: "prototype-opencode-go", provider: "OpenCode Go" },
];

const sampleSettings: PrototypeAgentModelSettings = {
	defaultModel: "anthropic/claude-sonnet-4.5",
	agents: [
		{ id: "requirements", name: "业务需求 Agent", nameEn: "Requirements Agent", description: "澄清业务目标，整理 IR 与 SR。", descriptionEn: "Clarify business goals and organize requirements.", model: "openai/gpt-5.2", reasoning: "high" },
		{ id: "requirements-review", name: "业务需求评审 Agent", nameEn: "Business Requirements Review Agent", description: "审查业务需求 Agent 的产物，检查需求完整性、一致性与可验收性。", descriptionEn: "Review the Requirements Agent's output for completeness, consistency and verifiability.", model: "anthropic/claude-opus-4.5", reasoning: "high" },
		{ id: "solution", name: "方案 Agent", nameEn: "Solution Agent", description: "在提案阶段完成技术方案，明确 SR 实施顺序、依赖及可并行范围；业务缺口打回补充，执行阶段不再启动。", descriptionEn: "Design the proposal solution and SR order, dependencies and parallel scope. Return business gaps for clarification; do not restart this role during execution.", model: "anthropic/claude-opus-4.5", reasoning: "high" },
		{ id: "planning", name: "计划 Agent", nameEn: "Planning Agent", description: "依据已确认方案与 SR 依赖编制开发计划，明确任务范围和验证步骤。", descriptionEn: "Plan the SR tasks and verification using the confirmed design and dependencies.", model: "inherit", reasoning: "default" },
		{ id: "execution", name: "执行 Agent", nameEn: "Execution Agent", description: "按计划实施、测试和代码审查，整理完成报告；代码、测试及该 SR 的规格更新随同一 PR 交付。", descriptionEn: "Implement, test and review the SR; deliver its code, tests and specification updates in the same PR.", model: "anthropic/claude-sonnet-4.5", reasoning: "medium" },
		{ id: "ir-acceptance", name: "IR 验收 Agent", nameEn: "IR Acceptance Agent", description: "全部 SR 合并后整体验收 IR，修复实现问题并复验，准备最终修复与归档 PR；归档不再同步规格，由人工创建、评审和合并 PR。", descriptionEn: "Accept the integrated IR after all SRs merge, fix implementation issues and reverify. Prepare the final fixes and archive PR without resyncing specs; humans create, review and merge it.", model: "anthropic/claude-opus-4.5", reasoning: "high" },
	],
};

// 模拟运行 Web 服务的 OMP 账号／profile 配置，不随浏览器工号切换。
// 原型配置只存在于本页内存，离开设置后可读回；刷新页面恢复样例。
let savedSettings = structuredClone(sampleSettings);
export function readPrototypeAgentModels(): PrototypeAgentModelSettings {
	return structuredClone(savedSettings);
}
export function savePrototypeAgentModels(settings: PrototypeAgentModelSettings): void {
	savedSettings = structuredClone(settings);
 configurationRevision += 1;
 for (const listener of listeners) listener();
}
export function createPrototypeAgentModelSamples(): PrototypeAgentModelSettings {
	return structuredClone(sampleSettings);
}

export type PrototypeAgentRole = "requirements" | "requirements-review" | "solution" | "planning" | "execution" | "ir-acceptance";
export interface PrototypeAgentModelBinding {
 role: PrototypeAgentRole;
 roleName: string;
 modelKey: string;
 modelName: string;
 providerId: string;
 modelId: string;
 reasoning: string;
 inherited: boolean;
 configurationRevision: number;
}
let configurationRevision = 1;
const listeners = new Set<() => void>();
export function prototypeAgentModelConfigurationRevision(): number { return configurationRevision; }
export function subscribePrototypeAgentModels(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** 角色会话创建时复制的演示配置，不调用或验证真实模型。 */
export function readPrototypeAgentModelBinding(role: PrototypeAgentRole): PrototypeAgentModelBinding {
 const agent = savedSettings.agents.find(item => item.id === role);
 if (!agent) throw new Error("此 Dev Agent 未配置。");
 const inherited = agent.model === "inherit";
 const modelKey = inherited ? savedSettings.defaultModel : agent.model;
 const model = PROTOTYPE_AGENT_MODELS.find(item => item.id === modelKey);
 if (!model) throw new Error("请选择原型支持的演示模型。");
 return { role, roleName: agent.name, modelKey, modelName: model.name, providerId: model.providerId, modelId: model.name, reasoning: agent.reasoning, inherited, configurationRevision };
}
export function prototypeAgentModelBindingChanged(binding: PrototypeAgentModelBinding): boolean {
 const latest = readPrototypeAgentModelBinding(binding.role);
 return latest.modelKey !== binding.modelKey || latest.reasoning !== binding.reasoning || latest.inherited !== binding.inherited;
}

export function prototypeAgentModelSelection(binding: PrototypeAgentModelBinding): ModelSelection {
 return { providerId: binding.providerId, modelId: binding.modelId, ...(binding.reasoning !== "default" ? { options: { reasoningLevel: binding.reasoning } } : {}) };
}
