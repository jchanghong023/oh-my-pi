import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as uiHelpers from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const TINY_PNG = encodeRawPng(Uint8Array.of(0, 0, 0, 255), 1, 1, 4).toString("base64");

interface ImageOwnershipHarness {
	ctx: InteractiveModeContext;
	editor: {
		pendingImages: ImageContent[];
		pendingImageLinks: (string | undefined)[];
		imageLinks: (string | undefined)[] | undefined;
		insertAtom: (text: string, label: string) => void;
		pasteText: (text: string) => void;
	};
	focus: { current: Component | null };
}

function createContext(sessionManager: SessionManager): ImageOwnershipHarness {
	const editor = {
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		imageLinks: undefined as (string | undefined)[] | undefined,
		insertAtom: vi.fn(),
		pasteText: vi.fn(),
	};
	const focus = { current: null as Component | null };
	const ctx = {
		editor,
		sessionManager,
		ui: { getFocused: () => focus.current, requestRender: vi.fn() },
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, editor, focus };
}

function expectUntouched({ ctx, editor }: ImageOwnershipHarness) {
	expect(editor.pendingImages).toEqual([]);
	expect(editor.pendingImageLinks).toEqual([]);
	expect(editor.imageLinks).toBeUndefined();
	expect(editor.insertAtom).not.toHaveBeenCalled();
	expect(editor.pasteText).not.toHaveBeenCalled();
	expect(ctx.showStatus).not.toHaveBeenCalled();
}

/** Pause the real dimension probe after chip preparation, immediately before draft commit. */
function pauseFinalDimensions() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const materialize = uiHelpers.materializeImageChipLinks;
	const metadata = Bun.Image.prototype.metadata;
	let finalProbe = false;
	spyOn(uiHelpers, "materializeImageChipLinks").mockImplementation(async (...args) => {
		const links = await materialize(...args);
		finalProbe = true;
		return links;
	});
	spyOn(Bun.Image.prototype, "metadata").mockImplementation(async function (this: Bun.Image) {
		const dimensions = await metadata.call(this);
		if (finalProbe) {
			finalProbe = false;
			entered.resolve();
			await release.promise;
		}
		return dimensions;
	});
	return { entered: entered.promise, release: () => release.resolve() };
}

function pauseImageLoad() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const load = imageLoading.loadImageInput;
	spyOn(imageLoading, "loadImageInput").mockImplementation(async options => {
		const image = await load(options);
		entered.resolve();
		await release.promise;
		return image;
	});
	return { entered: entered.promise, release: () => release.resolve() };
}

