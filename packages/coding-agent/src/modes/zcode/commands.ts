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
import { assertDevCommandAllowed, assertDevModeActivationAllowed } from "../../slash-commands/builtin-spec-driven";
import { peekSpecDrivenController } from "../../spec-driven/controller";
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
	/** Recheck owner-bound native controls after asynchronous command preparation. */
	validateBeforeDispatch?: (text: string) => void;
}
export type ZCodeCustomPrompt = Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution">;
export interface ZCodeCommandHostOptions {
	output?: (text: string) => void | Promise<void>;
	settingsChanged?: (frame: object) => void;
	run?: <T>(operation: () => T) => T;
	mcpManager?: MCPManager;
	/** Native Tan adapter; execution remains owned by TanCommandController. */
	startTan?: (work: string) => Promise<{ jobId: string }>;
	resourcesReloaded?: () => Promise<void>;
	/** Native child UI already allocated under its parent's interaction owner. */
	uiContext?: ExtensionUIContext;
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
		cwd: string,
		publishInteractions: (pending: PendingInteraction[]) => void,
		readonly options: ZCodeCommandHostOptions = {},
	) {
		this.interactions = new ZCodeInteractions(publishInteractions, text => this.#output(text));
		this.#catalog = new CommandCatalogService({ cwd, getMcpManager: () => options.mcpManager });
		this.#plan = new PlanHost(
			session,
			options.uiContext ?? this.interactions.ui,
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
	/** Native SessionManager is the sole cwd owner, including relocation rollback. */
	get cwd(): string {
		return this.session.sessionManager.getCwd();
	}
	#run<T>(operation: () => T): T {
		return this.options.run ? this.options.run(operation) : operation();
	}
	#output(text: string): void | Promise<void> {
		if (!this.#disposed) return this.options.output?.(text);
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
			// actor 的 SDK 已绑定父 owner；重新绑定本地 interactions 会把 ask 错投到 actor 新任务。
			if (!this.options.uiContext)
				this.options.setToolUIContext?.(this.interactions.ui, true, this.interactions.createSubagentUI);
			await initializeExtensions(this.session, {
				mode: "rpc",
				uiContext: this.options.uiContext ?? this.interactions.ui,
				reportSendError: (_action, error) => this.#output(error.message),
				reportRuntimeError: error => this.#output(error.error),
				onShutdown: () => this.cancel(),
			});
			await this.#goal.reconcile();
			await this.#goal.settled();
			await this.#plan.reconcile();
		}));
	}
	async catalog() {
		const catalog = await this.#run(() => this.#catalog.buildCatalog(this.session));
		return catalog.map(command =>
			command.name === "tan" && this.options.startTan
				? { ...command, execution: "omp" as const, availability: { available: true as const } }
				: command,
		);
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
		// 所有普通模型／Skill 派发共用同一模式门禁，后台继续也不能绕过。
		assertDevCommandAllowed(
			this.session,
			parseSlashCommand(text)?.name ?? "ordinary-agent",
			parseSlashCommand(text)?.args,
		);
		// Skill invocations use the same builder and custom-message business path as native hosts.
		const invocation = parseSkillInvocation(text);
		const skill =
			invocation &&
			this.session.skills.find(candidate => getSkillSlashCommandName(candidate) === `skill:${invocation.name}`);
		if (skill && invocation && this.session.skillsSettings?.enableSkillCommands) {
			const built = await buildSkillPromptMessage(skill, invocation, "user", {
				scope: this.session.sessionManager,
				getSessionBranch: () => this.session.sessionManager.getBranch(),
			});
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
		const parsed = parseSlashCommand(text);
		const native = peekSpecDrivenController(this.session.sessionManager);
		if (native?.inputMode() === "dev" && !parsed && text.startsWith("/"))
			throw new Error("协同开发模式拒绝无效命令；请使用 /dev help。");
		if (native?.inputMode() === "dev" && !parsed) {
			options.validateBeforeDispatch?.(text);
			const receipt = await native.submitText(text);
			await this.#output(
				receipt.kind === "draft"
					? "已保留协同开发草稿；尚未交给 Agent。使用 /dev help 查看操作。"
					: `消息已排队，尚未代表 Agent 已接收：${receipt.messageId}`,
			);
			if (options.inputId) await this.options.recordInputAdmission?.(options.inputId, options.sourceCommand);
			options.onPromptAdmitted?.();
			return { accepted: true, completion: Promise.resolve() };
		}
		if (parsed) assertDevCommandAllowed(this.session, parsed.name, parsed.args);
		const resolved = await this.#catalog.resolve(text, this.session);
		if (native?.inputMode() === "dev" && resolved.kind !== "builtin")
			throw Object.assign(new Error("协同开发模式拒绝未知命令或非本地入口；请先输入 /dev 返回普通聊天。"), {
				code: "invalid_params",
			});
		// /tan 是运行中父会话的独立控制入口；必须先于 TUI-only 判定和 prompt admission。
		if (resolved.kind === "builtin" && resolved.name === "tan" && this.options.startTan) {
			const command = parseSlashCommand(text);
			const job = await this.options.startTan(command?.args ?? "");
			if (options.inputId) {
				await this.options.recordInputAdmission?.(options.inputId, options.sourceCommand);
				// Tan 不经过 user-row promotion；把已完成派发和本次 admission 精确关联供冷恢复使用。
				await this.session.sessionManager.appendEntriesAtomically(() =>
					this.session.sessionManager.appendCustomEntry("zcode_tan_admission", {
						inputId: options.inputId,
						sourceCommand: options.sourceCommand,
						jobId: job.jobId,
					}),
				);
			}
			options.onPromptAdmitted?.();
			return { accepted: true, completion: Promise.resolve() };
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
				if (resolved.kind === "builtin" && !resolved.spec?.handleRpc && !resolved.spec?.handle)
					throw Object.assign(new Error(`/${resolved.name} requires a terminal UI`), { code: "unsupported" });
				// resolve 的 unknown 也包含原生扩展/自定义命令；只能拒绝 builtin 的非法参数，
				// 其余已注册入口必须保留原文交给 session.prompt 的原生解析与执行链。
				if (resolved.kind === "unknown" && text.startsWith("/")) {
					const token = parseSlashCommand(text)?.name;
					const known = (await this.catalog()).find(
						command => command.name === token || command.aliases?.includes(token ?? ""),
					);
					if (known?.source === "builtin")
						throw Object.assign(new Error(`Invalid arguments for /${token}`), { code: "invalid_params" });
				}
				// /dev 的模式、草稿、帮助和控制操作不得初始化外层 Agent 或扩展。
				if (resolved.kind !== "builtin" || resolved.name !== "dev") await this.initialize();
				if (!current()) throw new DOMException("Command cancelled", "AbortError");
				options.validateBeforeDispatch?.(text);
				if (command) assertDevCommandAllowed(this.session, command.name, command.args);
				if (resolved.kind !== "builtin" || !resolved.spec) {
					this.#loop.capturePrompt(text);
					await this.#submit(text, options, admit, rejectAdmission);
					return;
				}
				let lastOutput: string | undefined;
				const runtime: RpcSlashCommandRuntime = {
					session: this.session,
					sessionManager: this.session.sessionManager,
					settings: this.session.settings,
					mcpManager: this.options.mcpManager,
					get cwd(): string {
						return runtime.sessionManager.getCwd();
					},
					rebindCwd: () => {
						// 原生工具与 ExtensionContext 已从 manager 取实时 cwd；只刷新本会话仓库资源。
						this.session.refreshRepoLifecycle();
					},
					signal: operation.signal,
					assertCanActivateMode: mode => assertDevModeActivationAllowed(this.session, mode),
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
						lastOutput = message;
						if (current()) return this.#output(message);
					},
					refreshCommands: async () => {
						await this.catalog();
					},
					reloadPlugins: async () => {
						const projectPath = await resolveActiveProjectRegistryPath(this.cwd);
						clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
						await this.session.refreshSkillsAndCommands();
						await this.catalog();
						// /move、/wt 的 rebindCwd 尚未刷新原生资源；最终 reload 完成后才能重建引用目录。
						if (current()) await this.options.resourcesReloaded?.();
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
						if (mode === "plan" || mode === "goal" || mode === "goal-autopilot")
							assertDevModeActivationAllowed(this.session, mode === "plan" ? "plan" : "goal");
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
				// usage() 已输出原生诊断并标记 failed；不能把 consumed 误记为执行成功。
				if (result && "failed" in result && result.failed) {
					throw Object.assign(new Error(lastOutput ?? `/${resolved.name} failed`), {
						code: result.errorCode ?? "execution_failed",
					});
				}
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
			} catch (error) {
				// 拒绝若在 completion 外抛出，桌面只能收到通用发送失败，所属会话没有诊断。
				// 复用 native output 并等待落盘；仍抛出原错误，绝不能把拒绝记成 admission。
				if (current() && !(error instanceof Error && error.name === "AbortError")) {
					await this.#output(String(error));
				}
				throw error;
			} finally {
				await Promise.allSettled(background);
				this.#operations.delete(operation);
			}
		})();
		// Failure before runtime/handler admission rejects the receipt, never reports accepted.
		void completion.then(() => rejectAdmission(new Error("Command was not admitted")), rejectAdmission);
		void completion.catch(() => {});
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
				return this.#roles.listRoles({
					roleId: typeof params.roleId === "string" ? params.roleId : undefined,
					sessionModel: model ? { provider: model.provider, modelId: model.id } : undefined,
				});
			case "set_model_role":
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
			default:
				throw Object.assign(new Error(`Unknown configuration operation: ${operation}`), { code: "unsupported" });
		}
	}
	/** UI mode control delegates to the same planning lifecycle as /plan. */
	setPlanEnabled(enabled: boolean, atInputBoundary = false, signal?: AbortSignal): Promise<void> {
		return this.#run(async () => {
			if (this.#disposed) throw new Error("Session command host is closed");
			signal?.throwIfAborted();
			if (enabled) assertDevModeActivationAllowed(this.session, "plan");
			await this.initialize();
			if (enabled) assertDevModeActivationAllowed(this.session, "plan");
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
