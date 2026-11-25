import { offlineFromEnv } from "@oh-my-pi/pi-utils/env";
import { DEFAULT_MAX_FPS, parseMaxFps } from "../config/frame-rate";
import { MOTION_MODES, MOTION_PRESETS } from "../config/motion-presets";
import { combine, effect, register, type Setting } from "../config/registry";
import type { Settings } from "../config/settings";
import { parseSpinnerInterval } from "../config/spinner-interval";
import {
	CONTEXT_LINE_MODE_VALUES,
	CUSTOM_STATUS_LINE_DEFAULTS,
	STATUS_LINE_PRESET_VALUES,
	STATUS_LINE_SEGMENT_IDS,
	STATUS_LINE_SEPARATOR_VALUES,
} from "../config/status-line-schema";
import { cfgHideThinkingBlock } from "../session/settings";
import { cfgReadToolResultPreview } from "../tools/settings";
import { formatKeyHint, formatKeyHints } from "../ui/keys/hints";
import { setTightLayout } from "../ui/styles/terminal-padding";
import { setColorBlindMode, setSymbolPreset, setThemeSlot } from "../ui/theme/service";
import {
	DEFAULT_INLINE_IMAGE_COLUMNS,
	DEFAULT_INLINE_IMAGE_ROWS,
	setInlineImageLimits,
} from "../ui/transcript/messages/image";
import { MAGIC_KEYWORDS, type MagicKeywordId } from "./magic-keywords";
import { TREE_FILTER_MODES } from "./view-model/overlays/tree-selector";
import { WORD_COMPLETION_METHODS } from "./view-model/prompt/word-completion";

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
		description:
			"自动恢复当前目录中最近的会话。若无法恢复其模型且已禁用模型回退，交互式启动会发出警告并新建会话，不加载已保存的历史",
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
	default: "titanium",
	ui: {
		tab: "appearance",
		group: "主题",
		label: "深色主题",
		description: "终端背景为深色时使用的主题",
		options: "runtime",
	},
});
effect(cfgThemeDark, name => setThemeSlot("dark", name));

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
effect(cfgThemeLight, name => setThemeSlot("light", name));

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

/** The width limit for transcript images, in columns. */
export const cfgTuiMaxInlineImageColumns = register({
	id: "tui.maxInlineImageColumns",
	type: "number",
	default: DEFAULT_INLINE_IMAGE_COLUMNS,
	description: `Maximum width in terminal columns for inline images (default ${DEFAULT_INLINE_IMAGE_COLUMNS}). Set to 0 for unlimited (bounded only by terminal width).`,
});

/** The height limit for transcript images, in rows. */
export const cfgTuiMaxInlineImageRows = register({
	id: "tui.maxInlineImageRows",
	type: "number",
	default: DEFAULT_INLINE_IMAGE_ROWS,
	description: `Maximum height in terminal rows for inline images (default ${DEFAULT_INLINE_IMAGE_ROWS}). Set to 0 to use only the viewport-based limit (60% of terminal height).`,
});

effect(combine({ columns: cfgTuiMaxInlineImageColumns, rows: cfgTuiMaxInlineImageRows }), setInlineImageLimits);

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
	default: !offlineFromEnv(),
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

