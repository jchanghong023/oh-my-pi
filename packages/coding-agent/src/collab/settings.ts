/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { DEFAULT_RELAY_URL } from "./protocol";

// Collab
export const cfgCollabRelayUrl = register({
	id: "collab.relayUrl",
	type: "string",
	default: DEFAULT_RELAY_URL,
	ui: {
		tab: "interaction",
		group: "协作",
		label: "中继 URL",
		description: "/collab 使用的中继（wss://host[:port]）",
	},
});

export const cfgCollabWebUrl = register({
	id: "collab.webUrl",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "协作",
		label: "网页界面 URL",
		description: "/collab 链接使用的浏览器界面；留空则根据 collab.relayUrl 推导；显式 http:// 仅限 localhost",
	},
});

export const cfgCollabDisplayName = register({
	id: "collab.displayName",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "协作",
		label: "显示名称",
		description: "向其它协作参与者显示的名称（默认：操作系统用户名）",
	},
});

export const cfgCollabAutoStart = register({
	id: "collab.autoStart",
	type: "enum",
	values: ["off", "view", "control"] as const,
	default: "off",
	ui: {
		tab: "interaction",
		group: "协作",
		label: "自动启动",
		description:
			"每个交互式会话启动时通过 collab.relayUrl 托管，并发布到本地注册表（omp collab list）；切换会话时更换房间",
		options: [
			{ value: "off", label: "关闭", description: "仅在运行 /collab 时共享" },
			{
				value: "view",
				label: "查看",
				description: "自动托管；注册表分发只读链接（omp collab link --view）",
			},
			{
				value: "control",
				label: "控制",
				description: "自动托管；注册表分发可向会话发送提示的控制链接",
			},
		],
	},
});
