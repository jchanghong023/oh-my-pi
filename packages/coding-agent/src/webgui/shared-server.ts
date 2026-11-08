import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type ChildProcess,
	isEnoent,
	isFileLockHeld,
	isRecord,
	logger,
	ptree,
	readLines,
	tryAcquireFileLock,
} from "@oh-my-pi/pi-utils";
import {
	WEBGUI_CONTROL_TOKEN_ENV,
	WEBGUI_DEV_TARGET_PATH,
	WEBGUI_PROJECTS_PATH,
	WEBGUI_SESSION_INFO_ORIGIN_ENV,
	WEBGUI_SESSION_INFO_PATH,
} from "../../../../vendor/zcode-frontend/preview/session-info";
import { getPackageDir } from "../config";
import { getWorkbenchAddresses } from "../dev-workbench/server";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { writeFileAtomically } from "../utils/atomic-file";
import { openPathWithResult } from "../utils/open";
import {
	browserProjectSummary,
	listBrowserProjects,
	readBrowserProject,
	webGuiRuntimeDir,
	withBrowserProjectAdmission,
} from "./project-registry";

export const WEBGUI_SHARED_WORKER_ARG = "__omp_worker_shared_webgui";
const READY_PATH = "/internal/omp/ready";
const SHUTDOWN_PATH = "/internal/omp/shutdown";
const START_TIMEOUT_MS = 30_000;

export interface SharedWebServer {
	url: string;
	urls: readonly string[];
	loopbackUrl: string;
}

interface Discovery extends SharedWebServer {
	ownerId: string;
	token: string;
	apiOrigin: string;
}

function ownerLockPath(): string {
	return path.join(webGuiRuntimeDir(), "server-owner");
}

function discoveryPath(): string {
	return path.join(webGuiRuntimeDir(), "server.json");
}

function loopback(address: string | undefined): boolean {
	return address === "::1" || address === "127.0.0.1" || address?.startsWith("127.") === true ||
		address?.startsWith("::ffff:127.") === true;
}

function privateOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port &&
			url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
	} catch {
		return false;
	}
}

async function frontendResources(): Promise<{ frontendDir: string; viteEntry: string }> {
	const packageDir = getPackageDir();
	if (!packageDir) throw new Error("WebGUI requires frontend resources in an OMP source checkout");
	const frontendDir = path.resolve(packageDir, "../../vendor/zcode-frontend");
	const viteEntry = path.join(frontendDir, "node_modules/vite/bin/vite.js");
	if (!(await Bun.file(path.join(frontendDir, "preview/index.html")).exists()))
		throw new Error(`WebGUI frontend resources are missing: ${frontendDir}`);
	if (!(await Bun.file(viteEntry).exists()))
		throw new Error(`WebGUI dependencies are missing. Run bun install --frozen-lockfile in ${frontendDir}`);
	return { frontendDir, viteEntry };
}

