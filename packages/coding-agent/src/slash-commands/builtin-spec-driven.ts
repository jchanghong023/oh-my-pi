import type { AgentSession } from "../session/agent-session";
import { getSpecDrivenController, peekSpecDrivenController } from "../spec-driven/controller";
import { roleLabel, stageForPhase, stageLabel } from "../spec-driven/stages";
import { reloadTuiPluginState } from "./builtin-marketplace";
import { clearSubmittedText } from "./helpers/draft";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec } from "./types";

const usages = [
	["help", "", "打开当前原生操作界面，不切换输入模式"],
	["start", "<change-id> <request>", "开始新流程，澄清需求并起草规格"],
	["status", "", "查看当前阶段、材料和准确的下一步命令"],
	["answer", "<text>", "回答当前澄清问题"],
	["cancel-message", "<message-id>", "停止指定消息处理，保留已有文件，不取消流程"],
	["confirm-spec", "<version>", "确认需求并进入方案"],
	["choose", "<run-id> <candidate-id> <candidate-version>", "选择此方案并编写计划"],
	["confirm-plan", "<version> [--goal]", "批准计划并开始执行，可选 Goal；授权本任务本地 commit"],
	["accept", "<acceptance-version>", "最终验收当前交付版本"],
	["repair", "<acceptance-version> <text>", "撤销本轮验收资格，返回获批范围内执行并修复"],
	["amend", "<text>", "修改需求，撤销受影响下游批准"],
	["change-solution", "<reason>", "重新讨论核心方案，撤销相关下游批准"],
	["pause", "", "暂停并停止后续派发"],
	["resume", "", "继续本进程内的暂停流程，不自动发送草稿"],
	["cancel", "", "停止当前工作，保留已有文件并取消流程"],
] as const;

type DevUi = NonNullable<SlashCommandRuntime["ui"]> & {
	editor?: (title: string, prefill?: string, dialogOptions?: { signal?: AbortSignal }) => Promise<string | undefined>;
};
type DevHost = Omit<SlashCommandRuntime, "ui"> & {
	ui?: DevUi;
	persist?: (text: string) => Promise<void> | void;
};

async function emitReference(host: DevHost, text: string): Promise<void> {
	if (host.persist) await host.persist(text);
	else await host.output(text);
}

/** Shared policy for local commands; never infer safety from an unknown command's text. */

const LOCAL_ARGUMENT_FREE_COMMANDS: Record<string, true | undefined> = {
	new: true,
	clear: true,
	settings: true,
	status: true,
	extensions: true,
	context: true,
};
export function assertDevCommandAllowed(session: AgentSession, name: string, args = ""): void {
	if (peekSpecDrivenController(session.sessionManager)?.inputMode() !== "dev" || name === "dev") return;
	if (LOCAL_ARGUMENT_FREE_COMMANDS[name] === true && !args.trim()) return;
	if (["display", "model", "models", "switch"].includes(name)) return;
	throw Object.assign(
		new Error(`协同开发模式不能执行 /${name}；请先输入 /dev 返回普通聊天。未知命令不会转交 Agent。`),
		{ code: "invalid_params" },
	);
}

/** Checks only real native state; hosts additionally check their pending UI activation. */
export function assertDevModeActivationAllowed(session: AgentSession, mode: "dev" | "plan" | "goal" | "vibe"): void {
	if (mode !== "dev") {
		if (peekSpecDrivenController(session.sessionManager)?.inputMode() === "dev")
			throw Object.assign(new Error(`请先输入 /dev 返回普通聊天，再启用 ${mode} 模式。`), {
				code: "invalid_params",
			});
		return;
	}
	const contextMode = session.sessionManager.buildSessionContext().mode;
	const goal = session.getGoalModeState();
	if (
		session.getPlanModeState()?.enabled ||
		goal?.enabled ||
		goal?.goal.status === "paused" ||
		session.getVibeModeState()?.enabled ||
		contextMode === "plan_paused" ||
		contextMode === "goal_paused"
	)
		throw Object.assign(new Error("请先退出 Plan、Goal 或 Vibe 模式，再进入协同开发模式；现有模式保持不变。"), {
			code: "invalid_params",
		});
}

function invalidDevInput(message: string): Error & { code: "invalid_params" } {
	return Object.assign(new Error(message), { code: "invalid_params" as const });
}

