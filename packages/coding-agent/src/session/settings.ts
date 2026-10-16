import { combine, effect, register, type SettingValueOf } from "../config/registry";
import {
	SERVICE_TIER_ANTHROPIC_OPTIONS,
	SERVICE_TIER_ANTHROPIC_VALUES,
	SERVICE_TIER_GOOGLE_OPTIONS,
	SERVICE_TIER_GOOGLE_VALUES,
	SERVICE_TIER_INHERIT_OPTIONS,
	SERVICE_TIER_INHERIT_SETTING_VALUES,
	SERVICE_TIER_OPENAI_OPTIONS,
	SERVICE_TIER_OPENAI_VALUES,
} from "../config/service-tier";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "../tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "../tiny/dtype";
import { DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS, MAX_WEB_SEARCH_TIMEOUT_SECONDS } from "../web/search/types";
import { DEFAULT_USAGE_RESERVE_PCT } from "@oh-my-pi/pi-ai/auth-storage";
import { configureProviderStoreResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { configureProviderMaxInFlightRequests } from "@oh-my-pi/pi-ai/stream";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { AUTO_THINKING, getConfiguredThinkingLevelMetadata, getThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";

const EMPTY_NUMBER_RECORD: Record<string, number> = {};
const EMPTY_STRING_ARRAYS_RECORD: Record<string, string[]> = {};
const DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS: string[] = ["wait"];

// Power assertions: macOS IOKit, Linux login1/ScreenSaver, Windows execution state.
export const cfgPowerSleepPrevention = register({
	id: "power.sleepPrevention",
	type: "enum",
	values: ["off", "idle", "display", "system"] as const,
	default: "idle",
	ui: {
		tab: "interaction",
		group: "电源",
		label: "防止休眠",
		description: "在活跃会话期间防止系统休眠。各级效果累积：每一级都会包含所有较低级别的标志。",
		options: [
			{
				value: "off",
				label: "关闭",
				description: "不阻止任何休眠",
			},
			{
				value: "idle",
				label: "防止空闲休眠",
				description: "会话打开时保持系统唤醒（macOS `caffeinate -i`）",
			},
			{
				value: "display",
				label: "防止显示器休眠",
				description: "同时阻止显示器因空闲而休眠（macOS `caffeinate -i -d`）",
			},
			{
				value: "system",
				label: "防止系统休眠",
				description: "同时在接通电源时阻止所有系统休眠，并声明用户处于活跃状态（macOS `caffeinate -i -d -s -u`）",
			},
		],
	},
});

export const cfgPrewalkEnabled = register({
	id: "prewalk.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Prewalk",
		label: "开启 Prewalk",
		description:
			"先使用当前模型，在计划提示的待办列表建立后，首次 edit/write 时切换到快速、低成本模型（默认为 'smol' 角色）：强模型负责规划、提交待办并开始实现，再进行交接。可通过 --prewalk / --no-prewalk 按会话覆盖。",
	},
});

function isLimitRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveLimit(limit: unknown): limit is number {
	return typeof limit === "number" && Number.isFinite(limit) && limit > 0;
}

/** Per-provider request limits floored to whole numbers ≥ 1; non-positive or non-numeric entries are dropped. */
export function normalizeProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	const normalized: Record<string, number> = {};
	if (!isLimitRecord(value)) return normalized;
	for (const provider in value) {
		const limit = value[provider];
		if (isPositiveLimit(limit)) normalized[provider] = Math.max(1, Math.floor(limit));
	}
	return normalized;
}

/**
 * Per-provider request limits floored to whole numbers ≥ 1.
 *
 * @throws Error naming every provider whose limit is not a positive number.
 */
export function validateProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (isLimitRecord(value)) {
		const invalidProviders: string[] = [];
		for (const provider in value) if (!isPositiveLimit(value[provider])) invalidProviders.push(provider);
		if (invalidProviders.length > 0) {
			throw new Error(`Provider request limits must be positive numbers: ${invalidProviders.join(", ")}`);
		}
	}
	return normalizeProviderMaxInFlightRequests(value);
}

export const cfgProvidersMaxInFlightRequests = register({
	id: "providers.maxInFlightRequests",
	type: "record",
	default: EMPTY_NUMBER_RECORD,
	validate: validateProviderMaxInFlightRequests,
	normalize: validateProviderMaxInFlightRequests,
	ui: {
		tab: "providers",
		group: "服务",
		label: "最大并发请求数",
		description:
			'按 Provider id（例如 "openai" 或 "anthropic"）限制最大并发 LLM 请求数，由使用此配置根目录的本地 OMP 进程共享。未列出的 Provider 不受限制。',
	},
});
effect(cfgProvidersMaxInFlightRequests, limits =>
	configureProviderMaxInFlightRequests(normalizeProviderMaxInFlightRequests(limits)),
);

export const cfgImagesDescribeForTextModels = register({
	id: "images.describeForTextModels",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "视觉",
		label: "为文本模型描述图片",
		description:
			"向不支持视觉的模型附加图片时，将图片保存到 local://，并注入支持视觉的模型生成的描述，而不是丢弃图片",
	},
});

// ────────────────────────────────────────────────────────────────────────
// Model
// ────────────────────────────────────────────────────────────────────────

// Reasoning and prompts
export const cfgDefaultThinkingLevel = register({
	id: "defaultThinkingLevel",
	type: "enum",
	values: [...THINKING_EFFORTS, AUTO_THINKING],
	default: "high",
	ui: {
		tab: "model",
		group: "思考",
		label: "思考级别",
		description: "支持思考的模型的推理深度",
		options: [getConfiguredThinkingLevelMetadata(AUTO_THINKING), ...THINKING_EFFORTS.map(getThinkingLevelMetadata)],
	},
});

export const cfgHideThinkingBlock = register({
	id: "hideThinkingBlock",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "思考",
		label: "隐藏思考块",
		description: "隐藏助手回复中的思考块",
	},
});

export const cfgExpandThinkingBlocks = register({
	id: "expandThinkingBlocks",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "思考",
		label: "展开思考块",
		description: "保持已完成的思考块展开，而不是在轮次结束时折叠",
		condition: "nativeRendering",
	},
});

