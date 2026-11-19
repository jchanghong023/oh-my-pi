import { type Component, Container, Text, replaceTabs } from "@oh-my-pi/pi-tui";
import { urlHyperlinkAlways } from "@oh-my-pi/pi-tui/render";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { HookInputComponent } from "@oh-my-pi/pi-tui/overlays/hook-input";
import { offlineFromEnv } from "../cli/args";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSession } from "../session/agent-session";
import { requestOfflineBrowserUrlCopy } from "../utils/clipboard";
import { openPathWithResult } from "../utils/open";
import { holdBlockedStatus } from "../utils/run-status";
import { closeAllWebGuis, startWebGui, type WebGuiHandle } from "./host";
import { nativeWebGuiQuestions } from "./native-interactions";

const exitCommand = "/webgui";
const modes = new WeakMap<InteractiveModeContext, WebGuiTuiMode>();

function nativeBusy(session: AgentSession): boolean {
	return (
		session.isBusyForSnapshot ||
		session.hasAdmittedSubmission ||
		session.queuedMessageCount > 0 ||
		session.hasPostPromptWork ||
		session.wakeSources !== undefined ||
		session.hasUnsettledAsyncJobTree() ||
		session.getGoalModeState()?.enabled === true
	);
}

/** Keep the exit field inside the overlay's focus boundary without replacing its restore target. */
class WebGuiOverlay extends Container {
	ownsOverlayFocusTarget(component: Component): boolean {
		return this.children.includes(component);
	}
}

/** An exclusive input owner, not a second terminal workflow. */
class WebGuiTuiMode {
	readonly #context: InteractiveModeContext;
	#phase: "inactive" | "entering" | "active" | "exiting" = "inactive";
	#pending: Promise<void> | undefined;
	#overlay: HookInputComponent | undefined;
	#notice: Text | undefined;
	#overlayHandle: { hide(): void } | undefined;
	#previousDisableSubmit = false;

	constructor(context: InteractiveModeContext) {
		this.#context = context;
		context.isWebGuiModeActive = () => this.#active;
		context.handleWebGuiModeInput = data => this.#handleInput(data);
		context.handleWebGuiModeSubmit = text => this.#submit(text);
		context.registerHostShutdown(() => this.#close());
	}

	get #active(): boolean {
		return this.#phase !== "inactive";
	}

	async toggle(): Promise<void> {
		if (this.#pending) {
			await this.#pending;
			return;
		}
		const pending = this.#active ? this.#exit() : this.#enter();
		this.#pending = pending;
		try {
			await pending;
		} finally {
			if (this.#pending === pending) this.#pending = undefined;
		}
	}

	async #close(): Promise<void> {
		if (this.#pending) {
			try {
				await this.#pending;
			} catch {
				/* A failed close remains retryable below. */
			}
		}
		if (this.#active) await this.toggle();
		else await closeAllWebGuis();
	}

	#handleInput(data: string): boolean {
		if (!this.#active) return false;
		this.#overlay?.handleInput(data);
		this.#context.ui.requestRender();
		return true;
	}

	async #submit(text: string): Promise<boolean> {
		if (!this.#active) return false;
		if (text.trim() !== exitCommand) {
			this.#showNotice(
				`WebGUI 占用当前终端；普通聊天、命令和快捷操作已暂停。仅再次输入 ${exitCommand} 可退出。`,
				"warning",
			);
			return true;
		}
		if (this.#pending) {
			this.#showNotice(`WebGUI 正在切换，请等待结清后再次输入 ${exitCommand}。`, "muted");
			return true;
		}
		await this.toggle();
		return true;
	}

