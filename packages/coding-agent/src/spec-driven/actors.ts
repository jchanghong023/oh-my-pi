import * as fs from "node:fs/promises";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJobManagerApi } from "../async/job-manager";
import type { Settings } from "../config/settings";
import type { ExtensionUIContext } from "../extensibility/extensions";
import { applyToolProxy } from "../extensibility/tool-proxy";
import { cfgGoalEnabled } from "../goals/settings";
import { initializeExtensions } from "../modes/runtime-init";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, type AgentRegistryApi } from "../registry/agent-registry";
import { cloneEmbeddingToolRestrictions, createAgentSession, type CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { isLocalAgentSession } from "../session/agent-session-handle";
import type { SessionManager } from "../session/session-manager";
import { ToolRestrictions } from "../session/tool-restrictions";
import { followMCPTools } from "../task/executor";
import { cfgTaskIsolationEnabled, cfgTaskSpeculativeLaunch, cfgWorktreeOnStart } from "../task/settings";
import type { NativeSubagentHooks } from "../task/types";
import { buildRunnerDeps } from "../team/controller";
import type { Tool } from "../tools";
import { resolveToolTier } from "../tools/approval";
import actorTemplate from "../prompts/agents/spec-driven.md" with { type: "text" };
import { ensureSpecDrivenResources, loadSpecDrivenSkill } from "./resources";
import {
	exposeSpecExecutionSkill,
	grantSpecExecutionSkills,
	grantSpecSkillAccess,
	inheritSpecExecutionSkills,
} from "./skill-policy";

interface SpecNativeToolBoundary {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	sessionId: string;
}

/** Recheck final native arguments, after extension transforms, at canonical dispatch. */
class SpecActorToolRestrictions extends ToolRestrictions {
	readonly #base: ToolRestrictions;
	readonly #check: (name: string, input: unknown) => Promise<void>;
	readonly #before?: (event: SpecNativeToolBoundary) => Promise<void>;
	readonly #after?: (event: SpecNativeToolBoundary & { isError: boolean }) => Promise<void>;
	readonly #readOnly: boolean;
	readonly #cache = new WeakMap<Tool, Tool>();
	#sessionId = "";
	constructor(
		base: ToolRestrictions,
		check: (name: string, input: unknown) => Promise<void>,
		before?: (event: SpecNativeToolBoundary) => Promise<void>,
		after?: (event: SpecNativeToolBoundary & { isError: boolean }) => Promise<void>,
		readOnly = false,
		options = base.snapshot(),
	) {
		super(options);
		this.#base = base;
		this.#check = check;
		this.#before = before;
		this.#after = after;
		this.#readOnly = readOnly;
	}
	override clone(): SpecActorToolRestrictions {
		return this.withReadOnly(this.#readOnly);
	}
	withReadOnly(readOnly: boolean): SpecActorToolRestrictions {
		return new SpecActorToolRestrictions(
			this.#base,
			this.#check,
			this.#before,
			this.#after,
			readOnly || this.#readOnly,
			this.snapshot(),
		);
	}
	bindSession(sessionId: string): void {
		this.#sessionId = sessionId;
	}
	override wrap<T extends Tool>(tool: T): T {
		const existing = this.#cache.get(tool);
		if (existing) return existing as T;
		const guarded = super.wrap(this.#base.wrap(tool));
		const execute = guarded.execute;
		const wrapped = {
			execute: async (...args: Parameters<Tool["execute"]>) => {
				const approval =
					typeof guarded.approval === "function" ? guarded.approval(args[1], args[4]) : guarded.approval;
				const tier = resolveToolTier({ name: tool.name, approval }, args[1], args[4]);
				// Only the canonical index-device approval carries this policy isolation
				// marker. Other read-tier write transports (including eval/resolve) do
				// not bypass the workflow's filesystem and phase-write checks.
				const readonlyIndex =
					tool.name === "write" &&
					tier === "read" &&
					typeof approval === "object" &&
					approval !== null &&
					approval.fallbackToToolPolicy === false;
				const check = () => this.#check(readonlyIndex ? "read" : tool.name, args[1]);
				if (
					this.#readOnly &&
					tier !== "read" &&
					!("mcpReadOnlyHint" in guarded && guarded.mcpReadOnlyHint === true)
				)
					throw new Error(`Native read-only child denied non-read tool: ${tool.name}`);
				await check();
				const event: SpecNativeToolBoundary = {
					toolCallId: args[0],
					toolName: tool.name,
					input: args[1] as Record<string, unknown>,
					sessionId: this.#sessionId,
				};
				if (!event.sessionId) throw new Error("Native tool owner is not registered");
				await this.#before?.(event);
				let isError = true;
				let failure: unknown;
				try {
					await check();
					const result = await execute.call(guarded, ...args);
					isError = false;
					return result;
				} catch (error) {
					failure = error;
					throw error;
				} finally {
					try {
						await this.#after?.({ ...event, isError });
					} catch (error) {
						if (isError)
							throw new AggregateError(
								[failure, error],
								"Native execution and owned-write journaling both failed",
							);
						throw error;
					}
				}
			},
			speculation: undefined,
		} as T;
		applyToolProxy(guarded, wrapped);
		this.#cache.set(tool, wrapped);
		this.#cache.set(wrapped, wrapped);
		return wrapped;
	}
}

/** Collect every registered descendant of `ownerId` through the actual agent parent chain. */
export function specDescendantAgentIds(registry: AgentRegistryApi, ownerId: string): string[] {
	const children = new Map<string, string[]>();
	for (const ref of registry.list()) {
		if (!ref.parentId) continue;
		const siblings = children.get(ref.parentId) ?? [];
		siblings.push(ref.id);
		children.set(ref.parentId, siblings);
	}
	const seen = new Set<string>([ownerId]);
	const descendants: string[] = [];
	const queue = [ownerId];
	while (queue.length) {
		const parent = queue.shift()!;
		for (const child of children.get(parent) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			descendants.push(child);
			queue.push(child);
		}
	}
	return descendants;
}

/** Wait for all jobs owned by `ownerId`, treating rejected jobs as settled and picking up late registrations. */
async function waitOwnedSettled(manager: AsyncJobManagerApi, ownerId: string): Promise<void> {
	const awaited = new Set<string>();
	for (;;) {
		const pending = manager.getUnsettledJobs().filter(job => job.ownerId === ownerId && !awaited.has(job.id));
		if (pending.length === 0) return;
		for (const job of pending) awaited.add(job.id);
		await Promise.all(pending.map(job => job.promise.catch(() => {})));
	}
}

/**
 * Cancel the actor and every descendant agent's jobs, then wait for actual settlement.
 * A task child owns its own background jobs, so the actor's exact-owner barrier alone
 * cannot stop an idle grandchild; this walks the registered parent chain instead.
 */
export async function cancelSpecDescendantJobs(
	manager: AsyncJobManagerApi,
	ownerId: string,
	registry: AgentRegistryApi = AgentRegistry.global(),
): Promise<boolean> {
	const targets = new Set<string>([ownerId]);
	for (;;) {
		for (const id of specDescendantAgentIds(registry, ownerId)) targets.add(id);
		// Native registration retains lineage even after a parent job or ref disappears.
		const jobs = manager.getUnsettledJobs();
		let discovered = true;
		while (discovered) {
			discovered = false;
			for (const [child, parent] of manager.getAgentParentLinks()) {
				if (!targets.has(parent) || targets.has(child)) continue;
				targets.add(child);
				discovered = true;
			}
		}
		for (const job of jobs) if (job.ownerId && targets.has(job.ownerId)) manager.cancel(job.id);
		await Promise.all(
			[...targets]
				.filter(id => id !== ownerId)
				.map(async id => {
					const child = registry.get(id)?.session;
					if (!child || (isLocalAgentSession(child) && child.isDisposed)) return;
					if (isLocalAgentSession(child)) {
						child.clearQueue();
						if (child.getGoalModeState()?.enabled) await child.goalRuntime.pauseGoal();
					}
					await child.abort({ clearQueuedInputs: true, strict: true, goalReason: "internal" });
				}),
		);
		for (const id of targets) await waitOwnedSettled(manager, id);
		const remaining = manager.getUnsettledJobs();
		if (
			!specDescendantAgentIds(registry, ownerId).some(id => !targets.has(id)) &&
			![...manager.getAgentParentLinks()].some(([child, parent]) => targets.has(parent) && !targets.has(child)) &&
			!remaining.some(job => job.ownerId && targets.has(job.ownerId))
		)
			return true;
	}
}

export type DevNativeInputKind = "prompt" | "native-action";

/** Dev's replacement workflow actors retain the native SDK and recursively inherit one boundary. */
export interface DevNativeActor {
	readonly id: string;
	readonly session: AgentSession;
	prompt(text: string): Promise<void>;
	runInput<T>(operation: () => Promise<T>, kind?: DevNativeInputKind): Promise<T>;
	stop(): Promise<void>;
	dispose(): Promise<void>;
}

export async function createDevNativeActor(args: {
	name: string;
	options: CreateAgentSessionOptions;
	context: string;
	check: (name: string, input: unknown) => Promise<void>;
	afterTool: () => Promise<void>;
	onSessionCreated?: (session: AgentSession) => void;
	/** Validate settled cleanup and deferred shared-workspace release without authorizing live capture. */
	afterStop?: () => Promise<void>;
	uiForSession?: (session: AgentSession) => ExtensionUIContext;
}): Promise<DevNativeActor> {
	const id = `dev-${args.name}-${crypto.randomUUID()}`;
	const registry = args.options.agentRegistry ?? AgentRegistry.global();
	const base =
		args.options.toolRestrictions ??
		cloneEmbeddingToolRestrictions(args.options.modelRegistry) ??
		new ToolRestrictions();
	const restrictions = new SpecActorToolRestrictions(base, args.check, undefined, args.afterTool);
	let closed = false;
	let stopping = false;
	let releasingDescendants = false;
	let active: Promise<void> | undefined;
	const assertOpen = () => {
		if (closed || stopping) throw new Error("Dev native actor is stopped");
	};
	// Shared-workspace children defer their result observation to lifecycle release.
	// Only after stop's real settlement barrier may that observation use cleanup
	// validation: a permanent boundary lock must still reject every live capture.
	const observeResult = () => (releasingDescendants ? (args.afterStop ?? args.afterTool) : args.afterTool)();
	const createHooks = (inheritedReadOnly = false): NativeSubagentHooks => ({
		async beforeSpawn() {
			assertOpen();
			await args.check("task", {});
			return { applyChanges: true, preserveCwd: true };
		},
		async beforeCapture() {
			await observeResult();
		},
		async afterResult() {
			await observeResult();
		},
		async configureSession(request, options) {
			assertOpen();
			const parentScope = request.session.sessionManager;
			if (!parentScope) throw new Error("Native descendant skill grants require the actual parent session scope");
			const readOnly =
				inheritedReadOnly ||
				(!!options.toolNames && !options.toolNames.some(name => name === "write" || name === "edit"));
			const childRestrictions =
				options.toolRestrictions instanceof SpecActorToolRestrictions
					? options.toolRestrictions.withReadOnly(readOnly)
					: new SpecActorToolRestrictions(
							options.toolRestrictions ?? base.clone(),
							args.check,
							undefined,
							args.afterTool,
							readOnly,
						);
			return {
				toolRestrictions: childRestrictions,
				subagentHooks: createHooks(readOnly),
				customTools: [
					...new Map(
						[...(args.options.customTools ?? []), ...(options.customTools ?? [])].map(tool => [tool.name, tool]),
					).values(),
				],
				systemPrompt: defaults => {
					const original =
						typeof options.systemPrompt === "function"
							? options.systemPrompt(defaults)
							: (options.systemPrompt ?? defaults);
					return [...(typeof original === "string" ? [original] : original), args.context];
				},
				extensionProviderOwnership: "inherited",
				deferSkillDescriptionCompression: true,
				onSessionCreated(child) {
					childRestrictions.bindSession(child.sessionId);
					child.addDisposer(inheritSpecExecutionSkills(parentScope, child.sessionManager));
				},
			};
		},
	});
	const hooks = createHooks();
	const created = await AgentRegistry.runScoped(registry, () =>
		createAgentSession({
			...args.options,
			agentId: id,
			parentTaskPrefix: id,
			expectedAgentRef: null,
			initialAgentStatus: "idle",
			bindProcessState: false,
			agentRegistry: registry,
			toolRestrictions: restrictions,
			subagentHooks: hooks,
			requireYieldTool: false,
			extensionProviderOwnership: "inherited",
			deferSkillDescriptionCompression: true,
			systemPrompt: defaults => [...defaults, prompt.render(actorTemplate, { name: args.name }), args.context],
		}),
	);
	const session = created.session;
	restrictions.bindSession(session.sessionId);
	const ref = registry.get(id);
	const unsubscribe = registry.syncSessionStatus(id, session);
	session.addDisposer(() => {
		unsubscribe();
		registry.unregister(id, ref ?? session);
	});
	try {
		if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
		args.onSessionCreated?.(session);
		const ui = args.uiForSession?.(session) ?? created.interactionUI;
		if (ui) created.setToolUIContext(ui, true, args.options.createInteractionUI);
		await initializeExtensions(session, {
			uiContext: ui,
			reportSendError: (_action, error) => {
				session.agent.abort(error.message);
			},
			reportRuntimeError: error => {
				session.agent.abort(error.error);
			},
		});
		await session.sendCustomMessage(
			{ customType: "dev-workflow-context", display: false, content: args.context },
			{ triggerTurn: false },
		);
	} catch (error) {
		await session.dispose();
		throw error;
	}
	const stop = async () => {
		if (closed) return;
		stopping = true;
		session.clearQueue();
		const descendants = session.asyncJobManager
			? cancelSpecDescendantJobs(session.asyncJobManager, id, registry)
			: Promise.resolve(true);
		if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
		await session.abort({ clearQueuedInputs: true, strict: true, goalReason: "internal" });
		if (!(await descendants)) throw new Error("Dev native descendant settlement failed");
		await active?.catch(() => {});
		await (args.afterStop ?? args.afterTool)();
	};
	const runInput = async <T>(input: () => Promise<T>, kind: DevNativeInputKind = "prompt"): Promise<T> => {
		assertOpen();
		await args.check("dev-input", {});
		assertOpen();
		// Native follow-up/steer admission keeps its own queue semantics. The live
		// owning input retains the final settlement and frozen-output barrier.
		if (active) return AgentRegistry.runScoped(registry, input);
		if (session.isStreaming) throw new Error("Native session has an input outside its Dev owner");
		let message: AssistantMessage | undefined;
		const release = session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") message = event.message;
		});
		let value: T;
		const operation = AgentRegistry.runScoped(registry, async () => {
			value = await input();
			if (session.asyncJobManager) {
				for (;;) {
					const owners = new Set([id, ...specDescendantAgentIds(registry, id)]);
					let changed = true;
					while (changed) {
						changed = false;
						for (const [child, parent] of session.asyncJobManager.getAgentParentLinks())
							if (owners.has(parent) && !owners.has(child)) {
								owners.add(child);
								changed = true;
							}
					}
					const jobs = session.asyncJobManager
						.getUnsettledJobs()
						.filter(job => job.ownerId && owners.has(job.ownerId));
					if (!jobs.length) break;
					await Promise.all(jobs.map(job => job.promise.catch(() => {})));
				}
			}
			await args.afterTool();
			if ((kind === "prompt" && !message) || message?.stopReason === "error" || message?.stopReason === "aborted")
				throw new Error(
					`Native ${args.name} did not complete successfully${message?.errorMessage ? `: ${message.errorMessage}` : ""}`,
				);
		});
		active = operation;
		try {
			await operation;
			return value!;
		} catch (error) {
			try {
				session.clearQueue();
				const cancellation = session.asyncJobManager
					? cancelSpecDescendantJobs(session.asyncJobManager, id, registry)
					: Promise.resolve(true);
				if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
				await session.abort({ clearQueuedInputs: true, strict: true, goalReason: "internal" });
				if (!(await cancellation)) throw new Error("Failed native input descendants did not settle");
				await args.afterTool();
			} catch (settlement) {
				throw new AggregateError(
					[error, settlement],
					"Native input failed and settlement or authority validation also failed",
				);
			}
			throw error;
		} finally {
			release();
			if (active === operation) active = undefined;
		}
	};
	return {
		id,
		session,
		runInput,
		async prompt(text) {
			await runInput(() =>
				session.prompt(text, { expandPromptTemplates: false, runCommands: false, throwOnDrop: true }),
			);
		},
		stop,
		async dispose() {
			if (closed) return;
			await stop();
			releasingDescendants = true;
			try {
				await AgentRegistry.runScoped(registry, async () => {
					// Completed native task children stay live for IRC/revival. Settling
					// their jobs does not release their indexed workers or session handles.
					if (ref)
						await AgentLifecycleManager.global().releaseDescendants(ref, undefined, {
							strict: true,
							dispose: { strict: true },
						});
					await session.dispose({ strict: true });
				});
			} finally {
				releasingDescendants = false;
			}
			closed = true;
		},
	};
}

/** Build replacement Dev actors from the real project root, never from copied conversation state. */
export async function devNativeSessionOptions(args: {
	root: AgentSession;
	settings: Settings;
	cwd: string;
	sessionManager: SessionManager;
	role: "requirements" | "solution" | "planner" | "executor" | "reviewer";
	createInteractionUI?: CreateAgentSessionOptions["createInteractionUI"];
}): Promise<{
	options: CreateAgentSessionOptions;
	methods: string[];
	bind(session: AgentSession): void;
	dispose(): void;
}> {
	const { root, cwd, settings, sessionManager } = args;
	if (!root.asyncJobManager || !root.loadedProjectContext)
		throw new Error("Dev requires a real native project root with loaded constraints and job ownership");
	const deps = buildRunnerDeps(root, settings, cwd);
	const capabilities = root.nativeChildCapabilities;
	const mcpManager =
		capabilities?.enableMCP !== false && !capabilities?.restrictToolNames ? capabilities?.mcpManager : undefined;
	const follower = mcpManager
		? followMCPTools(
				mcpManager,
				{ scope: sessionManager.getSessionId(), seed: capabilities?.mcpToolScope },
				new Set(capabilities?.customTools?.map(tool => tool.name)),
			)
		: undefined;
	const skillNames =
		args.role === "requirements"
			? [["jch", "jch-grill-me"] as const]
			: args.role === "planner"
				? [["superpowers", "writing-plans"] as const]
				: args.role === "executor"
					? [
							["superpowers", "using-superpowers"] as const,
							["superpowers", "subagent-driven-development"] as const,
						]
					: [];
	const methodsResources = await Promise.all(skillNames.map(([source, name]) => loadSpecDrivenSkill(source, name)));
	const resources =
		args.role === "executor"
			? await Promise.all(
					(await ensureSpecDrivenResources()).manifest.skills
						.filter(resource => resource.source === "superpowers")
						.map(resource => loadSpecDrivenSkill("superpowers", resource.name)),
				)
			: methodsResources;
	const methods = await Promise.all(methodsResources.map(resource => fs.readFile(resource.filePath, "utf8")));
	const skills = [...root.skills];
	for (const resource of resources) {
		const index = skills.findIndex(skill => skill.filePath === resource.filePath);
		if (index === -1) {
			skills.push(args.role === "executor" ? exposeSpecExecutionSkill(resource) : resource);
		} else if (args.role === "executor") {
			// Expose only this actor's clone, including resources already in the root catalog.
			skills[index] = exposeSpecExecutionSkill(skills[index]!);
		}
	}
	const executionSkills =
		args.role === "executor"
			? skills.filter(skill => resources.some(resource => resource.filePath === skill.filePath))
			: [];
	const overlay = settings.overlay();
	cfgTaskIsolationEnabled.override(overlay, false);
	cfgWorktreeOnStart.override(overlay, "off");
	cfgTaskSpeculativeLaunch.override(overlay, false);
	if (args.role === "executor") cfgGoalEnabled.override(overlay, true);
	return {
		methods,
		options: {
			...capabilities,
			cwd,
			settings: overlay,
			sessionManager,
			// An explicit model wins over native transcript recovery; inherit the
			// root selection only for a genuinely new actor history.
			model: sessionManager.getBranchView().length ? undefined : root.model,
			modelRegistry: root.modelRegistry,
			authStorage: deps.authStorage,
			agentRegistry: root.agentRegistry,
			getApiKey: deps.getApiKey,
			asyncJobManager: root.asyncJobManager,
			parentAgentId: root.getAgentId(),
			eventBus: deps.eventBus,
			subagentEventBus: deps.subagentEventBus,
			additionalDirectories: root.sessionManager.getAdditionalDirectories(),
			mcpTools:
				capabilities?.enableMCP === false || capabilities?.restrictToolNames
					? undefined
					: (follower?.proxyTools() ?? capabilities?.mcpTools),
			mcpToolScope: follower?.scope,
			extensionRoots: () => root.effectiveExtensionRoots,
			preloadedPreparedExtensions: root.preparedExtensions?.filter(prepared =>
				root.extensionRunner?.isExtensionActive(prepared.path),
			),
			extensionProviderOwnership: "inherited",
			deferSkillDescriptionCompression: true,
			skills,
			promptTemplates: [...root.promptTemplates],
			slashCommands: [...root.slashCommands],
			spawns: "*",
			createInteractionUI: args.createInteractionUI,
			interactionParentSessionId: root.sessionId,
			interactivePrompts: !!args.createInteractionUI,
			hasUI: false,
			allowRestrictedGoal: args.role === "executor",
		},
		bind(child) {
			follower?.bind(child);
			for (const skill of resources) child.addDisposer(grantSpecSkillAccess(child.sessionManager, skill));
			child.addDisposer(grantSpecExecutionSkills(child.sessionManager, executionSkills));
		},
		dispose() {
			follower?.dispose();
		},
	};
}

/** Repair writes require an explicit imperative; discussion never reopens execution. */
export function hasExplicitRepairIntent(text: string): boolean {
	const value = text.trim();
	const withoutPreservationConstraints = value.replace(
		/(^|[，,、；;\n])\s*(?:(?:不|不要)(?:改|修改|变更|改动)(?:(?:已批准|已验收)的?(?:材料|文件|内容)|公开\s*API)|without (?:changing|modifying) (?:the )?(?:(?:approved|accepted) (?:materials|files|content)|public API))\s*(?=$|[，,、；;。.!！\n])/giu,
		"$1",
	);
	if (
		/[?？]/u.test(value) ||
		/(?:需要(?:改|修改|变更|调整|修复)[^。！？?\n]*(?:哪些|什么)|会(?:影响|导致|改变)[^。！？?\n]*(?:哪些|什么|吗|么)|是否|能否|如何|怎么|为什么|为何)/u.test(
			value,
		) ||
		/(?:不要|别\s*(?:改|修改|变更|改动|修复|修正|修好|继续)|勿|禁止|无需|不(?:要|许|改|修改|修复|修正)|先解释|只(?:需|要)?(?:解释|分析|讨论)|do not|don't|never|without (?:changing|modifying|fixing)|explain (?:first|only))/iu.test(
			withoutPreservationConstraints,
		)
	)
		return false;
	return /^(?:(?:(?:could|would) you\s+)?(?:please\s+)?(?:fix|repair|correct)\b|(?:请(?:你)?(?:帮我)?\s*|帮我\s*)?(?:修复|修正|修好|改正|纠正|继续(?:实施|完成)已批准|把[^。！？?\n]{1,80}(?:修复|修正|修好)))/iu.test(
		value,
	);
}
