import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import * as path from "node:path";
import { defineConfig, type HttpProxy, type Plugin, type PreviewServer, type ProxyOptions, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
	WEBGUI_CONTROL_TOKEN_ENV,
	WEBGUI_DEV_TARGET_PATH,
	WEBGUI_PROJECTS_PATH,
	WEBGUI_SESSION_INFO_ORIGIN_ENV,
	WEBGUI_SESSION_INFO_PATH,
} from "./session-info.js";

const root = path.resolve(import.meta.dirname, "..");
const packages = path.join(root, "packages");
const gatewayOrigin = process.env[WEBGUI_SESSION_INFO_ORIGIN_ENV];
const controlToken = process.env[WEBGUI_CONTROL_TOKEN_ENV];

interface DevRoute {
	target: URL;
	publicPrefix: string;
}

class GatewayError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

function loopback(address: string | undefined): boolean {
	return address === "::1" || address?.startsWith("127.") === true || address?.startsWith("::ffff:127.") === true;
}

function sameOrigin(req: IncomingMessage): void {
	// Validate the original browser headers before rewriting Host/Origin upstream.
	const origin = req.headers.origin;
	if (req.headers["sec-fetch-site"] === "cross-site" || (origin && origin !== `http://${req.headers.host}`))
		throw new GatewayError(403, "Cross-origin Dev requests are not allowed");
}

async function devRoute(req: IncomingMessage): Promise<DevRoute> {
	const match = /^\/dev\/([a-f0-9]{64})\//.exec(req.url ?? "");
	if (!match) throw new GatewayError(404, "Dev project not found");
	if (!gatewayOrigin || !controlToken) throw new GatewayError(503, "Dev requires the shared OMP gateway");
	sameOrigin(req);
	const response = await fetch(`${gatewayOrigin}${WEBGUI_DEV_TARGET_PATH}?projectId=${match[1]}`, {
		headers: { Authorization: `Bearer ${controlToken}` },
		signal: AbortSignal.timeout(5_000), redirect: "error", cache: "no-store",
	});
	if (!response.ok) throw new GatewayError(
		response.status === 404 || response.status === 409 ? response.status : 502, "Dev project is unavailable",
	);
	const body: unknown = await response.json();
	if (!body || typeof body !== "object" || !("devUrl" in body) || typeof body.devUrl !== "string" ||
		!("allowLan" in body) || typeof body.allowLan !== "boolean")
		throw new GatewayError(502, "Invalid native Dev target");
	if (!body.allowLan && !loopback(req.socket.remoteAddress))
		throw new GatewayError(403, "This Dev project allows only local connections");
	const target = new URL(body.devUrl);
	if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port ||
		!/^\/[a-f0-9]{64}\/$/.test(target.pathname) || target.search || target.hash || target.username || target.password)
		throw new GatewayError(502, "Invalid native Dev target");
	const publicPrefix = match[0] + target.pathname.slice(1);
	// Project discovery must not replace the native workbench's random capability.
	if (!(req.url ?? "").startsWith(publicPrefix))
		throw new GatewayError(404, "Native Dev capability is missing");
	return { target, publicPrefix };
}

function proxyOptions(req: IncomingMessage, route: DevRoute): HttpProxy.ServerOptions {
	const { target, publicPrefix } = route;
	req.url = target.pathname + (req.url ?? "").slice(publicPrefix.length);
	if (req.headers.origin) req.headers.origin = target.origin;
	return {
		target: target.origin, changeOrigin: true, prependPath: false,
		cookiePathRewrite: { [target.pathname]: publicPrefix },
	};
}

function failure(res: ServerResponse, status: number, message: string): void {
	res.statusCode = status;
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify({ error: message }));
}

