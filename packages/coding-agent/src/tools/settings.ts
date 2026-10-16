import { combine, register } from "../config/registry";
import { cfgAutolearnEnabled } from "../autolearn/settings";
import { cfgBashEnabled } from "../exec/settings";
import { cfgCompactionExperimentalContextManagement } from "../session/context-settings";
import { cfgEvalJs, cfgEvalPy } from "../eval/settings";
import { cfgIdaAvailable } from "../ida/install";
import { cfgLspEnabled } from "../lsp/settings";
import { cfgTaskMaxRecursionDepth } from "../task/settings";

const EMPTY_STRING_ARRAY: string[] = [];

export const cfgToolsArtifactSpillThreshold = register({
	id: "tools.artifactSpillThreshold",
	type: "number",
	default: 50,
	ui: {
		tab: "tools",
		group: "输出限制",
		label: "产物转存阈值 (KB)",
		description: "超过此大小的工具输出会保存为产物；尾部内容保留在行内",
		options: [
			{ value: "1", label: "1 KB", description: "约 250 Token" },
			{ value: "2.5", label: "2.5 KB", description: "约 625 Token" },
			{ value: "5", label: "5 KB", description: "约 1.25K Token" },
			{ value: "10", label: "10 KB", description: "约 2.5K Token" },
			{ value: "20", label: "20 KB", description: "约 5K Token" },
			{ value: "30", label: "30 KB", description: "约 7.5K Token" },
			{ value: "50", label: "50 KB", description: "默认；约 12.5K Token" },
			{ value: "75", label: "75 KB", description: "约 19K Token" },
			{ value: "100", label: "100 KB", description: "约 25K Token" },
			{ value: "200", label: "200 KB", description: "约 50K Token" },
			{ value: "500", label: "500 KB", description: "约 125K Token" },
			{ value: "1000", label: "1 MB", description: "约 250K Token" },
		],
	},
});

export const cfgToolsArtifactTailBytes = register({
	id: "tools.artifactTailBytes",
	type: "number",
	default: 20,
	ui: {
		tab: "tools",
		group: "输出限制",
		label: "产物尾部大小 (KB)",
		description: "输出转存为产物时，保留在行内的尾部内容大小",
		options: [
			{ value: "1", label: "1 KB", description: "约 250 Token" },
			{ value: "2.5", label: "2.5 KB", description: "约 625 Token" },
			{ value: "5", label: "5 KB", description: "约 1.25K Token" },
			{ value: "10", label: "10 KB", description: "约 2.5K Token" },
			{ value: "20", label: "20 KB", description: "默认；约 5K Token" },
			{ value: "50", label: "50 KB", description: "约 12.5K Token" },
			{ value: "100", label: "100 KB", description: "约 25K Token" },
			{ value: "200", label: "200 KB", description: "约 50K Token" },
		],
	},
});

export const cfgToolsArtifactHeadBytes = register({
	id: "tools.artifactHeadBytes",
	type: "number",
	default: 20,
	ui: {
		tab: "tools",
		group: "输出限制",
		label: "产物头部大小 (KB)",
		description: "输出转存为产物时，除尾部外保留在行内的头部内容大小（省略中间部分）。0 表示关闭，仅保留尾部。",
		options: [
			{ value: "0", label: "0 KB", description: "关闭；截断时仅保留尾部" },
			{ value: "1", label: "1 KB", description: "约 250 Token" },
			{ value: "2.5", label: "2.5 KB", description: "约 625 Token" },
			{ value: "5", label: "5 KB", description: "约 1.25K Token" },
			{ value: "10", label: "10 KB", description: "约 2.5K Token" },
			{ value: "20", label: "20 KB", description: "默认；约 5K Token" },
			{ value: "50", label: "50 KB", description: "约 12.5K Token" },
			{ value: "100", label: "100 KB", description: "约 25K Token" },
			{ value: "200", label: "200 KB", description: "约 50K Token" },
		],
	},
});

