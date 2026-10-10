import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSlowtestArgs, runSlowtest, type SlowtestDependencies } from "./slowtest";
import type { WslSelection, WslStageResult } from "./slowtest-wsl-stage";
import { runGate } from "./test-gate-runtime";

let temporary: string;
let stub: string;
beforeAll(async () => {
	temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-slowtest-mechanism-"));
	stub = path.join(temporary, "stub.ts");
	await fs.writeFile(
		stub,
		`
import * as fs from "node:fs/promises";
import { watch } from "node:fs";
import * as path from "node:path";
const [record, barrier, role, code] = process.argv.slice(2);
if (barrier !== "none") {
 const peer = role === "current" ? "linux" : "current";
 const ready = Promise.withResolvers();
 const watcher = watch(barrier, (_event, name) => { if (String(name) === peer) ready.resolve(); });
 try {
  await fs.writeFile(path.join(barrier, role), "");
  try { await fs.access(path.join(barrier, peer)); } catch { await ready.promise; }
 } finally { watcher.close(); }
}
await fs.appendFile(record, JSON.stringify({role})+"\\n");
process.exit(Number(code));
`,
	);
});
afterAll(async () => {
	await fs.rm(temporary, { recursive: true, force: true });
});
async function fixture(selection: WslSelection, dirty = false) {
	const directory = await fs.mkdtemp(path.join(temporary, "case-"));
	const root = path.join(directory, "source");
	await fs.mkdir(root);
	await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
	const localRecord = path.join(directory, "current.jsonl");
	const linuxRecord = path.join(directory, "linux.jsonl");
	const deps: SlowtestDependencies = {
		discover: async () => selection,
		identity: async () => ({
			head: "a".repeat(40),
			digest: await fs.readFile(path.join(root, "source.ts"), "utf8"),
			dirty,
			status: dirty ? " M source.ts\n?? new.ts\n" : "",
			files: [],
		}),
		fulltest: async gate => {
			await gate.run({
				label: "isolated fulltest stub",
				argv: [process.execPath, stub, localRecord, "none", "current", "0"],
			});
		},
		wsl: async (gate, options) => {
			if (selection.status !== "AVAILABLE") return selection;
			await gate.run({
				label: "isolated Linux stub",
				argv: [process.execPath, stub, linuxRecord, "none", "linux", "0"],
			});
			return { status: "PASS", distro: selection.distro, head: options.identity!.head };
		},
	};
	const execute = () =>
		runGate("slowtest", gate => runSlowtest(gate, { root, debug: false }, deps), {
			limitSeconds: 20,
			print: () => {},
		});
	const records = async (file: string): Promise<Array<{ role: string }>> =>
		(await fs.readFile(file, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
	return { root, deps, execute, records, localRecord, linuxRecord };
}

describe("slowtest isolated mechanism", () => {
	test.each([
		{ status: "SKIPPED_WSL_UNAVAILABLE", reason: "no compatible WSL" },
		{ status: "SKIPPED_NOT_APPLICABLE", reason: "no project need" },
	] as WslSelection[])(
		"executes current validation once when extension is $status, including dirty source",
		async selection => {
			const f = await fixture(selection, true);
			expect((await f.execute()).status).toBe("PASS");
			expect(await f.records(f.localRecord)).toHaveLength(1);
			await expect(fs.stat(f.linuxRecord)).rejects.toMatchObject({ code: "ENOENT" });
		},
		20000,
	);

	test("dirty source blocks WSL without transferring it and still runs fulltest once", async () => {
		const f = await fixture({ status: "AVAILABLE", distro: "Ubuntu-24.04" }, true);
		f.deps.wsl = async () => {
			throw new Error("dirty source must never enter WSL stage");
		};
		expect((await f.execute()).status).toBe("FAIL");
		expect(await f.records(f.localRecord)).toHaveLength(1);
		await expect(fs.stat(f.linuxRecord)).rejects.toMatchObject({ code: "ENOENT" });
	}, 20000);

	test("clean fixed-commit independent platform processes overlap", async () => {
		const f = await fixture({ status: "AVAILABLE", distro: "Ubuntu-24.04" });
		const barrier = await fs.mkdtemp(path.join(temporary, "concurrency-"));
		f.deps.fulltest = async gate => {
			await gate.run({
				label: "current stub",
				argv: [process.execPath, stub, f.localRecord, barrier, "current", "0"],
			});
		};
		f.deps.wsl = async (gate, options) => {
			await gate.run({ label: "Linux stub", argv: [process.execPath, stub, f.linuxRecord, barrier, "linux", "0"] });
			return { status: "PASS", distro: "Ubuntu-24.04", head: options.identity!.head };
		};
		expect((await f.execute()).status).toBe("PASS");
		expect(await f.records(f.localRecord)).toEqual([{ role: "current" }]);
		expect(await f.records(f.linuxRecord)).toEqual([{ role: "linux" }]);
	}, 20000);

	test.each(["BLOCKED", "UNVERIFIED", "FAIL", "TIMEOUT", "CANCELLED"] as const)(
		"available WSL $0 is nonpassing and retains local fulltest",
		async status => {
			const f = await fixture({ status: "AVAILABLE", distro: "Ubuntu-24.04" });
			f.deps.wsl = async () => ({
				status,
				reason: "inert failure",
				exitCode: status === "TIMEOUT" ? 124 : status === "CANCELLED" ? 130 : 17,
			});
			const result = await f.execute();
			expect(result.status).not.toBe("PASS");
			expect(result.exitCode).toBe(status === "TIMEOUT" ? 124 : status === "CANCELLED" ? 130 : 17);
			expect(await f.records(f.localRecord)).toHaveLength(1);
		},
		20000,
	);

	test("unexpected discovery failure does not omit reachable fulltest", async () => {
		const f = await fixture({ status: "AVAILABLE", distro: "Ubuntu-24.04" });
		f.deps.discover = async () => {
			throw new Error("WSL service probe blocked");
		};
		expect((await f.execute()).status).toBe("FAIL");
		expect(await f.records(f.localRecord)).toHaveLength(1);
	}, 20000);

	test("source changes during current validation cannot verify one identity", async () => {
		const f = await fixture({ status: "SKIPPED_NOT_APPLICABLE", reason: "fixture" });
		const original = f.deps.fulltest;
		f.deps.fulltest = async (gate, options) => {
			await original(gate, options);
			await gate.charged(() => fs.writeFile(path.join(f.root, "source.ts"), "changed during validation\n"));
		};
		expect((await f.execute()).status).toBe("FAIL");
	}, 20000);

	test("mismatching Linux fixed commit fails despite successful extension", async () => {
		const f = await fixture({ status: "AVAILABLE", distro: "Ubuntu-24.04" });
		f.deps.wsl = async (): Promise<WslStageResult> => ({
			status: "PASS",
			distro: "Ubuntu-24.04",
			head: "b".repeat(40),
		});
		expect((await f.execute()).status).toBe("FAIL");
	}, 20000);
});

test("slowtest rejects budget relaxation and ambiguous options", () => {
	expect(parseSlowtestArgs(["--limit-seconds=15", "--debug"])).toEqual({ debug: true, limitSeconds: 15 });
	for (const args of [
		["--release"],
		["--limit-seconds"],
		["--limit-seconds", "15"],
		["--limit-seconds=1501"],
		["--limit-seconds=0"],
		["--limit-seconds=NaN"],
		["--limit-seconds=15", "--limit-seconds=14"],
	])
		expect(parseSlowtestArgs(args)).toBeNull();
});
test("invalid slowtest CLI arguments still print the whole-run summary", async () => {
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "slowtest.ts"), "--invalid-gate-option"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode).toBe(2);
	expect(stdout).toMatch(
		/slowtest: FAIL total=[\d.]+s compile_excluded=[\d.]+s budgeted=[\d.]+s limit=1500\.0s exit=2/,
	);
});
