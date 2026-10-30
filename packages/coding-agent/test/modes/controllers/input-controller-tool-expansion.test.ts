import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgDisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("InputController tool output expansion", () => {
	it("expands children and forces a full repaint so every live block re-renders", () => {
		const expandable = { setExpanded: vi.fn() };
		const inert = { render: vi.fn(() => []) };
		const requestRender = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			toolOutputExpanded: false,
			chatContainer: { children: [expandable, inert] },
			ui: { requestRender },
			showStatus,
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(expandable.setExpanded).toHaveBeenCalledWith(true);
		// Expansion mutates every live block; the forced repaint re-renders them
		// at their new heights in the same frame.
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledWith(true);
		expect(showStatus).toHaveBeenCalledWith("Tool output expansion: enabled");
	});

	it("does not expand hidden tool activity and explains why", () => {
		const expandable = { setExpanded: vi.fn() };
		const requestRender = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
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
	it("cycles the same clean, compact and detailed settings as /display", () => {
		const settings = Settings.isolated();
		const showStatus = vi.fn();
		const controller = new InputController({ settings, showStatus } as unknown as InteractiveModeContext);
		cfgDisplayMode.set(settings, "compact");

		controller.toggleToolActivityVisibility();
		expect(cfgDisplayMode.get(settings)).toBe("detailed");
		expect(cfgHideThinkingBlock.get(settings)).toBe(false);
		expect(showStatus).toHaveBeenLastCalledWith("Display: detailed");

		controller.toggleToolActivityVisibility();
		expect(cfgDisplayMode.get(settings)).toBe("clean");
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);

		controller.toggleToolActivityVisibility();
		expect(cfgDisplayMode.get(settings)).toBe("compact");
		expect(cfgHideThinkingBlock.get(settings)).toBe(false);
	});
});