export const cfgToolsOutputMaxColumns = register({
	id: "tools.outputMaxColumns",
	type: "number",
	default: 768,
	ui: {
		tab: "tools",
		group: "输出限制",
		label: "输出列数上限",
		description:
			"流式工具输出（bash、python、js eval）及 `read` 的每行字节上限。超过此宽度的行会用省略号截断；直到下一个换行符的剩余字节会被丢弃。0 表示关闭。",
		options: [
			{ value: "0", label: "关闭", description: "不限制每行大小" },
			{ value: "256", label: "256", description: "严格" },
			{ value: "512", label: "512" },
			{ value: "768", label: "768", description: "默认" },
			{ value: "1024", label: "1024" },
			{ value: "2048", label: "2048" },
			{ value: "4096", label: "4096", description: "宽松" },
		],
	},
});

export const cfgToolsArtifactTailLines = register({
	id: "tools.artifactTailLines",
	type: "number",
	default: 500,
	ui: {
		tab: "tools",
		group: "输出限制",
		label: "产物尾部行数",
		description: "输出转存为产物时，保留在行内的尾部内容最大行数",
		options: [
			{ value: "50", label: "50 行", description: "约 250 Token" },
			{ value: "100", label: "100 行", description: "约 500 Token" },
			{ value: "250", label: "250 行", description: "约 1.25K Token" },
			{ value: "500", label: "500 行", description: "默认；约 2.5K Token" },
			{ value: "1000", label: "1000 行", description: "约 5K Token" },
			{ value: "2000", label: "2000 行", description: "约 10K Token" },
			{ value: "5000", label: "5000 行", description: "约 25K Token" },
		],
	},
});

export const cfgToolsArtifactMaxBytes = register({
	id: "tools.artifactMaxBytes",
	type: "number",
	default: 16,
	ui: {
		tab: "tools",
		group: "输出限制",
		label: "产物文件大小上限 (MB)",
		description:
			"为流式工具输出（bash、python、js eval）保存的产物文件最大大小。超过上限时，保留开头（最多 3 MB）及最新的剩余内容，并在两者之间插入截断提示。0 = 无限制。",
		options: [
			{ value: "0", label: "无限制", description: "保存完整输出" },
			{ value: "4", label: "4 MB" },
			{ value: "16", label: "16 MB", description: "默认" },
			{ value: "64", label: "64 MB" },
			{ value: "256", label: "256 MB" },
			{ value: "1024", label: "1 GB" },
		],
	},
});

export const cfgReadLineNumbers = register({
	id: "readLineNumbers",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "读取",
		label: "行号",
		description: "默认在 read 工具输出前添加行号",
	},
});

export const cfgReadDefaultLimit = register({
	id: "read.defaultLimit",
	type: "number",
	default: 300,
	ui: {
		tab: "files",
		group: "读取",
		label: "默认读取行数限制",
		description: "Agent 调用 read 时未指定行数限制所返回的默认行数",
		options: [
			{ value: "200", label: "200 行" },
			{ value: "300", label: "300 行" },
			{ value: "500", label: "500 行" },
			{ value: "1000", label: "1000 行" },
			{ value: "5000", label: "5000 行" },
		],
	},
});

export const cfgReadRenderMarkdown = register({
	id: "read.renderMarkdown",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "读取",
		label: "Markdown 预览",
		description: "将 Markdown 读取结果渲染为带格式的终端 Markdown 预览，而非原始源码",
	},
});

export const cfgReadSummarizeEnabled = register({
	id: "read.summarize.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "读取摘要",
		label: "读取摘要",
		description: "调用 read 时未指定显式选择器则返回结构化代码摘要",
	},
});

export const cfgReadSummarizeProse = register({
	id: "read.summarize.prose",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "读取摘要",
		label: "文本摘要",
		description: "读取 Markdown 和纯文本时返回结构化摘要",
	},
});

export const cfgReadSummarizeMinBodyLines = register({
	id: "read.summarize.minBodyLines",
	type: "number",
	default: 4,
	ui: {
		tab: "files",
		group: "读取摘要",
		label: "读取摘要主体行数",
		description: "读取摘要折叠多行主体或字面量所需的最小长度",
	},
});

export const cfgReadSummarizeMinCommentLines = register({
	id: "read.summarize.minCommentLines",
	type: "number",
	default: 6,
	ui: {
		tab: "files",
		group: "读取摘要",
		label: "读取摘要注释行数",
		description: "读取摘要折叠多行块注释所需的最小长度",
	},
});