async function readDiscovery(): Promise<Discovery | null> {
	if (!isFileLockHeld(ownerLockPath())) return null;
	let value: unknown;
	try {
		value = JSON.parse(await fs.readFile(discoveryPath(), "utf8"));
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	if (!isRecord(value) || typeof value.ownerId !== "string" || typeof value.token !== "string" ||
		value.token.length < 32 || typeof value.apiOrigin !== "string" || !privateOrigin(value.apiOrigin) ||
		typeof value.url !== "string" || typeof value.loopbackUrl !== "string" ||
		!privateOrigin(value.loopbackUrl) || !Array.isArray(value.urls) ||
		!value.urls.every(url => typeof url === "string")) {
		throw new Error("Invalid shared WebGUI discovery descriptor");
	}
	return value as unknown as Discovery;
}

async function readyDiscovery(): Promise<Discovery | null> {
	const discovery = await readDiscovery();
	if (!discovery) return null;
	try {
		const response = await fetch(`${discovery.apiOrigin}${READY_PATH}`, {
			headers: { Authorization: `Bearer ${discovery.token}` },
			signal: AbortSignal.timeout(1_000), redirect: "error", cache: "no-store",
		});
		const body: unknown = response.ok ? await response.json() : null;
		return isRecord(body) && body.ownerId === discovery.ownerId && isFileLockHeld(ownerLockPath())
			? discovery : null;
	} catch {
		return null;
	}
}

let starting: Promise<SharedWebServer> | undefined;

/** Discover an authenticated ready owner, or launch an independent OS-lease owner. */
export function ensureSharedWebServer(): Promise<SharedWebServer> {
	if (!starting) {
		starting = ensureServer();
		void starting.finally(() => { starting = undefined; }).catch(() => {});
	}
	return starting;
}

async function ensureServer(): Promise<SharedWebServer> {
	await fs.mkdir(webGuiRuntimeDir(), { recursive: true, mode: 0o700 });
	await fs.chmod(webGuiRuntimeDir(), 0o700);
	const deadline = Date.now() + START_TIMEOUT_MS;
	let spawned = false;
	let spawnFailure: Error | undefined;
	while (Date.now() < deadline) {
		const discovery = await readyDiscovery();
		if (discovery) return { url: discovery.url, urls: discovery.urls, loopbackUrl: discovery.loopbackUrl };
		if (!spawned && !isFileLockHeld(ownerLockPath())) {
			await frontendResources();
			spawned = true;
			const spawn = resolveWorkerSpawnCmd(WEBGUI_SHARED_WORKER_ARG);
			// Windows children otherwise join the launching terminal's kill-on-close job.
			const child = Bun.spawn(spawn.cmd, {
				cwd: spawn.cwd, env: workerEnvFromParent(),
				stdin: "ignore", stdout: "ignore", stderr: "ignore",
				detached: true, windowsHide: true,
			});
			void child.exited.then(code => {
				if (code !== 0) spawnFailure = new Error(`Shared WebGUI owner exited (${code}) before becoming ready`);
			});
			child.unref();
		}
		if (spawnFailure && !isFileLockHeld(ownerLockPath())) throw spawnFailure;
		await Bun.sleep(100);
	}
	throw new Error("Shared WebGUI owner did not become ready; an occupied lease is never treated as readiness");
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

/** CLI worker-host target; only the OS lease winner may publish discovery or start Vite. */
export async function runSharedWebServerWorker(): Promise<void> {
	await fs.mkdir(webGuiRuntimeDir(), { recursive: true, mode: 0o700 });
	await fs.chmod(webGuiRuntimeDir(), 0o700);
	const lease = tryAcquireFileLock(ownerLockPath());
	if (!lease) return;
	const ownerId = crypto.randomUUID();
	const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
	const shutdown = Promise.withResolvers<void>();
	const stop = () => shutdown.resolve();
	let api: Bun.Server<undefined> | undefined;
	let child: ChildProcess<"pipe"> | undefined;
	let output: Promise<void> | undefined;
	let published = false;
	let ready = false;
	const exitStop = () => child?.kill();
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
	process.on("exit", exitStop);
	try {
		await fs.rm(discoveryPath(), { force: true });
		const { frontendDir, viteEntry } = await frontendResources();
		api = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request, server) {
				const url = new URL(request.url);
				if (url.pathname.startsWith("/internal/")) {
					if (!loopback(server.requestIP(request)?.address) ||
						request.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "Forbidden" }, 403);
					if (url.pathname === SHUTDOWN_PATH) {
						if (request.method !== "POST") return new Response(null, {
							status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" },
						});
						return withBrowserProjectAdmission(async () => {
							if ((await listBrowserProjects()).length) return json({ error: "Projects still own this service" }, 409);
							ready = false;
							setTimeout(stop, 0);
							return json({ stopped: true });
						});
					}
				} else if (url.pathname !== WEBGUI_PROJECTS_PATH && url.pathname !== WEBGUI_SESSION_INFO_PATH) {
					return json({ error: "Not found" }, 404);
				}
				if (request.method !== "GET") return new Response(null, {
					status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" },
				});
				if (url.pathname === READY_PATH) return json({ ownerId }, ready ? 200 : 503);
				if (url.pathname === WEBGUI_PROJECTS_PATH) {
					const trustedProxy = loopback(server.requestIP(request)?.address) &&
						request.headers.get("authorization") === `Bearer ${token}`;
					const address = trustedProxy ? request.headers.get("x-omp-webgui-client-address") ?? undefined
						: server.requestIP(request)?.address;
					const projects = (await listBrowserProjects())
						.filter(project => project.mode !== "dev" || project.allowLan || loopback(address))
						.map(browserProjectSummary);
					return json({ projects });
				}
				if (url.pathname !== WEBGUI_DEV_TARGET_PATH && url.pathname !== WEBGUI_SESSION_INFO_PATH)
					return json({ error: "Not found" }, 404);
				const projectId = url.searchParams.get("projectId");
				if (!projectId && url.pathname === WEBGUI_SESSION_INFO_PATH) return json({ bound: false });
				const project = projectId ? await readBrowserProject(projectId) : null;
				if (!project) return json({ error: "Project not found" }, 404);
				if (project.phase !== "active" || project.mode !==
					(url.pathname === WEBGUI_DEV_TARGET_PATH ? "dev" : "webgui"))
					return json({ error: "Project is not active in the requested mode" }, 409);
				if (url.pathname === WEBGUI_DEV_TARGET_PATH)
					return project.devUrl ? json({ devUrl: project.devUrl, allowLan: project.allowLan })
						: json({ error: "Native Dev target is unavailable" }, 502);
				try {
					const response = await fetch(project.infoUrl, {
						signal: AbortSignal.timeout(5_000), redirect: "error", cache: "no-store",
					});
					if (!response.ok) return json({ error: "Project session endpoint is unavailable" }, 502);
					const info: unknown = await response.json();
					const live = await readBrowserProject(project.projectId);
					if (!live || live.ownerId !== project.ownerId) return json({ error: "Project not found" }, 404);
					if (live.phase !== "active") return json({ error: "Project is exiting" }, 409);
					return json(info);
				} catch {
					return json({ error: "Project session endpoint is unavailable" }, 502);
				}
			},
			error(error) {
				logger.warn("Shared WebGUI request failed", { error: String(error) });
				return json({ error: "Shared WebGUI request failed" }, 500);
			},
		});
		const apiOrigin = `http://127.0.0.1:${api.port}`;
		child = ptree.spawn(
			[process.execPath, viteEntry, "--config", "preview/vite.config.ts", "--host", "0.0.0.0", "--port", "0"],
			{
				cwd: frontendDir, stdin: "pipe", detached: false,
				env: workerEnvFromParent({
					BUN_BE_BUN: "1", NO_COLOR: "1", FORCE_COLOR: "0",
					[WEBGUI_SESSION_INFO_ORIGIN_ENV]: apiOrigin,
					[WEBGUI_CONTROL_TOKEN_ENV]: token,
				}),
			},
		);
		const preview = child;
		const listening = Promise.withResolvers<number>();
		output = (async () => {
			const decoder = new TextDecoder();
			for await (const bytes of readLines(preview.stdout)) {
				const line = decoder.decode(bytes);
				logger.debug("Shared WebGUI preview", { line });
				const local = /Local:\s+http:\/\/(?:localhost|127\.0\.0\.1):(\d+)\//.exec(line);
				if (local) listening.resolve(Number(local[1]));
			}
		})();
		void output.catch(error => listening.reject(error));
		const failed = preview.exited.then(code => {
			throw new Error(`Shared WebGUI preview exited (${code}): ${preview.peekStderr()}`);
		});
		void failed.catch(() => {});
		let timer: NodeJS.Timeout | undefined;
		try {
			const timeout = Promise.withResolvers<never>();
			timer = setTimeout(() => timeout.reject(new Error("Shared WebGUI preview readiness timed out")), START_TIMEOUT_MS);
			const port = await Promise.race([listening.promise, failed, timeout.promise]);
			const loopbackUrl = `http://127.0.0.1:${port}/`;
			const probe = await fetch(loopbackUrl, { signal: AbortSignal.timeout(5_000), redirect: "error" });
			if (!probe.ok) throw new Error(`Shared WebGUI preview readiness returned ${probe.status}`);
			await probe.body?.cancel();
			const discovery: Discovery = {
				ownerId, token, apiOrigin, url: loopbackUrl, loopbackUrl,
				urls: getWorkbenchAddresses(true).map(address => `http://${address}:${port}/`),
			};
			ready = true;
			await writeFileAtomically(discoveryPath(), `${JSON.stringify(discovery)}\n`);
			published = true;
		} finally {
			clearTimeout(timer);
		}
		await Promise.race([shutdown.promise, failed]);
	} finally {
		ready = false;
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
		// Keep the lease until the owned frontend and private listener have stopped.
		try {
			if (child) {
				child.kill();
				await output;
				await child.wait({ allowNonZero: true, allowAbort: true });
			}
			await api?.stop(true);
			if (published) await fs.rm(discoveryPath(), { force: true });
			lease.release();
		} finally {
			process.off("exit", exitStop);
		}
	}
}

