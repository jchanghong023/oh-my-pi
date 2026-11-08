import { readLines } from "@oh-my-pi/pi-utils";
import type { DevWorkbenchHandle } from "../dev-workbench/host";
import type { AgentSession } from "../session/agent-session";
import { openPathWithResult } from "../utils/open";
import { NativeCwdHost } from "./native-cwd";
import { acquireBrowserProject } from "./project-registry";
import { closeWebServer, ensureWebServer } from "./server";
import { readWebGuiSessionInfo } from "./session-source";

export interface WebGuiHandle extends DevWorkbenchHandle {
	readonly projectId: string;
}

const handles = new Set<WebGuiHandle>();
const openings = new Set<Promise<WebGuiHandle>>();

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
export function startWebGui(session: AgentSession): Promise<WebGuiHandle> {
	const opening = bindWebGui(session);
	openings.add(opening);
	void opening.then(
		() => openings.delete(opening),
		() => openings.delete(opening),
	);
	return opening;
}

async function bindWebGui(session: AgentSession): Promise<WebGuiHandle> {
	const lease = await acquireBrowserProject(session.sessionManager.getCwd(), "webgui");
	const cwdHost = new NativeCwdHost(session, lease);
	let closing: Promise<void> | undefined;
	let exiting = false;
	const handle: WebGuiHandle = {
		projectId: lease.projectId,
		url: "",
		urls: [],
		loopbackUrl: "",
		close() {
			exiting = true;
			if (!closing) {
				const pending = (async () => {
					await cwdHost.close();
					handles.delete(handle);
				})();
				closing = pending;
				void pending.catch(() => {
					if (closing === pending) closing = undefined;
				});
			}
			return closing;
		},
	};
	handles.add(handle);
	try {
		const server = await ensureWebServer({ webgui: true });
		if (exiting) throw new Error("WebGUI exited during server startup");
		await lease.activate(() => readWebGuiSessionInfo(session), { allowLan: true, nativeSession: session });
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
			await handle.close();
		} catch (cleanup) {
			throw new WebGuiStartError([error, cleanup], handle);
		}
		throw error;
	}
}

/** Settle every GUI binding owned by this process before stopping its listener. */
export async function closeAllWebGuis(): Promise<void> {
	await Promise.allSettled(openings);
	const results = await Promise.allSettled([...handles].map(handle => handle.close()));
	const failed = results.filter(result => result.status === "rejected");
	if (failed.length)
		throw new AggregateError(
			failed.map(result => result.reason),
			"WebGUI project settlement failed",
		);
}

/** Standalone browsing owns its in-process listener, but never an Agent or project. */
export async function runWebGuiCommand(): Promise<void> {
	const shutdown = Promise.withResolvers<void>();
	const inputAbort = new AbortController();
	const stop = () => shutdown.resolve();
	let input: Promise<void> | undefined;
	let inputError: unknown;
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
	try {
		const server = await ensureWebServer({ webgui: true });
		process.stdout.write("WebGUI 已启动（尚未连接的业务能力会明确显示不可用）。\n");
		for (const url of server.urls) process.stdout.write(`${url}\n`);
		process.stdout.write("输入 /webgui 退出并关闭当前 OMP 的 Web 服务。\n");
		if (process.env.OMP_WEBGUI_NO_OPEN === "1") {
			process.stderr.write("已按 OMP_WEBGUI_NO_OPEN=1 跳过自动打开浏览器；请使用上方地址访问。\n");
		} else {
			const result = await openPathWithResult(server.loopbackUrl);
			if (!result.opened) process.stderr.write(`浏览器未自动打开：${result.reason}\n`);
		}
		input = (async () => {
			const decoder = new TextDecoder();
			for await (const bytes of readLines(Bun.stdin.stream(), inputAbort.signal)) {
				if (decoder.decode(bytes).trim() === "/webgui") return stop();
				process.stdout.write("WebGUI 占用当前终端；仅输入 /webgui 可退出。\n");
			}
			stop();
		})().catch(error => {
			if (!inputAbort.signal.aborted) inputError = error;
			stop();
		});
		await shutdown.promise;
		if (inputError !== undefined) throw inputError;
	} finally {
		inputAbort.abort();
		await input;
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
		await closeAllWebGuis();
		await closeWebServer();
	}
}
