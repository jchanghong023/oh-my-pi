import {
	type AgentCompactionThresholdOverride,
	validateModelCompactionThresholds,
} from "../config/compaction-threshold";
import { combine, register, type SettingValueOf } from "../config/registry";
import { COMPACTION_METHOD_CHOICES, DEFAULT_COMPACTION_METHOD_ORDER } from "./compaction-methods";
import { SHAPE_VARIANT_NAMES } from "@oh-my-pi/snapcompact";

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_MODEL_COMPACTION_THRESHOLDS: Record<string, AgentCompactionThresholdOverride> = {};

export const cfgWorkspaceAdditionalDirectories = register({
	id: "workspace.additionalDirectories",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "context",
		group: "常规",
		label: "附加工作区目录",
		description:
			"为每个会话添加额外工作区根目录（多根工作区）。可通过 /add-dir 和 /remove-dir 实时管理。相对路径基于 cwd 解析；建议使用绝对路径。Agent 会获知这些根目录，并可使用 read/grep/glob 读取和搜索。",
	},
});

/** Built-in context filenames. Listing them in `contextFiles.extra` would load a second copy or bypass one-per-depth shadowing. */
const BUILTIN_CONTEXT_FILE_NAMES: Record<string, true> = {
	"agents.md": true,
	"claude.md": true,
	"gemini.md": true,
	"copilot-instructions.md": true,
};

/** Why `entry` is not a valid `contextFiles.extra` name; undefined for a plain, non-built-in file name. */
function contextFileNameError(entry: unknown): string | undefined {
	if (typeof entry !== "string") return `contextFiles.extra entries must be strings (${String(entry)})`;
	const name = entry.trim();
	if (name === "") return "contextFiles.extra entries must not be empty";
	if (BUILTIN_CONTEXT_FILE_NAMES[name.toLowerCase()] === true) {
		return `contextFiles.extra cannot list a built-in context file (${name})`;
	}
	if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
		return `contextFiles.extra entries must be file names, not paths (${name})`;
	}
	return undefined;
}

/** Extra instruction filenames discovered in addition to AGENTS.md / CLAUDE.md / GEMINI.md. */
export const cfgContextFilesExtra = register({
	id: "contextFiles.extra",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "context",
		group: "常规",
		label: "额外上下文文件",
		editor: "json",
		description:
			'在 AGENTS.md 之外加载的额外指令文件名。使用名称而非路径的 JSON 列表，例如 ["AGENTS.local.md"]；[] 表示关闭额外文件。新建会话后加载。',
		condition: "contextFilesExtraNotProject",
	},
	validate: raw => {
		if (raw === undefined) return;
		if (!Array.isArray(raw)) throw new Error("contextFiles.extra must be a list of file names");
		for (const entry of raw) {
			const error = contextFileNameError(entry);
			if (error !== undefined) throw new Error(error);
		}
	},
});

// ────────────────────────────────────────────────────────────────────────
// Context
// ────────────────────────────────────────────────────────────────────────

// Context promotion
export const cfgContextPromotionEnabled = register({
	id: "contextPromotion.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "常规",
		label: "自动升级上下文",
		description:
			"上下文溢出时切换到模型的 contextPromotionTarget，而不是压缩上下文。重试回退切换由“重试模型回退”控制",
	},
});

// Opt in to advertised maximum context windows and premium long-context
// tiers. Off preserves default windows and caps premium models before
// requests cross into their higher pricing tier.
export const cfgExtendedContext = register({
	id: "extendedContext",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "常规",
		label: "扩展上下文",
		description: "在支持时使用更大的上下文窗口，可能产生额外费用。关闭时保留默认窗口或标准定价窗口",
	},
});

// Compaction
export const cfgCompactionEnabled = register({
	id: "compaction.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "自动压缩上下文",
		description: "上下文过大时自动压缩",
	},
});

export const cfgCompactionExperimentalContextManagement = register({
	id: "compaction.experimentalContextManagement",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "基于笔记的上下文窗口（实验功能）",
		description: "在不同上下文窗口之间保留持久化笔记和可搜索的原始历史。",
	},
});

