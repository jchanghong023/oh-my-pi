import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractGoToolExec } from "./test-gate-go";

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