function upgradeFailure(socket: Duplex, status: number): void {
	const reasons: Record<number, string> = { 403: "Forbidden", 404: "Not Found", 409: "Conflict", 502: "Bad Gateway", 503: "Service Unavailable" };
	const reason = reasons[status] ?? "Bad Gateway";
	socket.end(`HTTP/1.1 ${status} ${reason}\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function gatewayPlugin(): Plugin {
	let proxy: HttpProxy.ProxyServer | undefined;
	const routes = new WeakMap<IncomingMessage, DevRoute>();
	const proxyConfig: ProxyOptions = {
		// Unmatchable HTTP context: obtain Vite's bundled http-proxy-3 instance,
		// then call its public per-request HTTP/WS APIs without mutable targets.
		configure(instance) {
			proxy = instance;
			instance.on("proxyRes", (response, req) => {
				response.headers["cache-control"] = "no-store";
				const route = routes.get(req);
				const location = response.headers.location;
				if (!route || !location) return;
				if (location.startsWith(route.target.href))
					response.headers.location = route.publicPrefix + location.slice(route.target.href.length);
				else if (location.startsWith(route.target.pathname))
					response.headers.location = route.publicPrefix + location.slice(route.target.pathname.length);
			});
		},
	};
	function install(server: ViteDevServer | PreviewServer): void {
		server.middlewares.use((req, res, next) => {
			const pathname = req.url?.split("?", 1)[0] ?? "";
			// No internal control/target endpoint may pass through the public server,
			// even when the gateway has not been configured.
			let decoded: string;
			try { decoded = decodeURIComponent(pathname); } catch { return failure(res, 400, "Invalid path"); }
			if (decoded.startsWith("/internal/")) return failure(res, 404, "Not found");
			if (pathname === WEBGUI_PROJECTS_PATH || pathname === WEBGUI_SESSION_INFO_PATH) {
				res.setHeader("Cache-Control", "no-store");
				if (req.method !== "GET") {
					res.setHeader("Allow", "GET");
					return failure(res, 405, "Method not allowed");
				}
				if (!gatewayOrigin || !controlToken) {
					res.setHeader("Content-Type", "application/json; charset=utf-8");
					return res.end(JSON.stringify(pathname === WEBGUI_PROJECTS_PATH ? { projects: [] } : { bound: false }));
				}
				if (!proxy) return failure(res, 502, "Shared gateway proxy is unavailable");
				// Only these exact read-only metadata paths can reach the private API.
				// Never trust browser-supplied forwarding/address or authorization headers.
				req.headers["x-omp-webgui-client-address"] = req.socket.remoteAddress ?? "";
				req.headers.authorization = `Bearer ${controlToken}`;
				proxy.web(req, res, { target: gatewayOrigin, changeOrigin: true }, () => {
					if (!res.headersSent) failure(res, 502, "Shared gateway is unavailable");
					else res.destroy();
				});
				return;
			}
			if (pathname !== "/dev" && !pathname.startsWith("/dev/")) return next();
			void (async () => {
				const route = await devRoute(req);
				if (res.destroyed) return;
				if (!proxy) throw new GatewayError(502, "Dev proxy is unavailable");
				routes.set(req, route);
				res.setHeader("Cache-Control", "no-store");
				proxy.web(req, res, proxyOptions(req, route), () => {
					if (!res.headersSent) failure(res, 502, "Native Dev server is unavailable");
					else res.destroy();
				});
			})().catch(error => {
				if (!res.headersSent) failure(res, error instanceof GatewayError ? error.status : 502,
					error instanceof GatewayError ? error.message : "Dev gateway is unavailable");
				else res.destroy();
			});
		});
		server.httpServer?.on("upgrade", (req, socket, head) => {
			const pathname = req.url?.split("?", 1)[0] ?? "";
			if (pathname.startsWith("/internal/")) return upgradeFailure(socket, 404);
			if (pathname !== "/dev" && !pathname.startsWith("/dev/")) return;
			// Pause while resolving the registered target; http-proxy owns the
			// handshake, buffered head and all subsequent frames in both directions.
			socket.pause();
			void (async () => {
				const route = await devRoute(req);
				if (socket.destroyed) return;
				if (!proxy) throw new GatewayError(502, "Dev proxy is unavailable");
				routes.set(req, route);
				proxy.ws(req, socket, head, proxyOptions(req, route), () => upgradeFailure(socket, 502));
				socket.resume();
			})().catch(error => upgradeFailure(socket, error instanceof GatewayError ? error.status : 502));
		});
		if (gatewayOrigin && controlToken) {
			// The independent owner keeps this pipe open. EOF also covers SIGKILL
			// on POSIX, where an orphan frontend would otherwise retain its port.
			process.stdin.once("end", () => { void server.close().finally(() => process.exit()); });
			process.stdin.resume();
		}
	}
	return {
		name: "omp-shared-gateway",
		config: () => ({ server: { proxy: { "^$": proxyConfig } }, preview: { proxy: { "^$": proxyConfig } } }),
		configureServer: install,
		configurePreviewServer: install,
	};
}

export default defineConfig({
	root: import.meta.dirname,
	publicDir: path.join(packages, "web/public"),
	plugins: [
		gatewayPlugin(),
		{
			name: "copied-frontend-packages",
			enforce: "pre",
			resolveId(source, importer) {
				if (source.startsWith("#src/") && importer) {
					const packageName = path.relative(packages, importer).split(path.sep)[0];
					return this.resolve(path.join(packages, packageName, "src", source.slice(5)), importer, { skipSelf: true });
				}
				if (!source.startsWith("@zcode/")) return;
				const [packageName, ...segments] = source.slice(7).split("/");
				const manifest = JSON.parse(fs.readFileSync(path.join(packages, packageName, "package.json"), "utf8"));
				const key = segments.length ? `./${segments.join("/")}` : ".";
				let entry = manifest.exports?.[key] ?? (key === "." ? manifest.exports : undefined);
				if (typeof entry === "object") entry = entry.browser ?? entry.import ?? entry.default;
				if (typeof entry !== "string") return;
				return this.resolve(path.join(packages, packageName, entry), importer, { skipSelf: true });
			},
		},
		react(),
		tailwindcss(),
	],
	resolve: {
		alias: {
			"@zcode/ui/styles.css": path.join(packages, "ui/src/styles.css"),
			"@": path.join(packages, "ui/src"),
		},
		dedupe: ["react", "react-dom"],
	},
	define: {
		__ZCODE_VERSION__: JSON.stringify("3.17.2"),
		__ZCODE_ENV__: JSON.stringify("production"),
		__ZCODE_AUTO_UPDATE_ENABLED__: "false",
	},
	server: { host: "0.0.0.0", port: 5177, strictPort: true, fs: { allow: [root] } },
});
