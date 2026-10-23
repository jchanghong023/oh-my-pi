import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { artifactVersion, containedSpecPath } from "./artifacts";
import { runSuperpowersScript } from "./resources";

export interface SpecGitBaseline {
	head: string;
	dirtyPaths: string[];
	status: string;
	version: string;
}
export interface SpecTaskGitState {
	taskId: string;
	ownedPaths: string[];
	base: string;
	head: string;
	commits: string[];
	fixes: Array<{ commit: string; findingIds: string[] }>;
}
export interface SpecTaskCommit {
	taskId: string;
	base: string;
	head: string;
	commit?: string;
	changedPaths: string[];
	findingIds: string[];
}
export interface SpecCommitAuthorization {
	executionApproved: true;
	planVersion: string;
	expectedPlanVersion: string;
}

function statusPaths(status: string): string[] {
	const fields = status.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]!;
		if (!field) continue;
		if (field.length < 4) throw new Error("Malformed native Git porcelain status");
		paths.push(field.slice(3));
		if (/[RC]/.test(field.slice(0, 2))) {
			const previous = fields[++index];
			if (!previous) throw new Error("Missing Git rename source");
			paths.push(previous);
		}
	}
	return [...new Set(paths)].sort();
}
function overlap(left: string, right: string): boolean {
	const a = process.platform === "win32" ? left.toLowerCase() : left;
	const b = process.platform === "win32" ? right.toLowerCase() : right;
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
/** One active task per checkout keeps task base..head ranges uncontaminated. */
export class SpecGitService {
	readonly cwd: string;
	readonly #repo: VcsGitRepo;
	#baseline?: SpecGitBaseline;
	#task?: SpecTaskGitState;
	#busy = false;
	static readonly #owners = new Map<string, SpecGitService>();
	constructor(cwd: string) {
		this.#repo = vcs.requireGit(cwd);
		this.cwd = this.#repo.info().repoRoot;
	}
	async preflight(): Promise<SpecGitBaseline> {
		if (this.#task) throw new Error("Cannot replace Git baseline during a task");
		const head = await this.#repo.headSha();
		if (!head)
			throw new Error("A real existing Git HEAD is required; initialize/commit explicitly outside the workflow");
		const status = await this.#repo.statusPorcelain({ untracked: "all", nulTerminated: true });
		this.#baseline = {
			head,
			status,
			dirtyPaths: statusPaths(status),
			version: artifactVersion(`${head}\0${status}`),
		};
		return structuredClone(this.#baseline);
	}
	async beginTask(
		taskId: string,
		ownedPaths: readonly string[],
		authorization: SpecCommitAuthorization,
	): Promise<SpecTaskGitState> {
		if (
			!authorization.executionApproved ||
			!authorization.planVersion ||
			authorization.planVersion !== authorization.expectedPlanVersion
		)
			throw new Error("Local commits require current approved execution");
		if (!this.#baseline) throw new Error("Git preflight must precede task execution");
		if (!taskId || !ownedPaths.length || this.#task || SpecGitService.#owners.has(this.cwd))
			throw new Error("Git task publication must be serialized");
		const normalized: string[] = [];
		for (const file of ownedPaths) {
			const target = await containedSpecPath(this.cwd, file);
			const relative = path.relative(await fs.realpath(this.cwd), target).replaceAll(path.sep, "/");
			if (!relative || relative === ".git" || relative.startsWith(".git/") || /[*?\[\]]/.test(relative))
				throw new Error(`Task ownership must name precise files: ${file}`);
			try {
				if (!(await fs.stat(target)).isFile()) throw new Error(`Task ownership is not a regular file: ${file}`);
			} catch (error) {
				if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
			}
			if (normalized.some(other => overlap(relative, other))) throw new Error(`Overlapping task paths: ${file}`);
			normalized.push(relative);
		}
		const current = statusPaths(await this.#repo.statusPorcelain({ untracked: "all", nulTerminated: true }));
		for (const file of normalized) {
			if ([...this.#baseline.dirtyPaths, ...current].some(dirty => overlap(file, dirty)))
				throw new Error(`Task overlaps existing dirty path: ${file}`);
		}
		const head = await this.#repo.headSha();
		if (!head) throw new Error("Git HEAD disappeared");
		if (this.#task || SpecGitService.#owners.has(this.cwd))
			throw new Error("Git task publication must be serialized");
		this.#task = { taskId, ownedPaths: normalized.sort(), base: head, head, commits: [], fixes: [] };
		SpecGitService.#owners.set(this.cwd, this);
		return structuredClone(this.#task);
	}
	async commitTask(taskId: string, message: string, findingIds: readonly string[] = []): Promise<SpecTaskCommit> {
		const task = this.#requireTask(taskId);
		if (this.#busy || !message.trim()) throw new Error("Concurrent or unnamed task commit");
		this.#busy = true;
		try {
			if ((await this.#repo.headSha()) !== task.head)
				throw new Error("Another commit contaminated the task review range");
			const dirty = statusPaths(await this.#repo.statusPorcelain({ untracked: "all", nulTerminated: true }));
			const changedPaths = dirty.filter(file => task.ownedPaths.includes(file));
			if (!changedPaths.length)
				return { taskId, base: task.base, head: task.head, changedPaths: [], findingIds: [...findingIds] };
			// Native partial commits copy only these staged paths into HEAD's tree. Other index entries remain untouched.
			await this.#repo.stageFiles(changedPaths);
			let commit: string;
			try {
				commit = await this.#repo.commitCreate(message, { files: changedPaths, allowEmpty: false, amend: false });
			} catch (error) {
				// Owned paths were clean at admission; undo only our staging, never another user's index.
				await this.#repo.unstage(changedPaths);
				throw error;
			}
			const details = await this.#repo.commitDetails(commit);
			if (details.parents.length !== 1 || details.parents[0] !== task.head)
				throw new Error("Task commit parent changed during publication");
			const actual = await this.#repo.diffChanges({ base: task.head, head: commit });
			if (
				actual.some(
					change =>
						!task.ownedPaths.includes(change.path) ||
						(change.previousPath && !task.ownedPaths.includes(change.previousPath)),
				)
			)
				throw new Error("Task commit contains unowned changes");
			task.head = commit;
			task.commits.push(commit);
			if (findingIds.length) task.fixes.push({ commit, findingIds: [...findingIds] });
			return { taskId, base: task.base, head: task.head, commit, changedPaths, findingIds: [...findingIds] };
		} finally {
			this.#busy = false;
		}
	}
	async reviewPackage(
		taskId: string,
		planPath: string,
		outputPath: string,
		signal?: AbortSignal,
	): Promise<{ path: string; content: string; base: string; head: string }> {
		const task = this.#requireTask(taskId);
		if (!task.commits.length || task.base === task.head)
			throw new Error("No-change tasks use validation/document evidence, not review-package");
		if ((await this.#repo.headSha()) !== task.head) throw new Error("Task range contaminated by an external commit");
		const revisions = await this.#repo.revListRange(task.base, task.head);
		if (revisions.length !== task.commits.length || revisions.some(commit => !task.commits.includes(commit)))
			throw new Error("Task range contains another task's commits");
		const output = await containedSpecPath(this.cwd, outputPath);
		try {
			await fs.lstat(output);
			throw new Error("Review package output already exists");
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
		}
		if (task.ownedPaths.includes(path.relative(this.cwd, output).replaceAll(path.sep, "/")))
			throw new Error("Review output cannot overwrite a task source");
		await fs.mkdir(path.dirname(output), { recursive: true });
		const plan = await containedSpecPath(this.cwd, planPath);
		if (!(await fs.stat(plan)).isFile()) throw new Error("Review requires the approved unique plan");
		const result = await runSuperpowersScript(
			"skills/subagent-driven-development/scripts/review-package",
			[plan, task.base, task.head, output],
			this.cwd,
			signal,
		);
		if (result.exitCode !== 0)
			throw new Error(`review-package failed (${result.exitCode}): ${result.stderr}\n${result.stdout}`);
		return { path: outputPath, content: await fs.readFile(output, "utf8"), base: task.base, head: task.head };
	}
	finishTask(taskId: string): SpecTaskGitState {
		const task = this.#requireTask(taskId);
		if (this.#busy) throw new Error("Task commit is still running");
		this.#task = undefined;
		SpecGitService.#owners.delete(this.cwd);
		return structuredClone(task);
	}
	#requireTask(taskId: string): SpecTaskGitState {
		if (!this.#task || this.#task.taskId !== taskId) throw new Error("No active Git task with this ID");
		return this.#task;
	}
}
