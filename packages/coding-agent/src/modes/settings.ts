import { combine, effect, register, type Setting } from "../config/registry";
import type { Settings } from "../config/settings";
import { formatKeyHint, formatKeyHints } from "@oh-my-pi/pi-tui/app-keybindings";
import { cfgReadToolResultPreview } from "../tools/settings";
import { MAGIC_KEYWORDS, type MagicKeywordId } from "./magic-keywords";
import { TREE_FILTER_MODES } from "@oh-my-pi/pi-tui/overlays/tree-selector";
import {
	CONTEXT_LINE_MODE_VALUES,
	CUSTOM_STATUS_LINE_DEFAULTS,
	STATUS_LINE_PRESET_VALUES,
	STATUS_LINE_SEGMENT_IDS,
	STATUS_LINE_SEPARATOR_VALUES,
} from "@oh-my-pi/pi-tui/status-line/schema";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { setEditorGapComposerShape } from "@oh-my-pi/pi-tui/prompt/editor-top-gap";
import { setEmojiAutocompleteEnabled } from "@oh-my-pi/pi-tui/prompt/prompt-action-autocomplete";
import { WORD_COMPLETION_METHODS } from "@oh-my-pi/pi-tui/prompt/word-completion";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { setInlineImageMaxColumns, setInlineImageMaxRows } from "@oh-my-pi/pi-tui/render/render-utils";
import { setShimmerMode } from "@oh-my-pi/pi-tui/theme/shimmer";
import { setAutoThemeMapping, setColorBlindMode, setSymbolPreset } from "@oh-my-pi/pi-tui/theme/theme";

const EMPTY_UNKNOWN_RECORD: Record<string, unknown> = {};

// ────────────────────────────────────────────────────────────────────────
// General settings (no UI)
// ────────────────────────────────────────────────────────────────────────
export const cfgSetupVersion = register({ id: "setupVersion", type: "number", default: 0 });

export const cfgAutoResume = register({
	id: "autoResume",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "启动与更新",
		label: "自动恢复",
		description: "自动恢复当前目录中最近的会话",
	},
});

export const cfgGitEnabled = register({
	id: "git.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Git",
		label: "启用 Git 集成",
		description: "在 TUI 中显示 Git 分支、状态和 PR 信息，并监视仓库元数据。",
	},
});

// ────────────────────────────────────────────────────────────────────────
// Appearance
// ────────────────────────────────────────────────────────────────────────

// Theme
export const cfgThemeDark = register({
	id: "theme.dark",
	type: "string",
	default: "dark-terminal",
	ui: {
		tab: "appearance",
		group: "主题",
		label: "深色主题",
		description: "终端背景为深色时使用的主题",
		options: "runtime",
	},
});
effect(cfgThemeDark, name => setAutoThemeMapping("dark", name));

export const cfgThemeLight = register({
	id: "theme.light",
	type: "string",
	default: "light",
	ui: {
		tab: "appearance",
		group: "主题",
		label: "浅色主题",
		description: "终端背景为浅色时使用的主题",
		options: "runtime",
	},
});
effect(cfgThemeLight, name => setAutoThemeMapping("light", name));

export const cfgSymbolPreset = register({
	id: "symbolPreset",
	type: "enum",
	values: ["unicode", "nerd", "ascii"] as const,
	default: "unicode",
	ui: {
		tab: "appearance",
		group: "主题",
		label: "符号预设",
		description: "图标和符号的字形集（Unicode、Nerd Font 或 ASCII）",
		options: [
			{ value: "unicode", label: "Unicode", description: "标准符号（默认）" },
			{
				value: "nerd",
				label: "Nerd Font",
				description: "需要 Nerd Font 或支持 Glyph Protocol 的终端（图标随内容传输）",
			},
			{ value: "ascii", label: "ASCII", description: "最佳兼容性" },
		],
	},
});
effect(cfgSymbolPreset, setSymbolPreset);

export const cfgColorBlindMode = register({
	id: "colorBlindMode",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "主题",
		label: "色盲模式",
		description: "差异中的新增内容使用蓝色而非绿色",
	},
});
effect(cfgColorBlindMode, setColorBlindMode);

// Composer
export const cfgComposerShape = register({
	id: "composer.shape",
	type: "string",
	default: "box",
	ui: {
		tab: "appearance",
		group: "输入区",
		label: "输入区形状",
		description: "输入编辑器和状态栏的视觉布局",
		options: "runtime",
	},
});
effect(cfgComposerShape, setEditorGapComposerShape);

