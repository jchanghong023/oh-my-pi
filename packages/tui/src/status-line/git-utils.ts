import type { GitStatus } from "./types";

/** Count distinct porcelain v1 -z paths; rename/copy sources are not separate changes. */
export function parseGitStatus(porcelain: string): GitStatus {
	const staged = new Set<string>();
	const unstaged = new Set<string>();
	const untracked = new Set<string>();
	let offset = 0;
	while (offset < porcelain.length) {
		const end = porcelain.indexOf("\0", offset);
		if (end < 0) break;
		const index = porcelain[offset];
		const worktree = porcelain[offset + 1];
		const path = porcelain.slice(offset + 3, end);
		if (index === "?" && worktree === "?") {
			untracked.add(path);
		} else if (index !== "!" && (index !== " " || worktree !== " ")) {
			if (index !== " ") staged.add(path);
			if (worktree !== " ") unstaged.add(path);
		}
		offset = end + 1;
		if (index === "R" || index === "C" || worktree === "R" || worktree === "C") {
			const sourceEnd = porcelain.indexOf("\0", offset);
			if (sourceEnd < 0) break;
			offset = sourceEnd + 1;
		}
	}
	const changed = new Set(staged);
	for (const path of unstaged) changed.add(path);
	for (const path of untracked) changed.add(path);
	return {
		staged: staged.size,
		unstaged: unstaged.size,
		untracked: untracked.size,
		changed: changed.size,
		paths: { staged: [...staged], unstaged: [...unstaged], untracked: [...untracked] },
	};
}

/**
 * Extract "owner/repo" from a GitHub remote URL.
 * Handles HTTPS, SSH (scp-style), and git:// protocols.
 *
 * @returns "owner/repo" or null if the URL isn't a recognized GitHub remote.
 */
export function parseGitHubRepo(remoteUrl: string): string | null {
	const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/]+)/);
	if (!match) return null;
	return match[1].replace(/\.git$/, "");
}

/**
 * Extract the branch name from a remote HEAD ref like "origin/main".
 * Returns the portion after the first "/" or the whole string if no "/" is present.
 */
export function parseDefaultBranch(ref: string): string {
	const slash = ref.indexOf("/");
	return slash >= 0 ? ref.slice(slash + 1) : ref;
}

export interface PrCacheContext {
	branch: string;
	repoId: string | null;
}

export function createPrCacheContext(branch: string, repoId: string | null): PrCacheContext {
	return { branch, repoId };
}

export function isSamePrCacheContext(a: PrCacheContext | undefined, b: PrCacheContext | undefined): boolean {
	if (!a || !b) return false;
	return a.branch === b.branch && a.repoId === b.repoId;
}

export function canReuseCachedPr(
	cachedPr: { number: number; url: string } | null | undefined,
	cachedContext: PrCacheContext | undefined,
	currentContext: PrCacheContext | null,
): boolean {
	return cachedPr !== undefined && currentContext !== null && isSamePrCacheContext(cachedContext, currentContext);
}
