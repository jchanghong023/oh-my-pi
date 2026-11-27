import { vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { checkPythonKernelAvailability, PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { $which } from "@oh-my-pi/pi-utils";

/** Resolve a working interpreter for real Python tests without loading user settings. */
export async function requireTestPython(cwd = process.cwd()): Promise<string> {
	const command = Bun.env.PYTHON;
	const explicit = command ? ($which(command) ?? command) : undefined;
	const availability = await checkPythonKernelAvailability(cwd, explicit, {
		forceProbe: true,
		settings: Settings.isolated(),
	});
	if (!availability.ok || !availability.pythonPath) {
		throw new Error(availability.reason ?? "Python kernel unavailable");
	}
	return availability.pythonPath;
}

/** Run one cell with the same builtin injection and prelude initialization as eval. */
export async function runPrelude(code: string, env: Record<string, string>): Promise<string> {
	const cwd = process.cwd();
	const interpreter = await requireTestPython(cwd);
	const settingsInit = vi.spyOn(Settings, "init").mockResolvedValue(Settings.isolated());
	let kernel: PythonKernel;
	try {
		kernel = await PythonKernel.start({ cwd, env, interpreter });
	} finally {
		settingsInit.mockRestore();
	}
	try {
		let output = "";
		const result = await kernel.execute(code, {
			id: "run",
			timeoutMs: 10_000,
			onChunk: chunk => {
				output += chunk;
			},
		});
		if (result.status !== "ok") throw new Error(result.error?.traceback.join("\n") || output || "Python cell failed");
		return output;
	} finally {
		await kernel.shutdown();
	}
}