export const cfgComposerTokenRate = register({
	id: "composer.tokenRate",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "输入区",
		label: "生成速率",
		description:
			"实时显示生成速率（tok/s）：位于会话标题旁的工作行，或原生输入栏中思考级别之后，后者会在轮次间保留上次读数。根据流式增量估算，并在每条消息完成时按 Provider 计费的输出数量修正。",
	},
});

// Status line
export const cfgStatusLinePreset = register({
	id: "statusLine.preset",
	type: "enum",
	values: STATUS_LINE_PRESET_VALUES,
	default: "default",
	ui: {
		tab: "appearance",
		group: "状态栏",
		label: "状态栏预设",
		description: "预设的状态栏配置",
		options: [
			{
				value: "default",
				label: "默认",
				description: "模型、路径、Git、Subagent、吞吐量、缓存、上下文、活动时间",
			},
			{ value: "minimal", label: "极简", description: "仅路径和 Git" },
			{ value: "compact", label: "紧凑", description: "模型、Git、费用、上下文" },
			{ value: "full", label: "完整", description: "所有片段，包括时间" },
			{ value: "nerd", label: "Nerd", description: "使用 Nerd Font 图标显示最多信息" },
			{ value: "ascii", label: "ASCII", description: "不使用特殊字符" },
			{ value: "custom", label: "自定义", description: "用户自定义片段" },
		],
	},
});

export const cfgStatusLineSeparator = register({
	id: "statusLine.separator",
	type: "enum",
	values: STATUS_LINE_SEPARATOR_VALUES,
	default: "powerline-thin",
	ui: {
		tab: "appearance",
		group: "状态栏",
		label: "状态栏分隔符",
		description: "片段之间的分隔符样式",
		options: [
			{ value: "powerline", label: "Powerline", description: "实心箭头（Nerd Font）" },
			{ value: "powerline-thin", label: "细尖括号", description: "细箭头（Nerd Font）" },
			{ value: "slash", label: "斜杠", description: "正斜杠" },
			{ value: "pipe", label: "竖线", description: "竖线分隔符" },
			{ value: "block", label: "方块", description: "实心方块" },
			{ value: "none", label: "无", description: "仅空格" },
			{ value: "ascii", label: "ASCII", description: "大于号" },
		],
	},
});

export const cfgStatusLineContextLine = register({
	id: "statusLine.contextLine",
	type: "enum",
	values: CONTEXT_LINE_MODE_VALUES,
	default: "embedded",
	ui: {
		tab: "appearance",
		group: "状态栏",
		label: "上下文反馈线",
		description: "左右片段之间的线条如何反映上下文用量（仅限方框输入区）",
		options: [
			{ value: "off", label: "关闭", description: "纯色强调线，不反映上下文" },
			{
				value: "percentage",
				label: "百分比",
				description: "已用部分使用强调色，其余部分调暗",
			},
			{
				value: "annotated",
				label: "带标记",
				description: "百分比加上推测式压缩和自动压缩边界的刻度",
			},
			{
				value: "embedded",
				label: "嵌入",
				description: "百分比线中右对齐显示上下文百分比和窗口，不显示边界刻度",
			},
		],
	},
});

export const cfgStatusLineSessionAccent = register({
	id: "statusLine.sessionAccent",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "状态栏",
		label: "会话强调色",
		description: "编辑器边框和状态栏间隙使用会话名称颜色",
	},
});

export const cfgStatusLineTransparent = register({
	id: "statusLine.transparent",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "状态栏",
		label: "透明状态栏",
		description:
			"状态栏使用终端默认背景，而非主题的 `statusLineBg`。不显示 Powerline 端帽，因为它们需要对比填充色才能衔接周围的终端背景。",
	},
});

export const cfgStatusLineCompactThinkingLevel = register({
	id: "statusLine.compactThinkingLevel",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "状态栏",
		label: "紧凑思考级别",
		description:
			"在模型名称上以单个图标显示思考级别，替代单独的 ` · <level>` 后缀；在 Tern 输入区中用模型标签的图标替代独立标签（点击图标可循环切换）。",
	},
});

export const cfgStatusLineShowHookStatus = register({
	id: "statusLine.showHookStatus",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "状态栏",
		label: "显示 Hook 状态",
		description: "在状态栏下方显示 Hook 状态消息",
	},
});

export const cfgStatusLineLeftSegments = register({
	id: "statusLine.leftSegments",
	type: "array",
	default: CUSTOM_STATUS_LINE_DEFAULTS.left,
	items: { values: STATUS_LINE_SEGMENT_IDS, label: "status line segment" },
});

