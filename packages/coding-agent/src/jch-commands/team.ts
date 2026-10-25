/**
 * `/team` — multi-agent planning discussion (fork feature).
 *
 * The command name is deliberately NOT `jch*`-prefixed (openspec/specs/team-discussion/spec.md
 * §5.1): an upstream command of the same name is an accepted collision risk
 * to be handled when it appears. It still registers through the fork's own
 * command list so it stays under fork control.
 *
 * Entry gates enforced here, before any stage runs:
 * - bare `/team` without a task asks for the question; never guesses;
 * - everything else (config errors, missing session model) is reported by the
 *   controller without running stages.
 */
import type { SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime } from "../slash-commands/types";
import { clearSubmittedText, restoreDetachedDraft } from "../slash-commands/helpers/draft";
import { showTeamConfig } from "../team/config-ui";

const USAGE = "用法：/team <问题或需求> — 用一段自然语言描述要分析的问题、需求或设计取舍。不猜测你要分析什么。";

/**
 * Detach the submission's attachments before dispatch can await persistence,
 * so new attachments start at #1 rather than inheriting the submitted prefix.
 * Failed dispatches restore this detached draft with shifted markers.
 */
function detachSubmittedImages(runtime: TuiSlashCommandRuntime): boolean {
	const images = runtime.input?.images;
	if (!images?.length) return false;
	const editor = runtime.ctx.editor;
	const pending = editor.pendingImages;
	if (!images.every((image, index) => pending[index] === image)) return false;
	pending.splice(0, images.length);
	const linkCount = Math.min(runtime.input?.imageLinks?.length ?? 0, editor.pendingImageLinks.length);
	editor.pendingImageLinks.splice(0, linkCount);
	editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
	return true;
}

export const TEAM_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "team",
		icon: "agents",
		description: "Team：至少三个代理独立调查、交叉审查与方案汇总（只读规划）",
		allowArgs: true,
		inlineHint: "<问题或需求>",
		acpInputHint: "<问题或需求>",
		subcommandOptional: true,
		subcommands: [{ name: "configure", description: "编辑 Team 有序模型槽位（不调用模型）" }],
		handle: async (command, runtime: SlashCommandRuntime) => {
			const question = command.args.trim();
			if (question === "configure") {
				await runtime.output(
					"Team 配置请使用 TUI /team configure，或 RPC v3 teamConfig 能力的 get_team_config / get_team_models / set_team_config 接口。此命令不发起讨论。",
				);
				return { consumed: true };
			}
			if (!question) {
				await runtime.output(USAGE);
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
			if (question === "configure") {
				clearSubmittedText(runtime);
				showTeamConfig(ctx);
				return { consumed: true };
			}
			if (!question) {
				ctx.showStatus(USAGE);
				return { consumed: true };
			}
			const draftDetached = runtime.draftDetached || detachSubmittedImages(runtime);
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
			// Dispatch consumes only its own draft; a failed dispatch returns any
			// detached images after the newer draft and remaps their markers.
			if (outcome.started) {
				const currentText = ctx.editor.getExpandedText();
				if (!currentText || currentText === command.text) clearSubmittedText(runtime);
			} else if (draftDetached) {
				restoreDetachedDraft(ctx.editor, command.text, runtime.input?.images, runtime.input?.imageLinks);
			} else {
				const currentText = ctx.editor.getExpandedText();
				ctx.editor.setCollapsedText([command.text, currentText].filter(part => part.trim()).join("\n\n"));
			}
			return { consumed: true };
		},
	},
];