export const cfgProseOnlyThinking = register({
	id: "proseOnlyThinking",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "思考",
		label: "纯文字思考",
		description: "从思考摘要中省略代码块，并以省略号替代",
	},
});

export const cfgOmitThinking = register({
	id: "omitThinking",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "思考",
		label: "省略思考摘要",
		description: "指示上游 Provider 从回复中完全省略思考摘要（需服务支持）",
	},
});

export const cfgExternalThinking = register({
	id: "externalThinking",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "思考",
		label: "外部思考",
		description: "使用不向用户展示的私有草稿区。关闭受支持的 GPT、Claude 和 Gemini 推理",
		warning: "风险自负：Provider 曾将此类请求判定为滥用，可能采取账户级处置",
	},
});

export const cfgModelLoopGuardEnabled = register({
	id: "model.loopGuard.enabled",
	type: "boolean",
	default: true,
	// Kill switch shared with pi-ai's stream-level guard (`utils/thinking-loop.ts`); only `1` disables.
	env: { name: "PI_NO_THINKING_LOOP_GUARD", parse: raw => (raw === "1" ? false : undefined) },
	ui: {
		tab: "model",
		group: "思考",
		label: "循环防护",
		description: "为模型推理和正文开启自动流式循环检测",
	},
});

export const cfgModelLoopGuardCheckAssistantContent = register({
	id: "model.loopGuard.checkAssistantContent",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "思考",
		label: "循环防护扫描正文",
		description: "除思考日志外，也对助手正文消息应用循环防护",
	},
});

export const cfgModelLoopGuardToolCallReminder = register({
	id: "model.loopGuard.toolCallReminder",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "思考",
		label: "循环防护工具调用提醒",
		description: "当 Gemini 推理流连续输出大量规划标题而不调用工具时，中断并注入工具调用提醒（需要开启循环防护）",
	},
});

export const cfgModelToolCallLoopGuardEnabled = register({
	id: "model.toolCallLoopGuard.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "思考",
		label: "工具调用循环防护",
		description: "检测跨轮次连续重复的相同工具调用，并注入纠正引导",
	},
});

export const cfgModelToolCallLoopGuardThreshold = register({
	id: "model.toolCallLoopGuard.threshold",
	type: "number",
	default: 5,
	ui: {
		tab: "model",
		group: "思考",
		label: "工具调用循环阈值",
		description: "连续出现多少次相同工具调用后注入纠正引导",
	},
});

export const cfgModelToolCallLoopGuardExemptTools = register({
	id: "model.toolCallLoopGuard.exemptTools",
	type: "array",
	default: DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS,
	ui: {
		tab: "model",
		group: "思考",
		label: "工具调用循环豁免工具",
		description: "允许连续重复调用而不触发跨轮次循环防护的工具名称",
	},
});

export const cfgInlineToolDescriptors = register({
	id: "inlineToolDescriptors",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "内联工具说明",
		description:
			"在系统 Prompt 中渲染完整工具说明，并从 Provider 工具 schema 中移除顶层及嵌套说明，避免重复发送。自动模式对 Gemini 模型开启，其他模型关闭",
		options: [
			{
				value: "auto",
				label: "自动",
				description: "对 Gemini 模型内联说明；其他模型保留在工具 schema 中",
			},
			{ value: "on", label: "开启", description: "始终在系统 Prompt 中内联说明" },
			{ value: "off", label: "关闭", description: "仅在 Provider 工具 schema 中保留说明" },
		],
	},
});

export const cfgIncludeModelInPrompt = register({
	id: "includeModelInPrompt",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Prompt",
		label: "在 Prompt 中包含模型",
		description: "在系统 Prompt 中展示当前模型标识，让 Agent 知道自己使用的模型",
	},
});

export const cfgIncludeWorkspaceTree = register({
	id: "includeWorkspaceTree",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Prompt",
		label: "包含工作区目录树",
		description: "在系统 Prompt 中渲染工作区目录树。警告：文件修改时可能使跨会话 Prompt 缓存失效。",
	},
});

export const cfgSkillful = register({
	id: "skillful",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Prompt",
		label: "在 Prompt 中列出 Skills",
		description: "在系统 Prompt 中列出可用 Skills；关闭可节省上下文，并可通过 /skillful 按会话切换",
	},
});

/** Personality preset. */
export type Personality = SettingValueOf<typeof cfgPersonality>;

export const cfgPersonality = register({
	id: "personality",
	type: "enum",
	values: ["default", "friendly", "pragmatic", "none"] as const,
	default: "default",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "个性",
		description: "写入系统 Prompt 个性块的沟通风格",
		options: [
			{
				value: "default",
				label: "默认",
				description: "简洁、证据优先的工程师；回复紧凑、注重行动",
			},
			{
				value: "friendly",
				label: "友好",
				description: "热情、善于鼓励的协作者，注重推进工作并鼓舞士气",
			},
			{
				value: "pragmatic",
				label: "务实",
				description: "直接、高效的工程师，注重清晰和严谨",
			},
			{ value: "none", label: "无", description: "完全省略个性块" },
		],
	},
});

// Sampling
export const cfgTemperature = register({
	id: "temperature",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "采样",
		label: "温度",
		description: "采样温度（0 = 确定性，1 = 创意，-1 = Provider 默认值）",
		options: [
			{ value: "-1", label: "默认", description: "使用 Provider 默认值" },
			{ value: "0", label: "0", description: "确定性" },
			{ value: "0.2", label: "0.2", description: "集中" },
			{ value: "0.5", label: "0.5", description: "均衡" },
			{ value: "0.7", label: "0.7", description: "创意" },
			{ value: "1", label: "1", description: "最大多样性" },
		],
	},
});

export const cfgTopP = register({
	id: "topP",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "采样",
		label: "Top P",
		description: "核采样截断值（0-1，-1 = Provider 默认值）",
		options: [
			{ value: "-1", label: "默认", description: "使用 Provider 默认值" },
			{ value: "0.1", label: "0.1", description: "高度集中" },
			{ value: "0.3", label: "0.3", description: "集中" },
			{ value: "0.5", label: "0.5", description: "均衡" },
			{ value: "0.9", label: "0.9", description: "广泛" },
			{ value: "1", label: "1", description: "不进行核采样筛选" },
		],
	},
});

