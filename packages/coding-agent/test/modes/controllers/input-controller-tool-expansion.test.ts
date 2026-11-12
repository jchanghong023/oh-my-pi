import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgDisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

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

	it("expands file-targeted cards in compact, including unchanged and failed calls", async () => {
		await initTheme(false);
		const settings = Settings.isolated();
		cfgDisplayMode.set(settings, "compact");
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn(), resetDisplay: vi.fn() };
		const changed = new ToolExecutionComponent("write", { path: "changed.txt", content: "new" }, {}, undefined, ui);
		const unchanged = new ToolExecutionComponent(
			"write",
			{ path: "unchanged.txt", content: "same" },
			{},
			undefined,
			ui,
		);
		const failed = new ToolExecutionComponent("edit", { path: "failed.txt" }, {}, undefined, ui);
		const nonfile = new ToolExecutionComponent(
			"write",
			{ path: "agent://peer", content: "message" },
			{},
			undefined,
			ui,
		);
		const ordinary = { setExpanded: vi.fn() };
		changed.updateResult({ content: [{ type: "text", text: "written" }] }, false);
		unchanged.updateResult({ content: [{ type: "text", text: "unchanged" }] }, false);
		failed.updateResult({ content: [{ type: "text", text: "failed" }], isError: true }, false);
		// Misleading change metadata cannot turn a non-file route into a file card.
		nonfile.updateResult(
			{ content: [{ type: "text", text: "message" }], details: { fileChanged: true, diff: "-old\n+new" } },
			false,
		);
		const changedExpansion = vi.spyOn(changed, "setExpanded");
		const unchangedExpansion = vi.spyOn(unchanged, "setExpanded");
		const failedExpansion = vi.spyOn(failed, "setExpanded");
		const nonfileExpansion = vi.spyOn(nonfile, "setExpanded");
		ui.requestRender.mockClear();
		const ctx = {
			settings,
			hideToolActivity: true,
			toolOutputExpanded: false,
			chatContainer: { children: [changed, unchanged, failed, nonfile, ordinary] },
			ui,
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		try {
			const controller = new InputController(ctx);
			controller.toggleToolOutputExpansion();
			controller.toggleToolOutputExpansion();
			expect(changedExpansion.mock.calls).toEqual([[true], [false]]);
			expect(unchangedExpansion.mock.calls).toEqual([[true], [false]]);
			expect(failedExpansion.mock.calls).toEqual([[true], [false]]);
			expect(nonfileExpansion).not.toHaveBeenCalled();
			expect(ordinary.setExpanded).not.toHaveBeenCalled();
			expect(ctx.toolOutputExpanded).toBe(false);
			expect(ui.requestRender).toHaveBeenCalledTimes(2);
		} finally {
			changed.dispose();
			unchanged.dispose();
			failed.dispose();
			nonfile.dispose();
		}
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
	it("cycles the same clean, compact and detailed settings as /display", () => {
		const settings = Settings.isolated({
			"terminal.showImages": false,
			"images.autoResize": false,
			"images.blockImages": true,
		});
		const showStatus = vi.fn();
		const controller = new InputController({ settings, showStatus } as unknown as InteractiveModeContext);
		cfgDisplayMode.set(settings, "compact");
		const imagePreferences = () => ({
			showImages: lookup("terminal.showImages")?.get(settings),
			autoResize: lookup("images.autoResize")?.get(settings),
			blockImages: lookup("images.blockImages")?.get(settings),
		});
		const independentImages = { showImages: false, autoResize: false, blockImages: true };

		controller.toggleToolActivityVisibility();
		expect(cfgDisplayMode.get(settings)).toBe("detailed");
		expect(cfgHideThinkingBlock.get(settings)).toBe(false);
		expect(showStatus).toHaveBeenLastCalledWith("Display: detailed");
		expect(imagePreferences()).toEqual(independentImages);

		controller.toggleToolActivityVisibility();
		expect(cfgDisplayMode.get(settings)).toBe("clean");
		expect(cfgHideThinkingBlock.get(settings)).toBe(true);
		expect(imagePreferences()).toEqual(independentImages);

		controller.toggleToolActivityVisibility();
		expect(cfgDisplayMode.get(settings)).toBe("compact");
		expect(cfgHideThinkingBlock.get(settings)).toBe(false);
		expect(imagePreferences()).toEqual(independentImages);
	});
});
