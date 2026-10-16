/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

const HINDSIGHT_RECALL_TYPES_DEFAULT: string[] = ["world", "experience"];

/** Integer `HINDSIGHT_*` variables: base-10 `parseInt` prefix (`5000ms` → 5000, `2.5` → 2); other text is unset. */
function parseEnvInteger(raw: string): number | undefined {
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) ? value : undefined;
}

// Hindsight (https://hindsight.vectorize.io)
export const cfgHindsightApiUrl = register({
	id: "hindsight.apiUrl",
	env: "HINDSIGHT_API_URL",
	type: "string",
	default: "http://localhost:8888",
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight API URL",
		description: "Hindsight 服务器 URL（云端或自托管）",
		condition: "hindsightActive",
	},
});

export const cfgHindsightApiToken = register({
	id: "hindsight.apiToken",
	env: "HINDSIGHT_API_TOKEN",
	type: "string",
	credential: true,
	default: undefined,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight API 令牌",
		description: "用于 Hindsight 服务器身份验证的 Bearer 令牌",
		condition: "hindsightActive",
	},
});

export const cfgHindsightBankId = register({
	id: "hindsight.bankId",
	env: "HINDSIGHT_BANK_ID",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight 记忆库 ID",
		description: "记忆库标识（默认：项目名称）",
		condition: "hindsightActive",
	},
});

export const cfgHindsightBankIdPrefix = register({ id: "hindsight.bankIdPrefix", type: "string", default: undefined });

export const cfgHindsightScoping = register({
	id: "hindsight.scoping",
	env: "HINDSIGHT_SCOPING",
	type: "enum",
	values: ["global", "per-project", "per-project-tagged"] as const,
	default: "per-project-tagged",
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight 作用域",
		description:
			"global = 一个共享记忆库；per-project = 每个 cwd 使用独立记忆库；per-project-tagged = 带项目标签的共享记忆库，召回时合并全局和项目记忆",
		options: [
			{
				value: "global",
				label: "全局",
				description: "一个共享记忆库，所有项目均可访问相同记忆",
			},
			{
				value: "per-project",
				label: "按项目",
				description: "按 cwd 目录名隔离记忆库，项目无法访问彼此的记忆",
			},
			{
				value: "per-project-tagged",
				label: "按项目（带标签）",
				description: "共享记忆库，保存时添加 project:<cwd> 标签。召回时同时显示项目记忆和无标签的全局记忆",
			},
		],
		condition: "hindsightActive",
	},
});

export const cfgHindsightBankMission = register({
	id: "hindsight.bankMission",
	env: "HINDSIGHT_BANK_MISSION",
	type: "string",
	default: undefined,
});

export const cfgHindsightRetainMission = register({
	id: "hindsight.retainMission",
	type: "string",
	default: undefined,
});

export const cfgHindsightAutoRecall = register({
	id: "hindsight.autoRecall",
	env: "HINDSIGHT_AUTO_RECALL",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight 自动召回",
		description: "在每个会话的第一轮召回记忆",
		condition: "hindsightActive",
	},
});

export const cfgHindsightAutoRetain = register({
	id: "hindsight.autoRetain",
	env: "HINDSIGHT_AUTO_RETAIN",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight 自动保存",
		description: "每 N 轮及会话边界处保存对话记录",
		condition: "hindsightActive",
	},
});

export const cfgHindsightRetainMode = register({
	id: "hindsight.retainMode",
	env: "HINDSIGHT_RETAIN_MODE",
	type: "enum",
	values: ["full-session", "last-turn"] as const,
	default: "full-session",
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight 保存模式",
		description: "full-session = 每个会话更新或插入一个文档；last-turn = 分块保存",
		options: [
			{
				value: "full-session",
				label: "完整会话",
				description: "每个会话更新或插入一个文档（推荐）",
			},
			{ value: "last-turn", label: "最后一轮", description: "按轮次边界分块保存" },
		],
		condition: "hindsightActive",
	},
});

