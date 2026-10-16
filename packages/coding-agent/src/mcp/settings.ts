/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { setMcpRenderMarkdownResults } from "@oh-my-pi/pi-tui/tools/mcp";
import { effect, register } from "../config/registry";

// MCP
export const cfgMcpEnableProjectConfig = register({
	id: "mcp.enableProjectConfig",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "发现与 MCP",
		label: "MCP 项目配置",
		description: "从项目根目录加载 .mcp.json/mcp.json",
	},
});

export const cfgMcpStartupTimeoutMs = register({
	id: "mcp.startupTimeoutMs",
	type: "number",
	default: 250,
	ui: {
		tab: "tools",
		group: "发现与 MCP",
		label: "MCP 启动等待时间",
		description: "首次发现 MCP 工具时等待的毫秒数；0 表示等待连接稳定",
	},
});

export const cfgMcpRenderMarkdownResults = register({
	id: "mcp.renderMarkdownResults",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "发现与 MCP",
		label: "MCP Markdown 结果",
		description: "在对话记录中将非 JSON 的 MCP 文本结果渲染为 Markdown",
	},
});
effect(cfgMcpRenderMarkdownResults, setMcpRenderMarkdownResults);

export const cfgMcpNotifications = register({
	id: "mcp.notifications",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "发现与 MCP",
		label: "注入 MCP 更新",
		description: "将 MCP 资源更新注入 Agent 对话",
	},
});

export const cfgMcpNotificationDebounceMs = register({
	id: "mcp.notificationDebounceMs",
	type: "number",
	default: 500,
	ui: {
		tab: "tools",
		group: "发现与 MCP",
		label: "MCP 通知防抖",
		description: "MCP 资源更新注入对话前的防抖等待时间（毫秒）",
	},
});
