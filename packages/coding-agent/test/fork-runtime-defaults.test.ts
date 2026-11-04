import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEvalJs } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { askTimeoutMs, cfgTerminalProgramStatus } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { createTools, resolveBuiltinToolPlan, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import {
	disposeProgramStatus,
	initProgramStatus,
	setProgramStatusEnabled,
	setRunStatus,
} from "@oh-my-pi/pi-coding-agent/utils/run-status";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { setTerminalHeadless, TempDir } from "@oh-my-pi/pi-utils";

const defaults = {
	"recap.enabled": false,
	"debug.enabled": false,
	"ida.enabled": false,
	"archive.enabled": false,
	"eval.js": false,
	"ask.timeout": 60,
	"async.maxJobs": 32,
	"startup.setupWizard": false,
	"statusLine.compactThinkingLevel": false,
	"composer.shape": "box",
	"composer.predictions": true,
	"theme.dark": "titanium",
	"theme.light": "light",
	"display.showTurnTime": true,
	"display.mode": "compact",
	"lsp.enabled": false,
	"mnemopi.embeddingVariant": "multilingual",
	"stt.language": "zh-CN",
};

function value(settings: Settings, id: string): unknown {
	const handle = lookup(id);
	if (!handle) throw new Error(`Missing setting: ${id}`);
	return handle.get(settings);
}

function toolSession(cwd: string, settings: Settings, taskDepth = 0): ToolSession {
	return { cwd, settings, taskDepth, hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "" };
}

function languages(tool: EvalTool): unknown {
	const wire = toolWireSchema(tool) as { properties: { language: { enum?: string[]; const?: string } } };
	return wire.properties.language.enum ?? [wire.properties.language.const];
}

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeAllVmContexts();
});

describe("fork runtime defaults", () => {
	for (const mode of ["ordinary", "offline"] as const) {
		it(`${mode} defaults reach configuration, tool registration, execution and terminal consumers`, async () => {
			// The offline-sensitive defaults are registered at import time: use a fresh process,
			// rather than changing OMP_OFFLINE after importing settings in the singleton bucket.
			if (process.env.OMP_DEFAULTS_CONTRACT !== mode) {
				using root = TempDir.createSync("@fork-defaults-process-");
				const env = { ...process.env };
				for (const key of Object.keys(env)) if (/^(PI_|OMP_|CLAUDE_CONFIG_DIR$)/.test(key)) delete env[key];
				Object.assign(env, {
					OMP_DEFAULTS_CONTRACT: mode,
					OMP_OFFLINE: mode === "offline" ? "1" : "0",
					HOME: root.path(),
					USERPROFILE: root.path(),
					PI_CODING_AGENT_DIR: root.join("agent"),
					OMP_CONFIG_ROOT: root.join(".omp"),
				});
				const child = Bun.spawn(
					[process.execPath, "test", import.meta.path, "--test-name-pattern", `${mode} defaults reach`],
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
			for (const [id, expected] of Object.entries(defaults)) expect(value(settings, id), id).toEqual(expected);
			expect(askTimeoutMs(settings)).toBe(60_000);
			expect(cfgTerminalProgramStatus.get(settings)).toBe(mode === "ordinary");
			expect(fs.existsSync(path.join(agentDir, "config.yml"))).toBe(false);

			const probe = vi.spyOn(pyKernel, "checkPythonKernelAvailability");
			const start = vi.spyOn(pyKernel.PythonKernel, "start");
			for (const depth of [0, 1]) {
				const owner = toolSession(root.path(), settings, depth);
				const plan = await resolveBuiltinToolPlan(owner, ["eval", "debug", "ida", "lsp"]);
				expect(plan.names).toEqual(["eval"]);
				const tools = await createTools(owner, ["eval"]);
				expect(tools.map(tool => tool.name)).toEqual(["eval"]);
			}
			expect(probe).not.toHaveBeenCalled();
			expect(start).not.toHaveBeenCalled();
			const owner = toolSession(root.path(), settings);
			const evalTool = new EvalTool(owner);
			expect(languages(evalTool)).toEqual(["py"]);
			expect(evalTool.docTopics().helpers).toContain("%pip");
			expect(evalTool.docTopics().helpers).not.toContain("%bun");
			await expect(evalTool.execute("disabled-js", { language: "js", code: "print(6 * 7)" })).rejects.toThrow(
				/JavaScript backend is disabled/,
			);
			cfgEvalJs.override(settings, true);
			expect(languages(evalTool)).toEqual(["py", "js"]);
			const result = await evalTool.execute("enabled-js", { language: "js", code: "print(6 * 7)" });
			expect(result.content).toEqual(
				expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("42") })]),
			);

			for (const configured of [undefined, true, false]) {
				const active =
					configured === undefined ? settings : Settings.isolated({ "terminal.programStatus": configured });
				const writes: string[] = [];
				const oldTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
				const previousHeadless = setTerminalHeadless(false);
				vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
				Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
				const output = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
					writes.push(String(chunk));
					return true;
				});
				try {
					initProgramStatus();
					setProgramStatusEnabled(cfgTerminalProgramStatus.get(active));
					writes.length = 0;
					setRunStatus({ state: "working" });
					setRunStatus({ state: "done" });
					expect(writes).toEqual(
						(configured ?? mode === "ordinary")
							? ["\x1b]7501;state=working:app=omp\x1b\\", "\x1b]7501;state=done:app=omp\x1b\\"]
							: [],
					);
				} finally {
					disposeProgramStatus();
					output.mockRestore();
					if (oldTty) Object.defineProperty(process.stdout, "isTTY", oldTty);
					else Reflect.deleteProperty(process.stdout, "isTTY");
					setTerminalHeadless(previousHeadless);
				}
			}

			const file = path.join(agentDir, "config.yml");
			const saved =
				"theme:\n  dark: anthracite\ncomposer:\n  predictions: false\nterminal:\n  programStatus: true\nask:\n  timeout: 9\neval:\n  js: true\n";
			await Bun.write(file, saved);
			const configured = await Settings.loadReadOnly({ cwd: root.path(), agentDir });
			expect(value(configured, "theme.dark")).toBe("anthracite");
			expect(value(configured, "composer.predictions")).toBe(false);
			expect(cfgTerminalProgramStatus.get(configured)).toBe(true);
			expect(askTimeoutMs(configured)).toBe(9_000);
			expect(languages(new EvalTool(toolSession(root.path(), configured)))).toEqual(["py", "js"]);
			expect(await Bun.file(file).text()).toBe(saved);
			const savedJs = Bun.env.PI_JS;
			try {
				Bun.env.PI_JS = "0";
				expect(languages(new EvalTool(toolSession(root.path(), configured)))).toEqual(["py"]);
				cfgEvalJs.override(configured, true);
				expect(languages(new EvalTool(toolSession(root.path(), configured)))).toEqual(["py", "js"]);
			} finally {
				if (savedJs === undefined) delete Bun.env.PI_JS;
				else Bun.env.PI_JS = savedJs;
			}
		}, 60_000);
	}
});
