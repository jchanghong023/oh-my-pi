import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { cfgDisplayMode, type DisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";
import {
	BUILTIN_SLASH_COMMANDS,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

function displayPreferences(settings: Settings) {
	return { mode: cfgDisplayMode.get(settings), hideThinkingBlock: cfgHideThinkingBlock.get(settings) };
}

const modes = ["detailed", "concise", "clean", "compact"] as const;

function createRuntime(settings = Settings.isolated()) {
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const prompt = vi.fn();
	const setText = vi.fn();
	let displayMode: DisplayMode | undefined;
	return {
		settings,
		showStatus,
		showWarning,
		prompt,
		runtime: {
			ctx: {
				settings,
				composer: { setText },
				get displayMode() {
					return displayMode ?? cfgDisplayMode.get(settings);
				},
				syncDisplayMode(next: DisplayMode) {
					if ((displayMode ?? cfgDisplayMode.get(settings)) === next) return false;
					displayMode = next;
					return true;
				},
				shell: {},
				showStatus,
				showWarning,
				session: { prompt },
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/display slash command", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir | undefined;

	beforeEach(() => {
		state = beginSettingsTest();
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		Bun.gc(true);
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("consumes explicit presets without invoking the model", async () => {
		const h = createRuntime();
		cfgHideThinkingBlock.set(h.settings, true);
		for (const mode of modes) {
			cfgDisplayMode.set(h.settings, "detailed");
			expect(await executeBuiltinSlashCommand(`/display ${mode}`, h.runtime)).toBe(true);
			expect(displayPreferences(h.settings)).toEqual({ mode, hideThinkingBlock: true });
		}
		expect(h.prompt).not.toHaveBeenCalled();
		expect(h.showWarning).not.toHaveBeenCalled();
		expect(h.showStatus).toHaveBeenCalledTimes(4);
	});

	it("cycles a fresh compact profile through detailed, concise, clean and compact", async () => {
		const h = createRuntime();
		const hideThinkingBlock = cfgHideThinkingBlock.get(h.settings);
		for (const mode of modes) {
			expect(await executeBuiltinSlashCommand("/display", h.runtime)).toBe(true);
			expect(displayPreferences(h.settings)).toEqual({ mode, hideThinkingBlock });
		}
	});

	it("uses one display tier without changing independent image settings", async () => {
		const settings = Settings.isolated({
			"terminal.showImages": false,
			"images.autoResize": false,
			"images.blockImages": true,
		});
		const h = createRuntime(settings);
		expect(lookup("display.compactToolActivity")).toBeUndefined();
		for (const mode of modes) {
			await executeBuiltinSlashCommand(`/display ${mode}`, h.runtime);
			expect(lookup("terminal.showImages")?.get(settings)).toBe(false);
			expect(lookup("images.autoResize")?.get(settings)).toBe(false);
			expect(lookup("images.blockImages")?.get(settings)).toBe(true);
		}
	});

	it("derives the cycle from the display tier rather than thinking visibility", async () => {
		const h = createRuntime();
		cfgHideThinkingBlock.set(h.settings, false);
		cfgDisplayMode.set(h.settings, "clean");
		await executeBuiltinSlashCommand("/display", h.runtime);
		expect(displayPreferences(h.settings)).toEqual({ mode: "compact", hideThinkingBlock: false });
		cfgHideThinkingBlock.set(h.settings, true);
		await executeBuiltinSlashCommand("/display", h.runtime);
		expect(displayPreferences(h.settings)).toEqual({ mode: "detailed", hideThinkingBlock: true });
	});

	it("rejects unknown or extra arguments without mutating preferences", async () => {
		const h = createRuntime();
		await executeBuiltinSlashCommand("/display detailed", h.runtime);
		const before = h.settings.getGlobalSettings();
		h.showStatus.mockClear();
		for (const argument of ["other", "compact detailed", "clean extra"]) {
			expect(await executeBuiltinSlashCommand(`/display ${argument}`, h.runtime)).toBe(true);
			expect(h.settings.getGlobalSettings()).toEqual(before);
		}
		expect(h.showWarning).toHaveBeenCalledTimes(3);
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(h.prompt).not.toHaveBeenCalled();
	});

	it("selects the requested view even when a runtime value masks the saved mode", async () => {
		const h = createRuntime();
		cfgHideThinkingBlock.override(h.settings, true);
		cfgDisplayMode.override(h.settings, "clean");
		for (const mode of ["compact", "detailed"] as const) {
			await executeBuiltinSlashCommand(`/display ${mode}`, h.runtime);
			expect(displayPreferences(h.settings)).toEqual({
				mode: "clean",
				hideThinkingBlock: true,
			});
			expect(h.settings.getGlobalSettings().hideThinkingBlock).toBeUndefined();
			expect(h.settings.getGlobalSettings().display).toMatchObject({ toolActivity: mode });
			expect(h.runtime.ctx.displayMode).toBe(mode);
			expect(h.showStatus).toHaveBeenLastCalledWith(expect.stringContaining(mode));
			expect(h.showWarning).not.toHaveBeenCalled();
		}
	});

	it("leaves the project thinking preference independent of display changes", async () => {
		tempDir = TempDir.createSync("@pi-display-shadow-");
		const agentDir = tempDir.join("agent");
		const cwd = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(tempDir.join("project", ".omp"), { recursive: true });
		await Bun.write(tempDir.join("project", ".omp", "config.yml"), "hideThinkingBlock: true\n");
		const settings = await Settings.loadIsolated({ agentDir, cwd });
		const h = createRuntime(settings);
		await executeBuiltinSlashCommand("/display compact", h.runtime);
		expect(displayPreferences(settings)).toEqual({
			mode: "compact",
			hideThinkingBlock: true,
		});
		expect(settings.getGlobalSettings().hideThinkingBlock).toBeUndefined();
		expect(settings.getGlobalSettings().display).toMatchObject({ toolActivity: "compact" });
		expect(h.showStatus).toHaveBeenCalledWith(expect.stringContaining("Display mode: compact"));
		expect(h.showWarning).not.toHaveBeenCalled();
		await settings.flush();
	});

	it("persists each preset and continues the cycle after reloading the profile", async () => {
		tempDir = TempDir.createSync("@pi-display-");
		const agentDir = tempDir.join("agent");
		const cwd = tempDir.join("project");
		for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
		let settings = await Settings.loadIsolated({ agentDir, cwd });
		const hideThinkingBlock = cfgHideThinkingBlock.get(settings);
		for (const [mode, next] of [
			["clean", "compact"],
			["compact", "detailed"],
			["detailed", "concise"],
			["concise", "clean"],
		] as const) {
			await executeBuiltinSlashCommand(`/display ${mode}`, createRuntime(settings).runtime);
			await settings.flush();
			settings = await Settings.loadIsolated({ agentDir, cwd });
			expect(displayPreferences(settings)).toEqual({ mode, hideThinkingBlock });
			await executeBuiltinSlashCommand("/display", createRuntime(settings).runtime);
			expect(displayPreferences(settings)).toEqual({ mode: next, hideThinkingBlock });
			await settings.flush();
		}
	});

	it("keeps bare invocation available while completing explicit presets", async () => {
		const command = BUILTIN_SLASH_COMMANDS.find(entry => entry.name === "display");
		expect(await command?.getArgumentCompletions?.("")).toBeNull();
		for (const mode of modes) {
			const matches = await command?.getArgumentCompletions?.(mode);
			expect(matches?.map(match => match.value)).toEqual([`${mode} `]);
		}
	});
});
