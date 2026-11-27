/** Managed linked worktrees and native/task-isolation directories. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreesDir, hashPath, isEnoent, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { hasLiveIsolationOwner, ISOLATION_OWNER_FILE, readRetainedMountBackend } from "../task/isolation-ownership";
import { releaseOvnfsCheckout } from "../ovnfs/task-record";
import type { ManagedWorktree } from "./backend";
import { OVNFS_RECORD_DIR } from "./ovnfs-records";

type WorktreeKind = Exclude<ManagedWorktree["kind"], "ovnfs">;
const TASK_ISOLATION_MOUNT_DIRS = ["m", "merged"] as const;

/** Ownership marker in Git's admin directory, never in the user's checkout. */
export function sessionWorktreeMarker(gitDir: string): string {
	return path.join(gitDir, "omp-session-worktree");
}

interface DiskEntry {
	path: string;
	/** Classification of what we found on disk. */
	kind: WorktreeKind;
	/** Parent repo root, when this is a registered git worktree. */
	parentRepo?: string;
	/** Branch name extracted from the parent's tracking file, when available. */
	branch?: string;
	/** When set, the entry is unhealthy and `omp worktree clear` will remove it. */
	orphanReason?: string;
}

/**
 * Run native teardown on a retained workspace before recursive removal.
 * Recursive `rm` through a live overlay mount destroys the preserved upper
 * layer entry by entry and then fails on the mountpoint itself (likewise a
 * Btrfs subvolume root, removable only via subvolume delete) — and mounts
 * survive the owning session, so the reclaim path (unlike teardown) cannot
 * rely on the creator to stop them. Side-effect-free without a retained-
 * backend sidecar (returns false); throws when the sidecar cannot be read
 * or teardown itself fails, so the caller skips removal instead of
 * traversing a possibly live mount — the entry is then reported failed
 * with the error, data intact.
 */
async function stopRetainedMount(dir: string): Promise<boolean> {
	const backend = await readRetainedMountBackend(dir);
	if (backend === undefined) return false;
	for (const name of TASK_ISOLATION_MOUNT_DIRS) {
		const candidate = path.join(dir, name);
		if (
			await fs
				.stat(candidate)
				.then(stat => stat.isDirectory())
				.catch(() => false)
		) {
			await natives.isoStop(backend, candidate);
			return true;
		}
	}
	return false;
}