export const cfgStatusLineRightSegments = register({
	id: "statusLine.rightSegments",
	type: "array",
	default: CUSTOM_STATUS_LINE_DEFAULTS.right,
	items: { values: STATUS_LINE_SEGMENT_IDS, label: "status line segment" },
});

export const cfgStatusLineSegmentOptions = register({
	id: "statusLine.segmentOptions",
	type: "record",
	default: EMPTY_UNKNOWN_RECORD,
});

// Images and terminal
export const cfgTerminalShowImages = register({
	id: "terminal.showImages",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "图片",
		label: "显示内嵌图片",
		description: "在终端中内嵌渲染图片",
		condition: "hasImageProtocol",
	},
});

export const cfgImagesAutoResize = register({
	id: "images.autoResize",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "图片",
		label: "自动调整图片尺寸",
		description: "将大图缩放至最大 2000x2000，以提高模型兼容性",
	},
});

export const cfgImagesBlockImages = register({
	id: "images.blockImages",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "图片",
		label: "阻止图片",
		description: "阻止向 LLM Provider 发送图片",
	},
});

export const cfgTuiMaxInlineImageColumns = register({
	id: "tui.maxInlineImageColumns",
	type: "number",
	default: 100,
	description:
		"Maximum width in terminal columns for inline images (default 100). Set to 0 for unlimited (bounded only by terminal width).",
});
effect(cfgTuiMaxInlineImageColumns, setInlineImageMaxColumns);

export const cfgTuiMaxInlineImageRows = register({
	id: "tui.maxInlineImageRows",
	type: "number",
	default: 20,
	description:
		"Maximum height in terminal rows for inline images (default 20). Set to 0 to use only the viewport-based limit (60% of terminal height).",
});
effect(cfgTuiMaxInlineImageRows, setInlineImageMaxRows);

export const cfgTuiMaxInlineImages = register({
	id: "tui.maxInlineImages",
	type: "number",
	default: 8,
	description:
		"Maximum number of inline images kept as live terminal graphics (default 8). Older images fall back to a text placeholder via a full redraw once the limit is exceeded. Set to 0 to keep every image (no limit).",
});

export const cfgTuiResizeScrollback = register({
	id: "tui.resizeScrollback",
	type: "enum",
	values: ["append", "rebuild", "preserve"] as const,
	default: "rebuild",
	ui: {
		tab: "appearance",
		group: "显示",
		label: "调整尺寸时的回滚缓冲区",
		description: "终端尺寸调整稳定后，如何刷新回滚缓冲区中保留的对话记录行",
		options: [
			{
				value: "append",
				label: "追加",
				description: "在保留的历史记录下方以新宽度重放对话记录",
			},
			{
				value: "rebuild",
				label: "重建",
				description: "清空终端回滚缓冲区，再以当前宽度重放一份对话记录",
			},
			{
				value: "preserve",
				label: "保留",
				description: "仅重绘视口，历史记录保留原宽度的换行",
			},
		],
	},
});

export const cfgTuiCompleteScrollback = register({
	id: "tui.completeScrollback",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Complete Scrollback",
		description:
			"Send transcript rows pushed off screen by a growing HUD or dialog straight to scrollback; when it shrinks, blank rows sit between the transcript and the input until new output fills them",
	},
});

export const cfgTerminalShowProgress = register({
	id: "terminal.showProgress",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "终端原生进度",
		description: "Agent 或上下文维护运行期间发送 OSC 9;4 不定进度（在 Tern 中始终开启）",
	},
});

export const cfgTerminalProgramStatus = register({
	id: "terminal.programStatus",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "程序状态（OSC 7501）",
		description: "通过 OSC 7501 报告 Agent 正在工作、等待用户、已完成或失败的状态，用于终端标签指示器和 Agent 收件箱",
	},
});

export const cfgTuiTextSizing = register({
	id: "tui.textSizing",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "大标题（Kitty）",
		description:
			"使用 Kitty 的 OSC 66 文字尺寸协议，以 2 倍大小渲染 Markdown H1 标题。仅对 Kitty 终端生效，其它终端忽略。默认关闭。",
	},
});

export const cfgTuiRenderMermaid = register({
	id: "tui.renderMermaid",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "渲染 Mermaid 图表",
		description: "将 Mermaid 围栏代码块渲染为 ASCII 图表",
	},
});

export const cfgTuiRenderSvg = register({
	id: "tui.renderSvg",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "渲染 SVG 图形",
		description: "引导 Agent 以 SVG 绘制示意图和图表，在支持图形的终端中以内嵌图片显示",
	},
});

