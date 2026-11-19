import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import type { WebSocketHandler } from "bun";
import {
	WEBGUI_PROJECTS_PATH,
	WEBGUI_RPC_PATH,
	WEBGUI_SERVER_INFO_PATH,
	WEBGUI_SESSION_INFO_PATH,
} from "../../../../vendor/zcode-frontend/preview/session-info";
import type { ServerRemoteInfo } from "../../../../vendor/zcode-frontend/packages/shared/src/server-remote";
import { getWorkbenchAddresses } from "../utils/browser-network";
import { browserProjectSummary, listBrowserProjects, readBrowserProject } from "./project-registry";
import { openWebGuiNativeProject } from "./native-session-host";
import { resolveWebGuiProject, WebGuiRequestError, WebGuiRpcHost, type WebGuiSocketData } from "./rpc-server";
import { prepareWebGuiAssets, type WebGuiStaticAssets } from "./static-assets";

export interface WebServerHandle {
	readonly url: string;
	readonly urls: readonly string[];
	readonly loopbackUrl: string;
	close(): Promise<void>;
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
	});
}

function loopback(address: string): boolean {
	return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** Host validation prevents DNS rebinding; peer addresses always come from Bun, never headers. */
function browserRequest(
	request: Request,
	address: string | undefined,
	port: number,
	hosts: ReadonlySet<string>,
): boolean {
	if (!address || request.headers.get("sec-fetch-site") === "cross-site") return false;
	try {
		const url = new URL(request.url);
		const host = request.headers.get("host");
		if (
			url.protocol !== "http:" ||
			url.username ||
			url.password ||
			host !== url.host ||
			url.port !== String(port) ||
			!hosts.has(url.hostname)
		)
			return false;
		const origin = request.headers.get("origin");
		return (!origin || origin === url.origin) && (url.pathname !== WEBGUI_RPC_PATH || !!origin);
	} catch {
		return false;
	}
}

class ProcessWebServer {
	#server: Bun.Server<WebGuiSocketData>;
	#rpc = new WebGuiRpcHost();
	#stopping = false;
	#closing: Promise<void> | undefined;
	readonly handle: WebServerHandle;

	constructor(assets: WebGuiStaticAssets, standaloneWorkspacePath: string) {
		const addresses = getWorkbenchAddresses(true);
		const hosts = new Set([...addresses, "localhost", "[::1]"]);
		const websocket: WebSocketHandler<WebGuiSocketData> = {
			...this.#rpc.websocket,
			open: socket => {
				if (this.#stopping) return socket.close(1001, "OMP web server is stopping");
				const project = socket.data.project;
				if (project) {
					const live = readBrowserProject(project.projectId);
					if (!live || live.ownerId !== project.ownerId || live.mode !== "webgui" || live.phase !== "active")
						return socket.close(1008, "WebGUI project ownership has ended");
				}
				return this.#rpc.websocket.open?.(socket);
			},
			message: (socket, message) => {
				if (this.#stopping) return;
				return this.#rpc.websocket.message(socket, message);
			},
		};
		this.#server = Bun.serve<WebGuiSocketData>({
			hostname: "0.0.0.0",
			port: 0,
			maxRequestBodySize: 24 * 1024 * 1024,
			websocket,
			fetch: async (request, server) => {
				if (this.#stopping) return json({ error: "OMP web server is stopping" }, 503);
				const url = new URL(request.url);
				const address = server.requestIP(request)?.address;
				if (!browserRequest(request, address, server.port!, hosts)) return json({ error: "Forbidden" }, 403);
				try {
					if (
						url.pathname === WEBGUI_SERVER_INFO_PATH ||
						url.pathname === WEBGUI_RPC_PATH ||
						url.pathname === WEBGUI_PROJECTS_PATH ||
						url.pathname === WEBGUI_SESSION_INFO_PATH
					) {
						if (url.pathname === WEBGUI_PROJECTS_PATH && request.method === "POST") {
							if (request.headers.get("origin") !== url.origin) return json({ error: "Forbidden" }, 403);
							if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
								return json({ error: "Expected an application/json request" }, 415);
							let value: unknown;
							try {
								value = await request.json();
							} catch {
								return json({ error: "Invalid project request JSON" }, 400);
							}
							if (
								!value ||
								typeof value !== "object" ||
								!("path" in value) ||
								typeof value.path !== "string" ||
								("create" in value && typeof value.create !== "boolean")
							)
								return json({ error: "Expected {path: string, create?: boolean}" }, 400);
							try {
								return json(
									await openWebGuiNativeProject(value.path, "create" in value && value.create === true),
								);
							} catch (error) {
								return json({ error: error instanceof Error ? error.message : String(error) }, 409);
							}
						}
						if (request.method !== "GET")
							return new Response(null, {
								status: 405,
								headers: {
									Allow: url.pathname === WEBGUI_PROJECTS_PATH ? "GET, POST" : "GET",
									"Cache-Control": "no-store",
								},
							});
						if (url.pathname === WEBGUI_PROJECTS_PATH) {
							const projects = listBrowserProjects()
								.filter(project => project.allowLan || loopback(address!))
								.map(browserProjectSummary);
							return json({ projects });
						}
						if (url.pathname === WEBGUI_SESSION_INFO_PATH) return this.#sessionInfo(url, address!);
						const project = await resolveWebGuiProject(url);
						if (project) {
							const live = readBrowserProject(project.projectId);
							if (!live || live.ownerId !== project.ownerId)
								throw new WebGuiRequestError(404, "Project not found");
							if (live.mode !== "webgui" || live.phase !== "active")
								throw new WebGuiRequestError(409, "Project is not active in WebGUI mode");
						}
						if (project && !project.allowLan && !loopback(address!)) return json({ error: "Forbidden" }, 403);
						if (this.#stopping) return json({ error: "OMP web server is stopping" }, 503);
						// Display context does not register a project or grant native business access.
						const workspacePath = project?.root ?? standaloneWorkspacePath;
						if (url.pathname === WEBGUI_SERVER_INFO_PATH) {
							const info: Pick<ServerRemoteInfo, "workspaces"> & { businessAvailable: false } = {
								workspaces: [{ path: workspacePath }],
								businessAvailable: false,
							};
							return json(info);
						}
						if (
							server.upgrade(request, {
								data: { project, workspacePath },
								headers: { "Cache-Control": "no-store" },
							})
						)
							return;
						return json({ error: "WebSocket upgrade required" }, 426);
					}
					if (/^\/(?:api|internal)(?:\/|$)/.test(url.pathname) || url.pathname.startsWith(`${WEBGUI_RPC_PATH}/`))
						return json({ error: "Not found" }, 404);
					return assets.fetch(request);
				} catch (error) {
					if (error instanceof WebGuiRequestError) return json({ error: error.message }, error.status);
					throw error;
				}
			},
			error(error) {
				logger.warn("OMP web request failed", { error: String(error) });
				return json({ error: "OMP web request failed" }, 500);
			},
		});
		const port = this.#server.port;
		const loopbackUrl = `http://127.0.0.1:${port}/`;
		this.handle = {
			url: loopbackUrl,
			urls: addresses.map(address => `http://${address}:${port}/`),
			loopbackUrl,
			close: () => closeRuntime(this),
		};
	}

	#sessionInfo(url: URL, address: string): Response {
		const ids = url.searchParams.getAll("projectId");
		if (!ids.length) return json({ bound: false });
		if (ids.length !== 1 || !ids[0]) return json({ error: "Project not found" }, 404);
		const project = readBrowserProject(ids[0]);
		if (!project) return json({ error: "Project not found" }, 404);
		if (!project.allowLan && !loopback(address)) return json({ error: "Forbidden" }, 403);
		if (project.mode !== "webgui" || project.phase !== "active")
			return json({ error: "Project is not active in WebGUI mode" }, 409);
		if (!project.readInfo) return json({ error: "Project session information is unavailable" }, 503);
		return json(project.readInfo());
	}

	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#stopping = true;
		this.#closing = (async () => {
			this.#rpc.dispose();
			logger.debug("WebGUI shutdown stage", { stage: "rpc-closed" });
			await this.#server.stop(true);
			logger.debug("WebGUI shutdown stage", { stage: "listener-closed" });
		})();
		void this.#closing.catch(() => {
			this.#closing = undefined;
		});
		return this.#closing;
	}
}

