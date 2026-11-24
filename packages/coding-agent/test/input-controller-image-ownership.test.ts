import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import * as uiHelpers from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { imageAttachmentSource } from "@oh-my-pi/pi-coding-agent/utils/image-source";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { signal } from "@oh-my-pi/pi-tui";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { createInteractiveModeContext, type ContextOverrides } from "./helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const TINY_PNG = encodeRawPng(Uint8Array.of(0, 0, 0, 255), 1, 1, 4).toString("base64");

function createContext(sessionManager: SessionManager, overrides: ContextOverrides = {}) {
	return createInteractiveModeContext({ sessionManager, ...overrides });
}

function expectUntouched({ composer, showStatus }: ReturnType<typeof createContext>) {
	expect(composer.pendingImages).toEqual([]);
	expect(composer.pendingImageLinks).toEqual([]);
	expect(composer.chips()).toEqual([]);
	expect(composer.expandedText()).toBe("");
	expect(showStatus).not.toHaveBeenCalled();
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

function pausePromptDimensions() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const metadata = Bun.Image.prototype.metadata;
	spyOn(Bun.Image.prototype, "metadata").mockImplementation(async function (this: Bun.Image) {
		const dimensions = await metadata.call(this);
		entered.resolve();
		await release.promise;
		return dimensions;
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
		const ctx = createContext(sessionManager);
		const gate = pauseFinalDimensions();
		let current = true;
		const pending = new InputController(ctx).handleImagePathPaste(imagePath, () => current);
		await gate.entered;
		expectUntouched(ctx);
		current = false;
		gate.release();
		await pending;
		expectUntouched(ctx);
	});

	it("does not mutate the main draft when native focus moves during dimensions", async () => {
		const ctx = createContext(sessionManager);
		const gate = pauseFinalDimensions();
		const pending = new InputController(ctx).handleImagePathPaste(imagePath, () => true);
		await gate.entered;
		const paste = spyOn(ctx.shell, "paste");
		const prompt = ctx.shell.overlays.show(() => jsx("col", {}));
		try {
			gate.release();
			await pending;
			expectUntouched(ctx);
			expect(paste).not.toHaveBeenCalled();
		} finally {
			prompt.close();
		}
	});

	it("commits a current real PNG with dimensions, link and original attachment source", async () => {
		const ctx = createContext(sessionManager);
		const { composer } = ctx;
		const gate = pauseFinalDimensions();
		const pending = new InputController(ctx).handleImagePathPaste(imagePath, () => true);
		await gate.entered;
		expectUntouched(ctx);
		gate.release();
		await pending;
		expect(composer.pendingImages).toHaveLength(1);
		const image = composer.pendingImages[0]!;
		expect(image.data).toBe(TINY_PNG);
		expect(image.mimeType).toBe("image/png");
		expect(imageAttachmentSource(image)).toEqual({ path: imagePath, kind: "image" });
		expect(composer.pendingImageLinks).toEqual([imagePath]);
		expect(composer.chips()).toHaveLength(1);
		expect(composer.imageLink(composer.chips()[0]!)).toBe(imagePath);
		expect(composer.expandedText().trimEnd()).toBe("[Image #1, 1x1]");
		expect(ctx.showStatus).not.toHaveBeenCalled();
	});

	it("loads guarded local URLs from the owning session and keeps the relocation-safe source", async () => {
		const owningSession = SessionManager.create(tmpDir, path.join(tmpDir, "sessions"));
		const source = "local://sketch-owned.png";
		const sourcePath = resolveLocalUrlToPath(source, {
			getArtifactsDir: () => owningSession.getArtifactsDir(),
			getSessionId: () => owningSession.getSessionId(),
		});
		await Bun.write(sourcePath, Buffer.from(TINY_PNG, "base64"));
		const ctx = createContext(owningSession);
		const { composer } = ctx;
		await new InputController(ctx).handleImagePathPaste(source, () => true);
		expect(composer.pendingImages).toHaveLength(1);
		const image = composer.pendingImages[0]!;
		expect(image.data).toBe(TINY_PNG);
		expect(imageAttachmentSource(image)).toEqual({ path: source, kind: "image" });
		expect(composer.expandedText().trimEnd()).toBe("[Image #1, 1x1]");
		const chipPath = composer.pendingImageLinks[0];
		expect(chipPath).toBeDefined();
		expect(Buffer.from(await Bun.file(chipPath!).arrayBuffer()).toBase64()).toBe(TINY_PNG);
	});

	it("drops late clipboard fallback text and status after ownership expires", async () => {
		const ctx = createContext(sessionManager);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<null>();
		const controller = new InputController(ctx, {
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
		expectUntouched(ctx);
	});

	for (const reason of ["ownership expires", "focus moves"]) {
		it(`does not attach to an image-accepting prompt when ${reason} during image preparation`, async () => {
			const target = signal<ContextOverrides["promptPasteTarget"]>(undefined);
			const ctx = createInteractiveModeContext({
				sessionManager,
				get promptPasteTarget() {
					return target();
				},
			});
			const prompt = ctx.shell.overlays.show(() => jsx("col", {}));
			const attachImage = vi.fn();
			const setText = vi.fn();
			const paste = spyOn(ctx.shell, "paste");
			target.set({ node: prompt.node, attachImage, setText });
			expect(ctx.shell.focused()).toBe(prompt.node);
			const gate = pausePromptDimensions();
			let current = true;
			const pending = new InputController(ctx).handleImagePathPaste(imagePath, () => current);
			try {
				await Promise.race([
					gate.entered,
					pending.then(() => {
						throw new Error("Guarded image paste did not probe dimensions for the focused prompt");
					}),
				]);
				if (reason === "ownership expires") current = false;
				else ctx.shell.focus(ctx.composer.field);
				gate.release();
				await pending;
				expectUntouched(ctx);
				expect(attachImage).not.toHaveBeenCalled();
				expect(setText).not.toHaveBeenCalled();
				expect(paste).not.toHaveBeenCalled();
			} finally {
				gate.release();
				target.set(undefined);
				prompt.close();
			}
		});
	}
});
