import { requirePrototypeSettingsWrite } from "./backend.js";
import { PROTOTYPE_BACKEND } from "./backend.js";
import type { DevAgentModel, DevAgentModelSettings, DevAgentRole, DevAgentModelBinding } from "../types.js";
import type { ModelSelection } from "@zcode/shared";

export const PROTOTYPE_AGENT_MODELS = [
	{ id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", providerId: "prototype-anthropic", provider: "Anthropic" },
	{ id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", providerId: "prototype-anthropic", provider: "Anthropic" },
	{ id: "openai/gpt-5.2", name: "GPT-5.2", providerId: "prototype-openai", provider: "OpenAI" },
	{ id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", providerId: "prototype-deepseek", provider: "DeepSeek" },
	{ id: "opencode/beam-free", name: "Beam Free", providerId: "prototype-opencode-go", provider: "OpenCode Go" },
];

const sampleSettings: DevAgentModelSettings = {
	defaultModel: "anthropic/claude-sonnet-4.5",
	agents: [
		{ id: "requirements", name: "业务需求 Agent", nameEn: "Requirements Agent", description: "澄清业务目标，整理 IR 与 SR。", descriptionEn: "Clarify business goals and organize requirements.", model: "openai/gpt-5.2", reasoning: "high" },
    { id: "requirements-review-a", name: "需求评审 A", nameEn: "Requirements Reviewer A", description: "与 B、C 并行只读审查同版 IR／SR，独立保留问题与依据。", descriptionEn: "Independently review the same IR/SR version alongside B and C.", model: "anthropic/claude-opus-4.5", reasoning: "high" },
    { id: "requirements-review-b", name: "需求评审 B", nameEn: "Requirements Reviewer B", description: "使用不同模型独立只读审查，不参考 A、C 的结论。", descriptionEn: "Read-only review with a different model, independently of A and C.", model: "openai/gpt-5.2", reasoning: "high" },
    { id: "requirements-review-c", name: "需求评审 C", nameEn: "Requirements Reviewer C", description: "使用第三个模型审查边界、异常与可验收性。", descriptionEn: "Use a third model to review boundaries, exceptions and verifiability.", model: "deepseek/deepseek-v3.2", reasoning: "high" },
    { id: "requirements-review", name: "综合评审 Agent", nameEn: "Review Synthesis Agent", description: "等待 A／B／C 报告完成后综合去重，保留来源与分歧；不替人决定通过。", descriptionEn: "Synthesize completed A/B/C reports, retaining sources and disagreements. Humans decide approval.", model: "anthropic/claude-sonnet-4.5", reasoning: "high" },
		{ id: "solution", name: "方案 Agent", nameEn: "Solution Agent", description: "在提案阶段完成技术方案，明确 SR 实施顺序、依赖及可并行范围；业务缺口打回补充，执行阶段不再启动。", descriptionEn: "Design the proposal solution and SR order, dependencies and parallel scope. Return business gaps for clarification; do not restart this role during execution.", model: "anthropic/claude-opus-4.5", reasoning: "high" },
		{ id: "planning", name: "计划 Agent", nameEn: "Planning Agent", description: "依据已确认方案与 SR 依赖编制开发计划，明确任务范围和验证步骤。", descriptionEn: "Plan the SR tasks and verification using the confirmed design and dependencies.", model: "inherit", reasoning: "default" },
		{ id: "execution", name: "执行 Agent", nameEn: "Execution Agent", description: "按计划实施、测试和代码审查，整理完成报告；代码、测试及该 SR 的规格更新随同一 PR 交付。", descriptionEn: "Implement, test and review the SR; deliver its code, tests and specification updates in the same PR.", model: "anthropic/claude-sonnet-4.5", reasoning: "medium" },
		{ id: "ir-acceptance", name: "IR 验收 Agent", nameEn: "IR Acceptance Agent", description: "全部 SR 合并后整体验收 IR，修复实现问题并复验，准备最终修复与归档 PR；归档不再同步规格，由人工创建、评审和合并 PR。", descriptionEn: "Accept the integrated IR after all SRs merge, fix implementation issues and reverify. Prepare the final fixes and archive PR without resyncing specs; humans create, review and merge it.", model: "anthropic/claude-opus-4.5", reasoning: "high" },
    { id: "skill-design", name: "Skill 设计 Agent", nameEn: "Skill Design Agent", description: "在独立设计会话中澄清技能需求、推荐标识并生成临时文件；预览确认后保存到项目或个人技能目录。", descriptionEn: "Clarify skill requirements in a dedicated session, recommend a name, and prepare temporary files for preview before explicitly saving to project or personal skills.", model: "inherit", reasoning: "default" },
	],
};

// 模拟当前开发者后端自己的 OMP profile；不共享到团队 Web 或其他开发者，不随浏览器工号切换。
// 原型配置只存在于本页内存，离开设置后可读回；刷新页面恢复样例。
let savedSettings = structuredClone(sampleSettings);
if (PROTOTYPE_BACKEND.owner === "j00808875") savedSettings.defaultModel = "openai/gpt-5.2";
export function readPrototypeAgentModels(): DevAgentModelSettings {
	return structuredClone(savedSettings);
}
export function savePrototypeAgentModels(settings: DevAgentModelSettings): void {
  requirePrototypeSettingsWrite();
	savedSettings = structuredClone(settings);
 configurationRevision += 1;
 for (const listener of listeners) listener();
}
export function createPrototypeAgentModelSamples(): DevAgentModelSettings {
	return structuredClone(sampleSettings);
}

let configurationRevision = 1;
const listeners = new Set<() => void>();
export function prototypeAgentModelConfigurationRevision(): number { return configurationRevision; }
export function subscribePrototypeAgentModels(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** 角色会话创建时复制的演示配置，不调用或验证真实模型。 */
export function readPrototypeAgentModelBinding(role: DevAgentRole): DevAgentModelBinding {
 const agent = savedSettings.agents.find(item => item.id === role);
 if (!agent) throw new Error("此 Dev Agent 未配置。");
 const inherited = agent.model === "inherit";
 const modelKey = inherited ? savedSettings.defaultModel : agent.model;
 const model = PROTOTYPE_AGENT_MODELS.find(item => item.id === modelKey);
 if (!model) throw new Error("请选择原型支持的演示模型。");
 return { role, roleName: agent.name, modelKey, modelName: model.name, providerId: model.providerId, modelId: model.name, reasoning: agent.reasoning, inherited, configurationRevision };
}
export function prototypeAgentModelBindingChanged(binding: DevAgentModelBinding): boolean {
 const latest = readPrototypeAgentModelBinding(binding.role);
 return latest.modelKey !== binding.modelKey || latest.reasoning !== binding.reasoning || latest.inherited !== binding.inherited;
}

export function prototypeAgentModelSelection(binding: DevAgentModelBinding): ModelSelection {
 return { providerId: binding.providerId, modelId: binding.modelId, ...(binding.reasoning !== "default" ? { options: { reasoningLevel: binding.reasoning } } : {}) };
}