export const cfgTopK = register({
	id: "topK",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "采样",
		label: "Top K",
		description: "从概率最高的 K 个 Token 中采样（-1 = Provider 默认值）",
		options: [
			{ value: "-1", label: "默认", description: "使用 Provider 默认值" },
			{ value: "1", label: "1", description: "贪心选择最高概率 Token" },
			{ value: "20", label: "20", description: "集中" },
			{ value: "40", label: "40", description: "均衡" },
			{ value: "100", label: "100", description: "广泛" },
		],
	},
});

export const cfgMinP = register({
	id: "minP",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "采样",
		label: "Min P",
		description: "最低概率阈值（0-1，-1 = Provider 默认值）",
		options: [
			{ value: "-1", label: "默认", description: "使用 Provider 默认值" },
			{ value: "0.01", label: "0.01", description: "非常宽松" },
			{ value: "0.05", label: "0.05", description: "均衡" },
			{ value: "0.1", label: "0.1", description: "严格" },
		],
	},
});

export const cfgPresencePenalty = register({
	id: "presencePenalty",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "采样",
		label: "存在惩罚",
		description: "对引入已出现 Token 的惩罚（-1 = Provider 默认值）",
		options: [
			{ value: "-1", label: "默认", description: "使用 Provider 默认值" },
			{ value: "0", label: "0", description: "无惩罚" },
			{ value: "0.5", label: "0.5", description: "轻度鼓励新颖性" },
			{ value: "1", label: "1", description: "鼓励新颖性" },
			{ value: "2", label: "2", description: "强烈鼓励新颖性" },
		],
	},
});

export const cfgRepetitionPenalty = register({
	id: "repetitionPenalty",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "采样",
		label: "重复惩罚",
		description: "对重复 Token 的惩罚（-1 = Provider 默认值）",
		options: [
			{ value: "-1", label: "默认", description: "使用 Provider 默认值" },
			{ value: "0.8", label: "0.8", description: "允许重复" },
			{ value: "1", label: "1", description: "无惩罚" },
			{ value: "1.1", label: "1.1", description: "轻度惩罚" },
			{ value: "1.2", label: "1.2", description: "均衡" },
			{ value: "1.5", label: "1.5", description: "强惩罚" },
		],
	},
});

const providerDefaultWhenNegative = (value: number): number | undefined => (value >= 0 ? value : undefined);

/** Agent sampling options; a negative sampling setting means "provider default" (`undefined`). */
export const cfgSampling = combine(
	{
		temperature: cfgTemperature,
		topP: cfgTopP,
		topK: cfgTopK,
		minP: cfgMinP,
		presencePenalty: cfgPresencePenalty,
		repetitionPenalty: cfgRepetitionPenalty,
		hideThinkingSummary: cfgOmitThinking,
	},
	values => ({
		temperature: providerDefaultWhenNegative(values.temperature),
		topP: providerDefaultWhenNegative(values.topP),
		topK: providerDefaultWhenNegative(values.topK),
		minP: providerDefaultWhenNegative(values.minP),
		presencePenalty: providerDefaultWhenNegative(values.presencePenalty),
		repetitionPenalty: providerDefaultWhenNegative(values.repetitionPenalty),
		hideThinkingSummary: values.hideThinkingSummary,
	}),
);

export const cfgTextVerbosity = register({
	id: "textVerbosity",
	type: "enum",
	values: ["low", "medium", "high"] as const,
	default: "medium",
	ui: {
		tab: "model",
		group: "采样",
		label: "文本详细程度",
		description: "OpenAI Responses 和 Codex 的回复详细程度（低、中或高）",
		options: [
			{ value: "low", label: "低", description: "倾向简洁回复" },
			{ value: "medium", label: "中", description: "兼顾简洁与细节（默认）" },
			{ value: "high", label: "高", description: "倾向详细回复" },
		],
	},
});

export const cfgTierOpenai = register({
	id: "tier.openai",
	type: "enum",
	values: SERVICE_TIER_OPENAI_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "采样",
		label: "服务等级 — OpenAI",
		description:
			"OpenAI / OpenAI-Codex 请求以及通过 OpenRouter 路由的 OpenAI 系列模型的处理等级（none = 不发送）。通过 `service_tier` 发送。",
		options: SERVICE_TIER_OPENAI_OPTIONS,
	},
});

export const cfgTierAnthropic = register({
	id: "tier.anthropic",
	type: "enum",
	values: SERVICE_TIER_ANTHROPIC_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "采样",
		label: "服务等级 — Anthropic",
		description:
			'Claude 请求的处理等级。`priority` 在支持的 Anthropic 直连模型上启用快速模式（`speed: "fast"`）；Bedrock/Vertex Claude 和通过 OpenRouter 的请求会忽略此设置。',
		options: SERVICE_TIER_ANTHROPIC_OPTIONS,
	},
});

export const cfgTierGoogle = register({
	id: "tier.google",
	type: "enum",
	values: SERVICE_TIER_GOOGLE_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "采样",
		label: "服务等级 — Google",
		description:
			"Gemini（Google AI Studio + Vertex）请求以及通过 OpenRouter 路由的 Google 系列模型的处理等级（none = 不发送）。作为顶层 `serviceTier` 字段发送。",
		options: SERVICE_TIER_GOOGLE_OPTIONS,
	},
});

export const cfgTierSubagent = register({
	id: "tier.subagent",
	type: "enum",
	values: SERVICE_TIER_INHERIT_SETTING_VALUES,
	default: "inherit",
	ui: {
		tab: "model",
		group: "采样",
		label: "服务等级 — Subagent",
		description:
			"新建的 task/eval Subagent 的服务等级。继承表示跟随主 Agent 各模型系列的实时等级（随 /fast 变化）；选择具体值则将其应用于 Subagent 模型所属系列。",
		options: SERVICE_TIER_INHERIT_OPTIONS,
	},
});

export const cfgTierAdvisor = register({
	id: "tier.advisor",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: SERVICE_TIER_INHERIT_SETTING_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "采样",
		label: "服务等级 — 顾问",
		description:
			"顾问模型的服务等级。无表示标准处理；继承表示跟随主 Agent 各模型系列的实时等级；选择具体值则将其应用于顾问模型所属系列。",
		options: SERVICE_TIER_INHERIT_OPTIONS,
		condition: "advisorEnabled",
	},
});

