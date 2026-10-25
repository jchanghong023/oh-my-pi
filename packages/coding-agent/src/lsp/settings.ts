/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// LSP
export const cfgLspEnabled = register({
	id: "lsp.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "LSP",
		label: "LSP",
		description: "启用 lsp 工具以提供代码智能能力（定义、引用、诊断、重命名）",
	},
});

export const cfgLspLazy = register({
	id: "lsp.lazy",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "LSP",
		label: "延迟启动 LSP",
		description: "首次使用时（调用 lsp 工具或编辑匹配类型的文件）启动语言服务器，而非在会话启动时启动",
	},
});

export const cfgLspShared = register({
	id: "lsp.shared",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "LSP",
		label: "共享语言服务器",
		description:
			"通过项目级守护进程代理启动语言服务器。每个连接使用独立服务器。项目中有其它 omp 实例运行时，释放的服务器会保持预热，供下个连接复用，避免冷启动（不可用时回退到私有服务器）",
	},
});

export const cfgLspFormatOnWrite = register({
	id: "lsp.formatOnWrite",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "LSP",
		label: "写入后格式化",
		description: "写入代码文件后自动使用 LSP 格式化",
	},
});

export const cfgLspDiagnosticsOnWrite = register({
	id: "lsp.diagnosticsOnWrite",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "LSP",
		label: "写入后诊断",
		description: "写入代码文件后返回 LSP 诊断",
	},
});

export const cfgLspDiagnosticsOnEdit = register({
	id: "lsp.diagnosticsOnEdit",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "LSP",
		label: "编辑后诊断",
		description: "编辑代码文件后返回 LSP 诊断",
	},
});

export const cfgLspDiagnosticsDeduplicate = register({
	id: "lsp.diagnosticsDeduplicate",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "LSP",
		label: "诊断去重",
		description: "不再显示编辑后已展示过的文件 LSP 诊断，仅显示新增或变化的诊断",
	},
});

export const cfgLspRequestTimeout = register({
	id: "lsp.requestTimeout",
	type: "number",
	default: 10,
	ui: {
		tab: "files",
		group: "LSP",
		label: "请求超时",
		description:
			"Agent 未指定超时时，等待语言服务器诊断、悬停信息等响应的秒数；延迟到达的编辑后诊断至少等待此时长。冷启动较慢的服务器可增大此值。每次调用仍可通过 lsp 工具的 timeout 参数调整",
		options: [
			{ value: "10", label: "10 秒", description: "默认" },
			{ value: "20", label: "20 秒" },
			{ value: "30", label: "30 秒" },
			{ value: "60", label: "1 分钟" },
			{ value: "120", label: "2 分钟" },
			{ value: "300", label: "5 分钟" },
		],
	},
});
