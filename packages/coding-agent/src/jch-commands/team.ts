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
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "../slash-commands/types";
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
	const { composer } = runtime.ctx;
	const pending = composer.pendingImages;
	if (!images.every((image, index) => pending[index] === image)) return false;
	pending.splice(0, images.length);
	composer.pendingImageLinks.splice(0, images.length);
	return true;
}

async function handleTeamCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const question = command.args.trim();
	if (question === "configure") {
		await runtime.output("Team 配置请在 TUI 中运行 /team configure。此命令不发起讨论。");
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
}

export const TEAM_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "team",
		icon: "agents",
		description: "Team：至少三个代理独立调查、交叉审查与方案汇总（只读规划）",
		allowArgs: true,
		inlineHint: "<问题或需求>",
		subcommandOptional: true,
		subcommands: [{ name: "configure", description: "编辑 Team 有序模型槽位（不调用模型）" }],
		handle: handleTeamCommand,
		handleTui: async (command, runtime: TuiSlashCommandRuntime) => {
			const question = command.args.trim();
			const { ctx } = runtime;
			const { composer } = ctx;
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
					rebuildChat: () => ctx.rebuildChatFromMessages(),
				},
			});
			// Dispatch consumes only its own draft; a failed dispatch returns any
			// detached images after the newer draft and remaps their markers.
			if (outcome.started) {
				const currentText = composer.expandedText();
				if (!currentText || currentText === command.text) clearSubmittedText(runtime);
			} else if (draftDetached) {
				restoreDetachedDraft(composer, command.text, runtime.input?.images, runtime.input?.imageLinks);
			} else {
				const currentText = composer.expandedText();
				composer.setCollapsedText([command.text, currentText].filter(part => part.trim()).join("\n\n"));
			}
			return { consumed: true };
		},
	},
];