// Retries
export const cfgRetryEnabled = register({ id: "retry.enabled", type: "boolean", default: true });

export const cfgRetryMaxRetries = register({
	id: "retry.maxRetries",
	type: "number",
	default: 10,
	ui: {
		tab: "model",
		group: "重试与回退",
		label: "重试次数",
		description: "API 出错时的最大重试次数",
		options: [
			{ value: "1", label: "重试 1 次" },
			{ value: "2", label: "重试 2 次" },
			{ value: "3", label: "重试 3 次" },
			{ value: "5", label: "重试 5 次" },
			{ value: "10", label: "重试 10 次" },
		],
	},
});

export const cfgRetryBaseDelayMs = register({ id: "retry.baseDelayMs", type: "number", default: 500 });

export const cfgRetryMaxDelayMs = register({
	id: "retry.maxDelayMs",
	type: "number",
	default: 5 * 60 * 1000,
	ui: {
		tab: "model",
		group: "重试与回退",
		label: "最大重试延迟",
		description:
			"重试之间的最长等待时间，单位为毫秒。当 Provider 要求等待更久，且凭据或模型回退均未成功时，请求会立即失败而非休眠（例如 Anthropic 的 3 小时限流窗口）。0 表示取消上限，让会话在 Provider 指定的配额重置后自动恢复。",
	},
});

export const cfgRetryWaitForUsageReset = register({
	id: "retry.waitForUsageReset",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "重试与回退",
		label: "等待用量重置",
		get description() {
			return `当 Provider 报告用量耗尽并给出重置时间时（任意 Provider 的 5 小时或每周配额窗口），等待至重置，而不是在超过 retry.maxDelayMs 后立即失败。可中止等待（${formatKeyHint("escape")}），但等待也会阻塞 Subagent，因此无人值守运行时应关闭。`;
		},
	},
});

export const cfgRetryModelFallback = register({
	id: "retry.modelFallback",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "重试与回退",
		label: "重试模型回退",
		description: "Provider 出错后，允许重试恢复切换到 retry.fallbackChains 中的模型。独立于“自动升级上下文”",
	},
});

export const cfgRetryFallbackOn = register({
	id: "retry.fallbackOn",
	type: "enum",
	values: ["any", "usage-limit", "except-usage-limit"] as const,
	default: "any",
	ui: {
		tab: "model",
		group: "重试与回退",
		label: "回退触发条件",
		description: "哪些失败请求可以切换到已配置的回退模型",
		options: [
			{ value: "any", label: "任何错误", description: "任何 Provider 错误都可触发模型切换" },
			{
				value: "usage-limit",
				label: "仅用量限制",
				description: "仅在达到用量限制时切换；其他错误在同一模型上重试，之后向用户显示",
			},
			{
				value: "except-usage-limit",
				label: "除用量限制外的所有错误",
				description: "用量限制时等待或向用户显示错误；其他错误触发切换",
			},
		],
	},
});

export const cfgRetryUsageAwareFallback = register({
	id: "retry.usageAwareFallback",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "重试与回退",
		label: "用量感知回退",
		description:
			"根据可靠的编程套餐配额报告，在达到硬性用量限制前，优先选择同 Provider 账户，其次选择已配置的回退模型。不包含普通配置的 API 密钥。",
	},
});

export const cfgRetryUsageReservePct = register({
	id: "retry.usageReservePct",
	type: "number",
	default: DEFAULT_USAGE_RESERVE_PCT,
	ui: {
		tab: "model",
		group: "重试与回退",
		label: "预留余量",
		description: "编程套餐模型的剩余百分比低于此值时，视为接近限制。用量未知或未映射时保留主模型。",
		condition: "usageAwareFallbackEnabled",
		options: [
			{ value: "5", label: "5%", description: "仅在接近耗尽时处理" },
			{ value: "10", label: "10%", description: "均衡的安全余量" },
			{ value: "15", label: "15%", description: "保守" },
			{ value: "20", label: "20%", description: "提前保护" },
			{ value: "25", label: "25%", description: "非常保守" },
		],
	},
});

export const cfgRetryUsageReservePolicy = register({
	id: "retry.usageReservePolicy",
	type: "enum",
	values: ["confirm", "auto", "fail-closed"] as const,
	default: "confirm",
	ui: {
		tab: "model",
		group: "重试与回退",
		label: "预留策略",
		description: "同 Provider 的所有编程套餐账户都进入预留余量时采取的措施。",
		condition: "usageAwareFallbackEnabled",
		options: [
			{
				value: "confirm",
				label: "交互式确认",
				description: "交互式会话保持主模型直至确认；后台 Agent 自动回退",
			},
			{
				value: "auto",
				label: "自动回退",
				description: "始终选择下一个符合条件的已配置回退模型",
			},
			{
				value: "fail-closed",
				label: "保守失败",
				description: "既不消耗预留配额，也不选择回退模型",
			},
		],
	},
});

export const cfgRetryFallbackChains = register({
	id: "retry.fallbackChains",
	type: "record",
	default: EMPTY_STRING_ARRAYS_RECORD,
	ui: {
		tab: "model",
		group: "重试与回退",
		label: "重试回退链",
		description:
			'将模型角色、模型选择器（"provider/model-id"）或 Provider 通配符（"provider/*"）映射到有序回退选择器的 JSON 对象，例如 {"default":["openai/gpt-4o-mini"],"google-antigravity/*":["google/*","google-vertex/*"]}。面向模型的键在对应模型或 Provider 处于活跃状态时生效，与角色无关；"provider/*" 条目保留失败模型的 id，仅替换 Provider。带 id 前缀的通配符（"openrouter/google/*"）会为失败模型的裸 id 重新添加前缀（google-antigravity/gemini-x -> openrouter/google/gemini-x）；用作键时，仅匹配该 Provider 此前缀下的 id。回退条目可带显式思考后缀（"provider/model:low"、":high"、":max"、":off"）；不带后缀的条目继承失败轮次的思考强度，"provider/*" 条目始终继承。',
	},
});

