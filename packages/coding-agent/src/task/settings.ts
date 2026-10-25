/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { type OAuthAccountPools, validateAgentAccountPools } from "../config/account-pools";
import {
	type AgentCompactionThresholdOverride,
	validateAgentCompactionThresholdOverrides,
} from "../config/compaction-threshold";
import { effect, register } from "../config/registry";
import { type ServiceTierInheritSettingValue, validateAgentServiceTierOverrides } from "../config/service-tier";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { isRecord, logger, setWorktreesDir } from "@oh-my-pi/pi-utils";
import { setFeedModelBadgeEnabled } from "@oh-my-pi/pi-tui/render/render-utils";
import { getThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";

const EMPTY_AGENT_SERVICE_TIER_OVERRIDES: Record<string, ServiceTierInheritSettingValue> = {};
const EMPTY_AGENT_COMPACTION_THRESHOLD_OVERRIDES: Record<string, AgentCompactionThresholdOverride> = {};
const EMPTY_AGENT_ACCOUNT_POOLS: Record<string, OAuthAccountPools> = {};
const EMPTY_AGENT_SOFT_REQUEST_BUDGET: Record<string, number | null> = {};

const DEFAULT_AGENT_MODEL_OVERRIDES: Record<string, string | string[]> = {};

// Delegation. Task and isolation settings declare `protocolDefault`: protocol hosts get neutral
// defaults instead of the local user's interactive preferences.
export const cfgTaskIsolationEnabled = register({
	id: "task.isolation.enabled",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "隔离",
		label: "允许隔离 Subagent",
		description: "允许通过 `isolated: true` 为单个任务启用隔离；未指定的任务在共享检出目录中运行",
	},
});

export const cfgIsolationBackend = register({
	id: "isolation.backend",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["auto", "apfs", "btrfs", "zfs", "reflink", "overlayfs", "projfs", "block-clone", "rcopy"] as const,
	default: "auto",
	ui: {
		tab: "tasks",
		group: "隔离",
		label: "隔离后端",
		description: "用于 Subagent 隔离和工作树克隆的后端",
		options: [
			{ value: "auto", label: "自动", description: "由 PAL 选择最佳可用后端" },
			{ value: "apfs", label: "APFS", description: "macOS clonefile 写时复制（APFS）" },
			{ value: "btrfs", label: "btrfs", description: "btrfs 子卷快照" },
			{ value: "zfs", label: "ZFS", description: "ZFS 快照与克隆" },
			{ value: "reflink", label: "Reflink", description: "Linux FICLONE 逐文件写时复制" },
			{
				value: "overlayfs",
				label: "Overlayfs",
				description: "Linux 内核叠加文件系统（或回退到 fuse-overlayfs）",
			},
			{ value: "projfs", label: "ProjFS", description: "Windows 投影文件系统" },
			{
				value: "block-clone",
				label: "块克隆",
				description: "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)",
			},
			{
				value: "rcopy",
				label: "递归复制",
				description: "优先使用 git worktree，否则递归复制",
			},
		],
	},
});

export const cfgWorktreeClone = register({
	id: "worktree.clone",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "隔离",
		label: "将检出目录克隆到工作树",
		description:
			"通过 `github pr_checkout` 和 bash 中的 `git worktree add` 创建的工作树，初始为当前检出目录的写时复制克隆，因此会保留被忽略的构建产物（node_modules、target）；文件系统不支持克隆时回退到普通检出",
	},
});

export const cfgWorktreeOnStart = register({
	id: "worktree.onStart",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["off", "ask", "create"] as const,
	default: "off",
	ui: {
		tab: "tasks",
		group: "隔离",
		label: "启动时的工作树",
		description: "新的交互会话是否在新建的关联工作树中启动",
		options: [
			{ value: "off", label: "关闭", description: "在当前检出目录中启动" },
			{ value: "ask", label: "询问", description: "会话启动时询问" },
			{ value: "create", label: "创建", description: "始终在 `wt/*` 分支的新工作树中启动" },
		],
	},
});