export const cfgReadSummarizeMinTotalLines = register({
	id: "read.summarize.minTotalLines",
	type: "number",
	default: 100,
	ui: {
		tab: "files",
		group: "读取摘要",
		label: "读取摘要最小文件行数",
		description: "总行数少于此值的文件按原文读取，而不生成结构化摘要",
	},
});

export const cfgReadSummarizeUnfoldUntil = register({
	id: "read.summarize.unfoldUntil",
	type: "number",
	default: 50,
	ui: {
		tab: "files",
		group: "读取摘要",
		label: "读取摘要展开目标",
		description: "以广度优先方式展开可省略片段，直到摘要至少包含此数量的可见行。0 表示仅保留最外层的省略。",
	},
});

export const cfgReadSummarizeUnfoldLimit = register({
	id: "read.summarize.unfoldLimit",
	type: "number",
	default: 100,
	ui: {
		tab: "files",
		group: "读取摘要",
		label: "读取摘要展开上限",
		description:
			"以广度优先方式展开时的摘要大小硬性上限。若一次展开显示的行数会超过此上限，则跳过该片段（保持折叠），继续展开其余片段。",
	},
});

export const cfgReadToolResultPreview = register({
	id: "read.toolResultPreview",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "读取",
		label: "行内读取预览",
		description: "在对话记录中行内渲染 read 工具结果，而非显示摘要行",
	},
});

// ────────────────────────────────────────────────────────────────────────
// Tools
// ────────────────────────────────────────────────────────────────────────

// Tool approval policies
export const cfgToolsApproval = register({
	id: "tools.approval",
	type: "record",
	default: {},
	ui: {
		tab: "interaction",
		group: "授权确认",
		label: "工具授权策略",
		description:
			"按工具设置授权策略。设为 'allow' 自动授权，'prompt' 要求确认，'deny' 阻止调用。所有授权确认模式均遵循这些覆盖设置。",
	},
});

// Default tool approval mode (interaction tab, but governs the tool wrapper).
//   "always-ask" — auto-approves read-tier tools only; prompts for write/exec.
//   "write"      — auto-approves read and write-tier tools; prompts for exec.
//   "yolo"       — auto-approves every tier.
export const cfgToolsApprovalMode = register({
	id: "tools.approvalMode",
	type: "enum",
	values: ["always-ask", "write", "yolo"] as const,
	default: "yolo",
	ui: {
		tab: "interaction",
		group: "授权确认",
		label: "工具授权确认",
		description:
			"工具调用的默认授权确认行为。“始终询问”仅自动授权只读工具。“允许写入”自动授权读取和工作区写入工具。“全部自动授权 (Yolo)”自动授权所有级别；用户策略仍可要求确认或阻止调用。",
		options: [
			{
				value: "always-ask",
				label: "始终询问",
				description: "自动授权只读工具；写入和执行工具需要确认。",
			},
			{
				value: "write",
				label: "允许写入",
				description: "自动授权只读和写入工具；bash、eval、browser 和 task 等执行工具需要确认。",
			},
			{
				value: "yolo",
				label: "全部自动授权 (Yolo)",
				description: "自动授权读取、写入和执行工具。用户策略仍可要求确认或阻止调用。",
			},
		],
	},
});

// Todo tool
// Todo settings deliberately have no `protocolDefault`: protocol embedders need project-level opt-outs
// for reminder/prelude prompt injection.
export const cfgTodoEnabled = register({
	id: "todo.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "待办",
		description: "启用 todo 工具以跟踪任务",
	},
});

export const cfgTodoReminders = register({
	id: "todo.reminders",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "待办",
		label: "待办提醒",
		description: "提醒 Agent 在停止前完成待办事项",
	},
});

export const cfgTodoRemindersMax = register({
	id: "todo.remindersMax",
	type: "number",
	default: 3,
	ui: {
		tab: "tools",
		group: "待办",
		label: "待办提醒上限",
		description: "放弃前的最大待办提醒次数",
		options: [
			{ value: "1", label: "1 次提醒" },
			{ value: "2", label: "2 次提醒" },
			{ value: "3", label: "3 次提醒" },
			{ value: "5", label: "5 次提醒" },
		],
	},
});

