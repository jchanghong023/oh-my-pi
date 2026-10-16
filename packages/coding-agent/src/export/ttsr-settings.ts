/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { combine, register, type SettingValueOf } from "../config/registry";

// TTSR
export const cfgTtsrEnabled = register({
	id: "ttsr.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "规则 (TTSR)",
		label: "TTSR",
		description: "输出匹配规则模式时，在流式生成中打断 Agent（Time-Traveling Stream Rules）",
	},
});

export const cfgTtsrJudge = register({
	id: "ttsr.judge",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "context",
		group: "规则 (TTSR)",
		label: "模型判定规则",
		description:
			"由 judge 模型角色根据每条 `question` 规则检查已完成的回复、推理和工具调用；判定为是时将规则作为警告注入",
		options: [
			{
				value: "auto",
				label: "自动",
				description: "仅当 judge 角色解析为原生 TypeSafe jev 模型时进行判定",
			},
			{ value: "on", label: "开启", description: "始终判定，不论 judge 角色解析为何种模型" },
			{ value: "off", label: "关闭", description: "从不判定；question 规则保持停用" },
		],
	},
});

export const cfgTtsrContextMode = register({
	id: "ttsr.contextMode",
	type: "enum",
	values: ["discard", "keep"] as const,
	default: "discard",
	ui: {
		tab: "context",
		group: "规则 (TTSR)",
		label: "TTSR 上下文模式",
		description: "TTSR 触发时如何处理已生成的部分输出",
	},
});

export const cfgTtsrInterruptMode = register({
	id: "ttsr.interruptMode",
	type: "enum",
	values: ["never", "prose-only", "tool-only", "always"] as const,
	default: "always",
	ui: {
		tab: "context",
		group: "规则 (TTSR)",
		label: "TTSR 打断模式",
		description: "何时在流式生成中打断，何时完成后注入警告",
		options: [
			{ value: "always", label: "始终", description: "正文和工具流均可触发打断" },
			{ value: "prose-only", label: "仅正文", description: "仅回复或思考匹配时打断" },
			{ value: "tool-only", label: "仅工具", description: "仅工具调用参数匹配时打断" },
			{ value: "never", label: "永不", description: "从不打断；完成后注入警告" },
		],
	},
});

export const cfgTtsrRepeatMode = register({
	id: "ttsr.repeatMode",
	type: "enum",
	values: ["once", "after-gap"] as const,
	default: "once",
	ui: {
		tab: "context",
		group: "规则 (TTSR)",
		label: "TTSR 重复模式",
		description: "规则的重复方式：每个会话一次，或间隔一定消息后再次触发",
	},
});

export const cfgTtsrRepeatGap = register({
	id: "ttsr.repeatGap",
	type: "number",
	default: 10,
	ui: {
		tab: "context",
		group: "规则 (TTSR)",
		label: "TTSR 重复间隔",
		description: "规则再次触发前所需的消息数",
		options: [
			{ value: "5", label: "5 条消息" },
			{ value: "10", label: "10 条消息" },
			{ value: "15", label: "15 条消息" },
			{ value: "20", label: "20 条消息" },
			{ value: "30", label: "30 条消息" },
		],
	},
});

export const cfgTtsrBuiltinRules = register({
	id: "ttsr.builtinRules",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "规则 (TTSR)",
		label: "内置规则",
		description: "加载 Agent 随附的默认规则（可通过 ttsr.disabledRules 逐条覆盖）",
	},
});

export const cfgTtsrDisabledRules = register({
	id: "ttsr.disabledRules",
	type: "array",
	default: [] as string[],
	ui: {
		tab: "context",
		group: "规则 (TTSR)",
		label: "已禁用规则",
		description: "完全忽略的规则名称（适用于内置默认规则和自定义规则）",
	},
});

/** Time-traveling stream rules configuration (`ttsr.*`). */
export const cfgTtsr = combine({
	enabled: cfgTtsrEnabled,
	judge: cfgTtsrJudge,
	contextMode: cfgTtsrContextMode,
	interruptMode: cfgTtsrInterruptMode,
	repeatMode: cfgTtsrRepeatMode,
	repeatGap: cfgTtsrRepeatGap,
	builtinRules: cfgTtsrBuiltinRules,
	disabledRules: cfgTtsrDisabledRules,
});

/** Time-traveling stream rules configuration ({@link cfgTtsr}). */
export type TtsrSettings = SettingValueOf<typeof cfgTtsr>;
