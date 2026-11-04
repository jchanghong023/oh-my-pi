import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseSetupArgs, runSetupCommand } from "@oh-my-pi/pi-coding-agent/cli/setup-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";

afterEach(() => vi.restoreAllMocks());

describe("explicit Python diagnostics after lazy startup", () => {
	it.each([true, false])("setup python --check still forces a probe and reports available=%s", async available => {
		const settings = Settings.isolated({ "python.interpreter": "fixture-python" });
		vi.spyOn(Settings, "init").mockResolvedValue(settings);
		const probe = vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({
			ok: available,
			pythonPath: "fixture-python",
		});
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const exitSignal = new Error("diagnostic exit");
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw exitSignal;
		});
		const args = parseSetupArgs(["setup", "python", "--check", "--json"]);
		expect(args).toEqual({ component: "python", flags: { check: true, json: true } });
		if (!args) throw new Error("Expected setup command");
		if (available) await runSetupCommand(args);
		else await expect(runSetupCommand(args)).rejects.toBe(exitSignal);
		expect(probe).toHaveBeenCalledWith(expect.any(String), "fixture-python", { forceProbe: true });
		expect(probe).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({
			available,
			pythonPath: "fixture-python",
			usingManagedEnv: false,
		});
		expect(exit).toHaveBeenCalledTimes(available ? 0 : 1);
		if (!available) expect(exit).toHaveBeenCalledWith(1);
	});
});