export const cfgCompactionMidTurnEnabled = register({
	id: "compaction.midTurnEnabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "轮次内上下文压缩",
		description:
			"在轮次内安全的工具循环边界、下一次 Provider 请求前检查阈值；Subagent 始终检查，因为其整个任务只占一个轮次",
	},
});

export const cfgCompactionMethodOrder = register({
	id: "compaction.methodOrder",
	type: "array",
	default: [...DEFAULT_COMPACTION_METHOD_ORDER],
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "上下文压缩方法顺序",
		description: "自动维护上下文时首选的回退顺序；方法不可用或失败时尝试下一项",
		options: COMPACTION_METHOD_CHOICES,
		ordered: true,
	},
});

export const cfgCompactionThresholdPercent = register({
	id: "compaction.thresholdPercent",
	type: "number",
	default: -1,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "上下文压缩阈值",
		description: "上下文维护的百分比阈值；设为“默认”可使用旧版基于预留空间的行为",
		options: [
			{ value: "default", label: "默认", description: "旧版基于预留空间的阈值" },
			{ value: "10", label: "10%", description: "极早维护" },
			{ value: "20", label: "20%", description: "很早维护" },
			{ value: "30", label: "30%", description: "提早维护" },
			{ value: "40", label: "40%", description: "适度提早维护" },
			{ value: "50", label: "50%", description: "使用到一半时维护" },
			{ value: "60", label: "60%", description: "中等上下文用量" },
			{ value: "70", label: "70%", description: "均衡" },
			{ value: "75", label: "75%", description: "略高上下文用量" },
			{ value: "80", label: "80%", description: "常用阈值" },
			{ value: "85", label: "85%", description: "较高上下文用量" },
			{ value: "90", label: "90%", description: "很高上下文用量" },
			{ value: "95", label: "95%", description: "接近上下文上限" },
		],
	},
});

export const cfgCompactionThresholdTokens = register({
	id: "compaction.thresholdTokens",
	type: "number",
	default: -1,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "上下文压缩 Token 上限",
		description: "上下文维护的固定 Token 上限；设置后优先于百分比阈值",
		options: [
			{ value: "default", label: "默认", description: "使用百分比阈值" },
			{ value: "25000", label: "25K Token", description: "200K 窗口的 1/8" },
			{ value: "50000", label: "50K Token", description: "200K 窗口的 1/4" },
			{ value: "100000", label: "100K Token", description: "200K 窗口的 1/2" },
			{ value: "150000", label: "150K Token", description: "200K 窗口的 3/4" },
			{ value: "200000", label: "200K Token", description: "完整标准上下文窗口" },
			{ value: "300000", label: "300K Token", description: "大型上下文窗口" },
			{ value: "500000", label: "500K Token", description: "超大型上下文窗口" },
		],
	},
});

/**
 * Per-model compaction limits for the models they match: `provider/model-id`
 * exactly, else the longest `…*` prefix. A token entry is the base the
 * threshold policy scales in place of the window (see
 * `applyModelCompactionThreshold`); a percentage entry replaces both
 * `compaction.threshold*` fields. Edited from the /models hub; a per-agent
 * `task.agentCompactionThresholdOverrides` entry still wins. A token base past a
 * model's standard window opts that model into its extended window
 * (`ModelRegistry.contextWindowTiers`).
 */
export const cfgCompactionModelThresholds = register({
	id: "compaction.modelThresholds",
	type: "record",
	default: EMPTY_MODEL_COMPACTION_THRESHOLDS,
	validate: validateModelCompactionThresholds,
});

/**
 * Whether `compaction.modelThresholds` applies. Subagent spawn turns it off for an
 * agent whose `task.agentCompactionThresholdOverrides` entry applies, so that entry
 * outranks every model entry, including ones added while the agent runs.
 */
export const cfgCompactionModelThresholdsEnabled = register({
	id: "compaction.modelThresholdsEnabled",
	type: "boolean",
	default: true,
});

export const cfgCompactionHandoffSaveToDisk = register({
	id: "compaction.handoffSaveToDisk",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "保存交接文档",
		description: "将生成的交接文档保存为 markdown 文件，用于自动交接流程",
	},
});

export const cfgCompactionRemoteStreamingV2Enabled = register({
	id: "compaction.remoteStreamingV2Enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "远程上下文压缩 V2",
		description: "对兼容的远程压缩模型使用 Responses 流式压缩",
	},
});

