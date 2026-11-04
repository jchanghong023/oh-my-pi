import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { runCli } from "../../src/cli";

describe("same-OMP workflow child entry", () => {
	// Dispatch the real hidden selector; profile and ordinary CLI argument parsing are not involved.
	test("injects VM, readline and process streams into the entry's exported start", async () => {
		await using root = await TempDir.create("zcode-workflow-entry-");
		const proof = root.join("injected.json");
		const entry = root.join("sandbox.ts");
		await Bun.write(
			entry,
			`export async function start({ vm, createInterface, stdin, stdout }) {
  await Bun.write(${JSON.stringify(proof)}, JSON.stringify({
    value: vm.runInNewContext("6 * 7"),
    readline: typeof createInterface,
    stdin: stdin === process.stdin,
    stdout: stdout === process.stdout,
  }));
}\n`,
		);
		await runCli(["__zcode_dwf_child", entry]);
		expect(await Bun.file(proof).json()).toEqual({ value: 42, readline: "function", stdin: true, stdout: true });
	});

	// Invalid arity must fail before importing the entry, never guess which path to execute.
	test("rejects missing, empty and excess entry arguments before executing any module", async () => {
		await using root = await TempDir.create("zcode-workflow-arity-");
		const marker = root.join("executed.txt");
		const entry = root.join("must-not-import.ts");
		await Bun.write(entry, `await Bun.write(${JSON.stringify(marker)}, "executed"); export function start() {}\n`);
		for (const args of [[], [""], [entry, entry]]) {
			await expect(runCli(["__zcode_dwf_child", ...args])).rejects.toThrow(
				"requires exactly one sandbox entry file",
			);
			expect(await Bun.file(marker).exists()).toBe(false);
		}
	});

	// An arbitrary module is not a valid sandbox entry merely because it can be imported.
	test("rejects an entry without a callable start export", async () => {
		await using root = await TempDir.create("zcode-workflow-export-");
		const entry = root.join("no-start.ts");
		await Bun.write(entry, 'export const start = "not callable";\n');
		await expect(runCli(["__zcode_dwf_child", entry])).rejects.toThrow("Workflow sandbox entry must export start");
	});
});
