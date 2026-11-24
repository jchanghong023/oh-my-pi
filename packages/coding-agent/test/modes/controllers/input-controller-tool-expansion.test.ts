import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { cfgDisplayMode, cfgImagesBlockImages, cfgTerminalShowImages } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("InputController tool output expansion", () => {
	it("flips the reactive expansion flag", () => {
		const showStatus = vi.fn();
		const ctx = {
			settings: Settings.isolated({ "display.mode": "detailed" }),
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
			settings: Settings.isolated({ "display.mode": "clean" }),
			hideToolActivity: true,
			toolOutputExpanded: false,
			keybindings: KeybindingsManager.inMemory(),
			showStatus,
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("/display"));
	});

	it("routes Ctrl+O to compact details without expanding detailed transcript blocks", () => {
		const toggleCompactDetails = vi.fn();
		const ctx = {
			settings: Settings.isolated({ "display.mode": "compact" }),
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
	it("cycles the shared display preset without changing independent image settings", async () => {
		const settings = Settings.isolated({ "terminal.showImages": false, "images.blockImages": true });
		cfgDisplayMode.set(settings, "detailed");
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const controller = new InputController({
			settings,
			showStatus,
			showWarning,
		} as unknown as InteractiveModeContext);

		for (const display of ["clean", "compact", "detailed"] as const) {
			controller.toggleToolActivityVisibility();
			await Promise.resolve();
			expect(cfgDisplayMode.get(settings)).toBe(display);
			expect(cfgHideThinkingBlock.get(settings)).toBe(display === "clean");
			expect(showStatus).toHaveBeenLastCalledWith(expect.stringContaining(`（${display}）`));
		}
		expect(showWarning).not.toHaveBeenCalled();
		expect(cfgTerminalShowImages.get(settings)).toBe(false);
		expect(cfgImagesBlockImages.get(settings)).toBe(true);
	});

	it("reports a setting override instead of claiming the shortcut applied it", async () => {
		const settings = Settings.isolated({ "display.mode": "detailed" });
		const showStatus = vi.fn();
		const showWarning = vi.fn();

		new InputController({
			settings,
			showStatus,
			showWarning,
		} as unknown as InteractiveModeContext).toggleToolActivityVisibility();
		await Promise.resolve();

		expect(cfgDisplayMode.get(settings)).toBe("detailed");
		expect(showStatus).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("display.mode"));
	});
});
