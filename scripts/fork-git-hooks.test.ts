import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

async function git(...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(code, `git ${args.join(" ")}: ${stderr}`).toBe(0);
	return stdout.trim();
}

it("disables hooks in this checkout and retains no dormant hook files", async () => {
	expect(await git("config", "--local", "--null", "--get-all", "core.hooksPath")).toBe("/dev/null\0");
	const commonDir = await git("rev-parse", "--git-common-dir");
	const hooks = path.resolve(repoRoot, commonDir, "hooks");
	let entries: string[];
	try {
		entries = await fs.readdir(hooks);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		entries = [];
	}
	expect(entries).toEqual([]);
});