export const cfgCompactionAsyncEnabled = register({
	id: "compaction.asyncEnabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "异步上下文压缩",
		description: "上下文接近压缩阈值时，在后台预先生成摘要；超过阈值后接入已准备好的结果",
	},
});

// No default: an unset reserve tells the compaction layer the user never
// chose one, so small-window recovery may swap in the proportional reserve
// (see resolveBudgetReserveTokens). A materialized 16384 here would make
// every session look explicitly configured.
export const cfgCompactionReserveTokens = register({
	id: "compaction.reserveTokens",
	type: "number",
	default: undefined,
});

export const cfgCompactionKeepRecentTokens = register({
	id: "compaction.keepRecentTokens",
	type: "number",
	default: 20000,
});

export const cfgCompactionAutoContinue = register({ id: "compaction.autoContinue", type: "boolean", default: true });

export const cfgCompactionRemoteEndpoint = register({
	id: "compaction.remoteEndpoint",
	type: "string",
	default: undefined,
});

export const cfgCompactionV2RetainedMessageBudget = register({
	id: "compaction.v2RetainedMessageBudget",
	type: "number",
	default: 64000,
});

// Idle compaction
export const cfgCompactionIdleEnabled = register({
	id: "compaction.idleEnabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "空闲上下文压缩",
		description: "空闲时若 Token 数超过阈值，则压缩上下文",
	},
});

export const cfgCompactionIdleThresholdTokens = register({
	id: "compaction.idleThresholdTokens",
	type: "number",
	default: 200000,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "空闲上下文压缩阈值",
		description: "触发空闲压缩的 Token 数下限",
		options: [
			{ value: "100000", label: "100K Token" },
			{ value: "200000", label: "200K Token" },
			{ value: "300000", label: "300K Token" },
			{ value: "400000", label: "400K Token" },
			{ value: "500000", label: "500K Token" },
			{ value: "600000", label: "600K Token" },
			{ value: "700000", label: "700K Token" },
			{ value: "800000", label: "800K Token" },
			{ value: "900000", label: "900K Token" },
		],
	},
});

export const cfgCompactionIdleTimeoutSeconds = register({
	id: "compaction.idleTimeoutSeconds",
	type: "number",
	default: 300,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "空闲上下文压缩延迟",
		description: "空闲后等待多少秒再压缩；使用 1 小时提示缓存时，改为在缓存即将过期前执行压缩",
		options: [
			{ value: "60", label: "1 分钟" },
			{ value: "120", label: "2 分钟" },
			{ value: "300", label: "5 分钟" },
			{ value: "600", label: "10 分钟" },
			{ value: "1800", label: "30 分钟" },
			{ value: "3600", label: "1 小时" },
		],
	},
});

export const cfgCompactionSupersedeReads = register({
	id: "compaction.supersedeReads",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "替代过时的读取结果",
		description: "再次读取同一文件时移除旧的读取结果（考虑缓存，每轮执行）",
	},
});

export const cfgCompactionDropUseless = register({
	id: "compaction.dropUseless",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "上下文压缩",
		label: "省略无实质内容的结果",
		description: "工具结果被使用后，移除被标记为对上下文无用的结果（无匹配结果、等待超时等；考虑缓存）",
	},
});

/** Every `compaction.*` setting as one memoized snapshot (the configured compaction policy). */
export const cfgCompaction = combine({
	enabled: cfgCompactionEnabled,
	experimentalContextManagement: cfgCompactionExperimentalContextManagement,
	methodOrder: cfgCompactionMethodOrder,
	thresholdPercent: cfgCompactionThresholdPercent,
	thresholdTokens: cfgCompactionThresholdTokens,
	reserveTokens: cfgCompactionReserveTokens,
	keepRecentTokens: cfgCompactionKeepRecentTokens,
	midTurnEnabled: cfgCompactionMidTurnEnabled,
	asyncEnabled: cfgCompactionAsyncEnabled,
	handoffSaveToDisk: cfgCompactionHandoffSaveToDisk,
	autoContinue: cfgCompactionAutoContinue,
	remoteEndpoint: cfgCompactionRemoteEndpoint,
	remoteStreamingV2Enabled: cfgCompactionRemoteStreamingV2Enabled,
	v2RetainedMessageBudget: cfgCompactionV2RetainedMessageBudget,
	idleEnabled: cfgCompactionIdleEnabled,
	idleThresholdTokens: cfgCompactionIdleThresholdTokens,
	idleTimeoutSeconds: cfgCompactionIdleTimeoutSeconds,
	supersedeReads: cfgCompactionSupersedeReads,
	dropUseless: cfgCompactionDropUseless,
});

