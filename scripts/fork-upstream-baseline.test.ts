import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const baselinePath = "openspec/specs/fork-upstream-baseline/spec.md";

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

// This is a repository metadata integration check, not a simulated upstream
// merge or a claim that Agent maintenance instructions execute automatically.
describe("integrated upstream baseline metadata", () => {
	it("records one complete upstream commit that is an ancestor of local main", async () => {
		const baseline = await Bun.file(path.join(repoRoot, baselinePath)).text();
		const recorded = Array.from(baseline.matchAll(/^[*-] \*\*Upstream commit\*\*[：:]\s*`([^`]+)`\s*$/gm));
		expect(recorded).toHaveLength(1);
		const sha = recorded[0]![1]!;
		expect(sha).toMatch(/^[a-f0-9]{40}$/);
		expect(await git("rev-parse", "--verify", `${sha}^{commit}`)).toBe(sha);
		await git("merge-base", "--is-ancestor", sha, "refs/heads/main");
	});

	it("matches its sole version to the integrated commit manifest and records a valid UTC date", async () => {
		const baseline = await git("show", `refs/heads/main:${baselinePath}`);
		const current = baseline.split(/^## 当前上游基线\s*$/m)[1];
		if (current === undefined) throw new Error("Missing current upstream baseline metadata");
		const versions = Array.from(current.matchAll(/^[*-] \*\*版本\*\*[：:]\s*(.+)$/gm));
		const commits = Array.from(baseline.matchAll(/^[*-] \*\*Upstream commit\*\*[：:]\s*`([^`]+)`\s*$/gm));
		const dates = Array.from(current.matchAll(/^[*-] \*\*同步日期\*\*[：:]\s*(.+)$/gm));
		expect(versions).toHaveLength(1);
		expect(commits).toHaveLength(1);
		expect(dates).toHaveLength(1);
		expect(versions[0]![1]!.trim()).toMatch(/^`v\d+\.\d+\.\d+`$/);
		expect(commits[0]![1]).toMatch(/^[a-f0-9]{40}$/);
		const manifest = JSON.parse(await git("show", `${commits[0]![1]}:packages/coding-agent/package.json`));
		expect(versions[0]![1]!.trim()).toBe(`\`v${manifest.version}\``);
		const date = dates[0]![1]!.trim();
		expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(new Date(`${date}T00:00:00.000Z`).toISOString()).toBe(`${date}T00:00:00.000Z`);
		await git("merge-base", "--is-ancestor", commits[0]![1]!, "refs/heads/main");
	});
});
