/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../../config/registry";

export const cfgBrowserEnabled = register({
	id: "browser.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "可用工具",
		label: "浏览器",
		description: "启用 browser eval 预置环境，通过脚本自动操控 Chromium（Puppeteer）",
	},
});

export const cfgBrowserCdpUrl = register({
	id: "browser.cdpUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "浏览器 CDP URL",
		description:
			"默认连接的 HTTP CDP 发现端点（例如 http://127.0.0.1:9222），用于连接现有浏览器而非启动新浏览器。工具调用中显式指定的 app.cdp_url 或 app.path 优先。",
	},
});

export const cfgBrowserRelay = register({
	id: "browser.relay",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "浏览器中继",
		description:
			"通过 omp 浏览器中继操控你自己的 Chrome 标签页。只需安装一次扩展（`omp browser-relay install`）；browser 预置环境需要时会自动启动中继服务器。优先于浏览器 CDP URL；设置 PI_BROWSER_RELAY=0 或 PI_BROWSER_RELAY=1 可覆盖此设置。",
	},
});

export const cfgBrowserRelayUrl = register({
	id: "browser.relayUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "浏览器中继 URL",
		description: "omp 浏览器中继端点（默认 http://127.0.0.1:9224）。",
	},
});

export const cfgBrowserHeadless = register({
	id: "browser.headless",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "无头浏览器",
		description: "以无头模式启动浏览器（关闭后显示浏览器界面）",
	},
});

export const cfgBrowserCmux = register({
	id: "browser.cmux",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "cmux 浏览器",
		description:
			"有可用的 cmux socket 时，使用 cmux WKWebView 界面进行浏览器自动化。设置 PI_BROWSER_CMUX=0 或 PI_BROWSER_CMUX=1 可覆盖此设置。",
	},
});

export const cfgBrowserTern = register({
	id: "browser.tern",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "Tern 浏览器",
		description:
			"在 Tern 窗格中，将浏览器标签页以画中画形式打开在 omp 窗格上方（原生网页视图），而非使用无头 Chromium；没有可承载它们的 Tern 窗口时回退到 Chromium。显式 app 选项、中继和浏览器 CDP URL 优先；app.tern:false 可在单次打开时禁用此行为。设置 PI_BROWSER_TERN=0 或 PI_BROWSER_TERN=1 可覆盖此设置。",
	},
});

export const cfgBrowserFreezeOnTurnEnd = register({
	id: "browser.freezeOnTurnEnd",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "回合结束时冻结浏览器标签页",
		description:
			"回合结束后冻结 OMP 管理的无头浏览器标签页，避免动画页面在空闲时持续消耗 CPU/GPU。下次使用时自动解冻；打开时传入 persist:true 可排除此标签页。",
	},
});

export const cfgBrowserIdleCloseSec = register({
	id: "browser.idleCloseSec",
	type: "number",
	default: 1800,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "浏览器空闲关闭超时",
		description:
			"关闭空闲时间超过此秒数的 OMP 管理的无头浏览器标签页和 Tern 浏览器画中画（0 = 永不关闭；会话释放时仍会回收）。不会影响中继/CDP/独立启动的浏览器或其他会话的标签页。",
		options: [
			{ value: "0", label: "永不" },
			{ value: "900", label: "15 分钟" },
			{ value: "1800", label: "30 分钟" },
			{ value: "3600", label: "1 小时" },
		],
	},
});

export const cfgBrowserScreenshotDir = register({
	id: "browser.screenshotDir",
	type: "string",
	default: undefined,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "截图目录",
		description:
			"保存截图的目录。未设置时，截图保存到临时文件。支持 ~。示例：~/Downloads、~/Desktop、/sdcard/Download（Android）",
	},
});