export const cfgTodoEager = register({
	id: "todo.eager",
	type: "enum",
	values: ["default", "preferred", "always"] as const,
	default: "default",
	ui: {
		tab: "tools",
		group: "待办",
		label: "自动创建待办事项",
		description: "收到首条消息后推动自动创建待办清单的程度",
		options: [
			{ value: "default", label: "默认", description: "由模型决定；不自动创建待办清单" },
			{
				value: "preferred",
				label: "优先",
				description: "收到首条消息时建议创建待办清单（仅提醒，不强制）",
			},
			{ value: "always", label: "始终", description: "收到首条消息时强制创建完整的待办清单" },
		],
	},
});

export const cfgTasksTodoClearDelay = register({
	id: "tasks.todoClearDelay",
	type: "number",
	default: 60,
	ui: {
		tab: "tools",
		group: "待办",
		label: "待办自动清除延迟",
		description: "从待办组件中移除已完成或已放弃事项前的延迟",
		options: [
			{ value: "0", label: "立即" },
			{ value: "60", label: "1 分钟", description: "默认" },
			{ value: "300", label: "5 分钟" },
			{ value: "900", label: "15 分钟" },
			{ value: "1800", label: "30 分钟" },
			{ value: "3600", label: "1 小时" },
			{ value: "-1", label: "永不" },
		],
	},
});

// Grep, glob, and AST tools
export const cfgGlobEnabled = register({
	id: "glob.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "Glob",
		description: "启用 glob 工具以通过 glob 模式查找文件",
	},
});

export const cfgGrepEnabled = register({
	id: "grep.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "Grep",
		description: "启用 grep 工具以通过正则表达式搜索内容",
	},
});

export const cfgGrepContextBefore = register({
	id: "grep.contextBefore",
	type: "number",
	default: 1,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "Grep 前文",
		description: "每个 grep 匹配项之前的上下文行数",
		options: [
			{ value: "0", label: "0 行" },
			{ value: "1", label: "1 行" },
			{ value: "2", label: "2 行" },
			{ value: "3", label: "3 行" },
			{ value: "5", label: "5 行" },
		],
	},
});

export const cfgGrepContextAfter = register({
	id: "grep.contextAfter",
	type: "number",
	default: 3,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "Grep 后文",
		description: "每个 grep 匹配项之后的上下文行数",
		options: [
			{ value: "0", label: "0 行" },
			{ value: "1", label: "1 行" },
			{ value: "2", label: "2 行" },
			{ value: "3", label: "3 行" },
			{ value: "5", label: "5 行" },
			{ value: "10", label: "10 行" },
		],
	},
});

export const cfgAstGrepEnabled = register({
	id: "astGrep.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "AST Grep",
		description: "启用 ast_grep 工具以进行结构化 AST 搜索",
	},
});

export const cfgAstEditEnabled = register({
	id: "astEdit.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "AST Edit",
		description: "启用 ast_edit 工具以进行结构化 AST 重写",
	},
});

export const cfgFindEnabled = register({
	id: "find.enabled",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "Find（语义 grep）",
		description:
			"启用 find 工具：使用自然语言搜索文件和行范围，由 judge 模型角色评判。自动模式仅在 judge 角色解析为原生 TypeSafe jev 模型时启用",
		options: [
			{
				value: "auto",
				label: "自动",
				description: "judge 角色解析为原生 TypeSafe jev 模型时启用",
			},
			{ value: "on", label: "开启", description: "始终启用，不受 judge 角色所解析模型的影响" },
			{ value: "off", label: "关闭", description: "禁用 find 工具" },
		],
	},
});

// Optional tools

export const cfgDebugEnabled = register({
	id: "debug.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "Debug",
		description: "启用 debug 工具以通过 DAP 调试",
	},
});

export const cfgLaunchEnabled = register({
	id: "launch.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "服务",
		description: "启用命名 bash 服务和 proc:// 监管，用于共享的长时间运行项目进程",
	},
});

export const cfgSpeechgenEnabled = register({
	id: "speechgen.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "语音生成",
		description: "启用 tts 工具，使用本机（Kokoro）或 xAI Grok Voice 合成语音文件",
	},
});

