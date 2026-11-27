/**
 * Repro for #2375: remote (SSH) image attachment surfaces only the local path.
 *
 * When a user attaches an image in their LOCAL terminal (e.g. drag/drop into
 * iTerm2 on macOS) while the omp process actually runs on a remote host (Pi
 * over SSH), the terminal forwards a bracketed-paste containing the local
 * macOS path. The remote `handleImagePathPaste` tries to read that path on
 * the remote filesystem, fails (ENOENT), then falls through to pasting the
 * unresolvable path as plain text — making it look like the image was
 * "attached as a local path" when in fact nothing was sent.
 *
 * Defended contract: an unreachable image path NEVER degrades to a silent
 * text paste; the user must see an SSH-aware diagnostic so they know to
 * paste image bytes directly instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { $which, setAgentDir } from "@oh-my-pi/pi-utils";
import { chipLabel } from "../src/ui/composer/attachments";
import { Composer } from "../src/ui/composer/composer";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

// A clipboard with no image on it — the deterministic default for the
// not-found assertions so a real screenshot on the dev's clipboard cannot
// flip the new fallback path and break them.
const EMPTY_CLIPBOARD = {
	readImage: async () => null,
	readText: async () => "",
};

// Minimal 1x1 PNG used to stand in for a Win+Shift+S bitmap on the clipboard.
const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);
const hasFfmpeg = Boolean($which("ffmpeg") && $which("ffprobe"));

function createContext(cwd: string) {
	const composer = new Composer();
	const pasteText = vi.spyOn(composer, "insertText");
	const insertAtom = vi.spyOn(composer, "insertAtom");
	const showStatus = vi.fn();
	const ctx = {
		composer,
		shell: { focused: () => composer.field },
		settings: Settings.isolated({ "images.autoResize": false }),
		sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
		showStatus,
	} as unknown as InteractiveModeContext;
	return { ctx, spies: { pasteText, insertAtom, showStatus } };
}

describe("InputController.handleImagePathPaste (issue #2375)", () => {
	let tmpDir: string;
	let settingsState: SettingsTestState | undefined;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-2375-"));
		setAgentDir(tmpDir);
		delete process.env.SSH_CONNECTION;
		delete process.env.SSH_TTY;
		delete process.env.SSH_CLIENT;
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("over SSH: never pastes the unreachable path as text and surfaces an SSH-aware status", async () => {
		process.env.SSH_CONNECTION = "10.0.0.2 50000 10.0.0.1 22";
		const { ctx, spies } = createContext(tmpDir);
		const controller = new InputController(ctx, { ...EMPTY_CLIPBOARD, isTerminalLocal: () => false });
		const missing = "/Users/someone/Pictures/local-only.png";

		await controller.handleImagePathPaste(missing);

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		const status = String(spies.showStatus.mock.calls[0]?.[0] ?? "");
		expect(status).toMatch(/SSH/i);
		// The diagnostic must point at the actual remediation: paste the bytes.
		expect(status.toLowerCase()).toContain("paste");
	});

	it("locally: still avoids the misleading path-as-text fallback when the file is unreachable", async () => {
		const { ctx, spies } = createContext(tmpDir);
		const controller = new InputController(ctx, EMPTY_CLIPBOARD);
		const missing = path.join(tmpDir, "missing.png");

		await controller.handleImagePathPaste(missing);

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		const status = String(spies.showStatus.mock.calls[0]?.[0] ?? "");
		expect(status).toMatch(/not found|could not|unreadable/i);
	});

	it("sanitizes untrusted pasted-path characters and bounds length before splicing into status", async () => {
		const { ctx, spies } = createContext(tmpDir);
		const controller = new InputController(ctx, EMPTY_CLIPBOARD);
		// Keep ANSI and control characters in the pasted input while resolving to
		// a valid but missing filename, including on hosts that reject those characters.
		const hostile = `./\x1b[31mevil\x1b[0m\r\nname\twith-${"x".repeat(100)}/../missing.png`;

		await controller.handleImagePathPaste(hostile);

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		const status = String(spies.showStatus.mock.calls[0]?.[0] ?? "");
		expect(status).toMatch(/^Image not found at .*evil/);
		// No ANSI escape, no raw control bytes, no embedded newlines/tabs.
		expect(status).not.toMatch(/\x1b/);
		expect(status).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F]/);
		expect(status).not.toContain("\n");
		expect(status).not.toContain("\t");
		// The hostile path runs well past the status truncation budget; the
		// displayed path must be clamped strictly inside that budget.
		expect(status.length).toBeLessThan(hostile.length);
	});

	it("locally: attaches the clipboard image when the pasted path is a stale transient file (Win+Shift+S)", async () => {
		// Windows 11 Win+Shift+S leaves the bitmap on the clipboard, but the
		// terminal pastes the snip's packaged-app TempState path, which is
		// already gone by the time omp reads it. The bytes are still on the
		// clipboard, so the paste must succeed from there instead of dead-ending
		// on "Image not found".
		const { ctx, spies } = createContext(tmpDir);
		const controller = new InputController(ctx, {
			readImage: async () => ({ data: ONE_PX_PNG, mimeType: "image/png" }),
			readText: async () => "",
		});
		const stale = path.join(tmpDir, "MicrosoftWindows.Client.Core_cw5n1h2txyewy", "TempState", "gone.png");

		await controller.handleImagePathPaste(stale);

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).not.toHaveBeenCalled();
		expect(ctx.composer.pendingImages.length).toBe(1);
		expect(ctx.composer.pendingImages[0]?.mimeType).toBe("image/png");
	});

	it("locally: attaches the clipboard image when the pasted path resolves to a non-image file", async () => {
		// The bracketed paste can resolve to an existing file that is not a
		// decodable image (zero-byte/locked transient snip), which surfaces as a
		// null load result rather than ENOENT. The clipboard bytes must still win
		// over a degraded text paste.
		const { ctx, spies } = createContext(tmpDir);
		const controller = new InputController(ctx, {
			readImage: async () => ({ data: ONE_PX_PNG, mimeType: "image/png" }),
			readText: async () => "",
		});
		const nonImage = path.join(tmpDir, "not-an-image.png");
		await Bun.write(nonImage, "not really a png");
		try {
			await controller.handleImagePathPaste(nonImage);
		} finally {
			await Bun.file(nonImage).delete();
		}

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(ctx.composer.pendingImages.length).toBe(1);
		expect(ctx.composer.pendingImages[0]?.mimeType).toBe("image/png");
	});

	it.skipIf(!hasFfmpeg)("locally: attaches a pasted video as a preview image", async () => {
		const { ctx, spies } = createContext(tmpDir);
		const controller = new InputController(ctx, EMPTY_CLIPBOARD);
		const video = path.join(tmpDir, "preview.mp4");
		const process = Bun.spawn([
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=1:size=320x240:rate=30",
			"-pix_fmt",
			"yuv420p",
			"-c:v",
			"libx264",
			video,
		]);
		try {
			expect(await process.exited).toBe(0);

			await controller.handleImagePathPaste(video);
		} finally {
			await Bun.file(video)
				.delete()
				.catch(() => {});
		}

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).not.toHaveBeenCalled();
		expect(ctx.composer.pendingImages).toHaveLength(1);
		expect(ctx.composer.pendingImages[0]?.mimeType).toBe("image/png");
		expect(spies.insertAtom).toHaveBeenCalledWith(chipLabel("video", 1), "[Video #1, 960x480]", expect.anything());
	});
});