export const cfgTuiAutoGraph = register({
	id: "tui.autoGraph",
	type: "enum",
	values: ["smart", "always", "off"] as const,
	default: "always",
	ui: {
		tab: "appearance",
		group: "显示",
		label: "表格自动绘图",
		description: "在支持图形的终端中，使用主题颜色在 Agent 回答的数值表格下方绘制图表",
		options: [
			{
				value: "smart",
				label: "智能",
				description: "由评判模型优化每张图表：类型、列、行名和分组、比例尺、优劣方向及标题",
			},
			{
				value: "always",
				label: "始终",
				description: "使用内置最佳推测，为每个看起来包含数值的表格绘图",
			},
			{ value: "off", label: "关闭", description: "仅显示表格" },
		],
	},
});

export const cfgTuiReactions = register({
	id: "tui.reactions",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "Agent 表情回应",
		description: "引导 Agent 在消息气泡上用表情徽标回应你的消息",
	},
});

export const cfgTuiCodexResetFireworks = register({
	id: "tui.codexResetFireworks",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "Codex 重置 Fireworks",
		get description() {
			return `在 Codex 周用量意外重置或新增已存储的重置额度时，于屏幕上方三分之一区域显示烟花庆祝，按 ${formatKeyHint("escape")} 后关闭`;
		},
	},
});

export const cfgTuiTitleState = register({
	id: "tui.titleState",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "终端标题运行状态",
		description:
			"在终端标题分隔符中显示 Agent 运行状态：工作时显示动画旋转图标（WSL 下为静态 ':'），轮到你时显示 '>'，Agent 等待你时显示 '!'",
	},
});

export const cfgTuiTitleSpinner = register({
	id: "tui.titleSpinner",
	type: "enum",
	values: ["braille", "pulse", "dots", "line"] as const,
	default: "braille",
	ui: {
		tab: "appearance",
		group: "显示",
		label: "终端标题旋转图标",
		description: "终端标题中工作状态旋转图标的字形集：盲文扫描、月相填充、单点循环或兼容 ASCII 的线条",
		options: [
			{ value: "braille", label: "盲文", description: "经典 ⠋⠙⠹ 扫描（默认）" },
			{ value: "pulse", label: "脉动", description: "月相 ○◑● 逐渐填满再变空" },
			{ value: "dots", label: "圆点", description: "单个盲文点循环" },
			{ value: "line", label: "线条", description: "适用于不支持盲文字体的 ASCII - \\ | /" },
		],
	},
});

export const cfgTuiHyperlinks = register({
	id: "tui.hyperlinks",
	type: "enum",
	values: ["off", "auto", "always"] as const,
	default: "auto",
	ui: {
		tab: "appearance",
		group: "显示",
		label: "终端超链接",
		description:
			"将路径和 URL 包装为 OSC 8 超链接，支持终端原生点击打开（auto：检测支持情况；off：从不；always：始终）",
	},
});
// Also re-applied when a project-scoped reload (`/move`, cross-project resume, rollback) changes the
// effective value, so pi-tui renderers gating on the shared flag track it the same instant path links do.
effect(cfgTuiHyperlinks, applyHyperlinkSetting);

export const cfgTuiMouse = register({
	id: "tui.mouse",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "鼠标点击聚焦",
		get description() {
			const shift = formatKeyHint("shift");
			return `在主会话中捕获鼠标点击，使活动 Subagent 卡片和 HUD 行可点击聚焦，并在悬停时高亮目标。开启后，原生文本选择改为 ${shift}+拖动，滚轮滚动改为 ${shift}+滚轮`;
		},
	},
});

export const cfgTuiTight = register({
	id: "tui.tight",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "紧凑布局",
		description: "移除终端输出左右两侧各 1 字符的水平内边距",
	},
});

export const cfgDisplayShimmer = register({
	id: "display.shimmer",
	type: "enum",
	values: ["classic", "kitt", "disabled"] as const,
	default: "disabled",
	ui: {
		tab: "appearance",
		group: "显示",
		label: "微光动画",
		description: "工作中和加载中消息的动画样式",
		options: [
			{ value: "classic", label: "经典", description: "柔和的余弦波扫过文字" },
			{ value: "kitt", label: "KITT 扫描器", description: "《霹雳游侠》（1982）中左右往返的红灯" },
			{ value: "disabled", label: "关闭", description: "无动画，显示静态淡色文字" },
		],
	},
});
effect(cfgDisplayShimmer, setShimmerMode);

