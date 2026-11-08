import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo, VcsHeadState } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import {
	isEnoent,
	isProbablyBinaryHeader,
	isRecord,
	normalizePathForComparison,
	pathIsWithin,
} from "@oh-my-pi/pi-utils";
import type {
	GitChangeKind,
	GitCommitGraphCommit,
	GitCommitGraphRef,
	GitCommitGraphResult,
	GitDiffResult,
	GitFileChange,
	GitLocalBranchListResult,
	GitRefreshResult,
	GitRepositorySummary,
} from "../../../../vendor/zcode-frontend/packages/shared/src/git";
import { resolveToCwd } from "../tools/path-utils";
import { nativeReadContext, resolveNativeReadPath } from "./native-read-context";
import { WebGuiNotImplementedError, type WebGuiMethod, type WebGuiServiceContext } from "./rpc-contract";

interface RepositoryRead {
	sessionId: string;
	root: string;
	repo: VcsGitRepo | null;
	assertCurrent(): void;
}

interface StatusEntry {
	path: string;
	originalPath?: string;
	x: string;
	y: string;
}

function request(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || typeof value.workspacePath !== "string" || !value.workspacePath)
		throw new TypeError("Git reads require a workspacePath");
	if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || !value.sessionId.trim()))
		throw new TypeError("Git reads require a nonempty native sessionId");
	return value;
}

async function repositoryRead(context: WebGuiServiceContext, params: Record<string, unknown>): Promise<RepositoryRead> {
	const read = await nativeReadContext(context, typeof params.sessionId === "string" ? params.sessionId : undefined);
	if (typeof params.workspacePath !== "string") throw new TypeError("Git reads require a workspacePath");
	const requested = await fs.realpath(resolveToCwd(params.workspacePath, read.cwd));
	read.assertCurrent();
	if (normalizePathForComparison(requested) !== normalizePathForComparison(read.root))
		throw new Error("Git workspace does not match the native workspace");
	const repo = vcs.git(read.root);
	const info = repo?.info();
	return {
		sessionId: read.session.sessionId,
		root: read.root,
		repo,
		assertCurrent() {
			read.assertCurrent();
			const current = vcs.gitInfo(read.root);
			if (
				Boolean(current) !== Boolean(info) ||
				(current &&
					info &&
					(normalizePathForComparison(current.repoRoot) !== normalizePathForComparison(info.repoRoot) ||
						normalizePathForComparison(current.gitDir) !== normalizePathForComparison(info.gitDir) ||
						normalizePathForComparison(current.commonDir) !== normalizePathForComparison(info.commonDir)))
			)
				throw new Error("The native repository changed during the read");
		},
	};
}

function requireRepository(read: RepositoryRead): VcsGitRepo {
	if (!read.repo) throw new Error("The native workspace is not a Git repository");
	return read.repo;
}

function bounded<T>(value: T): T {
	if (Buffer.byteLength(JSON.stringify(value), "utf8") > DEFAULT_MAX_BYTES)
		throw new Error("Git read exceeds the native inline output budget");
	return value;
}

function parseStatus(status: string): StatusEntry[] {
	const tokens = status.split("\0");
	const entries: StatusEntry[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const record = tokens[i];
		if (!record) continue;
		if (record.length < 4 || record[2] !== " ") throw new Error("Incomplete native Git status");
		const x = record[0];
		const y = record[1];
		const renamed = x === "R" || x === "C" || y === "R" || y === "C";
		const originalPath = renamed ? tokens[++i] : undefined;
		if (renamed && !originalPath) throw new Error("Incomplete native Git rename status");
		entries.push({ path: record.slice(3), x, y, originalPath });
	}
	return entries;
}

async function statusEntries(read: RepositoryRead, signal: AbortSignal): Promise<StatusEntry[]> {
	const status = await requireRepository(read).statusPorcelain({ nulTerminated: true, untracked: "all" }, signal);
	read.assertCurrent();
	if (Buffer.byteLength(status) > DEFAULT_MAX_BYTES)
		throw new Error("Git status exceeds the native inline output budget");
	if (status && !status.endsWith("\0")) throw new Error("Incomplete native Git status");
	return parseStatus(status);
}

