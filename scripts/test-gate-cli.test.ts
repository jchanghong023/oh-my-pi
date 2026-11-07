import { expect, test } from "bun:test";
import * as path from "node:path";
import { parseFastcheckArgs } from "./fastcheck";
import { parseFulltestArgs, fulltestCommands } from "./fulltest";
import { parseSlowtestArgs } from "./slowtest";

const entries = [
	{ level: "fastcheck", maximum: 360, parse: parseFastcheckArgs },
	{ level: "fulltest", maximum: 1800, parse: parseFulltestArgs },
	{ level: "slowtest", maximum: 3000, parse: parseSlowtestArgs },
] as const;

// Literal entry-specific budgets enforce the specification, rather than
// deriving both the fixture and expected value from the same production constant.
test.each(entries)("$level accepts its own finite-positive limit boundaries", ({ level, maximum, parse }) => {
	for (const value of [0.125, maximum])
		expect(parse([`--limit-seconds=${value}`])).toMatchObject({ limitSeconds: value });
	for (const value of ["", "0", "-1", "NaN", "Infinity", String(maximum + 0.01)]) {
		expect(parse([`--limit-seconds=${value}`])).toBeNull();
	}
	if (level !== "fastcheck") expect(parse(["--debug"])).toMatchObject({ debug: true });
	else expect(parse(["--debug"])).toBeNull();
});

// Public error paths must reject before launching any checks, not merely return
// null from a parser unit test. All intentional failures are isolated from an outer gate.
test.each(entries)(
	"$level rejects invalid public argv with usage and a complete exit-2 summary",
	async ({ level, maximum }) => {
		for (const args of [
			["--limit-seconds=1", "--limit-seconds=2"],
			[`--limit-seconds=${maximum + 1}`],
			["--unrecognized"],
		]) {
			const child = Bun.spawn([process.execPath, path.join(import.meta.dir, `${level}.ts`), ...args], {
				env: { ...process.env, OMP_GATE_EVENT_TOKEN: "", OMP_GATE_EVENT_FILE: "", OMP_GATE_CLOCK_TOKEN: "" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, `${args.join(" ")}\n${stdout}\n${stderr}`).toBe(2);
			expect(stdout + stderr).toContain(`Usage: bun run ${level}`);
			expect(stdout).toMatch(
				new RegExp(
					`${level}: FAIL total=\\d+\\.\\ds compile_excluded=\\d+\\.\\ds budgeted=\\d+\\.\\ds limit=${maximum}\\.0s exit=2`,
				),
			);
			expect(stdout + stderr).not.toContain("scope=repository-static");
			expect(stdout + stderr).not.toContain("source tested after builds");
		}
	},
	15_000,
);

// --full changes the requested suites, never the limit or independent integration authorization.
test("full mode selects every supported language plan without enabling separate integrations", () => {
	expect(parseFulltestArgs(["--full", "--debug", "--limit-seconds=1800"])).toEqual({
		debug: true,
		full: true,
		limitSeconds: 1800,
	});
	const commands = fulltestCommands({ full: true, debug: true }, "isolated-home");
	expect(commands.map(command => command.label)).toEqual([
		"test/TypeScript fork feature suite",
		"test/TypeScript startup suite",
		"test/Rust workspace",
		"test/Python suites",
		"test/Go SDK",
		"test/Rust SDK",
		"smoke/isolated native TUI PTY",
	]);
	for (const command of commands.filter(command => command.label.startsWith("test/TypeScript"))) {
		expect(command.argv).toContain("all");
		expect(command.argv).toContain("--unsharded");
		expect(command.argv).toContain("--exclude-desktop");
		expect(command.env?.OMP_FULLTEST_AFFECTED).toBeUndefined();
	}
	for (const command of commands.filter(
		command => command.label.startsWith("test/") && !command.label.startsWith("test/TypeScript"),
	)) {
		expect(command.argv).toContain("--full");
		expect(command.env?.ROBOMP_INTEGRATION).toBe("");
		expect(command.argv).not.toContain("integration");
	}
	expect(parseSlowtestArgs(["--full"])).toBeNull();
});