export const cfgWorktreeOnExit = register({
	id: "worktree.onExit",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["keep", "ask", "remove"] as const,
	default: "keep",
	ui: {
		tab: "tasks",
		group: "隔离",
		label: "退出时的工作树",
		description: "退出时如何处理 omp 启动后创建的工作树（启动时或通过 `/wt` 创建）",
		options: [
			{ value: "keep", label: "保留", description: "保留工作树" },
			{ value: "ask", label: "询问", description: "退出时询问" },
			{
				value: "remove",
				label: "移除",
				description: "移除干净的工作树；存在未提交更改或新提交时询问。被 Git 忽略的文件（如 `.env`）也会被删除",
			},
		],
	},
});

export const cfgTaskIsolationApply = register({
	id: "task.isolation.apply",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "隔离",
		label: "应用隔离更改",
		description: "自动将成功的隔离任务更改应用到父检出目录；关闭后保留补丁或分支产物",
	},
});

export const cfgTaskIsolationMerge = register({
	id: "task.isolation.merge",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["patch", "branch"] as const,
	default: "patch",
	ui: {
		tab: "tasks",
		group: "隔离",
		label: "隔离合并策略",
		description: "如何集成隔离任务的更改（应用补丁或合并分支）",
		options: [
			{ value: "patch", label: "补丁", description: "合并差异并使用 git apply 应用" },
			{ value: "branch", label: "分支", description: "逐任务提交，使用 --no-ff 合并" },
		],
	},
});

export const cfgTaskIsolationCommits = register({
	id: "task.isolation.commits",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["generic", "ai"] as const,
	default: "generic",
	ui: {
		tab: "tasks",
		group: "隔离",
		label: "隔离提交风格",
		description: "嵌套仓库更改的提交信息风格（通用或 AI 生成）",
		options: [
			{ value: "generic", label: "通用", description: "固定提交信息" },
			{ value: "ai", label: "AI", description: "根据差异由 AI 生成提交信息" },
		],
	},
});

export const cfgWorktreeBase = register({
	id: "worktree.base",
	type: "string",
	default: undefined,
	ui: {
		tab: "tasks",
		group: "隔离",
		label: "工作树基础目录",
		description:
			"Agent 管理的工作树基础目录：任务隔离副本、`github` PR 检出目录和 `omp worktree` 清理均使用此处。未设置时使用 ~/.omp/wt。必须为绝对路径或相对于 ~ 的路径；忽略相对路径。OMP_WORKTREE_DIR 环境变量会覆盖此设置。",
	},
});
effect(cfgWorktreeBase, value => {
	const dir = value?.trim() ? value : undefined;
	// Always applied, so an unset/empty value clears a previous override. setWorktreesDir expands `~`,
	// rejects relative paths, and returns the applied absolute path (undefined when cleared/rejected).
	if (!setWorktreesDir(dir) && dir) {
		logger.warn("Settings: worktree.base must be an absolute or ~-relative path; ignoring", { value: dir });
	}
});

export const cfgTaskEager = register({
	id: "task.eager",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["default", "preferred", "always"] as const,
	default: "default",
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "优先委派任务",
		description: "推动将工作委派给 Subagent 的程度",
		options: [
			{
				value: "default",
				label: "默认",
				description: "使用所选模型的策略；某些模型需要明确提出委派请求",
			},
			{ value: "preferred", label: "优先", description: "在系统 Prompt 中加入委派指导" },
			{ value: "always", label: "始终", description: "Prompt 指导加上首轮委派提醒" },
		],
	},
});

export const cfgTaskBatch = register({
	id: "task.batch",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "批量任务调用",
		description:
			"将 task 工具切换为批量形式：一次调用携带 { context, tasks[] }，每项对应一个 Subagent，可单独指定 agent（默认使用会话生成策略中的 Agent）和隔离方式，并将必填的共享 context 添加到每个任务前。async.enabled=true 时，每次生成均作为独立后台 Agent 运行，采用正常的空闲/停驻生命周期；否则调用阻塞直至返回合并结果。关闭后恢复扁平的单 Agent 生成 schema。",
	},
});

export const cfgTaskStructured = register({
	id: "task.structured",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "结构化任务结果",
		description:
			"在 task 工具中提供 outputSchema/schemaMode，并通过 yield 工具返回 Subagent 结果，按调用方或 Agent 的输出 schema 验证。关闭时：task Subagent 没有 yield 工具，以纯文本返回最终消息，但定义中设置 structured: true 的 Agent 除外。Eval agent()/workpool 生成的 Agent 始终保留结构化结果。",
	},
});