async function upstream(repo: VcsGitRepo, branch: string | undefined, signal: AbortSignal) {
	if (!branch) return null;
	const [remote, merge] = await Promise.all([
		repo.configGet(`branch.${branch}.remote`, signal),
		repo.configGet(`branch.${branch}.merge`, signal),
	]);
	if (!remote || !merge) return null;
	let trackingRef = remote === "." ? merge : undefined;
	if (remote !== ".") {
		const fetch = (await repo.configGet(`remote.${remote}.fetch`, signal))?.replace(/^\+/, "");
		const [from, to] = fetch?.split(":") ?? [];
		if (from && to) {
			const wildcard = from.indexOf("*");
			if (wildcard < 0 && from === merge) trackingRef = to;
			else if (
				wildcard >= 0 &&
				merge.startsWith(from.slice(0, wildcard)) &&
				merge.endsWith(from.slice(wildcard + 1))
			) {
				const match = merge.slice(wildcard, merge.length - (from.length - wildcard - 1));
				trackingRef = to.replace("*", match);
			}
		}
	}
	if (!trackingRef) throw new Error(`Cannot resolve the configured upstream ref for ${branch}`);
	const sha = await repo.resolveRef(trackingRef, signal);
	if (!sha) throw new Error(`The configured upstream for ${branch} is unavailable`);
	return { name: trackingRef.replace(/^refs\/(?:heads|remotes)\//, ""), sha };
}

async function summary(
	read: RepositoryRead,
	signal: AbortSignal,
	entries?: StatusEntry[],
): Promise<GitRepositorySummary> {
	const repo = read.repo;
	if (!repo)
		return {
			workspacePath: read.root,
			repoRoot: "",
			workspaceInRepoPath: "",
			autoRefreshWatchPaths: [],
			branchName: null,
			trackingBranchName: null,
			headRefType: "detached",
			ahead: 0,
			behind: 0,
			isDirty: false,
			isGitAvailable: true,
			isRepository: false,
		};
	const [head, status] = await Promise.all([repo.head(signal), entries ?? statusEntries(read, signal)]);
	const tracking = await upstream(repo, head.branch, signal);
	let ahead = 0;
	let behind = 0;
	if (tracking) {
		if (!head.commit) throw new Error("Cannot compare an unborn branch with its configured upstream");
		const counts = await Promise.all([
			repo.revListRange(tracking.sha, head.commit, signal),
			repo.revListRange(head.commit, tracking.sha, signal),
		]);
		ahead = counts[0].length;
		behind = counts[1].length;
	}
	read.assertCurrent();
	const info = repo.info();
	return {
		workspacePath: read.root,
		repoRoot: info.repoRoot,
		workspaceInRepoPath: repo.prefixOf(read.root) ?? "",
		autoRefreshWatchPaths: [...new Set([info.gitDir, info.commonDir])].map(target => ({
			path: target,
			recursive: true,
		})),
		branchName: head.branch ?? null,
		trackingBranchName: tracking?.name ?? null,
		headRefType: head.kind === "ref" ? "branch" : "detached",
		ahead,
		behind,
		isDirty: status.length > 0,
		isGitAvailable: true,
		isRepository: true,
	};
}

function kind(letter: string): GitChangeKind {
	if (letter === "A" || letter === "?") return "added";
	if (letter === "D") return "deleted";
	if (letter === "R" || letter === "C") return "renamed";
	return "modified";
}

function conflicted(entry: StatusEntry): boolean {
	return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(entry.x + entry.y);
}

async function fileBytes(target: string): Promise<{ data: Uint8Array; truncated: boolean }> {
	const stat = await fs.lstat(target);
	if (stat.isSymbolicLink()) return { data: Buffer.from(await fs.readlink(target)), truncated: false };
	if (!stat.isFile()) throw new Error("Git content is not an ordinary file");
	const file = await fs.open(target, "r");
	try {
		const bytes = Buffer.alloc(DEFAULT_MAX_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		return { data: bytes.subarray(0, Math.min(length, DEFAULT_MAX_BYTES)), truncated: length > DEFAULT_MAX_BYTES };
	} finally {
		await file.close();
	}
}

async function changes(
	context: WebGuiServiceContext,
	read: RepositoryRead,
	source: "staged" | "unstaged",
	entries: StatusEntry[],
): Promise<GitFileChange[]> {
	const repo = requireRepository(read);
	const selected = entries.filter(
		entry =>
			pathIsWithin(read.root, path.resolve(repo.info().repoRoot, entry.path)) &&
			(source === "staged"
				? entry.x !== " " && entry.x !== "?" && !conflicted(entry)
				: entry.y !== " " || conflicted(entry)),
	);
	if (!selected.length) return [];
	const counts = new Map(
		(
			await repo.numstat(
				{ cached: source === "staged", files: selected.map(entry => `:(literal)${entry.path}`) },
				context.signal,
			)
		).map(entry => [entry.path, entry]),
	);
	read.assertCurrent();
	const result: GitFileChange[] = [];
	for (const entry of selected) {
		const target = path.resolve(repo.info().repoRoot, entry.path);
		const untracked = entry.x === "?" && entry.y === "?";
		const count = counts.get(entry.path);
		let added = count?.added ?? 0;
		if (untracked) {
			await resolveNativeReadPath(context, target, { sessionId: read.sessionId });
			const bytes = await fileBytes(target);
			read.assertCurrent();
			if (bytes.truncated) throw new Error("Untracked Git content exceeds the native inline output budget");
			if (!isProbablyBinaryHeader(bytes.data)) {
				const text = new TextDecoder().decode(bytes.data);
				added = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
			}
		}
		result.push({
			path: target,
			repoRelativePath: entry.path,
			workspaceRelativePath: path.relative(read.root, target).split(path.sep).join("/"),
			x: entry.x,
			y: entry.y,
			kind: kind(source === "staged" ? entry.x : entry.y),
			section: conflicted(entry) ? "conflicted" : untracked ? "untracked" : source,
			added,
			removed: count?.removed ?? 0,
			isStaged: source === "staged",
			isUntracked: untracked,
			isConflicted: conflicted(entry),
		});
	}
	return bounded(result);
}

function sourceId(params: Record<string, unknown>): "staged" | "unstaged" {
	const source = params.sourceId ?? (params.staged === true ? "staged" : "unstaged");
	if (source !== "staged" && source !== "unstaged")
		throw new WebGuiNotImplementedError(`git diff source: ${String(source)}`);
	return source;
}

async function diff(
	context: WebGuiServiceContext,
	read: RepositoryRead,
	params: Record<string, unknown>,
): Promise<GitDiffResult> {
	if (typeof params.path !== "string" || !params.path) throw new TypeError("Git diff requires a path");
	const repo = requireRepository(read);
	const source = sourceId(params);
	const admitted = await resolveNativeReadPath(context, params.path, {
		allowMissing: true,
		sessionId: read.sessionId,
	});
	read.assertCurrent();
	const target = path.resolve(
		read.root,
		path.relative(admitted.cwd, path.resolve(resolveToCwd(params.path, admitted.cwd))),
	);
	const relative = path.relative(repo.info().repoRoot, target).split(path.sep).join("/");
	const entry = (await statusEntries(read, context.signal)).find(item => item.path === relative);
	const unavailable = (availability: GitDiffResult["availability"], reason: string): GitDiffResult => ({
		path: target,
		availability,
		patch: null,
		beforeContent: null,
		afterContent: null,
		summary: reason,
	});
	if (!entry || (source === "staged" ? entry.x === " " || entry.x === "?" : entry.y === " "))
		return unavailable("unavailable", `The file has no ${source} change`);
	if (entry && conflicted(entry)) return unavailable("unavailable", "The file has unresolved Git conflicts");
	const oldRelative = source === "staged" ? (entry?.originalPath ?? relative) : relative;
	if (!pathIsWithin(read.root, path.resolve(repo.info().repoRoot, oldRelative)))
		throw new Error("The Git preimage is outside the native workspace");
	const blob = async (spec: string, missingAllowed = false) => {
		try {
			return await repo.showBlob(spec, DEFAULT_MAX_BYTES, context.signal);
		} catch (error) {
			if (missingAllowed && vcs.isVcsError(error) && error.code === "ObjectNotFound")
				return { data: Buffer.alloc(0), truncated: false };
			throw error;
		}
	};
	const before = await blob(
		`${source === "staged" ? "HEAD" : ""}:${oldRelative}`,
		source === "staged" ? entry.x === "A" : entry.x === "?" || entry.y === "A",
	);
	let after: { data: Uint8Array; truncated: boolean };
	if (source === "staged") after = await blob(`:${relative}`, entry.x === "D");
	else {
		try {
			after = await fileBytes(target);
		} catch (error) {
			if (!isEnoent(error) || entry.y !== "D") throw error;
			after = { data: Buffer.alloc(0), truncated: false };
		}
	}
	read.assertCurrent();
	if (before.truncated || after.truncated)
		return unavailable("truncated", "Git content exceeds the native inline output budget");
	if (isProbablyBinaryHeader(before.data) || isProbablyBinaryHeader(after.data))
		return unavailable("binary", "Binary Git content");
	const beforeContent = new TextDecoder().decode(before.data);
	const afterContent = new TextDecoder().decode(after.data);
	let patch: string;
	try {
		if (entry?.x === "?" && entry.y === "?" && source === "unstaged") {
			const lines = afterContent ? afterContent.split("\n") : [];
			if (afterContent.endsWith("\n")) lines.pop();
			const label = JSON.stringify(`b/${relative}`);
			patch = lines.length
				? `--- /dev/null\n+++ ${label}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}\n`).join("")}${afterContent.endsWith("\n") ? "" : "\\ No newline at end of file\n"}`
				: "";
		} else
			patch = await repo.diffText(
				{ cached: source === "staged", files: [`:(literal)${relative}`], maxBytes: DEFAULT_MAX_BYTES },
				context.signal,
			);
	} catch (error) {
		if (vcs.isVcsError(error) && error.code === "OutputTooLarge") return unavailable("truncated", error.message);
		throw error;
	}
	read.assertCurrent();
	if (Buffer.byteLength(patch) + before.data.length + after.data.length > DEFAULT_MAX_BYTES)
		return unavailable("truncated", "Git diff exceeds the native inline output budget");
	return { path: target, availability: "patch", patch, beforeContent, afterContent };
}

async function branches(read: RepositoryRead, signal: AbortSignal): Promise<GitLocalBranchListResult> {
	const repo = requireRepository(read);
	const [head, names] = await Promise.all([repo.head(signal), repo.listBranches(false, signal)]);
	const result: GitLocalBranchListResult = {
		headRefType: head.kind === "ref" ? "branch" : "detached",
		currentBranchName: head.branch ?? null,
		branches: [],
	};
	for (const name of names) {
		const sha = await repo.resolveRef(`refs/heads/${name}`, signal);
		const details = sha ? await repo.commitDetails(sha, signal) : null;
		const tracking = await upstream(repo, name, signal);
		read.assertCurrent();
		const timestamp = details?.author.date ? Date.parse(details.author.date) : NaN;
		result.branches.push({
			name,
			isCurrent: head.branch === name,
			upstreamName: tracking?.name ?? null,
			commitHash: details?.sha ?? null,
			commitTimestampMs: Number.isFinite(timestamp) ? timestamp : null,
		});
	}
	return bounded(result);
}

async function graph(
	read: RepositoryRead,
	signal: AbortSignal,
	params: Record<string, unknown>,
): Promise<GitCommitGraphResult> {
	const repo = requireRepository(read);
	const maxCount = params.maxCount ?? 50;
	const skip = params.skip ?? 0;
	if (
		typeof maxCount !== "number" ||
		!Number.isSafeInteger(maxCount) ||
		maxCount < 1 ||
		typeof skip !== "number" ||
		!Number.isSafeInteger(skip) ||
		skip < 0
	)
		throw new TypeError("Git graph pagination requires nonnegative safe integers and a positive maxCount");
	const head: VcsHeadState = await repo.head(signal);
	const refs = new Map<string, GitCommitGraphRef[]>();
	const pending = new Map<string, GitCommitGraphCommit>();
	let bytes = 0;
	const add = async (sha: string) => {
		if (pending.has(sha) || visited.has(sha)) return;
		const detail = await repo.commitDetails(sha, signal);
		read.assertCurrent();
		bytes += Buffer.byteLength(detail.message) + detail.sha.length + detail.parents.join("").length;
		if (bytes > DEFAULT_MAX_BYTES) throw new Error("Git history exceeds the native inline output budget");
		const timestamp = detail.author.date ? Date.parse(detail.author.date) : NaN;
		pending.set(sha, {
			hash: detail.sha,
			parents: detail.parents,
			refs: refs.get(sha) ?? [],
			subject: detail.message.split(/\r?\n/, 1)[0],
			authorName: detail.author.name || null,
			authoredAtMs: Number.isFinite(timestamp) ? timestamp : null,
		});
	};
	const visited = new Set<string>();
	for (const name of await repo.listBranches(true, signal)) {
		const remote = name.startsWith("remotes/");
		const ref = remote ? `refs/${name}` : `refs/heads/${name}`;
		const sha = await repo.resolveRef(ref, signal);
		if (!sha) continue;
		const labels = refs.get(sha) ?? [];
		labels.push({ name: remote ? name.slice("remotes/".length) : name, kind: remote ? "remote" : "branch" });
		refs.set(sha, labels);
	}
	if (head.commit) {
		const labels = refs.get(head.commit) ?? [];
		labels.push({ name: "HEAD", kind: "head" });
		refs.set(head.commit, labels);
	}
	for (const sha of refs.keys()) await add(sha);
	const commits: GitCommitGraphCommit[] = [];
	while (pending.size && commits.length <= maxCount) {
		const next = [...pending.values()].sort(
			(a, b) => (b.authoredAtMs ?? 0) - (a.authoredAtMs ?? 0) || a.hash.localeCompare(b.hash),
		)[0];
		pending.delete(next.hash);
		visited.add(next.hash);
		if (visited.size > skip) {
			for (const name of await repo.tagsAt(next.hash, signal)) next.refs.push({ name, kind: "tag" });
			commits.push(next);
		}
		if (commits.length > maxCount) break;
		for (const parent of next.parents) await add(parent);
	}
	read.assertCurrent();
	return bounded({ commits: commits.slice(0, maxCount), hasMore: commits.length > maxCount });
}

/** Only native repository reads are admitted; all mutation descriptors stay unavailable. */
export function createNativeGitMethods(context: WebGuiServiceContext): Readonly<Record<string, WebGuiMethod>> {
	return {
		getRepositorySummary: async value => {
			const read = await repositoryRead(context, request(value));
			return bounded(await summary(read, context.signal));
		},
		getChanges: async value => {
			const params = request(value);
			const read = await repositoryRead(context, params);
			return changes(context, read, sourceId(params), await statusEntries(read, context.signal));
		},
		getDiff: async value => {
			const params = request(value);
			return diff(context, await repositoryRead(context, params), params);
		},
		getCommitGraph: async value => {
			const params = request(value);
			return graph(await repositoryRead(context, params), context.signal, params);
		},
		getLocalBranches: async value => branches(await repositoryRead(context, request(value)), context.signal),
		// The retained Git pane consumes this single status snapshot instead of three independent reads.
		refresh: async value => {
			const read = await repositoryRead(context, request(value));
			const entries = read.repo ? await statusEntries(read, context.signal) : [];
			const result: GitRefreshResult = {
				summary: await summary(read, context.signal, entries),
				identity: null,
				branchComparison: null,
				unstagedChanges: read.repo ? await changes(context, read, "unstaged", entries) : [],
				stagedChanges: read.repo ? await changes(context, read, "staged", entries) : [],
			};
			read.assertCurrent();
			return bounded(result);
		},
	};
}
