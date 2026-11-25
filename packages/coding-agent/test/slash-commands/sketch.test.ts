import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import * as args from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import * as sketch from "@oh-my-pi/pi-coding-agent/sketch/server";
import { decodePng } from "@oh-my-pi/pi-coding-agent/tools/browser/screenshot";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { imageAttachmentSource } from "@oh-my-pi/pi-coding-agent/utils/image-source";
import * as open from "@oh-my-pi/pi-coding-agent/utils/open";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import type { InputInterceptor } from "../../src/ui/shell";
import { initTheme } from "../../src/ui/theme/service";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const PNG = encodeRawPng(Uint8Array.of(0, 0, 0, 255), 1, 1, 4);

function sketchCanvas(deliver: Parameters<typeof sketch.startSketchServer>[0]) {
	const result = Promise.withResolvers<Buffer | null>();
	let settled = false;
	const isOpen = () => !settled;
	function settle(value: Buffer | null) {
		if (settled) return;
		settled = true;
		result.resolve(value);
	}
	const cancel = () => settle(null);
	const close = vi.fn(cancel);
	const server: sketch.SketchServer = { url: "http://127.0.0.1:12345/private-canvas/", result: result.promise, close };
	return {
		server,
		cancel,
		close,
		async submit(png: Buffer) {
			if (!isOpen()) return "stale";
			const outcome = await deliver(png, isOpen);
			if (!isOpen()) return "stale";
			settle(outcome === "attached" ? png : null);
			return outcome;
		},
	};
}

function service() {
	let canvas: ReturnType<typeof sketchCanvas> | undefined;
	const start = spyOn(sketch, "startSketchServer").mockImplementation(deliver => {
		canvas = sketchCanvas(deliver);
		return canvas.server;
	});
	return {
		start,
		get canvas() {
			if (!canvas) throw new Error("Sketch server has not started");
			return canvas;
		},
	};
}

