import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTerminalProgramStatus } from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
	disposeProgramStatus,
	initProgramStatus,
	setProgramStatusEnabled,
	setRunStatus,
} from "@oh-my-pi/pi-coding-agent/utils/run-status";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { setTerminalHeadless, TempDir } from "@oh-my-pi/pi-utils";

describe("fork runtime defaults", () => {
	for (const mode of ["ordinary", "offline"] as const) {
		it(`${mode} resolves fork defaults and honors an explicit terminal status setting`, async () => {
			const offline = mode === "offline";
			// The offline-sensitive defaults are registered at import time: use a fresh process,
			// rather than changing OMP_OFFLINE after importing settings in the singleton bucket.
			if (process.env.OMP_DEFAULTS_CONTRACT !== mode) {
				using root = TempDir.createSync("@fork-defaults-process-");
				const env = { ...process.env };
				for (const key of Object.keys(env)) if (/^(PI_|OMP_|CLAUDE_CONFIG_DIR$)/.test(key)) delete env[key];
				Object.assign(env, {
					OMP_DEFAULTS_CONTRACT: mode,
					OMP_OFFLINE: offline ? "1" : "0",
					HOME: root.path(),
					USERPROFILE: root.path(),
					PI_CODING_AGENT_DIR: root.join("agent"),
					OMP_CONFIG_ROOT: root.join(".omp"),
				});
				const child = Bun.spawn(
					[process.execPath, "test", import.meta.path, "--test-name-pattern", `${mode} resolves fork defaults`],
					{ env, stdout: "pipe", stderr: "pipe" },
				);
				const [stdout, stderr, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(code, stdout + stderr).toBe(0);
				expect(stdout + stderr).toMatch(/1 pass/);
				return;
			}

			using root = TempDir.createSync("@fork-defaults-");
			const agentDir = root.join("agent");
			fs.mkdirSync(agentDir);
			const settings = await Settings.loadReadOnly({ cwd: root.path(), agentDir });
			if (!offline) {
				for (const [id, expected] of Object.entries({
					"recap.enabled": false,
					"startup.setupWizard": false,
					"statusLine.compactThinkingLevel": false,
					"composer.shape": "box",
					"display.showTurnTime": true,
					"display.mode": "compact",
					"mnemopi.embeddingVariant": "multilingual",
				})) {
					expect(lookup(id)?.get(settings), id).toBe(expected);
				}
			}

			const file = path.join(agentDir, "config.yml");
			const saved = `terminal:\n  programStatus: ${offline}\n`;
			await Bun.write(file, saved);
			const configured = await Settings.loadReadOnly({ cwd: root.path(), agentDir });

			const writes: string[] = [];
			const oldTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
			const previousHeadless = setTerminalHeadless(false);
			const title = spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			const output = spyOn(process.stdout, "write").mockImplementation(chunk => {
				writes.push(String(chunk));
				return true;
			});
			try {
				initProgramStatus();
				setProgramStatusEnabled(cfgTerminalProgramStatus.get(settings));
				writes.length = 0;
				setRunStatus({ state: "working" });
				expect(writes.some(chunk => chunk.startsWith("\x1b]7501;"))).toBe(!offline);

				setProgramStatusEnabled(cfgTerminalProgramStatus.get(configured));
				writes.length = 0;
				setRunStatus({ state: "done" });
				expect(writes.some(chunk => chunk.startsWith("\x1b]7501;"))).toBe(offline);
			} finally {
				disposeProgramStatus();
				output.mockRestore();
				title.mockRestore();
				if (oldTty) Object.defineProperty(process.stdout, "isTTY", oldTty);
				else Reflect.deleteProperty(process.stdout, "isTTY");
				setTerminalHeadless(previousHeadless);
			}
			expect(await Bun.file(file).text()).toBe(saved);
		}, 60_000);
	}
});
