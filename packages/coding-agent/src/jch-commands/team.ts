/**
 * `/team` — multi-model planning discussion (fork feature).
 *
 * The command name is deliberately NOT `jch*`-prefixed (docs-zh-CN/team.md
 * §5.1): an upstream command of the same name is an accepted collision risk
 * to be handled when it appears. It still registers through the fork's own
 * command list so it stays under fork control.
 *
 * Entry gates enforced here, before any stage runs:
 * - bare `/team` without a task asks for the question; never guesses;
 * - Discuss primary agent: notice to switch back to Main with Shift+F2,
 *   nothing dispatched (same gating as `/tan`);
 * - everything else (config errors, missing session model) is reported by the
 *   controller without running stages or degrading to a single-model flow.
 */
import type { AgentSession } from "../session/agent-session";
import type { SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime } from "../slash-commands/types";

const USAGE = "用法：/team <问题或需求> — 用一段自然语言描述要分析的问题、需求或设计取舍。不猜测你要分析什么。";

function isDiscussPrimaryAgent(session: AgentSession): boolean {
	return session.getPrimaryAgentId() === "discuss" || session.getPendingPrimaryAgentId?.() === "discuss";
}

const DISCUSS_NOTICE = "/team 在 Discuss 模式下不可用。请先用 Shift+F2 切回 Main 再发起。";

export const TEAM_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "team",
		icon: "agents",
		description: "Team：多模型独立调查、交叉审查与方案汇总（只读规划）",
		allowArgs: true,
		inlineHint: "<问题或需求>",
		acpInputHint: "<问题或需求>",
		handle: async (command, runtime: SlashCommandRuntime) => {
			const question = command.args.trim();
			if (!question) {
				await runtime.output(USAGE);
				return { consumed: true };
			}
			if (isDiscussPrimaryAgent(runtime.session)) {
				await runtime.output(DISCUSS_NOTICE);
				return { consumed: true };
			}
			// Deferred import keeps command registration free of the orchestrator's
			// module graph (executor -> extensions -> builtin-registry -> here).
			const { startTeamDiscussion } = await import("../team/controller");
			await startTeamDiscussion(question, {
				session: runtime.session,
				settings: runtime.settings,
				cwd: runtime.cwd,
				hooks: {
					output: text => runtime.output(text),
				},
			});
			return { consumed: true };
		},
		handleTui: async (command, runtime: TuiSlashCommandRuntime) => {
			const question = command.args.trim();
			const ctx = runtime.ctx;
			if (!question) {
				ctx.showStatus(USAGE);
				return { consumed: true };
			}
			if (isDiscussPrimaryAgent(ctx.session)) {
				ctx.showWarning(DISCUSS_NOTICE);
				return { consumed: true };
			}
			const { startTeamDiscussion } = await import("../team/controller");
			const outcome = await startTeamDiscussion(question, {
				session: ctx.session,
				settings: ctx.settings,
				cwd: ctx.sessionManager.getCwd(),
				hooks: {
					showStatus: text => ctx.showStatus(text),
					showError: text => ctx.showError(text),
					rebuildChat: () => {
						ctx.rebuildChatFromMessages();
						// rebuildChatFromMessages mutates the component tree without
						// scheduling a paint; the report would otherwise wait for the
						// next unrelated repaint.
						ctx.ui.requestRender();
					},
				},
			});
			// Clear only after a successful dispatch: on a validation or config
			// error the question must stay in the editor for the user to fix and
			// resubmit.
			if (outcome.started) ctx.editor.setText("");
			return { consumed: true };
		},
	},
];
