import * as fs from "node:fs/promises";
import * as os from "node:os";
import { createInterface, type Interface } from "node:readline";
import { getProjectDir, normalizePathForComparison } from "@oh-my-pi/pi-utils/dirs";
import { $env } from "@oh-my-pi/pi-utils/env";
import { ensureTheme } from "@oh-my-pi/pi-tui/theme";
import { Settings } from "../config/settings";
import { createAgentSession, discoverAuthStorage, type CreateAgentSessionResult } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { RpcGoalController } from "../modes/rpc/rpc-goal";
import { AIReqWorkspace } from "../spec-driven/workspace";
import type { Args } from "../cli/args";
import { offlineFromEnv } from "../cli/args";
import { applyStartupCwd } from "../cli/startup-cwd";
import {
	COMPANY_OFFLINE_CONTEXT_WINDOW,
	COMPANY_OFFLINE_ROLE_DEFAULTS,
	setCompanyChatContextWindow,
} from "../config/company-models";
import { COMPANY_PROVIDER_ID, getCompanyConfig, setCompanyOfflineEnabled } from "../config/company-provider";
import { ModelRegistry } from "../config/model-registry";
import { disabledProviderIds } from "../config/model-resolver";
import { initializeWithSettings } from "../discovery";
import { injectPluginDirRoots, preloadPluginRoots } from "../discovery/helpers";
import { injectOmpExtensionCliRoots } from "../discovery/omp-extension-roots";
import { buildSessionOptions, resolveScopedModels, watchScopedModelSettings } from "../main";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { createAuthStorageSettingsSync } from "../session/auth-broker-config";
import { SessionManager } from "../session/session-manager";
import { cfgSessionMaxCost, cfgSessionWarnCost } from "../session/settings";
import { createPersistedSubagentReviverFactory } from "../task/persisted-revive";
import { cfgTaskAgentIdleTtlMs } from "../task/settings";
import { cfgAstEditEnabled, cfgFetchEnabled, cfgToolsApprovalMode, cfgWebSearchEnabled } from "../tools/settings";
import { cfgBrowserEnabled } from "../tools/browser/settings";
import { EventBus } from "../utils/event-bus";
import { openPathWithResult } from "../utils/open";
import { type MCPAuthHandler, MCPManager } from "../mcp/manager";
import type { MCPAuthChallenge, MCPAuthInvocation, MCPServerConfig } from "../mcp/types";
import {
	findMcpServerForAuth,
	matchingManagerServerConfig,
	MCPOAuthCancelledError,
	reauthorizeMcpServer,
} from "../mcp/oauth-reauth";
import { cfgMcpEnableProjectConfig } from "../mcp/settings";
import { acquireBrowserProject, type BrowserProjectLease } from "../webgui/project-registry";
import { readWebGuiSessionInfo } from "../webgui/session-source";
import { closeWebServer } from "../webgui/server";
import { startAIReqWorkbenchServer } from "./server";
import { AIReqWorkflowHost } from "./workflow-host";
import { nativeWebGuiQuestions } from "./native/native-interactions";