function harness(artifactsDir: string, streaming = false) {
	const listeners = new Set<InputInterceptor>();
	const changes = new Set<() => void>();
	const disposers: Array<() => void> = [];
	const statuses = new Map<string, string>();
	const prompt = vi.fn<InteractiveModeContext["session"]["prompt"]>(async () => true);
	const abort = vi.fn<InteractiveModeContext["session"]["abort"]>(async () => {});
	let sessionId = "sketch-owner";
	let disposed = false;
	let focusedAgentId: string | undefined;
	const ctx = createInteractiveModeContext({
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
		setHookStatus: (key, text) => {
			if (text === undefined) statuses.delete(key);
			else statuses.set(key, text);
		},
		withLocalSubmission: async <T>(_text: string, run: () => Promise<T>): Promise<T> => run(),
	});
	const interceptInput = ctx.shell.interceptInput.bind(ctx.shell);
	spyOn(ctx.shell, "interceptInput").mockImplementation(listener => {
		listeners.add(listener);
		const remove = interceptInput(listener);
		return () => {
			listeners.delete(listener);
			remove();
		};
	});
	const controller = new InputController(ctx);
	ctx.handleImagePathPaste = controller.handleImagePathPaste.bind(controller);
	controller.setupEditorSubmitHandler();
	return {
		ctx,
		composer: ctx.composer,
		prompt,
		abort,
		listeners,
		changes,
		statuses,
		disposers,
		async submit() {
			ctx.composer.submit();
			await controller.waitForSubmissionDispatches();
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
			ctx.shell.overlays.closeAll();
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

	beforeAll(() => initTheme());
	beforeEach(async () => {
		settingsState = beginSettingsTest();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sketch-command-"));
		setAgentDir(dir);
		await Settings.init({ inMemory: true });
		spyOn(open, "openPath").mockImplementation(() => {});
		spyOn(args, "offlineFromEnv").mockReturnValue(false);
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

	it("keeps the offline canvas URL and PNG attachment flow without launching a browser", async () => {
		spyOn(args, "offlineFromEnv").mockReturnValue(true);
		spyOn(clipboard, "requestOfflineBrowserUrlCopy").mockReturnValue(true);
		const h = createHarness();
		const s = service();
		h.composer.setText("offline draft");
		const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		const canvas = s.canvas;
		expect(open.openPath).not.toHaveBeenCalled();
		expect(clipboard.requestOfflineBrowserUrlCopy).toHaveBeenCalledWith(canvas.server.url);
		expect(h.ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining(canvas.server.url));
		expect(await canvas.submit(PNG)).toBe("attached");
		await run;
		expect(h.ctx.showError).not.toHaveBeenCalled();
		expect(h.composer.expandedText()).toStartWith("offline draft");
		expect(h.composer.pendingImages).toHaveLength(1);
		expect(h.prompt).not.toHaveBeenCalled();
		expect(canvas.close).toHaveBeenCalled();
	});

	it("refuses TUI arguments without starting a sketch or changing the draft", async () => {
		const h = createHarness();
		const s = service();
		const existing = oldImage();
		h.composer.pendingImages.push(existing);
		h.composer.pendingImageLinks.push("file:///existing.png");
		h.composer.setCollapsedText("keep [Image #1] and this text");
		const before = h.composer.expandedText();
		expect(await executeBuiltinSlashCommand("/sketch extra", { ctx: h.ctx })).toBe(false);
		expect(s.start).not.toHaveBeenCalled();
		expect(open.openPath).not.toHaveBeenCalled();
		expect(h.composer.expandedText()).toBe(before);
		expect(h.composer.pendingImages).toEqual([existing]);
		expect(h.composer.pendingImageLinks).toEqual(["file:///existing.png"]);
		expect(h.prompt).not.toHaveBeenCalled();
	});

	it("attaches a real PNG beside existing text/images and only sends on a later manual submit", async () => {
		const h = createHarness();
		const s = service();
		const existing = oldImage();
		h.composer.pendingImages.push(existing);
		h.composer.pendingImageLinks.push("file:///existing.png");
		h.composer.setCollapsedText("keep [Image #1] and this text ");
		const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		const canvas = s.canvas;
		h.composer.insertText("newer typing ");
		const before = h.composer.expandedText();
		expect(await canvas.submit(PNG)).toBe("attached");
		await run;

		expect(h.ctx.showError).not.toHaveBeenCalled();
		expect(h.composer.expandedText()).toStartWith(before);
		expect(h.composer.expandedText()).toContain("[Image #2");
		expect(h.composer.expandedText()).not.toContain("/sketch");
		expect(h.composer.pendingImages).toHaveLength(2);
		expect(h.composer.pendingImages[0]).toBe(existing);
		const attached = h.composer.pendingImages[1]!;
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
		expect(h.composer.pendingImageLinks[0]).toBe("file:///existing.png");
		expect(h.prompt).not.toHaveBeenCalled();
		expect(open.openPath).toHaveBeenCalledWith(canvas.server.url);
		expect(h.ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining(canvas.server.url));
		expect(h.listeners.size).toBe(0);
		expect(h.changes.size).toBe(0);
		expect(h.statuses.size).toBe(0);

		await h.submit();
		expect(h.ctx.showError).not.toHaveBeenCalled();
		expect(h.prompt).toHaveBeenCalledTimes(1);
		expect(h.prompt.mock.calls[0]?.[0]).toContain("keep [Image #1] and this text newer typing");
		expect(h.prompt.mock.calls[0]?.[1]?.images).toEqual([existing, attached]);
		expect(h.composer.pendingImages).toHaveLength(0);
	});

	it("restores detached submission images without replacing newer composer text/images", async () => {
		const h = createHarness();
		const s = service();
		const submitted = oldImage();
		const newer = oldImage();
		h.composer.pendingImages.push(newer);
		h.composer.pendingImageLinks.push("file:///newer.png");
		h.composer.setCollapsedText("newer draft [Image #1]");
		const run = executeBuiltinSlashCommand("/sketch", {
			ctx: h.ctx,
			draftDetached: true,
			input: { images: [submitted], imageLinks: ["file:///submitted.png"] },
		});
		s.canvas.cancel();
		await run;
		expect(h.composer.expandedText()).toBe("[Image #2]\n\nnewer draft [Image #1]");
		expect(h.composer.pendingImages).toEqual([newer, submitted]);
		expect(h.composer.pendingImageLinks).toEqual(["file:///newer.png", "file:///submitted.png"]);
		expect(h.prompt).not.toHaveBeenCalled();
	});

	it("consumes terminal Escape without aborting an unrelated active agent or changing its draft", async () => {
		const h = createHarness(dir, true);
		const s = service();
		const existing = oldImage();
		h.composer.pendingImages.push(existing);
		h.composer.pendingImageLinks.push("file:///existing.png");
		h.composer.setCollapsedText("unchanged [Image #1]");
		const olderInterceptor = vi.fn(() => false);
		const remove = h.ctx.shell.interceptInput(olderInterceptor);
		const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		try {
			h.ctx.shell.input({ type: "key", key: { id: "escape", kind: "press", raw: "\x1b" } });
			expect(olderInterceptor).not.toHaveBeenCalled();
		} finally {
			remove();
		}
		await run;
		expect(s.canvas.close).toHaveBeenCalled();
		expect(h.abort).not.toHaveBeenCalled();
		expect(h.composer.expandedText()).toBe("unchanged [Image #1]");
		expect(h.composer.pendingImages).toEqual([existing]);
		expect(h.listeners.size).toBe(0);
		expect(h.statuses.size).toBe(0);
	});

	it("does not restore the consumed command on browser cancellation or launch failure", async () => {
		const h = createHarness();
		const s = service();
		h.composer.setText("/sketch");
		const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		s.canvas.cancel();
		await run;
		expect(h.composer.text()).toBe("");
		s.start.mockImplementationOnce(() => {
			throw new Error("listen denied");
		});
		h.composer.setText("/sketch");
		await executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		expect(h.ctx.showError).toHaveBeenCalledWith("Sketch failed: listen denied");
		expect(h.composer.text()).toBe("");
		expect(h.listeners.size).toBe(0);
		expect(h.changes.size).toBe(0);
		expect(h.statuses.size).toBe(0);
	});

	it("closes on session replacement while PNG delivery is in flight", async () => {
		const h = createHarness();
		const s = service();
		const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		const canvas = s.canvas;
		const submission = canvas.submit(PNG);
		h.switchSession();
		h.composer.clearDraft();
		h.composer.setText("replacement draft");
		expect(await submission).toBe("stale");
		await run;
		expect(canvas.close).toHaveBeenCalled();
		expect(h.composer.text()).toBe("replacement draft");
		expect(h.composer.pendingImages).toEqual([]);
		expect(h.listeners.size).toBe(0);
		expect(h.changes.size).toBe(0);
		expect(h.statuses.size).toBe(0);
	});

	it.each(["view", "prompt", "draft", "dispose"] as const)(
		"ignores late completion after a %s change",
		async change => {
			const h = createHarness();
			const s = service();
			h.composer.setText("owner draft");
			const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
			const canvas = s.canvas;
			const submission = canvas.submit(PNG);
			if (change === "view") h.focusAgent("OtherAgent");
			if (change === "prompt") h.ctx.shell.overlays.show(() => jsx("col", {}));
			if (change === "draft") {
				h.composer.clearDraft();
				h.composer.setText("next draft");
			}
			if (change === "dispose") h.dispose();
			expect(await submission).toBe("stale");
			await run;
			expect(h.composer.pendingImages).toEqual([]);
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
		s.canvas.cancel();
		await first;
		const second = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		s.canvas.cancel();
		await second;
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
		h.composer.pendingImages.push(image);
		h.composer.pendingImageLinks.push("file:///existing.png");
		h.composer.setCollapsedText("keep [Image #1]");
		const run = executeBuiltinSlashCommand("/sketch", { ctx: h.ctx });
		expect(await s.canvas.submit(PNG)).toBe("failed");
		await run;
		expect(h.ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Sketch failed:"));
		expect(h.composer.expandedText()).toBe("keep [Image #1]");
		expect(h.composer.pendingImages).toEqual([image]);
		expect(h.prompt).not.toHaveBeenCalled();
		expect(h.listeners.size).toBe(0);
		expect(h.changes.size).toBe(0);
		expect(h.statuses.size).toBe(0);
	});
});