export const cfgTuiColorfulMarkdown = register({
	id: "tui.colorfulMarkdown",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Colorful Markdown",
		description:
			"Color headings by level, bold and italic text, inline code, and table headers from the theme's ANSI palette. Off uses one heading color and plain bold/italic.",
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

export const cfgTuiRenderEmbeds = register({
	id: "tui.renderEmbeds",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Render Embedded Images and Pages",
		description:
			"Invite the agent to show pictures with <img> and web pages with <iframe>, loading them (remote addresses included) to draw inline on terminals that show graphics",
	},
});

export const cfgTuiAutoGraph = register({
	id: "tui.autoGraph",
	type: "enum",
	values: ["auto", "smart", "always", "off"] as const,
	default: "auto",
	ui: {
		tab: "appearance",
		group: "显示",
		label: "表格自动绘图",
		description: "在支持图形的终端中，使用主题颜色在 Agent 回答的数值表格下方绘制图表",
		options: [
			{
				value: "auto",
				label: "Auto",
				description: "Smart when the judge role resolves to a native TypeSafe jev model, else Always",
			},
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

export const cfgTuiSpinnerInterval = register({
	id: "tui.spinnerInterval",
	type: "number",
	// Unset follows `tui.motion`; any value set (file, flag, env) wins over the preset.
	default: undefined,
	env: "PI_SPINNER_INTERVAL",
	validate: raw => {
		if (raw !== undefined && raw !== null) parseSpinnerInterval(raw);
	},
	normalize: parseSpinnerInterval,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "旋转图标间隔（毫秒）",
		description: "所有旋转图标（包括终端标题）的帧间隔；0 为静态。未设置时跟随动画预设",
		options: [
			{ value: "0", label: "静态", description: "无动画" },
			{ value: "80", label: "80 ms", description: "12.5 帧/秒" },
			{ value: "250", label: "250 ms", description: "4 帧/秒" },
			{ value: "1000", label: "1 s", description: "1 帧/秒" },
		],
	},
});

export const cfgTuiMaxFps = register({
	id: "tui.maxFps",
	type: "number",
	default: DEFAULT_MAX_FPS,
	env: "PI_MAX_FPS",
	validate: raw => {
		if (raw !== undefined && raw !== null) parseMaxFps(raw);
	},
	normalize: parseMaxFps,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "每秒最大帧数",
		description: "TUI 重绘频率上限，包括流式文字。按键回显保持 30 fps，让输入继续响应",
		options: [
			{ value: "30", label: "30 fps", description: "默认" },
			{ value: "15", label: "15 fps" },
			{ value: "4", label: "4 fps", description: "适合多个分屏的低刷新率" },
			{ value: "1", label: "1 fps", description: "最低" },
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
			return `在主会话中捕获鼠标点击，使活动 Subagent 卡片和 HUD 行可点击聚焦，并在悬停时高亮目标；点击扩展专属链接可交由对应扩展处理（也可通过链接提示快捷键选择，无需鼠标）。开启后，原生文本选择改为 ${shift}+拖动，鼠标捕获会阻止滚轮滚动（终端将滚轮事件发送给 omp）；请使用终端的键盘回滚快捷键滚动，或关闭此设置`;
		},
	},
});

/** Whether terminal output removes a cell of horizontal padding on each side. */
export const cfgTuiTight = register({
	id: "tui.tight",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "紧凑布局",
		description: "移除终端输出左右各一格的标准内边距，保留消息气泡和工具边框的内边距",
	},
});

effect(cfgTuiTight, setTightLayout);

export const cfgDisplayShimmer = register({
	id: "display.shimmer",
	type: "enum",
	values: ["classic", "kitt", "disabled"] as const,
	default: "classic",
	ui: {
		tab: "appearance",
		group: "显示",
		label: "微光动画",
		description: "工作中和加载中消息的动画样式；减少或关闭动画时不显示",
		options: [
			{ value: "classic", label: "经典", description: "柔和的余弦波扫过文字" },
			{ value: "kitt", label: "KITT 扫描器", description: "《霹雳游侠》（1982）中左右往返的红灯" },
			{ value: "disabled", label: "关闭", description: "无动画，显示静态淡色文字" },
		],
	},
});

export const cfgTuiMotion = register({
	id: "tui.motion",
	type: "enum",
	values: MOTION_MODES,
	default: "full",
	env: "PI_MOTION",
	ui: {
		tab: "appearance",
		group: "显示",
		label: "动画",
		description:
			"统一控制旋转图标、微光和装饰性闪烁或渐变，不影响流式文字（参见每秒最大帧数）。显式设置的旋转图标间隔优先",
		options: [
			{ value: "full", label: "完整", description: "每种动画使用各自设置（默认）" },
			{ value: "reduced", label: "减少", description: "旋转图标间隔 250 ms，关闭微光和闪烁／渐变" },
			{ value: "none", label: "关闭", description: "静态旋转图标和标题，关闭微光和闪烁／渐变" },
		],
	},
});

/** Effective animation settings: `tui.motion`'s preset under the user's own spinner interval and shimmer. */
export const cfgMotionResolved = combine(
	{ mode: cfgTuiMotion, spinnerInterval: cfgTuiSpinnerInterval, shimmer: cfgDisplayShimmer },
	({ mode, spinnerInterval, shimmer }) => {
		const preset = MOTION_PRESETS[mode];
		return {
			spinnerInterval: spinnerInterval ?? preset.spinnerInterval,
			titleSpinnerInterval: spinnerInterval ?? preset.titleSpinnerInterval,
			shimmer: preset.effects ? shimmer : ("disabled" as const),
			effects: preset.effects,
		};
	},
);

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
	default: true,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "Smooth Streaming",
		description:
			"Reveal assistant text and streamed tool input smoothly while chunks arrive (Tern types assistant text out itself)",
	},
});