/**
 * Configured compaction policy ({@link cfgCompaction}). `baseWindowTokens` is
 * never configured directly: a `compaction.modelThresholds` token entry sets it
 * for its model (see `applyModelCompactionThreshold`).
 */
export type CompactionSettings = SettingValueOf<typeof cfgCompaction> & { baseWindowTokens?: number };

// Experimental: snapcompact inline imaging (transient, per-request; never persisted)
export const cfgSnapcompactSystemPrompt = register({
	id: "snapcompact.systemPrompt",
	type: "enum",
	values: ["none", "agents-md", "all"] as const,
	default: "none",
	ui: {
		tab: "context",
		group: "实验功能",
		label: "Snapcompact 系统 Prompt",
		description:
			"实验功能：将选定的系统 Prompt 文本渲染为高密度 PNG 图片，并附加到第一条用户消息（仅限视觉模型）。节省 Token，但图片化文本将无法使用 Prompt 缓存。",
		options: [
			{ value: "none", label: "无", description: "保留文本形式的系统 Prompt。" },
			{
				value: "agents-md",
				label: "AGENTS.md",
				description: "仅在能节省 Token 时，将已加载的上下文文件指令转为图片。",
			},
			{
				value: "all",
				label: "全部",
				description: "在能节省 Token 时，将完整系统 Prompt 转为图片。",
			},
		],
	},
});

export const cfgSnapcompactToolResults = register({
	id: "snapcompact.toolResults",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "实验功能",
		label: "Snapcompact 工具结果",
		description:
			"实验功能：将大型工具结果（包括最新一条）渲染为高密度 PNG 图片，而非文本（仅限视觉模型）。可减少累计搜索和命令输出的 Token；读取结果仍保留为文本，除非已知模型能准确依据图片编辑。",
	},
});

export const cfgToolsFormat = register({
	id: "tools.format",
	type: "enum",
	values: [
		"auto",
		"native",
		"glm",
		"hermes",
		"kimi",
		"xml",
		"anthropic",
		"deepseek",
		"harmony",
		"qwen3",
		"gemini",
		"gemma",
		"minimax",
	] as const,
	default: "auto",
	ui: {
		tab: "context",
		group: "实验功能",
		label: "工具调用模式",
		description:
			"控制向模型提供工具的方式。自动模式使用 Provider 原生工具调用；若所选模型被标记为不支持，则回退到内置 GLM 方言。原生模式强制使用 Provider 原生工具；其他值强制使用对应的内置方言。",
		options: [
			{
				value: "auto",
				label: "自动",
				description: "使用原生工具调用，除非已知模型不支持。",
			},
			{ value: "native", label: "原生", description: "使用 Provider 原生工具调用。" },
			{ value: "glm", label: "GLM", description: "使用 GLM 风格的带内工具调用。" },
			{ value: "hermes", label: "Hermes", description: "使用 Hermes 风格的带内工具调用。" },
			{ value: "kimi", label: "Kimi", description: "使用 Kimi 风格的带内工具调用。" },
			{ value: "xml", label: "XML", description: "使用通用 XML 带内工具调用。" },
			{ value: "anthropic", label: "Anthropic", description: "使用 Anthropic 风格的带内工具调用。" },
			{ value: "deepseek", label: "DeepSeek", description: "使用 DeepSeek 风格的带内工具调用。" },
			{ value: "harmony", label: "Harmony", description: "使用 Harmony 风格的带内工具调用。" },
			{ value: "qwen3", label: "Qwen3", description: "使用内置 Qwen3 方言。" },
			{ value: "gemini", label: "Gemini", description: "使用内置 Gemini 方言。" },
			{ value: "gemma", label: "Gemma", description: "使用内置 Gemma 方言。" },
			{ value: "minimax", label: "MiniMax", description: "使用内置 MiniMax 方言。" },
		],
	},
});

