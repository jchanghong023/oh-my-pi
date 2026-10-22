import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fetch as nativeFetch } from "bun";
import { withProxyInit } from "@oh-my-pi/pi-ai/utils/proxy";
import { resolveExtraCa, wrapFetchForExtraCa } from "@oh-my-pi/pi-utils";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { appServerHelp } from "../../cli/command-help";
import { ZCodeFrameWriter, runZCodeAppServer } from "./server";
import {
	ZCODE_AGENT_CA_CERT_ENV_KEY,
	ZCODE_HTTP_PROXY_ENV_KEY,
	ZCODE_NO_PROXY_ENV_KEY,
} from "./schema/vendor/runtimeEnv";
import { prepareZCodeStorage } from "./storage";

/** Host 网络配置归进程所有，不按会话重复维护。 */
async function configureHostNetwork(): Promise<void> {
	const hostProxy = process.env[ZCODE_HTTP_PROXY_ENV_KEY];
	const hostNoProxy = process.env[ZCODE_NO_PROXY_ENV_KEY];
	if (hostProxy !== undefined) {
		const value = hostProxy.trim();
		const proxy = value && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? `http://${value}` : value;
		for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
			process.env[key] = proxy;
		}
		if (!proxy) {
			// CLI 可能已捕获系统代理；Host 显式空值不能再进入该包装链，
			// 但仍保留原生请求／Provider 配置及 PI_PROXY 的更高优先级。
			const nativeProxy = process.env.PI_PROXY?.trim();
			globalThis.fetch = nativeProxy
				? Object.assign(
						(input: string | URL | Request, init?: RequestInit) =>
							nativeFetch(input, withProxyInit(input, init, nativeProxy)),
						{ preconnect: nativeFetch.preconnect },
					)
				: nativeFetch;
		}
	}
	if (hostNoProxy !== undefined || hostProxy !== undefined) {
		process.env.NO_PROXY = process.env.no_proxy = hostNoProxy?.trim() ?? "";
	}
	const caPath = process.env[ZCODE_AGENT_CA_CERT_ENV_KEY]?.trim();
	if (caPath) {
		if (!(await fs.stat(caPath)).isFile()) throw new Error("ZCode CA certificate must be an existing file");
		process.env.NODE_EXTRA_CA_CERTS = caPath;
		// 仅在 Host 配置 CA 时覆盖 fork 的宽松启动默认值，由原生机制合并信任根。
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
		resolveExtraCa();
		globalThis.fetch = wrapFetchForExtraCa(globalThis.fetch) as typeof globalThis.fetch;
	}
}

/** Dedicated command boundary; none of the native launch/TUI/rpc/acp paths run here. */
export async function runAppServerCommand(argv: string[]): Promise<void> {
	let stdio = false;
	let prepareStorage = false;
	let surface: "desktop" | "default" = "default";
	let cwd = process.cwd();
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--stdio") stdio = true;
		else if (flag === "--prepare-storage") prepareStorage = true;
		else if (flag === "--surface") {
			const value = argv[++index];
			if (value !== "desktop") throw new Error("app-server --surface requires desktop");
			surface = value;
		} else if (flag === "--cwd") {
			const value = argv[++index];
			if (!value || !path.isAbsolute(value)) throw new Error("app-server --cwd requires an absolute path");
			cwd = path.resolve(value);
		} else throw new Error(`Unknown app-server argument: ${flag}`);
	}
	if (!stdio) throw new Error("app-server requires --stdio");
	if (!(await fs.stat(cwd)).isDirectory()) throw new Error("app-server cwd must be an existing directory");
	await configureHostNetwork();
	// Third-party diagnostic console calls must not corrupt the protocol channel.
	const originalLog = console.log;
	const originalInfo = console.info;
	const originalDebug = console.debug;
	console.log = console.error;
	console.info = console.error;
	console.debug = console.error;
	try {
		if (prepareStorage) {
			const writer = new ZCodeFrameWriter(process.stdout);
			await prepareZCodeStorage(process.stdin, frame => writer.write(frame));
			await writer.flush();
		} else await runZCodeAppServer({ cwd, surface });
	} finally {
		console.log = originalLog;
		console.info = originalInfo;
		console.debug = originalDebug;
	}
}
export { runZCodeAppServer, ZCodeServer, ZCodeFrameWriter, ZCodeProtocolError } from "./server";

export default class AppServer extends Command {
	static description = appServerHelp.description;
	static strict = false;
	async run(): Promise<void> {
		await runAppServerCommand(this.argv);
	}
}
