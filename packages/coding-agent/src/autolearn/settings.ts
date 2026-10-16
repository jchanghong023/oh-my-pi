/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Auto-Learn (experimental): post-stop nudge to capture lessons to memory
// and mint/enhance isolated managed skills under ~/.omp/agent/managed-skills.
// Master flag is default-off → inert (read live at every stop); sub-flags gate behaviour.
export const cfgAutolearnEnabled = register({
	id: "autolearn.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "自动学习",
		label: "自动学习（实验功能）",
		description: "Agent 停止后，提醒其将经验记录到记忆，并创建或增强隔离的托管 Skills",
	},
});

export const cfgAutolearnAutoContinue = register({
	id: "autolearn.autoContinue",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "自动学习",
		label: "停止时自动记录经验",
		description: "开启时，停止后自动运行一轮私有经验记录（消耗额外 Token）。关闭时，仅保留常驻自动学习指导。",
		condition: "autolearnActive",
	},
});

// Config-file-only knob (numbers without `options` are hidden from the UI).
export const cfgAutolearnMinToolCalls = register({ id: "autolearn.minToolCalls", type: "number", default: 5 });
