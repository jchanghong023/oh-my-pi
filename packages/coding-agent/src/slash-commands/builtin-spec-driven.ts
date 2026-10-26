import {
	DevDecisionPanel,
	type DevDecisionModel,
	type DevDecisionResult,
} from "@oh-my-pi/pi-tui/overlays/dev-decision-panel";
import type { AgentSession } from "../session/agent-session";
import {
	getSpecDrivenController,
	peekSpecDrivenController,
	type SpecControllerObservation,
} from "../spec-driven/controller";
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
	["confirm-spec", "[--team] [confirmation...]", "确认当前需求文件并进入方案；--team 仅本次启用 Team"],
	["choose", "<candidate-id> [confirmation...]", "选择实际方案文件中的候选并编写计划"],
	["confirm-plan", "[--goal] [confirmation...]", "批准当前计划文件并开始执行；--goal 仅本次启用原生 Goal"],
	["revise-plan", "<修改说明...>", "修订计划后等待重新批准，不自动执行"],
	["accept", "", "验收当前完成报告，随后同步需求并归档"],
	["repair", "<text>", "返回当前范围内执行并修复"],
	["amend", "<text>", "修改需求，撤销受影响下游批准"],
	["change-solution", "<reason>", "重新讨论核心方案，撤销相关下游批准"],
	["pause", "", "暂停并停止后续派发"],
	["resume", "", "继续本进程内的暂停流程，不自动发送草稿"],
	["cancel", "", "停止当前工作，保留已有文件并取消流程"],
] as const;

