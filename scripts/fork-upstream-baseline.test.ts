import { expect, it } from "bun:test";

const baselinePath = "openspec/specs/fork-upstream-baseline/spec.md";

async function git(...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: import.meta.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(code, `git ${args.join(" ")}: ${stderr}`).toBe(0);
	return stdout.trim();
}

it("records one upstream ancestor of local main with a matching version and valid UTC date", async () => {
	const baseline = await git("show", `refs/heads/main:${baselinePath}`);
	const commits = Array.from(baseline.matchAll(/^[*-] \*\*Upstream commit\*\*[：:]\s*`([^`]+)`\s*$/gm));
	expect(commits).toHaveLength(1);
	const sha = commits[0]![1]!;
	expect(sha).toMatch(/^[a-f0-9]{40}$/);
	await git("merge-base", "--is-ancestor", sha, "refs/heads/main");

	const current = baseline.split(/^## 当前上游基线\s*$/m)[1];
	if (current === undefined) throw new Error("Missing current upstream baseline metadata");
	const versions = Array.from(current.matchAll(/^[*-] \*\*版本\*\*[：:]\s*(.+)$/gm));
	const dates = Array.from(current.matchAll(/^[*-] \*\*同步日期\*\*[：:]\s*(.+)$/gm));
	expect(versions).toHaveLength(1);
	expect(dates).toHaveLength(1);
	const version = versions[0]![1]!.trim();
	expect(version).toMatch(/^`v\d+\.\d+\.\d+`$/);
	const manifest = JSON.parse(await git("show", `${sha}:packages/coding-agent/package.json`));
	expect(version).toBe(`\`v${manifest.version}\``);

	const date = dates[0]![1]!.trim();
	expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	const midnightUtc = `${date}T00:00:00.000Z`;
	expect(new Date(midnightUtc).toISOString()).toBe(midnightUtc);
});
