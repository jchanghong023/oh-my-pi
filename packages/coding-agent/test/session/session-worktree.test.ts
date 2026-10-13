import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import {
	canAutoCreateWorktree,
	createSessionWorktree,
	decideWorktreeExit,
	inspectSessionWorktree,
	planWorktreeExit,
	removeExitWorktrees,
	removeSessionWorktree,
	type SessionWorktreeState,
	type WorktreeExitAction,
} from "../../src/session/session-worktree";

const clean: SessionWorktreeState = { dirty: false, moved: false, offBranch: false };

const rows: [
	name: string,
	policy: "keep" | "ask" | "remove",
	state: SessionWorktreeState,
	expected: WorktreeExitAction,
][] = [
	["keep ignores state", "keep", { dirty: true, moved: true, offBranch: true }, "keep"],
	["ask prompts even when clean", "ask", clean, "prompt"],
	["remove removes a clean worktree", "remove", clean, "remove"],
	["remove prompts when dirty", "remove", { ...clean, dirty: true }, "prompt"],
	["remove prompts when the branch moved", "remove", { ...clean, moved: true }, "prompt"],
	["remove prompts when HEAD left the branch", "remove", { ...clean, offBranch: true }, "prompt"],
];

describe("decideWorktreeExit", () => {
	it.each(rows)("%s", (_name, policy, state, action) => {
		expect(decideWorktreeExit(policy, state)).toBe(action);
	});
});

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

function worktreePaths(repo: string): string[] {
	return git(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter(line => line.startsWith("worktree "))
		.map(line => path.resolve(line.slice("worktree ".length)));
}

function branchSha(repo: string, branch: string): string | null {
	const r = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
		cwd: repo,
		stdout: "pipe",
	});
	return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

const exists = (p: string) =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

const commitFile = async (cwd: string, name: string) => {
	await Bun.write(path.join(cwd, name), "x\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-q", "-m", `add ${name}`);
};

