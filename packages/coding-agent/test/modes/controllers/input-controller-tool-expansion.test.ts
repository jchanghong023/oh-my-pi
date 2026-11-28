import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import {
	cfgDisplayMode,
	cfgImagesBlockImages,
	cfgTerminalShowImages,
	type DisplayMode,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("InputController tool output expansion", () => {
	it("flips the reactive expansion flag", () => {
		const showStatus = vi.fn();
		const ctx = {
			displayMode: "detailed",
			toolOutputExpanded: false,
			hideToolActivity: false,
			showStatus,
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(showStatus).toHaveBeenCalledWith("Tool output expansion: enabled");
	});

	it("does not expand hidden tool activity and explains why", () => {
		const showStatus = vi.fn();
		const ctx = {
			displayMode: "clean",
			hideToolActivity: true,
			toolOutputExpanded: false,
			keybindings: KeybindingsManager.inMemory(),
			showStatus,
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("/settings"));
	});

	it("routes Ctrl+O to compact details without expanding detailed transcript blocks", () => {
		const toggleCompactDetails = vi.fn();
		const ctx = {
			displayMode: "compact",
			hideToolActivity: true,
			toolOutputExpanded: false,
			toggleCompactDetails,
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(toggleCompactDetails).toHaveBeenCalledTimes(1);
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(ctx.showStatus).not.toHaveBeenCalled();
	});
});

describe("InputController tool activity visibility", () => {
	it("cycles the four modes without changing independent thinking and image settings", () => {
		const settings = Settings.isolated({ "terminal.showImages": false, "images.blockImages": true });
		cfgDisplayMode.set(settings, "detailed");
		cfgHideThinkingBlock.set(settings, true);
		const showStatus = vi.fn();
		const replayHistory = vi.fn();
		const ctx = {
			settings,
			showStatus,
			displayMode: "detailed" as DisplayMode,
			syncDisplayMode(next: DisplayMode) {
				if (this.displayMode === next) return false;
				this.displayMode = next;
				return true;
			},
			shell: { host: { replayHistory } },
		};
		const controller = new InputController(ctx as unknown as InteractiveModeContext);

		for (const [display, status] of [
			["concise", "Tool activity: concise"],
			["clean", "clean"],
			["compact", "/display detailed"],
			["detailed", "Tool activity: detailed"],
		] as const) {
			controller.toggleToolActivityVisibility();
			expect(cfgDisplayMode.get(settings)).toBe(display);
			expect(cfgHideThinkingBlock.get(settings)).toBe(true);
			expect(showStatus).toHaveBeenLastCalledWith(expect.stringContaining(status));
		}
		expect(replayHistory).toHaveBeenCalledTimes(4);
		expect(cfgTerminalShowImages.get(settings)).toBe(false);
		expect(cfgImagesBlockImages.get(settings)).toBe(true);
	});

	it("cycles the live view even when a runtime value masks the saved mode", () => {
		const settings = Settings.isolated({ "display.toolActivity": "detailed" });
		const showStatus = vi.fn();
		const ctx = {
			settings,
			showStatus,
			displayMode: "detailed" as DisplayMode,
			syncDisplayMode(next: DisplayMode) {
				if (this.displayMode === next) return false;
				this.displayMode = next;
				return true;
			},
			shell: {},
		};
		const controller = new InputController(ctx as unknown as InteractiveModeContext);
		for (const [mode, status] of [["concise", "Tool activity: concise"], ["clean", "Display mode: clean"]] as const) {
			controller.toggleToolActivityVisibility();
			expect(ctx.displayMode).toBe(mode);
			expect(cfgDisplayMode.get(settings)).toBe("detailed");
			expect(settings.getGlobalSettings().display).toMatchObject({ toolActivity: mode });
			expect(showStatus).toHaveBeenLastCalledWith(status);
		}
	});
});
