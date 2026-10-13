/**
 * `/wt` backing: reuse a branch's checkout or create a committed-only linked
 * worktree beside the current session directory, without changing the source.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IsoBackendKind } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { hashPath } from "@oh-my-pi/pi-utils";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { Settings } from "../config/settings";
import { formatIsolationBackend, parseIsolationBackend } from "../task/worktree";
import { resolveAvailableWorktreePath } from "../tools/gh-pr-checkout";

import { cfgIsolationBackend, cfgWorktreeClone } from "../task/settings";

export interface SessionWorktree {
	/** Worktree root, or the unchanged cwd when already on the target branch. */
	path: string;
	/** Branch checked out in the worktree. */
	branch: string;
	/** Backend that cloned the checkout, or undefined for a plain checkout. */
	clonedWith?: IsoBackendKind;
	/** Why the clone fell back to a plain checkout, when it did. */
	cloneError?: string;
	/** Checkout the worktree was forked from. */
	sourceCwd: string;
	/** Target branch's initial commit, used to detect later branch movement. */
	baseCommit: string;
	/** Whether this session created the worktree rather than reusing it. */
	created: boolean;
	/** Whether this session also created the branch. */
	createdBranch: boolean;
}

/** State of a session-owned worktree at exit. */
export interface SessionWorktreeState {
	/** Worktree has uncommitted or untracked changes. */
	dirty: boolean;
	/** Branch tip moved off `baseCommit`; the branch is kept on removal. */
	moved: boolean;
	/** Worktree `HEAD` is not the branch tip, so its commits may be on no branch. */
	offBranch: boolean;
}

/** What to do with a session-owned worktree when the session exits. */
export type WorktreeExitAction = "keep" | "remove" | "prompt";

/**
 * Map the `worktree.onExit` policy and the worktree's state to an exit action.
 * `remove` only removes worktrees with nothing to lose; anything else prompts.
 */
export function decideWorktreeExit(policy: "keep" | "ask" | "remove", state: SessionWorktreeState): WorktreeExitAction {
	if (policy === "keep") return "keep";
	if (policy === "remove" && !state.dirty && !state.moved && !state.offBranch) return "remove";
	return "prompt";
}

/** Reports whether a fresh session in `cwd` may get a worktree: a primary git checkout with commits. */
export async function canAutoCreateWorktree(cwd: string): Promise<boolean> {
	const repository = vcs.git(cwd);
	if (!repository || repository.linkedWorktree()) return false;
	return Boolean(await repository.headSha());
}