let runtime: ProcessWebServer | undefined;
let starting: Promise<ProcessWebServer> | undefined;
let closing: Promise<void> | undefined;

/** Each OMP process owns one ephemeral listener; no discovery, workers or internal HTTP. */
export async function ensureWebServer(): Promise<WebServerHandle> {
	if (closing) await closing;
	if (runtime) return runtime.handle;
	if (!starting) {
		starting = (async () => {
			const workspacePath = getProjectDir();
			const assets = await prepareWebGuiAssets();
			const server = new ProcessWebServer(assets, workspacePath);
			runtime = server;
			return server;
		})();
		void starting
			.finally(() => {
				starting = undefined;
			})
			.catch(() => {});
	}
	const server = await starting;
	if (closing) throw new Error("OMP web server closed during startup");
	return server.handle;
}

function closeRuntime(server: ProcessWebServer): Promise<void> {
	if (server !== runtime) return server.close();
	return closeWebServer();
}

/** Closing is scoped to this module's listener, including a startup still preparing assets. */
export function closeWebServer(): Promise<void> {
	if (closing) return closing;
	const pending = starting;
	closing = (async () => {
		let server = runtime;
		if (!server && pending) {
			try {
				server = await pending;
			} catch {
				return;
			}
		}
		if (!server) return;
		await server.close();
		if (runtime === server) runtime = undefined;
	})();
	void closing
		.finally(() => {
			closing = undefined;
		})
		.catch(() => {});
	return closing;
}
