import { matchesKey } from "@oh-my-pi/pi-tui";
import { formatVisionMarker, referencedAttachments } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { InternalUrlRouter } from "../internal-urls/router";
import type { AgentSession } from "../session/agent-session";
import { startSketchServer, type SketchServer } from "../sketch/server";
import { openPath } from "../utils/open";
import { restoreDetachedDraft } from "./helpers/draft";
import { errorMessage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

interface SketchSessionState {
	current?: { cancel(): void };
}

const sessions = new WeakMap<AgentSession, SketchSessionState>();

function sessionState(session: AgentSession): SketchSessionState {
	let state = sessions.get(session);
	if (!state) {
		state = {};
		sessions.set(session, state);
		const owned = state;
		// One lifetime hook per session, not one retained closure per invocation.
		session.addDisposer(() => owned.current?.cancel());
	}
	return state;
}

export const BUILTIN_SKETCH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "sketch",
		description: "Draw in a local browser canvas and attach the PNG to your draft",
		handleWebGui: (command, runtime) => runtime.host.sketch(command, runtime),
		handleTui: async (command, runtime) => {
			const { ctx } = runtime;
			const { editor, session, sessionManager } = ctx;
			// Enter may already have removed the command; never clear newer typing or
			// turn the slash invocation itself back into ordinary prompt text.
			if (!runtime.draftDetached && editor.getExpandedText().trim() === command.text.trim()) editor.setText("");
			const missing = (runtime.input?.images ?? []).flatMap((image, index) =>
				editor.pendingImages.includes(image) ? [] : [{ image, link: runtime.input?.imageLinks?.[index] }],
			);
			const currentText = editor.getExpandedText();
			const refs = referencedAttachments(currentText, new Map());
			const unreferenced = (runtime.input?.images ?? []).flatMap(image => {
				const index = editor.pendingImages.indexOf(image) + 1;
				return index > 0 && !refs.image.has(index) && !refs.video.has(index)
					? [formatVisionMarker("image", index)]
					: [];
			});
			if (unreferenced.length)
				editor.setCollapsedText([unreferenced.join(" "), currentText].filter(Boolean).join("\n\n"));
			if (missing.length) {
				restoreDetachedDraft(
					editor,
					missing.map((_, index) => formatVisionMarker("image", index + 1)).join(" "),
					missing.map(item => item.image),
					missing.map(item => item.link),
				);
			}
			const state = sessionState(session);
			if (state.current) {
				ctx.showWarning("A sketch is already open in this session; finish it or press Escape to cancel.");
				return;
			}
			if (session.isDisposed || session.isSessionTransitioning || ctx.isShuttingDown) return;
			const sessionId = sessionManager.getSessionId();
			const generation = session.sessionGeneration;
			const view = ctx.viewSession;
			const focusedAgentId = ctx.focusedAgentId;
			const focus = ctx.ui.getFocused();
			if (focus && focus !== editor) {
				ctx.showWarning("Return to the main composer before opening a sketch.");
				return;
			}
			const images = editor.pendingImages;
			let cancelled = false;
			let server: SketchServer | undefined;
			let removeInput: (() => void) | undefined;
			let removeSessionChange: (() => void) | undefined;
			const statusKey = `sketch:${crypto.randomUUID()}`;
			const owned = {
				cancel() {
					cancelled = true;
					server?.close();
				},
			};
			const isCurrent = () =>
				!cancelled &&
				!session.isDisposed &&
				!session.isSessionTransitioning &&
				!ctx.isShuttingDown &&
				ctx.session === session &&
				ctx.sessionManager === sessionManager &&
				sessionManager.getSessionId() === sessionId &&
				session.sessionGeneration === generation &&
				ctx.viewSession === view &&
				ctx.focusedAgentId === focusedAgentId &&
				ctx.editor === editor &&
				editor.pendingImages === images &&
				ctx.ui.getFocused() === focus;
			state.current = owned;
			try {
				server = startSketchServer();
				removeSessionChange = session.registerSessionChangeCallback(owned.cancel);
				removeInput = ctx.ui.addInputListener(
					data => {
						if (!isCurrent()) {
							owned.cancel();
							return undefined;
						}
						if (!matchesKey(data, "escape")) return undefined;
						owned.cancel();
						return { consume: true };
					},
					{ prepend: true },
				);
				ctx.setHookStatus(statusKey, "Sketch open · Esc to cancel");
				ctx.showStatus(`Sketch canvas: ${server.url} (open this URL if the browser does not launch)`);
				openPath(server.url);
				const png = await server.result;
				if (!png || !isCurrent()) return;
				const localUrl = `local://sketch-${crypto.randomUUID()}.png`;
				const artifactsDir = sessionManager.getArtifactsDir();
				const filePath = InternalUrlRouter.instance().locateSync(localUrl, {
					localProtocolOptions: {
						getArtifactsDir: () => artifactsDir,
						getSessionId: () => sessionId,
					},
				});
				if (filePath === undefined) throw new Error("Unable to locate the session sketch artifact");
				await Bun.write(filePath, png);
				if (!isCurrent()) return;
				await ctx.handleImagePathPaste(localUrl, isCurrent);
			} catch (error) {
				if (isCurrent()) ctx.showError(`Sketch failed: ${errorMessage(error)}`);
			} finally {
				removeInput?.();
				removeSessionChange?.();
				ctx.setHookStatus(statusKey, undefined);
				server?.close();
				if (state.current === owned) state.current = undefined;
			}
		},
	},
];