/** Default `/wt` branch name: `wt/<yyyymmdd-hhmmss>`. */
export function defaultSessionWorktreeBranch(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `wt/${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** One-line confirmation shown after the session moved into `worktree`. */
export function formatSessionWorktreeSummary(worktree: SessionWorktree): string {
	const how = !worktree.created
		? "reused existing worktree"
		: worktree.clonedWith === undefined
			? "checked out, committed branch contents"
			: `cloned via ${formatIsolationBackend(worktree.clonedWith)}, committed branch contents`;
	return `Moved to worktree ${worktree.path} on branch ${worktree.branch} (${how}).`;
}

/**
 * Resolve the worktree for `/wt`. Throws with a user-facing message when `cwd`
 * is not a git checkout, `branch` is invalid, or git refuses.
 */
export async function createSessionWorktree(cwd: string, settings: Settings, branch: string): Promise<SessionWorktree> {
	try {
		await settings.flush();
	} catch (err) {
		throw new Error(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
	}
	const repository = vcs.git(cwd);
	if (!repository) {
		throw new Error(`Not inside a git repository: ${cwd}`);
	}
	if (!/^[^\s~^:?*[\\]+$/.test(branch) || branch.startsWith("-") || branch.endsWith("/") || branch.includes("..")) {
		throw new Error(`Invalid branch name: ${branch}`);
	}
	const branchRef = `refs/heads/${branch}`;
	const branchCommit = await repository.resolveRef(branchRef);
	const createdBranch = branchCommit === null || branchCommit === undefined;
	const baseCommit = branchCommit ?? (await repository.headSha());
	if (!baseCommit) {
		throw new Error(`Cannot create a worktree: ${cwd} has no commits.`);
	}
	const worktrees = await repository.worktrees();
	if (!createdBranch) {
		const sameBranch = (await repository.currentBranch()) === branch;
		const existing = worktrees.find(entry => entry.branch === branchRef);
		const reusedPath = sameBranch ? cwd : existing ? await fs.realpath(existing.path) : undefined;
		if (reusedPath !== undefined) {
			return { path: reusedPath, branch, sourceCwd: cwd, baseCommit, created: false, createdBranch: false };
		}
	}
	const primaryRoot = repository.primaryRoot() ?? repository.info().repoRoot;
	const slug = branch.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
	const basePath = path.join(path.dirname(path.resolve(cwd)), `${slug}-${hashPath(primaryRoot)}`);
	const worktreePath = await resolveAvailableWorktreePath(basePath, worktrees);
	await fs.mkdir(path.dirname(worktreePath), { recursive: true });

	// Cloning a checkout into itself would recursively include the destination.
	const sourceRoot = await fs.realpath(repository.info().repoRoot);
	const destination = path.join(await fs.realpath(path.dirname(worktreePath)), path.basename(worktreePath));
	const relativeDestination = path.relative(sourceRoot, destination);
	const outsideSource =
		relativeDestination === ".." ||
		relativeDestination.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeDestination);

	if (createdBranch) await repository.createBranch(branch, baseCommit, false);
	const result = await repository.worktreeAdd(worktreePath, branchRef, {
		detach: false,
		clone: cfgWorktreeClone.get(settings) && outsideSource,
		backend: parseIsolationBackend(cfgIsolationBackend.get(settings)),
		keepChanges: false,
	});
	return {
		path: await fs.realpath(worktreePath),
		branch,
		clonedWith: result.clonedWith ?? undefined,
		cloneError: result.cloneError ?? undefined,
		sourceCwd: cwd,
		baseCommit,
		created: true,
		createdBranch,
	};
}

/** State of `wt` plus a fingerprint that changes whenever any file, ref, or `HEAD` in it changes. */
interface WorktreeSnapshot {
	state: SessionWorktreeState;
	fingerprint: string;
	/** Worktree directory still exists as a git checkout. */
	present: boolean;
}

async function snapshotSessionWorktree(wt: SessionWorktree): Promise<WorktreeSnapshot> {
	const sourceRepo = vcs.git(wt.sourceCwd);
	let moved = true;
	let tip: string | null | undefined;
	if (sourceRepo) {
		tip = await sourceRepo.resolveRef(`refs/heads/${wt.branch}`);
		moved = tip !== null && tip !== undefined && tip !== wt.baseCommit;
	}
	const worktreeExists = await fs.stat(wt.path).then(
		() => true,
		() => false,
	);
	const worktreeRepo = worktreeExists ? vcs.git(wt.path) : null;
	if (!worktreeRepo) {
		return { state: { dirty: false, moved, offBranch: false }, fingerprint: `missing\0${tip ?? ""}`, present: false };
	}
	const status = await worktreeRepo.statusPorcelain({ untracked: "all", nulTerminated: true });
	const head = await worktreeRepo.headSha();
	// Porcelain codes do not change when an already-modified file is edited again,
	// so fold in each changed path's size and mtime.
	const parts = [head ?? "", tip ?? "", status];
	const entries = status.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) continue;
		// Renames and copies are followed by their source path as a separate entry.
		if (entry[0] === "R" || entry[0] === "C") i++;
		const file = entry.slice(3);
		const stat = await fs.stat(path.join(wt.path, file)).catch(() => undefined);
		parts.push(stat ? `${file}:${stat.size}:${stat.mtimeMs}` : `${file}:-`);
	}
	return {
		state: { dirty: status.length > 0, moved, offBranch: Boolean(head) && head !== tip },
		fingerprint: Bun.hash(parts.join("\0")).toString(16),
		present: true,
	};
}

/**
 * Gets the state of `wt`. A missing worktree is not dirty and not off-branch; a
 * deleted branch has not moved; a missing source repo counts as moved so the
 * branch is never deleted.
 */
export async function inspectSessionWorktree(wt: SessionWorktree): Promise<SessionWorktreeState> {
	return (await snapshotSessionWorktree(wt)).state;
}

/** Describes what removing a worktree in `state` would lose, for the exit prompt. */
function describeWorktreeRisk(wt: SessionWorktree, state: SessionWorktreeState): string {
	const issues: string[] = [];
	if (state.dirty) issues.push("has uncommitted changes");
	if (state.moved) issues.push("has new commits (branch is kept)");
	if (state.offBranch) issues.push(`HEAD is not on ${wt.branch}; commits only reachable from HEAD are lost`);
	return issues.join("; ");
}

/** A worktree chosen for removal at exit. */
export interface WorktreeExitPlan {
	worktree: SessionWorktree;
	/** Snapshot fingerprint at the time removal was decided or approved. */
	approvedFingerprint: string;
}

/**
 * Applies `policy` to `owned` and returns the worktrees to remove, newest first.
 * Calls `confirm` for each worktree that needs a prompt; inspection errors go to
 * `warn` and keep that worktree.
 */
export async function planWorktreeExit(
	owned: readonly SessionWorktree[],
	policy: "keep" | "ask" | "remove",
	confirm: (title: string, message: string) => Promise<boolean>,
	warn: (message: string) => void,
): Promise<WorktreeExitPlan[]> {
	if (policy === "keep") return [];
	const plan: WorktreeExitPlan[] = [];
	// Newest first: a `/wt` worktree may have been forked from an older owned one.
	for (const worktree of owned.toReversed()) {
		try {
			const { state, fingerprint } = await snapshotSessionWorktree(worktree);
			const action = decideWorktreeExit(policy, state);
			if (action === "keep") continue;
			if (action === "remove") {
				plan.push({ worktree, approvedFingerprint: fingerprint });
				continue;
			}
			const risk = describeWorktreeRisk(worktree, state);
			const message = `${shortenPath(worktree.path)} (${worktree.branch})${risk ? `: ${risk}` : ""}`;
			if (await confirm("Remove worktree?", message)) plan.push({ worktree, approvedFingerprint: fingerprint });
		} catch (err) {
			warn(err instanceof Error ? err.message : String(err));
		}
	}
	return plan;
}

/**
 * Removes the planned worktrees in order, keeping any that changed at all since
 * removal was decided or approved. Returns one message per kept or failed
 * worktree, plus a resume note when the worktree holding the process cwd is removed.
 */
export async function removeExitWorktrees(plan: readonly WorktreeExitPlan[]): Promise<string[]> {
	const messages: string[] = [];
	for (const { worktree, approvedFingerprint } of plan) {
		try {
			const { state, fingerprint, present } = await snapshotSessionWorktree(worktree);
			// A vanished worktree holds nothing to lose; `state.moved` still guards the branch.
			if (present && fingerprint !== approvedFingerprint) {
				messages.push(`Kept worktree ${shortenPath(worktree.path)}: it changed while the session was closing.`);
				continue;
			}
			// Git cannot open the source repo while our cwd is the deleted worktree.
			const rel = path.relative(worktree.path, process.cwd());
			const holdsCwd = !rel.startsWith("..") && !path.isAbsolute(rel);
			if (holdsCwd) process.chdir(worktree.sourceCwd);
			await removeSessionWorktree(worktree, state.moved);
			if (holdsCwd) {
				const commits = state.moved ? `; its commits are on branch ${worktree.branch}` : "";
				messages.push(
					`Removed worktree ${shortenPath(worktree.path)}. Resuming opens in the directory you launch omp from${commits}.`,
				);
			}
		} catch (err) {
			messages.push(err instanceof Error ? err.message : String(err));
		}
	}
	return messages;
}

/**
 * Force-remove an owned `wt`; delete only newly created branches that have not moved.
 * Throws a user-facing error when git refuses either step.
 */
export async function removeSessionWorktree(wt: SessionWorktree, moved: boolean): Promise<void> {
	if (!wt.created) return;
	const repository = vcs.requireGit(wt.sourceCwd);
	if (!(await repository.worktreeRemove(wt.path, true))) {
		throw new Error(`Failed to remove worktree ${wt.path}; branch '${wt.branch}' kept.`);
	}
	if (wt.createdBranch && !moved && !(await repository.deleteBranch(wt.branch, true))) {
		throw new Error(`Removed worktree ${wt.path} but failed to delete branch '${wt.branch}'.`);
	}
}
