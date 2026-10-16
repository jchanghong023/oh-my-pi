/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { ADVISOR_REVIEW_MODES, ADVISOR_SYNC_BACKLOG_MODES } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { register } from "../config/registry";
import { ADVISOR_DEFAULT_BUDGET_PER_UPDATE } from "./emission-guard";

// Advisor is interactive-session assistance: protocol hosts opt in explicitly instead of inheriting the
// user's local preference, and get the default tuning rather than the user's local tuning.
export const cfgAdvisorEnabled = register({
	id: "advisor.enabled",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "顾问",
		label: "启用顾问",
		description: "搭配第二个模型（分配至 'advisor' 角色），被动审查每轮内容并注入建议。",
	},
});

export const cfgAdvisorSyncBacklog = register({
	id: "advisor.syncBacklog",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ADVISOR_SYNC_BACKLOG_MODES,
	default: "off",
	ui: {
		tab: "model",
		group: "顾问",
		label: "顾问待审同步",
		description:
			"暂停主 Agent，直到顾问待审数量低于阈值。数值模式最多等待 30 秒；strict 等待所有已安排审查完成，不限时长。关闭后不再等待顾问跟进。中止、失败和释放资源均会结束等待。",
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorImmuneTurns = register({
	id: "advisor.immuneTurns",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 3,
	ui: {
		tab: "model",
		group: "顾问",
		label: "顾问免打扰轮数",
		description:
			"顾问的疑虑或阻塞问题打断主 Agent 后，在指定的主 Agent 轮数内，将后续疑虑作为不打断执行的旁注。阻塞问题不受冷却限制。",
		options: [
			{ value: "0", label: "0 轮", description: "无冷却。" },
			{ value: "1", label: "1 轮" },
			{ value: "2", label: "2 轮" },
			{ value: "3", label: "3 轮", description: "默认。" },
			{ value: "4", label: "4 轮" },
			{ value: "5", label: "5 轮" },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorReviewMode = register({
	id: "advisor.reviewMode",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ADVISOR_REVIEW_MODES,
	default: "turn",
	ui: {
		tab: "model",
		group: "顾问",
		label: "顾问审查模式",
		description:
			"不存在 WATCHDOG.yml 名单时使用的默认顾问审查频率。turn 审查主 Agent 的每一轮；agent-end 仅审查最终交付。",
		options: [
			{ value: "turn", label: "每轮", description: "审查主 Agent 的每次更新（工具调用轮）。" },
			{ value: "agent-end", label: "Agent 结束时", description: "仅在最终交付时审查（每次运行一次）。" },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorReviewInterval = register({
	id: "advisor.reviewInterval",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 1,
	ui: {
		tab: "model",
		group: "顾问",
		label: "顾问审查间隔",
		description:
			"不存在 WATCHDOG.yml 名单时使用的默认顾问审查频率：每 N 次符合条件的主 Agent 更新审查一次。1 = 每次更新。跳过的更新将随下次计划审查一并发送。",
		options: [
			{ value: "1", label: "每次符合条件的更新", description: "默认。" },
			{ value: "2", label: "每 2 次" },
			{ value: "3", label: "每 3 次" },
			{ value: "5", label: "每 5 次" },
			{ value: "10", label: "每 10 次" },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorMaxNotesPerUpdate = register({
	id: "advisor.maxNotesPerUpdate",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: ADVISOR_DEFAULT_BUDGET_PER_UPDATE,
	ui: {
		tab: "model",
		group: "顾问",
		label: "顾问每次更新的建议上限",
		description:
			"每次顾问 Prompt 更新可接受的非阻塞建议数量上限（1–32；界面提供 1–5 的快捷选项）。阻塞问题不受限制。",
		options: [
			{ value: "1", label: "1 条建议", description: "严格防止建议过多。" },
			{ value: "2", label: "2 条建议" },
			{ value: "3", label: "3 条建议" },
			{ value: "4", label: "4 条建议", description: "适用于前沿推理模型。默认。" },
			{ value: "5", label: "5 条建议" },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorEvictStaleResults = register({
	id: "advisor.evictStaleResults",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "顾问",
		label: "清理顾问旧结果",
		description: "每次审查前，用简短占位说明替换顾问旧审查中的 read/grep/glob 输出。保留最近一次审查。",
		condition: "advisorEnabled",
	},
});
