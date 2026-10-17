import { afterEach, describe, expect, it, vi } from "bun:test";
import * as bun from "bun";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	enumeratePythonRuntimes,
	filterEnv,
	resolveExplicitPythonRuntime,
	resolvePythonRuntime,
} from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import { getOfflineShmState } from "@oh-my-pi/pi-natives/offline-root";
import * as piUtils from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { cfgIdaInstall } from "../../src/ida/install";
import { resolveIdaRuntime } from "../../src/ida/runtime";
import type { ToolSession } from "../../src/tools";

describe("Python gateway environment filtering", () => {
	it("filters sensitive and unknown variables from shell env", () => {
		const env: Record<string, string | undefined> = {
			PATH: "/bin",
			HOME: "/home/test",
			OPENAI_API_KEY: "secret",
			ANTHROPIC_API_KEY: "also-secret",
			UNSAFE_TOKEN: "nope",
			PI_CUSTOM: "1",
			LC_ALL: "en_US.UTF-8",
			LD_LIBRARY_PATH: "/opt/conda/lib",
			OMP_OFFLINE: " TrUe ",
			OMP_CONFIG_ROOT: "/nfs/custom-omp-root",
			OMP_PROFILE: "chip",
			OMP_SKILLS_DIR: "/nfs/shared-skills",
			OMP_API_TOKEN: "never-inherit",
		};

		const filtered = filterEnv(env);

		expect(filtered.PATH).toBe("/bin");
		expect(filtered.HOME).toBe("/home/test");
		expect(filtered.PI_CUSTOM).toBe("1");
		expect(filtered.LC_ALL).toBe("en_US.UTF-8");
		expect(filtered.LD_LIBRARY_PATH).toBe("/opt/conda/lib");
		expect(filtered.OMP_OFFLINE).toBe(env.OMP_OFFLINE);
		expect(filtered.OMP_CONFIG_ROOT).toBe(env.OMP_CONFIG_ROOT);
		expect(filtered.OMP_PROFILE).toBe(env.OMP_PROFILE);
		expect(filtered.OMP_SKILLS_DIR).toBe(env.OMP_SKILLS_DIR);
		expect(filtered.OMP_API_TOKEN).toBeUndefined();
		expect(filtered.OPENAI_API_KEY).toBeUndefined();
		expect(filtered.ANTHROPIC_API_KEY).toBeUndefined();
		expect(filtered.UNSAFE_TOKEN).toBeUndefined();
	});

	it("preserves XDG and LC prefixed variables", () => {
		const env: Record<string, string | undefined> = {
			XDG_CONFIG_HOME: "/home/test/.config",
			XDG_RUNTIME_DIR: "/run/user/1000",
			LC_CTYPE: "UTF-8",
			LC_MESSAGES: "en_US.UTF-8",
		};

		const filtered = filterEnv(env);

		expect(filtered.XDG_CONFIG_HOME).toBe("/home/test/.config");
		expect(filtered.XDG_RUNTIME_DIR).toBe("/run/user/1000");
		expect(filtered.LC_CTYPE).toBe("UTF-8");
		expect(filtered.LC_MESSAGES).toBe("en_US.UTF-8");
	});

	const python = piUtils.$which("python3") ?? piUtils.$which("python");
	it.skipIf(process.platform !== "linux" || !python)(
		"preserves original root and profile through Python into a nested OMP process",
		async () => {
			const originalRoot = `/nfs/omp-python-${randomUUID()}`;
			const env = filterEnv({
				...process.env,
				OMP_OFFLINE: " YeS ",
				OMP_CONFIG_ROOT: originalRoot,
				OMP_PROFILE: "python-nested",
				OMP_SKILLS_DIR: "/nfs/shared-omp-skills",
				OMP_API_TOKEN: "private",
				OPENAI_API_KEY: "private",
			});
			const expected = getOfflineShmState(env)!;
			try {
				const script = `
					import { getConfigRootDir, getOfflineShmState } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-utils"))};
					console.log(JSON.stringify({
						state: getOfflineShmState(),
						configRoot: getConfigRootDir(),
						offline: process.env.OMP_OFFLINE,
						originalRoot: process.env.OMP_CONFIG_ROOT,
						profile: process.env.OMP_PROFILE,
						skills: process.env.OMP_SKILLS_DIR,
						leaked: !!(process.env.OMP_API_TOKEN || process.env.OPENAI_API_KEY),
					}));
				`;
				const child = Bun.spawn(
					[
						python!,
						"-c",
						"import subprocess, sys; sys.exit(subprocess.run(sys.argv[1:]).returncode)",
						process.execPath,
						"--eval",
						script,
					],
					{ env, stdout: "pipe", stderr: "pipe" },
				);
				const [stdout, stderr, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
				expect(JSON.parse(stdout)).toEqual({
					state: expected,
					configRoot: path.join(expected.runtimeRoot, "profiles", "python-nested"),
					offline: " YeS ",
					originalRoot,
					profile: "python-nested",
					skills: "/nfs/shared-omp-skills",
					leaked: false,
				});
			} finally {
				fs.rmSync(path.dirname(expected.runtimeRoot), { recursive: true, force: true });
			}
		},
		10_000,
	);
});

describe("enumeratePythonRuntimes", () => {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(process, "platform", platformDescriptor);
	});

	const managedDir = path.join(path.sep, "fake", ".omp", "python-env");
	const managedBin = path.join(managedDir, process.platform === "win32" ? "Scripts" : "bin");
	const managedPy = path.join(managedBin, process.platform === "win32" ? "python.exe" : "python");
	const systemPy = path.join(path.sep, "usr", "bin", "python3");
	const offlinePy = "/software/public/python/3.11.4/bin/python3.11";

	it("keeps the Eval-only fixed interpreter out of shared discovery for active environments", () => {
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
		const activeDir = path.join(path.sep, "business", ".venv");
		const activePy = path.join(activeDir, "bin", "python");
		const linuxManagedPy = path.join(managedDir, "bin", "python");
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$which").mockReturnValue(systemPy);
		vi.spyOn(fs, "existsSync").mockImplementation(candidate =>
			[offlinePy, activePy, linuxManagedPy].includes(String(candidate)),
		);
		const baseEnv = {
			OMP_OFFLINE: "1",
			PATH: "/business/.venv/bin:/usr/bin",
			VIRTUAL_ENV: activeDir,
			CONDA_PREFIX: "/business/conda",
			CONDA_DEFAULT_ENV: "business",
			PYTHONPATH: "/business/python36/site-packages",
			PYTHONHOME: "/business/python36",
			LD_LIBRARY_PATH: "/software/lib",
		};
		const originalEnv = { ...baseEnv };

		const runtimes = enumeratePythonRuntimes(path.join(path.sep, "work"), baseEnv);

		expect(runtimes.map(runtime => runtime.pythonPath)).toEqual([activePy, linuxManagedPy, systemPy]);
		expect(runtimes[0].venvPath).toBe(activeDir);
		expect(runtimes[0].env.VIRTUAL_ENV).toBe(activeDir);
		expect(runtimes[0].env.PYTHONPATH).toBe(baseEnv.PYTHONPATH);
		expect(runtimes[2].env).toEqual(baseEnv);
		expect(baseEnv).toEqual(originalEnv);
	});

	it("keeps active, managed, and system fallback order when the fixed offline interpreter is absent", () => {
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
		const activeDir = path.join(path.sep, "business", ".venv");
		const activePy = path.join(activeDir, "bin", "python");
		const linuxManagedPy = path.join(managedDir, "bin", "python");
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$which").mockReturnValue(systemPy);
		vi.spyOn(fs, "existsSync").mockImplementation(candidate =>
			[activePy, linuxManagedPy].includes(String(candidate)),
		);

		const runtimes = enumeratePythonRuntimes(path.join(path.sep, "work"), {
			OMP_OFFLINE: "1",
			VIRTUAL_ENV: activeDir,
		});

		expect(runtimes.map(runtime => runtime.pythonPath)).toEqual([activePy, linuxManagedPy, systemPy]);
	});

	it.each([
		["linux", undefined],
		["linux", "0"],
		["linux", "true"],
		["darwin", "1"],
		["win32", "1"],
	] as const)("preserves existing runtime order on %s with OMP_OFFLINE=%s", (platform, offline) => {
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
		const activeDir = path.join(path.sep, "business", ".venv");
		const binDir = platform === "win32" ? "Scripts" : "bin";
		const executable = platform === "win32" ? "python.exe" : "python";
		const activePy = path.join(activeDir, binDir, executable);
		const candidateManagedPy = path.join(managedDir, binDir, executable);
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$which").mockReturnValue(systemPy);
		vi.spyOn(fs, "existsSync").mockReturnValue(true);
		const baseEnv = { OMP_OFFLINE: offline, VIRTUAL_ENV: activeDir, PYTHONPATH: "/business/modules" };

		const runtimes = enumeratePythonRuntimes(path.join(path.sep, "work"), baseEnv);

		expect(runtimes.map(runtime => runtime.pythonPath)).toEqual([activePy, candidateManagedPy, systemPy]);
		expect(runtimes[0].env.PYTHONPATH).toBe(baseEnv.PYTHONPATH);
		expect(runtimes[2].env).toEqual(baseEnv);
	});

	it("keeps an explicit interpreter ahead of offline discovery without changing its environment", () => {
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
		const which = vi.spyOn(piUtils, "$which");
		vi.spyOn(fs, "existsSync").mockReturnValue(false);
		const explicitPy = path.join(path.sep, "business", "python3.11");
		const baseEnv = { OMP_OFFLINE: "1", VIRTUAL_ENV: "/business/venv", PYTHONPATH: "/business/modules" };

		const runtime = resolveExplicitPythonRuntime(explicitPy, path.join(path.sep, "work"), baseEnv);

		expect(runtime.pythonPath).toBe(explicitPy);
		expect(runtime.env).toEqual(baseEnv);
		expect(runtime.env).not.toBe(baseEnv);
		expect(which).not.toHaveBeenCalled();
	});

	it("keeps the Eval-only fixed interpreter out of shared discovery for project environments", () => {
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
		const cwd = path.join(path.sep, "work");
		const projectDir = path.join(cwd, ".venv");
		const projectPython = path.join(projectDir, "bin", "python");
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$which").mockReturnValue(systemPy);
		vi.spyOn(fs, "existsSync").mockImplementation(candidate =>
			[offlinePy, projectDir, projectPython].includes(String(candidate)),
		);
		const activeVenv = piUtils.$env.VIRTUAL_ENV;
		const activeConda = piUtils.$env.CONDA_PREFIX;
		try {
			delete piUtils.$env.VIRTUAL_ENV;
			delete piUtils.$env.CONDA_PREFIX;

			const runtimes = enumeratePythonRuntimes(cwd, { OMP_OFFLINE: "1" });

			expect(runtimes.map(runtime => runtime.pythonPath)).toEqual([projectPython, systemPy]);
			expect(runtimes[0].venvPath).toBe(projectDir);
		} finally {
			if (activeVenv === undefined) delete piUtils.$env.VIRTUAL_ENV;
			else piUtils.$env.VIRTUAL_ENV = activeVenv;
			if (activeConda === undefined) delete piUtils.$env.CONDA_PREFIX;
			else piUtils.$env.CONDA_PREFIX = activeConda;
		}
	});

	it.each(["active", "project"] as const)(
		"does not let Eval's fixed offline interpreter replace IDA's %s environment",
		async source => {
			Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
			const cwd = path.join(path.sep, "work", `ida-offline-${randomUUID()}`);
			const venvDir = source === "active" ? path.join(cwd, "business-venv") : path.join(cwd, ".venv");
			const venvBin = path.join(venvDir, "bin");
			const venvPython = path.join(venvBin, "python");
			const env: Record<string, string> = {
				OMP_OFFLINE: "1",
				PATH: "/usr/bin",
				PYTHONPATH: "/business/python36/site-packages",
			};
			if (source === "active") env.VIRTUAL_ENV = venvDir;
			const originalEnv = { ...env };
			const settings = Settings.isolated();
			const shellConfig = settings.getShellConfig();
			vi.spyOn(Settings, "init").mockResolvedValue(settings);
			vi.spyOn(settings, "getShellConfig").mockReturnValue({ ...shellConfig, env });
			const installDir = path.join(cwd, "ida");
			vi.spyOn(cfgIdaInstall, "get").mockReturnValue(installDir);
			vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
			vi.spyOn(piUtils, "$which").mockReturnValue(systemPy);
			vi.spyOn(fs, "existsSync").mockImplementation(candidate =>
				[offlinePy, venvDir, venvPython].includes(String(candidate)),
			);
			// Native `$` imports retain their callable across namespace spies.
			// Intercept the shared lazy ShellPromise instead, before any command
			// can run: every candidate deterministically qualifies for IDA.
			const shellPrototype = Object.getPrototypeOf(bun.$`exit 0`) as bun.$.ShellPromise;
			const probeEnv = vi.spyOn(shellPrototype, "env");
			const probe = vi
				.spyOn(shellPrototype, "nothrow")
				.mockReturnValue(Promise.resolve({ exitCode: 0 }) as unknown as bun.$.ShellPromise);
			const activeVenv = piUtils.$env.VIRTUAL_ENV;
			const activeConda = piUtils.$env.CONDA_PREFIX;
			try {
				delete piUtils.$env.VIRTUAL_ENV;
				delete piUtils.$env.CONDA_PREFIX;

				const runtime = await resolveIdaRuntime({ cwd, settings, hasUI: false } as ToolSession);

				expect(probe).toHaveBeenCalledTimes(1);
				expect(probeEnv).toHaveBeenCalledTimes(1);
				expect(runtime.pythonPath).toBe(venvPython);
				expect(probeEnv.mock.calls[0][0]).toMatchObject({
					VIRTUAL_ENV: venvDir,
					PYTHONPATH: env.PYTHONPATH,
					PATH: `${venvBin}${path.delimiter}${env.PATH}`,
				});
				expect(runtime.env).toMatchObject({
					VIRTUAL_ENV: venvDir,
					PYTHONPATH: env.PYTHONPATH,
					IDADIR: installDir,
				});
				expect(env).toEqual(originalEnv);
			} finally {
				if (activeVenv === undefined) delete piUtils.$env.VIRTUAL_ENV;
				else piUtils.$env.VIRTUAL_ENV = activeVenv;
				if (activeConda === undefined) delete piUtils.$env.CONDA_PREFIX;
				else piUtils.$env.CONDA_PREFIX = activeConda;
			}
		},
	);

	it("enumerates the managed env AND the system interpreter so a broken managed env can fall through", () => {
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$which").mockImplementation(bin => (bin === "python" ? systemPy : null));
		// Only the managed interpreter physically exists; no project/active venv.
		vi.spyOn(fs, "existsSync").mockImplementation(candidate => candidate === managedPy);

		const runtimes = enumeratePythonRuntimes(path.join(path.sep, "work"), {
			PATH: path.join(path.sep, "usr", "bin"),
		});

		expect(runtimes.map(r => r.pythonPath)).toEqual([managedPy, systemPy]);

		const [managed, system] = runtimes;
		expect(managed.venvPath).toBe(managedDir);
		expect(managed.env.VIRTUAL_ENV).toBe(managedDir);
		expect(managed.env.PATH).toBe(`${managedBin}${path.delimiter}${path.join(path.sep, "usr", "bin")}`);

		// The system candidate must not inherit the managed env's VIRTUAL_ENV/PATH mutation.
		expect(system.venvPath).toBeUndefined();
		expect(system.env.VIRTUAL_ENV).toBeUndefined();
		expect(system.env.PATH).toBe(path.join(path.sep, "usr", "bin"));
	});

	it("falls back to the system interpreter when no managed env or venv exists", () => {
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$which").mockImplementation(bin => (bin === "python" ? systemPy : null));
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		const runtimes = enumeratePythonRuntimes(path.join(path.sep, "work"), {
			PATH: path.join(path.sep, "usr", "bin"),
		});

		expect(runtimes.map(r => r.pythonPath)).toEqual([systemPy]);
		expect(resolvePythonRuntime(path.join(path.sep, "work"), {}).pythonPath).toBe(systemPy);
	});

	it("resolves an explicit interpreter without falling through to discovery", () => {
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$which").mockImplementation(bin => (bin === "python" ? systemPy : null));
		vi.spyOn(fs, "existsSync").mockReturnValue(false);
		const explicitPy = path.join(path.sep, "custom", "python3.13");

		const runtime = resolveExplicitPythonRuntime(explicitPy, path.join(path.sep, "work"), {
			PATH: path.join(path.sep, "usr", "bin"),
		});

		expect(runtime.pythonPath).toBe(explicitPy);
		expect(runtime.venvPath).toBeUndefined();
		expect(runtime.env.PATH).toBe(path.join(path.sep, "usr", "bin"));
	});

	it("sets venv env vars for an explicit interpreter inside a virtualenv", () => {
		const venvDir = path.join(path.sep, "work", ".venv");
		const binDir = path.join(venvDir, process.platform === "win32" ? "Scripts" : "bin");
		const explicitPy = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
		vi.spyOn(fs, "existsSync").mockImplementation(candidate => candidate === path.join(venvDir, "pyvenv.cfg"));

		const runtime = resolveExplicitPythonRuntime(explicitPy, path.join(path.sep, "work"), {
			PATH: path.join(path.sep, "usr", "bin"),
		});

		expect(runtime.venvPath).toBe(venvDir);
		expect(runtime.env.VIRTUAL_ENV).toBe(venvDir);
		expect(runtime.env.PATH).toBe(`${binDir}${path.delimiter}${path.join(path.sep, "usr", "bin")}`);
	});

	it("expands a home-relative explicit interpreter instead of resolving against cwd", () => {
		const home = path.join(path.sep, "home", "tester");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		const runtime = resolveExplicitPythonRuntime("~/venvs/py/bin/python", path.join(path.sep, "work"), {});

		expect(runtime.pythonPath).toBe(path.join(home, "venvs", "py", "bin", "python"));
	});

	it("resolves a relative explicit interpreter against cwd", () => {
		vi.spyOn(fs, "existsSync").mockReturnValue(false);
		// `path.sep` alone is drive-relative on Windows; resolve it so the cwd
		// is absolute on every platform.
		const cwd = path.resolve(path.sep, "work");

		const runtime = resolveExplicitPythonRuntime(path.join(".venv", "bin", "python"), cwd, {});

		expect(runtime.pythonPath).toBe(path.join(cwd, ".venv", "bin", "python"));
	});

	it("throws from resolvePythonRuntime when no interpreter can be found", () => {
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$which").mockReturnValue(null);
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		expect(enumeratePythonRuntimes(path.join(path.sep, "work"), {})).toEqual([]);
		expect(() => resolvePythonRuntime(path.join(path.sep, "work"), {})).toThrow("Python executable not found");
	});
});