describe("session worktree helpers (real git)", () => {
	let root: string;
	let repo: string;
	let savedEnv: string | undefined;
	let savedCwd: string;
	const branch = "wt/test-session";

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-wt-")));
		repo = path.join(root, "repo");
		await fs.mkdir(repo);
		savedEnv = process.env.OMP_WORKTREE_DIR;
		savedCwd = process.cwd();
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(path.join(root, "wt"));
		git(repo, "init", "-q", "-b", "main");
		git(repo, "config", "core.autocrlf", "false");
		await Bun.write(path.join(repo, "tracked.txt"), "base\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
	});

	afterEach(async () => {
		process.chdir(savedCwd);
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		await fs.rm(root, { recursive: true, force: true });
	});

	const create = (name = branch) => createSessionWorktree(repo, Settings.isolated(), name);

	it("offers a worktree only in a primary checkout with commits", async () => {
		const plain = path.join(root, "plain");
		const unborn = path.join(root, "unborn");
		await fs.mkdir(plain);
		await fs.mkdir(unborn);
		git(unborn, "init", "-q");
		await expect(createSessionWorktree(unborn, Settings.isolated(), branch)).rejects.toThrow("has no commits");
		expect(await exists(path.join(root, "wt"))).toBe(false);
		const wt = await create();
		expect(await canAutoCreateWorktree(repo)).toBe(true);
		expect(await canAutoCreateWorktree(plain)).toBe(false);
		expect(await canAutoCreateWorktree(unborn)).toBe(false);
		expect(await canAutoCreateWorktree(wt.path)).toBe(false);
	});

	it("removes a clean worktree and deletes its branch", async () => {
		const wt = await create();
		expect(worktreePaths(repo)).toContain(wt.path);
		expect(await inspectSessionWorktree(wt)).toEqual(clean);
		await removeSessionWorktree(wt, false);
		expect(await exists(wt.path)).toBe(false);
		expect(worktreePaths(repo)).not.toContain(wt.path);
		expect(branchSha(repo, branch)).toBeNull();
	});

	it("keeps the branch at the new commit when the worktree moved", async () => {
		const wt = await create();
		await commitFile(wt.path, "new.txt");
		const tip = git(wt.path, "rev-parse", "HEAD");
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, moved: true });
		await removeSessionWorktree(wt, true);
		expect(await exists(wt.path)).toBe(false);
		expect(worktreePaths(repo)).not.toContain(wt.path);
		expect(branchSha(repo, branch)).toBe(tip);
	});

	it("prompts instead of removing when commits exist only on a detached HEAD", async () => {
		const wt = await create();
		git(wt.path, "switch", "-q", "--detach");
		await commitFile(wt.path, "detached.txt");
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, offBranch: true });
		const prompts: string[] = [];
		const plan = await planWorktreeExit(
			[wt],
			"remove",
			async (_title, message) => {
				prompts.push(message);
				return false;
			},
			() => {},
		);
		expect(plan).toEqual([]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(`HEAD is not on ${branch}`);
		expect(await exists(wt.path)).toBe(true);
	});

	it("reports moved from the source repo when the worktree dir was deleted externally", async () => {
		const wt = await create();
		await commitFile(wt.path, "new.txt");
		await fs.rm(wt.path, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		expect(worktreePaths(repo)).not.toContain(wt.path);
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, moved: true });
	});

	it("rejects and keeps the branch when git cannot remove the worktree", async () => {
		const wt = await create();
		await fs.rm(wt.path, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		await expect(removeSessionWorktree(wt, false)).rejects.toThrow(`branch '${branch}' kept`);
		expect(branchSha(repo, branch)).toBe(wt.baseCommit);
	});

	it("creates a committed-only sibling worktree without changing the source index or files", async () => {
		await Bun.write(path.join(repo, "deleted.txt"), "committed\n");
		await Bun.write(path.join(repo, "unstaged-deleted.txt"), "committed\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "files to delete");
		await Bun.write(path.join(repo, "tracked.txt"), "staged\n");
		git(repo, "add", "tracked.txt");
		await Bun.write(path.join(repo, "tracked.txt"), "unstaged\n");
		git(repo, "rm", "-q", "deleted.txt");
		await fs.rm(path.join(repo, "unstaged-deleted.txt"));
		await Bun.write(path.join(repo, "untracked.txt"), "u\n");
		const status = git(repo, "status", "--porcelain");
		const staged = git(repo, "diff", "--cached");
		const unstaged = git(repo, "diff");
		process.env.OMP_WORKTREE_DIR = path.join(root, "configured-wt");
		const wt = await createSessionWorktree(
			repo,
			Settings.isolated({ "worktree.cleanSource": true, "worktree.base": path.join(root, "configured-base") }),
			branch,
		);
		expect(wt.created).toBe(true);
		expect(wt.createdBranch).toBe(true);
		expect(path.dirname(wt.path)).toBe(path.dirname(repo));
		expect(wt.baseCommit).toBe(git(repo, "rev-parse", "HEAD"));
		expect(await Bun.file(path.join(wt.path, "tracked.txt")).text()).toBe("base\n");
		expect(await Bun.file(path.join(wt.path, "deleted.txt")).text()).toBe("committed\n");
		expect(await Bun.file(path.join(wt.path, "unstaged-deleted.txt")).text()).toBe("committed\n");
		expect(await exists(path.join(wt.path, "untracked.txt"))).toBe(false);
		expect(git(wt.path, "status", "--porcelain")).toBe("");
		expect(git(repo, "status", "--porcelain")).toBe(status);
		expect(git(repo, "diff", "--cached")).toBe(staged);
		expect(git(repo, "diff")).toBe(unstaged);
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("unstaged\n");
		expect(await Bun.file(path.join(repo, "untracked.txt")).text()).toBe("u\n");
		expect(await exists(path.join(repo, "deleted.txt"))).toBe(false);
		expect(await exists(path.join(repo, "unstaged-deleted.txt"))).toBe(false);
		expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
		expect(await inspectSessionWorktree(wt)).toEqual(clean);
		await Bun.write(path.join(wt.path, "tracked.txt"), "wt edit\n");
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, dirty: true });
	});

	it("checks out an existing branch at its own tip and keeps the branch after exit removal", async () => {
		git(repo, "branch", branch);
		const tip = branchSha(repo, branch);
		await commitFile(repo, "main-only.txt");
		const wt = await create();
		expect(wt.created).toBe(true);
		expect(wt.createdBranch).toBe(false);
		expect(wt.baseCommit).toBe(tip);
		expect(git(wt.path, "rev-parse", "HEAD")).toBe(tip!);
		expect(wt.baseCommit).not.toBe(git(repo, "rev-parse", "HEAD"));
		expect(await exists(path.join(wt.path, "main-only.txt"))).toBe(false);
		const plan = await planWorktreeExit([wt], "remove", async () => true, () => {});
		await removeExitWorktrees(plan);
		expect(await exists(wt.path)).toBe(false);
		expect(branchSha(repo, branch)).toBe(tip);
	});

	it("reuses an existing dirty worktree without changing either checkout", async () => {
		const target = path.join(root, "existing");
		git(repo, "worktree", "add", "-q", "-b", branch, target);
		await Bun.write(path.join(target, "tracked.txt"), "target staged\n");
		git(target, "add", "tracked.txt");
		await Bun.write(path.join(target, "tracked.txt"), "target unstaged\n");
		await Bun.write(path.join(target, "untracked.txt"), "target untracked\n");
		await Bun.write(path.join(repo, "tracked.txt"), "source edit\n");
		const status = git(target, "status", "--porcelain");
		const staged = git(target, "diff", "--cached");
		const unstaged = git(target, "diff");
		const paths = worktreePaths(repo);
		const wt = await create();
		expect(wt.path).toBe(target);
		expect(wt.created).toBe(false);
		expect(wt.createdBranch).toBe(false);
		expect(worktreePaths(repo)).toEqual(paths);
		expect(git(target, "status", "--porcelain")).toBe(status);
		expect(git(target, "diff", "--cached")).toBe(staged);
		expect(git(target, "diff")).toBe(unstaged);
		expect(await Bun.file(path.join(target, "tracked.txt")).text()).toBe("target unstaged\n");
		expect(await Bun.file(path.join(target, "untracked.txt")).text()).toBe("target untracked\n");
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("source edit\n");
	});

	it("keeps the exact current directory when the requested branch is already checked out", async () => {
		const cwd = path.join(repo, "subdirectory");
		await fs.mkdir(cwd);
		await Bun.write(path.join(repo, "tracked.txt"), "source edit\n");
		const status = git(repo, "status", "--porcelain");
		const paths = worktreePaths(repo);
		const wt = await createSessionWorktree(cwd, Settings.isolated(), "main");
		expect(wt.path).toBe(cwd);
		expect(wt.created).toBe(false);
		expect(wt.createdBranch).toBe(false);
		expect(worktreePaths(repo)).toEqual(paths);
		expect(git(repo, "status", "--porcelain")).toBe(status);
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("source edit\n");
	});

	it("plans newest first and removes from inside the newest worktree", async () => {
		const older = await create("wt/older");
		const newer = await create("wt/newer");
		const plan = await planWorktreeExit(
			[older, newer],
			"remove",
			async () => {
				throw new Error("clean worktrees must not prompt");
			},
			() => {},
		);
		expect(plan.map(p => p.worktree.branch)).toEqual(["wt/newer", "wt/older"]);
		process.chdir(newer.path);
		expect(await removeExitWorktrees(plan)).toEqual([
			`Removed worktree ${shortenPath(newer.path)}. Resuming opens in the directory you launch omp from.`,
		]);
		expect(await fs.realpath(process.cwd())).toBe(repo);
		expect(worktreePaths(repo)).toEqual([repo]);
		expect(branchSha(repo, "wt/newer")).toBeNull();
		expect(branchSha(repo, "wt/older")).toBeNull();
	});

	it("keeps a worktree removed without a prompt that changed after planning", async () => {
		const wt = await create();
		const plan = await planWorktreeExit(
			[wt],
			"remove",
			async () => true,
			() => {},
		);
		expect(plan.map(p => p.worktree)).toEqual([wt]);
		await Bun.write(path.join(wt.path, "late.txt"), "written during teardown\n");
		const messages = await removeExitWorktrees(plan);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("changed while the session was closing");
		expect(await Bun.file(path.join(wt.path, "late.txt")).text()).toBe("written during teardown\n");
	});

	it("keeps a confirmed dirty worktree that got more uncommitted edits after the prompt", async () => {
		const wt = await create();
		await Bun.write(path.join(wt.path, "dirty.txt"), "d\n");
		const plan = await planWorktreeExit(
			[wt],
			"ask",
			async () => true,
			() => {},
		);
		expect(plan.map(p => p.worktree)).toEqual([wt]);
		await Bun.write(path.join(wt.path, "dirty.txt"), "more work written during teardown\n");
		const messages = await removeExitWorktrees(plan);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("changed while the session was closing");
		expect(await exists(wt.path)).toBe(true);
	});

	it("removes a confirmed dirty worktree, keeps a moved branch, and names it in the resume note", async () => {
		const wt = await create();
		await commitFile(wt.path, "work.txt");
		const tip = git(wt.path, "rev-parse", "HEAD");
		await Bun.write(path.join(wt.path, "dirty.txt"), "d\n");
		const plan = await planWorktreeExit(
			[wt],
			"ask",
			async () => true,
			() => {},
		);
		expect(plan.map(p => p.worktree)).toEqual([wt]);
		process.chdir(wt.path);
		expect(await removeExitWorktrees(plan)).toEqual([
			`Removed worktree ${shortenPath(wt.path)}. Resuming opens in the directory you launch omp from; its commits are on branch ${branch}.`,
		]);
		expect(await exists(wt.path)).toBe(false);
		expect(branchSha(repo, branch)).toBe(tip);
	});

	it("returns a message instead of throwing when removal fails", async () => {
		const wt = await create();
		const plan = await planWorktreeExit(
			[wt],
			"remove",
			async () => true,
			() => {},
		);
		await fs.rm(wt.path, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		const messages = await removeExitWorktrees(plan);
		expect(messages).toEqual([`Failed to remove worktree ${wt.path}; branch '${branch}' kept.`]);
		expect(branchSha(repo, branch)).toBe(wt.baseCommit);
	});
});