	#showNotice(text: string, color: "warning" | "error" | "muted"): void {
		if (this.#notice) {
			this.#notice.setText(theme.fg(color, replaceTabs(text)));
			this.#context.ui.requestRender();
		} else if (color === "error") {
			this.#context.showError(text);
		}
	}

	#showOverlay(detail: string, urls: readonly string[] = []): void {
		this.#overlayHandle?.hide();
		this.#overlay?.dispose();
		const surface = new WebGuiOverlay();
		surface.addChild(new Text(theme.fg("accent", "WebGUI"), 0, 0));
		for (const url of urls) surface.addChild(new Text(urlHyperlinkAlways(url, url), 0, 0));
		surface.addChild(new Text(replaceTabs(detail), 0, 0));
		surface.addChild(new Text(`普通终端操作已暂停；仅输入 ${exitCommand} 并提交可退出。关闭网页不会退出。`, 0, 1));
		this.#notice = new Text("", 0, 0);
		surface.addChild(this.#notice);
		const overlay = new HookInputComponent(
			"退出 WebGUI",
			exitCommand,
			text => {
				void this.#submit(text).catch(error =>
					this.#showNotice(error instanceof Error ? error.message : String(error), "error"),
				);
			},
			() => this.#showNotice(`请明确输入 ${exitCommand} 退出；Esc、Ctrl+C 和关闭网页不退出。`, "warning"),
			{ tui: this.#context.ui },
		);
		surface.addChild(overlay);
		this.#overlay = overlay;
		this.#overlayHandle = this.#context.ui.showOverlay(surface, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
			mouseTracking: false,
		});
		this.#context.ui.setFocus(overlay);
		this.#context.ui.requestRender();
	}

	#release(): void {
		this.#overlayHandle?.hide();
		this.#overlayHandle = undefined;
		this.#overlay?.dispose();
		this.#overlay = undefined;
		this.#notice = undefined;
		this.#context.editor.disableSubmit = this.#previousDisableSubmit;
		this.#phase = "inactive";
		this.#context.ui.requestRender();
	}

	async #enter(): Promise<void> {
		const context = this.#context;
		if (!context.getWebGuiEntryBlocker) throw new Error("当前终端未提供互斥准入检查，请使用 omp webgui。");
		const blocked = context.getWebGuiEntryBlocker();
		if (blocked) throw new Error(blocked);
		if (nativeBusy(context.session))
			throw new Error(
				`普通原生任务或自动续跑尚未结清；请先停止或等待，再输入 ${exitCommand}。不会自动停止普通任务。`,
			);
		this.#previousDisableSubmit = context.editor.disableSubmit;
		context.editor.disableSubmit = true;
		this.#phase = "entering";
		try {
			this.#showOverlay("正在启动，请稍候。");
			if (!context.initializeWebGuiNativeHost || !context.getToolUIContext)
				throw new Error("The native host does not expose WebGUI composition and UI ownership");
			const originalToolUI = context.getToolUIContext();
			if (!originalToolUI) throw new Error("The native tool UI has not initialized");
			context.initializeWebGuiNativeHost();
			const handle = await startWebGui(context.session, {
				setToolUIContext: (ui, hasUI) => context.setToolUIContext(ui, hasUI),
				holdBlockedStatus,
				restoreToolUIContext: () => {
					if (context.ownsToolUIContext?.(nativeWebGuiQuestions(context.session).ui))
						context.setToolUIContext(originalToolUI, true);
				},
			});
			this.#phase = "active";
			this.#showAddress(handle);
			this.#openBrowser(handle);
			if (handle.urls.length === 1)
				this.#showNotice("未找到非 loopback IPv4 网络接口；当前仅可使用本机地址。", "warning");
		} catch (error) {
			try {
				await closeAllWebGuis();
			} catch (cleanupError) {
				this.#phase = "exiting";
				this.#showOverlay(`服务启动失败且 WebGUI 尚未结清；普通终端保持暂停。输入 ${exitCommand} 重试退出。`);
				throw new AggregateError([error, cleanupError], "WebGUI 服务启动失败，且资源仍待结清");
			}
			this.#release();
			throw error;
		}
	}

	#showAddress(handle: WebGuiHandle): void {
		const copyRequested = requestOfflineBrowserUrlCopy(handle.loopbackUrl);
		this.#showOverlay(
			copyRequested
				? "已尝试复制完整本机地址，可在浏览器地址栏粘贴；未生效时请手动复制上方地址。"
				: "地址可选择复制，或按住 Ctrl 点击在浏览器中打开。",
			handle.urls,
		);
	}

	#openBrowser(handle: WebGuiHandle): void {
		if (offlineFromEnv()) {
			this.#showNotice("offline 模式不自动打开浏览器；请使用上方地址访问。", "muted");
			return;
		}
		if (process.env.OMP_WEBGUI_NO_OPEN === "1") {
			this.#showNotice("已按 OMP_WEBGUI_NO_OPEN=1 跳过自动打开浏览器；请使用上方地址访问。", "muted");
			return;
		}
		void openPathWithResult(handle.loopbackUrl).then(result => {
			if (this.#phase !== "active") return;
			if (!result.opened) this.#showNotice(`浏览器未自动打开：${result.reason}\n请使用上方地址访问。`, "warning");
		});
	}

	async #exit(): Promise<void> {
		this.#phase = "exiting";
		this.#showOverlay("正在停止并结清 WebGUI；普通终端将在结清后恢复。");
		try {
			await closeAllWebGuis();
		} catch (error) {
			this.#showOverlay(`WebGUI 尚未结清；普通终端保持暂停。输入 ${exitCommand} 重试退出。`);
			throw error;
		}
		this.#release();
		this.#context.showStatus("已退出 WebGUI，普通会话和草稿保持不变。");
	}
}

export function getWebGuiTuiMode(context: InteractiveModeContext): WebGuiTuiMode {
	let mode = modes.get(context);
	if (!mode) {
		mode = new WebGuiTuiMode(context);
		modes.set(context, mode);
	}
	return mode;
}
