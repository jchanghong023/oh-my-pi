import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(code, `git ${args.join(" ")}: ${stderr}`).toBe(0);
	return stdout.trim();
}

// Git metadata is the consumer here. These checks deliberately do not compare
// the submodule worktree/HEAD to its gitlink: local development may be dirty.
describe("OpenWiki fork source ownership metadata", () => {
	it("keeps exactly one declared OpenWiki submodule at the fork URL", async () => {
		expect(
			await git(repoRoot, "config", "--file", ".gitmodules", "--get-all", "submodule.vendor/openwiki.path"),
		).toBe("vendor/openwiki");
		expect(await git(repoRoot, "config", "--file", ".gitmodules", "--get-all", "submodule.vendor/openwiki.url")).toBe(
			"https://github.com/jchanghong023/openwiki.git",
		);
	});

	it("pins the parent release source to an available commit object, not a directory or floating branch", async () => {
		const entry = await git(repoRoot, "ls-tree", "HEAD", "--", "vendor/openwiki");
		const pinned = /^160000 commit ([a-f0-9]{40})\tvendor\/openwiki$/.exec(entry);
		if (!pinned) throw new Error(`OpenWiki must be a gitlink, got: ${entry}`);
		expect(await git(path.join(repoRoot, "vendor/openwiki"), "cat-file", "-t", pinned[1]!)).toBe("commit");
	});
});
