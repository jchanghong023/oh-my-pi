import { getAIReqWorkbenchTuiMode } from "../aireq-workbench/tui-mode";
import { restoreDetachedDraft } from "./helpers/draft";
import type { SlashCommandResult, SlashCommandSpec } from "./types";

export const BUILTIN_WEBGUI_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "webgui",
		description: "Open WebGUI; enter /webgui again to close this instance's web service and restore the terminal",
		handleWebGui: async (_command, runtime) => {
			await runtime.host.toggleMode("webgui");
			return { consumed: true };
		},
		handleTui: async (command, runtime): Promise<SlashCommandResult> => {
			const { ctx } = runtime;
			const consumed = !runtime.draftDetached && ctx.editor.getExpandedText() === command.text;
			if (consumed) ctx.editor.setText("");
			try {
				await getAIReqWorkbenchTuiMode(ctx).toggle("webgui");
				if (runtime.draftDetached && runtime.input?.images?.length)
					restoreDetachedDraft(ctx.editor, "", runtime.input.images, runtime.input.imageLinks);
				return { consumed: true };
			} catch (error) {
				if (runtime.draftDetached)
					restoreDetachedDraft(ctx.editor, command.text, runtime.input?.images, runtime.input?.imageLinks);
				else if (consumed) restoreDetachedDraft(ctx.editor, command.text);
				ctx.showError(error instanceof Error ? error.message : String(error));
				return { consumed: true, failed: true };
			}
		},
	},
];
