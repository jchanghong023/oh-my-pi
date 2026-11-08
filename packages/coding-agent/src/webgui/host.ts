import * as path from "node:path";
import { logger, ptree, readLines } from "@oh-my-pi/pi-utils";
import { getPackageDir } from "../config";
import type { DevWorkbenchHandle } from "../dev-workbench/host";
import { getWorkbenchAddresses } from "../dev-workbench/server";
import { openPathWithResult } from "../utils/open";

export interface WebGuiHandle extends DevWorkbenchHandle {
	exited: Promise<number>;
}

/** Own only this preview process; never attach to or stop a manually started server. */
export async function startWebGui(): Promise<WebGuiHandle> {
	const packageDir = getPackageDir();
	if (!packageDir) throw new Error("WebGUI requires the copied frontend in an OMP source checkout.");
	const frontendDir = path.resolve(packageDir, "../../vendor/zcode-frontend");
	const viteEntry = path.join(frontendDir, "node_modules/vite/bin/vite.js");
	if (!(await Bun.file(path.join(frontendDir, "preview/index.html")).exists())) {
		throw new Error(`WebGUI frontend resources are missing: ${frontendDir}`);
	}
	if (!(await Bun.file(viteEntry).exists())) {
		throw new Error(`WebGUI dependencies are missing. Run bun install --frozen-lockfile in ${frontendDir}`);
	}
	const child = ptree.spawn(
		[process.execPath, viteEntry, "--config", "preview/vite.config.ts", "--host", "0.0.0.0", "--port", "0"],
		{
			cwd: frontendDir,
			env: { ...Bun.env, BUN_BE_BUN: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
			stdin: "ignore",
			detached: process.platform !== "win32",
		},
	);
	const ready = Promise.withResolvers<number>();
	const stopChild = () => child.kill();
	process.on("exit", stopChild);
	const output = (async () => {
		const decoder = new TextDecoder();
		for await (const bytes of readLines(child.stdout)) {
			const line = decoder.decode(bytes);
			logger.debug("WebGUI preview", { line });
			const local = /Local:\s+http:\/\/(?:localhost|127\.0\.0\.1):(\d+)\//.exec(line);
			if (local) ready.resolve(Number(local[1]));
		}
	})();
	void output.catch(error => ready.reject(error));
	void child.exited.then(
		code => ready.reject(new Error(`WebGUI preview exited (${code}): ${child.peekStderr()}`)),
		error => ready.reject(error),
	);
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (!closing) {
			closing = (async () => {
				child.kill();
				await output;
				await child.wait({ allowNonZero: true, allowAbort: true });
				process.off("exit", stopChild);
			})();
			void closing.catch(() => { closing = undefined; });
		}
		return closing;
	};
	try {
		const port = await ready.promise;
		const loopbackUrl = `http://127.0.0.1:${port}/`;
		return {
			url: loopbackUrl,
			urls: getWorkbenchAddresses(true).map(address => `http://${address}:${port}/`),
			loopbackUrl,
			exited: child.exited,
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

/** Standalone entry, with no Agent session, backend connection or configuration mutation. */
export async function runWebGuiCommand(): Promise<void> {
	const shutdown = Promise.withResolvers<void>();
	const inputAbort = new AbortController();
	const stop = () => shutdown.resolve();
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
	let handle: WebGuiHandle | undefined;
	try {
		handle = await startWebGui();
		process.stdout.write("WebGUI 界面预览（未连接 OMP 后端）\n");
		for (const url of handle.urls) process.stdout.write(`${url}\n`);
		process.stdout.write("输入 /webgui 退出；关闭网页不会停止服务。\n");
		if (process.env.OMP_WEBGUI_NO_OPEN !== "1") {
			const result = await openPathWithResult(handle.loopbackUrl);
			if (!result.opened) process.stderr.write(`浏览器未自动打开：${result.reason}\n`);
		}
		const input = (async () => {
			const decoder = new TextDecoder();
			for await (const bytes of readLines(Bun.stdin.stream(), inputAbort.signal)) {
				if (decoder.decode(bytes).trim() === "/webgui") {
					shutdown.resolve();
					return;
				}
				process.stdout.write("WebGUI 占用当前终端；仅输入 /webgui 可退出。\n");
			}
		})();
		void input.catch(error => {
			logger.warn("WebGUI terminal input unavailable", { error: String(error) });
			shutdown.resolve();
		});
		await Promise.race([shutdown.promise, handle.exited]);
	} finally {
		inputAbort.abort();
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
		await handle?.close();
	}
}