export const cfgGenerateImageEnabled = register({
	id: "generate_image.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "图片生成",
		description: "启用 generate_image 工具（文生图与图片编辑）。tools.xdev 开启时以 xd:// 设备形式提供。",
	},
});

export const cfgComputerEnabled = register({
	id: "computer.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "计算机",
		description: "启用可编程宿主桌面 eval 预置环境（截图、输入、无障碍功能）",
	},
});

export const cfgRatchetEnabled = register({
	id: "ratchet.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "Ratchet",
		description: "启用 ratchet 评估/爬山优化预置环境；/ratchet 可为当前会话开启此功能",
	},
});

export const cfgArchiveEnabled = register({
	id: "archive.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "归档",
		description: "启用只读 archive eval 预置环境：Prompt 历史、最近项目、历史会话及回顾",
	},
});

export const cfgComputerDisplay = register({
	id: "computer.display",
	type: "string",
	default: "active",
	ui: {
		tab: "tools",
		group: "计算机",
		label: "计算机显示器",
		description: "活动窗口所在的显示器（active）、所有显示器（all）或原生显示器 id",
	},
});

export const cfgComputerMaxWidth = register({
	id: "computer.maxWidth",
	type: "number",
	default: 3840,
	ui: {
		tab: "tools",
		group: "计算机",
		label: "计算机截图宽度",
		description: "截图最大宽度，单位为像素",
	},
});

export const cfgComputerMaxHeight = register({
	id: "computer.maxHeight",
	type: "number",
	default: 2400,
	ui: {
		tab: "tools",
		group: "计算机",
		label: "计算机截图高度",
		description: "截图最大高度，单位为像素",
	},
});

export const cfgImagesQuestionTimeoutMs = register({
	id: "images.questionTimeoutMs",
	type: "number",
	default: 300_000,
	ui: {
		tab: "tools",
		group: "执行",
		label: "图片提问超时",
		description:
			"read 的 ?q= 图片提问所调用视觉模型的单次请求超时，单位为毫秒。Provider 无响应时会快速返回超时错误，而非一直阻塞到手动中止。设为 0 可禁用超时。",
		options: [
			{ value: "0", label: "关闭" },
			{ value: "60000", label: "1 分钟" },
			{ value: "120000", label: "2 分钟" },
			{ value: "180000", label: "3 分钟" },
			{ value: "300000", label: "5 分钟" },
		],
	},
});

export const cfgCheckpointEnabled = register({
	id: "checkpoint.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "检查点/回退",
		description: "启用 checkpoint 和 rewind 工具以创建和恢复上下文检查点",
	},
});

// Fetching and browser
export const cfgFetchEnabled = register({
	id: "fetch.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "读取 URL",
		description: "允许 read 工具获取和处理 URL",
	},
});

export const cfgVaultEnabled = register({
	id: "vault.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "Obsidian 知识库",
		description:
			"启用 vault:// 内部 URL，通过 Obsidian CLI 读取和编辑 Obsidian 知识库内容。关闭时，拒绝解析 vault://，系统 Prompt 中也不包含 vault:// 条目。",
	},
});

export const cfgGithubEnabled = register({
	id: "github.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "GitHub CLI",
		description:
			"启用 github 工具（通过 op 分派仓库、issue、pull request、diff、search、checkout、push 及 Actions 监视等工作流）",
	},
});

export const cfgGithubCacheEnabled = register({
	id: "github.cache.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "GitHub",
		label: "GitHub 视图缓存",
		description: "在 ~/.omp/cache/github-cache.db 中缓存渲染后的 issue/PR 视图输出，重复读取不再产生开销",
	},
});

export const cfgGithubCacheSoftTtlSec = register({
	id: "github.cache.softTtlSec",
	type: "number",
	default: 300,
	ui: {
		tab: "tools",
		group: "GitHub",
		label: "GitHub 缓存软 TTL",
		description: "在此时间范围内，直接返回缓存的 issue/PR 视图行（单位为秒；默认 5 分钟）",
	},
});

export const cfgGithubCacheHardTtlSec = register({
	id: "github.cache.hardTtlSec",
	type: "number",
	default: 604800,
	ui: {
		tab: "tools",
		group: "GitHub",
		label: "GitHub 缓存硬 TTL",
		description: "超过软 TTL 后返回缓存行并在后台刷新；超过硬 TTL 后丢弃缓存（单位为秒；默认 7 天）",
	},
});