export const cfgDisplayPinnedAgents = register({
	id: "display.pinnedAgents",
	type: "enum",
	values: ["off", "collapsed", "full"] as const,
	default: "collapsed",
	ui: {
		tab: "appearance",
		group: "显示",
		label: "置顶 Agent",
		description: "编辑器上方置顶的活动 Agent 跳转列表（off 隐藏；collapsed 显示几行并提供展开按钮；full 显示全部）",
		options: [
			{ value: "off", label: "关闭", description: "隐藏置顶跳转列表" },
			{ value: "collapsed", label: "折叠", description: "显示几行并提供展开按钮" },
			{ value: "full", label: "完整", description: "始终列出所有活动 Agent" },
		],
	},
});

export const cfgDisplaySubagentLivePreview = register({
	id: "display.subagentLivePreview",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "Subagent 实时预览",
		description: "在每个置顶 Subagent 行下方显示其当前（或最近）的工具调用",
	},
});

export const cfgDisplaySmoothStreaming = register({
	id: "display.smoothStreaming",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "平滑流式显示",
		description: "数据块到达时平滑显示助手文字和流式工具输入",
	},
});

export const cfgDisplayHideToolActivity = register({
	id: "display.hideToolActivity",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "隐藏工具活动",
		description: "在对话记录中隐藏模型发起的工具调用和结果",
	},
});

export const cfgDisplayCompactToolActivity = register({
	id: "display.compactToolActivity",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "紧凑显示工具调用",
		description: "工具与思考各保留两行；仅活动回合显示最近三个编辑 diff，完整详情在详细模式查看",
	},
});

export const cfgDisplayShowTokenUsage = register({
	id: "display.showTokenUsage",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "显示 Token 用量",
		description: "在助手消息中显示每轮 Token 用量",
	},
});

export const cfgDisplayShowTurnTime = register({
	id: "display.showTurnTime",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "显示轮次耗时",
		description: "在助手消息用量行中显示从 Prompt 提交到交还的总耗时（包括工具调用）",
	},
});

export const cfgDisplayCacheMissMarker = register({
	id: "display.cacheMissMarker",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "缓存未命中标记",
		description: "在请求丢失（未命中）Prompt 缓存的助手轮次后显示分隔线",
	},
});
effect(
	combine({
		hideToolActivity: cfgDisplayHideToolActivity,
		compactToolActivity: cfgDisplayCompactToolActivity,
		readToolResultPreview: cfgReadToolResultPreview,
		showImages: cfgTerminalShowImages,
		cacheMissMarker: cfgDisplayCacheMissMarker,
		showTokenUsage: cfgDisplayShowTokenUsage,
		showTurnTime: cfgDisplayShowTurnTime,
	}),
	setChatTranscriptDisplayPreferences,
);

export const cfgDisplayCollapseCompacted = register({
	id: "display.collapseCompacted",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "折叠已压缩历史",
		description:
			"干净／详细模式下将已压缩历史折叠到摘要分隔线后；关闭后保留完整记录。紧凑模式始终只保留旧对话正文，不受此项影响",
	},
});

export const cfgShowHardwareCursor = register({
	id: "showHardwareCursor",
	type: "boolean",
	default: true, // will be computed based on platform if undefined
	ui: {
		tab: "appearance",
		group: "显示",
		label: "显示硬件光标",
		description: "显示终端光标以支持输入法",
	},
});

export const cfgTuiImeSafeCursor = register({
	id: "tui.imeSafeCursor",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "输入法安全输入布局",
		description: "将输入区底边框移至单独一行，避免 macOS 输入法预编辑文本将其挤开",
	},
});

// ────────────────────────────────────────────────────────────────────────
// Interaction
// ────────────────────────────────────────────────────────────────────────

// Conversation flow
export const cfgSteeringMode = register({
	id: "steeringMode",
	type: "enum",
	values: ["all", "one-at-a-time"] as const,
	default: "one-at-a-time",
	ui: {
		tab: "interaction",
		group: "输入",
		label: "引导消息模式",
		description: "Agent 工作时如何处理排队的消息",
	},
});

export const cfgFollowUpMode = register({
	id: "followUpMode",
	type: "enum",
	values: ["all", "one-at-a-time"] as const,
	default: "one-at-a-time",
	ui: {
		tab: "interaction",
		group: "输入",
		label: "后续消息模式",
		description: "一轮完成后如何处理后续消息队列",
	},
});

export const cfgInterruptMode = register({
	id: "interruptMode",
	type: "enum",
	values: ["immediate", "wait"] as const,
	default: "immediate",
	ui: {
		tab: "interaction",
		group: "输入",
		label: "中断模式",
		description: "引导消息何时中断工具执行",
	},
});

