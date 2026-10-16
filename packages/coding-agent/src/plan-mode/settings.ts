/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// ────────────────────────────────────────────────────────────────────────
// Tasks
// ────────────────────────────────────────────────────────────────────────

// Plan mode
export const cfgPlanEnabled = register({
	id: "plan.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "模式",
		label: "计划模式",
		description: "启用计划模式，在执行前进行只读探索和规划",
	},
});

export const cfgPlanDefaultOnStartup = register({
	id: "plan.defaultOnStartup",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "模式",
		label: "启动时进入计划模式",
		description: "每个新会话开始时自动进入计划模式",
		condition: "planModeEnabled",
	},
});

export const cfgPlanAutosave = register({
	id: "plan.autosave",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "模式",
		label: "自动保存计划",
		description: "计划模式完成时，自动将已批准的计划保存到磁盘",
		condition: "planModeEnabled",
	},
});

export const cfgPlanAutosaveDir = register({
	id: "plan.autosaveDir",
	type: "string",
	default: undefined,
	ui: {
		tab: "tasks",
		group: "模式",
		label: "自动保存目录",
		description: "自动保存计划的目录。支持 ~、绝对路径和相对于 cwd 的路径。留空则使用 <project>/.omp/plans/。",
		condition: "planAutosaveEnabled",
	},
});