type DevUi = NonNullable<SlashCommandRuntime["ui"]> & {
	editor?: (title: string, prefill?: string, dialogOptions?: { signal?: AbortSignal }) => Promise<string | undefined>;
	decision?: (model: DevDecisionModel, options?: { signal?: AbortSignal }) => Promise<DevDecisionResult | undefined>;
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

/** Only leading option tokens configure execution; confirmation prose stays opaque. */
function confirmationOption(text: string, supported: "--team" | "--goal"): boolean {
	let remaining = text;
	let enabled = false;
	for (;;) {
		const option = /^\s*(--\S*)(?:\s|$)/.exec(remaining);
		if (!option) return enabled;
		if (option[1] === "--") return enabled;
		if (option[1] !== supported) throw invalidDevInput(`不支持选项 ${option[1]}；此确认仅支持 ${supported}。`);
		enabled = true;
		remaining = remaining.slice(option[0].length);
	}
}

/** Presentation only: material views never approve a transition. */
function decisionModel(observation: SpecControllerObservation): DevDecisionModel {
	const { status: state, interaction } = observation;
	const stage =
		state.phase === "idle"
			? "尚未启动"
			: state.phase === "completed"
				? "已完成"
				: state.phase === "cancelled"
					? "已取消"
					: stageLabel(stageForPhase(state.phase));
	const specification =
		state.specification?.files.map(file => `## ${file.path}\n${file.content}`).join("\n\n") ?? "尚无需求文件。";
	const solution = state.solution ? `## ${state.solution.path}\n${state.solution.content}` : "尚无方案文件。";
	const plan = state.plan ? `## ${state.plan.path}\n${state.plan.content}` : "尚无计划文件。";
	const report = state.report ? `## ${state.report.path}\n${state.report.content}` : "尚无完成报告。";
	const model: DevDecisionModel = {
		title: `协同开发 · ${stage}`,
		summary: [
			`当前阶段：${stage}；${state.paused ? "已暂停" : observation.active ? "后台工作中" : "等待你的决定"}。`,
			state.blockedReason ?? "",
			state.useTeam === undefined ? "" : `本轮方案 Team：${state.useTeam ? "已启用" : "关闭"}（确认需求时确定）。`,
			state.useGoal === undefined
				? ""
				: `本轮执行原生 Goal：${state.useGoal ? "已启用" : "关闭"}（批准计划时确定）。`,
			interaction.recipient ? `消息接收方：${roleLabel(interaction.recipient.role)}` : "",
			"查看材料、编辑草稿、调整窗口或关闭窗口不会批准。只有明确提交操作才推进流程。",
			"批准计划不授权推送、发布、PR 或无关改动；验收后才同步需求并归档。",
		]
			.filter(Boolean)
			.join("\n"),
		actions: [],
	};
	const material = (id: string, label: string, detail: string): void => {
		model.actions.push({ id: `inspect:${id}`, label, group: "material", detail, inspect: true });
	};
	if (state.lastReply) material("reply", "查看当前阶段完整回复", state.lastReply);
	if (state.specification) material("specification", "查看完整需求文件", specification);
	if (state.solution) {
		material("solution", "查看完整方案文件与所有候选", solution);
		for (const candidate of state.solution.candidates)
			material(`candidate:${candidate.id}`, `查看方案：${candidate.title}`, candidate.content);
	}
	if (state.plan) material("plan", "查看完整计划文件", plan);
	if (state.report) material("report", "查看完整完成报告", report);
	for (const action of interaction.actions) {
		if (action.id === "status") continue;
		const candidate = state.solution?.candidates.find(item => action.id === `choose:${item.id}`);
		const detail =
			action.id === "confirm-spec"
				? specification
				: candidate
					? `${solution}\n\n选择：${candidate.title}\n可填写原始确认与补充说明；提交的选择和说明将原样交给计划 Agent。`
					: ["confirm-plan", "revise-plan"].includes(action.id)
						? plan
						: ["accept", "repair"].includes(action.id)
							? report
							: action.id === "answer"
								? (state.lastReply ?? "补充当前阶段所需信息；不会批准下一阶段。")
								: "明确提交才执行此操作。关闭窗口不改变流程。";
		model.actions.push({
			id: action.id,
			label: action.label,
			group:
				["start", "answer", "confirm-spec", "confirm-plan", "accept", "repair"].includes(action.id) || candidate
					? "decision"
					: "manage",
			detail,
			disabledReason: action.available ? undefined : (action.blockedReason ?? "当前不可用"),
			fields:
				action.id === "start"
					? [
							{ id: "request", label: "需求正文", value: interaction.draft, multiline: true },
							{ id: "change-id", label: "流程名称（可修改）", value: `change-${crypto.randomUUID()}` },
						]
					: action.id === "confirm-spec" || action.id === "confirm-plan"
						? [
								{
									id: action.id === "confirm-spec" ? "useTeam" : "useGoal",
									label:
										action.id === "confirm-spec"
											? "本次方案启用 Team（默认关闭）"
											: "本次执行启用原生 Goal（默认关闭）",
									kind: "checkbox",
									value: "false",
								},
								{ id: "confirmation", label: "确认与补充说明（可选）", multiline: true },
							]
						: candidate
							? [{ id: "confirmation", label: "确认与补充说明（可选）", multiline: true }]
							: action.requiresInput
								? [{ id: "text", label: "说明或回答", multiline: true }]
								: undefined,
		});
	}
	material(
		"commands",
		"查看命令与完整原始材料",
		[...interaction.actions.map(action => `${action.label}：${action.command}`), JSON.stringify(state, null, 2)].join(
			"\n\n",
		),
	);
	model.initialActionId = ["idle", "completed", "cancelled"].includes(state.phase)
		? "start"
		: ["requirements", "solution", "planning", "executing"].includes(state.phase) && !state.paused
			? "answer"
			: state.phase === "awaiting-choice"
				? "inspect:solution"
				: state.phase === "awaiting-plan"
					? "inspect:plan"
					: state.phase === "awaiting-acceptance"
						? "inspect:report"
						: state.specification
							? "inspect:specification"
							: "inspect:commands";
	return model;
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
			const stage = ["idle", "completed", "cancelled"].includes(observation.status.phase)
				? observation.status.phase === "idle"
					? "尚未启动"
					: observation.status.phase === "completed"
						? "已完成"
						: "已取消"
				: stageLabel(stageForPhase(observation.status.phase));
			await host.output(
				[
					`当前输入模式：${mode === "dev" ? "协同开发" : "普通聊天"}；流程阶段：${stage}`,
					`消息去向：${mode === "chat" ? "普通聊天 Agent" : observation.status.paused ? "暂停，输入保留为草稿" : recipient ? `${roleLabel(recipient.role)} · ${observation.active ? "运行中" : "等待你"}` : ["idle", "completed", "cancelled"].includes(observation.status.phase) ? "尚无运行中的流程，输入保留为需求草稿；使用 /dev help 开始新流程" : (observation.interaction.blockedReason ?? "阶段 Agent 尚未准备好")}`,
					`后台工作：${observation.active ? "仍在运行" : "当前空闲"}；切换输入模式不取消流程。`,
					["idle", "completed", "cancelled"].includes(observation.status.phase)
						? "使用 /dev help 填写需求并开始新流程。"
						: "使用 /dev help 查看当前材料并决定下一步。",
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
				if (host.ui?.decision) {
					const model = decisionModel(original);
					const selected = await host.ui.decision(model, { signal: host.signal });
					if (!selected) return { consumed: true };
					const presented = model.actions.find(item => item.id === selected.actionId);
					if (!presented || presented.inspect || presented.disabledReason)
						throw invalidDevInput("该操作不可提交，请重新打开 /dev help。");
					const chosen = actions.find(item => item.id === selected.actionId);
					if (!chosen) throw invalidDevInput("未知流程操作，请重新打开 /dev help。");
					assertCurrentAction(chosen);
					let invocation = chosen.command;
					if (chosen.id === "start") {
						const change = selected.values?.["change-id"] ?? "";
						const request = selected.values?.request ?? "";
						if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change))
							throw invalidDevInput("流程名称必须由小写 ASCII 字母、数字及分隔连字符组成，例如 change-result。");
						if (!request.trim()) throw invalidDevInput("请填写需求正文。");
						invocation = `/dev start ${change} ${request}`;
					} else if (chosen.id === "confirm-spec" || chosen.id === "confirm-plan") {
						const useTeam = chosen.id === "confirm-spec";
						if (selected.values?.[useTeam ? "useTeam" : "useGoal"] === "true")
							invocation += useTeam ? " --team" : " --goal";
						const confirmation = selected.values?.confirmation ?? "";
						if (confirmation) invocation += ` -- ${confirmation}`;
					} else if (chosen.id.startsWith("choose:")) {
						const confirmation = selected.values?.confirmation ?? "";
						if (confirmation) invocation = `${invocation} ${confirmation}`;
					} else if (chosen.requiresInput) {
						const input = selected.values?.text ?? "";
						if (!input.trim()) throw invalidDevInput("请填写本次操作的说明或回答。");
						invocation = `${invocation} ${input}`;
					}
					assertCurrentAction(chosen);
					return handleDev(
						{ name: "dev", args: invocation.replace(/^\/dev(?:\s+|$)/, ""), text: invocation },
						host,
					);
				}
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
				const choices = actions
					.filter(item => item.available)
					.flatMap(action => [
						{ action, command: action.command, label: `${action.label} — ${action.command}` },
						...(action.id === "confirm-spec" || action.id === "confirm-plan"
							? [
									{
										action,
										command: `${action.command} ${action.id === "confirm-spec" ? "--team" : "--goal"}`,
										label: `${action.label}（本次启用 ${action.id === "confirm-spec" ? "Team" : "原生 Goal"}）`,
									},
								]
							: []),
					]);
				if (!choices.length) return { consumed: true };
				const labels = choices.map(item => item.label);
				const selected = await host.ui.select("协同开发操作（关闭窗口不改变模式或流程）", labels, {
					signal: host.signal,
				});
				const choice = choices[labels.indexOf(selected ?? "")];
				if (!choice) return { consumed: true };
				const chosen = choice.action;
				assertCurrentAction(chosen);
				let invocation = choice.command;
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
				const useTeam = confirmationOption(text, "--team");
				controller.schedule(core => core.confirmSpecification(command.text, { useTeam }));
				break;
			}
			case "choose": {
				const choice = /^\s*(\S+)(?:\s([\s\S]*))?$/.exec(text);
				if (!choice) throw invalidDevInput("用法：/dev choose <candidate-id> [confirmation...]");
				controller.schedule(core => core.chooseCandidate(choice[1]!, command.text));
				break;
			}
			case "confirm-plan": {
				const useGoal = confirmationOption(text, "--goal");
				controller.schedule(core => core.confirmPlan(command.text, { useGoal }));
				break;
			}
			case "revise-plan":
				controller.revisePlan(requiredText());
				break;
			case "accept":
				controller.schedule(core => core.accept(command.text));
				break;
			case "repair":
				controller.repair(requiredText());
				break;
			case "amend": {
				const amendment = requiredText();
				controller.schedule(core => core.amendRequirements(amendment));
				break;
			}
			case "change-solution": {
				const reason = requiredText();
				controller.schedule(core => core.changeSolution(reason));
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
		description: "协同开发模式：四阶段 Agent、真实文件交接与明确批准",
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
				observesCustomMessages: true,
				signal: cancellation.signal,
				ui: {
					select: (...args) => ctx.showHookSelector(...args),
					confirm: (...args) => ctx.showHookConfirm(...args),
					input: (...args) => ctx.showHookInput(...args),
					editor: (title, prefill, dialogOptions) => ctx.showHookEditor(title, prefill, dialogOptions),
					decision: (model, options) =>
						ctx.showHookCustom<DevDecisionResult | undefined>(
							(tui, _theme, _keybindings, done) => new DevDecisionPanel(tui, model, done),
							{ overlay: true, signal: options?.signal },
						),
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
