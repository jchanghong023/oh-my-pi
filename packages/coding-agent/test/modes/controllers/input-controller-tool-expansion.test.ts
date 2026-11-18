import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgDisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("InputController tool output expansion", () => {
	it("expands children and forces a full repaint so every live block re-renders", () => {
		const settings = Settings.isolated();
		cfgDisplayMode.set(settings, "detailed");
		const expandable = { setExpanded: vi.fn() };
		const inert = { render: vi.fn(() => []) };
		const pendingShell = { setExpanded: vi.fn() };
		const requestRender = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			settings,
			toolOutputExpanded: false,
			chatContainer: { children: [expandable, inert] },
			pendingShellContainer: { children: [pendingShell] },
			ui: { requestRender },
			showStatus,
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(expandable.setExpanded).toHaveBeenCalledWith(true);
		expect(pendingShell.setExpanded).toHaveBeenCalledWith(true);
		// Expansion mutates every live block; the forced repaint re-renders them
		// at their new heights in the same frame.
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledWith(true);
	});

	it("does not expand hidden tool activity and explains why", () => {
		const settings = Settings.isolated();
		cfgDisplayMode.set(settings, "clean");
		const expandable = { setExpanded: vi.fn() };
		const requestRender = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			settings,
			hideToolActivity: true,
			toolOutputExpanded: false,
			chatContainer: { children: [expandable] },
			keybindings: { getKeys: vi.fn(() => ["alt+h"]) },
			showStatus,
			ui: { requestRender },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(expandable.setExpanded).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("/display"));
	});
});

describe("InputController tool activity visibility", () => {
	it("cycles the same clean, compact and detailed settings as /display", async () => {
		const settings = Settings.isolated({
			"terminal.showImages": false,
			"images.autoResize": false,
			"images.blockImages": true,
		});
		const showWarning = vi.fn();
		const controller = new InputController({
			settings,
			showStatus: vi.fn(),
			showWarning,
		} as unknown as InteractiveModeContext);
		const toggle = async () => {
			controller.toggleToolActivityVisibility();
			await Promise.resolve(); // The preset reports after the settings effect.
		};
		cfgDisplayMode.set(settings, "compact");
		const imagePreferences = () => ({
			showImages: lookup("terminal.showImages")?.get(settings),
			autoResize: lookup("images.autoResize")?.get(settings),
			blockImages: lookup("images.blockImages")?.get(settings),
		});
		const independentImages = { showImages: false, autoResize: false, blockImages: true };

		await toggle();
		expect(cfgDisplayMode.get(settings)).toBe("detailed");
		expect(cfgHideThinkingBlock.get(settings)).toBe(false);
		expect(imagePreferences()).toEqual(independentImages);

		await toggle();
		expect(cfgDisplayMode.get(settings)).toBe("clean");
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(imagePreferences()).toEqual(independentImages);

		await toggle();
		expect(cfgDisplayMode.get(settings)).toBe("compact");
		expect(cfgHideThinkingBlock.get(settings)).toBe(false);
		expect(imagePreferences()).toEqual(independentImages);
		expect(showWarning).not.toHaveBeenCalled();
	});
});
