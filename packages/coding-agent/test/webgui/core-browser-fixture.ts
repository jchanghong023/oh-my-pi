import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Browser, Page } from "puppeteer-core";
import { build } from "../../../../vendor/zcode-frontend/node_modules/vite/dist/node/index.js";
import productionConfig from "../../../../vendor/zcode-frontend/preview/vite.config";
import { WEBGUI_RPC_PATH, WEBGUI_SERVER_INFO_PATH } from "../../../../vendor/zcode-frontend/preview/session-info";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentRegistry, createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { listSessionsReadOnly } from "../../src/session/session-listing";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";
import {
	chromiumExecutableProbeForTest,
	closeLaunchedBrowser,
	loadPuppeteer,
	systemChromiumCandidatesForTest,
} from "../../src/tools/browser/launch";
import { NativeCwdHost } from "../../src/webgui/native-cwd";
import { acquireBrowserProject, type BrowserProjectLease } from "../../src/webgui/project-registry";
import {
	resolveWebGuiProject,
	WebGuiRequestError,
	WebGuiRpcHost,
	type WebGuiSocketData,
} from "../../src/webgui/rpc-server";
import { readWebGuiSessionInfo } from "../../src/webgui/session-source";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";
import type { ControlledReply, CoreBrowserFixture, NativeBrowserCase } from "./core-browser-types";

function reportBrowserErrors(page: Page): void {
	page.on("pageerror", error => process.stderr.write(`[core-browser] ${page.url()}: ${String(error)}\n`));
	page.on("console", message => {
		if (message.type() === "error") process.stderr.write(`[core-browser] ${page.url()}: ${message.text()}\n`);
	});
	page.on("requestfailed", request =>
		process.stderr.write(`[core-browser] ${request.url()}: ${request.failure()?.errorText}\n`),
	);
}

async function installedChromium(): Promise<string> {
	const explicit = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
	for (const candidate of explicit ? [explicit] : systemChromiumCandidatesForTest()) {
		if (
			await fs.stat(candidate).then(
				value => value.isFile(),
				() => false,
			)
		) {
			if (await chromiumExecutableProbeForTest(candidate)) return candidate;
		}
	}
	throw new Error(
		explicit
			? `PUPPETEER_EXECUTABLE_PATH is not executable Chromium: ${explicit}`
			: "Core browser integration requires installed Chromium (PUPPETEER_EXECUTABLE_PATH); downloads are disabled",
	);
}

