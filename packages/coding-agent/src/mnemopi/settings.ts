/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register, type ScopeLike } from "../config/registry";
import { cfgMemoryBackend } from "../memory-backend/settings";

// Mnemopi local SQLite memory backend.
export const cfgMnemopiDbPath = register({
	id: "mnemopi.dbPath",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi 数据库路径",
		description: "可选的 SQLite 数据库路径。默认为 Agent 记忆目录。",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiBank = register({
	id: "mnemopi.bank",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi 记忆库",
		description: "可选的共享记忆库基础名称。按项目划分的模式据此派生项目本地记忆库。",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiScoping = register({
	id: "mnemopi.scoping",
	type: "enum",
	values: ["global", "per-project", "per-project-tagged"] as const,
	default: "per-project",
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi 作用域",
		description:
			"global = 一个共享记忆库；per-project = 每个 cwd 使用独立记忆库；per-project-tagged = 写入项目本地记忆库，同时可召回全局记忆",
		options: [
			{
				value: "global",
				label: "全局",
				description: "所有项目共享一个 Mnemopi 记忆库",
			},
			{
				value: "per-project",
				label: "按项目",
				description: "按 cwd 目录名划分项目本地 Mnemopi 记忆库",
			},
			{
				value: "per-project-tagged",
				label: "按项目（带标签）",
				description: "写入项目本地记忆库，但合并项目和共享记忆的召回结果",
			},
		],
		condition: "mnemopiActive",
	},
});

/**
 * Whether `retain`/`learn` can take `scope: "global"`: only Mnemopi with a bank every project
 * recalls (`global` or `per-project-tagged` scoping). Tools hide the option everywhere else.
 */
export function isGlobalMemoryScopeAvailable(scope: ScopeLike): boolean {
	return cfgMemoryBackend.get(scope) === "mnemopi" && cfgMnemopiScoping.get(scope) !== "per-project";
}

export const cfgMnemopiEmbeddingVariant = register({
	id: "mnemopi.embeddingVariant",
	type: "enum",
	values: ["en", "multilingual"] as const,
	default: "multilingual",
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "嵌入模型变体",
		description:
			"本地嵌入模型系列。en = 更强的英语模型；multilingual = 跨语言模型。修改后，下次启动时重建已有记忆的嵌入。",
		options: [
			{
				value: "en",
				label: "英语（bge-base-en-v1.5）",
				description: "BAAI/bge-base-en-v1.5（768 维），仅限英语",
			},
			{
				value: "multilingual",
				label: "多语言（multilingual-e5-large）",
				description: "intfloat/multilingual-e5-large（1024 维），支持跨语言召回",
			},
		],
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiAutoRecall = register({
	id: "mnemopi.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi 自动召回",
		description: "在每个会话的第一轮召回本地记忆",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiAutoRetain = register({
	id: "mnemopi.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi 自动保存",
		description: "将已完成的对话轮次保存到本地 Mnemopi 记忆",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiPolyphonicRecall = register({
	id: "mnemopi.polyphonicRecall",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi 多路召回",
		description: "融合图谱、事实、向量和时间等召回通道，无需关键词匹配也能发现关联记忆",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiEnhancedRecall = register({
	id: "mnemopi.enhancedRecall",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi 增强召回",
		description: "为选项相同的重复及相似查询缓存召回结果；任何记忆写入都会清空缓存",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiProactiveLinking = register({
	id: "mnemopi.proactiveLinking",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi 主动关联",
		description: "存储新记忆时将其纳入情景图谱，关联到相关实体和记忆",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiNoEmbeddings = register({
	id: "mnemopi.noEmbeddings",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi 禁用嵌入",
		description: "强制仅使用确定性的 FTS 召回，不使用向量嵌入",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiEmbeddingModel = register({
	id: "mnemopi.embeddingModel",
	type: "string",
	default: undefined,
	// Without the env term a variant default would silently shadow a user's configured env model.
	env: { name: "MNEMOPI_EMBEDDING_MODEL", fallback: "blank" },
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi 嵌入模型",
		description: "高级：指定嵌入模型 ID，覆盖模型变体。留空则使用 mnemopi.embeddingVariant。",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiEmbeddingApiUrl = register({
	id: "mnemopi.embeddingApiUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi 嵌入 API URL",
		description: "传递给 Mnemopi 的可选 OpenAI 兼容嵌入端点",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiEmbeddingApiKey = register({
	id: "mnemopi.embeddingApiKey",
	type: "string",
	credential: true,
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi 嵌入 API 密钥",
		description: "传递给 Mnemopi 的可选嵌入 API 密钥",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiLlmMode = register({
	id: "mnemopi.llmMode",
	type: "enum",
	values: ["none", "smol", "remote"] as const,
	default: "smol",
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi LLM 模式",
		description: "不使用 LLM、使用在线微型模型（/models 中的 TINY 角色，否则为 @smol），或使用远程 OpenAI 兼容端点",
		condition: "mnemopiActive",
		options: [
			{ value: "none", label: "不使用", description: "禁用 Mnemopi 基于 LLM 的提取" },
			{
				value: "smol",
				label: "在线（微型模型）",
				description: "使用在线微型模型（/models 中的 TINY 角色，否则为 @smol）",
			},
			{ value: "remote", label: "远程", description: "使用下方 Mnemopi 远程 LLM 设置" },
		],
	},
});

export const cfgMnemopiLlmBaseUrl = register({
	id: "mnemopi.llmBaseUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi LLM 基础 URL",
		description: "Mnemopi 远程模式使用的可选 OpenAI 兼容 LLM 端点",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiLlmApiKey = register({
	id: "mnemopi.llmApiKey",
	type: "string",
	credential: true,
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi LLM API 密钥",
		description: "Mnemopi 远程模式使用的可选 LLM API 密钥",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiLlmModel = register({
	id: "mnemopi.llmModel",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi LLM 模型",
		description: "Mnemopi 远程模式使用的可选 LLM 模型名称",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiRetainEveryNTurns = register({ id: "mnemopi.retainEveryNTurns", type: "number", default: 4 });

export const cfgMnemopiRecallLimit = register({ id: "mnemopi.recallLimit", type: "number", default: 8 });

export const cfgMnemopiRecallContextTurns = register({ id: "mnemopi.recallContextTurns", type: "number", default: 3 });

export const cfgMnemopiRecallMaxQueryChars = register({
	id: "mnemopi.recallMaxQueryChars",
	type: "number",
	default: 4000,
});

export const cfgMnemopiInjectionTokenLimit = register({
	id: "mnemopi.injectionTokenLimit",
	type: "number",
	default: 5000,
});

export const cfgMnemopiDebug = register({ id: "mnemopi.debug", type: "boolean", default: false });