export interface AIReqWorkbenchHandle {
	url: string;
	urls: readonly string[];
	loopbackUrl: string;
	close(): Promise<void>;
}
export class AIReqWorkbenchStartError extends AggregateError {
	constructor(
		errors: readonly unknown[],
		readonly host: AIReqWorkbenchHost,
	) {
		super(errors, "AIReq host startup and settlement failed");
	}
}
const hosts = new Map<string, Promise<AIReqWorkbenchHost>>();
const services = new WeakMap<AIReqWorkbenchHost, Promise<AIReqWorkbenchHandle>>();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function createAIReqGoalController(session: AgentSession): RpcGoalController {
	return new RpcGoalController(session, undefined, "interactive");
}
interface HostInput {
	session: AgentSession;
	settings: Settings;
	cwd: string;
	projectLease: BrowserProjectLease;
	cacheKey?: string;
	ownsRoot?: boolean;
	mcpManager?: MCPManager;
	nativeMcpUiAuthHandler?: MCPAuthHandler;
	closeRootResources?: () => Promise<void>;
}
/** Owns AIReq lifecycle, not native transcripts or domain transactions. */
export class AIReqWorkbenchHost {
	readonly cwd: string;
	readonly settings: Settings;
	readonly rootSession: AgentSession;
	readonly projectLease: BrowserProjectLease;
	readonly workflow: AIReqWorkflowHost;
	readonly #input: HostInput;
	readonly #authShutdown = new AbortController();
	readonly #authWork = new Set<Promise<unknown>>();
	readonly #restoreMcpAuth: (() => void) | undefined;
	#closing: Promise<void> | undefined;
	#stopping = false;
	#service: AIReqWorkbenchHandle | undefined;
	#serviceStartup: Promise<void> | undefined;
	constructor(input: HostInput) {
		this.#input = input;
		this.cwd = input.cwd;
		this.settings = input.settings.overlay();
		this.rootSession = input.session;
		this.projectLease = input.projectLease;
		this.workflow = new AIReqWorkflowHost({
			cwd: input.cwd,
			rootSession: input.session,
			settings: this.settings,
			mcpAuth: (name, challenge, invocation) => this.handleNativeMcpAuth(name, challenge, invocation),
		});
		const manager = input.mcpManager;
		if (manager && (!manager.getAuthHandler() || manager.getAuthHandler() === input.nativeMcpUiAuthHandler)) {
			const previous = manager.getAuthHandler();
			const handler: MCPAuthHandler = (name, challenge, invocation) =>
				this.handleNativeMcpAuth(name, challenge, invocation);
			manager.setAuthHandler(handler);
			this.#restoreMcpAuth = () => {
				if (manager.getAuthHandler() === handler) manager.setAuthHandler(previous);
			};
		}
	}
	attachService(service: AIReqWorkbenchHandle): void {
		this.#service = service;
	}
	trackServiceStartup(startup: Promise<AIReqWorkbenchHandle>): void {
		this.#serviceStartup = startup.then(
			() => {},
			() => {},
		);
	}
	get stopping(): boolean {
		return this.#stopping;
	}
	handleNativeMcpAuth(
		name: string,
		challenge: MCPAuthChallenge,
		invocation?: MCPAuthInvocation,
	): Promise<MCPServerConfig | undefined> {
		const task = this.#authorizeMcp(name, challenge, invocation);
		this.#authWork.add(task);
		void task.then(
			() => this.#authWork.delete(task),
			() => this.#authWork.delete(task),
		);
		return task;
	}
	async #authorizeMcp(
		name: string,
		challenge: MCPAuthChallenge,
		invocation?: MCPAuthInvocation,
	): Promise<MCPServerConfig | undefined> {
		if (!invocation?.scope || invocation.scope === "owner" || !invocation.toolCallId)
			throw new Error("MCP authorization requires attributed native invocation identity");
		const session = await this.workflow.resolveMcpSession(invocation.scope, invocation.toolCallId);
		const candidate = session.nativeChildCapabilities?.mcpManager ?? this.#input.mcpManager;
		if (!(candidate instanceof MCPManager)) throw new Error("Native MCP manager is unavailable");
		const signal = invocation.signal
			? AbortSignal.any([invocation.signal, this.#authShutdown.signal])
			: this.#authShutdown.signal;
		const current = async () => {
			if ((await this.workflow.resolveMcpSession(invocation.scope!, invocation.toolCallId!)) !== session)
				throw new Error("Native MCP invocation owner changed");
			signal.throwIfAborted();
		};
		const ui = nativeWebGuiQuestions(this.workflow.nativeUiOwner(session)).ui;
		try {
			return await session.waitForUser(async () => {
				const cwd = session.sessionManager.getCwd();
				const found = await findMcpServerForAuth(name, cwd, candidate, {
					preferManager: true,
					enableProjectConfig: cfgMcpEnableProjectConfig.get(session.settings),
				});
				if (!found || !matchingManagerServerConfig(candidate, name, found.config))
					throw new Error("Native MCP configuration identity changed");
				await current();
				if (
					!(await ui.confirm(
						`Authorize native MCP server ${name}`,
						`OAuth may save credentials and update ${found.scope} server configuration. Continue?`,
						{ signal },
					))
				)
					return undefined;
				let url = "",
					instructions = "";
				const result = await reauthorizeMcpServer(name, found, {
					authStorage: session.modelRegistry.authStorage,
					mcpManager: candidate,
					cwd,
					authChallenge: challenge,
					signal,
					flowOwner: session,
					silent: true,
					onAuth: info => {
						url = info.url;
						instructions = info.instructions ?? "";
						ui.notify(`${url}\n${instructions}`);
					},
					onProgress: text => ui.notify(text),
					onManualCodeInput: async flowSignal => {
						const answer = await ui.input(
							`MCP ${name}: open ${url}\n${instructions}\nPaste callback URL or code`,
							undefined,
							{ signal: flowSignal ? AbortSignal.any([signal, flowSignal]) : signal, secret: true },
						);
						if (answer === undefined) throw new MCPOAuthCancelledError();
						return answer;
					},
				});
				await current();
				return result.config;
			});
		} catch (error) {
			if (error instanceof MCPOAuthCancelledError || signal.aborted) return undefined;
			throw error;
		}
	}
	close(): Promise<void> {
		this.#stopping = true;
		if (!this.#closing) {
			const pending = this.#close();
			this.#closing = pending;
			void pending.catch(() => {
				if (this.#closing === pending) this.#closing = undefined;
			});
		}
		return this.#closing;
	}
	async #close(): Promise<void> {
		await this.projectLease.markExiting();
		this.#authShutdown.abort("AIReq host is exiting");
		await this.#serviceStartup;
		await this.workflow.close();
		await Promise.all(this.#authWork);
		await this.settings.flush();
		this.#restoreMcpAuth?.();
		if (this.#input.ownsRoot) await this.rootSession.dispose();
		await this.#input.closeRootResources?.();
		await this.#service?.close();
		await this.workflow.release();
		await this.projectLease.close();
		if (this.#input.cacheKey) hosts.delete(this.#input.cacheKey);
		services.delete(this);
	}
}
export async function createAIReqWorkbenchHost(input: {
	session: AgentSession;
	settings: Settings;
	cwd: string;
	setToolUIContext?: CreateAgentSessionResult["setToolUIContext"];
	ownsRoot?: boolean;
	mcpManager?: MCPManager;
	nativeMcpUiAuthHandler?: MCPAuthHandler;
	projectLease?: BrowserProjectLease;
	closeRootResources?: () => Promise<void>;
}): Promise<AIReqWorkbenchHost> {
	if (input.session.isDisposed) throw new Error("Cannot enter AIReq mode with a disposed native root");
	const { root: cwd } = await AIReqWorkspace.resolve(input.cwd);
	const profile = await fs.realpath(input.settings.getAgentDir());
	const cacheKey = JSON.stringify([normalizePathForComparison(cwd), normalizePathForComparison(profile)]);
	let pending = hosts.get(cacheKey);
	if (!pending) {
		pending = (async () => {
			const projectLease = input.projectLease ?? (await acquireBrowserProject(cwd, "aireq"));
			let host: AIReqWorkbenchHost | undefined;
			try {
				if (
					projectLease.mode !== "aireq" ||
					normalizePathForComparison(projectLease.root) !== normalizePathForComparison(cwd)
				)
					throw new Error("Native AIReq project lease identity mismatch");
				const candidate = input.mcpManager ?? input.session.nativeChildCapabilities?.mcpManager;
				host = new AIReqWorkbenchHost({
					...input,
					cwd,
					projectLease,
					cacheKey,
					mcpManager: candidate instanceof MCPManager ? candidate : undefined,
				});
				await host.workflow.initialize();
				return host;
			} catch (error) {
				if (host)
					try {
						await host.close();
					} catch (cleanup) {
						throw new AIReqWorkbenchStartError([error, cleanup], host);
					}
				else if (!input.projectLease) {
					await projectLease.markExiting();
					await projectLease.close();
				}
				throw error;
			}
		})();
		hosts.set(cacheKey, pending);
		void pending.catch(error => {
			if (error instanceof AIReqWorkbenchStartError) hosts.set(cacheKey, Promise.resolve(error.host));
			else hosts.delete(cacheKey);
		});
	}
	const host = await pending;
	if (host.rootSession !== input.session) throw new Error("This project already has another native AIReq owner");
	if (host.stopping) throw new AIReqWorkbenchStartError([new Error("AIReq host is still exiting")], host);
	return host;
}
export function getOrStartAIReqWorkbench(
	host: AIReqWorkbenchHost,
	options?: Parameters<typeof startAIReqWorkbenchServer>[1],
): Promise<AIReqWorkbenchHandle> {
	let pending = services.get(host);
	if (!pending) {
		if (host.stopping) return Promise.reject(new AIReqWorkbenchStartError([new Error("AIReq host is exiting")], host));
		const opening = (async () => {
			const endpoint = await startAIReqWorkbenchServer(host, {
				...options,
				basePath: `/aireq/${host.projectLease.projectId}/`,
			});
			host.attachService(endpoint);
			if (host.stopping) throw new Error("AIReq host exited during listener startup");
			const allowLan = options?.offline ?? offlineFromEnv();
			await host.projectLease.activate(() => readWebGuiSessionInfo(host.rootSession), { allowLan });
			if (host.stopping) {
				await host.projectLease.markExiting();
				throw new Error("AIReq host exited during project activation");
			}
			return {
				url: endpoint.url,
				urls: endpoint.urls,
				loopbackUrl: endpoint.loopbackUrl,
				close: () => host.close(),
			};
		})();
		host.trackServiceStartup(opening);
		pending = opening.catch(async error => {
			try {
				await host.close();
			} catch (cleanup) {
				throw new AIReqWorkbenchStartError([error, cleanup], host);
			}
			throw error;
		});
		services.set(host, pending);
		void pending.catch(() => services.delete(host));
	}
	return pending;
}
export async function closeAllAIReqWorkbenches(): Promise<void> {
	const opening = await Promise.allSettled(hosts.values());
	const owned = opening.filter(result => result.status === "fulfilled").map(result => result.value);
	const results = await Promise.allSettled(owned.map(host => host.close()));
	const failed = [...opening, ...results].filter(result => result.status === "rejected");
	if (failed.length)
		throw new AggregateError(
			failed.map(result => result.reason),
			"Workbench shutdown failed",
		);
}
/** Native startup shared by the browser host; constructing it never submits a turn. */
async function createAIReqWorkbenchSession(
	parsed: Args,
	ownResource: (settle: () => Promise<void>) => void,
): Promise<{
	session: AgentSession;
	settings: Settings;
	cwd: string;
	setToolUIContext: CreateAgentSessionResult["setToolUIContext"];
	mcpManager?: MCPManager;
	ownsRoot: true;
}> {
	const cwd = getProjectDir();
	await ensureTheme();
	await setCompanyOfflineEnabled(parsed.offline === true);
	const activeSettings = await Settings.init({ cwd, configFiles: parsed.config });
	ownResource(() => activeSettings.flush());
	if (parsed.approvalMode) cfgToolsApprovalMode.override(activeSettings, parsed.approvalMode);
	else if (parsed.autoApprove) cfgToolsApprovalMode.override(activeSettings, "yolo");
	if (parsed.warnCost !== undefined) cfgSessionWarnCost.override(activeSettings, parsed.warnCost);
	if (parsed.maxCost !== undefined) cfgSessionMaxCost.override(activeSettings, parsed.maxCost);
	if (parsed.offline) {
		cfgWebSearchEnabled.override(activeSettings, false);
		cfgBrowserEnabled.override(activeSettings, false);
		cfgAstEditEnabled.override(activeSettings, false);
		cfgFetchEnabled.override(activeSettings, false);
		setCompanyChatContextWindow(COMPANY_OFFLINE_CONTEXT_WINDOW);
		if (getCompanyConfig() && !disabledProviderIds(activeSettings).has(COMPANY_PROVIDER_ID)) {
			activeSettings.setModelRoleDefaults(COMPANY_OFFLINE_ROLE_DEFAULTS);
		}
	}
	const home = os.homedir();
	if (parsed.pluginDirs?.length) await injectPluginDirRoots(home, parsed.pluginDirs, cwd, { includeClaude: false });
	else await preloadPluginRoots(home, cwd, { includeClaude: false });
	if (!parsed.trustedExtensions?.length) {
		injectOmpExtensionCliRoots([...(parsed.extensions ?? []), ...(parsed.hooks ?? [])], home, cwd, {
			mode: parsed.noExtensions ? "explicit-only" : "merge",
			replace: true,
		});
	}
	await initializeWithSettings(activeSettings);
	const smol = parsed.smol ?? $env.PI_SMOL_MODEL;
	const slow = parsed.slow ?? $env.PI_SLOW_MODEL;
	const plan = parsed.plan ?? $env.PI_PLAN_MODEL;
	if (smol || slow || plan) activeSettings.overrideModelRoles({ smol, slow, plan });
	if (parsed.noPty) Bun.env.PI_NO_PTY = "1";
	if (parsed.noTitle) Bun.env.PI_NO_TITLE = "1";
	const authStorage = await discoverAuthStorage(undefined, { settings: activeSettings });
	ownResource(async () => {
		authStorage.close();
	});
	const authSync = createAuthStorageSettingsSync(activeSettings, authStorage);
	ownResource(async () => {
		authSync.stop();
		await authSync.settled();
	});
	const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: activeSettings });
	await modelRegistry.hydrateCredentialScopedModelCaches();
	const scopedModels = await resolveScopedModels(parsed, modelRegistry, activeSettings);
	const manager = SessionManager.inMemory(cwd);
	const options = await buildSessionOptions(parsed, scopedModels, manager, modelRegistry, activeSettings);
	options.authStorage = authStorage;
	options.modelRegistry = modelRegistry;
	options.settings = activeSettings;
	options.hasUI = true;
	options.interactivePrompts = true;
	options.settingsApproval = true;
	options.deferSkillDescriptionCompression = true;
	options.eventBus = new EventBus();
	options.subagentEventBus = new EventBus();
	if (parsed.apiKey && options.model) authStorage.keys.setRuntime(options.model.provider, parsed.apiKey);
	const result = await createAgentSession(options);
	ownResource(() => result.session.dispose());
	if (parsed.apiKey && !options.model && result.session.model) {
		authStorage.keys.setRuntime(result.session.model.provider, parsed.apiKey);
	}
	watchScopedModelSettings(result.session, parsed, modelRegistry, activeSettings);
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({
			session: result.session,
			authStorage,
			modelRegistry,
			settings: activeSettings,
			enableLsp: options.enableLsp ?? true,
			eventBus: options.eventBus,
			subagentEventBus: options.subagentEventBus,
		}),
		() => Math.trunc(Number(cfgTaskAgentIdleTtlMs.get(activeSettings)) || 0),
	);
	return {
		session: result.session,
		settings: activeSettings,
		cwd,
		setToolUIContext: result.setToolUIContext,
		ownsRoot: true,
		mcpManager: result.mcpManager,
	};
}

/** Standalone native owner; the browser only subscribes to this process. */
export async function runAIReqWorkbenchCommand(parsedArgs: Args, _rawArgs: string[]): Promise<void> {
	await applyStartupCwd(parsedArgs);
	const projectLease = await acquireBrowserProject(getProjectDir(), "aireq");
	const resources: Array<() => Promise<void>> = [];
	const closeRootResources = async (): Promise<void> => {
		while (resources.length) {
			await resources[resources.length - 1]();
			resources.pop();
		}
	};
	let host: AIReqWorkbenchHost | undefined;
	let sessionReturned = false;
	let shutdown = Promise.withResolvers<void>();
	const signal = () => shutdown.resolve();
	let control: Interface | undefined;
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, signal);
	try {
		const boot = await createAIReqWorkbenchSession(parsedArgs, settle => resources.push(settle));
		sessionReturned = true;
		host = await createAIReqWorkbenchHost({ ...boot, projectLease, closeRootResources });
		const handle = await getOrStartAIReqWorkbench(host);
		control = createInterface({ input: process.stdin, terminal: false });
		control.on("line", line => {
			const command = line.trim();
			if (command === "/aireq") signal();
			else if (command)
				process.stderr.write("Standalone AIReq accepts /aireq to exit; use the browser for native conversation.\n");
		});
		for (const url of handle.urls) process.stdout.write(`AIReq workbench ready: ${url}\n`);
		if (handle.urls.length === 1 && parsedArgs.offline) {
			process.stderr.write("No non-loopback IPv4 interface was found; only the local URL is available.\n");
		}
		if (offlineFromEnv()) {
			process.stderr.write("offline 模式不自动打开浏览器；请使用上方地址访问。\n");
		} else if (process.env.OMP_AIREQ_NO_OPEN === "1") {
			process.stderr.write("Browser opener skipped (OMP_AIREQ_NO_OPEN=1); use the ready URL.\n");
		} else {
			const opened = await openPathWithResult(handle.loopbackUrl);
			if (!opened.opened)
				process.stderr.write(`Browser opener failed: ${opened.reason}. Service remains ready at ${handle.url}\n`);
		}
		await shutdown.promise;
	} catch (error) {
		if (!sessionReturned) {
			// The process-local registry retains its OS lock; no unknown SDK owner is released.
			throw new Error(
				"AIReq 原生会话启动失败，无法确认内部资源已结清；项目占用将保持到当前 OMP 进程结束。请结束此 OMP 进程后重试。",
				{ cause: error },
			);
		}
		if (error instanceof AIReqWorkbenchStartError) host = error.host;
		throw error;
	} finally {
		// A failed settlement must keep the OS lease and a live terminal retry path.
		try {
			while (sessionReturned) {
				try {
					if (host) await host.close();
					else {
						await projectLease.markExiting();
						await closeRootResources();
						await projectLease.close();
					}
					break;
				} catch (error) {
					shutdown = Promise.withResolvers<void>();
					process.stderr.write(`AIReq 尚未结清，项目占用保持；输入 /aireq 或按 Ctrl+C 重试退出：${message(error)}\n`);
					await shutdown.promise;
				}
			}
			await closeWebServer();
		} finally {
			control?.close();
			for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(name, signal);
		}
	}
}