export const cfgWebSearchEnabled = register({
	id: "web_search.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "网页搜索",
		description: "启用 web_search 工具以获取实时网页结果",
	},
});

export const cfgSecurityEnabled = register({
	id: "security.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "安全",
		description: "启用 OMP 原生安全扫描规划、执行及只读 security:// 资源命名空间",
	},
});

export const cfgAskEnabled = register({
	id: "ask.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "提问",
		description: "启用 ask 工具以交互方式向用户提问",
	},
});

// Tool execution
export const cfgToolsIntentTracing = register({
	id: "tools.intentTracing",
	type: "boolean",
	default: true,
	env: "PI_INTENT_TRACING",
	ui: {
		tab: "tools",
		group: "执行",
		label: "意图追踪",
		description: "要求 Agent 在执行每次工具调用前说明其意图",
	},
});

export const cfgToolsAbortOnFabricatedResult = register({
	id: "tools.abortOnFabricatedResult",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "执行",
		label: "伪造工具结果时中止",
		description:
			"使用带内工具调用时，模型在回合中开始编造工具结果便立即停止。关闭后，模型会完成生成，再丢弃伪造的后续内容。",
	},
});

export const cfgToolsSpeculativeExecutionEnabled = register({
	id: "tools.speculativeExecution.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "执行",
		label: "实验性推测执行",
		description:
			"启用可安全丢弃的首批操作：通过直接 read 调用和嵌套 eval 进行已验证的本地读取。此基础范围不包含网络请求、Provider 生成请求及实际文件系统写入。",
	},
});

export const cfgToolsSpeculativeExecutionMaxInFlight = register({
	id: "tools.speculativeExecution.maxInFlight",
	type: "number",
	default: 2,
	ui: {
		tab: "tools",
		group: "执行",
		label: "推测执行并发数",
		description: "在常规分派前允许运行的已验证本地读取操作的最大数量。",
		options: [
			{ value: "1", label: "1 个操作" },
			{ value: "2", label: "2 个操作" },
			{ value: "3", label: "3 个操作" },
			{ value: "4", label: "4 个操作" },
		],
	},
});

export const cfgToolsMaxTimeout = register({
	id: "tools.maxTimeout",
	type: "number",
	default: 0,
	ui: {
		tab: "tools",
		group: "执行",
		label: "工具最大超时",
		description: "Agent 可为任意工具设置的最大超时秒数（0 = 无限制）",
		options: [
			{ value: "0", label: "无限制" },
			{ value: "30", label: "30 秒" },
			{ value: "60", label: "60 秒" },
			{ value: "120", label: "120 秒" },
			{ value: "300", label: "5 分钟" },
			{ value: "600", label: "10 分钟" },
		],
	},
});

// Async jobs. RPC hosts start from the neutral background-job defaults (`protocolDefault`), as do the
// bash/eval auto-background settings.
export const cfgAsyncEnabled = register({
	id: "async.enabled",
	protocolDefault: ["rpc"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "执行",
		label: "异步执行",
		description: "启用异步 bash 命令和后台任务执行",
	},
});

export const cfgAsyncMaxJobs = register({
	id: "async.maxJobs",
	protocolDefault: ["rpc"],
	type: "number",
	default: 100,
});

export const cfgToolsXdev = register({
	id: "tools.xdev",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "发现与 MCP",
		label: "xd:// 工具",
		description:
			"将不常用（可发现）的工具挂载到通过 read/write 操作的 xd:// 设备 URL 下，而非在每次请求中附带其 schema。会话显式工具列表允许 read 但未包含 write 时，通过仅限设备的 write 传输挂载设备（除设备外，仅 local:// 临时区域仍可写）。关闭后，所有已启用工具均在顶层提供。",
	},
});