/** Standalone has no Agent/project lease; closing it never stops live projects. */
export async function runSharedWebGuiCommand(): Promise<void> {
	const shutdown = Promise.withResolvers<void>();
	const inputAbort = new AbortController();
	const stop = () => shutdown.resolve();
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
	try {
		const server = await ensureSharedWebServer();
		process.stdout.write("WebGUI 多项目只读预览\n");
		for (const url of server.urls) process.stdout.write(`${url}\n`);
		process.stdout.write("输入 /webgui 退出；仍有项目时保留共享服务。\n");
		if (process.env.OMP_WEBGUI_NO_OPEN !== "1") {
			const result = await openPathWithResult(server.loopbackUrl);
			if (!result.opened) process.stderr.write(`浏览器未自动打开：${result.reason}\n`);
		}
		const input = (async () => {
			const decoder = new TextDecoder();
			for await (const bytes of readLines(Bun.stdin.stream(), inputAbort.signal)) {
				if (decoder.decode(bytes).trim() === "/webgui") return stop();
				process.stdout.write("WebGUI 占用当前终端；仅输入 /webgui 可退出。\n");
			}
			stop();
		})();
		void input.catch(error => {
			if (!inputAbort.signal.aborted) logger.warn("WebGUI terminal input unavailable", { error: String(error) });
			stop();
		});
		await shutdown.promise;
	} finally {
		inputAbort.abort();
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
		const discovery = await readyDiscovery();
		if (discovery) {
			const response = await fetch(`${discovery.apiOrigin}${SHUTDOWN_PATH}`, {
				method: "POST", headers: { Authorization: `Bearer ${discovery.token}` },
				signal: AbortSignal.timeout(5_000), redirect: "error", cache: "no-store",
			});
			if (!response.ok && response.status !== 409)
				throw new Error(`Shared WebGUI shutdown failed (${response.status})`);
		}
	}
}
