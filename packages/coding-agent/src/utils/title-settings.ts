/**
 * Automatic session-title settings: which generator names a session, how its
 * card icon shows, and whether a todo replan refreshes it.
 */
import { register } from "../config/registry";

/** The `title.icons` styles. */
export const TITLE_ICONS = ["nf+emoji", "emoji", "boring"] as const;
/** How a session title shows its card icon: see {@link cfgTitleIcons}. */
export type TitleIcons = (typeof TITLE_ICONS)[number];

export const cfgTitleIcons = register({
	id: "title.icons",
	type: "enum",
	values: TITLE_ICONS,
	default: "nf+emoji",
	ui: {
		tab: "appearance",
		group: "显示",
		label: "标题图标",
		description: "新生成或通过 /rename 修改的会话标题前的图标和短码",
		options: [
			{
				value: "nf+emoji",
				label: "Nerd Font + Emoji",
				description: "使用 Nerd Font 符号预设时显示 Nerd Font 字形，否则显示 Emoji（默认）",
			},
			{ value: "emoji", label: "Emoji", description: "始终显示 Emoji" },
			{ value: "boring", label: "纯文本", description: "纯文本标题：无图标或短码" },
		],
	},
});

export const cfgTitleGenerator = register({
	id: "title.generator",
	type: "enum",
	values: ["fork", "tiny"] as const,
	default: "fork",
	ui: {
		tab: "tasks",
		group: "模式",
		label: "标题生成器",
		description: "根据用户消息为无标题会话命名的方式",
		options: [
			{
				value: "fork",
				label: "分叉",
				description: "使用会话模型进行旁路回复：读取其 Prompt 缓存并添加卡片图标（默认）",
			},
			{ value: "tiny", label: "微型模型", description: "仅使用 title 模型角色；生成不带卡片的纯文本标题" },
		],
	},
});

export const cfgTitleRefreshOnReplan = register({
	id: "title.refreshOnReplan",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "模式",
		label: "重新规划时刷新标题",
		description: "todo init 重新规划后刷新自动生成的会话标题，用户手动设置的标题除外",
	},
});
