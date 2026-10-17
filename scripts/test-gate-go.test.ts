import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { extractGoToolExec } from "./test-gate-go";
import { runGate } from "./test-gate-runtime";

let directory: string;
let preload: string;
beforeAll(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gate-go-"));
	preload = path.join(directory, "spawn.ts");
	await fs.writeFile(
		preload,
		`Bun.spawn = (argv, options) => {
  if (argv[0] !== "go") throw new Error("Unexpected executable");
  console.log(JSON.stringify({ argv, original: options.env.OMP_GATE_ORIGINAL_GO_TOOLEXEC }));
  return { exited: Promise.resolve(0) };
};`,
	);
});
afterAll(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

it("preserves the last GOFLAGS wrapper when no explicit override is present", () => {
	expect(extractGoToolExec(["-trimpath", "./..."], '-toolexec=first "-toolexec=last --flag"')).toEqual({
		args: ["-trimpath", "./..."],
		originalWrapper: ["last", "--flag"],
	});
});

it("applies explicit flag precedence, including an empty wrapper, without mutating arguments", () => {
	const args = ["-toolexec=first", "./...", "-toolexec", "second --flag", "-toolexec="];
	expect(extractGoToolExec(args, "-toolexec=environment")).toEqual({ args: ["./..."], originalWrapper: [] });
	expect(args).toEqual(["-toolexec=first", "./...", "-toolexec", "second --flag", "-toolexec="]);
	expect(() => extractGoToolExec(["-toolexec"], "")).toThrow("Missing value for Go -toolexec");
});

it("preserves a run expression that looks like a wrapper option", () => {
	const args = ["-run", "-toolexec=not-a-wrapper", "./..."];
	expect(extractGoToolExec(args, "")).toEqual({ args, originalWrapper: [] });
	expect(args).toEqual(["-run", "-toolexec=not-a-wrapper", "./..."]);
});

it("consumes build and test-alias operands before recognizing a real wrapper override", () => {
	const args = ["-o", "-toolexec", "--test.run", "-args", "-test.skip", "--", "./..."];
	expect(extractGoToolExec([...args, "-toolexec", "'real wrapper' --option"], "-toolexec=environment")).toEqual({
		args,
		originalWrapper: ["real wrapper", "--option"],
	});
});

it("does not consume the next flag after an equal-form operand", () => {
	expect(extractGoToolExec(["--run=-args", "-toolexec=real", "./..."], "")).toEqual({
		args: ["--run=-args", "./..."],
		originalWrapper: ["real"],
	});
});

it("does not consume wrapper overrides after bare or equal-form booleans", () => {
	expect(extractGoToolExec(["-buildvcs", "-toolexec=first", "--test.v=false", "-toolexec=last", "./..."], "")).toEqual(
		{
			args: ["-buildvcs", "--test.v=false", "./..."],
			originalWrapper: ["last"],
		},
	);
});

it("honors double-dash wrapper flags in GOFLAGS and explicit final overrides", () => {
	expect(extractGoToolExec(["./..."], '-toolexec=first "--toolexec=last --flag"')).toEqual({
		args: ["./..."],
		originalWrapper: ["last", "--flag"],
	});
	expect(
		extractGoToolExec(["--toolexec=first", "--toolexec", "'final wrapper' --flag", "./..."], "-toolexec=environment"),
	).toEqual({ args: ["./..."], originalWrapper: ["final wrapper", "--flag"] });
});

it.each(["-args", "--args", "--"])("preserves test-binary arguments after %s", separator => {
	expect(extractGoToolExec(["./...", separator, "-toolexec=not-a-go-option"], "-toolexec=original")).toEqual({
		args: ["./...", separator, "-toolexec=not-a-go-option"],
		originalWrapper: ["original"],
	});
});

it.each(["equals", "separate"])("keeps the gate wrapper authoritative for explicit %s syntax", async syntax => {
	const original = "'explicit wrapper' --option";
	const args = syntax === "equals" ? [`-toolexec=${original}`] : ["-toolexec", original];
	const child = Bun.spawn(
		[
			process.execPath,
			"--preload",
			preload,
			path.join(import.meta.dir, "test-gate-go.ts"),
			"build",
			...args,
			"-trimpath",
			"./...",
		],
		{
			env: { ...process.env, GOFLAGS: '"-toolexec=environment-wrapper --from-env"' },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	const output = JSON.parse(stdout);
	expect(output.argv.slice(0, 2)).toEqual(["go", "build"]);
	expect(output.argv.slice(3)).toEqual(["-trimpath", "./..."]);
	expect(output.argv.filter((arg: string) => arg.startsWith("-toolexec="))).toHaveLength(1);
	expect(output.argv[2]).toContain("test-gate-compiler.ts");
	expect(output.argv[2]).toContain("--go");
	expect(JSON.parse(output.original)).toEqual(["explicit wrapper", "--option"]);
});

it("forwards a wrapper-looking run expression unchanged through the Go gate command", async () => {
	const args = ["-run", "-toolexec=not-a-wrapper", "./..."];
	const child = Bun.spawn(
		[process.execPath, "--preload", preload, path.join(import.meta.dir, "test-gate-go.ts"), "test", ...args],
		{
			env: { ...process.env, GOFLAGS: "" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	const output = JSON.parse(stdout);
	expect(output.argv.slice(0, 2)).toEqual(["go", "test"]);
	expect(output.argv[2]).toContain("test-gate-compiler.ts");
	expect(output.argv.slice(3)).toEqual(args);
	expect(JSON.parse(output.original)).toEqual([]);
});

it.each([
	["build", "separate"],
	["build", "equals"],
	["test", "separate"],
	["test", "equals"],
])("keeps -C first when wrapping go %s with %s syntax", async (command, syntax) => {
	const moduleDirectory = path.join(directory, "module with spaces");
	const chdir = syntax === "separate" ? ["-C", moduleDirectory] : [`-C=${moduleDirectory}`];
	const child = Bun.spawn(
		[
			process.execPath,
			"--preload",
			preload,
			path.join(import.meta.dir, "test-gate-go.ts"),
			command,
			...chdir,
			"-trimpath",
			"./...",
		],
		{
			env: { ...process.env, GOFLAGS: "" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	const { argv } = JSON.parse(stdout);
	expect(argv.slice(0, 2 + chdir.length)).toEqual(["go", command, ...chdir]);
	expect(argv[2 + chdir.length]).toStartWith("-toolexec=");
	expect(argv.slice(3 + chdir.length)).toEqual(["-trimpath", "./..."]);
});

it("charges Go test execution overlapping another package's compiler", async () => {
	const fixture = await fs.mkdtemp(path.join(directory, "parallel-"));
	try {
		const compiler = path.join(fixture, process.platform === "win32" ? "compile.exe" : "compile");
		try {
			await fs.link(process.execPath, compiler);
		} catch {
			await fs.copyFile(process.execPath, compiler);
		}
		const driver = path.join(fixture, "go-actions.ts");
		const spawnPreload = path.join(fixture, "spawn.ts");
		await fs.writeFile(
			spawnPreload,
			`const spawn = Bun.spawn;
Bun.spawn = (argv, options) => {
  if (argv[0] !== "go") throw new Error("Unexpected executable");
  return spawn([process.execPath, ${JSON.stringify(driver)}, ...argv.slice(1)], options);
};`,
		);
		// Reproduce Go's per-package action graph without requiring an installed
		// Go SDK: the test binary is not a toolexec tool. Only use an -exec
		// wrapper if the real gate command supplied one.
		await fs.writeFile(
			driver,
			`import * as fs from "node:fs/promises";
import * as path from "node:path";
import { splitGoCommand } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-gate-go.ts")).href)};
const root = ${JSON.stringify(fixture)};
const marker = name => path.join(root, name);
const wait = async name => {
  // Independent subprocesses publish filesystem barriers on the real platform
  // clock; parent fake timers cannot advance this polling backoff.
  const signal = AbortSignal.timeout(10000);
  while (true) {
    signal.throwIfAborted();
    try { await fs.access(marker(name)); return; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await Bun.sleep(5);
  }
};
const mode = process.argv[2];
if (mode === "test-binary") {
  await fs.writeFile(marker("test-started"), "");
  await wait("compiler-started");
  await fs.writeFile(marker("compiler-release"), "");
  await wait("compiler-exited");
} else if (mode === "compiler") {
  await fs.writeFile(marker("compiler-started"), "");
  await wait("compiler-release");
} else {
  const args = process.argv.slice(3);
  const flag = name => {
    let value = "";
    for (let index = 0; index < args.length; index++) {
      if (args[index] === name) value = args[++index];
      else if (args[index].startsWith(name + "=")) value = args[index].slice(name.length + 1);
    }
    return value;
  };
  const tool = splitGoCommand(flag("-toolexec"));
  const exec = splitGoCommand(flag("-exec"));
  if (mode !== "test" || !tool.length) throw new Error("Missing Go test tool wrapper");
  const running = Bun.spawn([...exec, process.execPath, import.meta.path, "test-binary"], {
    env: process.env, stdout: "inherit", stderr: "inherit"
  });
  let compiling;
  try {
    await wait("test-started");
    compiling = Bun.spawn([...tool, ${JSON.stringify(compiler)}, import.meta.path, "compiler"], {
      env: process.env, stdout: "inherit", stderr: "inherit"
    });
    const compilerExit = await compiling.exited;
    await fs.writeFile(marker("compiler-exited"), "");
    const testExit = await running.exited;
    const events = (await fs.readFile(process.env.OMP_GATE_EVENT_FILE, "utf8"))
      .trim().split("\\n").filter(Boolean)
      .map(line => JSON.parse(line.slice(line.indexOf("{"))));
    await fs.writeFile(marker("observed.json"), JSON.stringify({
      compilerExit, testExit, compileEvents: events.filter(event => event.kind === "compile").length
    }));
    process.exitCode = compilerExit || testExit;
  } finally {
    if (compiling && compiling.exitCode === null) compiling.kill();
    if (running.exitCode === null) running.kill();
    await Promise.all([compiling?.exited, running.exited]);
  }
}`,
		);
		const result = await runGate(
			"fastcheck",
			async gate => {
				await gate.run({
					label: "test/go-parallel-packages",
					argv: [
						process.execPath,
						"--preload",
						spawnPreload,
						path.join(import.meta.dir, "test-gate-go.ts"),
						"test",
						"-p=2",
						"-vet=off",
						"-count=1",
						"./...",
					],
					env: { GOFLAGS: "", BUN_BE_BUN: "1" },
				});
			},
			{ print: () => {} },
		);
		expect(result.status).toBe("PASS");
		const observed = JSON.parse(await fs.readFile(path.join(fixture, "observed.json"), "utf8"));
		expect(observed).toEqual({
			compilerExit: 0,
			testExit: 0,
			compileEvents: expect.any(Number),
		});
		expect(observed.compileEvents).toBeGreaterThan(0);
		// The compiler's entire lifetime is inside the real test subprocess's
		// lifetime, so none of its interval is provably pure compilation.
		expect(result.compileExcludedSeconds).toBe(0);
	} finally {
		await fs.rm(fixture, { recursive: true, force: true });
	}
}, 30000);