export const cfgSnapcompactShape = register({
	id: "snapcompact.shape",
	type: "enum",
	values: ["auto", ...SHAPE_VARIANT_NAMES] as const,
	default: "auto",
	ui: {
		tab: "context",
		group: "实验功能",
		label: "Snapcompact 图像版式",
		description: "snapcompact 输出文本时使用的图像版式（用于压缩归档和内联图片）。自动模式选择适合当前模型的版式。",
		options: [
			{
				value: "auto",
				label: "自动",
				description: "选择适合当前模型的版式，未匹配时回退到其 Provider 系列。",
			},
			{
				value: "8x8r-bw",
				label: "8x8 重复，黑色",
				description: "unscii 方形字符单元，黑色墨迹，每行打印两次，副本位于浅色高亮带上。",
			},
			{
				value: "8x8r-sent",
				label: "8x8 重复，逐句配色",
				description: "重复网格，在句子边界循环切换六种墨迹颜色。",
			},
			{
				value: "8x8u-bw",
				label: "8x8，黑色",
				description: "普通 unscii 方形字符单元，单次打印各行，黑色墨迹。",
			},
			{
				value: "8x8u-sent",
				label: "8x8，逐句配色",
				description: "普通 unscii 方形字符单元，逐句切换墨迹颜色。",
			},
			{
				value: "6x6u-bw",
				label: "6x6 密集，黑色",
				description: "将 unscii 压缩至 6x6：最密集的可读字符单元、最少的图像帧，使用黑色墨迹。",
			},
			{
				value: "6x6u-sent",
				label: "6x6 密集，逐句配色",
				description: "最密集的字符单元，逐句切换墨迹颜色。",
			},
			{
				value: "5x8-bw",
				label: "5x8 旧版，黑色",
				description: "在 2576px 图像帧上使用原始 X.org 5x8 字形，黑色墨迹。",
			},
			{
				value: "5x8-sent",
				label: "5x8 旧版，逐句配色",
				description: "原始 snapcompact 版式（引入版式表之前的会话使用此版式渲染）。",
			},
			{
				value: "6x12-dim",
				label: "6x12，淡化停用词",
				description: "X.org 6x12 字形，黑色墨迹，功能词以灰色淡化。",
			},
			{
				value: "8x13-bw",
				label: "8x13，黑色",
				description: "X.org 8x13 字形，黑色墨迹。",
			},
			{
				value: "8on16-bw",
				label: "8x13，16px 行距，黑色",
				description: "在 8x16 字符单元中使用 8x13 字形（增加行距），黑色墨迹。",
			},
			{
				value: "8on22-bw",
				label: "8x13，22px 行距，黑色",
				description: "在 8x22 字符单元中使用 8x13 字形，增大行距以免行间拥挤。OpenAI/Google 的默认版式。",
			},
			{
				value: "11on16-bw",
				label: "8x13，11px 字距，黑色",
				description: "在 11x16 字符单元中使用 8x13 字形，增大字距以免字符粘连。Anthropic 的默认版式。",
			},
			{
				value: "silver16-bw",
				label: "Silver 16, CJK",
				description: "在 16px 网格中使用内嵌 Silver TrueType 字体，适用于 CJK 及其他非拉丁文字。",
			},
			{
				value: "doc-8on16-bw",
				label: "文档 8on16，黑色",
				description: "两栏报纸式自动换行布局，使用 8x13 字形、16px 行距和黑色墨迹。",
			},
			{
				value: "doc-8on16-sent",
				label: "文档 8on16，逐句配色",
				description: "双栏文档布局，逐句切换墨迹颜色。",
			},
			{
				value: "doc-8on16-sent-dim",
				label: "文档 8on16，逐句配色并淡化停用词",
				description: "双栏文档布局，逐句配色，功能词以灰色淡化。",
			},
		],
	},
});

// Branch summaries
export const cfgBranchSummaryEnabled = register({
	id: "branchSummary.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "常规",
		label: "分支摘要",
		description: "离开分支时提示生成摘要",
	},
});

export const cfgBranchSummaryReserveTokens = register({
	id: "branchSummary.reserveTokens",
	type: "number",
	default: 16384,
});