export const cfgTaskSpeculativeLaunch = register({
	id: "task.speculativeLaunch",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "推测式任务启动",
		description:
			"每个批量 Subagent 的 tasks[] 项流式接收完成后立即启动，无需等待整个 task 调用。若完整调用验证失败、被阻止或参数发生变化，已启动的 Agent 将被中止。要求 task 授权确认为自动允许，且没有扩展工具生命周期处理器。",
	},
});

export const cfgTaskEnableEffort = register({
	id: "task.enableEffort",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "逐任务思考强度",
		description: "在 task 生成调用中提供可选的 effort 参数，允许调用方覆盖每个 Subagent 的思考级别",
	},
});

export const cfgTaskMaxConcurrency = register({
	id: "task.maxConcurrency",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 32,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "最大并发任务数",
		description: "同时运行的 Subagent 数量上限",
		options: [
			{ value: "0", label: "无限制" },
			{ value: "1", label: "1 个任务" },
			{ value: "2", label: "2 个任务" },
			{ value: "4", label: "4 个任务" },
			{ value: "8", label: "8 个任务" },
			{ value: "16", label: "16 个任务" },
			{ value: "32", label: "32 个任务" },
			{ value: "64", label: "64 个任务" },
		],
	},
});

export const cfgTaskEnableLsp = register({
	id: "task.enableLsp",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Subagent 中的 LSP",
		description: "允许通过 task 工具生成的 Subagent 使用 lsp 工具",
	},
});

export const cfgTaskMaxRecursionDepth = register({
	id: "task.maxRecursionDepth",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 2,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "最大任务递归深度",
		description: "Subagent 继续生成 Subagent 的最大层数",
		options: [
			{ value: "-1", label: "无限制" },
			{ value: "0", label: "无" },
			{ value: "1", label: "一层" },
			{ value: "2", label: "两层" },
			{ value: "3", label: "三层" },
		],
	},
});

export const cfgTaskMaxRuntimeMs = register({
	id: "task.maxRuntimeMs",
	type: "number",
	default: 0,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Subagent 最长运行时间",
		description:
			"每个 Subagent 的实际运行时间硬上限（毫秒）。0 表示关闭。用于纵深防护，防止 Provider 侧的流挂起绕过推理层看门狗；超限时以 'timed out' 原因正常中止 Subagent。",
		options: [
			{ value: "0", label: "无限制", description: "默认" },
			{ value: "300000", label: "5 分钟" },
			{ value: "900000", label: "15 分钟" },
			{ value: "1800000", label: "30 分钟" },
			{ value: "3600000", label: "1 小时" },
		],
	},
});

export const cfgTaskCompletionProbe = register({
	id: "task.completionProbe",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Subagent 完成度探测",
		description:
			"通过类似 /btw 的缓存侧请求，询问工作中的 Subagent 任务完成度：分别再过 2、5、10、30 分钟询问，之后每小时询问。估计值显示在 wait 和 task 视图的 Subagent 旁。仅询问交互会话主 Agent 生成的 Subagent；print、RPC、ACP 和 SDK 运行不进行探测。",
	},
});

export const cfgTaskAgentIdleTtlMs = register({
	id: "task.agentIdleTtlMs",
	type: "number",
	default: 420_000,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Agent 空闲保留时间",
		description:
			"空闲 Subagent 在内存中保持活动、随后停驻到磁盘的等待时间（毫秒）。停驻 Agent 收到消息或恢复时会自动唤醒。0 表示空闲 Agent 保持活动直至退出。",
	},
});

export const cfgTaskSoftRequestBudget = register({
	id: "task.softRequestBudget",
	type: "number",
	default: 200,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Subagent 请求软预算",
		description:
			"每个 Subagent 的请求软预算（每次运行的助手请求数）。超出后注入收尾引导通知（参见 task.softRequestBudgetNotice）；达到预算的 1.5 倍时强制停止运行，Agent 必须交回部分发现。0 表示关闭防护。内置 scout/sonic Agent 有较低的内置预算上限，因此低于该上限的设置仍对其生效。task.agentSoftRequestBudget 条目会替换所指定 Agent 的此预算。",
		options: [
			{ value: "0", label: "关闭" },
			{ value: "90", label: "90 次请求" },
			{ value: "150", label: "150 次请求" },
			{ value: "200", label: "200 次请求", description: "默认" },
		],
	},
});