export const cfgRetryFallbackRevertPolicy = register({
	id: "retry.fallbackRevertPolicy",
	type: "enum",
	values: ["cooldown-expiry", "never"] as const,
	default: "cooldown-expiry",
	ui: {
		tab: "model",
		group: "重试与回退",
		label: "回退恢复策略",
		description: "回退后何时恢复主模型",
		options: [
			{
				value: "cooldown-expiry",
				label: "冷却期结束",
				description: "主模型的抑制窗口结束后恢复主模型",
			},
			{ value: "never", label: "从不", description: "保持回退模型，直到手动更改" },
		],
	},
});

/** Retry/backoff and usage-aware fallback policy (`retry.*` except fallback chains/revert policy). */
export const cfgRetry = combine({
	enabled: cfgRetryEnabled,
	maxRetries: cfgRetryMaxRetries,
	baseDelayMs: cfgRetryBaseDelayMs,
	maxDelayMs: cfgRetryMaxDelayMs,
	waitForUsageReset: cfgRetryWaitForUsageReset,
	modelFallback: cfgRetryModelFallback,
	fallbackOn: cfgRetryFallbackOn,
	usageAwareFallback: cfgRetryUsageAwareFallback,
	usageReservePct: cfgRetryUsageReservePct,
	usageReservePolicy: cfgRetryUsageReservePolicy,
});

/** Retry/backoff policy ({@link cfgRetry}). */
export type RetrySettings = SettingValueOf<typeof cfgRetry>;

export const cfgProvidersAnthropicServerSideFallback = register({
	id: "providers.anthropic.serverSideFallback",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "重试与回退",
		label: "Anthropic 服务端回退（Fable 5）",
		description:
			"Claude Fable 5 / Mythos 5 请求被 Anthropic 安全分类器阻止时，在服务端使用 Claude Opus 5 重试（Anthropic `server-side-fallback-2026-06-01` 测试功能）。需主动开启；关闭时所有请求保持引入回退前的行为。",
	},
});

/**
 * Anthropic subscription slow mode (`off` | `auto`). Deliberately has no
 * `/settings` UI: `/slow on|off` on an Anthropic model is the only switch.
 * `auto` switches to low priority automatically when a Claude subscription
 * hits its 5-hour limit and Anthropic offers it. Wrap-up allowance tracking
 * runs either way; this only gates the low-priority lane.
 */
export const cfgProvidersAnthropicSlowMode = register({
	id: "providers.anthropic.slowMode",
	type: "enum",
	values: ["off", "auto"] as const,
	default: "off" as const,
});

// Provider selection
export const cfgProvidersOllamaCloudMaxConcurrency = register({
	id: "providers.ollama-cloud.maxConcurrency",
	type: "number",
	default: 3,
	ui: {
		tab: "providers",
		group: "服务",
		label: "Ollama Cloud 最大并发数",
		description: "每个进程中 Ollama Cloud Subagent 的最大并发运行数；0 表示取消此 Provider 专属限制",
	},
});

export const cfgProvidersWebSearchTimeoutSeconds = register({
	id: "providers.webSearchTimeoutSeconds",
	type: "number",
	default: DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	ui: {
		tab: "providers",
		group: "服务",
		label: "网络搜索超时",
		description: `各 Provider 搜索传输的硬超时，超时后 web_search 尝试下一回退项，单位为秒（最大 ${MAX_WEB_SEARCH_TIMEOUT_SECONDS}）`,
		options: [
			{ value: "30", label: "30 秒" },
			{ value: "60", label: "1 分钟" },
			{ value: "120", label: "2 分钟" },
			{ value: "180", label: "3 分钟" },
			{ value: "300", label: "5 分钟" },
		],
	},
});

export const cfgProvidersAntigravityEndpoint = register({
	id: "providers.antigravityEndpoint",
	type: "enum",
	values: ["auto", "production", "sandbox"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "服务",
		label: "Antigravity 端点模式",
		description: "google-antigravity Provider 的端点路由策略（聊天、搜索、图片、发现）",
		options: [
			{
				value: "auto",
				label: "自动",
				description: "尝试生产端点，遇到 5xx/429 时切换到沙箱",
			},
			{
				value: "production",
				label: "仅生产环境",
				description: "强制仅使用生产端点",
			},
			{
				value: "sandbox",
				label: "仅沙箱环境",
				description: "强制仅使用沙箱端点",
			},
		],
	},
});

export const cfgProvidersFireworksTier = register({
	id: "providers.fireworksTier",
	type: "enum",
	values: ["standard", "priority"] as const,
	default: "standard",
	ui: {
		tab: "providers",
		group: "Fireworks",
		label: "Fireworks 服务等级",
		description:
			'Fireworks 请求的服务路径。优先模式发送 `service_tier: "priority"`，以更高价格获得高峰流量下更高的可靠性；标准模式不发送。Fast（`-fast`）模型会忽略此设置，因为 Fast 使用独立的服务路径。',
		options: [
			{ value: "standard", label: "标准", description: "默认服务路径（不发送 service_tier）" },
			{
				value: "priority",
				label: "优先",
				description: "优先服务路径：可靠性更高，按 Token 收取更高费用",
			},
		],
	},
});

export const cfgProvidersTinyModelDevice = register({
	id: "providers.tinyModelDevice",
	type: "enum",
	values: TINY_MODEL_DEVICE_SETTING_VALUES,
	default: TINY_MODEL_DEVICE_DEFAULT,
	env: {
		name: "PI_TINY_DEVICE",
		parse: raw => TINY_MODEL_DEVICE_SETTING_VALUES.find(value => value === raw.trim().toLowerCase()),
	},
	ui: {
		tab: "providers",
		group: "微型模型",
		label: "微型模型设备",
		description:
			"本地微型模型（标题与记忆）的推理后端：可使用 ONNX 执行提供程序，或使用 `mlx` 下载 MLX 权重并通过 mlx-lm 在 Apple silicon 上运行。默认使用仅 CPU 的 ONNX。PI_TINY_DEVICE 环境变量会覆盖此设置。",
		options: TINY_MODEL_DEVICE_SETTING_OPTIONS,
	},
});

