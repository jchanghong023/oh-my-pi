import type { AgentSession } from "../session/agent-session";
import { getSpecDrivenController, peekSpecDrivenController } from "../spec-driven/controller";
import { reloadTuiPluginState } from "./builtin-marketplace";
import { clearSubmittedText, restoreDetachedDraft } from "./helpers/draft";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec } from "./types";

function invalidDevInput(message: string): Error & { code: "invalid_params" } {
	return Object.assign(new Error(message), { code: "invalid_params" as const });
}

/** Native lifecycle commands run normally only after the host has awaited Dev exit. */
export function isDevSessionTransitionCommand(name: string, args = ""): boolean {
	if (name === "session" && args.trim().split(/\s+/)[0] === "delete") return true;
	return [
		"new",
		"clear",
		"resume",
		"fork",
		"delete",
		"move",
		"cwd",
		"worktree",
		"newSession",
		"switchSession",
		"forkSession",
		"forkAssistant",
		"deleteSession",
		"moveSession",
		"setCwd",
		"createWorktree",
	].includes(name);
}

/** Safety policy applies to the actual visible native stage, not a separate Dev command runtime. */
export function assertDevCommandAllowed(session: AgentSession, name: string, args = ""): void {
	const controller = peekSpecDrivenController(session.sessionManager);
	if (controller?.inputMode() !== "dev" || name === "dev") return;
	if (isDevSessionTransitionCommand(name, args)) return;
	if (
		[
			"compact",
			"retry",
			"queue",
			"retryTurn",
			"compactSession",
			"sendQueuedNow",
			"editUserQuery",
			"setAutoDrain",
		].includes(name) &&
		controller.nativeSession() !== session
	) {
		throw invalidDevInput("尚无当前阶段原生会话；请先使用 /dev new <完整需求>，不会调用普通会话模型。");
	}
	if (
		[
			"display",
			"model",
			"models",
			"switch",
			"compact",
			"retry",
			"queue",
			"stop",
			"abort",
			"settings",
			"status",
			"extensions",
			"context",
			"help",
			"hotkeys",
			"copy",
			"export",
			"session",
			"name",
			"thinking",
			"setModel",
			"setThinkingLevel",
			"abortPrompt",
			"compactSession",
			"retryTurn",
			"editUserQuery",
			"sendQueuedNow",
			"setAutoDrain",
			"setFollowupMode",
		].includes(name)
	)
		return;
	if (
		["goal", "goal-autopilot", "sendGoalCommand"].includes(name) &&
		controller.status().phase === "executing" &&
		controller.nativeSession() === session
	)
		return;
	throw invalidDevInput(`协同开发模式不能执行 /${name}；请先输入 /dev 返回普通聊天。未知命令不会转交 Agent。`);
}

/** An executor's own native Goal is not an outer mode conflict. */
export function assertDevModeActivationAllowed(session: AgentSession, mode: "dev" | "plan" | "goal" | "vibe"): void {
	const controller = peekSpecDrivenController(session.sessionManager);
	if (controller?.inputMode() === "dev") {
		if (mode === "dev") return;
		if (mode === "goal" && controller.status().phase === "executing" && controller.nativeSession() === session)
			return;
		throw invalidDevInput(`请先输入 /dev 返回普通聊天，再启用 ${mode} 模式。`);
	}
	if (mode !== "dev") return;
	const contextMode = session.sessionManager.buildSessionContext().mode;
	const goal = session.getGoalModeState();
	if (
		session.getPlanModeState()?.enabled ||
		goal?.enabled ||
		goal?.goal.status === "paused" ||
		session.getVibeModeState()?.enabled ||
		contextMode === "plan_paused" ||
		contextMode === "goal_paused"
	) {
		throw invalidDevInput("请先退出 Plan、Goal 或 Vibe 模式，再进入协同开发模式；现有模式保持不变。");
	}
}