describe("guarded image path paste ownership", () => {
	let settingsState: SettingsTestState | undefined;
	let tmpDir: string;
	let imagePath: string;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-ownership-"));
		setAgentDir(tmpDir);
		sessionManager = SessionManager.inMemory(tmpDir);
		imagePath = path.join(tmpDir, "sketch.png");
		await Bun.write(imagePath, Buffer.from(TINY_PNG, "base64"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tmpDir, { recursive: true, force: true });
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	it("does not append images, links, atoms or text when ownership expires during dimensions", async () => {
		const harness = createContext(sessionManager);
		const gate = pauseFinalDimensions();
		let current = true;
		const pending = new InputController(harness.ctx).handleImagePathPaste(imagePath, () => current);
		await gate.entered;
		expectUntouched(harness);
		current = false;
		gate.release();
		await pending;
		expectUntouched(harness);
		expect(harness.ctx.ui.requestRender).not.toHaveBeenCalled();
	});

	it("does not mutate the main draft when native focus moves during dimensions", async () => {
		const harness = createContext(sessionManager);
		const gate = pauseFinalDimensions();
		const pending = new InputController(harness.ctx).handleImagePathPaste(imagePath, () => true);
		await gate.entered;
		const newFocus = { render: () => [], pasteText: vi.fn() };
		harness.focus.current = newFocus;
		gate.release();
		await pending;
		expectUntouched(harness);
		expect(newFocus.pasteText).not.toHaveBeenCalled();
	});

	it("commits a current real PNG with dimensions, link and original attachment source", async () => {
		const harness = createContext(sessionManager);
		const gate = pauseFinalDimensions();
		const pending = new InputController(harness.ctx).handleImagePathPaste(imagePath, () => true);
		await gate.entered;
		expectUntouched(harness);
		gate.release();
		await pending;
		expect(harness.editor.pendingImages).toHaveLength(1);
		const image = harness.editor.pendingImages[0]!;
		expect(image.data).toBe(TINY_PNG);
		expect(image.mimeType).toBe("image/png");
		expect(imageAttachmentSource(image)).toEqual({ path: imagePath, kind: "image" });
		expect(harness.editor.pendingImageLinks).toEqual([imagePath]);
		expect(harness.editor.imageLinks).toBe(harness.editor.pendingImageLinks);
		expect(harness.editor.insertAtom).toHaveBeenCalledWith(expect.any(String), "[Image #1, 1x1]");
		expect(harness.editor.pasteText).not.toHaveBeenCalled();
		expect(harness.ctx.showStatus).not.toHaveBeenCalled();
	});

	it("loads guarded local URLs from the owning session and keeps the relocation-safe source", async () => {
		const owningSession = SessionManager.create(tmpDir, path.join(tmpDir, "sessions"));
		const source = "local://sketch-owned.png";
		const sourcePath = resolveLocalUrlToPath(source, {
			getArtifactsDir: () => owningSession.getArtifactsDir(),
			getSessionId: () => owningSession.getSessionId(),
		});
		await Bun.write(sourcePath, Buffer.from(TINY_PNG, "base64"));
		const harness = createContext(owningSession);
		await new InputController(harness.ctx).handleImagePathPaste(source, () => true);
		expect(harness.editor.pendingImages).toHaveLength(1);
		const image = harness.editor.pendingImages[0]!;
		expect(image.data).toBe(TINY_PNG);
		expect(imageAttachmentSource(image)).toEqual({ path: source, kind: "image" });
		expect(harness.editor.insertAtom).toHaveBeenCalledWith(expect.any(String), "[Image #1, 1x1]");
		const chipPath = harness.editor.pendingImageLinks[0];
		expect(chipPath).toBeDefined();
		expect(Buffer.from(await Bun.file(chipPath!).arrayBuffer()).toBase64()).toBe(TINY_PNG);
	});

	it("drops late clipboard fallback text and status after ownership expires", async () => {
		const harness = createContext(sessionManager);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<null>();
		const controller = new InputController(harness.ctx, {
			readImage: () => {
				entered.resolve();
				return release.promise;
			},
			readText: async () => "",
		});
		let current = true;
		const pending = controller.handleImagePathPaste(path.join(tmpDir, "missing.png"), () => current);
		await entered.promise;
		current = false;
		release.resolve(null);
		await pending;
		expectUntouched(harness);
	});

	for (const reason of ["ownership expires", "focus moves"]) {
		it(`does not attach to an image-accepting prompt when ${reason} during load`, async () => {
			const harness = createContext(sessionManager);
			const finishPaste = vi.fn();
			const prompt = {
				render: () => [],
				acceptsImages: true,
				attachImage: vi.fn(() => "[Image #1, 1x1]"),
				pasteText: vi.fn(),
				beginPaste: () => finishPaste,
			};
			harness.focus.current = prompt;
			const gate = pauseImageLoad();
			let current = true;
			const pending = new InputController(harness.ctx).handleImagePathPaste(imagePath, () => current);
			await gate.entered;
			if (reason === "ownership expires") current = false;
			else harness.focus.current = null;
			gate.release();
			await pending;
			expectUntouched(harness);
			expect(prompt.attachImage).not.toHaveBeenCalled();
			expect(prompt.pasteText).not.toHaveBeenCalled();
			expect(finishPaste).toHaveBeenCalledWith(undefined);
		});
	}
});
