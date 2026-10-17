import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgDisplayCompactToolActivity, cfgDisplayHideToolActivity } from "@oh-my-pi/pi-coding-agent/modes/settings";
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
	return {
		hideThinkingBlock: cfgHideThinkingBlock.get(settings),
		hideToolActivity: cfgDisplayHideToolActivity.get(settings),
		compactToolActivity: cfgDisplayCompactToolActivity.get(settings),
	};
}

const presets = {
	clean: { hideThinkingBlock: false, hideToolActivity: true, compactToolActivity: true },
	compact: { hideThinkingBlock: false, hideToolActivity: false, compactToolActivity: true },
	detailed: { hideThinkingBlock: true, hideToolActivity: false, compactToolActivity: false },
};

function createRuntime(settings = Settings.isolated()) {
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const prompt = vi.fn();
	const setText = vi.fn();
	return {
		settings,
		showStatus,
		showWarning,
		prompt,
		runtime: {
			ctx: {
				settings,
				editor: { setText },
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

	it("consumes explicit presets and reapplies all three preferences without invoking the model", async () => {
		const h = createRuntime();
		for (const mode of ["clean", "detailed", "compact"] as const) {
			cfgHideThinkingBlock.set(h.settings, false);
			cfgDisplayHideToolActivity.set(h.settings, true);
			cfgDisplayCompactToolActivity.set(h.settings, false);
			expect(await executeBuiltinSlashCommand(`/display ${mode}`, h.runtime)).toBe(true);
			expect(displayPreferences(h.settings)).toEqual(presets[mode]);
		}
		expect(h.prompt).not.toHaveBeenCalled();
		expect(h.showWarning).not.toHaveBeenCalled();
		for (const [status] of h.showStatus.mock.calls) {
			expect(status).toMatch(/[\u4e00-\u9fff]/);
			expect(status).not.toMatch(/[\r\n]/);
		}
	});

	it("cycles a fresh compact profile through detailed, clean and compact", async () => {
		const h = createRuntime();
		for (const mode of ["detailed", "clean", "compact"] as const) {
			expect(await executeBuiltinSlashCommand("/display", h.runtime)).toBe(true);
			expect(displayPreferences(h.settings)).toEqual(presets[mode]);
		}
	});

	it("derives the cycle from independent tool preferences rather than thinking visibility", async () => {
		const h = createRuntime();
		cfgHideThinkingBlock.set(h.settings, false);
		cfgDisplayHideToolActivity.set(h.settings, true);
		cfgDisplayCompactToolActivity.set(h.settings, false);
		await executeBuiltinSlashCommand("/display", h.runtime);
		expect(displayPreferences(h.settings)).toEqual(presets.compact);
		cfgHideThinkingBlock.set(h.settings, true);
		await executeBuiltinSlashCommand("/display", h.runtime);
		expect(displayPreferences(h.settings)).toEqual(presets.detailed);
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
		for (const [warning] of h.showWarning.mock.calls) {
			expect(warning).toContain("/display");
			expect(warning).toMatch(/[\u4e00-\u9fff]/);
		}
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(h.prompt).not.toHaveBeenCalled();
	});

	it("reports runtime overrides instead of claiming a blocked preset is active", async () => {
		const h = createRuntime();
		cfgHideThinkingBlock.override(h.settings, true);
		cfgDisplayHideToolActivity.override(h.settings, true);
		for (const mode of ["compact", "detailed"] as const) {
			await executeBuiltinSlashCommand(`/display ${mode}`, h.runtime);
			expect(displayPreferences(h.settings)).toEqual({
				hideThinkingBlock: true,
				hideToolActivity: true,
				compactToolActivity: mode === "compact",
			});
			expect(h.settings.getGlobalSettings()).toMatchObject({
				hideThinkingBlock: mode === "detailed",
				display: { hideToolActivity: false, compactToolActivity: mode === "compact" },
			});
			expect(h.showStatus).not.toHaveBeenCalled();
			const warning = h.showWarning.mock.calls.at(-1)?.[0];
			// Detailed hides the thinking window itself, so only compact's
			// thinking preference can still be blocked by the override.
			expect(warning).toContain("display.hideToolActivity");
			expect(warning).toContain("运行时");
			if (mode === "compact") expect(warning).toContain("hideThinkingBlock");
			expect(warning).toMatch(/实时思考窗口隐藏.*工具隐藏/);
		}
	});

	it("reports a partially applied preset when project settings keep thinking hidden", async () => {
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
			hideThinkingBlock: true,
			hideToolActivity: false,
			compactToolActivity: true,
		});
		expect(settings.getGlobalSettings()).toMatchObject({
			hideThinkingBlock: false,
			display: { hideToolActivity: false, compactToolActivity: true },
		});
		expect(h.showStatus).not.toHaveBeenCalled();
		const warning = h.showWarning.mock.calls[0]?.[0];
		expect(warning).toContain("hideThinkingBlock");
		expect(warning).toContain("项目配置");
		expect(warning).toMatch(/实时思考窗口隐藏.*工具单行/);
		await settings.flush();
	});

	it("persists each preset and continues the cycle after reloading the profile", async () => {
		tempDir = TempDir.createSync("@pi-display-");
		const agentDir = tempDir.join("agent");
		const cwd = tempDir.join("project");
		for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
		let settings = await Settings.loadIsolated({ agentDir, cwd });
		for (const [mode, next] of [
			["clean", "compact"],
			["compact", "detailed"],
			["detailed", "clean"],
		] as const) {
			await executeBuiltinSlashCommand(`/display ${mode}`, createRuntime(settings).runtime);
			await settings.flush();
			settings = await Settings.loadIsolated({ agentDir, cwd });
			expect(displayPreferences(settings)).toEqual(presets[mode]);
			await executeBuiltinSlashCommand("/display", createRuntime(settings).runtime);
			expect(displayPreferences(settings)).toEqual(presets[next]);
			await settings.flush();
		}
	});

	it("keeps bare invocation available while completing explicit presets", async () => {
		const command = BUILTIN_SLASH_COMMANDS.find(entry => entry.name === "display");
		expect(await command?.getArgumentCompletions?.("")).toBeNull();
		for (const mode of ["clean", "compact", "detailed"]) {
			const matches = await command?.getArgumentCompletions?.(mode);
			expect(matches?.map(match => match.value)).toEqual([`${mode} `]);
			expect(matches?.[0]?.description).toContain("实时思考窗口");
			expect(matches?.[0]?.description).toContain(mode === "detailed" ? "隐藏实时" : "显示实时");
		}
	});
});