/** One build and browser for native-RPC and retained-component integration, not host security or native Workflow execution. */
export async function createCoreBrowserFixture(): Promise<CoreBrowserFixture> {
	const temp = TempDir.createSync("@pi-core-browser-");
	let rpc = new WebGuiRpcHost();
	const cases = new Set<NativeBrowserCase>();
	const componentPages = new Set<Page>();
	let browser: Browser | undefined;
	const launchAbort = new AbortController();
	let server: Bun.Server<WebGuiSocketData> | undefined;
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		const failures: unknown[] = [];
		for (const dispose of [
			...Array.from(cases, value => () => value.close()),
			...Array.from(componentPages, page => () => page.close()),
			async () => {
				rpc.dispose();
			},
			async () => {
				await server?.stop(true);
			},
			async () => {
				if (browser) await closeLaunchedBrowser(browser);
				else launchAbort.abort();
			},
			async () => {
				temp[Symbol.dispose]();
			},
		]) {
			try {
				await dispose();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length) throw new AggregateError(failures, "Core browser cleanup failed");
	};
	try {
		const outDir = temp.join("assets");
		const result = await build({
			...productionConfig,
			configFile: false,
			logLevel: "warn",
			resolve: {
				...productionConfig.resolve,
				dedupe: [...(productionConfig.resolve?.dedupe ?? []), "@dnd-kit/core", "@dnd-kit/sortable"],
			},
			oxc: { jsx: { development: false } },
			define: { ...productionConfig.define, "process.env.NODE_ENV": JSON.stringify("production") },
			build: {
				...productionConfig.build,
				outDir,
				write: true,
				cssCodeSplit: false,
				reportCompressedSize: false,
				lib: {
					entry: {
						app: path.resolve(import.meta.dir, "../../../../vendor/zcode-frontend/preview/main.tsx"),
						components: path.resolve(import.meta.dir, "fixtures/core-ui-entry.tsx"),
					},
					formats: ["es"],
				},
			},
		});
		const results = Array.isArray(result) ? result : [result];
		const output = results.flatMap(bundle => {
			if (!("output" in bundle)) throw new Error("Unexpected watch-mode frontend build output");
			return bundle.output;
		});
		const css = output.filter(asset => asset.type === "asset" && asset.fileName.endsWith(".css"));
		const compat = output.find(asset => asset.fileName.endsWith("browser-compat.js"));
		if (!compat || !css.length) throw new Error("Production frontend build omitted compatibility script or styles");
		const html = (name: string) => {
			const entry = output.find(asset => asset.type === "chunk" && asset.isEntry && asset.name === name);
			if (!entry) throw new Error(`Missing frontend entry ${name}`);
			return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/${compat.fileName}"></script>${css.map(asset => `<link rel="stylesheet" href="/${asset.fileName}">`).join("")}</head><body><div id="root" style="height:100vh"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
		};
		const appHtml = html("app");
		const componentHtml = html("components");
		server = Bun.serve<WebGuiSocketData>({
			hostname: "127.0.0.1",
			port: 0,
			websocket: {
				...rpc.websocket,
				open: socket => rpc.websocket.open?.(socket),
				message: (socket, message) => rpc.websocket.message(socket, message),
				drain: socket => rpc.websocket.drain?.(socket),
				close: (socket, code, reason) => rpc.websocket.close?.(socket, code, reason),
			},
			async fetch(request, host) {
				const url = new URL(request.url);
				try {
					if (url.pathname === WEBGUI_SERVER_INFO_PATH || url.pathname === WEBGUI_RPC_PATH) {
						const project = await resolveWebGuiProject(url);
						if (!project) return new Response("Project required", { status: 404 });
						if (url.pathname === WEBGUI_SERVER_INFO_PATH)
							return Response.json({ workspaces: [{ path: project.root }], businessAvailable: false });
						if (host.upgrade(request, { data: { kind: "webgui", project, workspacePath: project.root } })) return;
						return new Response("WebSocket required", { status: 426 });
					}
					if (url.pathname === "/" || url.pathname === "/components")
						return new Response(url.pathname === "/" ? appHtml : componentHtml, {
							headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
						});
					const filePath = path.resolve(outDir, `.${decodeURIComponent(url.pathname)}`);
					if (!filePath.startsWith(`${outDir}${path.sep}`)) return new Response(null, { status: 404 });
					const file = Bun.file(filePath);
					return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
				} catch (error) {
					if (error instanceof WebGuiRequestError) return new Response(error.message, { status: error.status });
					throw error;
				}
			},
		});
		const baseUrl = `http://127.0.0.1:${server.port}`;
		const puppeteer = await loadPuppeteer();
		// 与 Dev 浏览器夹具一致：Chrome 需要存在的独立 HOME/AppData，
		// 仅设置 userDataDir 不能修复门禁隔离环境中的默认目录判定失败。
		const browserHome = temp.join("browser-home");
		const browserAppData = path.join(browserHome, "AppData", "Roaming");
		const browserLocalData = path.join(browserHome, "AppData", "Local");
		const browserTemp = temp.join("browser-tmp");
		await Promise.all(
			[browserHome, browserAppData, browserLocalData, browserTemp].map(directory =>
				fs.mkdir(directory, { recursive: true }),
			),
		);
		browser = await puppeteer.launch({
			executablePath: await installedChromium(),
			signal: launchAbort.signal,
			// Puppeteer can replace Windows startup failures with a profile-lock error.
			// Keep Chromium's actual stderr visible alongside that exception.
			dumpio: true,
			headless: true,
			userDataDir: temp.join("chromium"),
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				WINDIR: process.env.WINDIR,
				ProgramFiles: process.env.ProgramFiles,
				HOME: browserHome,
				USERPROFILE: browserHome,
				APPDATA: browserAppData,
				LOCALAPPDATA: browserLocalData,
				TEMP: browserTemp,
				TMP: browserTemp,
			},
			args: [
				"--remote-debugging-port=0",
				"--remote-debugging-address=127.0.0.1",
				"--no-sandbox",
				"--disable-dev-shm-usage",
				"--disable-background-networking",
				"--no-first-run",
				"--no-default-browser-check",
			],
		});
		const sharedBrowser = browser;
		let nativeIndex = 0;
		return {
			browser: sharedBrowser,
			async componentPage(kind) {
				const page = await sharedBrowser.newPage();
				reportBrowserErrors(page);
				componentPages.add(page);
				page.once("close", () => componentPages.delete(page));
				page.setDefaultTimeout(20_000);
				await page.setViewport({ width: 1440, height: 1000 });
				await page.goto(`${baseUrl}/components?case=${kind}`, { waitUntil: "load" });
				return page;
			},
			async nativeCase(options = {}) {
				if (cases.size)
					throw new Error("Native browser cases must close sequentially before the history spy can be replaced");
				const cwd = temp.join(`native-${nativeIndex++}`);
				const historyDir = path.join(cwd, "history");
				await fs.mkdir(historyDir, { recursive: true });
				const auth = createInMemoryAuthStorage();
				const manager = SessionManager.create(cwd, historyDir);
				const historySpy = spyOn(SessionManager, "listAll").mockImplementation(() =>
					listSessionsReadOnly(historyDir, new FileSessionStorage()),
				);
				let session: AgentSession | undefined;
				let lease: BrowserProjectLease | undefined;
				let cwdHost: NativeCwdHost | undefined;
				let page: Page | undefined;
				let reply: ControlledReply | undefined;
				let restorePrompt: (() => void) | undefined;
				let caseClosed = false;
				let native: NativeBrowserCase | undefined;
				const closeCase = async () => {
					if (caseClosed) return;
					caseClosed = true;
					const failures: unknown[] = [];
					for (const dispose of [
						async () => {
							await page?.close();
						},
						async () => {
							rpc.dispose();
							rpc = new WebGuiRpcHost();
						},
						async () => {
							reply?.finish();
							await session?.abort();
						},
						async () => {
							if (cwdHost) await cwdHost.close();
							else await lease?.close();
						},
						async () => {
							restorePrompt?.();
							await session?.dispose();
						},
						async () => {
							await manager.close();
						},
						async () => {
							auth.close();
						},
						async () => {
							historySpy.mockRestore();
							if (native) cases.delete(native);
						},
					]) {
						try {
							await dispose();
						} catch (error) {
							failures.push(error);
						}
					}
					if (failures.length) throw new AggregateError(failures, "Native browser case cleanup failed");
				};
				try {
					const model = getTestModel("ascend");
					auth.keys.setRuntime(model.provider, "test-key");
					const skillFile = path.join(cwd, "skills", "webgui-retained-skill", "SKILL.md");
					if (options.withSkill) {
						await Bun.write(
							skillFile,
							"---\nname: webgui-retained-skill\ndescription: Retained native skill\n---\nRead-only fixture instructions.\n",
						);
					}
					({ session } = await createAgentSession({
						cwd,
						agentDir: cwd,
						sessionManager: manager,
						authStorage: auth,
						modelRegistry: new ModelRegistry(auth, path.join(cwd, "models.yml")),
						model,
						settings: Settings.isolated({
							"compaction.enabled": false,
							"async.enabled": false,
							"memory.backend": "off",
						}),
						toolNames: [],
						disableExtensionDiscovery: true,
						bindProcessState: false,
						offline: true,
						agentRegistry: new AgentRegistry(),
						skills: options.withSkill
							? [
									{
										name: "webgui-retained-skill",
										description: "Retained native skill",
										filePath: skillFile,
										baseDir: path.dirname(skillFile),
										// The file belongs to this case's isolated agentDir; settings initially show user skills.
										source: "user",
									},
								]
							: [],
						contextFiles: [],
						promptTemplates: [],
						slashCommands: [],
						rules: [],
						preloadedCustomToolPaths: [],
						enableMCP: false,
						enableLsp: false,
						taskDepth: 1,
						agentId: "SubAgent",
					}));
					const activeSession = session;
					// No accidental provider/network call is possible, even before a scenario installs its reply.
					activeSession.agent.streamFn = () => {
						throw new Error("Scenario must install a controlled reply before sending");
					};
					lease = await acquireBrowserProject(cwd, "webgui");
					cwdHost = new NativeCwdHost(activeSession, lease);
					await lease.activate(() => readWebGuiSessionInfo(activeSession), {
						allowLan: false,
						nativeSession: activeSession,
					});
					page = await sharedBrowser.newPage();
					reportBrowserErrors(page);
					page.setDefaultTimeout(20_000);
					await page.setViewport({ width: 1440, height: 1000 });
					native = {
						page,
						session: activeSession,
						url: `${baseUrl}/?project=${encodeURIComponent(lease.projectId)}`,
						async seedHistory(title, userText, assistantText, historyCwd = cwd) {
							await fs.mkdir(historyCwd, { recursive: true });
							const historical = SessionManager.create(historyCwd, historyDir);
							try {
								historical.appendMessage({ role: "user", content: userText, timestamp: Date.now() });
								historical.appendMessage(createAssistantMessage(assistantText));
								await historical.setSessionName(title, "user");
								await historical.ensureOnDisk();
								await historical.flush();
								const filePath = historical.getSessionFile();
								if (!filePath) throw new Error("History fixture did not persist its journal");
								return { sessionId: historical.getSessionId(), filePath, title, userText, assistantText };
							} finally {
								await historical.close();
							}
						},
						setReply(prefix, suffix) {
							const began = Promise.withResolvers<void>();
							const finished = Promise.withResolvers<void>();
							const barrier = Promise.withResolvers<void>();
							const mock = createMockModel({ responses: [{ content: [prefix + suffix] }] });
							activeSession.agent.streamFn = (selectedModel, context, options) => {
								const stream = new AssistantMessageEventStream();
								void (async () => {
									for await (const event of mock.stream(selectedModel, context, options)) {
										if (event.type === "start")
											stream.push({ ...event, partial: { ...event.partial, content: [] } });
										else if (event.type === "text_start")
											stream.push({
												...event,
												partial: { ...event.partial, content: [{ type: "text", text: "" }] },
											});
										else if (event.type === "text_delta") {
											stream.push({
												...event,
												delta: prefix,
												partial: { ...event.partial, content: [{ type: "text", text: prefix }] },
											});
											began.resolve();
											await barrier.promise;
											stream.push({ ...event, delta: suffix });
										} else stream.push(event);
									}
									await activeSession.waitForIdle();
									finished.resolve();
								})().catch(error => {
									stream.fail(error);
									began.reject(error);
									finished.reject(error);
								});
								return stream;
							};
							reply = { began: began.promise, finished: finished.promise, finish: () => barrier.resolve() };
							return reply;
						},
						rejectNextPrompt(reason) {
							if (restorePrompt) throw new Error("An admission rejection is already armed");
							const original = activeSession.prompt;
							const promptSpy = spyOn(activeSession, "prompt");
							restorePrompt = () => {
								promptSpy.mockRestore();
								restorePrompt = undefined;
							};
							promptSpy.mockImplementationOnce(async () => {
								restorePrompt?.();
								throw new Error(reason);
							});
							promptSpy.mockImplementation((text, options) => original.call(activeSession, text, options));
						},
						close: closeCase,
					};
					cases.add(native);
					return native;
				} catch (error) {
					await closeCase();
					throw error;
				}
			},
			close,
		};
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Core browser setup and cleanup failed", { cause: error });
		}
		throw error;
	}
}
