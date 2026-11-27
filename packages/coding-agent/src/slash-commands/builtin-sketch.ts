import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isSsh } from "@oh-my-pi/pi-tui/driver/mux/detect";
import { errorMessage, logger } from "@oh-my-pi/pi-utils";
import { offlineFromEnv } from "../cli/args";
import { InternalUrlRouter } from "../internal-urls/router";
import { compactImageMarkers, formatVisionMarker } from "../modes/view-model/prompt/composer-attachments";
import type { AgentSession } from "../session/agent-session";
import { startSketchServer, type SketchServer } from "../sketch/server";
import { requestOfflineBrowserUrlCopy } from "../utils/clipboard";
import { imageAttachmentSource } from "../utils/image-source";
import { openPath } from "../utils/open";
import { restoreDetachedDraft } from "./helpers/draft";
import type { ParsedSlashCommand, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

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

export function restoreSketchDraft(command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): void {
	const { composer } = runtime.ctx;
	// Enter may already have removed the command; never clear newer typing or
	// turn the slash invocation itself back into ordinary prompt text.
	if (!runtime.draftDetached && composer.expandedText().trim() === command.text.trim()) composer.setText("");
	const images = runtime.input?.images;
	if (!images?.length) return;
	const missing = images.flatMap((image, index) =>
		composer.pendingImages.includes(image) ? [] : [{ image, link: runtime.input?.imageLinks?.[index] }],
	);
	const currentText = composer.expandedText();
	const refs = compactImageMarkers(currentText, composer.pendingImages.length);
	const unreferenced = images.flatMap(image => {
		const index = composer.pendingImages.indexOf(image);
		return index >= 0 && refs && !refs.keep.includes(index)
			? [formatVisionMarker(imageAttachmentSource(image)?.kind ?? "image", index + 1)]
			: [];
	});
	if (unreferenced.length)
		composer.setCollapsedText([unreferenced.join(" "), currentText].filter(Boolean).join("\n\n"));
	if (missing.length) {
		restoreDetachedDraft(
			composer,
			missing
				.map(({ image }, index) => formatVisionMarker(imageAttachmentSource(image)?.kind ?? "image", index + 1))
				.join(" "),
			missing.map(item => item.image),
			missing.map(item => item.link),
		);
	}
}

export const BUILTIN_SKETCH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "sketch",
		description: "Draw in a local browser canvas and attach the PNG to your draft",
		handleTui: (command, runtime) => {
			const { ctx } = runtime;
			const { composer, session, sessionManager } = ctx;
			restoreSketchDraft(command, runtime);
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
			const focus = ctx.shell.focused();
			if (focus && focus !== composer.field) {
				ctx.showWarning("Return to the main composer before opening a sketch.");
				return;
			}
			const draftGeneration = composer.draftGeneration;
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
				ctx.composer === composer &&
				composer.draftGeneration === draftGeneration &&
				ctx.shell.focused() === focus;
			state.current = owned;
			const dispose = () => {
				removeInput?.();
				removeSessionChange?.();
				ctx.setHookStatus(statusKey, undefined);
				server?.close();
				if (state.current === owned) state.current = undefined;
			};
			try {
				server = startSketchServer(async (png, isOpen) => {
					const ownsDraft = () => isOpen() && isCurrent();
					if (!ownsDraft()) return "stale";
					let ownedPath: string | undefined;
					let attached = false;
					try {
						const localUrl = `local://sketch-${crypto.randomUUID()}.png`;
						const artifactsDir = sessionManager.getArtifactsDir();
						const filePath = InternalUrlRouter.instance().locateSync(localUrl, {
							localProtocolOptions: {
								getArtifactsDir: () => artifactsDir,
								getSessionId: () => sessionId,
							},
						});
						if (filePath === undefined) throw new Error("Unable to locate the session sketch artifact");
						await mkdir(dirname(filePath), { recursive: true });
						if (!ownsDraft()) return "stale";
						const file = await open(filePath, "wx");
						ownedPath = filePath;
						try {
							await file.writeFile(png);
						} finally {
							await file.close();
						}
						if (!ownsDraft()) return "stale";
						attached = (await ctx.handleImagePathPaste(localUrl, ownsDraft)) === true;
						if (attached) return "attached";
						if (!ownsDraft()) return "stale";
						throw new Error("Unable to attach the sketch PNG to the draft");
					} catch (error) {
						if (!ownsDraft()) return "stale";
						ctx.showError(`Sketch failed: ${errorMessage(error)}`);
						return "failed";
					} finally {
						if (ownedPath && !attached) {
							try {
								await rm(ownedPath, { force: true });
							} catch (error) {
								logger.warn("Failed to remove unattached sketch", {
									path: ownedPath,
									error: errorMessage(error),
								});
							}
						}
					}
				});
				removeSessionChange = session.registerSessionChangeCallback(owned.cancel);
				removeInput = ctx.shell.interceptInput(event => {
					if (!isCurrent()) {
						owned.cancel();
						return false;
					}
					if (event.type !== "key" || event.key.kind === "release" || event.key.id !== "escape") return false;
					owned.cancel();
					return true;
				});
				ctx.setHookStatus(statusKey, "Sketch open · Esc to cancel");
				const copyRequested = requestOfflineBrowserUrlCopy(server.url);
				const offline = offlineFromEnv();
				const hint = isSsh(process.env)
					? "open this URL in a browser on the remote host, or forward its port over SSH before opening it locally"
					: copyRequested
						? "attempted to copy the full URL; paste it into your browser's address bar or copy it manually"
						: offline
							? "offline mode does not launch a browser; open this URL manually"
							: "open this URL if the browser does not launch";
				ctx.showStatus(`Sketch canvas: ${server.url} (${hint})`);
				if (!offline) openPath(server.url);
				// The canvas owns its lifetime; never hold the input queue open for it.
				void server.result.finally(dispose).catch(error => {
					logger.warn("Sketch canvas cleanup failed", { error: errorMessage(error) });
				});
			} catch (error) {
				try {
					if (isCurrent()) ctx.showError(`Sketch failed: ${errorMessage(error)}`);
				} finally {
					dispose();
				}
			}
		},
	},
];
