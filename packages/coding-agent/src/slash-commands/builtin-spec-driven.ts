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
import type { SpecToolRecord } from "../spec-driven/types";
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
	["revise-plan", "<plan-version> <修改说明...>", "仅修订计划，审查后等待重新批准，不自动执行"],
	["extend-review", "<review-id> <revision> <repair-limit>", "为当前耗尽的审查明确追加一轮自动修复，不代表通过"],
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

/** Presentation only: all executable actions and their versions remain owned by the controller. */
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
	const questions = (state.clarification?.questions ?? state.questions).join("\n\n");
	const specification = state.specification
		? [state.specification.proposal, ...state.specification.specs.map(doc => `## ${doc.path}\n${doc.content}`)].join(
				"\n\n",
			)
		: "尚无需求规格材料。";
	const plan = state.plan;
	const planAuthorization =
		"批准即授权在上述范围内实现、验证、本任务本地 commit 及既定任务工作区集成；不授权 push、发布、创建 PR、改写历史或无关改动。普通执行与 Goal 均须遵守同一计划及版本门禁。";
	const planScope = plan ? [...new Set(plan.tasks.flatMap(task => task.ownedPaths))].join("、") || "无文件改动" : "";
	const planDetail = plan
		? [
				`任务摘要：\n${plan.tasks.map(task => `${task.title}；负责路径：${task.ownedPaths.join("、") || "无"}`).join("\n")}`,
				`执行工作区：${plan.workspace.executionPath}\n隔离：${plan.workspace.isolation === "native" ? "原生隔离" : "不隔离"}；集成：原生`,
				`核心验证：${[...new Set([...plan.tasks.flatMap(task => task.validation.map(validation => validation.command)), ...plan.finalValidation.map(validation => validation.command)])].join("；") || "未列出"}`,
				planAuthorization,
				"## 完整任务与验证要求",
				...plan.tasks.map(task =>
					[
						`### ${task.title}`,
						task.instructions,
						`负责路径：${task.ownedPaths.join("、") || "无"}`,
						`验证：\n${task.validation.map(v => `${v.behavior}：${v.command}`).join("\n")}`,
						task.tdd.mode === "required"
							? `TDD：先失败再实现；${task.tdd.behavior}`
							: `TDD 例外：${task.tdd.reason}\n替代验证：${task.tdd.alternativeCommands.join("\n")}`,
					].join("\n"),
				),
				`前置条件：\n${plan.conditions.map(c => `${c.description}：${c.command}`).join("\n") || "无"}`,
				`最终验证：\n${plan.finalValidation.map(v => `${v.behavior}：${v.command}${v.realEntry ? "（真实入口）" : ""}`).join("\n")}`,
				`## 完整计划正文\n${plan.content}`,
			].join("\n\n")
		: "尚无执行计划。";
	const recordSummary = (record: SpecToolRecord): string => {
		const stage =
			record.obligation?.stage === "red"
				? "RED（历史先失败阶段，不据此单独判定交付失败）"
				: record.obligation?.stage === "green"
					? "GREEN（实现后验证阶段）"
					: "验证记录";
		return `${record.args.command}；${stage}；${record.result.status === "completed" ? "已结束" : record.result.status === "cancelled" ? "已取消" : "结果未知"}；退出码 ${record.result.exitCode ?? "未知"}${record.result.isError ? "；工具报告错误" : ""}`;
	};
	const records = state.tasks.flatMap(task => task.records);
	const acceptance = [
		"交付与验证事实",
		...state.tasks.map(task => {
			const title = plan?.tasks.find(item => item.id === task.id)?.title ?? "任务";
			return [
				`### ${title}：${({ pending: "待执行", implemented: "已实现", verified: "已验证", completed: "已完成" } as const)[task.status]}`,
				`交付路径：${task.execution?.changedPaths.join("、") || "尚无执行记录"}`,
				task.records.length ? `最新验证记录：${recordSummary(task.records.at(-1)!)}` : "尚无验证记录",
				task.review
					? `审查：${task.review.findings.map(f => `${f.issue}\n${f.evidence}`).join("\n") || "无发现"}`
					: "尚无任务审查记录",
			].join("\n");
		}),
		...state.reviews.map(review =>
			review.lastReview
				? `审查结论：${({ pass: "通过", revise: "需要修订", clarify: "需要澄清" } as const)[review.lastReview.verdict]}\n${review.lastReview.summary}\n${review.lastReview.findings.map(finding => `${finding.issue}\n${finding.evidence}`).join("\n")}`
				: "审查尚无结论",
		),
		...(plan?.finalValidation.map(validation => {
			const record = records.findLast(
				item =>
					item.obligation?.validationId === validation.id &&
					item.obligation.approvedCommand === validation.command,
			);
			return `最终验证：${validation.behavior}${validation.realEntry ? "（真实入口）" : ""}；${record ? recordSummary(record) : `${validation.command}；尚无匹配的执行记录`}`;
		}) ?? []),
		...(state.reviewArtifacts?.map(artifact => `审查材料：${artifact.path}`) ?? []),
		`待收尾：${state.pendingClosure.join("、") || "无"}`,
		"验收仅针对当前交付版本；要求修复将撤销本轮验收资格，并限定在已批准范围内。",
		"## 历史验证记录概要",
		"以下按实际阶段和退出状态列出历史记录；RED 不等于当前交付失败，也不自动表示先失败验证有效。完整标准输出与错误输出请查看“完整验证原始输出”。",
		...records.map(recordSummary),
	].join("\n\n");
	const candidateDetail = (candidate: NonNullable<typeof state.team>["candidates"][number]): string =>
		[
			candidate.proposal,
			`审查：${candidate.reviewSucceeded ? "通过" : "未通过"}；复核：${candidate.recheckSucceeded ? "通过" : "未通过"}；可采用：${candidate.adoptable ? "是" : "否"}`,
			`适用条件：\n${candidate.conditions.map(c => `${c.description}${c.command ? `：${c.command}` : ""}`).join("\n") || "未列出额外条件"}`,
			`阻塞：${candidate.exclusionReason ?? ""}\n${candidate.unresolvedBlocking.map(b => b.evidence).join("\n") || "无未解决阻塞"}`,
			`方案讨论报告：\n${state.team?.report ?? "尚无报告"}`,
			...(state.team?.interpretationDifferences.map(
				d => `${d.question}；${d.affectsChoice ? "影响选择" : "不影响选择"}；${d.resolved ? "已解决" : "未解决"}`,
			) ?? []),
		].join("\n\n");
	const model: DevDecisionModel = {
		title: `协同开发 · ${stage}`,
		summary: [
			["idle", "completed", "cancelled"].includes(state.phase)
				? state.phase === "idle"
					? "尚未启动。填写需求并提交后才开始新流程。"
					: state.phase === "completed"
						? "本轮已完成，可查看交付或开始新流程。"
						: "本轮已取消，已有文件保留。"
				: `当前阶段：${stage}；${state.paused ? "已暂停" : observation.active ? "后台工作中" : "等待你的决定"}。`,
			state.phase === "awaiting-plan" && plan ? `计划范围：${plan.tasks.length} 项任务；${planScope}` : "",
			state.phase === "awaiting-plan" && plan ? planAuthorization : "",
			state.blockedReason ?? "",
			interaction.recipient ? `消息接收方：${roleLabel(interaction.recipient.role)}` : "",
			"查看材料不会批准；只有明确提交操作才会推进流程。关闭窗口不改变流程。",
		]
			.filter(Boolean)
			.join("\n"),
		actions: [],
	};
	const material = (id: string, label: string, detail: string): void => {
		model.actions.push({ id: `inspect:${id}`, label, group: "material", detail, inspect: true });
	};
	if (state.specification) material("specification", "查看完整需求规格", specification);
	if (state.team) {
		material("comparison", "查看方案比较与审查报告", state.team.report);
		for (const candidate of state.team.candidates)
			material(
				`candidate:${candidate.id}`,
				`查看${candidate.label}：${
					candidate.proposal
						.split(/\r?\n/)
						.find(line => line.trim())
						?.replace(/^#+\s*/, "")
						.slice(0, 60) || candidate.label
				}`,
				candidateDetail(candidate),
			);
	}
	if (plan) material("plan", "查看计划、验证与授权", planDetail);
	if (state.tasks.length || state.acceptanceVersion) material("acceptance", "查看交付与验收事实", acceptance);
	if (records.length)
		material(
			"verification-output",
			"完整验证原始输出",
			records
				.map(record =>
					[
						recordSummary(record),
						`证据材料：${record.artifact.path}`,
						`标准输出：\n${record.result.stdout}`,
						`错误输出：\n${record.result.stderr}`,
					].join("\n\n"),
				)
				.join("\n\n---\n\n"),
		);
	for (const action of interaction.actions) {
		if (action.id === "status") continue;
		const candidate = state.team?.candidates.find(item => action.id === `choose:${item.id}`);
		const detail =
			action.id === "answer"
				? questions
				: action.id === "confirm-spec"
					? specification
					: candidate
						? candidateDetail(candidate)
						: ["confirm-plan", "confirm-plan-goal", "revise-plan"].includes(action.id)
							? planDetail
							: ["accept", "repair"].includes(action.id)
								? acceptance
								: action.id === "start"
									? "先描述需求；流程名称已自动生成，可按需修改。提交后开始澄清需求，不会自动批准后续阶段。"
									: action.id === "amend"
										? "修改需求会撤销受影响的下游批准，请说明新的需求。"
										: "此操作会改变当前流程，请明确提交。";
		model.actions.push({
			id: action.id,
			label: candidate
				? `采用${candidate.label}：${
						candidate.proposal
							.split(/\r?\n/)
							.find(line => line.trim())
							?.replace(/^#+\s*/, "")
							.slice(0, 60) || candidate.label
					}`
				: action.id.startsWith("cancel-message:")
					? "停止处理当前消息（保留已有副作用）"
					: action.id.startsWith("extend-review:")
						? "为当前审查追加一轮修复（不代表通过）"
						: action.label,
			group:
				["start", "answer", "confirm-spec", "confirm-plan", "confirm-plan-goal", "accept", "repair"].includes(
					action.id,
				) || candidate
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
					: action.requiresInput
						? [
								{
									id: "text",
									label:
										action.id === "answer"
											? "本轮完整回答"
											: action.id === "repair"
												? "获批范围内的修复说明"
												: "说明",
									multiline: true,
								},
							]
						: undefined,
		});
	}
	material(
		"commands",
		"查看完整命令、版本与原始材料",
		[
			...interaction.actions.map(
				action => `${action.label}：${action.command}${action.available ? "" : `（${action.blockedReason}）`}`,
			),
			JSON.stringify(state, null, 2),
		].join("\n\n"),
	);
	model.initialActionId =
		state.phase === "awaiting-answers"
			? "answer"
			: ["idle", "completed", "cancelled"].includes(state.phase)
				? "start"
				: state.phase === "awaiting-plan"
					? "inspect:plan"
					: state.phase === "awaiting-choice"
						? "inspect:comparison"
						: state.phase === "awaiting-acceptance"
							? "inspect:acceptance"
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
			case "revise-plan": {
				const revision = /^\s*(\S+)\s+([\s\S]+)$/.exec(text);
				if (!revision || !revision[2]!.trim())
					throw invalidDevInput("用法：/dev revise-plan <plan-version> <修改说明...>");
				controller.revisePlan(revision[1]!, revision[2]!);
				break;
			}
			case "extend-review": {
				const [id, revision, repairLimit] = exact(3);
				if (
					!/^\d+$/.test(revision!) ||
					!/^\d+$/.test(repairLimit!) ||
					!Number.isSafeInteger(Number(revision)) ||
					!Number.isSafeInteger(Number(repairLimit))
				)
					throw invalidDevInput("审查轮次与修复额度必须是非负安全整数。");
				controller.extendReview(id!, Number(revision), Number(repairLimit));
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
