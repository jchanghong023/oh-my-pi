import type { GitStatus } from "./types";

/** Count distinct porcelain v1 -z paths for each visibility mask; skip rename/copy sources. */
export function parseGitStatus(input: Buffer | string): GitStatus {
	// Latin-1 maps every byte to a distinct code unit. These keys are compared,
	// not displayed; UTF-8 replacement would merge different invalid paths.
	const porcelain = typeof input === "string" ? input : input.toString("latin1");
	const paths = new Map<string, number>();
	let offset = 0;
	while (offset < porcelain.length) {
		const end = porcelain.indexOf("\0", offset);
		if (end === -1) throw new Error("Incomplete Git status record");
		const index = porcelain[offset];
		const worktree = porcelain[offset + 1];
		let mask = 0;
		if (index === "?" && worktree === "?") {
			mask = 4;
		} else if (index !== "!" || worktree !== "!") {
			mask = Number(index !== " ") | (Number(worktree !== " ") << 1);
		}
		if (mask !== 0) {
			const path = porcelain.slice(offset + 3, end);
			paths.set(path, (paths.get(path) ?? 0) | mask);
		}
		offset = end + 1;
		if (index === "R" || index === "C" || worktree === "R" || worktree === "C") {
			const sourceEnd = porcelain.indexOf("\0", offset);
			if (sourceEnd === -1) throw new Error("Incomplete Git status rename or copy record");
			offset = sourceEnd + 1;
		}
	}
	const histogram = [0, 0, 0, 0, 0, 0, 0, 0];
	for (const mask of paths.values()) histogram[mask]++;
	const counts: [...GitStatus] = [0, 0, 0, 0, 0, 0, 0, 0];
	for (let enabled = 1; enabled < counts.length; enabled++) {
		for (let mask = 1; mask < histogram.length; mask++) {
			if (enabled & mask) counts[enabled] += histogram[mask];
		}
	}
	return counts;
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
