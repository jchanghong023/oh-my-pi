import type { Settings } from "../../config/settings";
import { cfgDisabledExtensions, cfgSkills } from "../../extensibility/settings";
import { withActiveSettings } from "../../config/settings-context";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	buildSkillPromptMessage,
	getSkillSlashCommandName,
	loadSkills,
	parseSkillInvocation,
} from "../../extensibility/skills";
import { parseGoalSubcommand } from "../../goals/state";
import { SKILL_PROMPT_MESSAGE_TYPE, type CustomMessage } from "../../session/messages";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import type { AgentSession } from "../../session/agent-session";
import type { MCPManager } from "../../mcp";
import type { PromptOptions } from "../../session/agent-session-types";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import type { RpcSlashCommandRuntime } from "../../slash-commands/types";
import { TeamConfigService } from "../../team/config";
import type { TeamConfigPreviewInput, TeamConfigSaveInput } from "../../team/config-types";
import { initializeExtensions } from "../runtime-init";
import { CommandCatalogService } from "./hosts/command-catalog";
import { GoalHost } from "./hosts/goal-host";
import { LoopHost } from "./hosts/loop-host";
import { ModelRoleService, type ModelRoleSetOptions } from "./hosts/model-roles";
import { PlanHost } from "./hosts/plan-host";
import { DECLINE_ANSWER, ZCodeInteractions } from "./interactions";
import type { ModelSelection, PendingInteraction } from "./schema";
import type { ModelExecution } from "./schema/vendor/model-execution";
import type { ToolSession } from "../../tools";

export interface ZCodeDispatchOptions extends PromptOptions {
	execution?: ModelExecution & { selection: ModelSelection; offPeakTaskId?: string };
}
export type ZCodeCustomPrompt = Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution">;
export interface ZCodeCommandHostOptions {
	output?: (text: string) => void;
	settingsChanged?: (frame: object) => void;
	run?: <T>(operation: () => T) => T;
	mcpManager?: MCPManager;
	setToolUIContext?: (
		ui: ExtensionUIContext,
		hasUI: boolean,
		createInteractionUI?: ToolSession["createInteractionUI"],
	) => void;
	submit?: (text: string, options?: ZCodeDispatchOptions) => Promise<unknown>;
	submitCustom?: (
		message: ZCodeCustomPrompt,
		options: ZCodeDispatchOptions & { queueChipText: string },
	) => Promise<unknown>;
	recordInputAdmission?: (inputId: string, sourceCommand?: PromptOptions["sourceCommand"]) => Promise<void>;
}
export interface ZCodeCommandReceipt {
	accepted: true;
	completion: Promise<void>;
}

/** Workspace capability facts without opening or leasing a conversation journal. */
export async function workspaceCatalog(cwd: string, settings: Settings) {
	return withActiveSettings(settings, async () => {
		const skillsSettings = cfgSkills.get(settings);
		const skills = await loadSkills({
			...skillsSettings,
			cwd,
			agentDir: settings.getAgentDir(),
			disabledExtensions: cfgDisabledExtensions.get(settings),
		});
		const catalog = new CommandCatalogService({ cwd });
		// Only native metadata discovery is safe here. Executable custom and extension
		// registrations are advertised by the resident session's real catalog.
		return catalog.buildCatalog({
			customCommands: [],
			skills: skills.skills,
			skillsSettings,
			sessionManager: { getCwd: () => cwd },
			setSlashCommands: () => {},
		});
	});
}