export const cfgProvidersTinyModelDtype = register({
	id: "providers.tinyModelDtype",
	type: "enum",
	values: TINY_MODEL_DTYPE_SETTING_VALUES,
	default: TINY_MODEL_DTYPE_DEFAULT,
	env: {
		name: "PI_TINY_DTYPE",
		parse: raw => TINY_MODEL_DTYPE_SETTING_VALUES.find(value => value === raw.trim().toLowerCase()),
	},
	ui: {
		tab: "providers",
		group: "微型模型",
		label: "微型模型精度",
		description:
			"本地微型模型的 ONNX 量化与精度。默认使用各模型自带的 dtype（q4）；精度越低速度越快，精度越高还原度越好。MLX 后端忽略此设置（其仓库已预先量化为 4 位）。PI_TINY_DTYPE 环境变量会覆盖此设置。",
		options: TINY_MODEL_DTYPE_SETTING_OPTIONS,
	},
});

export const cfgProvidersAutoThinkingMaxEffort = register({
	id: "providers.autoThinkingMaxEffort",
	type: "enum",
	values: ["xhigh", "max"] as const,
	default: "xhigh",
	ui: {
		tab: "model",
		group: "思考",
		label: "自动思考上限",
		description:
			"`auto` 分类器可判定的最高思考强度。`xhigh` 将分类器限制在最高等级之下一级，只有显式 `ultrathink` 才能达到 `max`；`max` 则允许被分类器判定为特殊情况的轮次，在支持的模型上使用最高等级计费。",
		condition: "autoThinkingActive",
		options: [
			{ value: "xhigh", label: "xhigh", description: "分类器最高使用 xhigh（默认）" },
			{ value: "max", label: "max", description: "模型支持时，分类器可使用 max" },
		],
	},
});

export const cfgFeaturesUnexpectedStopDetection = register({
	id: "features.unexpectedStopDetection",
	type: "enum",
	values: ["none", "mechanical", "smart"] as const,
	default: "mechanical",
	ui: {
		tab: "interaction",
		group: "Agent",
		label: "意外停止",
		description: "助手停止且没有可见消息时自动恢复。智能模式还会使用小模型对仅含文本的停止进行分类。",
		options: [
			{ value: "none", label: "无", description: "关闭" },
			{
				value: "mechanical",
				label: "机械检测",
				description: "没有可见助手消息时重试；不包含工具调用（默认）",
			},
			{
				value: "smart",
				label: "智能检测",
				description: "机械检测加上小模型对仅含文本的停止进行分类",
			},
		],
	},
});

export const cfgProvidersKimiApiFormat = register({
	id: "providers.kimiApiFormat",
	type: "enum",
	values: ["auto", "openai", "anthropic"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "协议",
		label: "Kimi API 格式",
		description: "Kimi Code Provider 的 API 格式（自动模式跟随实时模型元数据）",
		options: [
			{ value: "auto", label: "自动", description: "使用服务端为模型声明的协议" },
			{ value: "openai", label: "OpenAI", description: "api.kimi.com" },
			{ value: "anthropic", label: "Anthropic", description: "api.moonshot.ai" },
		],
	},
});

export const cfgProvidersOpenaiWebsockets = register({
	id: "providers.openaiWebsockets",
	type: "enum",
	values: ["auto", "off", "on"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "协议",
		label: "OpenAI WebSockets",
		description: "OpenAI Codex 模型的 WebSocket 策略（auto 使用模型默认值，on 强制开启，off 关闭）",
		options: [
			{ value: "auto", label: "自动", description: "使用模型或 Provider 默认的 WebSocket 行为" },
			{ value: "off", label: "关闭", description: "为 OpenAI Codex 模型关闭 WebSocket" },
			{ value: "on", label: "开启", description: "为 OpenAI Codex 模型强制开启 WebSocket" },
		],
	},
});

export const cfgProvidersOpenaiLiveSteering = register({
	id: "providers.openaiLiveSteering",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "协议",
		label: "OpenAI 实时引导",
		description:
			"GPT-6 回复流式输出期间，将输入的消息通过 Codex WebSocket 直接传入当前回复，而不是等到下一个工具边界",
	},
});

export const cfgProvidersMuseCodeStoreResponses = register({
	id: "providers.muse-code.storeResponses",
	type: "boolean",
	default: false,
	env: "PI_MUSE_STORE_RESPONSES",
	ui: {
		tab: "providers",
		group: "协议",
		label: "Muse Code 回复存储",
		description:
			"将 Muse Code 结果存储在 Meta 服务器，以便连接中断时恢复当前轮次，而不是重新运行。存储的运行会在 Meta 端保留 Prompt 和输出。",
	},
});
// Process-wide too, so side requests that call `completeSimple`/`streamSimple`
// directly (titles, commit messages, memories) follow the setting.
effect(cfgProvidersMuseCodeStoreResponses, enabled => configureProviderStoreResponses({ "muse-code": enabled }));

export const cfgProvidersCacheRetention = register({
	id: "providers.cacheRetention",
	type: "enum",
	values: ["auto", "short", "long", "none"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "协议",
		label: "Prompt 缓存保留时间",
		description: "向支持的 Provider（Anthropic、Bedrock、OpenRouter、OpenAI）传递 Prompt 缓存保留时间",
		options: [
			{
				value: "auto",
				label: "自动",
				description:
					"Provider 默认值：Anthropic OAuth 订阅会话默认为 1 小时，API 密钥使用 5 分钟；PI_CACHE_RETENTION 仍然生效",
			},
			{
				value: "short",
				label: "短期（5 分钟）",
				description: "缓存写入成本最低；配合缓存预热可在空闲时保持短期条目有效",
			},
			{
				value: "long",
				label: "长期（1 小时）",
				description: "Provider 支持时使用 1 小时 TTL；写入成本较高，仅在活跃运行期间预热",
			},
			{ value: "none", label: "关闭", description: "关闭 Prompt 缓存和缓存亲和路由" },
		],
	},
});