export const cfgHindsightRetainEveryNTurns = register({
	id: "hindsight.retainEveryNTurns",
	env: { name: "HINDSIGHT_RETAIN_EVERY_N_TURNS", parse: parseEnvInteger },
	type: "number",
	default: 3,
});

export const cfgHindsightRetainOverlapTurns = register({
	id: "hindsight.retainOverlapTurns",
	type: "number",
	default: 2,
});

export const cfgHindsightRetainContext = register({ id: "hindsight.retainContext", type: "string", default: "omp" });

export const cfgHindsightRecallBudget = register({
	id: "hindsight.recallBudget",
	env: "HINDSIGHT_RECALL_BUDGET",
	type: "enum",
	values: ["low", "mid", "high"] as const,
	default: "mid",
});

export const cfgHindsightRecallMaxTokens = register({
	id: "hindsight.recallMaxTokens",
	env: { name: "HINDSIGHT_RECALL_MAX_TOKENS", parse: parseEnvInteger },
	type: "number",
	default: 1024,
});

export const cfgHindsightRecallContextTurns = register({
	id: "hindsight.recallContextTurns",
	env: { name: "HINDSIGHT_RECALL_CONTEXT_TURNS", parse: parseEnvInteger },
	type: "number",
	default: 1,
});

export const cfgHindsightRecallMaxQueryChars = register({
	id: "hindsight.recallMaxQueryChars",
	env: { name: "HINDSIGHT_RECALL_MAX_QUERY_CHARS", parse: parseEnvInteger },
	type: "number",
	default: 800,
});

export const cfgHindsightRecallTypes = register({
	id: "hindsight.recallTypes",
	type: "array",
	default: HINDSIGHT_RECALL_TYPES_DEFAULT,
});

export const cfgHindsightDebug = register({
	id: "hindsight.debug",
	env: "HINDSIGHT_DEBUG",
	type: "boolean",
	default: false,
});

export const cfgHindsightRequestTimeoutMs = register({
	id: "hindsight.requestTimeoutMs",
	env: { name: "HINDSIGHT_REQUEST_TIMEOUT_MS", parse: parseEnvInteger },
	type: "number",
	default: 30_000,
});

export const cfgHindsightReflectTimeoutMs = register({
	id: "hindsight.reflectTimeoutMs",
	env: { name: "HINDSIGHT_REFLECT_TIMEOUT_MS", parse: parseEnvInteger },
	type: "number",
	default: 120_000,
});

export const cfgHindsightRecallTimeoutMs = register({
	id: "hindsight.recallTimeoutMs",
	env: { name: "HINDSIGHT_RECALL_TIMEOUT_MS", parse: parseEnvInteger },
	type: "number",
	default: 30_000,
});

export const cfgHindsightRetainTimeoutMs = register({
	id: "hindsight.retainTimeoutMs",
	env: { name: "HINDSIGHT_RETAIN_TIMEOUT_MS", parse: parseEnvInteger },
	type: "number",
	default: 60_000,
});

export const cfgHindsightMentalModelsEnabled = register({
	id: "hindsight.mentalModelsEnabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight 心智模型",
		description:
			"启动时将精选反思摘要（心智模型）读入开发者指令。仅加载记忆库中已有模型，不写入。搭配 hindsight.mentalModelAutoSeed 还可自动创建内置初始模型集。",
		condition: "hindsightActive",
	},
});

export const cfgHindsightMentalModelAutoSeed = register({
	id: "hindsight.mentalModelAutoSeed",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight 自动创建心智模型",
		description:
			"会话开始时，在记忆库中创建尚不存在的内置心智模型（project-conventions、project-decisions、user-preferences）。",
		condition: "hindsightActive",
	},
});

export const cfgHindsightMentalModelMaxRenderChars = register({
	id: "hindsight.mentalModelMaxRenderChars",
	type: "number",
	default: 16_000,
});