export const cfgTuiVimMode = register({
	id: "tui.vimMode",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "Vim 编辑模式",
		get description() {
			return `模态输入编辑。${formatKeyHint("escape")} 退出插入模式；普通模式支持 hjkl、0、$、^、w、b、e、gg、G、计数、x/D/C、dd/yy、p 和 u；操作符接受移动命令或文本对象（diw、ca(、dap）；v/V 开始可视选择，y 复制，d 删除`;
		},
	},
});

export const cfgTuiVimModeDisplay = register({
	id: "tui.vimModeDisplay",
	type: "enum",
	values: ["text", "icon", "none"] as const,
	default: "text",
	ui: {
		tab: "interaction",
		group: "输入",
		label: "Vim 模式指示器",
		description: "当前 Vim 模式在状态栏中的显示方式",
		condition: "vimModeEnabled",
		options: [
			{ value: "text", label: "文字", description: "完整模式名：NORMAL、INSERT、VISUAL、V-LINE、REPLACE" },
			{ value: "icon", label: "图标", description: "每种模式用一个紧凑字形表示" },
			{ value: "none", label: "隐藏", description: "不在状态栏显示模式" },
		],
	},
});

export const cfgLoopMode = register({
	id: "loop.mode",
	type: "enum",
	values: ["prompt", "compact", "reset"] as const,
	default: "prompt",
	ui: {
		tab: "interaction",
		group: "输入",
		label: "循环模式",
		description: "在 /loop 迭代之间重新提交 Prompt 前执行的操作",
		options: [
			{
				value: "prompt",
				label: "Prompt",
				description: "将 Prompt 作为后续消息重新提交（当前行为）",
			},
			{
				value: "compact",
				label: "压缩",
				description: "压缩会话上下文后重新提交 Prompt",
			},
			{ value: "reset", label: "重置", description: "启动新会话后重新提交 Prompt" },
		],
	},
});

export const cfgLoopConditionTimeoutMs = register({
	id: "loop.conditionTimeoutMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "循环条件超时（毫秒）",
		description: "等待 `/loop --while` / `--until` 条件命令的最长时间，超时视为异常并停止循环。设为 0 表示无限等待",
		options: [
			{ value: "0", label: "无限制" },
			{ value: "10000", label: "10 秒" },
			{ value: "30000", label: "30 秒" },
			{ value: "120000", label: "2 分钟" },
		],
	},
});

// Input and startup
export const cfgComposerRecallClearedDrafts = register({
	id: "composer.recallClearedDrafts",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "召回已清空草稿",
		get description() {
			return `将通过 ${formatKeyHint("ctrl+c")} 清空的草稿保留在本地 ${formatKeyHints(["up", "down"])} 历史中直至退出；关闭仅影响之后的清空操作`;
		},
	},
});

export const cfgDoubleEscapeAction = register({
	id: "doubleEscapeAction",
	type: "enum",
	values: ["rewind", "tree", "none"] as const,
	default: "rewind",
	ui: {
		tab: "interaction",
		group: "输入",
		label: "双击 Escape 操作",
		get description() {
			return `编辑器为空时连按两次 ${formatKeyHint("escape")} 的操作：打开对话回溯选择器、打开会话树或不执行操作`;
		},
	},
});

export const cfgBareExitOnEmptySession = register({
	id: "input.bareExitOnEmptySession",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "空会话直接退出",
		description: "首条消息前，仅提交 `exit`、`quit` 或 `q`（不区分大小写）将退出，而非发送给模型",
	},
});

export const cfgBareSlashCommands = register({
	id: "input.bareSlashCommands",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "省略斜杠执行命令",
		description:
			"仅提交不带前导 `/` 的命令名（如 `model`、`compact`）即可执行相应斜杠命令；会话已有消息后，需连按两次 Enter 确认",
	},
});

export const cfgTreeFilterMode = register({
	id: "treeFilterMode",
	type: "enum",
	values: TREE_FILTER_MODES,
	default: "default",
	ui: {
		tab: "interaction",
		group: "输入",
		label: "会话树筛选",
		description: "打开会话树时的默认筛选模式",
	},
});

export const cfgAutocompleteMaxVisible = register({
	id: "autocompleteMaxVisible",
	type: "number",
	default: 10,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "自动补全条目数",
		description: "自动补全下拉列表的最大可见条目数（3-20）",
		options: [
			{ value: "3", label: "3 项" },
			{ value: "5", label: "5 项" },
			{ value: "7", label: "7 项" },
			{ value: "10", label: "10 项" },
			{ value: "15", label: "15 项" },
			{ value: "20", label: "20 项" },
		],
	},
});