/** Direct session-affine command adapter; controllers remain the shared business owners. */
export class ZCodeCommandHost {
	readonly interactions: ZCodeInteractions;
	readonly #catalog: CommandCatalogService;
	readonly #plan: PlanHost;
	readonly #loop: LoopHost;
	readonly #goal: GoalHost;
	readonly #roles: ModelRoleService;
	readonly #operations = new Set<AbortController>();
	readonly #planTasks = new Set<Promise<void>>();
	readonly #goalPromotions = new Map<string, Promise<void>>();
	readonly #unsubscribe: () => void;
	readonly #unsubscribeQueue: () => void;
	#disposed = false;
	#initialized: Promise<void> | undefined;
	constructor(
		readonly session: AgentSession,
		readonly cwd: string,
		publishInteractions: (pending: PendingInteraction[]) => void,
		readonly options: ZCodeCommandHostOptions = {},
	) {
		this.interactions = new ZCodeInteractions(publishInteractions, text => this.#output(text));
		this.#catalog = new CommandCatalogService({ cwd, getMcpManager: () => options.mcpManager });
		this.#plan = new PlanHost(
			session,
			this.interactions.ui,
			text => this.#output(text),
			task => {
				const pending = task();
				this.#planTasks.add(pending);
				this.#background(pending.finally(() => this.#planTasks.delete(pending)));
			},
			() => this.#loop.refresh(),
			async (details, content, signal) => {
				const answer = await this.interactions.request(
					{
						kind: "userInput",
						toolName: "ExitPlanMode",
						prompt: content,
						freeText: false,
						input: { title: details.title, plan: content },
						options: [
							{ optionId: "approve", label: "Execute with current context" },
							{ optionId: "reject", label: "Keep planning" },
						],
					},
					{ signal },
				);
				// ExitPlanMode 审批复用桌面 elicitation {answers, answer_N} 内容形状(用户裁定,findings B):
				// 桌面把 approve 合成为 answer/answer_0/answers 里的 "approve" 值提交,
				// 不能只认顶层 optionId === "approve"。
				const record = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : undefined;
				const carriesApprove = (value: unknown): boolean =>
					value === "approve" || (Array.isArray(value) && value.includes("approve"));
				if (record) {
					if (record.optionId === "approve" || carriesApprove(record.answer) || carriesApprove(record.answer_0))
						return true;
					const answers =
						record.answers && typeof record.answers === "object" && !Array.isArray(record.answers)
							? (record.answers as Record<string, unknown>)
							: undefined;
					if (answers && Object.values(answers).some(carriesApprove)) return true;
				}
				// 显式拒绝:CLI 自有 options 的 reject,或桌面 decline(Escape dismiss)。
				if (record?.optionId === "reject" || answer === DECLINE_ANSWER) return false;
				// 空 {answers:{}} / 取消不再误判为拒绝(用户裁定,findings B):按取消处理,
				// 交由上层 guard 归为 cancelled,不触发 onReviewRejected 的拒绝路径。
				throw new DOMException("Plan approval was cancelled", "AbortError");
			},
		);
		this.#loop = new LoopHost(session, {
			output: text => this.#output(text),
			submit: async (text, current) => {
				if (!this.#disposed && current()) await this.#submit(text);
			},
			reset: async current => {
				if (this.#disposed || !current()) return false;
				await this.#goal.beginSessionChange();
				await this.#plan.beginSessionChange();
				let changed = false;
				try {
					// Reset model context on the same authoritative journal; never remap the Host's session identity.
					if (current()) changed = (await session.resetSessionContext()) !== undefined;
					return changed;
				} finally {
					await this.#plan.endSessionChange();
					await this.#goal.endSessionChange({ detachedRun: changed });
				}
			},
			onContinuationDropped: () => this.#goal.refresh(),
			continuationAllowed: () => !this.#disposed && !this.#plan.reviewPending,
		});
		this.#goal = new GoalHost(
			session,
			undefined,
			() => !this.#disposed && !this.#loop.enabled,
			() => this.#plan.assertCanEnterGoal(),
		);
		this.#roles = new ModelRoleService({
			getSettings: () => session.settings,
			getModelRegistry: () => session.modelRegistry,
			emit: frame => {
				if (!this.#disposed) this.options.settingsChanged?.(frame);
			},
			reloadSessionSettings: async () => {
				await session.settings.reloadFromDisk();
				if (!this.#disposed) await this.#plan.refreshModelRole();
			},
		});
		this.#unsubscribe = session.subscribe(event =>
			this.#run(() => {
				if (this.#disposed) return;
				if (event.type === "session_abort") this.interactions.cancel();
				this.#goal.observe(event);
				this.#loop.observe(event);
				this.#plan.observe(event);
			}),
		);
		this.#unsubscribeQueue = session.agent.addBeforeQueuedMessageDequeueHook(signal =>
			this.#run(() => this.#promoteGoalCommand(signal)),
		);
	}
	#run<T>(operation: () => T): T {
		return this.options.run ? this.options.run(operation) : operation();
	}
	#output(text: string): void {
		if (!this.#disposed) this.options.output?.(text);
	}
	#background(task: Promise<unknown>): void {
		void task.catch(error => {
			if (!(error instanceof Error && error.name === "AbortError")) this.#output(String(error));
		});
	}
	/** Explicit promotion shares native Goal dispatch with the dequeue hook, without draining siblings. */
	promoteQueuedGoal(inputId: string): Promise<void> {
		return this.#run(() => this.#promoteGoalCommand(undefined, inputId));
	}
	async #promoteGoalCommand(signal?: AbortSignal, inputId?: string): Promise<void> {
		const steering = this.session.agent.peekSteeringQueue();
		const candidates = inputId
			? this.session.getQueuedInputMessages().filter(message => "inputId" in message && message.inputId === inputId)
			: steering.length
				? steering
				: this.session.getQueuedInputMessages().slice(0, 1);
		for (const message of candidates) {
			if (this.#disposed || signal?.aborted) return;
			if (message.role !== "user" || !message.inputId) continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(block => block.type === "text")
							.map(block => block.text)
							.join("\n");
			if (!/^\/goal(?:-autopilot)?(?:\s|$)/.test(text)) continue;
			// Keep the input in its owner's queue throughout asynchronous controller work.
			// Stop can therefore hold it even while the shared controller is awaiting a hook.
			let pending = this.#goalPromotions.get(message.inputId);
			if (!pending) {
				pending = (async () => {
					const receipt = await this.#dispatch(
						text,
						{
							inputId: message.inputId,
							inputClientId: message.inputClientId,
							sourceCommand: message.sourceCommand,
							attachments: message.attachments,
							toolDenylist: message.toolDenylist,
						},
						true,
					);
					await receipt.completion;
				})();
				this.#goalPromotions.set(message.inputId, pending);
			}
			try {
				await pending;
			} finally {
				if (this.#goalPromotions.get(message.inputId) === pending) this.#goalPromotions.delete(message.inputId);
			}
		}
	}
	initialize(): Promise<void> {
		return (this.#initialized ??= this.#run(async () => {
			this.options.setToolUIContext?.(this.interactions.ui, true, this.interactions.createSubagentUI);
			await initializeExtensions(this.session, {
				mode: "rpc",
				uiContext: this.interactions.ui,
				reportSendError: (_action, error) => this.#output(error.message),
				reportRuntimeError: error => this.#output(error.error),
				onShutdown: () => this.cancel(),
			});
			await this.#goal.reconcile();
			await this.#goal.settled();
			await this.#plan.reconcile();
		}));
	}
	catalog() {
		return this.#run(() => this.#catalog.buildCatalog(this.session));
	}
	complete(text: string, cursor: number) {
		return this.#run(() => this.#catalog.complete({ text, cursor, session: this.session }));
	}
	async #submit(
		text: string,
		options: ZCodeDispatchOptions = {},
		admit?: () => void,
		fail?: (error: unknown) => void,
	): Promise<void> {
		if (this.#disposed) throw new Error("Session command host is closed");
		// Skill invocations use the same builder and custom-message business path as native hosts.
		const invocation = parseSkillInvocation(text);
		const skill =
			invocation &&
			this.session.skills.find(candidate => getSkillSlashCommandName(candidate) === `skill:${invocation.name}`);
		if (skill && invocation && this.session.skillsSettings?.enableSkillCommands) {
			const built = await buildSkillPromptMessage(skill, invocation, "user");
			const message: ZCodeCustomPrompt = {
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: options.images?.length
					? [{ type: "text", text: built.message }, ...options.images]
					: built.message,
				display: true,
				details: built.details,
				attribution: "user",
			};
			if (this.options.submitCustom) {
				await this.options.submitCustom(message, { ...options, queueChipText: text });
				admit?.();
				return;
			}
			if (options.execution) throw new Error("Custom prompt execution requires an execution-aware session host");
			let admission: Promise<void> | undefined;
			await this.session.promptCustomMessage(message, {
				streamingBehavior: options.streamingBehavior,
				queueChipText: text,
				inputId: options.inputId,
				sourceCommand: options.sourceCommand,
				inputClientId: options.inputClientId,
				onPromptAdmitted: () => {
					if (options.inputId && this.options.recordInputAdmission) {
						admission = this.options.recordInputAdmission(options.inputId, options.sourceCommand);
						this.#background(admission);
						void admission.then(
							() => {
								options.onPromptAdmitted?.();
								admit?.();
							},
							error => fail?.(error),
						);
					} else {
						options.onPromptAdmitted?.();
						admit?.();
					}
				},
				goalAutoOrchestrateInitialId: options.goalAutoOrchestrateInitialId,
			});
			await admission;
			return;
		}
		if (this.options.submit) {
			await this.options.submit(text, options);
			admit?.();
			return;
		}
		await this.session.prompt(text, {
			...options,
			onPromptAdmitted: () => {
				options.onPromptAdmitted?.();
				admit?.();
			},
		});
	}
	dispatch(text: string, options: ZCodeDispatchOptions = {}): Promise<ZCodeCommandReceipt> {
		return this.#run(() => this.#dispatch(text, options));
	}
	async #dispatch(text: string, options: ZCodeDispatchOptions, promoting = false): Promise<ZCodeCommandReceipt> {
		if (this.#disposed) throw new Error("Session command host is closed");
		// /move、/wt(别名 /worktree)的 headless handle 会 setProjectDir → process.chdir
		// (slash-commands/builtin-lifecycle.ts → utils/dirs.ts)改整个进程 cwd,违反同
		// 进程多会话禁令;app-server(zcode 模式)在 dispatch 层直接拒绝,仅 TUI 可用。
		if (/^\/(?:move|wt|worktree)(?:\s|$)/.test(text))
			throw Object.assign(new Error("/move、/wt 仅 TUI 可用"), { code: "unsupported" });
		const resolved = await this.#catalog.resolve(text, this.session);
		if (resolved.kind === "builtin" && !resolved.spec?.handleRpc && !resolved.spec?.handle)
			throw Object.assign(new Error(`/${resolved.name} requires a terminal UI`), { code: "unsupported" });
		// A recognized command with invalid arguments must never become model prose.
		if (resolved.kind === "unknown" && text.startsWith("/")) {
			const token = text.slice(1).split(/\s/, 1)[0];
			const known = (await this.catalog()).find(
				command => command.name === token || command.aliases?.includes(token ?? ""),
			);
			if (known) throw Object.assign(new Error(`Invalid arguments for /${token}`), { code: "invalid_params" });
		}
		const command = parseSlashCommand(text);
		const goalSubcommand =
			resolved.kind === "builtin" && command && (resolved.name === "goal" || resolved.name === "goal-autopilot")
				? parseGoalSubcommand(command.args).sub
				: undefined;
		if (
			!promoting &&
			(this.session.isStreaming || this.session.isCompacting) &&
			goalSubcommand !== "pause" &&
			goalSubcommand !== "resume" &&
			/^\/goal(?:-autopilot)?(?:\s|$)/.test(text)
		) {
			// 创建／替换仍由原生队列接纳；pause/resume 若排在运行中目标之后便无法及时控制。
			// 控制继续走下方同一控制器及 generation／取消边界，不另建目标状态。
			await this.#submit(text, {
				...options,
				queueOnly: true,
				streamingBehavior: options.streamingBehavior ?? "followUp",
			});
			return { accepted: true, completion: Promise.resolve() };
		}
		const operation = new AbortController();
		const generation = this.session.sessionGeneration;
		this.#operations.add(operation);
		const current = () =>
			!this.#disposed && !operation.signal.aborted && generation === this.session.sessionGeneration;
		const background: Promise<void>[] = [];
		const { promise: admitted, resolve: admit, reject: rejectAdmission } = Promise.withResolvers<void>();
		operation.signal.addEventListener(
			"abort",
			() => rejectAdmission(new DOMException("Command cancelled", "AbortError")),
			{ once: true },
		);
		const completion = (async () => {
			try {
				await this.initialize();
				if (!current()) throw new DOMException("Command cancelled", "AbortError");
				if (resolved.kind !== "builtin" || !resolved.spec) {
					this.#loop.capturePrompt(text);
					await this.#submit(text, options, admit, rejectAdmission);
					return;
				}
				const runtime: RpcSlashCommandRuntime = {
					session: this.session,
					sessionManager: this.session.sessionManager,
					settings: this.session.settings,
					cwd: this.cwd,
					signal: operation.signal,
					ui: {
						select: async (...args) => {
							const answer = this.interactions.ui.select(...args);
							admit();
							return answer;
						},
						confirm: async (...args) => {
							const answer = this.interactions.ui.confirm(...args);
							admit();
							return answer;
						},
						input: async (...args) => {
							const answer = this.interactions.ui.input(...args);
							admit();
							return answer;
						},
					},
					output: message => {
						if (current()) this.#output(message);
					},
					refreshCommands: async () => {
						await this.catalog();
					},
					reloadPlugins: async () => {
						const projectPath = await resolveActiveProjectRegistryPath(this.cwd);
						clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
						await this.session.refreshSkillsAndCommands();
						await this.catalog();
					},
					setModel: async model => {
						if (current()) await this.session.setModelTemporary(model);
					},
					runCommandInBackground: task => {
						if (current()) {
							const pending = task();
							background.push(pending);
							this.#background(pending);
							admit();
						}
					},
					runModeCommand: async (mode, args) => {
						if (!current()) return;
						if (mode === "plan") return this.#plan.handle(args, operation.signal);
						if (mode === "loop") {
							const result = await this.#loop.handle(args);
							this.#goal.refresh();
							return result;
						}
						return this.#goal.handleSlash(args, runtime, { autoOrchestrate: mode === "goal-autopilot" });
					},
				};
				if (!command) throw new Error("Invalid slash command");
				const result = resolved.spec.handleRpc
					? await resolved.spec.handleRpc(command, runtime)
					: await resolved.spec.handle?.(command, runtime);
				if (current() && result && "prompt" in result) {
					this.#loop.capturePrompt(result.prompt);
					if (promoting && options.inputId) {
						if (
							!this.session.mutateQueuedInput(options.inputId, "edit", {
								text: result.prompt,
								goalAutoOrchestrateInitialId: result.goalAutoOrchestrateInitialId,
							})
						)
							throw new Error("Goal input was removed before native dequeue");
						admit();
					} else {
						await this.#submit(
							result.prompt,
							{ ...options, goalAutoOrchestrateInitialId: result.goalAutoOrchestrateInitialId },
							admit,
							rejectAdmission,
						);
					}
				} else if (current()) {
					if (promoting && options.inputId) this.session.mutateQueuedInput(options.inputId, "delete");
					admit();
				}
			} finally {
				await Promise.allSettled(background);
				this.#operations.delete(operation);
			}
		})();
		// Failure before runtime/handler admission rejects the receipt, never reports accepted.
		void completion.then(() => rejectAdmission(new Error("Command was not admitted")), rejectAdmission);
		this.#background(completion);
		await admitted;
		return { accepted: true, completion };
	}
	resolveInteraction(id: string, response: unknown): boolean {
		return this.#run(() => this.interactions.resolve(id, response));
	}
	configure(operation: string, params: Record<string, unknown> = {}): Promise<unknown> {
		return this.#run(() => this.#configure(operation, params));
	}
	async #configure(operation: string, params: Record<string, unknown>): Promise<unknown> {
		if (this.#disposed) throw new Error("Session command host is closed");
		const model = this.session.model;
		const team = new TeamConfigService({
			getSettings: () => this.session.settings,
			getModelRegistry: () => this.session.modelRegistry,
			getSessionModel: () => model,
			isCurrent: () => !this.#disposed,
			emit: frame => {
				if (!this.#disposed) this.options.settingsChanged?.(frame);
			},
		});
		switch (operation) {
			case "get_model_roles":
			case "get_role_model_config":
				return this.#roles.listRoles({
					roleId: typeof params.roleId === "string" ? params.roleId : undefined,
					sessionModel: model ? { provider: model.provider, modelId: model.id } : undefined,
				});
			case "set_model_role":
			case "set_role_model":
				return this.#roles.setRole(params as unknown as ModelRoleSetOptions);
			case "get_team_config":
				return team.getConfig(params.preview as TeamConfigPreviewInput | undefined);
			case "get_team_models":
				return team.getModels(typeof params.query === "string" ? params.query : undefined);
			case "set_team_config":
				return team.setConfig({
					scope: params.scope,
					expectedRevision: params.expectedRevision,
					members: params.members,
				} as TeamConfigSaveInput);
			case "get_available_models":
				return { models: this.session.modelRegistry.getAvailable() };
			case "set_model": {
				const target = this.session.modelRegistry
					.getAvailable()
					.find(candidate => candidate.provider === params.provider && candidate.id === params.modelId);
				if (!target) throw Object.assign(new Error("Model is unavailable"), { code: "invalid_params" });
				await this.session.setModelTemporary(target);
				return { model: { provider: target.provider, modelId: target.id } };
			}
			default:
				throw Object.assign(new Error(`Unknown configuration operation: ${operation}`), { code: "unsupported" });
		}
	}
	/** UI mode control delegates to the same planning lifecycle as /plan. */
	setPlanEnabled(enabled: boolean, atInputBoundary = false, signal?: AbortSignal): Promise<void> {
		return this.#run(async () => {
			if (this.#disposed) throw new Error("Session command host is closed");
			signal?.throwIfAborted();
			await this.initialize();
			const paused = this.session.sessionManager.buildSessionContext().mode === "plan_paused";
			if (!!this.session.getPlanModeState()?.enabled === enabled && !paused) return;
			await this.#plan.handle("", signal, atInputBoundary);
			if (paused && enabled) await this.#plan.handle("", signal, atInputBoundary);
			for (const task of this.#planTasks) await task;
			await this.#plan.settled();
			signal?.throwIfAborted();
			if (!!this.session.getPlanModeState()?.enabled !== enabled)
				throw Object.assign(new Error("Plan mode change was cancelled"), { code: "execution_failed" });
		});
	}
	config(operation: string, params: Record<string, unknown> = {}) {
		return this.configure(operation, params);
	}
	cancel(): void {
		this.#run(() => this.#cancel());
	}
	#cancel(): void {
		for (const operation of this.#operations) operation.abort();
		this.#operations.clear();
		this.interactions.cancel();
		this.#plan.cancel();
		this.#loop.pause();
		this.#goal.stopForHostAbort();
	}
	dispose(): void {
		this.#run(() => {
			this.#cancel();
			this.#disposed = true;
			this.#loop.clear();
			this.interactions.dispose();
			this.#unsubscribe();
			this.#unsubscribeQueue();
		});
	}
}