export const cfgToolsXdevDocs = register({
	id: "tools.xdevDocs",
	type: "enum",
	values: ["inline", "builtins", "catalog"] as const,
	default: "catalog",
	ui: {
		tab: "tools",
		group: "发现与 MCP",
		label: "xd:// Prompt 文档",
		description:
			"选择在系统 Prompt 中内联哪些已挂载设备的文档和 schema。“仅内置”会内联核心工具，而 MCP 和扩展工具仍按需获取。",
		options: [
			{ value: "inline", label: "所有设备", description: "内联所有已挂载设备的文档和 schema。" },
			{
				value: "builtins",
				label: "仅内置",
				description: "内联内置文档；按需获取 MCP 和扩展文档。",
			},
			{ value: "catalog", label: "仅目录", description: "列出所有设备；按需获取全部文档。" },
		],
	},
});

export const cfgToolsXdevInlineDevices = register({
	id: "tools.xdevInlineDevices",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "tools",
		group: "发现与 MCP",
		label: "xd:// 内联设备",
		description:
			"“xd:// Prompt 文档”设为“仅内置”时，内联名称匹配这些 glob 模式的动态设备（例如 mcp__context_mode_*）。“仅目录”会忽略此设置。",
	},
});

export const cfgDevAutoqa = register({
	id: "dev.autoqa",
	type: "boolean",
	default: true,
	env: "PI_AUTO_QA",
	ui: {
		tab: "tools",
		group: "开发者",
		label: "自动 QA",
		description:
			"自动报告工具问题（xd://report_issue）。默认开启；首次报告会征求同意，拒绝后会关闭报告，直到再次显式启用",
	},
});

export const cfgDevAutoqaPushEndpoint = register({
	id: "dev.autoqaPush.endpoint",
	type: "string",
	default: "https://qa.omp.sh/v1/grievances" as const,
	ui: {
		tab: "tools",
		group: "开发者",
		label: "自动 QA 推送端点",
		description: "接收自动 QA JSON 报告的完整 URL（默认 https://qa.omp.sh/v1/grievances）",
	},
});

export const cfgDevAutoqaPushToken = register({
	id: "dev.autoqaPush.token",
	type: "string",
	default: undefined,
	credential: true,
});

/**
 * User decision on sharing automatic `report_tool_issue` grievances.
 *
 *   - `"unset"`  — never asked; the first `report_tool_issue` invocation
 *                  pops a consent dialog and persists the answer here.
 *   - `"granted"` — record and (when push is configured) ship grievances.
 *   - `"denied"`  — silently no-op every `report_tool_issue` call.
 *
 * Owned by `packages/coding-agent/src/tools/report-tool-issue.ts` via the
 * process-global consent handler registered by `InteractiveMode`.
 *
 * @default "unset"
 */
export const cfgDevAutoqaConsent = register({
	id: "dev.autoqaConsent",
	type: "enum",
	values: ["unset", "granted", "denied"] as const,
	default: "unset" as const,
});

/** Settings read by `resolveBuiltinToolPlan` (`tools/index.ts`); a live session reconciles its built-ins when any changes. */
export const cfgBuiltinToolGates = combine({
	ask: cfgAskEnabled,
	astEdit: cfgAstEditEnabled,
	astGrep: cfgAstGrepEnabled,
	async: cfgAsyncEnabled,
	autolearn: cfgAutolearnEnabled,
	bash: cfgBashEnabled,
	checkpoint: cfgCheckpointEnabled,
	contextManagement: cfgCompactionExperimentalContextManagement,
	debug: cfgDebugEnabled,
	evalJs: cfgEvalJs,
	evalPy: cfgEvalPy,
	find: cfgFindEnabled,
	github: cfgGithubEnabled,
	glob: cfgGlobEnabled,
	grep: cfgGrepEnabled,
	ida: cfgIdaAvailable,
	launch: cfgLaunchEnabled,
	lsp: cfgLspEnabled,
	security: cfgSecurityEnabled,
	taskMaxRecursionDepth: cfgTaskMaxRecursionDepth,
	todo: cfgTodoEnabled,
	webSearch: cfgWebSearchEnabled,
});

/** Settings that add or remove the built-in tools they gate (`AgentSession.reconcileBuiltinTools`). */
export const cfgSessionToolGates = combine({
	builtins: cfgBuiltinToolGates,
	generateImage: cfgGenerateImageEnabled,
	speechgen: cfgSpeechgenEnabled,
	xdev: cfgToolsXdev,
});