async function handleDev(command: ParsedSlashCommand, host: DevHost): Promise<SlashCommandResult> {
	// 只移除命令语法分隔符，不压缩用户正文中的空白或换行。
	const rawArgs = /^\/dev(?:[:\s]([\s\S]*))?$/.exec(command.text)?.[1] ?? command.args;
	const match = /^\s*(\S+)(?:\s([\s\S]*))?$/.exec(rawArgs);
	const action = match?.[1];
	const text = match?.[2] ?? "";
	try {
		const controller = getSpecDrivenController(host, { restart: action === "start" });
		const assertDialogOwner = (): void => {
			// 原生窗口返回时不能把旧会话的选择派发给新会话或已替换的流程。
			if (
				host.signal?.aborted ||
				!controller.belongsTo(host) ||
				peekSpecDrivenController(host.sessionManager) !== controller ||
				controller.observation().disposed
			)
				throw invalidDevInput("操作窗口所属会话或流程已改变，请重新打开 /dev help。");
		};
		if (!action) {
			const mode = controller.inputMode() === "dev" ? "chat" : "dev";
			if (mode === "dev") {
				host.assertCanActivateMode?.("dev");
				assertDevModeActivationAllowed(host.session, "dev");
			}
			controller.setInputMode(mode);
			const observation = controller.observation();
			const recipient = observation.interaction.recipient;
			const stage = stageLabel(stageForPhase(observation.status.phase));
			await host.output(
				[
					`当前输入模式：${mode === "dev" ? "协同开发" : "普通聊天"}；流程阶段：${stage}`,
					`消息去向：${mode === "chat" ? "普通聊天 Agent" : observation.status.paused ? "暂停，输入保留为草稿" : recipient ? `${roleLabel(recipient.role)} · ${observation.active ? "运行中" : "等待你"}` : (observation.interaction.blockedReason ?? "尚未启动，输入保留为需求草稿")}`,
					`后台工作：${observation.active ? "仍在运行" : "当前空闲"}；切换输入模式不取消流程。`,
					"/dev help",
				].join("\n"),
			);
			return { consumed: true };
		}
		const usage = usages.find(item => item[0] === action);
		if (!usage) throw invalidDevInput(`未知 /dev 子命令：${action}。使用 /dev help 查看操作。`);
		const exact = (count: number): string[] => {
			const values = text.trim() ? text.trim().split(/\s+/) : [];
			if (values.length !== count) throw invalidDevInput(`用法：/dev ${action}${usage[1] ? ` ${usage[1]}` : ""}`);
			return values;
		};
		const requiredText = (): string => {
			if (!text.trim()) throw invalidDevInput(`用法：/dev ${action} ${usage[1]}`);
			return text;
		};
		switch (action) {
			case "help": {
				exact(0);
				const original = controller.observation();
				const actions = controller.actions();
				const assertCurrentAction = (chosen?: (typeof actions)[number]): void => {
					assertDialogOwner();
					const current = controller.observation();
					if (
						current.runId !== original.runId ||
						current.status.generation !== original.status.generation ||
						current.status.phase !== original.status.phase ||
						current.status.paused !== original.status.paused ||
						(chosen &&
							!controller
								.actions()
								.some(
									item =>
										item.id === chosen.id &&
										item.version === chosen.version &&
										item.command === chosen.command &&
										item.requiresInput === chosen.requiresInput &&
										item.available,
								))
					)
						throw invalidDevInput("操作窗口中的阶段或操作版本已过期，请重新打开 /dev help。");
				};
				await controller.report();
				await emitReference(
					host,
					actions
						.map(
							item =>
								`${item.label}：${item.command}${item.available ? "" : `（不可用：${item.blockedReason ?? "当前状态不允许"}）`}`,
						)
						.join("\n"),
				);
				assertCurrentAction();
				if (!host.ui) return { consumed: true };
				const choices = actions.filter(item => item.available);
				if (!choices.length) return { consumed: true };
				const labels = choices.map(item => `${item.label} — ${item.command}`);
				const selected = await host.ui.select("协同开发操作（关闭窗口不改变模式或流程）", labels, {
					signal: host.signal,
				});
				const chosen = choices[labels.indexOf(selected ?? "")];
				if (!chosen) return { consumed: true };
				assertCurrentAction(chosen);
				let invocation = chosen.command;
				if (chosen.requiresInput) {
					if (!host.ui.input) return { consumed: true };
					if (chosen.id === "start") {
						const change = await host.ui.input("新流程名称（change-id）", "", { signal: host.signal });
						assertCurrentAction(chosen);
						if (change === undefined) return { consumed: true };
						if (!/^\S+$/.test(change)) throw invalidDevInput("change-id 必须是单个非空标识。");
						const request = host.ui.editor
							? await host.ui.editor("需求正文", original.interaction.draft, { signal: host.signal })
							: await host.ui.input("需求正文", original.interaction.draft, { signal: host.signal });
						if (request === undefined) return { consumed: true };
						assertCurrentAction(chosen);
						invocation = `/dev start ${change} ${request}`;
					} else {
						const input = await host.ui.input(chosen.label, "", { signal: host.signal });
						assertCurrentAction(chosen);
						if (input === undefined) return { consumed: true };
						invocation = `${invocation} ${input}`;
					}
				}
				// 选择仅是输入；派发前校验原始所有者，再经过同一原生操作解析边界。
				assertCurrentAction(chosen);
				return handleDev({ name: "dev", args: invocation.replace(/^\/dev(?:\s+|$)/, ""), text: invocation }, host);
			}
			case "status":
				exact(0);
				await controller.report({ rawPhase: true });
				return { consumed: true };
			case "pause":
				exact(0);
				controller.pause();
				await controller.report();
				return { consumed: true };
			case "cancel":
				exact(0);
				if (
					host.ui &&
					!(await host.ui.confirm(
						"取消协同开发流程",
						"停止当前工作，保留已有文件；不会回滚已发生的修改。确认取消？",
						{ signal: host.signal },
					))
				)
					return { consumed: true };
				assertDialogOwner();
				await controller.cancel();
				await controller.report();
				return { consumed: true };
			case "cancel-message": {
				const [id] = exact(1);
				await controller.cancelMessage(id!);
				await controller.report();
				return { consumed: true };
			}
			case "resume":
				exact(0);
				controller.resume();
				break;
			case "start": {
				const start = /^\s*(\S+)\s+([\s\S]+)$/.exec(text);
				if (!start || !start[2]!.trim()) throw invalidDevInput("用法：/dev start <change-id> <request>");
				controller.schedule(core => core.start(start[2]!, start[1]!));
				break;
			}
			case "answer": {
				const answer = requiredText();
				controller.schedule(core => core.answer(answer));
				break;
			}
			case "confirm-spec": {
				const [version] = exact(1);
				controller.schedule(core => core.confirmSpecification(version!));
				break;
			}
			case "choose": {
				const [run, candidate, version] = exact(3);
				controller.schedule(core => core.chooseCandidate(run!, candidate!, version!));
				break;
			}
			case "confirm-plan": {
				const values = text.trim().split(/\s+/);
				if (
					!values[0] ||
					values[0].startsWith("-") ||
					values.length > 2 ||
					(values.length === 2 && values[1] !== "--goal")
				)
					throw invalidDevInput("用法：/dev confirm-plan <version> [--goal]");
				controller.schedule(core =>
					core.confirmPlan(values[0]!, { mode: values.length === 2 ? "goal" : "normal" }),
				);
				break;
			}
			case "accept": {
				const [version] = exact(1);
				controller.schedule(core => core.accept(version!));
				break;
			}
			case "repair": {
				const repair = /^\s*(\S+)\s+([\s\S]+)$/.exec(text);
				if (!repair || !repair[2]!.trim())
					throw invalidDevInput("用法：/dev repair <acceptance-version> <修复说明...>");
				controller.repair(repair[1]!, repair[2]!);
				break;
			}
			case "amend": {
				const amendment = requiredText();
				controller.schedule(core => core.amendRequirements(amendment), true);
				break;
			}
			case "change-solution": {
				const reason = requiredText();
				controller.schedule(core => core.changeSolution(reason), true);
				break;
			}
		}
		const status = controller.status();
		await host.output(
			`已提交后台任务：${usages.find(item => item[0] === action)?.[2] ?? action}；当前阶段：${stageLabel(
				stageForPhase(status.phase),
			)}。`,
		);
		await controller.report();
		return { consumed: true };
	} catch (error) {
		await host.output(
			`协同开发操作失败：${error instanceof Error ? error.message : String(error)}\n/dev status\n/dev help`,
		);
		return {
			consumed: true,
			failed: true,
			errorCode:
				error instanceof Error && "code" in error && error.code === "invalid_params"
					? "invalid_params"
					: "execution_failed",
		};
	}
}

