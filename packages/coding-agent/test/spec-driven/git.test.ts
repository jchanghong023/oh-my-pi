import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { SpecGitService } from "../../src/spec-driven/git";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const authority = {
	executionApproved: true as const,
	planVersion: "approved-plan",
	expectedPlanVersion: "approved-plan",
};
async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`Fixture Git failed (${code}): ${stderr}`);
	return stdout.trimEnd();
}
async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-git-"));
	roots.push(cwd);
	await git(cwd, "init", "-b", "main");
	await git(cwd, "config", "user.name", "Specification Test");
	await git(cwd, "config", "user.email", "spec@example.test");
	await git(cwd, "config", "core.autocrlf", "false");
	await git(cwd, "config", "core.hooksPath", path.join(cwd, "disabled-hooks"));
	for (const file of ["task.txt", "user-staged.txt", "user-unstaged.txt"])
		await fs.writeFile(path.join(cwd, file), "original\n");
	await fs.writeFile(path.join(cwd, "plan.md"), "# Approved plan\nTask T001\n");
	await git(cwd, "add", "task.txt", "user-staged.txt", "user-unstaged.txt", "plan.md");
	await git(cwd, "commit", "-m", "fixture baseline");
	return { cwd, repo: vcs.requireGit(cwd), service: new SpecGitService(cwd) };
}
test("commits task plus associated fixes and reviews real new files without user index contamination", async () => {
	const { cwd, repo, service } = await fixture();
	await fs.writeFile(path.join(cwd, "user-staged.txt"), "staged user\n");
	await git(cwd, "add", "user-staged.txt");
	await fs.appendFile(path.join(cwd, "user-staged.txt"), "unstaged user\n");
	await fs.writeFile(path.join(cwd, "user-unstaged.txt"), "unstaged\n");
	await fs.writeFile(path.join(cwd, "user-untracked.txt"), "untracked\n");
	const originalIndex = await repo.diffText({ cached: true });
	const originalUser = await fs.readFile(path.join(cwd, "user-staged.txt"), "utf8");
	const baseline = await service.preflight();
	expect(baseline.dirtyPaths).toContain("user-untracked.txt");
	await service.beginTask("T001", ["task.txt", "new-task.txt"], authority);
	await fs.writeFile(path.join(cwd, "task.txt"), "implemented\n");
	await fs.writeFile(path.join(cwd, "new-task.txt"), "brand new behavior\n");
	const implementation = await service.commitTask("T001", "Implement T001");
	expect(implementation.commit).toBe((await repo.headSha())!);
	await fs.appendFile(path.join(cwd, "task.txt"), "review fix\n");
	const fix = await service.commitTask("T001", "Fix finding F001", ["F001"]);
	expect(fix.findingIds).toEqual(["F001"]);
	expect(fix.base).toBe(baseline.head);
	const review = await service.reviewPackage("T001", "plan.md", ".review/T001.diff");
	expect(review.content).toContain("brand new behavior");
	expect(review.content).toContain("review fix");
	expect(review.content).not.toContain("staged user");
	expect(await repo.diffText({ cached: true })).toBe(originalIndex);
	expect(await fs.readFile(path.join(cwd, "user-staged.txt"), "utf8")).toBe(originalUser);
	expect(await fs.readFile(path.join(cwd, "user-untracked.txt"), "utf8")).toBe("untracked\n");
	expect(await fs.readFile(path.join(cwd, "user-unstaged.txt"), "utf8")).toBe("unstaged\n");
	const completed = service.finishTask("T001");
	expect(completed.commits).toEqual([implementation.commit!, fix.commit!]);
	expect(completed.fixes).toEqual([{ commit: fix.commit!, findingIds: ["F001"] }]);
});
test("no-change task creates no empty commit or review package", async () => {
	const { repo, service } = await fixture();
	const baseline = await service.preflight();
	await service.beginTask("T002", ["task.txt"], authority);
	const result = await service.commitTask("T002", "No changes");
	expect(result.commit).toBeUndefined();
	expect(result.head).toBe(baseline.head);
	expect(await repo.headSha()).toBe(baseline.head);
	await expect(service.reviewPackage("T002", "plan.md", "unused.diff")).rejects.toThrow("No-change");
	service.finishTask("T002");
});
test("rejects dirty overlap, broad ownership, missing approval, competing task and external range contamination", async () => {
	const { cwd, service, repo } = await fixture();
	await fs.writeFile(path.join(cwd, "user-staged.txt"), "user\n");
	await repo.stageFiles(["user-staged.txt"]);
	await service.preflight();
	await expect(service.beginTask("bad", ["user-staged.txt"], authority)).rejects.toThrow("dirty");
	await expect(service.beginTask("bad", ["."], authority)).rejects.toThrow();
	await expect(service.beginTask("bad", ["task.txt"], { ...authority, expectedPlanVersion: "old" })).rejects.toThrow(
		"approved",
	);
	await service.beginTask("T003", ["task.txt"], authority);
	const competitor = new SpecGitService(cwd);
	await competitor.preflight();
	await expect(competitor.beginTask("T004", ["other.txt"], authority)).rejects.toThrow("serialized");
	await fs.writeFile(path.join(cwd, "task.txt"), "task\n");
	await service.commitTask("T003", "Task commit");
	await fs.writeFile(path.join(cwd, "external.txt"), "other task\n");
	await repo.stageFiles(["external.txt"]);
	await repo.commitCreate("External task", { files: ["external.txt"] });
	await expect(service.commitTask("T003", "Must not contaminate")).rejects.toThrow("contaminated");
	await expect(service.reviewPackage("T003", "plan.md", "unused.diff")).rejects.toThrow("contaminated");
	service.finishTask("T003");
});
test("failed real commit preserves HEAD, unstaged work and user staging", async () => {
	const { cwd, service, repo } = await fixture();
	await fs.writeFile(path.join(cwd, "user-staged.txt"), "user staging\n");
	await repo.stageFiles(["user-staged.txt"]);
	const index = await repo.diffText({ cached: true });
	const baseline = await service.preflight();
	await service.beginTask("T005", ["task.txt"], authority);
	await fs.writeFile(path.join(cwd, "task.txt"), "task implementation\n");
	await repo.configSet("commit.gpgSign", "not-a-boolean");
	await expect(service.commitTask("T005", "Must fail")).rejects.toThrow();
	expect(await repo.headSha()).toBe(baseline.head);
	expect(await repo.diffText({ cached: true })).toBe(index);
	expect(await fs.readFile(path.join(cwd, "task.txt"), "utf8")).toBe("task implementation\n");
	service.finishTask("T005");
});
