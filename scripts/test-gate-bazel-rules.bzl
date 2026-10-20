"""Local gate macros: stock rules own actions, launchers and test results."""

load("@bazel_skylib//rules:native_binary.bzl", "native_binary", "native_test")
load("@bazel_skylib//rules:write_file.bzl", "write_file")

def gate_action(name, spec, bun, runner, srcs = [], tools = [], artifact_files = []):
    native.genrule(
        name = name,
        srcs = depset(srcs + [runner, spec]).to_list(),
        tools = depset(tools + [bun]).to_list(),
        outs = [name + ".success.json"] + [name + ".artifacts/" + filename for filename in artifact_files],
        cmd = '"$(location %s)" "$(location %s)" execute "$(location %s)" "$(location %s.success.json)"' % (bun, runner, spec, name),
        # genrule invokes cmd.exe /S /c: its outer quote pair is stripped
        # before parsing the quoted executable and each argument.
        cmd_bat = '""$(location %s)" "$(location %s)" execute "$(location %s)" "$(location %s.success.json)""' % (bun, runner, spec, name),
        local = True,
        tags = ["local", "no-remote", "no-sandbox"],
    )

def _quote(value, windows):
    if windows:
        return '"' + value.replace("%", "%%").replace('"', '""') + '"'
    return "'" + value.replace("'", "'\"'\"'") + "'"

def _gate_executable(
        name,
        spec,
        bun,
        runner,
        windows,
        bun_path,
        runner_path,
        spec_path,
        command_args,
        command_cwd,
        test,
        srcs = [],
        tools = [],
        **kwargs):
    # Stable absolute paths also work with Windows manifest-only runfiles.
    # All referenced files remain declared data, without random run paths.
    if test:
        # Keep tests in the direct Bun process for process-snapshot ancestry.
        # Bun dispatches its built-in subcommand before parsing preload flags.
        builtin = command_args and command_args[0] in ["test", "run"]
        arguments = [bun_path] + (command_args[:1] if builtin else []) + ["--preload", runner_path] + (command_args[1:] if builtin else command_args)
    else:
        # Package scripts do not reliably execute Bun's preload. Apply the
        # primitive environment before spawning the original command instead.
        arguments = [bun_path, runner_path, "execute", spec_path]
    if windows:
        content = ["@echo off"] + (['set "OMP_GATE_SPEC=%s"' % spec_path.replace("%", "%%")] if test else []) + [
            "cd /d %s || exit /b" % _quote(command_cwd, True),
            " ".join([_quote(value, True) for value in arguments]),
            "exit /b %errorlevel%",
            "",
        ]
    else:
        content = ["#!/bin/sh"] + (["export OMP_GATE_SPEC=%s" % _quote(spec_path, False)] if test else []) + [
            "cd %s || exit" % _quote(command_cwd, False),
            "exec %s" % " ".join([_quote(value, False) for value in arguments]),
            "",
        ]
    extension = ".bat" if windows else ".sh"
    write_file(
        name = name + "_launcher",
        out = name + ".launcher" + extension,
        content = content,
        is_executable = True,
        newline = "windows" if windows else "unix",
        tags = ["manual"],
    )
    wrapper = native_test if test else native_binary
    wrapper(
        name = name,
        src = ":" + name + "_launcher",
        out = name + extension,
        data = depset(srcs + tools + [bun, runner, spec]).to_list(),
        **kwargs
    )

def gate_test(**kwargs):
    _gate_executable(test = True, **kwargs)

# bazel run always invokes the command; only its launcher is a cached build.
# Use this for side effects whose outputs are outside Bazel's action graph.
def gate_run(**kwargs):
    _gate_executable(test = False, **kwargs)
