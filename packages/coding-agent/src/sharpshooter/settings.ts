/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgSharpshooterModel = register({
	id: "sharpshooter.model",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Sharpshooter",
		label: "Sharpshooter 模型",
		description: "用于提取和整合的模型选择器，留空 = smol 角色",
	},
});

export const cfgSharpshooterIntervalMinutes = register({
	id: "sharpshooter.intervalMinutes",
	type: "number",
	default: 5,
});

export const cfgSharpshooterInjectionTokenLimit = register({
	id: "sharpshooter.injectionTokenLimit",
	type: "number",
	default: 15000,
});
