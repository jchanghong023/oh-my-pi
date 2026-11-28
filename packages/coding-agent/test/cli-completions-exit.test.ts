import { expect, it } from "bun:test";
import * as path from "node:path";
import { generateLiveCompletion } from "../src/commands/completions";

it("writes the full completion script to a pipe and exits successfully", async () => {
	const expected = await generateLiveCompletion("zsh");
	const proc = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/cli.ts"), "completions", "zsh"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(code, stderr).toBe(0);
	expect(stdout).toBe(expected);
});