export const cfgProvidersCacheWarming = register({
	id: "providers.cacheWarming",
	type: "enum",
	values: ["off", "streaming", "idle"] as const,
	default: "idle",
	ui: {
		tab: "providers",
		group: "协议",
		label: "缓存预热",
		description: "在 Prompt 缓存条目即将过期前，以一个 Token 的输出预算重新发送上次请求",
		options: [
			{ value: "off", label: "关闭", description: "关闭缓存预热" },
			{
				value: "streaming",
				label: "流式输出期间",
				description: "长时间执行工具时保护高成本前缀；Agent 停止活动后结束",
			},
			{
				value: "idle",
				label: "空闲期间",
				description: "在预期节省仍高于成本下限时，也在运行间隙刷新 5 分钟缓存条目",
			},
		],
	},
});

export const cfgProvidersStreamFirstEventTimeoutSeconds = register({
	id: "providers.streamFirstEventTimeoutSeconds",
	type: "number",
	default: -1,
	ui: {
		tab: "providers",
		group: "超时",
		label: "流式首事件超时",
		description: "等待首个模型流事件的秒数；-1 使用 Provider 或环境变量默认值，0 关闭超时监控",
		options: [
			{ value: "-1", label: "自动", description: "使用 Provider 默认值和 PI_* 超时环境变量" },
			{ value: "0", label: "关闭", description: "关闭首事件超时" },
			{ value: "300", label: "5 分钟" },
			{ value: "600", label: "10 分钟" },
			{ value: "1800", label: "30 分钟" },
		],
	},
});

export const cfgProvidersStreamIdleTimeoutSeconds = register({
	id: "providers.streamIdleTimeoutSeconds",
	type: "number",
	default: -1,
	ui: {
		tab: "providers",
		group: "超时",
		label: "流式空闲超时",
		description: "模型流在相邻事件之间允许无响应的秒数；-1 使用 Provider 或环境变量默认值，0 关闭超时监控",
		options: [
			{ value: "-1", label: "自动", description: "使用 Provider 默认值和 PI_* 超时环境变量" },
			{ value: "0", label: "关闭", description: "关闭空闲超时" },
			{ value: "300", label: "5 分钟" },
			{ value: "600", label: "10 分钟" },
			{ value: "1800", label: "30 分钟" },
		],
	},
});

export const cfgProvidersOpenrouterVariant = register({
	id: "providers.openrouterVariant",
	type: "enum",
	values: ["default", "nitro", "floor", "online", "exacto"] as const,
	default: "default",
	ui: {
		tab: "providers",
		group: "协议",
		label: "OpenRouter 路由",
		description: "默认附加到 OpenRouter 模型 ID 的路由变体后缀（选择器已指定变体时会覆盖此设置）",
		options: [
			{ value: "default", label: "默认", description: "不加后缀；使用 OpenRouter 默认路由" },
			{ value: "nitro", label: ":nitro", description: "优先选择高吞吐量或低延迟" },
			{ value: "floor", label: ":floor", description: "优先选择价格最低的可用 Provider" },
			{ value: "online", label: ":online", description: "开启 OpenRouter 网络搜索插件" },
			{
				value: "exacto",
				label: ":exacto",
				description: "精选高质量 Provider（仅部分模型支持）",
			},
		],
	},
});

export const cfgProvidersFetch = register({
	id: "providers.fetch",
	type: "enum",
	values: ["auto", "native", "trafilatura", "lynx", "parallel", "firecrawl", "jina"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "服务",
		label: "网页获取 Provider",
		description: "fetch/read URL 工具的阅读器后端优先级",
		options: [
			{
				value: "auto",
				label: "自动",
				description: "优先级：native > trafilatura > lynx > parallel > firecrawl > jina",
			},
			{ value: "native", label: "原生", description: "进程内 HTML→Markdown 转换器（始终可用）" },
			{ value: "trafilatura", label: "Trafilatura", description: "通过 uv/pip 自动安装" },
			{ value: "lynx", label: "Lynx", description: "需要 lynx 系统软件包" },
			{ value: "parallel", label: "Parallel", description: "需要 PARALLEL_API_KEY" },
			{ value: "firecrawl", label: "Firecrawl", description: "需要 FIRECRAWL_API_KEY" },
			{ value: "jina", label: "Jina", description: "使用 r.jina.ai 阅读器（JINA_API_KEY 可选）" },
		],
	},
});

// Codex saved rate-limit resets (auto-redeem)
export const cfgCodexResetsAutoRedeem = register({
	id: "codexResets.autoRedeem",
	type: "enum",
	values: ["unset", "yes", "no"] as const,
	default: "unset" as const,
	ui: {
		tab: "providers",
		group: "服务",
		label: "Codex 自动兑换已保存的重置额度",
		description:
			"自动消耗已保存的 Codex 限流重置额度：轮次受阻且无其他账户可接管时，恢复因 5 小时或每周配额耗尽而受限的账户，并利用即将过期的额度。unset 在首次消耗前询问（无提示界面时，仅消耗 5 分钟内过期的额度），yes 无需询问直接消耗，no 关闭两项检查。",
		options: [
			{
				value: "unset",
				label: "未设置",
				description:
					"检查是否符合条件，在首次消耗已保存的重置额度前询问。无提示界面时，仅消耗 5 分钟内过期的额度。",
			},
			{ value: "yes", label: "是", description: "无需询问，消耗符合条件的已保存重置额度。" },
			{ value: "no", label: "否", description: "不执行已保存重置额度的自动兑换检查。" },
		],
	},
});

export const cfgCodexResetsMinBlockedMinutes = register({
	id: "codexResets.minBlockedMinutes",
	type: "number",
	default: 60,
	ui: {
		tab: "providers",
		group: "服务",
		label: "Codex 自动兑换最短受限时间",
		description:
			"仅在自然解除限制（已耗尽的 5 小时或每周窗口中最晚的重置时间）距今至少达到此分钟数时自动兑换，避免为了缩短少量等待而消耗稀缺额度。提高此值（如 360）可忽略仅 5 小时窗口导致的限制。",
	},
});

export const cfgCodexResetsKeepCredits = register({
	id: "codexResets.keepCredits",
	type: "number",
	default: 0,
	ui: {
		tab: "providers",
		group: "服务",
		label: "Codex 自动兑换预留额度",
		description:
			"自动消耗后保留的重置额度不得少于此数量（0 = 允许自动消耗最后一份额度）。即将过期的额度不受此限制，因为保留至过期没有收益。",
	},
});