export const cfgDisplayMode = register({
	id: "display.mode",
	type: "enum",
	values: ["clean", "compact", "detailed"] as const,
	default: "compact",
});

export function nextDisplayMode(settings: Settings): "clean" | "compact" | "detailed" {
	return ({ clean: "compact", compact: "detailed", detailed: "clean" } as const)[cfgDisplayMode.get(settings)];
}

/** Apply the saved preset, reporting the actual values when a higher layer overrides it. */
export async function applyDisplayPreset(
	settings: Settings,
	mode: "clean" | "compact" | "detailed",
	output: { showStatus(message: string): void; showWarning(message: string): void },
): Promise<void> {
	const hideThinking = mode === "clean";
	cfgHideThinkingBlock.set(settings, hideThinking);
	cfgDisplayMode.set(settings, mode);
	// The settings effect rebuilds the transcript in a microtask, before the status notice is inserted.
	await Promise.resolve();
	const actualMode = cfgDisplayMode.get(settings);
	const actualHideThinking = cfgHideThinkingBlock.get(settings);
	const label = { clean: "干净", compact: "紧凑", detailed: "详细" }[mode];
	if (mode === actualMode && hideThinking === actualHideThinking) {
		output.showStatus(`显示模式：${label}（${mode}）${mode === "compact" ? "；工具详情：/display detailed" : ""}`);
		return;
	}
	const sources = {
		env: "环境变量",
		runtime: "运行时",
		overlay: "启动配置",
		project: "项目配置",
		global: "全局配置",
		default: "默认值",
	};
	const overrides: string[] = [];
	if (hideThinking !== actualHideThinking)
		overrides.push(`${cfgHideThinkingBlock.id}（${sources[cfgHideThinkingBlock.provenance(settings)]}）`);
	if (mode !== actualMode) overrides.push(`${cfgDisplayMode.id}（${sources[cfgDisplayMode.provenance(settings)]}）`);
	const thinking = actualHideThinking || actualMode !== "detailed" ? "隐藏" : "显示";
	const tools = { clean: "隐藏", compact: "仅显示两行活动、临时输出和本轮文件差异", detailed: "详细" }[actualMode];
	output.showWarning(
		`显示偏好：${label}（${mode}）；当前：实时思考窗口${thinking}、工具${tools}；覆盖：${overrides.join("、")}`,
	);
}

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

export const cfgDisplayShellVisualization = register({
	id: "display.shellVisualization",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "Shell 可视化",
		description: "以交互式执行可视化呈现 Bash 命令，而非普通 Shell 命令文本",
	},
});

export const cfgDisplayAdvisorCollapsedLines = register({
	id: "display.advisorCollapsedLines",
	type: "number",
	default: 0,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "Advisor Collapsed Lines",
		description:
			"Maximum note lines a collapsed advisor card shows below its header (0 keeps the full preview; expand with the tool-output toggle)",
		options: [
			{ value: "0", label: "No limit", description: "Default." },
			{ value: "1", label: "1 line" },
			{ value: "2", label: "2 lines" },
			{ value: "3", label: "3 lines" },
			{ value: "5", label: "5 lines" },
		],
	},
});
/** Transcript display preferences shared by the ANSI and native blocks. */
export const cfgTranscriptDisplay = combine({
	hideToolActivity: cfgDisplayMode.map(mode => mode !== "detailed"),
	shellVisualization: cfgDisplayShellVisualization,
	readToolResultPreview: cfgReadToolResultPreview,
	showImages: cfgTerminalShowImages,
	cacheMissMarker: cfgDisplayCacheMissMarker,
	showTokenUsage: cfgDisplayShowTokenUsage,
	showTurnTime: cfgDisplayShowTurnTime,
	advisorCollapsedLines: cfgDisplayAdvisorCollapsedLines,
});