async function handleDev(command: ParsedSlashCommand, host: SlashCommandRuntime): Promise<SlashCommandResult> {
	try {
		const rawArgs = /^\/dev(?:[:\s]([\s\S]*))?$/.exec(command.text)?.[1] ?? command.args;
		const match = /^\s*(\S+)(?:\s([\s\S]*))?$/.exec(rawArgs);
		const action = match?.[1];
		const text = match?.[2] ?? "";
		// Parse completely before acquiring a workspace, showing UI, or starting any work.
		if (action && !["config", "new", "next", "back", "drop"].includes(action))
			throw invalidDevInput(`未知 /dev 子命令：${action}。`);
		if (action === "new" && !text.trim()) throw invalidDevInput("用法：/dev new <完整需求>");
		if (action && action !== "new" && action !== "next" && text.trim()) throw invalidDevInput(`用法：/dev ${action}`);
		const ids = action === "next" ? text.trim().split(/\s+/).filter(Boolean) : [];
		if (ids.length > 1) throw invalidDevInput("用法：/dev next [candidate-id]");
		const existing = peekSpecDrivenController(host.sessionManager);
		if (action && existing?.inputMode() !== "dev") throw invalidDevInput("请先输入 /dev 进入协同开发模式。");
		const controller = getSpecDrivenController(host);
		if (!action) {
			if (controller.inputMode() === "dev") await controller.exit();
			else {
				host.assertCanActivateMode?.("dev");
				assertDevModeActivationAllowed(host.session, "dev");
				await controller.enter();
			}
			return { consumed: true };
		}
		switch (action) {
			case "config": {
				const available = controller.actions().find(item => item.id === "config");
				if (!available?.available) {
					await host.output(available?.blockedReason ?? "当前阶段不能修改 Team 配置。");
					break;
				}
				if (!host.ui) throw invalidDevInput("当前宿主不支持原生配置选择。");
				const useTeam = controller.status().useTeam;
				const selected = await host.ui.select(`方案 Team · 当前${useTeam ? "开启" : "关闭"}`, ["开启", "关闭"], {
					signal: host.signal,
					initialIndex: useTeam ? 0 : 1,
				});
				if (selected === undefined) break;
				if (selected !== "开启" && selected !== "关闭") throw invalidDevInput("无效的 Team 配置。");
				if (
					host.signal?.aborted ||
					peekSpecDrivenController(host.sessionManager) !== controller ||
					controller.inputMode() !== "dev"
				)
					throw invalidDevInput("配置窗口所属会话已改变。");
				await controller.setTeam(selected === "开启");
				break;
			}
			case "new":
				await controller.new(text, host.input?.images, host.input?.imageLinks);
				break;
			case "next":
				if (ids.length && controller.status().phase !== "solution")
					throw invalidDevInput("只有方案阶段允许 candidate-id。");
				await controller.next(ids[0], command.text);
				break;
			case "back":
				await controller.back();
				break;
			case "drop":
				await controller.drop();
				break;
		}
		return { consumed: true };
	} catch (error) {
		await host.output(`协同开发操作失败：${error instanceof Error ? error.message : String(error)}`);
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
		description: "进入或退出协同开发工作区",
		allowArgs: true,
		subcommandOptional: true,
		subcommands: [
			{ name: "config", description: "配置方案 Team" },
			{ name: "new", usage: "<完整需求>", description: "开始新需求" },
			{ name: "next", usage: "[candidate-id]", description: "明确批准当前材料并推进" },
			{ name: "back", description: "返回上一阶段" },
			{ name: "drop", description: "停止并丢弃流程状态，保留已有文件" },
		],
		handle: handleDev,
		handleTui: async (command, runtime) => {
			const { ctx } = runtime;
			const result = await handleDev(command, {
				session: ctx.session,
				sessionManager: ctx.sessionManager,
				settings: ctx.settings,
				cwd: ctx.sessionManager.getCwd(),
				input: runtime.input,
				bindMainSession: session => ctx.bindMainSession(session),
				output: text => ctx.showDevCommandStatus(text),
				ui: {
					select: (...args) => ctx.showHookSelector(...args),
					confirm: (...args) => ctx.showHookConfirm(...args),
				},
				assertCanActivateMode: () => ctx.assertCanActivateMode("dev"),
				refreshCommands: () => ctx.refreshSlashCommandState(),
				reloadPlugins: () => reloadTuiPluginState(ctx),
			});
			if (result && "failed" in result && result.failed) {
				if (runtime.draftDetached)
					restoreDetachedDraft(ctx.editor, command.text, runtime.input?.images, runtime.input?.imageLinks);
			} else clearSubmittedText(runtime);
			return result;
		},
	},
];
