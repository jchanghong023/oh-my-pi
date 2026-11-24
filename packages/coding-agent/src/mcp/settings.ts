/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

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

export const cfgMcpShared = register({
	id: "mcp.shared",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "发现与 MCP",
		label: "共享 MCP 服务器",
		description:
			"由守护进程托管 MCP 服务器，多个 OMP 实例可共享服务器进程与工具目录缓存；维护会话状态的服务器仍为每个实例单独运行。守护进程不可用时回退到独立服务器。",
	},
});

export const cfgMcpIdleStopMinutes = register({
	id: "mcp.idleStopMinutes",
	type: "number",
	default: 5,
	ui: {
		tab: "tools",
		group: "发现与 MCP",
		label: "MCP 空闲停止时间",
		description: "共享 MCP 服务器空闲达到此分钟数后停止，下次请求时重新启动。",
	},
});

export const cfgMcpEvalNamespaces = register({
	id: "mcp.evalNamespaces",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Eval Namespaces",
		description:
			"Expose each MCP server as an eval global (github.create_issue(...)) instead of top-level tools or tool commands",
	},
});

export const cfgMcpBuiltinTransforms = register({
	id: "mcp.builtinTransforms",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Built-in Transforms",
		description:
			"Skip recognized MCP servers that omp's own tools replace (Codex's node_repl while eval runs JavaScript)",
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