/**
 * Validates `task.agentSoftRequestBudget`: exact agent name → request budget,
 * a non-negative integer (0 disables that agent's guard). A `null` entry clears
 * one inherited from a lower-priority settings layer.
 */
function validateAgentSoftRequestBudget(value: unknown): void {
	if (value === undefined || value === null) return;
	if (!isRecord(value)) {
		const received = Array.isArray(value) ? "an array" : `a ${typeof value}`;
		throw new Error(
			`Invalid task.agentSoftRequestBudget: expected a map of agent name to request budget, got ${received}.`,
		);
	}
	for (const [agentName, budget] of Object.entries(value)) {
		if (budget === null || (typeof budget === "number" && Number.isSafeInteger(budget) && budget >= 0)) continue;
		throw new Error(
			`Invalid task.agentSoftRequestBudget.${agentName}: expected a non-negative integer request count (0 disables the guard), got ${Bun.inspect(budget)}.`,
		);
	}
}

export const cfgTaskAgentSoftRequestBudget = register({
	id: "task.agentSoftRequestBudget",
	type: "record",
	default: EMPTY_AGENT_SOFT_REQUEST_BUDGET,
	validate: validateAgentSoftRequestBudget,
});

export const cfgTaskSoftRequestBudgetNotice = register({
	id: "task.softRequestBudgetNotice",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "请求软预算通知",
		description: "Subagent 超出请求软预算时注入一次引导通知，要求其在达到 1.5 倍预算而强制交还前收尾。",
	},
});

export const cfgTaskMaxEffort = register({
	id: "task.maxEffort",
	type: "enum",
	values: THINKING_EFFORTS,
	default: "max",
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "单次生成的最大思考强度",
		description:
			"task 工具逐次生成 effort 提示允许的最大推理强度。较低的值可防止调用方将 Subagent 提升到此上限以上；默认值保留模型的完整范围。",
		options: THINKING_EFFORTS.map(getThinkingLevelMetadata),
	},
});

export const cfgTaskDisabledAgents = register({
	id: "task.disabledAgents",
	protocolDefault: ["rpc", "acp"],
	type: "array",
	default: [] as string[],
});

export const cfgTaskAgentModelOverrides = register({
	id: "task.agentModelOverrides",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: DEFAULT_AGENT_MODEL_OVERRIDES,
});

export const cfgTaskAgentServiceTierOverrides = register({
	id: "task.agentServiceTierOverrides",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: EMPTY_AGENT_SERVICE_TIER_OVERRIDES,
	validate: validateAgentServiceTierOverrides,
});

export const cfgTaskAgentCompactionThresholdOverrides = register({
	id: "task.agentCompactionThresholdOverrides",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: EMPTY_AGENT_COMPACTION_THRESHOLD_OVERRIDES,
	validate: validateAgentCompactionThresholdOverrides,
});

export const cfgTaskAgentAccountPools = register({
	id: "task.agentAccountPools",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: EMPTY_AGENT_ACCOUNT_POOLS,
	validate: validateAgentAccountPools,
});

export const cfgTaskAgentPrewalk = register({
	id: "task.agentPrewalk",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: {} as Record<string, string>,
});

export const cfgTaskAgentAdvisor = register({
	id: "task.agentAdvisor",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: {} as Record<string, string>,
});

export const cfgTaskPrewalk = register({
	id: "task.prewalk",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "通用任务 Prewalk",
		description:
			"为内置通用 `task` Subagent 启用 Prewalk：先用解析得到的模型启动、制定计划并开始实现，在首次 edit/write 时交接给 'smol' 角色。逐 Agent 覆盖项（task.agentPrewalk，通过 /agents 管理页配置）和用户 Agent 的 `prewalk` frontmatter 不受此开关影响。",
	},
});

export const cfgTaskShowResolvedModelBadge = register({
	id: "task.showResolvedModelBadge",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "显示实际模型徽标",
		description: "在任务组件状态栏中显示每个 Subagent 实际使用的模型 ID",
	},
});
effect(cfgTaskShowResolvedModelBadge, setFeedModelBadgeEnabled);
