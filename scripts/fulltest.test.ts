import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFastcheckArgs, runGateCommands } from "./fastcheck";
import { parseFulltestArgs, removeFulltestHome } from "./fulltest";
import { runGate } from "./test-gate-runtime";

describe("standard gate charged-budget parameters", () => {
	test("fastcheck accepts only a finite positive downward limit", () => {
		expect(parseFastcheckArgs(["--limit-seconds=0.25"])).toEqual({ limitSeconds: 0.25 });
		expect(parseFastcheckArgs(["--limit-seconds=60"])).toEqual({ limitSeconds: 60 });
		for (const args of [
			["--limit-seconds=60.01"],
			["--limit-seconds=0"],
			["--limit-seconds=-1"],
			["--limit-seconds=Infinity"],
			["--limit-seconds=NaN"],
			["--limit-seconds=1", "--limit-seconds=2"],
			["--limit=1"],
			["--debug"],
			["anything"],
		]) {
			expect(parseFastcheckArgs(args)).toBeNull();
		}
	});

	test("fulltest retains debug and rejects budget relaxation or ambiguous options", () => {
		expect(parseFulltestArgs(["--debug", "--debug"])).toEqual({ debug: true });
		expect(parseFulltestArgs(["--limit-seconds=900", "--debug"])).toEqual({ debug: true, limitSeconds: 900 });
		expect(parseFulltestArgs(["--debug", "--limit-seconds=0.25"])).toEqual({ debug: true, limitSeconds: 0.25 });
		for (const args of [
			["--limit-seconds=900.01"],
			["--limit-seconds=0"],
			["--limit-seconds=-1"],
			["--limit-seconds=Infinity"],
			["--limit-seconds=NaN"],
			["--limit-seconds=1", "--limit-seconds=2"],
			["--limit=1"],
			["--other"],
			["--debug", "anything"],
		]) {
			expect(parseFulltestArgs(args)).toBeNull();
		}
	});
});

test("mechanism selftests cannot exempt simulated compilation from a real gate", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-charged-selftest-"));
	try {
		const stub = path.join(directory, "stub.ts");
		await fs.writeFile(
			stub,
			`
process.stderr.write("OMP_GATE_EVENT " + process.env.OMP_GATE_EVENT_TOKEN + ' {"id":"simulated","kind":"compile"}\\n');
await Bun.sleep(300);
process.stderr.write("OMP_GATE_EVENT " + process.env.OMP_GATE_EVENT_TOKEN + ' {"id":"simulated","kind":"idle"}\\n');
`,
		);
		const result = await runGate(
			"fulltest",
			gate =>
				runGateCommands(gate, [
					{
						label: "isolated mechanism fixture",
						argv: [process.execPath, stub],
						kind: "charged",
					},
				]),
			{ print: () => {} },
		);
		expect(result.status).toBe("PASS");
		expect(result.compileExcludedSeconds).toBe(0);
		expect(result.budgetedSeconds).toBeGreaterThanOrEqual(0.3);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "win32")(
	"removes denied Windows junctions without deleting their targets",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-junction-cleanup-"));
		const home = path.join(directory, "home");
		const outside = path.join(directory, "outside");
		const junction = path.join(home, "cache");
		await fs.mkdir(home);
		await fs.mkdir(outside);
		await Bun.write(path.join(outside, "keep"), "outside gate ownership");
		await fs.symlink(outside, junction, "junction");
		try {
			const acl = Bun.spawn(["icacls.exe", junction, "/deny", "*S-1-1-0:(RD)", "/L"], {
				stdout: "ignore",
				stderr: "inherit",
			});
			expect(await acl.exited).toBe(0);
			await expect(fs.readdir(junction)).rejects.toMatchObject({ code: "EPERM" });
			await removeFulltestHome(home);
			await expect(fs.lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await Bun.file(path.join(outside, "keep")).text()).toBe("outside gate ownership");
		} finally {
			await removeFulltestHome(directory);
		}
	},
);
