import type { GitStatus } from "./types";

/** Count porcelain v1 -z entries; rename/copy source paths are not separate changes. */
export function parseGitStatus(porcelain: string): GitStatus {
	const status: GitStatus = { staged: 0, unstaged: 0, untracked: 0, changed: 0 };
	let offset = 0;
	while (offset < porcelain.length) {
		const end = porcelain.indexOf("\0", offset);
		if (end < 0) break;
		const index = porcelain[offset];
		const worktree = porcelain[offset + 1];
		if (index === "?" && worktree === "?") {
			status.untracked++;
			status.changed++;
		} else if (index !== "!" && (index !== " " || worktree !== " ")) {
			if (index !== " ") status.staged++;
			if (worktree !== " ") status.unstaged++;
			status.changed++;
		}
		offset = end + 1;
		if (index === "R" || index === "C" || worktree === "R" || worktree === "C") {
			const sourceEnd = porcelain.indexOf("\0", offset);
			if (sourceEnd < 0) break;
			offset = sourceEnd + 1;
		}
	}
	return status;
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