export const cfgSpellingTypoDetection = register({
	id: "spelling.typoDetection",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "拼写错误检测（macOS）",
		description: "使用当前 macOS 词典标记输入中的拼写错误",
		condition: "macOS",
	},
});

export const cfgSpellingAutocomplete = register({
	id: "spelling.autocomplete",
	type: "enum",
	values: WORD_COMPLETION_METHODS,
	default: "auto",
	ui: {
		tab: "interaction",
		group: "输入",
		label: "单词自动补全",
		get description() {
			return `将预测的单词补全显示为行内提示：${formatKeyHint("tab")} 接受并添加空格，${formatKeyHint("right")} 接受但不添加空格`;
		},
		options: [
			{ value: "off", label: "关闭", description: "不补全单词" },
			{
				value: "auto",
				label: "自动",
				description: "N-gram（无需下载）",
			},
			{ value: "ngram", label: "N-gram", description: "从输入历史学习你的词汇" },
			{
				value: "smollm",
				label: "SmolLM",
				description: "与 N-gram 混合的设备端小型语言模型（首次使用时下载权重）",
			},
			...(process.platform === "darwin"
				? [{ value: "apple" as const, label: "Apple", description: "macOS 词典补全" }]
				: []),
		],
	},
});

export const cfgComposerPredictions = register({
	id: "composer.predictions",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "输入区预测",
		get description() {
			return `每轮完成后，请当前模型预测你的下一条消息，并在空输入区中以淡色预览文字显示；${formatKeyHint("tab")} 或 ${formatKeyHint("right")} 可插入但不发送。额外用量：每轮完成后都会针对整个对话增加一次计费请求（计入 /stats）`;
		},
	},
});

export const cfgSpellingAutocorrect = register({
	id: "spelling.autocorrect",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "自动纠错（macOS）",
		description: "单词输入完成后应用高置信度的 macOS 拼写纠正",
		condition: "macOS",
	},
});

export const cfgEmojiAutocomplete = register({
	id: "emojiAutocomplete",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "表情自动补全",
		description: "根据 `:name:` 短代码推荐表情，并展开 `:D` 或 `:-)` 等文字表情",
	},
});
effect(cfgEmojiAutocomplete, setEmojiAutocompleteEnabled);

export const cfgPasteLargeMenuThreshold = register({
	id: "paste.largeMenuThreshold",
	type: "number",
	default: 100,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "大段粘贴菜单",
		description:
			"粘贴内容达到此行数时，提供菜单以包裹为代码块、包裹为 XML 标签或保存到文件。0 表示关闭菜单（大段粘贴仍会折叠为 [Paste] 标记）。",
		options: [
			{ value: "0", label: "关闭" },
			{ value: "100", label: "100 行" },
			{ value: "250", label: "250 行" },
			{ value: "500", label: "500 行" },
			{ value: "1000", label: "1000 行" },
		],
	},
});

export const cfgStartupQuiet = register({
	id: "startup.quiet",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "启动与更新",
		label: "安静启动",
		description: "跳过欢迎界面和启动状态消息",
	},
});

export const cfgStartupShowSplash = register({
	id: "startup.showSplash",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "启动与更新",
		label: "显示启动动画",
		description: "正常交互启动时显示完整的设置动画，不重新运行设置。安静启动仍会将其隐藏。",
	},
});

export const cfgStartupSetupWizard = register({
	id: "startup.setupWizard",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "启动与更新",
		label: "设置向导",
		description: "每个设置版本仅显示一次新增的引导步骤",
	},
});

export const cfgStartupCheckUpdate = register({
	id: "startup.checkUpdate",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "启动与更新",
		label: "检查更新",
		description: "启动时检查 omp 更新",
	},
});

export const cfgUpdateChannel = register({
	id: "update.channel",
	type: "enum",
	values: ["stable", "canary"] as const,
	default: "stable",
	ui: {
		tab: "interaction",
		group: "启动与更新",
		label: "更新渠道",
		description: "omp update 和启动更新检查使用的更新渠道",
		options: [
			{ value: "stable", label: "稳定版" },
			{ value: "canary", label: "预览版" },
		],
	},
});

export const cfgMarketplaceAutoUpdate = register({
	id: "marketplace.autoUpdate",
	type: "enum",
	values: ["off", "notify", "auto"] as const,
	default: "notify",
	ui: {
		tab: "interaction",
		group: "启动与更新",
		label: "插件市场自动更新",
		description: "启动时检查插件更新",
		options: [
			{ value: "off", label: "关闭", description: "不检查插件更新" },
			{ value: "notify", label: "通知", description: "启动时检查，有可用更新时通知" },
			{ value: "auto", label: "自动", description: "启动时检查并自动安装更新" },
		],
	},
});

