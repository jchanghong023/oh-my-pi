import { createInterface } from "node:readline";
import { logger } from "@oh-my-pi/pi-utils";
import { offlineFromEnv } from "../cli/args";
import type { AIReqWorkbenchHandle } from "../aireq-workbench/host";
import type { AgentSession } from "../session/agent-session";
import { requestOfflineBrowserUrlCopy } from "../utils/clipboard";
import { openPathWithResult } from "../utils/open";
import {
	installNativeWebGuiInteractions,
	restoreNativeWebGuiInteractions,
	type NativeWebGuiInteractionBindings,
} from "./native-interactions";
import {
	assertWebGuiNativeAdmission,
	closeWebGuiNativeSessions,
	enableWebGuiNativeSessions,
	releaseWebGuiNativeProjects,
	hasWebGuiNativeResources,
} from "./native-session-host";
import { acquireBrowserProject, readBrowserProject } from "./project-registry";
import { closeWebServer, ensureWebServer } from "./server";
import { readWebGuiSessionInfo } from "./session-source";

export interface WebGuiHandle extends AIReqWorkbenchHandle {
	readonly projectId: string;
}

const bindingClosures = new Map<WebGuiHandle, () => Promise<void>>();
const handles = new Set<WebGuiHandle>();
const openings = new Set<Promise<WebGuiHandle>>();
let settling: Promise<void> | undefined;
let activated = false;

export type WebGuiBindings = NativeWebGuiInteractionBindings;

/** Keep failed startup settlement reachable by the terminal's exit/retry flow. */
export class WebGuiStartError extends AggregateError {
	constructor(
		errors: readonly unknown[],
		readonly handle: WebGuiHandle,
	) {
		super(errors, "WebGUI startup and project settlement failed");
	}
}

/** Bind the existing native session without creating another Agent or private listener. */
export function startWebGui(session: AgentSession, bindings?: WebGuiBindings): Promise<WebGuiHandle> {
	enableWebGuiNativeSessions();
	activated = true;
	const opening = bindWebGui(session, bindings);
	openings.add(opening);
	void opening.then(
		() => openings.delete(opening),
		() => openings.delete(opening),
	);
	return opening;
}

async function bindWebGui(session: AgentSession, bindings?: WebGuiBindings): Promise<WebGuiHandle> {
	const lease = await acquireBrowserProject(session.sessionManager.getCwd(), "webgui", { reuseWebGuiOwner: true });
	let closing: Promise<void> | undefined;
	let exiting = false;
	const closeBinding = (): Promise<void> => {
		exiting = true;
		if (!closing) {
			const pending = (async () => {
				restoreNativeWebGuiInteractions(session);
				await lease.close();
				handles.delete(handle);
				bindingClosures.delete(handle);
			})();
			closing = pending;
			void pending.catch(() => {
				if (closing === pending) closing = undefined;
			});
		}
		return closing;
	};
	const handle: WebGuiHandle = {
		projectId: lease.projectId,
		url: "",
		urls: [],
		loopbackUrl: "",
		close: closeAllWebGuis,
	};
	handles.add(handle);
	bindingClosures.set(handle, closeBinding);
	try {
		const server = await ensureWebServer({ webgui: true });
		if (exiting) throw new Error("WebGUI exited during server startup");
		assertWebGuiNativeAdmission();
		await lease.activate(
			() => {
				const current = readBrowserProject(lease.projectId)?.nativeSession;
				return current ? readWebGuiSessionInfo(current) : { bound: false };
			},
			{ allowLan: true, nativeSession: session },
		);
		if (bindings) installNativeWebGuiInteractions(session, bindings);
		if (exiting) throw new Error("WebGUI exited during project activation");
		const selected = (address: string): string => {
			const url = new URL(address);
			url.searchParams.set("project", lease.projectId);
			return url.href;
		};
		handle.url = selected(server.url);
		handle.urls = server.urls.map(selected);
		handle.loopbackUrl = selected(server.loopbackUrl);
		return handle;
	} catch (error) {
		try {
			await closeBinding();
		} catch (cleanup) {
			throw new WebGuiStartError([error, cleanup], handle);
		}
		throw error;
	}
}

