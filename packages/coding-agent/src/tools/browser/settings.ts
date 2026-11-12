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
		description: "启用 browser eval 预置环境，通过脚本自动操控浏览器",
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
			"默认连接的 HTTP CDP 发现端点（例如 http://127.0.0.1:9222），用于连接现有浏览器而非启动新浏览器。工具调用中显式指定的 app 优先。",
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
		description:
			"无窗口运行浏览器（关闭后显示窗口）。OMP 的 WebKit 在提供查看器的平台（macOS）即时切换窗口；其他平台使用 Chromium，下次打开时应用新模式。",
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
			'在 Tern 窗格中，将浏览器标签页以画中画形式打开在 omp 窗格上方（原生网页视图），而非使用 OMP 自有无头浏览器；没有可承载的 Tern 窗口时回退到自有浏览器。显式 app、中继和浏览器 CDP URL 优先；app "own" 可在单次打开时禁用此行为。设置 PI_BROWSER_TERN=0 或 PI_BROWSER_TERN=1 可覆盖此设置。',
	},
});

export const cfgBrowserWebKit = register({
	id: "browser.webkit",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "WebKit 浏览器",
		description:
			'已安装引擎时，使用 OMP 自有无头 WebKit 而非托管 Chromium（未安装浏览器时，OMP 会先下载此引擎，再尝试 Chrome for Testing；参见 WebKit 引擎路径）。不提供查看器的平台仍使用 Chromium 显示窗口，引擎启动失败的标签页也回退到 Chromium。显式 app、中继、浏览器 CDP URL、Tern 和 cmux 优先；app "chromium" 可在单次打开时禁用。设置 PI_BROWSER_WEBKIT=0 或 PI_BROWSER_WEBKIT=1 可覆盖此设置。',
	},
});

export const cfgBrowserWebKitPath = register({
	id: "browser.webkitPath",
	type: "string",
	default: undefined,
	ui: {
		tab: "tools",
		group: "Grep 与浏览器",
		label: "WebKit 引擎路径",
		description:
			"OMP WebKit 宿主可执行文件或 ABKit 引擎目录（内含 ABHost；Windows 为 ABHost.exe）。未设置时使用已安装引擎的默认路径。支持 ~；PI_BROWSER_WEBKIT_PATH 优先。",
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
			"回合结束后冻结 OMP 管理的无头 Chromium 标签页，避免动画页面在空闲时持续消耗 CPU/GPU（WebKit 仅在请求时绘制）。下次使用时自动解冻；打开时传入 persist:true 可排除此标签页。",
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
