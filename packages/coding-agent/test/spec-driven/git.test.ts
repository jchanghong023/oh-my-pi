import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { SpecGitService, type SpecTaskGitState } from "../../src/spec-driven/git";
import {
	captureDeltaPatch,
	captureIsolationBaseline,
	cleanupIsolation,
	commitToBranch,
	type CommitToBranchResult,
	ensureIsolation,
	type IsolationHandle,
	mergeTaskBranches,
} from "../../src/task/worktree";

const roots: string[] = [];
const isolations: IsolationHandle[] = [];
const pendingReviews = new Set<Promise<unknown>>();
afterEach(async () => {
	// Bun's case timeout does not cancel native I/O: settle owned reviews before deleting their cwd.
	await Promise.allSettled([...pendingReviews]);
	for (const handle of isolations.splice(0)) await cleanupIsolation(handle);
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
function reviewPackage(
	service: Pick<SpecGitService, "reviewPackage">,
	...args: Parameters<SpecGitService["reviewPackage"]>
) {
	const review = service.reviewPackage(...args);
	pendingReviews.add(review);
	void review.then(
		() => pendingReviews.delete(review),
		() => pendingReviews.delete(review),
	);
	return review;
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

// The fourth argument is host-derived from the native handle, not supplied by a model.
type WorkspaceGitService = Omit<SpecGitService, "beginTask"> & {
	beginTask(
		taskId: string,
		ownedPaths: readonly string[],
		authorization: typeof authority,
		workspace?: string,
	): Promise<SpecTaskGitState>;
};

async function nativeSources(cwd: string, ids: string[]): Promise<IsolationHandle[]> {
	const previous = process.env.OMP_WORKTREE_DIR;
	const isolationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-native-"));
	roots.push(isolationRoot);
	process.env.OMP_WORKTREE_DIR = isolationRoot;
	try {
		const handles: IsolationHandle[] = [];
		for (const id of ids) {
			const handle = await ensureIsolation(cwd, id);
			isolations.push(handle);
			handles.push(handle);
			expect(await fs.realpath(handle.mergedDir)).not.toBe(await fs.realpath(cwd));
			expect(vcs.requireGit(handle.mergedDir).info().commonDir).not.toBe(vcs.requireGit(cwd).info().commonDir);
		}
		return handles;
	} finally {
		if (previous === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = previous;
	}
}

test("native workspace binding commits and reviews source writes rather than target no-change", async () => {
	const { cwd, repo, service: targetService } = await fixture();
	const service: WorkspaceGitService = targetService;
	const [source] = await nativeSources(cwd, ["source-binding"]);
	const workspace = source!.mergedDir;
	const sourceRepo = vcs.requireGit(workspace);
	const baseline = await service.preflight();
	await service.beginTask("T-native-source", ["native-source.txt"], authority, workspace);
	try {
		await fs.writeFile(path.join(workspace, "native-source.txt"), "native source implementation\n");
		await fs.writeFile(path.join(workspace, "user-staged.txt"), "source user staging\n");
		await git(workspace, "add", "user-staged.txt");
		const sourceIndex = await sourceRepo.diffText({ cached: true });
		const result = await service.commitTask("T-native-source", "Implement native source");
		expect(result.commit).toBeDefined();
		expect(result.commit ?? null).toBe((await sourceRepo.headSha()) ?? null);
		expect(result.changedPaths).toEqual(["native-source.txt"]);
		expect(await repo.headSha()).toBe(baseline.head);
		expect(await repo.statusPorcelain({ untracked: "all" })).toBe("");
		expect(await sourceRepo.diffText({ cached: true })).toBe(sourceIndex);
		const review = await reviewPackage(service, "T-native-source", "plan.md", ".review/native-source.diff");
		expect(review.content).toContain("native source implementation");
		expect(review.content).not.toContain("source user staging");
		expect(await fs.readFile(path.join(workspace, review.path), "utf8")).toBe(review.content);
		expect(await fs.stat(path.join(cwd, review.path)).catch(() => null)).toBeNull();
	} finally {
		service.finishTask("T-native-source");
	}
});

test("native independent workspaces admit concurrent tasks and keep commit and review ranges separate", async () => {
	const { cwd, repo, service: targetService } = await fixture();
	const service: WorkspaceGitService = targetService;
	const sources = await nativeSources(cwd, ["parallel-a", "parallel-b"]);
	const baseline = await service.preflight();
	const tasks = sources.map((source, index) => ({
		id: `T-native-${index}`,
		file: `native-${index}.txt`,
		text: `isolated implementation ${index}\n`,
		workspace: source.mergedDir,
	}));
	const admitted = await Promise.allSettled(
		tasks.map(task => service.beginTask(task.id, [task.file], authority, task.workspace)),
	);
	try {
		expect(admitted.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
		await Promise.all(tasks.map(task => fs.writeFile(path.join(task.workspace, task.file), task.text)));
		const commits = await Promise.all(tasks.map(task => service.commitTask(task.id, `Implement ${task.id}`)));
		for (const [index, task] of tasks.entries()) {
			const commit = commits[index]!;
			expect(commit.commit).toBeDefined();
			expect(commit.commit ?? null).toBe((await vcs.requireGit(task.workspace).headSha()) ?? null);
			expect(commit.base).toBe(baseline.head);
			expect(commit.changedPaths).toEqual([task.file]);
			expect(await git(task.workspace, "rev-list", `${commit.base}..${commit.head}`)).toBe(commit.commit!);
		}
		const reviews = await Promise.all(
			tasks.map(task => reviewPackage(service, task.id, "plan.md", `.review/${task.id}.diff`)),
		);
		for (const [index, review] of reviews.entries()) {
			expect(review.content).toContain(tasks[index]!.text.trim());
			expect(review.content).not.toContain(tasks[1 - index]!.text.trim());
			expect(review.base).toBe(commits[index]!.base);
			expect(review.head).toBe(commits[index]!.commit!);
		}
		expect(await repo.headSha()).toBe(baseline.head);
		expect(await repo.statusPorcelain({ untracked: "all" })).toBe("");
	} finally {
		for (const [index, result] of admitted.entries()) {
			if (result.status === "fulfilled") service.finishTask(tasks[index]!.id);
		}
	}
}, 30_000);

test("native publication control captures real sources and sequentially lands deltas without user staging", async () => {
	const { cwd, repo } = await fixture();
	await fs.writeFile(path.join(cwd, "user-staged.txt"), "target user staging\n");
	await git(cwd, "add", "user-staged.txt");
	const targetIndex = await repo.diffText({ cached: true });
	const sources = await nativeSources(cwd, ["publish-a", "publish-b"]);
	const captures = [];
	const sourceHeads: string[] = [];
	for (const [index, source] of sources.entries()) {
		const baseline = await captureIsolationBaseline(source.mergedDir, cwd);
		const file = `published-${index}.txt`;
		await fs.writeFile(path.join(source.mergedDir, file), `native published ${index}\n`);
		await git(source.mergedDir, "add", file);
		await git(source.mergedDir, "commit", "--only", "-m", `Source ${index}`, "--", file);
		sourceHeads.push(await git(source.mergedDir, "rev-parse", "HEAD"));
		const captured = await commitToBranch(source.mergedDir, baseline, `publish-${index}`, `Publish ${index}`);
		if (!captured?.branchName || !captured.baseSha) throw new Error("Native source did not produce a task branch");
		expect(captured.rootPatch).toContain(`native published ${index}`);
		expect(captured.rootPatch).not.toContain("target user staging");
		expect(captured.nestedPatches).toEqual([]);
		captures.push({ branchName: captured.branchName, baseSha: captured.baseSha, taskId: `publish-${index}` });
	}
	// Move the actual target independently: publication must not require source/target SHA equality.
	await fs.writeFile(path.join(cwd, "target-only.txt"), "target-only commit\n");
	await git(cwd, "add", "target-only.txt");
	await git(cwd, "commit", "--only", "-m", "Independent target commit", "--", "target-only.txt");
	const targetBase = await repo.headSha();
	for (const [index, capture] of captures.entries()) {
		const outcome = await mergeTaskBranches(cwd, [capture]);
		expect(outcome).toEqual({ merged: [capture.branchName], failed: [] });
		expect(await fs.readFile(path.join(cwd, `published-${index}.txt`), "utf8")).toBe(`native published ${index}\n`);
		expect(await repo.headSha()).not.toBe(sourceHeads[index]!);
	}
	const targetHead = (await repo.headSha())!;
	expect((await git(cwd, "rev-list", `${targetBase}..${targetHead}`)).split("\n")).toHaveLength(2);
	expect(await git(cwd, "diff", "--name-only", targetBase!, targetHead)).toBe("published-0.txt\npublished-1.txt");
	expect(await repo.diffText({ cached: true })).toBe(targetIndex);
	expect(await git(cwd, "show", "HEAD:user-staged.txt")).toBe("original");
});

function nativeOutcome(id: string, capture?: CommitToBranchResult): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: id,
		exitCode: 0,
		output: "Native task finished",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		isolated: true,
		branchName: capture?.branchName,
		branchBaseSha: capture?.baseSha,
		nestedPatches: capture?.nestedPatches ?? [],
	};
}

test("approved execution subdirectory keeps project evidence and native Git coordinates separate", async () => {
	const { cwd, repo } = await fixture();
	const execution = path.join(cwd, "project", "app");
	const change = ".spec/changes/subdirectory";
	const plan = `${change}/plan.md`;
	await fs.mkdir(execution, { recursive: true });
	await fs.mkdir(path.join(cwd, change), { recursive: true });
	await fs.writeFile(path.join(cwd, plan), "# Approved subdirectory plan\nTask parent\n");
	await fs.writeFile(path.join(execution, "local.txt"), "local baseline\n");
	await repo.stageFiles([plan, "project/app/local.txt"]);
	await repo.commitCreate("Prepare approved execution subdirectory", { files: [plan, "project/app/local.txt"] });
	await fs.writeFile(path.join(cwd, "user-staged.txt"), "preserved subdirectory user index\n");
	await repo.stageFiles(["user-staged.txt"]);
	await fs.writeFile(path.join(cwd, "user-untracked.txt"), "preserved subdirectory untracked\n");
	const index = await repo.diffText({ cached: true });
	const service = new SpecGitService(execution, { projectRoot: cwd });
	await service.preflight();
	expect(service.cwd).toBe(execution);
	const local = await service.beginTask("local", ["local.txt"], authority);
	expect(local.workspace).toBe(await fs.realpath(execution));
	expect(local.ownedPaths).toEqual(["local.txt"]);
	await fs.writeFile(path.join(execution, "local.txt"), "local approved implementation\n");
	const localCommit = await service.commitTask("local", "Implement approved local task");
	expect(localCommit.changedPaths).toEqual(["local.txt"]);
	expect(await git(cwd, "show", "--format=", "--name-only", localCommit.commit!)).toBe("project/app/local.txt");
	const localReview = await reviewPackage(service, "local", plan, ".git/spec-review/subdirectory-local.diff");
	expect(localReview.content).toContain("local approved implementation");
	await expect(reviewPackage(service, "local", "../plan.md", ".git/spec-review/rejected-plan.diff")).rejects.toThrow();
	await expect(reviewPackage(service, "local", plan, "../outside.diff")).rejects.toThrow();
	service.finishTask("local");
	await expect(service.beginTask("escape", ["../outside.txt"], authority)).rejects.toThrow();
	await expect(service.beginTask("wrong-root", ["task.txt"], authority, cwd)).rejects.toThrow("approved execution");
	const [handle] = await nativeSources(cwd, ["subdirectory-source"]);
	const sourceWorkspace = path.join(handle!.mergedDir, "project", "app");
	const baseline = await captureIsolationBaseline(handle!.mergedDir, cwd);
	await service.beginTask("child", ["native.txt"], authority, sourceWorkspace);
	await fs.writeFile(path.join(sourceWorkspace, "native.txt"), "native approved subdirectory implementation\n");
	const commit = await service.commitTask("child", "Implement approved native subdirectory task");
	expect(commit.changedPaths).toEqual(["native.txt"]);
	const review = await reviewPackage(service, "child", plan, ".git/spec-review/subdirectory-source.diff");
	expect(review.content).toContain("project/app/native.txt");
	expect(review.content).toContain("native approved subdirectory implementation");
	await expect(service.freezeTaskSource("child", "../outside-checks")).rejects.toThrow();
	const frozen = await service.freezeTaskSource("child", `${change}/checks`);
	expect(frozen.sourceWorkspace).toBe(await fs.realpath(sourceWorkspace));
	expect(frozen.evidencePath.startsWith(`${change}/checks/`)).toBe(true);
	service.finishTask("child");
	const capture = await commitToBranch(handle!.mergedDir, baseline, "subdirectory-source", "Subdirectory source");
	if (!capture?.branchName) throw new Error("Expected real subdirectory native branch capture");
	await cleanupIsolation(handle!);
	isolations.splice(isolations.indexOf(handle!), 1);
	await expect(
		service.registerNativeSource("child", nativeOutcome("child", capture), "../outside-checks", "parent"),
	).rejects.toThrow();
	const source = await service.registerNativeSource(
		"child",
		nativeOutcome("child", capture),
		`${change}/checks`,
		"parent",
	);
	await service.beginTask("parent", ["native.txt"], authority);
	const [publication] = await service.integrateTask("parent", [source.sourceId]);
	expect(publication!.complete).toBe(true);
	expect(publication!.targetWorkspace).toBe(execution);
	expect(publication!.changedPaths).toEqual(["native.txt"]);
	expect(await git(cwd, "show", "--format=", "--name-only", publication!.afterHead)).toBe("project/app/native.txt");
	expect(await fs.readFile(path.join(execution, "native.txt"), "utf8")).toBe(
		"native approved subdirectory implementation\n",
	);
	const targetReview = await reviewPackage(service, "parent", plan, ".git/spec-review/subdirectory-target.diff");
	expect(targetReview.content).toContain("native approved subdirectory implementation");
	service.finishTask("parent");
	const durable = JSON.parse(await fs.readFile(path.join(cwd, source.evidencePath), "utf8"));
	expect(durable.frozenSource.repoOwnedPaths).toEqual(["project/app/native.txt"]);
	expect(durable.frozenSource.ownedPaths).toEqual(["native.txt"]);
	expect(durable.frozenSource.reviews[0].content).toBe(review.content);
	const landed = JSON.parse(
		await fs.readFile(path.join(cwd, source.evidencePath.replace(/\.json$/, ".publication.json")), "utf8"),
	);
	expect(landed.changedPaths).toEqual(["native.txt"]);
	expect(await repo.diffText({ cached: true })).toBe(index);
	expect(await fs.readFile(path.join(cwd, "user-untracked.txt"), "utf8")).toBe("preserved subdirectory untracked\n");
	const outside = new SpecGitService(cwd, { projectRoot: execution });
	await expect(outside.preflight()).rejects.toThrow();
}, 30_000);

test("registered native sources publish actual target ranges after source disposal without user staging", async () => {
	const { cwd, repo, service } = await fixture();
	await fs.writeFile(path.join(cwd, "user-staged.txt"), "preserved user index\n");
	await repo.stageFiles(["user-staged.txt"]);
	await fs.writeFile(path.join(cwd, "user-untracked.txt"), "preserved untracked\n");
	const index = await repo.diffText({ cached: true });
	await service.preflight();
	const handles = await nativeSources(cwd, ["registered-a", "registered-b"]);
	const registered = [];
	for (const [number, handle] of handles.entries()) {
		const bindingId = `binding-${number}`;
		const file = `registered-${number}.txt`;
		const baseline = await captureIsolationBaseline(handle.mergedDir, cwd);
		await service.beginTask(bindingId, [file], authority, handle.mergedDir);
		await fs.writeFile(path.join(handle.mergedDir, file), `registered implementation ${number}\n`);
		const commit = await service.commitTask(bindingId, `Implement registered ${number}`);
		await reviewPackage(service, bindingId, "plan.md", `.git/spec-review/${bindingId}.diff`);
		const frozen = await service.freezeTaskSource(bindingId, "checks/native");
		expect(frozen.head).toBe(commit.commit!);
		service.finishTask(bindingId);
		const capture = await commitToBranch(handle.mergedDir, baseline, `registered-${number}`, bindingId);
		if (!capture?.branchName) throw new Error("Expected real native branch capture");
		await cleanupIsolation(handle);
		isolations.splice(isolations.indexOf(handle), 1);
		expect(await fs.stat(handle.mergedDir).catch(() => null)).toBeNull();
		registered.push(
			await service.registerNativeSource(bindingId, nativeOutcome(bindingId, capture), "checks/native", "parent"),
		);
	}
	await fs.writeFile(path.join(cwd, "target-only.txt"), "independent target\n");
	await repo.stageFiles(["target-only.txt"]);
	await repo.commitCreate("Move target independently", { files: ["target-only.txt"] });
	const before = await repo.headSha();
	await expect(service.integrateTask("other-parent", [registered[0]!.sourceId])).rejects.toThrow("this task");
	const result = await service.integrateTask(
		"parent",
		registered.map(source => source.sourceId),
	);
	expect(result).toHaveLength(2);
	expect(result[0]!.beforeHead).toBe(before!);
	expect(result[1]!.beforeHead).toBe(result[0]!.afterHead);
	for (const [number, publication] of result.entries()) {
		expect(publication.complete).toBe(true);
		expect(publication.partial).toBe(false);
		expect(publication.source.head).not.toBe(publication.afterHead);
		expect(publication.source.branchHead).toBeDefined();
		expect(publication.commits).toHaveLength(1);
		expect(publication.changedPaths).toEqual([`registered-${number}.txt`]);
		expect(publication.merged).toEqual([registered[number]!.branchName!]);
		const sourceEvidence = JSON.parse(await fs.readFile(path.join(cwd, publication.source.evidencePath), "utf8"));
		expect(sourceEvidence.frozenSource.committedDiff).toContain(`registered implementation ${number}`);
		expect(sourceEvidence.frozenSource.committedDiff).not.toContain("preserved user index");
		expect(sourceEvidence.frozenSource.reviews[0].content).toContain(`registered implementation ${number}`);
		const targetEvidence = JSON.parse(
			await fs.readFile(
				path.join(cwd, publication.source.evidencePath.replace(/\.json$/, ".publication.json")),
				"utf8",
			),
		);
		expect(targetEvidence.afterHead).toBe(publication.afterHead);
	}
	expect(await repo.diffText({ cached: true })).toBe(index);
	expect(await fs.readFile(path.join(cwd, "user-untracked.txt"), "utf8")).toBe("preserved untracked\n");
	await expect(service.integrateTask("parent", [registered[0]!.sourceId])).rejects.toThrow("unpublished");
});

test("native source conflict records intra-branch partial landing and preserves source evidence and user index", async () => {
	const { cwd, repo, service } = await fixture();
	await fs.writeFile(path.join(cwd, "user-staged.txt"), "user index across conflict\n");
	await repo.stageFiles(["user-staged.txt"]);
	const index = await repo.diffText({ cached: true });
	await service.preflight();
	const [handle] = await nativeSources(cwd, ["partial-conflict"]);
	const workspace = handle!.mergedDir;
	const baseline = await captureIsolationBaseline(workspace, cwd);
	await service.beginTask("conflicting-source", ["landed-first.txt", "task.txt"], authority, workspace);
	await fs.writeFile(path.join(workspace, "landed-first.txt"), "land this first\n");
	await service.commitTask("conflicting-source", "First source commit");
	await fs.writeFile(path.join(workspace, "task.txt"), "source conflicting content\n");
	await service.commitTask("conflicting-source", "Second source conflicts");
	const frozen = await service.freezeTaskSource("conflicting-source", "checks/native");
	service.finishTask("conflicting-source");
	const capture = await commitToBranch(workspace, baseline, "partial-conflict", "Partial conflict");
	if (!capture?.branchName) throw new Error("Expected real multi-commit native capture");
	await cleanupIsolation(handle!);
	isolations.splice(isolations.indexOf(handle!), 1);
	const source = await service.registerNativeSource(
		"conflicting-source",
		nativeOutcome("partial-conflict", capture),
		"checks/native",
	);
	await fs.writeFile(path.join(cwd, "task.txt"), "target conflicting content\n");
	await repo.stageFiles(["task.txt"]);
	await repo.commitCreate("Target diverges", { files: ["task.txt"] });
	const before = await repo.headSha();
	const [publication] = await service.integrateTask("conflicting-source", [source.sourceId]);
	expect(publication!.complete).toBe(false);
	expect(publication!.partial).toBe(true);
	expect(publication!.beforeHead).toBe(before!);
	expect(publication!.afterHead).not.toBe(before!);
	expect(publication!.commits).toHaveLength(1);
	expect(publication!.changedPaths).toContain("landed-first.txt");
	expect(publication!.merged).toEqual([]);
	expect(publication!.failed).toEqual([capture.branchName]);
	expect(publication!.conflict).toBeDefined();
	expect(publication!.source.head).toBe(frozen.head);
	expect(await fs.readFile(path.join(cwd, "landed-first.txt"), "utf8")).toBe("land this first\n");
	expect(await repo.diffText({ cached: true, files: ["user-staged.txt"] })).toBe(index);
	expect(await fs.readFile(path.join(cwd, source.evidencePath), "utf8")).toContain("source conflicting content");
	expect(await git(cwd, "rev-parse", capture.branchName)).toBe(source.branchHead!);
});

// Includes native capture/disposal, patch publication, a target commit, and the real Bash review script.
test("registered native patch source retains delta bytes after disposal without inventing a source commit", async () => {
	const { cwd, repo, service } = await fixture();
	await service.preflight();
	const [handle] = await nativeSources(cwd, ["registered-patch"]);
	const workspace = handle!.mergedDir;
	const baseline = await captureIsolationBaseline(workspace, cwd);
	await service.beginTask("patch-source", ["patch-file.txt"], authority, workspace);
	await fs.writeFile(path.join(workspace, "patch-file.txt"), "real native patch delta\n");
	const delta = await captureDeltaPatch(workspace, baseline);
	const frozen = await service.freezeTaskSource("patch-source", "checks/native");
	service.finishTask("patch-source");
	const nativePatch = path.join(cwd, "checks/native/native.patch");
	await fs.writeFile(nativePatch, delta.rootPatch);
	await cleanupIsolation(handle!);
	isolations.splice(isolations.indexOf(handle!), 1);
	const outcome = {
		...nativeOutcome("registered-patch", delta),
		patchPath: nativePatch,
		hasRootChanges: true,
	};
	const source = await service.registerNativeSource("patch-source", outcome, "checks/native");
	await fs.rm(nativePatch);
	const before = await repo.headSha();
	await service.beginTask("patch-source", ["patch-file.txt"], authority);
	try {
		const [publication] = await service.integrateTask("patch-source", [source.sourceId]);
		expect(publication!.complete).toBe(true);
		expect(publication!.source.head).toBe(frozen.head);
		expect(publication!.source.branchName).toBeUndefined();
		expect(publication!.source.branchHead).toBeUndefined();
		expect(publication!.source.branchBaseSha).toBeUndefined();
		expect(publication!.beforeHead).toBe(before!);
		expect(publication!.afterHead).toBe(before!);
		expect(publication!.commits).toEqual([]);
		expect(publication!.changedPaths).toEqual(["patch-file.txt"]);
		expect(await fs.readFile(path.join(cwd, "patch-file.txt"), "utf8")).toBe("real native patch delta\n");
		expect(await fs.readFile(path.join(cwd, source.evidencePath), "utf8")).toContain("real native patch delta");
		const committed = await service.commitTask("patch-source", "Commit the published target patch");
		expect(committed.commit).toBeDefined();
		const review = await reviewPackage(service, "patch-source", "plan.md", ".review/published-patch.diff");
		expect(review.content).toContain("real native patch delta");
	} finally {
		service.finishTask("patch-source");
	}
}, 30_000);
// Two real commits and the compound Git/Bash review share one fixture deadline, not Bun's default 5 seconds.
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
	const review = await reviewPackage(service, "T001", "plan.md", ".review/T001.diff");
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
}, 30_000);
test("no-change task creates no empty commit or review package", async () => {
	const { repo, service } = await fixture();
	const baseline = await service.preflight();
	await service.beginTask("T002", ["task.txt"], authority);
	const result = await service.commitTask("T002", "No changes");
	expect(result.commit).toBeUndefined();
	expect(result.head).toBe(baseline.head);
	expect(await repo.headSha()).toBe(baseline.head);
	await expect(reviewPackage(service, "T002", "plan.md", "unused.diff")).rejects.toThrow("No-change");
	service.finishTask("T002");
});
test("empty-owned verification checkpoints preserve real HEAD and user staged and untracked work", async () => {
	const { cwd, repo, service } = await fixture();
	await fs.writeFile(path.join(cwd, "user-staged.txt"), "user staging\n");
	await git(cwd, "add", "user-staged.txt");
	await fs.writeFile(path.join(cwd, "user-untracked.txt"), "user untracked\n");
	const baseline = await service.preflight();
	const index = await repo.diffText({ cached: true });
	const status = await repo.statusPorcelain({ untracked: "all", nulTerminated: true });
	await expect(service.beginTask("verification", [], { ...authority, expectedPlanVersion: "old" })).rejects.toThrow(
		"approved",
	);
	const task = await service.beginTask("verification", [], authority);
	try {
		expect(task.ownedPaths).toEqual([]);
		const result = await service.commitTask("verification", "Validate approved exception");
		expect(result).toEqual({
			taskId: "verification",
			base: baseline.head,
			head: baseline.head,
			changedPaths: [],
			findingIds: [],
		});
		expect(await repo.headSha()).toBe(baseline.head);
		expect(await repo.diffText({ cached: true })).toBe(index);
		expect(await repo.statusPorcelain({ untracked: "all", nulTerminated: true })).toBe(status);
		expect(await fs.readFile(path.join(cwd, "user-untracked.txt"), "utf8")).toBe("user untracked\n");
		await expect(reviewPackage(service, "verification", "plan.md", "unused.diff")).rejects.toThrow("No-change");
		expect(await fs.stat(path.join(cwd, "unused.diff")).catch(() => null)).toBeNull();
	} finally {
		const completed = service.finishTask("verification");
		expect(completed.commits).toEqual([]);
		expect(completed.head).toBe(baseline.head);
	}
});

test("empty-owned native source freezes and integrates an actual empty delta without a commit", async () => {
	const { cwd, repo, service } = await fixture();
	const [source] = await nativeSources(cwd, ["zero-write"]);
	const workspace = source!.mergedDir;
	const baseline = await service.preflight();
	const nativeBaseline = await captureIsolationBaseline(workspace, cwd);
	await service.beginTask("verification-source", [], authority, workspace);
	expect((await service.commitTask("verification-source", "Validate source")).head).toBe(baseline.head);
	const frozen = await service.freezeTaskSource("verification-source", ".git/spec-checks");
	service.finishTask("verification-source");
	const delta = await captureDeltaPatch(workspace, nativeBaseline);
	expect(delta.rootPatch).toBe("");
	expect(delta.nestedPatches).toEqual([]);
	const registered = await service.registerNativeSource(
		"verification-source",
		{ ...nativeOutcome("zero-write"), nestedPatches: delta.nestedPatches, hasRootChanges: !!delta.rootPatch },
		".git/spec-checks",
		"verification",
	);
	expect(frozen.base).toBe(baseline.head);
	expect(frozen.head).toBe(baseline.head);
	await service.beginTask("verification", [], authority);
	try {
		const [publication] = await service.integrateTask("verification", [registered.sourceId]);
		expect(publication!.complete).toBe(true);
		expect(publication!.commits).toEqual([]);
		expect(publication!.changedPaths).toEqual([]);
		expect(publication!.beforeHead).toBe(baseline.head);
		expect(publication!.afterHead).toBe(baseline.head);
		expect(await repo.headSha()).toBe(baseline.head);
		expect((await service.commitTask("verification", "Validate target")).commit).toBeUndefined();
		// A later real native capture cannot turn this zero-write source into publication authority.
		await fs.writeFile(path.join(workspace, "unowned-native.txt"), "must not publish\n");
		const changed = await captureDeltaPatch(workspace, nativeBaseline);
		expect(changed.rootPatch).toContain("must not publish");
		const patchPath = path.join(cwd, ".git/spec-checks/unowned.patch");
		await fs.writeFile(patchPath, changed.rootPatch);
		const rejected = await service.registerNativeSource(
			"verification-source",
			{
				...nativeOutcome("zero-write"),
				patchPath,
				nestedPatches: changed.nestedPatches,
				hasRootChanges: true,
			},
			".git/spec-checks",
			"verification",
		);
		const [failure] = await service.integrateTask("verification", [rejected.sourceId]);
		expect(failure!.complete).toBe(false);
		expect(failure!.conflict).toContain("unowned");
		expect(failure!.commits).toEqual([]);
		expect(failure!.changedPaths).toEqual([]);
		expect(await repo.headSha()).toBe(baseline.head);
		expect(await fs.stat(path.join(cwd, "unowned-native.txt")).catch(() => null)).toBeNull();
	} finally {
		service.finishTask("verification");
	}
}, 30_000);
test("host-authorized target repair retries after uncheckpointed release without consuming prior authority or user staging", async () => {
	const { cwd, repo } = await fixture();
	await fs.mkdir(path.join(cwd, "test"));
	const testPath = path.join(cwd, "test/greeting.test.ts");
	await fs.writeFile(testPath, "original greeting assertion\n");
	await git(cwd, "add", "test/greeting.test.ts");
	await git(cwd, "commit", "-m", "Add actual owned test");
	await fs.writeFile(path.join(cwd, "user-staged.txt"), "user staging\n");
	await git(cwd, "add", "user-staged.txt");
	await fs.writeFile(path.join(cwd, "user-untracked.txt"), "user untracked\n");
	const index = await repo.diffText({ cached: true });
	await fs.writeFile(testPath, "initial dirty assertion\n");
	const initial = new SpecGitService(cwd);
	await initial.preflight();
	await expect(initial.beginTask("initial", ["test/greeting.test.ts"], authority)).rejects.toThrow("dirty");
	await fs.writeFile(testPath, "original greeting assertion\n");
	const service = new SpecGitService(cwd);
	const baseline = await service.preflight();
	await service.beginTask("T001", ["test/greeting.test.ts"], authority);
	await fs.writeFile(testPath, "completed greeting assertion\n");
	const completed = await service.commitTask("T001", "Implement greeting test");
	expect(completed.commit).toBeDefined();
	service.finishVerifiedTask("T001");
	service.finishTask("T001");
	// Git tests attest at the host boundary; behavioral host tests prove the actual completed checkpoint.
	await fs.writeFile(testPath, "externally invalidated greeting assertion\n");
	await expect(service.beginTask("T001", ["test/greeting.test.ts"], authority)).rejects.toThrow("dirty");
	// Host preparation can fail after Git admission; ordinary release must not revoke the completed checkpoint.
	for (let attempt = 0; attempt < 2; attempt++) {
		await service.beginTask("T001", ["test/greeting.test.ts"], { ...authority, priorTaskId: "T001" });
		service.finishTask("T001");
		expect(await repo.headSha()).toBe(completed.head);
		expect(await repo.diffText({ cached: true })).toBe(index);
		await expect(service.beginTask("T001", ["test/greeting.test.ts"], authority)).rejects.toThrow("dirty");
	}
	const foreign = new SpecGitService(cwd);
	await foreign.preflight();
	await expect(
		foreign.beginTask("T001", ["test/greeting.test.ts"], { ...authority, priorTaskId: "T001" }),
	).rejects.toThrow("exact finished target");
	const repair = await service.beginTask("T001", ["test/greeting.test.ts"], { ...authority, priorTaskId: "T001" });
	try {
		expect(repair.base).toBe(completed.head);
		expect(await repo.headSha()).toBe(completed.head);
		expect(await fs.readFile(testPath, "utf8")).toBe("externally invalidated greeting assertion\n");
		await fs.writeFile(testPath, "repaired greeting assertion\n");
		const repaired = await service.commitTask("T001", "Repair invalidated greeting test");
		expect(repaired.commit).toBeDefined();
		expect(repaired.changedPaths).toEqual(["test/greeting.test.ts"]);
		expect(await git(cwd, "rev-list", "--count", `${baseline.head}..${repaired.head}`)).toBe("2");
		expect(await git(cwd, "diff", "--name-only", baseline.head, repaired.head)).toBe("test/greeting.test.ts");
		expect(await git(cwd, "show", "HEAD:user-staged.txt")).toBe("original");
		expect(await repo.diffText({ cached: true })).toBe(index);
		expect(await fs.readFile(path.join(cwd, "user-untracked.txt"), "utf8")).toBe("user untracked\n");
		service.finishVerifiedTask("T001");
	} finally {
		service.finishTask("T001");
	}
});

test("a newer released checkpoint supersedes retained completed repair ownership only when attested", async () => {
	const { cwd, service } = await fixture();
	await service.preflight();
	await service.beginTask("target", ["task.txt"], authority);
	service.finishVerifiedTask("target");
	service.finishTask("target");
	await service.beginTask("target", ["user-unstaged.txt"], authority);
	service.finishTask("target");
	await fs.writeFile(path.join(cwd, "user-unstaged.txt"), "external newer owned mutation\n");
	await expect(
		service.beginTask("unverified-newer", ["user-unstaged.txt"], { ...authority, priorTaskId: "target" }),
	).rejects.toThrow("exact finished target");
	// A retained controller checkpoint must attest the latest released binding, not its completed predecessor.
	service.finishVerifiedTask("target");
	await fs.writeFile(path.join(cwd, "task.txt"), "external previous owned mutation\n");
	await expect(service.beginTask("superseded", ["task.txt"], { ...authority, priorTaskId: "target" })).rejects.toThrow(
		"exact finished target",
	);
	await service.beginTask("target", ["user-unstaged.txt"], { ...authority, priorTaskId: "target" });
	service.finishTask("target");
});

test("repair authority rejects unknown stale plan changed ownership live and native-source prior bindings", async () => {
	const { cwd, repo, service } = await fixture();
	const baseline = await service.preflight();
	await service.beginTask("completed-target", ["task.txt"], authority);
	service.finishTask("completed-target");
	await expect(
		service.beginTask("merely-released", ["task.txt"], { ...authority, priorTaskId: "completed-target" }),
	).rejects.toThrow("exact finished target");
	service.finishVerifiedTask("completed-target");
	await fs.writeFile(path.join(cwd, "task.txt"), "external owned mutation\n");
	const repairAuthority = { ...authority, priorTaskId: "completed-target" };
	await expect(service.beginTask("unknown", ["task.txt"], { ...authority, priorTaskId: "forged" })).rejects.toThrow(
		"exact finished target",
	);
	await expect(
		service.beginTask("changed-plan", ["task.txt"], {
			...repairAuthority,
			planVersion: "replacement-plan",
			expectedPlanVersion: "replacement-plan",
		}),
	).rejects.toThrow("exact finished target");
	await expect(service.beginTask("changed-owned", ["task.txt", "new.txt"], repairAuthority)).rejects.toThrow(
		"exact finished target",
	);
	const replacement = new SpecGitService(cwd);
	await replacement.preflight();
	await expect(replacement.beginTask("stale", ["task.txt"], repairAuthority)).rejects.toThrow("exact finished target");
	const [source] = await nativeSources(cwd, ["repair-authority-source"]);
	const workspace = source!.mergedDir;
	await expect(service.beginTask("different-workspace", ["task.txt"], repairAuthority, workspace)).rejects.toThrow(
		"exact finished target",
	);
	await service.beginTask("live-source", ["source.txt"], authority, workspace);
	try {
		expect(() => service.finishVerifiedTask("live-source")).toThrow("target Git binding");
		await expect(
			service.beginTask("live-repair", ["source.txt"], { ...authority, priorTaskId: "live-source" }),
		).rejects.toThrow("exact finished target");
	} finally {
		service.finishTask("live-source");
	}
	expect(() => service.finishVerifiedTask("live-source")).toThrow("target Git binding");
	await expect(
		service.beginTask("source-repair", ["source.txt"], { ...authority, priorTaskId: "live-source" }),
	).rejects.toThrow("exact finished target");
	await expect(
		service.beginTask("source-repair", ["source.txt"], { ...authority, priorTaskId: "live-source" }, workspace),
	).rejects.toThrow("exact finished target");
	expect(await repo.headSha()).toBe(baseline.head);
	expect(await fs.readFile(path.join(cwd, "task.txt"), "utf8")).toBe("external owned mutation\n");
}, 30_000);

test("repair prior binding never overrides dirty ownership captured by preflight", async () => {
	const { cwd, service, repo } = await fixture();
	await service.preflight();
	await service.beginTask("completed", ["task.txt"], authority);
	service.finishVerifiedTask("completed");
	service.finishTask("completed");
	await fs.writeFile(path.join(cwd, "task.txt"), "preexisting dirty work\n");
	const baseline = await service.preflight();
	await expect(service.beginTask("repair", ["task.txt"], { ...authority, priorTaskId: "completed" })).rejects.toThrow(
		"dirty",
	);
	expect(await repo.headSha()).toBe(baseline.head);
	expect(await fs.readFile(path.join(cwd, "task.txt"), "utf8")).toBe("preexisting dirty work\n");
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
	await expect(reviewPackage(service, "T003", "plan.md", "unused.diff")).rejects.toThrow("contaminated");
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