/** Settle every GUI binding owned by this process before stopping its listener. */
export function closeAllWebGuis(): Promise<void> {
	if (!activated && !handles.size && !openings.size && !hasWebGuiNativeResources()) return Promise.resolve();
	if (settling) return settling;
	const nativeSettlement = closeWebGuiNativeSessions();
	const operation = (async () => {
		const settlements = await Promise.allSettled([Promise.allSettled(openings), nativeSettlement]);
		const native = settlements[1];
		if (native.status === "rejected") throw native.reason;
		logger.debug("WebGUI shutdown stage", { stage: "native-settled" });
		// Keep leases until watcher/socket/listener teardown has also succeeded.
		await closeWebServer();
		await releaseWebGuiNativeProjects();
		const results = await Promise.allSettled([...bindingClosures.values()].map(close => close()));
		const failed = results.filter(result => result.status === "rejected");
		if (failed.length)
			throw new AggregateError(
				failed.map(result => result.reason),
				"WebGUI project settlement failed",
			);
		activated = false;
		logger.debug("WebGUI shutdown stage", { stage: "resources-settled" });
	})();
	settling = operation;
	void operation.then(
		() => {
			settling = undefined;
		},
		() => {
			settling = undefined;
		},
	);
	return operation;
}

/** Standalone startup is lazy; only explicit browser actions admit projects and native sessions. */
export async function runWebGuiCommand(): Promise<void> {
	enableWebGuiNativeSessions();
	activated = true;
	let shutdown = Promise.withResolvers<void>();
	let inputLines: ReturnType<typeof createInterface> | undefined;
	const stop = () => shutdown.resolve();
	let input: Promise<void> | undefined;
	let inputError: unknown;
	let settled = false;
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
	try {
		const server = await ensureWebServer({ webgui: true });
		process.stdout.write("WebGUI 已启动，请在浏览器打开或创建项目后新建原生会话。\n");
		for (const url of server.urls) process.stdout.write(`${url}\n`);
		if (requestOfflineBrowserUrlCopy(server.loopbackUrl))
			process.stdout.write("已尝试复制完整本机地址，可在浏览器地址栏粘贴；未生效时请手动复制上方地址。\n");
		process.stdout.write("输入 /webgui 退出并关闭当前 OMP 的 Web 服务。\n");
		if (offlineFromEnv()) {
			process.stderr.write("offline 模式不自动打开浏览器；请使用上方地址访问。\n");
		} else if (process.env.OMP_WEBGUI_NO_OPEN === "1") {
			process.stderr.write("已按 OMP_WEBGUI_NO_OPEN=1 跳过自动打开浏览器；请使用上方地址访问。\n");
		} else {
			const result = await openPathWithResult(server.loopbackUrl);
			if (!result.opened) process.stderr.write(`浏览器未自动打开：${result.reason}\n`);
		}
		// Own a closable reader: cancelling Bun's native stdin stream can wait
		// for another pipe read on Windows even after all native sessions settle.
		const lines = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
		inputLines = lines;
		input = (async () => {
			for await (const line of lines) {
				if (line.trim() === "/webgui") {
					stop();
					continue;
				}
				process.stdout.write("WebGUI 占用当前终端；仅输入 /webgui 可退出。\n");
			}
			stop();
		})().catch(error => {
			inputError = error;
			stop();
		});
		for (;;) {
			await shutdown.promise;
			shutdown = Promise.withResolvers<void>();
			try {
				await closeAllWebGuis();
				await closeWebServer();
				settled = true;
				break;
			} catch (error) {
				process.stderr.write(
					`WebGUI 退出未结清，项目保持锁定：${error instanceof Error ? error.message : String(error)}\n`,
				);
				process.stderr.write("请再次输入 /webgui 重试退出。\n");
			}
		}
		if (inputError !== undefined) throw inputError;
	} finally {
		logger.debug("WebGUI shutdown stage", { stage: "input-closing" });
		inputLines?.close();
		await input;
		logger.debug("WebGUI shutdown stage", { stage: "input-closed" });
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
		if (!settled) {
			await closeAllWebGuis();
			await closeWebServer();
		}
	}
}