export const cfgCodexResetsSalvageHorizonHours = register({
	id: "codexResets.salvageHorizonHours",
	type: "number",
	default: 12,
	ui: {
		tab: "providers",
		group: "服务",
		label: "Codex 重置额度临期利用窗口",
		description:
			"开启自动兑换后，当任一聊天配额窗口已有实质用量，且已保存的 Codex 重置额度将在此小时数内过期时消耗该额度。0 关闭提前利用；对于 5 分钟内过期的额度，仍会尝试消耗，不受用量影响。",
	},
});

/** Codex saved-reset auto-redeem policy (`codexResets.*`). */
export const cfgCodexResets = combine({
	autoRedeem: cfgCodexResetsAutoRedeem,
	minBlockedMinutes: cfgCodexResetsMinBlockedMinutes,
	keepCredits: cfgCodexResetsKeepCredits,
	salvageHorizonHours: cfgCodexResetsSalvageHorizonHours,
});

/** Whether automatic reset redemption asks first, spends, or remains disabled. */
export type ResetAutoRedeemMode = SettingValueOf<typeof cfgCodexResetsAutoRedeem>;

// Claude Cedar/Juniper rate-limit resets (independent auto-redeem consent)
export const cfgClaudeResetsAutoRedeem = register({
	id: "claudeResets.autoRedeem",
	type: "enum",
	values: ["unset", "yes", "no"] as const,
	default: "unset" as const,
	ui: {
		tab: "providers",
		group: "服务",
		label: "Claude 自动兑换重置额度",
		description:
			"自动消耗符合条件的 Claude Cedar 或 Juniper 重置额度。Cedar 仅用于其覆盖的限制；Juniper 仅能恢复单独的 5 小时窗口限制。unset 在首次消耗前询问（无提示界面时，仅消耗 5 分钟内过期的额度），yes 无需询问直接消耗，no 关闭受限恢复和临期利用。",
		options: [
			{
				value: "unset",
				label: "未设置",
				description:
					"实时检查是否符合条件，在首次消耗 Claude 重置额度前询问。无提示界面时，仅消耗 5 分钟内过期的额度。",
			},
			{ value: "yes", label: "是", description: "无需询问，消耗符合条件的 Claude 重置额度。" },
			{ value: "no", label: "否", description: "不执行 Claude 重置额度的自动兑换检查。" },
		],
	},
});

export const cfgClaudeResetsMinBlockedMinutes = register({
	id: "claudeResets.minBlockedMinutes",
	type: "number",
	default: 60,
	ui: {
		tab: "providers",
		group: "服务",
		label: "Claude 自动兑换最短受限时间",
		description:
			"仅在自然解除限制（已耗尽且受覆盖的窗口中最晚的重置时间）距今至少达到此分钟数时自动兑换。仅适用于 5 小时窗口的重置额度绝不用于每周或特定模型的限制。",
	},
});

export const cfgClaudeResetsKeepCredits = register({
	id: "claudeResets.keepCredits",
	type: "number",
	default: 0,
	ui: {
		tab: "providers",
		group: "服务",
		label: "Claude 自动兑换预留额度",
		description:
			"至少保留此数量的 Claude 重置额度（0 允许自动消耗最后一份符合条件的额度）。预留限制适用于提前利用，但不适用于 5 分钟内过期且符合条件的额度。",
	},
});

export const cfgClaudeResetsSalvageHorizonHours = register({
	id: "claudeResets.salvageHorizonHours",
	type: "number",
	default: 12,
	ui: {
		tab: "providers",
		group: "服务",
		label: "Claude 重置额度临期利用窗口",
		description:
			"开启自动兑换后，当服务端选定的 Cedar 重置额度将在此小时数内过期，且其覆盖的窗口已有实质用量时使用该额度。0 关闭提前利用；对于 5 分钟内过期且符合条件的 Cedar 或 Juniper 额度，仍会尝试消耗，不受用量或预留额度影响。Provider 的限制条件仍然适用。",
	},
});

/** Claude reset auto-redeem policy (`claudeResets.*`), independent of {@link cfgCodexResets}. */
export const cfgClaudeResets = combine({
	autoRedeem: cfgClaudeResetsAutoRedeem,
	minBlockedMinutes: cfgClaudeResetsMinBlockedMinutes,
	keepCredits: cfgClaudeResetsKeepCredits,
	salvageHorizonHours: cfgClaudeResetsSalvageHorizonHours,
});

export const cfgProviderAppendOnlyContext = register({
	id: "provider.appendOnlyContext",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "协议",
		label: "仅追加上下文",
		description:
			"缓存系统 Prompt 与工具规格，并保持消息日志仅追加，使 Provider（DeepSeek、Xiaomi/SGLang、Anthropic）的前缀缓存获得最高命中率。自动模式对已知支持前缀缓存的 Provider 开启。",
		options: [
			{ value: "auto", label: "自动", description: "为已知支持前缀缓存的 Provider 开启（推荐）" },
			{ value: "on", label: "开启", description: "始终开启仅追加上下文" },
			{ value: "off", label: "关闭", description: "关闭仅追加上下文" },
		],
	},
});

export const cfgThinkingBudgetsMinimal = register({ id: "thinkingBudgets.minimal", type: "number", default: 1024 });

export const cfgThinkingBudgetsLow = register({ id: "thinkingBudgets.low", type: "number", default: 2048 });

export const cfgThinkingBudgetsMedium = register({ id: "thinkingBudgets.medium", type: "number", default: 8192 });

export const cfgThinkingBudgetsHigh = register({ id: "thinkingBudgets.high", type: "number", default: 16384 });

export const cfgThinkingBudgetsXhigh = register({ id: "thinkingBudgets.xhigh", type: "number", default: 32768 });

export const cfgThinkingBudgetsMax = register({ id: "thinkingBudgets.max", type: "number", default: 32768 });

/** Token budget per thinking level (`thinkingBudgets.*`) on transports that accept reasoning token budgets. */
export const cfgThinkingBudgets = combine({
	minimal: cfgThinkingBudgetsMinimal,
	low: cfgThinkingBudgetsLow,
	medium: cfgThinkingBudgetsMedium,
	high: cfgThinkingBudgetsHigh,
	xhigh: cfgThinkingBudgetsXhigh,
	max: cfgThinkingBudgetsMax,
});
