import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as probe from "@oh-my-pi/pi-coding-agent/eval/probe";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import * as pyRuntime from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import * as piUtils from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";

function languages(tool: EvalTool): string[] {
	const wire = toolWireSchema(tool) as { properties: { language: { enum?: string[]; const?: string } } };
	const language = wire.properties.language;
	return language.enum ?? (language.const ? [language.const] : []);
}

describe("eval Python availability contract", () => {
	let dir: piUtils.TempDir;
	let savedPy: string | undefined;
	let savedJs: string | undefined;
	let savedSkipCheck: string | undefined;

	beforeEach(() => {
		dir = piUtils.TempDir.createSync("@eval-availability-contract-");
		savedPy = Bun.env.PI_PY;
		savedJs = Bun.env.PI_JS;
		savedSkipCheck = Bun.env.PI_PYTHON_SKIP_CHECK;
		delete Bun.env.PI_PY;
		delete Bun.env.PI_JS;
		delete Bun.env.PI_PYTHON_SKIP_CHECK;
		// Exercise the ordinary availability path, including its cache.
		vi.spyOn(piUtils, "isBunTestRuntime").mockReturnValue(false);
		vi.spyOn(pyRuntime, "enumeratePythonRuntimes").mockReturnValue([{ pythonPath: "/tmp/broken-python", env: {} }]);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreEnvValue("PI_PY", savedPy);
		restoreEnvValue("PI_JS", savedJs);
		restoreEnvValue("PI_PYTHON_SKIP_CHECK", savedSkipCheck);
		await dir.remove();
	});

	function session(overrides: Record<string, unknown> = {}): ToolSession {
		return {
			cwd: dir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "eval.js": true, ...overrides }),
		};
	}

	it("keeps configured languages after an execution reports a failed probe", async () => {
		const owner = session();
		const tool = new EvalTool(owner);
		const failure = "/tmp/broken-python (exit code 1)";
		const candidateProbe = vi.spyOn(probe, "probeCandidates").mockResolvedValue({
			ok: false,
			aborted: false,
			failures: [failure],
		});
		expect(languages(tool)).toEqual(["py", "js"]);
		expect(candidateProbe).not.toHaveBeenCalled();
		const execution = tool.execute("py-unavailable", { language: "py", code: "print(1)" });
		await expect(execution).rejects.toThrow(failure);
		await expect(execution).rejects.toThrow(/Python 3\.8\+.*PATH/);
		await expect(execution).rejects.not.toThrow("install the python kernel");
		expect(languages(tool)).toEqual(["py", "js"]);
		expect(candidateProbe).toHaveBeenCalledTimes(1);
	});

	it("does not turn a cancelled or deadline-limited probe into permanent unavailability", async () => {
		const owner = session();
		const tool = new EvalTool(owner);
		const candidateProbe = vi.spyOn(probe, "probeCandidates").mockResolvedValue({
			ok: false,
			aborted: true,
			failures: [],
		});
		await pyKernel.checkPythonKernelAvailability(owner.cwd, undefined, { forceProbe: true });
		expect(languages(tool)).toEqual(["py", "js"]);
		candidateProbe.mockResolvedValue({
			ok: false,
			aborted: false,
			timedOut: true,
			failures: ["/tmp/broken-python (probe timed out)"],
		});
		await pyKernel.checkPythonKernelAvailability(owner.cwd, undefined, { forceProbe: true });
		expect(languages(tool)).toEqual(["py", "js"]);
	});

	it("keeps Python advertised when it is the only enabled runtime and its probe fails", async () => {
		const owner = session({ "eval.js": false });
		const tool = new EvalTool(owner);
		expect(languages(tool)).toEqual(["py"]);
		vi.spyOn(probe, "probeCandidates").mockResolvedValue({ ok: false, aborted: false, failures: ["broken"] });
		await pyKernel.checkPythonKernelAvailability(owner.cwd, undefined, { forceProbe: true });
		expect(languages(tool)).toEqual(["py"]);
	});

	it("never probes or advertises Python when settings allow only JavaScript", () => {
		const candidateProbe = vi.spyOn(probe, "probeCandidates");
		const tool = new EvalTool(session({ "eval.py": false }));
		expect(languages(tool)).toEqual(["js"]);
		expect(candidateProbe).not.toHaveBeenCalled();
	});

	it("discovers a repaired runtime after PATH changes", async () => {
		const owner = session();
		vi.spyOn(probe, "probeCandidates")
			.mockResolvedValueOnce({ ok: false, aborted: false, failures: ["broken"] })
			.mockResolvedValueOnce({ ok: true, index: 0 });
		expect((await pyKernel.checkPythonKernelAvailability(owner.cwd)).ok).toBe(false);
		const previousPath = Bun.env.PATH;
		try {
			Bun.env.PATH = `${dir.path()}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;
			expect((await pyKernel.checkPythonKernelAvailability(owner.cwd)).ok).toBe(true);
		} finally {
			restoreEnvValue("PATH", previousPath);
		}
	});

	it("does not retain a startup failure after the Python module search environment changes", async () => {
		const owner = session();
		vi.spyOn(probe, "probeCandidates")
			.mockResolvedValueOnce({ ok: false, aborted: false, failures: ["startup failed"] })
			.mockResolvedValueOnce({ ok: true, index: 0 });
		expect((await pyKernel.checkPythonKernelAvailability(owner.cwd)).ok).toBe(false);
		const previousPath = Bun.env.PYTHONPATH;
		try {
			Bun.env.PYTHONPATH = dir.path();
			expect((await pyKernel.checkPythonKernelAvailability(owner.cwd)).ok).toBe(true);
		} finally {
			restoreEnvValue("PYTHONPATH", previousPath);
		}
	});
});