export const cfgStartupChangelogMode = register({
	id: "startup.changelogMode",
	type: "enum",
	values: ["summary", "expanded", "hidden"] as const,
	default: "summary",
	ui: {
		tab: "interaction",
		group: "启动与更新",
		label: "启动更新日志",
		description: "选择启动时以摘要、完整详情显示更新说明，或保持隐藏",
		options: [
			{
				value: "summary",
				label: "摘要",
				description: "显示发布版本和更改数量，并提示 /changelog",
			},
			{
				value: "expanded",
				label: "展开",
				description: "完整显示近期发布说明",
			},
			{
				value: "hidden",
				label: "隐藏",
				description: "启动时不显示发布说明",
			},
		],
	},
});

export const cfgMagicKeywordsEnabled = register({
	id: "magicKeywords.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "魔法关键词",
		label: "魔法关键词",
		description: `为独立出现的 ${MAGIC_KEYWORDS.map(keyword => keyword.word).join(", ")} 关键词启用隐藏通知`,
	},
});

/** One `magicKeywords.<id>` toggle per registered keyword, keyed by keyword id. */
export const cfgMagicKeyword = Object.fromEntries(
	MAGIC_KEYWORDS.map(keyword => [
		keyword.id,
		register({
			id: `magicKeywords.${keyword.id}`,
			type: "boolean",
			default: true,
			ui: { tab: "interaction", group: "魔法关键词", label: keyword.label, description: keyword.description },
		}),
	]),
) as Record<MagicKeywordId, Setting<boolean>>;

// Notifications
export const cfgCompletionNotify = register({
	id: "completion.notify",
	type: "enum",
	values: ["on", "off"] as const,
	default: "on",
	ui: {
		tab: "interaction",
		group: "通知",
		label: "完成通知",
		description: "Agent 完成一轮时通知",
	},
});

export const cfgErrorNotify = register({
	id: "error.notify",
	type: "enum",
	values: ["on", "off"] as const,
	default: "on",
	ui: {
		tab: "interaction",
		group: "通知",
		label: "错误通知",
		description: "Agent 因错误停止时通知",
	},
});

export const cfgAskTimeout = register({
	id: "ask.timeout",
	type: "number",
	default: 60,
	ui: {
		tab: "interaction",
		group: "通知",
		label: "提问超时",
		description:
			"未回答的 ask 问题在此秒数后自动回复（0 表示关闭）。也限制 cfg:// 授权确认提示的等待时间；未回答的授权确认将拒绝写入",
		options: [
			{ value: "0", label: "关闭" },
			{ value: "15", label: "15 秒" },
			{ value: "30", label: "30 秒" },
			{ value: "60", label: "60 秒" },
			{ value: "120", label: "120 秒" },
		],
	},
});

/**
 * `ask.timeout` in the milliseconds dialogs consume, or `undefined` for no
 * deadline. Shared by the ask tool and the `cfg://` approval prompt so the
 * setting means the same thing everywhere it is honored.
 */
export function askTimeoutMs(settings: Settings): number | undefined {
	const timeoutSeconds = cfgAskTimeout.get(settings);
	return timeoutSeconds === 0 ? undefined : timeoutSeconds * 1000;
}

export const cfgAskNotify = register({
	id: "ask.notify",
	type: "enum",
	values: ["on", "off"] as const,
	default: "on",
	ui: {
		tab: "interaction",
		group: "通知",
		label: "提问通知",
		description: "ask 工具等待输入时通知",
	},
});

export const cfgRecapEnabled = register({
	id: "recap.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "通知",
		label: "空闲回顾",
		description: "终端空闲一段时间后，由 LLM 生成简短的当前进展回顾",
	},
});

export const cfgRecapIdleSeconds = register({
	id: "recap.idleSeconds",
	type: "number",
	default: 240,
	ui: {
		tab: "interaction",
		group: "通知",
		label: "空闲回顾延迟",
		description: "空闲后等待多少秒显示回顾",
		options: [
			{ value: "60", label: "1 分钟" },
			{ value: "120", label: "2 分钟" },
			{ value: "240", label: "4 分钟" },
			{ value: "300", label: "5 分钟" },
			{ value: "600", label: "10 分钟" },
		],
	},
});

/** Idle recap policy (`recap.*`). */
export const cfgRecap = combine({ enabled: cfgRecapEnabled, idleSeconds: cfgRecapIdleSeconds });
