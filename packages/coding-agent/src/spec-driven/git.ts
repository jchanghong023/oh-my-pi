import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { randomUUID } from "node:crypto";
import { applyEligibleNestedPatches, mergeIsolatedChanges } from "../task/isolation-runner";
import { mergeTaskBranches } from "../task/worktree";
import { withRepoLock } from "../utils/repo-lock";
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
	workspace: string;
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
	/** Host-only: supplied only after the unique controller checkpoints this target binding as completed. */
	priorTaskId?: string;
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
interface TaskBinding {
	task: SpecTaskGitState;
	repo: VcsGitRepo;
	/** Native Git paths are repository-root-relative; public ownership stays workspace-relative. */
	repoOwnedPaths: string[];
	key: string;
	planVersion: string;
	targetWorkspace: boolean;
	checkpointCompleted?: true;
	/** Keep the last completed authority while a replacement is released without a completed checkpoint. */
	completedPrior?: TaskBinding;
	busy: boolean;
	reviews: Array<{ path: string; content: string; base: string; head: string }>;
	frozen?: SpecFrozenSource;
}

export interface SpecFrozenSource {
	base: string;
	head: string;
	sourceWorkspace: string;
	evidencePath: string;
}

export interface SpecNativeSource {
	sourceId: string;
	taskId: string;
	sourceWorkspace: string;
	base: string;
	head: string;
	branchName?: string;
	branchBaseSha?: string;
	branchHead?: string;
	evidencePath: string;
}

export interface SpecNestedTargetFact {
	workspace: string;
	head: string | null;
	status: string;
	error?: string;
}

export interface SpecNativePublication {
	source: SpecNativeSource;
	targetWorkspace: string;
	beforeHead: string;
	afterHead: string;
	commits: string[];
	changedPaths: string[];
	merged: string[];
	failed: string[];
	conflict?: string;
	partial: boolean;
	complete: boolean;
	beforeStatus: string;
	afterStatus: string;
	beforeDiff: string;
	afterDiff: string;
	nestedBefore: SpecNestedTargetFact[];
	nestedAfter: SpecNestedTargetFact[];
}

interface RegisteredSource {
	facts: SpecNativeSource;
	outcome: SingleResult;
	ownedPaths: string[];
	attempted: boolean;
	captureError?: string;
}

