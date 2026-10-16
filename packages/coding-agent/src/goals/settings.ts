import { register } from "../config/registry";

export const cfgGoalEnabled = register({
	id: "goal.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "模式",
		label: "目标模式",
		description: "启用会话级目标模式和隐藏的 goal 工具",
	},
});

export const cfgGoalStatusInFooter = register({
	id: "goal.statusInFooter",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "模式",
		label: "底栏目标状态",
		description: "在状态栏的目标指示旁显示 Token 预算",
	},
});

const GOAL_CONTINUATION_MODES_DEFAULT: string[] = ["interactive"];

export const cfgGoalContinuationModes = register({
	id: "goal.continuationModes",
	type: "array",
	default: GOAL_CONTINUATION_MODES_DEFAULT,
	ui: {
		tab: "tasks",
		group: "模式",
		label: "目标自动继续模式",
		description: '允许活动目标在轮次之间自动继续的运行模式（"interactive"、"rpc"）',
	},
});
