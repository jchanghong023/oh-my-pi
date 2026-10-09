/**
 * `/team` — multi-model planning discussion (fork feature).
 *
 * The command name is deliberately NOT `jch*`-prefixed (docs-zh-CN/requirements/team.md
 * §5.1): an upstream command of the same name is an accepted collision risk
 * to be handled when it appears. It still registers through the fork's own
 * command list so it stays under fork control.
 *
 * Entry gates enforced here, before any stage runs:
 * - bare `/team` without a task asks for the question; never guesses;
 * - everything else (config errors, missing session model) is reported by the
 *   controller without running stages or degrading to a single-model flow.
 */
import type { SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime } from "../slash-commands/types";
import { clearSubmittedText, restoreDetachedDraft } from "../slash-commands/helpers/draft";

const USAGE = "用法：/team <问题或需求> — 用一段自然语言描述要分析的问题、需求或设计取舍。不猜测你要分析什么。";

/**
 * Drop the submission's attachments while they are still the live prefix of the
 * editor's pending list (the input controller's `#dropSubmittedPending` guard):
 * the Enter submit path leaves them in the composer, so a consumed `/team` must
 * take them with it instead of leaking them onto whatever the user types next;
 * anything attached after the submission stays untouched.
 */
function dropSubmittedImages(runtime: TuiSlashCommandRuntime): void {
	const images = runtime.input?.images;
	if (!images?.length) return;
	const editor = runtime.ctx.editor;
	const pending = editor.pendingImages;
	if (!images.every((image, index) => pending[index] === image)) return;
	pending.splice(0, images.length);
	const linkCount = Math.min(runtime.input?.imageLinks?.length ?? 0, editor.pendingImageLinks.length);
	editor.pendingImageLinks.splice(0, linkCount);
	editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
}

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
			// Both dispatch paths emptied the editor's text before this handler ran
			// (submit resets it; the follow-up path clears the draft), but only the
			// follow-up path also took the images with it. A failed dispatch must put
			// the submission back for the user to fix and resubmit; a successful one
			// consumes the text and the submitted images it still owns.
			if (outcome.started) {
				clearSubmittedText(runtime);
				dropSubmittedImages(runtime);
			} else if (runtime.draftDetached) {
				// The follow-up path took the draft's images out of the editor
				// before dispatch; a failed dispatch returns them with the text.
				restoreDetachedDraft(ctx.editor, command.text, runtime.input?.images, runtime.input?.imageLinks);
			} else {
				// Enter path: the images never left the editor, so restoring only the
				// text keeps them where the markers in it point — no marker shift, and
				// anything typed while dispatch ran stays behind the submission.
				const currentText = ctx.editor.getExpandedText();
				ctx.editor.setCollapsedText([command.text, currentText].filter(part => part.trim()).join("\n\n"));
			}
			return { consumed: true };
		},
	},
];