/** Shared checkouts serialize; native checkouts with separate Git metadata may run concurrently. */
export class SpecGitService {
	readonly cwd: string;
	readonly projectRoot: string;
	readonly #repoRoot: string;
	readonly #repo: VcsGitRepo;
	#baseline?: SpecGitBaseline;
	readonly #tasks = new Map<string, TaskBinding>();
	readonly #finished = new Map<string, TaskBinding>();
	readonly #sources = new Map<string, RegisteredSource>();
	static readonly #owners = new Map<string, SpecGitService>();
	/** The host supplies the approved execution cwd and the authoritative project document root. */
	constructor(cwd: string, options: { projectRoot?: string } = {}) {
		this.cwd = path.resolve(cwd);
		this.projectRoot = path.resolve(options.projectRoot ?? cwd);
		this.#repoRoot = vcs.requireGit(cwd).info().repoRoot;
		this.#repo = vcs.requireGit(this.#repoRoot);
	}
	async #readBaseline(repo: VcsGitRepo): Promise<SpecGitBaseline> {
		const head = await repo.headSha();
		if (!head)
			throw new Error("A real existing Git HEAD is required; initialize/commit explicitly outside the workflow");
		const status = await repo.statusPorcelain({ untracked: "all", nulTerminated: true });
		return { head, status, dirtyPaths: statusPaths(status), version: artifactVersion(`${head}\0${status}`) };
	}
	async preflight(): Promise<SpecGitBaseline> {
		if (this.#tasks.size) throw new Error("Cannot replace Git baseline during a task");
		await containedSpecPath(this.projectRoot, path.relative(this.projectRoot, this.cwd) || ".");
		this.#baseline = await this.#readBaseline(this.#repo);
		return structuredClone(this.#baseline);
	}
	async beginTask(
		taskId: string,
		ownedPaths: readonly string[],
		authorization: SpecCommitAuthorization,
		workspace = this.cwd,
	): Promise<SpecTaskGitState> {
		if (
			!authorization.executionApproved ||
			!authorization.planVersion ||
			authorization.planVersion !== authorization.expectedPlanVersion
		)
			throw new Error("Local commits require current approved execution");
		if (!this.#baseline) throw new Error("Git preflight must precede task execution");
		const repoRoot = await fs.realpath(vcs.requireGit(workspace).info().repoRoot);
		const repo = vcs.requireGit(repoRoot);
		const cwd = await fs.realpath(workspace);
		await containedSpecPath(repoRoot, path.relative(repoRoot, cwd) || ".");
		const targetRoot = await fs.realpath(this.#repoRoot);
		const targetWorkspace = await fs.realpath(this.cwd);
		if (path.relative(repoRoot, cwd) !== path.relative(targetRoot, targetWorkspace))
			throw new Error("Git task workspace must preserve the approved execution subdirectory");
		// Native sources have independent common metadata; shared refs/index owners remain serialized.
		const keyPath = await fs.realpath(repo.info().commonDir);
		const key = process.platform === "win32" ? keyPath.toLowerCase() : keyPath;
		if (!taskId || this.#tasks.has(taskId) || SpecGitService.#owners.has(key))
			throw new Error("Git task publication must be serialized");
		const baseline = repoRoot === targetRoot ? this.#baseline : await this.#readBaseline(repo);
		const normalized: string[] = [];
		const repoOwnedPaths: string[] = [];
		for (const file of ownedPaths) {
			const target = await containedSpecPath(cwd, file);
			const relative = path.relative(cwd, target).replaceAll(path.sep, "/");
			if (!relative || relative === ".git" || relative.startsWith(".git/") || /[*?\[\]]/.test(relative))
				throw new Error(`Task ownership must name precise files: ${file}`);
			try {
				if (!(await fs.stat(target)).isFile()) throw new Error(`Task ownership is not a regular file: ${file}`);
			} catch (error) {
				if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
			}
			if (normalized.some(other => overlap(relative, other))) throw new Error(`Overlapping task paths: ${file}`);
			normalized.push(relative);
			repoOwnedPaths.push(path.relative(repoRoot, target).replaceAll(path.sep, "/"));
		}
		normalized.sort();
		const releasedPrior =
			authorization.priorTaskId === undefined ? undefined : this.#finished.get(authorization.priorTaskId);
		const prior = releasedPrior?.checkpointCompleted ? releasedPrior : releasedPrior?.completedPrior;
		// finishTask releases Git ownership, not controller completion; the host owns completed-checkpoint provenance.
		if (
			authorization.priorTaskId !== undefined &&
			(!prior ||
				!prior.targetWorkspace ||
				!prior.checkpointCompleted ||
				prior.frozen ||
				cwd !== targetWorkspace ||
				prior.task.workspace !== cwd ||
				prior.planVersion !== authorization.planVersion ||
				prior.task.ownedPaths.length !== normalized.length ||
				prior.task.ownedPaths.some((file, index) => file !== normalized[index]))
		)
			throw new Error("Repair requires an exact finished target Git binding for the current approved plan");
		const current = statusPaths(await repo.statusPorcelain({ untracked: "all", nulTerminated: true }));
		for (const file of repoOwnedPaths) {
			if (
				baseline.dirtyPaths.some(dirty => overlap(file, dirty)) ||
				(!prior && current.some(dirty => overlap(file, dirty)))
			)
				throw new Error(`Task overlaps existing dirty path: ${file}`);
		}
		const head = await repo.headSha();
		if (!head) throw new Error("Git HEAD disappeared");
		if (this.#tasks.has(taskId) || SpecGitService.#owners.has(key))
			throw new Error("Git task publication must be serialized");
		if (prior && this.#finished.get(authorization.priorTaskId!) !== releasedPrior)
			throw new Error("Repair prior Git binding changed during admission");
		const task: SpecTaskGitState = {
			taskId,
			workspace: cwd,
			ownedPaths: normalized,
			base: head,
			head,
			commits: [],
			fixes: [],
		};
		const previous = this.#finished.get(taskId);
		this.#tasks.set(taskId, {
			task,
			repo,
			repoOwnedPaths,
			key,
			planVersion: authorization.planVersion,
			targetWorkspace: repoRoot === targetRoot && cwd === targetWorkspace,
			completedPrior: previous?.checkpointCompleted ? previous : previous?.completedPrior,
			busy: false,
			reviews: [],
		});
		SpecGitService.#owners.set(key, this);
		return structuredClone(task);
	}
	async commitTask(taskId: string, message: string, findingIds: readonly string[] = []): Promise<SpecTaskCommit> {
		const binding = this.#requireTask(taskId);
		const { task, repo } = binding;
		if (binding.busy || !message.trim()) throw new Error("Concurrent or unnamed task commit");
		binding.busy = true;
		try {
			if ((await repo.headSha()) !== task.head) throw new Error("Another commit contaminated the task review range");
			const dirty = statusPaths(await repo.statusPorcelain({ untracked: "all", nulTerminated: true }));
			const changedPaths = dirty.filter(file => binding.repoOwnedPaths.includes(file));
			if (!changedPaths.length)
				return { taskId, base: task.base, head: task.head, changedPaths: [], findingIds: [...findingIds] };
			// Native partial commits preserve unrelated staged and untracked user work.
			await repo.stageFiles(changedPaths);
			let commit: string;
			try {
				commit = await repo.commitCreate(message, { files: changedPaths, allowEmpty: false, amend: false });
			} catch (error) {
				await repo.unstage(changedPaths);
				throw error;
			}
			const details = await repo.commitDetails(commit);
			if (details.parents.length !== 1 || details.parents[0] !== task.head)
				throw new Error("Task commit parent changed during publication");
			await this.#assertOwned(repo, task.head, commit, binding.repoOwnedPaths);
			task.head = commit;
			task.commits.push(commit);
			if (findingIds.length) task.fixes.push({ commit, findingIds: [...findingIds] });
			return {
				taskId,
				base: task.base,
				head: task.head,
				commit,
				changedPaths: changedPaths.map(file =>
					path.relative(task.workspace, path.join(repo.info().repoRoot, file)).replaceAll(path.sep, "/"),
				),
				findingIds: [...findingIds],
			};
		} finally {
			binding.busy = false;
		}
	}
	/** Plan paths are project-relative; output paths are repo-relative for native .git capture exclusion. */
	async reviewPackage(
		taskId: string,
		planPath: string,
		outputPath: string,
		signal?: AbortSignal,
	): Promise<{ path: string; content: string; base: string; head: string }> {
		const binding = this.#requireTask(taskId);
		const { task, repo } = binding;
		if (binding.busy) throw new Error("Task commit is still running");
		binding.busy = true;
		try {
			if (!task.commits.length || task.base === task.head)
				throw new Error("No-change tasks use validation/document evidence, not review-package");
			if ((await repo.headSha()) !== task.head) throw new Error("Task range contaminated by an external commit");
			const revisions = await repo.revListRange(task.base, task.head);
			if (revisions.length !== task.commits.length || revisions.some(commit => !task.commits.includes(commit)))
				throw new Error("Task range contains another task's commits");
			const output = await containedSpecPath(repo.info().repoRoot, outputPath);
			try {
				await fs.lstat(output);
				throw new Error("Review package output already exists");
			} catch (error) {
				if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
			}
			if (binding.repoOwnedPaths.includes(path.relative(repo.info().repoRoot, output).replaceAll(path.sep, "/")))
				throw new Error("Review output cannot overwrite a task source");
			await fs.mkdir(path.dirname(output), { recursive: true });
			const plan = await containedSpecPath(this.projectRoot, planPath);
			if (!(await fs.stat(plan)).isFile()) throw new Error("Review requires the approved unique plan");
			const result = await runSuperpowersScript(
				"skills/subagent-driven-development/scripts/review-package",
				[plan, task.base, task.head, output],
				task.workspace,
				signal,
			);
			if (result.exitCode !== 0)
				throw new Error(`review-package failed (${result.exitCode}): ${result.stderr}\n${result.stdout}`);
			const review = {
				path: outputPath,
				content: await fs.readFile(output, "utf8"),
				base: task.base,
				head: task.head,
			};
			binding.reviews.push(review);
			return review;
		} finally {
			binding.busy = false;
		}
	}
	/** Host-only attestation after the unique controller checkpoints this exact target binding as completed. */
	finishVerifiedTask(taskId: string): void {
		const binding = this.#tasks.get(taskId) ?? this.#finished.get(taskId);
		if (!binding || !binding.targetWorkspace || binding.frozen || binding.busy)
			throw new Error("Completed checkpoint attestation requires an idle target Git binding");
		binding.checkpointCompleted = true;
		delete binding.completedPrior;
	}
	finishTask(taskId: string): SpecTaskGitState {
		const binding = this.#requireTask(taskId);
		if (binding.busy) throw new Error("Task commit is still running");
		this.#tasks.delete(taskId);
		this.#finished.set(taskId, binding);
		SpecGitService.#owners.delete(binding.key);
		return structuredClone(binding.task);
	}
	/** Freeze live source facts in an owned session disposer, before native isolation cleanup. */
	async freezeTaskSource(bindingTaskId: string, checksDirectory: string): Promise<SpecFrozenSource> {
		const binding = this.#tasks.get(bindingTaskId);
		if (!binding || binding.busy) throw new Error("Source freeze requires an idle owned Git binding");
		binding.busy = true;
		try {
			const { task, repo } = binding;
			const head = await repo.headSha();
			if (!head) throw new Error("Source Git HEAD disappeared");
			const directory = await containedSpecPath(this.projectRoot, checksDirectory);
			await fs.mkdir(directory, { recursive: true });
			const evidencePath = path
				.relative(this.projectRoot, path.join(directory, `frozen-${randomUUID()}.json`))
				.replaceAll(path.sep, "/");
			const facts = { base: task.base, head, sourceWorkspace: task.workspace, evidencePath };
			await fs.writeFile(
				path.join(this.projectRoot, evidencePath),
				JSON.stringify(
					{
						...facts,
						bindingTaskId,
						ownedPaths: task.ownedPaths,
						repoOwnedPaths: binding.repoOwnedPaths,
						commits: task.commits,
						fixes: task.fixes,
						reviews: binding.reviews,
						status: await repo.statusPorcelain({ untracked: "all", nulTerminated: true }),
						committedDiff: await repo.diffText({ base: task.base, head }),
						stagedDiff: await repo.diffText({ cached: true }),
						unstagedDiff: await repo.diffText({}),
					},
					null,
					2,
				),
				{ flag: "wx" },
			);
			binding.frozen = facts;
			return structuredClone(facts);
		} finally {
			binding.busy = false;
		}
	}
	/**
	 * Host-only registration of observed native capture outcomes, never a model tool.
	 * Source cwd may already be gone: consume frozen facts and surviving native artifacts only.
	 */
	async registerNativeSource(
		bindingTaskId: string,
		outcome: SingleResult,
		checksDirectory: string,
		parentTaskId = bindingTaskId,
	): Promise<SpecNativeSource> {
		const binding = this.#tasks.get(bindingTaskId) ?? this.#finished.get(bindingTaskId);
		if (!binding || binding.busy || !binding.frozen)
			throw new Error("Native source requires a frozen owned Git binding");
		const { task } = binding;
		const sourceId = randomUUID();
		const directory = await containedSpecPath(this.projectRoot, checksDirectory);
		await fs.mkdir(directory, { recursive: true });
		const evidencePath = path
			.relative(this.projectRoot, path.join(directory, `source-${sourceId}.json`))
			.replaceAll(path.sep, "/");
		const frozen = structuredClone(outcome);
		let rootPatch = "";
		const nestedArtifacts: Array<{ path: string; content: string }> = [];
		let artifactError: string | undefined;
		try {
			if (outcome.patchPath) rootPatch = await fs.readFile(outcome.patchPath, "utf8");
			for (const file of outcome.nestedPatchPaths ?? []) {
				nestedArtifacts.push({ path: file, content: await fs.readFile(file, "utf8") });
			}
		} catch (error) {
			artifactError = error instanceof Error ? error.message : String(error);
		}
		const facts: SpecNativeSource = {
			sourceId,
			taskId: parentTaskId,
			sourceWorkspace: task.workspace,
			base: binding.frozen.base,
			head: binding.frozen.head,
			branchName: outcome.branchName,
			branchBaseSha: outcome.branchBaseSha,
			evidencePath,
		};
		const raw = {
			...facts,
			bindingTaskId,
			ownedPaths: task.ownedPaths,
			commits: task.commits,
			fixes: task.fixes,
			frozenSource: JSON.parse(await fs.readFile(path.join(this.projectRoot, binding.frozen.evidencePath), "utf8")),
			outcome: frozen,
			rootPatch,
			nestedArtifacts,
		};
		// Preserve capture failures and raw source reviews before any publication eligibility check.
		await fs.writeFile(path.join(this.projectRoot, evidencePath), JSON.stringify(raw, null, 2), { flag: "wx" });
		let captureError: string | undefined;
		let capturedDiff: string | undefined;
		try {
			if (artifactError) throw new Error(`Native capture artifact is unavailable: ${artifactError}`);
			if (outcome.hasRootChanges === true && !outcome.branchName && !outcome.patchPath)
				throw new Error("Native root delta has no captured branch or patch");
			if (outcome.exitCode !== 0 || outcome.error || outcome.aborted)
				throw new Error(outcome.error || "Native source did not finish successfully");
			if (outcome.branchName) {
				if (!outcome.branchBaseSha) throw new Error("Native branch capture omitted its actual baseline");
				const details = await this.#repo.commitDetails(outcome.branchName);
				facts.branchHead = details.sha;
				capturedDiff = await this.#repo.diffText({ base: outcome.branchBaseSha, head: details.sha });
				const revisions = await this.#repo.revListRange(outcome.branchBaseSha, outcome.branchName);
				for (const revision of revisions) {
					const commit = await this.#repo.commitDetails(revision);
					if (commit.parents.length !== 1) throw new Error("Native source range is not a linear task range");
					await this.#assertOwned(this.#repo, commit.parents[0]!, revision, binding.repoOwnedPaths);
				}
			}
			this.#assertPatchOwned(rootPatch, "", binding.repoOwnedPaths);
			for (const nested of outcome.nestedPatches ?? []) {
				await containedSpecPath(this.#repoRoot, nested.relativePath);
				this.#assertPatchOwned(nested.patch, nested.relativePath, binding.repoOwnedPaths);
			}
		} catch (error) {
			captureError = error instanceof Error ? error.message : String(error);
		}
		if (outcome.patchPath) {
			const patchFile = path.join(directory, `source-${sourceId}.patch`);
			await fs.writeFile(patchFile, rootPatch, { flag: "wx" });
			frozen.patchPath = patchFile;
		}
		await fs.writeFile(
			path.join(this.projectRoot, evidencePath),
			JSON.stringify({ ...raw, ...facts, capturedDiff, captureError }, null, 2),
		);
		this.#sources.set(sourceId, {
			facts,
			outcome: frozen,
			ownedPaths: [...binding.repoOwnedPaths],
			attempted: false,
			captureError,
		});
		return structuredClone(facts);
	}
	/** Only opaque registered IDs reach this model-facing operation; target is constructor-bound. */
	async integrateTask(taskId: string, sourceIds: readonly string[]): Promise<SpecNativePublication[]> {
		if (!sourceIds.length || new Set(sourceIds).size !== sourceIds.length)
			throw new Error("Integration requires distinct registered source IDs");
		const sources = sourceIds.map(id => {
			const source = this.#sources.get(id);
			if (!source || source.facts.taskId !== taskId || source.attempted)
				throw new Error("Source is not an unpublished native source of this task");
			return source;
		});
		const keyPath = await fs.realpath(this.#repo.info().commonDir);
		const key = process.platform === "win32" ? keyPath.toLowerCase() : keyPath;
		const targetBinding = this.#tasks.get(taskId);
		const ownsTarget = targetBinding?.key === key && SpecGitService.#owners.get(key) === this;
		if ((SpecGitService.#owners.has(key) && !ownsTarget) || targetBinding?.busy)
			throw new Error("Git task publication must be serialized");
		if (ownsTarget) targetBinding.busy = true;
		else SpecGitService.#owners.set(key, this);
		const publications: SpecNativePublication[] = [];
		try {
			for (const source of sources) {
				const beforeHead = await this.#repo.headSha();
				if (!beforeHead) throw new Error("Target Git HEAD disappeared");
				const beforeStatus = await this.#repo.statusPorcelain({ untracked: "all", nulTerminated: true });
				const beforeDiff = await this.#repo.diffText({ base: beforeHead });
				const nestedBefore = source.captureError ? [] : await this.#nestedTargetFacts(source.outcome);
				let conflict = source.captureError ?? nestedBefore.find(fact => fact.error)?.error;
				let merged: string[] = [];
				let failed: string[] = [];
				let complete = false;
				if (
					!conflict &&
					ownsTarget &&
					(beforeHead !== targetBinding.task.head ||
						source.ownedPaths.some(file => !targetBinding.repoOwnedPaths.includes(file)))
				)
					conflict = "Source does not match the current approved target task range or ownership";
				if (
					!conflict &&
					statusPaths(beforeStatus).some(file => source.ownedPaths.some(owned => overlap(file, owned)))
				)
					conflict = "Target task paths contain existing user changes";
				if (!conflict && source.facts.branchName) {
					try {
						const current = await this.#repo.commitDetails(source.facts.branchName);
						if (current.sha !== source.facts.branchHead)
							conflict = "Registered native branch changed before integration";
					} catch (error) {
						conflict = error instanceof Error ? error.message : String(error);
					}
				}
				source.attempted = true;
				if (!conflict) {
					try {
						if (source.facts.branchName) {
							const result = await mergeTaskBranches(this.#repoRoot, [
								{
									branchName: source.facts.branchName,
									baseSha: source.facts.branchBaseSha,
									taskId,
								},
							]);
							merged = result.merged;
							failed = result.failed;
							conflict = result.conflict;
							complete = failed.length === 0;
						} else if (source.outcome.patchPath) {
							const result = await withRepoLock(this.#repoRoot, () =>
								mergeIsolatedChanges({
									result: source.outcome,
									repoRoot: this.#repoRoot,
									mergeMode: "patch",
								}),
							);
							complete = result.changesApplied === true;
							if (!complete) conflict = result.summary;
						} else {
							complete = true;
						}
						if (complete) {
							const nested = await withRepoLock(this.#repoRoot, () =>
								applyEligibleNestedPatches({
									result: source.outcome,
									repoRoot: this.#repoRoot,
									mergeMode: source.facts.branchName ? "branch" : "patch",
									changesApplied: true,
									mergedBranchForNestedPatches: true,
								}),
							);
							if (nested) {
								conflict = nested;
								complete = false;
							}
						}
					} catch (error) {
						conflict = error instanceof Error ? error.message : String(error);
						complete = false;
					}
				}
				const afterHead = await this.#repo.headSha();
				if (!afterHead) throw new Error("Target Git HEAD disappeared after integration");
				const afterStatus = await this.#repo.statusPorcelain({ untracked: "all", nulTerminated: true });
				const afterDiff = await this.#repo.diffText({ base: afterHead });
				const nestedAfter = source.captureError ? [] : await this.#nestedTargetFacts(source.outcome);
				const nestedError = nestedAfter.find(fact => fact.error)?.error;
				if (nestedError) {
					conflict ??= nestedError;
					complete = false;
				}
				const commits = beforeHead === afterHead ? [] : await this.#repo.revListRange(beforeHead, afterHead);
				const changedPaths = [
					...new Set([
						...(await this.#repo.diffChanges({ base: beforeHead, head: afterHead })).map(change => change.path),
						...(beforeStatus !== afterStatus || beforeDiff !== afterDiff
							? statusPaths(afterStatus).filter(file => source.ownedPaths.includes(file))
							: []),
					]),
				].sort();
				if (ownsTarget) {
					targetBinding.task.head = afterHead;
					targetBinding.task.commits.push(...commits);
				}
				const publication: SpecNativePublication = {
					source: structuredClone(source.facts),
					targetWorkspace: this.cwd,
					beforeHead,
					afterHead,
					commits,
					changedPaths: changedPaths.map(file =>
						path.relative(this.cwd, path.join(this.#repoRoot, file)).replaceAll(path.sep, "/"),
					),
					merged,
					failed,
					conflict,
					complete,
					beforeStatus,
					afterStatus,
					beforeDiff,
					afterDiff,
					nestedBefore,
					nestedAfter,
					partial:
						!complete &&
						(beforeHead !== afterHead ||
							beforeStatus !== afterStatus ||
							beforeDiff !== afterDiff ||
							JSON.stringify(nestedBefore) !== JSON.stringify(nestedAfter)),
				};
				// Do not dispose source refs/artifacts: durable target facts must exist first, including partial failure.
				const output = source.facts.evidencePath.replace(/\.json$/, ".publication.json");
				await fs.writeFile(path.join(this.projectRoot, output), JSON.stringify(publication, null, 2), {
					flag: "wx",
				});
				publications.push(publication);
				if (!complete) break;
			}
			return publications;
		} finally {
			if (ownsTarget) targetBinding.busy = false;
			else SpecGitService.#owners.delete(key);
		}
	}
	async #nestedTargetFacts(outcome: SingleResult): Promise<SpecNestedTargetFact[]> {
		return Promise.all(
			[...new Set((outcome.nestedPatches ?? []).map(patch => patch.relativePath))].map(async relative => {
				let workspace = path.resolve(this.#repoRoot, relative);
				try {
					workspace = await containedSpecPath(this.#repoRoot, relative);
					const repo = vcs.requireGit(workspace);
					if ((await fs.realpath(repo.info().repoRoot)) !== (await fs.realpath(workspace)))
						throw new Error(`Captured nested target is not an independent Git repository: ${relative}`);
					return {
						workspace,
						head: (await repo.headSha()) ?? null,
						status: await repo.statusPorcelain({ untracked: "all", nulTerminated: true }),
					};
				} catch (error) {
					return {
						workspace,
						head: null,
						status: "",
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);
	}
	#assertPatchOwned(patch: string, prefix: string, ownedPaths: string[]): void {
		if (!patch.trim()) return;
		let headers = 0;
		for (const line of patch.split("\n")) {
			if (!line.startsWith("diff --git ")) continue;
			const tokens = line.slice(11).match(/"(?:\\.|[^"])*"|[^\s]+/g) ?? [];
			if (tokens.length !== 2) throw new Error("Native patch paths cannot be safely qualified");
			for (const token of tokens) {
				const file: string = token.startsWith('"') ? JSON.parse(token) : token;
				if (!/^[ab]\//.test(file)) throw new Error("Native patch has an invalid path");
				const relative = path.posix.join(prefix.replaceAll("\\", "/"), file.slice(2));
				if (!ownedPaths.includes(relative)) throw new Error(`Native patch contains unowned changes: ${relative}`);
			}
			headers++;
		}
		if (!headers) throw new Error("Native patch has no qualified file delta");
	}
	async #assertOwned(repo: VcsGitRepo, base: string, head: string, ownedPaths: string[]): Promise<void> {
		const changes = await repo.diffChanges({ base, head });
		if (
			changes.some(
				change =>
					!ownedPaths.includes(change.path) || (change.previousPath && !ownedPaths.includes(change.previousPath)),
			)
		)
			throw new Error("Task commit contains unowned changes");
	}
	#requireTask(taskId: string): TaskBinding {
		const binding = this.#tasks.get(taskId);
		if (!binding) throw new Error("No active Git task with this ID");
		return binding;
	}
}
