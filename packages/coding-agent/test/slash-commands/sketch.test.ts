import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeRpcBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { RpcSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import * as sketch from "@oh-my-pi/pi-coding-agent/sketch/server";
import { decodePng } from "@oh-my-pi/pi-coding-agent/tools/browser/screenshot";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import * as open from "@oh-my-pi/pi-coding-agent/utils/open";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const PNG = encodeRawPng(Uint8Array.of(0, 0, 0, 255), 1, 1, 4);
type InputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

function service() {
	const result = Promise.withResolvers<Buffer | null>();
	const close = vi.fn(() => result.resolve(null));
	const server: sketch.SketchServer = { url: "http://127.0.0.1:12345/private-canvas/", result: result.promise, close };
	const start = spyOn(sketch, "startSketchServer").mockReturnValue(server);
	return { ...result, close, start, server };
}

function harness(artifactsDir: string, streaming = false) {
	const editor = new CustomEditor(getEditorTheme());
	const listeners = new Set<InputListener>();
	const changes = new Set<() => void>();
	const disposers: Array<() => void> = [];
	const statuses = new Map<string, string>();
	const prompt = vi.fn<InteractiveModeContext["session"]["prompt"]>(async () => true);
	const abort = vi.fn<InteractiveModeContext["session"]["abort"]>(async () => {});
	let sessionId = "sketch-owner";
	let disposed = false;
	let focused: Component | null = editor;
	let focusedAgentId: string | undefined;
	const ctx = createInteractiveModeContext({
		editor,
		get focusedAgentId() {
			return focusedAgentId;
		},
		sessionManager: {
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => sessionId,
		},
		session: {
			get isDisposed() {
				return disposed;
			},
			sessionGeneration: 0,
			isStreaming: streaming,
			isSessionTransitioning: false,
			customCommands: [],
			promptTemplates: [],
			prompt,
			abort,
			addDisposer: dispose => {
				disposers.push(dispose);
			},
			registerSessionChangeCallback: callback => {
				changes.add(callback);
				return () => {
					changes.delete(callback);
				};
			},
		},
		ui: {
			getFocused: () => focused,
			addInputListener: listener => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		setHookStatus: (key, text) => {
			if (text === undefined) statuses.delete(key);
			else statuses.set(key, text);
		},
		flushPendingBashComponents: () => {},
		withLocalSubmission: async <T>(_text: string, run: () => Promise<T>): Promise<T> => run(),
	});
	const controller = new InputController(ctx);
	ctx.handleImagePathPaste = controller.handleImagePathPaste.bind(controller);
	controller.setupEditorSubmitHandler();
	return {
		ctx,
		editor,
		prompt,
		abort,
		listeners,
		changes,
		statuses,
		disposers,
		key(data: string) {
			for (const listener of listeners) if (listener(data)?.consume) return true;
			return false;
		},
		focus(target: Component | null) {
			focused = target;
		},
		focusAgent(id: string | undefined) {
			focusedAgentId = id;
		},
		switchSession() {
			sessionId = "replacement";
			for (const callback of changes) callback();
		},
		dispose() {
			disposed = true;
			for (const dispose of disposers) dispose();
		},
	};
}

function oldImage(): ImageContent {
	return { type: "image", data: PNG.toString("base64"), mimeType: "image/png" };
}

describe("native /sketch", () => {
	let dir: string;
	let settingsState: SettingsTestState | undefined;
	const cleanup: Array<() => void> = [];

	beforeAll(async () => {
		await initTheme(false);
	});
	beforeEach(async () => {
		settingsState = beginSettingsTest();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sketch-command-"));
		setAgentDir(dir);
		await Settings.init({ inMemory: true });
		spyOn(open, "openPath").mockImplementation(() => {});
		spyOn(clipboard, "requestOfflineBrowserUrlCopy").mockReturnValue(false);
	});
	afterEach(async () => {
		for (const dispose of cleanup.splice(0)) dispose();
		vi.restoreAllMocks();
		await fs.rm(dir, { recursive: true, force: true });
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	function createHarness(artifactsDir = dir, streaming = false) {
		const h = harness(artifactsDir, streaming);
		cleanup.push(h.dispose);
		return h;
	}

	it("refuses RPC invocation and TUI arguments without starting a sketch or changing the draft", async () => {
		const h = createHarness();
		const s = service();
		const existing = oldImage();
		h.editor.pendingImages.push(existing);
		h.editor.pendingImageLinks.push("file:///existing.png");
		h.editor.setCollapsedText("keep [Image #1] and this text");
		const before = h.editor.getExpandedText();
		await expect(executeRpcBuiltinSlashCommand("/sketch", {} as RpcSlashCommandRuntime)).rejects.toThrow(
			"/sketch is only available in the interactive TUI.",
		);
		expect(await executeBuiltinSlashCommand("/sketch extra", { ctx: h.ctx })).toBe(false);
		expect(s.start).not.toHaveBeenCalled();
		expect(open.openPath).not.toHaveBeenCalled();
		expect(h.editor.getExpandedText()).toBe(before);
		expect(h.editor.pendingImages).toEqual([existing]);
		expect(h.editor.pendingImageLinks).toEqual(["file:///existing.png"]);
		expect(h.prompt).not.toHaveBeenCalled();
	});

	it("attaches a real PNG beside existing text/images and only sends on a later manual submit", async () => {
		const h = createHarness();
		const s = service();
		const existing = oldImage();
		h.editor.pendingImages.push(existing);
		h.editor.pendingImageLinks.push("file:///existing.png");
		h.editor.setCollapsedText("keep [Image #1] and this text ");
		const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		h.editor.pasteText("newer typing ");
		const before = h.editor.getExpandedText();
		s.resolve(PNG);
		await run;

		expect(h.ctx.showError).not.toHaveBeenCalled();
		expect(h.editor.getExpandedText()).toStartWith(before);
		expect(h.editor.getExpandedText()).toContain("[Image #2");
		expect(h.editor.getExpandedText()).not.toContain("/sketch");
		expect(h.editor.pendingImages).toHaveLength(2);
		expect(h.editor.pendingImages[0]).toBe(existing);
		const attached = h.editor.pendingImages[1]!;
		const decoded = decodePng(await new Bun.Image(Buffer.from(attached.data, "base64")).png().bytes());
		const original = decodePng(PNG);
		expect(decoded.width * original.height).toBe(decoded.height * original.width);
		for (let channel = 0; channel < 3; channel++) {
			expect(decoded.pixels[channel]!).toBeLessThanOrEqual(3);
		}
		expect(decoded.pixels[3]).toBe(255);
		const source = imageAttachmentSource(attached);
		expect(source?.path).toStartWith("local://sketch-");
		const saved = InternalUrlRouter.instance().locateSync(source!.path, {
			localProtocolOptions: { getArtifactsDir: () => dir, getSessionId: () => "sketch-owner" },
		});
		expect(saved).toBeDefined();
		expect(Buffer.from(await Bun.file(saved!).arrayBuffer()).equals(PNG)).toBe(true);
		expect(h.editor.pendingImageLinks[0]).toBe("file:///existing.png");
		expect(h.prompt).not.toHaveBeenCalled();
		expect(open.openPath).toHaveBeenCalledWith(s.server.url);
		expect(h.ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining(s.server.url));
		expect(h.listeners.size).toBe(0);
		expect(h.changes.size).toBe(0);
		expect(h.statuses.size).toBe(0);

		const manualText = h.editor.getExpandedText();
		await h.editor.onSubmit?.(manualText);
		expect(h.ctx.showError).not.toHaveBeenCalled();
		expect(h.prompt).toHaveBeenCalledTimes(1);
		expect(h.prompt.mock.calls[0]?.[0]).toContain("keep [Image #1] and this text newer typing");
		expect(h.prompt.mock.calls[0]?.[1]?.images).toEqual([existing, attached]);
		expect(h.editor.pendingImages).toHaveLength(0);
	});

	it("restores detached submission images without replacing newer composer text/images", async () => {
		const h = createHarness();
		const s = service();
		const submitted = oldImage();
		const newer = oldImage();
		h.editor.pendingImages.push(newer);
		h.editor.pendingImageLinks.push("file:///newer.png");
		h.editor.setCollapsedText("newer draft [Image #1]");
		const run = executeBuiltinSlashCommand("/sketch", {
			ctx: h.ctx,
			draftDetached: true,
			input: { images: [submitted], imageLinks: ["file:///submitted.png"] },
		});
		s.resolve(null);
		await run;
		expect(h.editor.getExpandedText()).toBe("[Image #2]\n\nnewer draft [Image #1]");
		expect(h.editor.pendingImages).toEqual([newer, submitted]);
		expect(h.editor.pendingImageLinks).toEqual(["file:///newer.png", "file:///submitted.png"]);
		expect(h.prompt).not.toHaveBeenCalled();
	});

	it("consumes terminal Escape without aborting an unrelated active agent or changing its draft", async () => {
		const h = createHarness(dir, true);
		const s = service();
		const existing = oldImage();
		h.editor.pendingImages.push(existing);
		h.editor.pendingImageLinks.push("file:///existing.png");
		h.editor.setCollapsedText("unchanged [Image #1]");
		const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		expect(h.key("\x1b")).toBe(true);
		await run;
		expect(s.close).toHaveBeenCalled();
		expect(h.abort).not.toHaveBeenCalled();
		expect(h.editor.getExpandedText()).toBe("unchanged [Image #1]");
		expect(h.editor.pendingImages).toEqual([existing]);
		expect(h.listeners.size).toBe(0);
		expect(h.statuses.size).toBe(0);
	});

	it("does not restore the consumed command on browser cancellation or launch failure", async () => {
		const h = createHarness();
		const s = service();
		h.editor.setText("/sketch");
		const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		s.resolve(null);
		await run;
		expect(h.editor.getText()).toBe("");
		s.start.mockImplementationOnce(() => {
			throw new Error("listen denied");
		});
		h.editor.setText("/sketch");
		await executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		expect(h.ctx.showError).toHaveBeenCalledWith("Sketch failed: listen denied");
		expect(h.editor.getText()).toBe("");
		expect(h.listeners.size).toBe(0);
		expect(h.changes.size).toBe(0);
		expect(h.statuses.size).toBe(0);
	});

	it("closes on session replacement even when a submitted PNG already resolved", async () => {
		const h = createHarness();
		const s = service();
		const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		s.resolve(PNG);
		h.switchSession();
		h.editor.clearDraft();
		h.editor.setText("replacement draft");
		await run;
		expect(s.close).toHaveBeenCalled();
		expect(h.editor.getText()).toBe("replacement draft");
		expect(h.editor.pendingImages).toEqual([]);
		expect(h.listeners.size).toBe(0);
		expect(h.changes.size).toBe(0);
		expect(h.statuses.size).toBe(0);
	});

	it.each(["view", "prompt", "draft", "dispose"] as const)(
		"ignores late completion after a %s change",
		async change => {
			const h = createHarness();
			const s = service();
			h.editor.setText("owner draft");
			const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
			s.resolve(PNG);
			if (change === "view") h.focusAgent("OtherAgent");
			if (change === "prompt") h.focus({ render: () => [], handleInput: () => {} });
			if (change === "draft") {
				h.editor.clearDraft();
				h.editor.setText("next draft");
			}
			if (change === "dispose") h.dispose();
			await run;
			expect(h.editor.pendingImages).toEqual([]);
			expect(h.prompt).not.toHaveBeenCalled();
			expect(h.listeners.size).toBe(0);
			expect(h.changes.size).toBe(0);
			expect(h.statuses.size).toBe(0);
		},
	);

	it("prevents duplicate canvases and retains only one session disposal hook across invocations", async () => {
		const h = createHarness();
		const s = service();
		const first = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		await executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		expect(s.start).toHaveBeenCalledTimes(1);
		expect(h.ctx.showWarning).toHaveBeenCalled();
		s.resolve(null);
		await first;
		await executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		expect(s.start).toHaveBeenCalledTimes(2);
		expect(h.disposers).toHaveLength(1);
		expect(h.listeners.size).toBe(0);
		expect(h.changes.size).toBe(0);
	});

	it("reports artifact write failures without dropping existing draft content or attachments", async () => {
		const blockedRoot = path.join(dir, "not-a-directory");
		await Bun.write(blockedRoot, "file blocks the artifact directory");
		const h = createHarness(blockedRoot);
		const s = service();
		const image = oldImage();
		h.editor.pendingImages.push(image);
		h.editor.pendingImageLinks.push("file:///existing.png");
		h.editor.setCollapsedText("keep [Image #1]");
		const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		s.resolve(PNG);
		await run;
		expect(h.ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Sketch failed:"));
		expect(h.editor.getExpandedText()).toBe("keep [Image #1]");
		expect(h.editor.pendingImages).toEqual([image]);
		expect(h.prompt).not.toHaveBeenCalled();
		expect(h.listeners.size).toBe(0);
		expect(h.changes.size).toBe(0);
		expect(h.statuses.size).toBe(0);
	});
});