export const BUILTIN_SPEC_DRIVEN_SLASH_COMMANDS: SlashCommandSpec[] = [
	{
		name: "dev",
		description: "协同开发模式：独立四阶段 Agent、显式版本批准及原生操作",
		allowArgs: true,
		subcommandOptional: true,
		subcommands: usages.map(([name, usage, description]) => ({ name, usage, description })),
		handle: handleDev,
		handleTui: async (command, runtime) => {
			const { ctx } = runtime;
			const session = ctx.session;
			const cancellation = new AbortController();
			const unregister = session.registerSessionChangeCallback(() => cancellation.abort());
			const host: DevHost = {
				session,
				sessionManager: ctx.sessionManager,
				settings: ctx.settings,
				cwd: ctx.sessionManager.getCwd(),
				output: text => ctx.showStatus(text, { toast: false }),
				persist: text =>
					ctx.session.appendCustomMessage({ customType: "spec-driven", content: text, display: true }),
				signal: cancellation.signal,
				ui: {
					select: (...args) => ctx.showHookSelector(...args),
					confirm: (...args) => ctx.showHookConfirm(...args),
					input: (...args) => ctx.showHookInput(...args),
					editor: (title, prefill, dialogOptions) => ctx.showHookEditor(title, prefill, dialogOptions),
				},
				assertCanActivateMode: () => ctx.assertCanActivateMode("dev"),
				refreshCommands: () => ctx.refreshSlashCommandState(),
				reloadPlugins: () => reloadTuiPluginState(ctx),
			};
			try {
				clearSubmittedText(runtime);
				return await handleDev(command, host);
			} finally {
				unregister();
			}
		},
	},
];
