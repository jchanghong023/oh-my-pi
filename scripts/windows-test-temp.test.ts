import { expect, test } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface TempScenario {
	platform?: string;
	env?: Record<string, string>;
	drives?: Record<string, { free?: number; fail?: "mkdir" | "write" }>;
}

// Filesystem and platform doubles live in a separate process: neither the host
// environment nor another test's node:fs module may be changed by these cases.
async function selectTemp(scenario: TempScenario) {
	const source = `
import { spyOn } from "bun:test";
import * as fs from "node:fs";
const scenario = ${JSON.stringify(scenario)};
Object.defineProperty(process, "platform", { value: scenario.platform ?? "win32" });
for (const key of Object.keys(process.env)) {
  if (["TEMP", "TMP", "SYSTEMDRIVE"].includes(key.toUpperCase())) delete process.env[key];
}
Object.assign(process.env, scenario.env ?? {});
const before = {...process.env};
const calls = [];
const drives = scenario.drives ?? {};
const drive = file => String(file).slice(0, 2).toUpperCase();
const record = (operation, file) => calls.push({operation, path: String(file)});
spyOn(fs, "existsSync").mockImplementation(file => {
  record("exists", file);
  return drive(file) in drives;
});
spyOn(fs, "mkdirSync").mockImplementation(file => {
  record("mkdir", file);
  if (drives[drive(file)]?.fail === "mkdir") throw new Error("drive is read-only");
});
spyOn(fs, "mkdtempSync").mockImplementation(prefix => {
  record("write", prefix);
  if (drives[drive(prefix)]?.fail === "write") throw new Error("write probe denied");
  return String(prefix) + "fixture";
});
spyOn(fs, "rmSync").mockImplementation(file => { record("remove", file); });
spyOn(fs, "statfsSync").mockImplementation(file => {
  record("space", file);
  const free = drives[drive(file)]?.free;
  if (free === undefined) throw new Error("space is unknown");
  return {bsize: 4096, bavail: free};
});
const {windowsTestTempOverride} = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "windows-test-temp.ts")).href)});
const result = windowsTestTempOverride();
process.stdout.write(JSON.stringify({result: result ?? null, calls, unchanged: JSON.stringify(before) === JSON.stringify({...process.env})}));
`;
	const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	const output = JSON.parse(stdout) as {
		result: { TMP: string; TEMP: string } | null;
		calls: { operation: string; path: string }[];
		unchanged: boolean;
	};
	expect(output.unchanged).toBe(true);
	return output;
}

// Existing non-system TEMP (or TMP when TEMP is absent) is authoritative.
test.each([{ TEMP: "E:\\existing", TMP: "C:\\fallback" }, { TMP: "e:/existing" }])(
	"preserves an existing non-system temporary directory: %j",
	async env => {
		const output = await selectTemp({ env: { SystemDrive: "C:", ...env }, drives: { "D:": { free: 100 } } });
		expect(output.result).toBeNull();
		expect(output.calls).toEqual([]);
	},
);

// No platform-specific override or filesystem probing is allowed on Linux.
test("non-Windows leaves the environment and filesystem untouched", async () => {
	const output = await selectTemp({ platform: "linux", env: { TEMP: "/tmp" }, drives: { "D:": { free: 100 } } });
	expect(output.result).toBeNull();
	expect(output.calls).toEqual([]);
});

// Candidates must pass both directory creation and a real-write boundary probe.
test("skips failed creation and write probes and cleans every successful probe", async () => {
	const output = await selectTemp({
		env: { SystemDrive: "C:", TEMP: "C:\\system-temp" },
		drives: { "D:": { fail: "mkdir" }, "E:": { fail: "write" }, "F:": { free: 10 } },
	});
	const selected = path.join("F:\\", "omp-test-tmp");
	expect(output.result).toEqual({ TMP: selected, TEMP: selected });
	expect(output.calls.filter(call => call.operation === "mkdir").map(call => call.path.slice(0, 2))).toEqual([
		"D:",
		"E:",
		"F:",
	]);
	const probe = output.calls.find(call => call.operation === "write" && call.path.startsWith("F:"))!;
	expect(output.calls.filter(call => call.operation === "remove")).toEqual([
		{ operation: "remove", path: `${probe.path}fixture` },
	]);
	expect(output.calls.filter(call => call.operation === "space").map(call => call.path.slice(0, 2))).toEqual(["F:"]);
});

// Free-space ranking must beat enumeration order when all sizes are known.
test("selects the writable non-system drive with the most free space", async () => {
	const output = await selectTemp({
		env: { TEMP: "C:\\system-temp" },
		drives: { "D:": { free: 2 }, "E:": { free: 9 }, "F:": { free: 4 } },
	});
	const selected = path.join("E:\\", "omp-test-tmp");
	expect(output.result).toEqual({ TMP: selected, TEMP: selected });
	expect(output.calls.filter(call => call.operation === "remove")).toHaveLength(3);
});

// Unknown capacity cannot demote the first proven-writable candidate.
test.each([undefined, 100])(
	"retains probe order when the first free-space result is unknown (later=%j)",
	async free => {
		const output = await selectTemp({
			env: { TEMP: "C:\\system-temp" },
			drives: { "D:": {}, "E:": { free } },
		});
		const selected = path.join("D:\\", "omp-test-tmp");
		expect(output.result).toEqual({ TMP: selected, TEMP: selected });
	},
);

// C: is eligible too when Windows itself is installed on another drive.
test("probes C when the system drive is D", async () => {
	const output = await selectTemp({
		env: { SystemDrive: "D:", TEMP: "D:\\system-temp" },
		drives: { "C:": { free: 10 } },
	});
	const selected = path.join("C:\\", "omp-test-tmp");
	expect(output.result).toEqual({ TMP: selected, TEMP: selected });
	expect(output.calls.filter(call => call.operation === "write").map(call => call.path.slice(0, 2))).toEqual(["C:"]);
});

// No usable alternative means callers keep their system defaults.
test("returns no override when all alternate drives are absent or unwritable", async () => {
	const output = await selectTemp({ drives: { "D:": { fail: "write" } } });
	expect(output.result).toBeNull();
	expect(output.calls.filter(call => call.operation === "remove")).toEqual([]);
});