/** Discover entries in the managed base and session worktrees registered with the current repository. */
export async function managedGitWorktrees(cwd?: string): Promise<ManagedWorktree[]> {
	const entries = (await scanWorktrees()).map(entry => ({ ...entry, remove: () => removeEntry(entry) }));
	const known = new Set(entries.map(entry => resolveEquivalentPath(entry.path)));
	const repo = cwd === undefined ? null : vcs.git(cwd);
	if (!repo) return entries;
	const primary = repo.primaryRoot();
	const commonDir = resolveEquivalentPath(repo.info().commonDir);
	const adminRoot = path.join(commonDir, "worktrees");
	const hashes = new Set([hashPath(primary), hashPath(resolveEquivalentPath(primary))]);
	for (const wt of (await repo.worktrees()).slice(1)) {
		const root = resolveEquivalentPath(wt.path);
		if (known.has(root)) continue;
		const belongsToRepo = (checkout: ReturnType<typeof vcs.requireGit>) => {
			const info = checkout.info();
			return (
				resolveEquivalentPath(info.repoRoot) === root &&
				resolveEquivalentPath(info.commonDir) === commonDir &&
				path.relative(adminRoot, path.dirname(resolveEquivalentPath(info.gitDir))) === ""
			);
		};
		const checkout = vcs.git(root);
		if (!checkout || !belongsToRepo(checkout)) continue;
		const gitDir = checkout.info().gitDir;
		const marked = await Bun.file(sessionWorktreeMarker(gitDir)).exists();
		const branch = wt.branch?.replace(/^refs\/heads\//, "");
		if (!marked) {
			// Before we recorded ownership, `/wt` used the branch's slug and the
			// primary checkout's hash, plus a bounded numeric collision suffix.
			if (!branch) continue;
			const slug = branch.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
			const name = path.basename(root).replace(/-(?:[2-9]|[1-9]\d|100)$/, "");
			if (![...hashes].some(hash => name === `${slug}-${hash}`)) continue;
		}
		known.add(root);
		entries.push({
			path: root,
			kind: "pr-checkout",
			parentRepo: primary,
			branch,
			remove: async () => {
				const current = vcs.git(root);
				if (
					!current ||
					!belongsToRepo(current) ||
					current.info().gitDir !== gitDir ||
					!(await repo.worktreeRemove(root, true))
				) {
					throw new Error(`Git refused to remove worktree ${root}`);
				}
			},
		});
	}
	return entries;
}

async function removeEntry(entry: DiskEntry): Promise<void> {
	const parent = entry.parentRepo ? vcs.git(entry.parentRepo) : null;
	if (entry.kind === "pr-checkout" && !entry.orphanReason && (await parent?.worktreeRemove(entry.path, true))) return;
	if (entry.kind === "task-isolation") {
		await stopRetainedMount(entry.path);
		await releaseOvnfsCheckout(entry.path);
	}
	await fs.rm(entry.path, { recursive: true, force: true });
	await parent?.worktreePrune().catch(() => {});
}

async function scanWorktrees(): Promise<DiskEntry[]> {
	const root = getWorktreesDir();
	let topLevel: string[];
	try {
		topLevel = await fs.readdir(root);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const entries: DiskEntry[] = [];
	for (const name of topLevel) {
		if (name === OVNFS_RECORD_DIR) continue;
		const dir = path.join(root, name);
		const stat = await fs.stat(dir).catch(() => null);
		if (!stat?.isDirectory()) continue;

		const direct = await classifyDir(dir);
		if (direct) {
			entries.push(direct);
			continue;
		}

		// Legacy nesting: ~/.omp/wt/<encoded-project>/<branch-or-id>
		let children: string[];
		try {
			children = await fs.readdir(dir);
		} catch {
			continue;
		}
		let nested = 0;
		for (const child of children) {
			const childDir = path.join(dir, child);
			const childStat = await fs.stat(childDir).catch(() => null);
			if (!childStat?.isDirectory()) continue;
			const childClassified = await classifyDir(childDir);
			if (childClassified) {
				entries.push(childClassified);
				nested += 1;
			}
		}
		if (nested === 0) {
			entries.push({
				path: dir,
				kind: children.length === 0 ? "empty" : "stray",
				orphanReason: children.length === 0 ? "empty directory" : "no recognizable worktree contents",
			});
		}
	}
	return entries;
}

async function classifyDir(dir: string): Promise<DiskEntry | null> {
	const gitEntry = path.join(dir, ".git");
	const gitStat = await fs.stat(gitEntry).catch(() => null);
	if (gitStat?.isFile()) {
		return classifyPrCheckout(dir, gitEntry);
	}
	// A task-isolation sandbox is identified by its ownership marker — written
	// before the backend materialises the mount — or by the `m`/`merged` mount
	// dir itself (legacy dirs and crashed pre-marker runs). Recognizing the
	// marker alone keeps an in-progress sandbox from being mistaken for a stray
	// during the window between marker creation and mount materialisation.
	let isIsolation = await Bun.file(path.join(dir, ISOLATION_OWNER_FILE)).exists();
	if (!isIsolation) {
		for (const mountDir of TASK_ISOLATION_MOUNT_DIRS) {
			const mountStat = await fs.stat(path.join(dir, mountDir)).catch(() => null);
			if (mountStat?.isDirectory()) {
				isIsolation = true;
				break;
			}
		}
	}
	if (!isIsolation) return null;
	const live = await hasLiveIsolationOwner(dir);
	return {
		path: dir,
		kind: "task-isolation",
		// Only after confirming no live owner is the "no live task" claim true.
		// A running subagent's sandbox stays live so `clear` won't delete it.
		orphanReason: live ? undefined : "task-isolation leftover (no live task owns it)",
	};
}

async function classifyPrCheckout(dir: string, gitEntry: string): Promise<DiskEntry> {
	let contents: string;
	try {
		contents = await fs.readFile(gitEntry, "utf8");
	} catch (err) {
		return {
			path: dir,
			kind: "pr-checkout",
			orphanReason: `cannot read .git file: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
	const parentGitDir = match?.[1];
	if (!parentGitDir) {
		return { path: dir, kind: "pr-checkout", orphanReason: "malformed .git file (no gitdir line)" };
	}
	// parentGitDir is `<parent-repo>/.git/worktrees/<name>`; back out the repo root.
	const parentRepo = path.dirname(path.dirname(path.dirname(parentGitDir)));
	const branch = await readWorktreeBranch(path.join(parentGitDir, "HEAD"));

	const parentDirStat = await fs.stat(parentGitDir).catch(() => null);
	if (!parentDirStat?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo no longer tracks this worktree",
		};
	}
	const parentRepoStat = await fs.stat(parentRepo).catch(() => null);
	if (!parentRepoStat?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo missing",
		};
	}
	return { path: dir, kind: "pr-checkout", parentRepo, branch };
}

async function readWorktreeBranch(headFile: string): Promise<string | undefined> {
	try {
		const head = (await fs.readFile(headFile, "utf8")).trim();
		const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		return refMatch?.[1];
	} catch {
		return undefined;
	}
}
