import { describe, expect, it } from "bun:test";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

// Execute the actual recovery block delivered to the model. Only the OS/IBus
// boundary is simulated; no real input method, process, or user file is changed.
const harness = String.raw`
import ast
import contextlib
import io
import json
import os
import subprocess
import sys
from pathlib import PurePosixPath as Path
from types import SimpleNamespace
from unittest.mock import patch
payload = json.load(sys.stdin)
source = payload["source"]
ast.parse(source, feature_version=(3, 6))
mode = payload["mode"]
state = {"restarted": False, "engine": "xkb:us::eng", "calls": []}
display = "localhost:11.0"
daemon_env = {"DISPLAY": display, "HOME": "/home/test", "DBUS_SESSION_BUS_ADDRESS": "unix:abstract=/session"}
processes = {101: (1000, daemon_env), 121: (1000, dict(daemon_env, DISPLAY="localhost:12.0"))}
if mode == "foreign_display":
    del processes[101]
if mode == "foreign_user":
    processes[101] = (1001, daemon_env)
if mode == "ambiguous":
    processes[102] = (1000, daemon_env)

def stat(path):
    name = str(path)
    if name.startswith("/proc/"):
        return SimpleNamespace(st_uid=processes[int(path.parts[2])][0])
    return SimpleNamespace(st_uid=1001 if mode == "foreign_file" else 1000)

def text(path, *args, **kwargs):
    name = str(path)
    if name.endswith("/machine-id"):
        return "machine"
    if name.endswith("/comm"):
        return "ibus-daemon\n"
    pid = 202 if state["restarted"] else (121 if mode == "stale_pid" else 101)
    address = "unix:abstract=/new" if state["restarted"] else "unix:abstract=/old"
    return "IBUS_ADDRESS=%s\nIBUS_DAEMON_PID=%d\n" % (address, pid)

def read_bytes(path):
    values = processes[int(path.parts[2])][1]
    return ("\0".join(key + "=" + value for key, value in values.items()) + "\0").encode()

def run(args, env, **kwargs):
    command = args[1:]
    state["calls"].append({"args": command, "address": env.get("IBUS_ADDRESS")})
    code, output = 0, ""
    if command == ["list-engine", "--name-only"]:
        if mode == "bus_timeout":
            raise subprocess.TimeoutExpired(args, 8)
        output = "xkb:us::eng\n" + ("" if mode == "no_engine" else "libpinyin\n")
        if mode == "reconnect_failed" and state["restarted"]:
            code = 1
    elif command == ["restart"]:
        if mode == "restart_failed":
            code = 1
        else:
            state["restarted"] = True
            processes[202] = processes.pop(101)
    elif command == ["engine", "libpinyin"]:
        if mode != "wrong_engine":
            state["engine"] = "libpinyin"
    elif command == ["engine"]:
        output = state["engine"] + "\n"
    else:
        raise AssertionError(command)
    return SimpleNamespace(returncode=code, stdout=output, stderr="")

clock = iter(range(0, 1000, 20))
output = io.StringIO()
environment = {"DISPLAY": display, "IBUS_ADDRESS": "unix:abstract=/stale-shell", "DBUS_SESSION_BUS_ADDRESS": "unix:abstract=/wrong-session"}
if mode == "missing_display":
    environment.pop("DISPLAY")
with contextlib.ExitStack() as stack:
    stack.enter_context(patch.dict(os.environ, environment, clear=True))
    stack.enter_context(patch("sys.platform", "win32" if mode == "windows" else "linux"))
    stack.enter_context(patch("os.getuid", return_value=1000, create=True))
    stack.enter_context(patch("shutil.which", return_value="/usr/bin/ibus"))
    stack.enter_context(patch("subprocess.run", run))
    stack.enter_context(patch("pathlib.Path", Path))
    stack.enter_context(patch.object(Path, "iterdir", lambda self: iter(Path("/proc") / str(pid) for pid in list(processes)), create=True))
    stack.enter_context(patch.object(Path, "stat", stat, create=True))
    stack.enter_context(patch.object(Path, "read_text", text, create=True))
    stack.enter_context(patch.object(Path, "read_bytes", read_bytes, create=True))
    stack.enter_context(patch("time.monotonic", lambda: next(clock)))
    stack.enter_context(patch("time.sleep", lambda seconds: None))
    stack.enter_context(contextlib.redirect_stdout(output))
    code = 0
    try:
        exec(compile(source, "<jchime-recovery>", "exec"), {})
    except SystemExit as error:
        code = error.code
print(json.dumps(dict(state, exitCode=code, output=output.getvalue())))
`;

interface RecoveryResult {
	exitCode: number;
	engine: string;
	restarted: boolean;
	output: string;
	calls: { args: string[]; address: string }[];
}

async function recover(mode: string): Promise<RecoveryResult> {
	const python = Bun.which("python3") ?? Bun.which("python");
	if (!python) throw new Error("Python 3.8+ is required to verify the Python 3.6 recovery syntax");
	const expanded = await executeAcpBuiltinSlashCommand("/jchime", {
		session: { model: undefined },
	} as unknown as SlashCommandRuntime);
	if (!expanded || !("prompt" in expanded)) throw new Error("Expected /jchime recovery instructions");
	const source = expanded.prompt.split("python3 - <<'JCH_IME_PY'\n")[1]?.split("\nJCH_IME_PY")[0];
	if (!source) throw new Error("Missing executable recovery block");
	const child = Bun.spawn([python, "-c", harness], {
		stdin: new TextEncoder().encode(JSON.stringify({ mode, source })),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return JSON.parse(stdout) as RecoveryResult;
}

describe("JCH IME executable recovery", () => {
	it("restarts only the matching display and selects Chinese using the newly discovered bus", async () => {
		const result = await recover("success");
		expect(result.exitCode).toBe(0);
		expect(result.engine).toBe("libpinyin");
		expect(result.calls.filter(call => call.args[0] === "restart")).toEqual([
			{ args: ["restart"], address: "unix:abstract=/old" },
		]);
		expect(result.calls.find(call => call.args.length === 2 && call.args[0] === "engine")).toEqual({
			args: ["engine", "libpinyin"],
			address: "unix:abstract=/new",
		});
		expect(result.output).toContain("JCH_IME_SERVICE_OK:");
	});

	it.each([
		"windows",
		"missing_display",
		"foreign_display",
		"foreign_user",
		"ambiguous",
		"foreign_file",
		"stale_pid",
		"no_engine",
		"bus_timeout",
	])("leaves input methods unchanged for %s", async mode => {
		const result = await recover(mode);
		expect(result.exitCode).toBe(1);
		expect(result.restarted).toBe(false);
		expect(result.calls.filter(call => call.args[0] !== "list-engine")).toEqual([]);
		expect(result.output).toContain("JCH_IME_STOP:");
	});

	it.each(["restart_failed", "reconnect_failed", "wrong_engine"])(
		"reports incomplete recovery rather than success for %s",
		async mode => {
			const result = await recover(mode);
			expect(result.exitCode).toBe(1);
			expect(result.calls.filter(call => call.args[0] === "restart")).toHaveLength(1);
			expect(result.output).toContain("JCH_IME_STOP:");
			expect(result.output).not.toContain("JCH_IME_SERVICE_OK:");
		},
	);
});