export const cfgDisplayCollapseCompacted = register({
	id: "display.collapseCompacted",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "显示",
		label: "折叠已压缩历史",
		description: "将已压缩历史折叠到摘要分隔线后；关闭后保留完整记录，并在各压缩点显示分隔线",
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
		description: "将输入区底边框移至单独一行，避免 macOS 输入法预编辑文本将其挤开；需启用“显示硬件光标”",
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

export const cfgBtwInject = register({
	id: "btw.inject",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "/btw Steering Inject",
		description:
			"When you ask /btw for a steering prompt, it drafts one in <inject> tags, highlighted in the answer; Alt+I (app.btw.inject) sends it to the main session",
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
			{
				value: "none",
				label: "隐藏",
				description: "不在状态栏显示模式；启用「显示 Vim 命令」后，仍会显示正在输入的命令",
			},
		],
	},
});

export const cfgTuiVimShowCommand = register({
	id: "tui.vimShowCommand",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "显示 Vim 命令",
		description: "像 Vim 的 showcmd 一样显示正在输入的命令，例如 15d。隐藏模式指示器时仍会显示",
		condition: "vimModeEnabled",
	},
});

export const cfgTuiVimYankToClipboard = register({
	id: "tui.vimYankToClipboard",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "Vim 复制同步到剪贴板",
		description: '像 Vim 的 clipboard=unnamed 一样同步复制；关闭时仅 "+y 和 "*y 写入剪贴板',
		condition: "vimModeEnabled",
	},
});

export const cfgTuiVimStartMode = register({
	id: "tui.vimStartMode",
	type: "enum",
	values: ["insert", "normal"] as const,
	default: "insert",
	ui: {
		tab: "interaction",
		group: "输入",
		label: "Vim 起始模式",
		description: "启动时、每次发送消息后以及打开对话框文本框时所用的模式",
		condition: "vimModeEnabled",
		options: [
			{ value: "insert", label: "插入", description: "可以直接输入；按 Esc 进入普通模式" },
			{ value: "normal", label: "普通", description: "可以执行 Vim 命令；按 i、a、o 等开始输入" },
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
	default: true,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "输入区预测",
		get description() {
			return `每轮完成后，请当前模型预测你的下一条消息，并在空输入区中以淡色预览文字显示；${formatKeyHint("tab")} 或 ${formatKeyHint("right")} 可插入但不发送。额外用量：每轮完成后都会针对整个对话增加一次计费请求（计入 /stats）`;
		},
	},
});

export const cfgComposerPredictionAlternatives = register({
	id: "composer.predictionAlternatives",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "Prediction Alternatives",
		get description() {
			return `Ask for up to four distinct predictions instead of one, most likely first. The ghost text shows the first one your draft matches; after inserting one, press ${formatKeyHint("tab")} again to pick another. The same single request returns a few more output tokens`;
		},
		condition: "composerPredictionsEnabled",
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

export const cfgPasteLargeMenuThreshold = register({
	id: "paste.largeMenuThreshold",
	type: "number",
	default: 100,
	ui: {
		tab: "interaction",
		group: "输入",
		label: "大段粘贴菜单",
		description:
			"粘贴内容达到此行数时，提供菜单以包裹为代码块、包裹为 XML 标签或保存到文件。0 表示关闭菜单（大段粘贴仍会折叠为粘贴标签）。",
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
	default: false,
	ui: {
		tab: "interaction",
		group: "启动与更新",
		label: "启动时检查更新",
		description: "启动交互会话时检查 OMP 新版本，不自动安装；内网模式跳过检查",
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
		description: "启动版本检查与 omp update 使用的更新渠道",
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
	default: "off",
	ui: {
		tab: "interaction",
		group: "启动与更新",
		label: "插件市场自动更新",
		description: "启动时检查插件更新；内网模式仅支持手动更新",
		options: [
			{ value: "off", label: "关闭", description: "不检查插件更新" },
			{ value: "notify", label: "仅检查", description: "启动时检查更新，只在调试日志中报告" },
			{ value: "auto", label: "自动更新", description: "启动时检查并安装插件更新" },
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
	default: "off",
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
	default: 0,
	ui: {
		tab: "interaction",
		group: "通知",
		label: "提问超时",
		description:
			"在此秒数后提交 ask 表单的当前值（预选答案；0 表示关闭）。也限制 cfg:// 授权确认提示的等待时间；未回答的授权确认将拒绝写入",
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

export const cfgPtyNotify = register({
	id: "pty.notify",
	type: "enum",
	values: ["on", "off"] as const,
	default: "on",
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: "Console Notification",
		description: "Notify when an interactive console (bash `pty`) is waiting on you",
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
