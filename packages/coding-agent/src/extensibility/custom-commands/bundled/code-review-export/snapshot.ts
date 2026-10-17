import * as fs from "node:fs/promises";
import * as path from "node:path";
import { structuredPatchHunks } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { throwIfAborted } from "../../../../tools/tool-errors";
import { github } from "../../../../utils/github";
import type { ReviewExportChange, ReviewExportScope, ReviewExportSnapshot } from "./types";

// These are fail-closed limits, never cropping budgets. The caller can split a large review.
const FILE_LIMIT = 32 * 1024 * 1024;
const DIFF_LIMIT = 64 * 1024 * 1024;
const CAPTURE_LIMIT = 256 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
type Version = "base" | "target";
type Entry = { sha: string; mode: string; type: string };
type Status = { path: string; previousPath?: string; code: string };
type Observation = { bytes: Buffer | undefined; mode?: string };

function relativePath(value: string): string {
	if (
		!value ||
		value.includes("\\") ||
		/[\x00-\x1f\x7f:]/.test(value) ||
		path.posix.isAbsolute(value) ||
		value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
	)
		throw new Error(`Unsafe or unsupported repository path: ${JSON.stringify(value)}`);
	return value;
}

function isTemporary(value: string): boolean {
	const normalized = process.platform === "win32" ? value.toLowerCase() : value;
	return normalized === ".tmp" || normalized.startsWith(".tmp/");
}

function untrackedExclusion(value: string): string | undefined {
	if (
		/(^|\/)(?:node_modules|vendor|dist|build|out|coverage|target|__pycache__|\.cache|\.venv|venv)(?:\/|$)/.test(value)
	) {
		return "untracked dependency, build output, or cache";
	}
	if (/(?:\.pyc|\.pyo|\.tsbuildinfo|\.log|\.swp|\.swo|\.o|\.obj|\.class|\.dll|\.exe|\.a|\.so|\.dylib|~)$/.test(value))
		return "untracked generated or editor artifact";
	if (/(^|\/)(?:\.env(?:\.(?!example$|sample$)[^/]+)?|\.npmrc|\.pypirc|id_rsa|id_ed25519)$/.test(value)) {
		return "untracked private configuration (not related source)";
	}
	return undefined;
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
	return a === undefined || b === undefined ? a === b : Buffer.from(a).equals(b);
}

function text(bytes: Uint8Array | undefined): string | undefined {
	if (!bytes) return "";
	if (bytes.includes(0)) return undefined;
	try {
		return decoder.decode(bytes);
	} catch {
		return undefined;
	}
}

function supported(change: ReviewExportChange): void {
	for (const mode of [change.beforeMode, change.afterMode]) {
		if (mode && mode !== "100644" && mode !== "100755") {
			throw new Error(
				`Cannot export ${change.path}: unsupported ${mode === "120000" ? "symlink" : mode === "160000" ? "submodule" : `file mode ${mode}`}. No link is followed or payload omitted silently.`,
			);
		}
	}
}

function renderPatch(
	change: ReviewExportChange,
	before: Uint8Array | undefined,
	after: Uint8Array | undefined,
): string {
	const oldPath = change.previousPath ?? change.path;
	const quote = (value: string) => (/[\s"\\]/.test(value) ? JSON.stringify(value) : value);
	let result = `diff --git ${quote(`a/${oldPath}`)} ${quote(`b/${change.path}`)}\n`;
	if (before === undefined) result += `new file mode ${change.afterMode ?? "100644"}\n`;
	else if (after === undefined) result += `deleted file mode ${change.beforeMode ?? "100644"}\n`;
	else if (change.beforeMode && change.afterMode && change.beforeMode !== change.afterMode) {
		result += `old mode ${change.beforeMode}\nnew mode ${change.afterMode}\n`;
	}
	if (change.previousPath) result += `rename from ${quote(oldPath)}\nrename to ${quote(change.path)}\n`;
	const oldText = text(before);
	const newText = text(after);
	change.binary = oldText === undefined || newText === undefined;
	if (change.binary)
		return `${result}Binary files ${before === undefined ? "/dev/null" : quote(`a/${oldPath}`)} and ${after === undefined ? "/dev/null" : quote(`b/${change.path}`)} differ\n`;
	const hunks = structuredPatchHunks(oldText!, newText!, 3);
	if (hunks.length) {
		result += `--- ${before === undefined ? "/dev/null" : quote(`a/${oldPath}`)}\n+++ ${after === undefined ? "/dev/null" : quote(`b/${change.path}`)}\n`;
		for (const hunk of hunks) {
			const oldStart = hunk.oldLines === 0 ? Math.max(0, hunk.oldStart - 1) : hunk.oldStart;
			const newStart = hunk.newLines === 0 ? Math.max(0, hunk.newStart - 1) : hunk.newStart;
			result += `@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}\n`;
		}
	}
	return result;
}

function parseStatus(raw: string): Status[] {
	const tokens = raw.split("\0");
	const rows: Status[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (!token) continue;
		if (token.length < 4 || token[2] !== " ") throw new Error("Unsupported Git status format.");
		const code = token.slice(0, 2);
		const filePath = token.slice(3);
		const previousPath = /[RC]/.test(code) ? (tokens[++index] ?? "") : undefined;
		if (isTemporary(filePath) && (!previousPath || isTemporary(previousPath))) continue;
		if (!isTemporary(filePath)) relativePath(filePath);
		if (previousPath !== undefined && !isTemporary(previousPath)) relativePath(previousPath);
		if (code.includes("U") || code === "AA" || code === "DD")
			throw new Error(`Resolve Git conflicts before export: ${filePath}`);
		rows.push({ path: filePath, previousPath, code });
	}
	return rows;
}

/** No filesystem read may traverse a repository symlink, even one pointing back inside. */
async function observe(root: string, filePath: string): Promise<Observation> {
	const parts = relativePath(filePath).split("/");
	let current = root;
	for (let index = 0; index < parts.length; index++) {
		current = path.join(current, parts[index]!);
		let stat;
		try {
			stat = await fs.lstat(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: undefined };
			throw error;
		}
		if (stat.isSymbolicLink()) throw new Error(`Cannot export symlink worktree path: ${filePath}`);
		if (index < parts.length - 1) {
			if (!stat.isDirectory()) throw new Error(`Unsafe worktree parent: ${filePath}`);
			continue;
		}
		if (!stat.isFile())
			throw new Error(`Cannot export non-regular worktree entry (including submodules): ${filePath}`);
		if (stat.size > FILE_LIMIT) throw new Error(`File exceeds ${FILE_LIMIT} bytes; split this review: ${filePath}`);
		const canonical = await fs.realpath(current);
		const relative = path.relative(root, canonical);
		if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
			throw new Error(`Path escaped repository: ${filePath}`);
		const handle = await fs.open(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		try {
			const opened = await handle.stat();
			if (
				!opened.isFile() ||
				opened.dev !== stat.dev ||
				opened.ino !== stat.ino ||
				opened.size !== stat.size ||
				opened.mtimeMs !== stat.mtimeMs
			) {
				throw new Error(`Worktree changed while reading ${filePath}; export aborted.`);
			}
			const bytes = await handle.readFile();
			const finished = await handle.stat();
			const final = await fs.lstat(current);
			if (
				bytes.length > FILE_LIMIT ||
				final.isSymbolicLink() ||
				finished.size !== opened.size ||
				finished.mtimeMs !== opened.mtimeMs ||
				final.ino !== opened.ino ||
				final.dev !== opened.dev
			) {
				throw new Error(`Worktree changed while reading ${filePath}; export aborted.`);
			}
			return { bytes, mode: process.platform !== "win32" && stat.mode & 0o111 ? "100755" : "100644" };
		} finally {
			await handle.close();
		}
	}
	throw new Error(`Invalid repository path: ${filePath}`);
}

async function ghJson<T>(cwd: string, endpoint: string, signal?: AbortSignal): Promise<T> {
	const result = await github.run(cwd, ["api", endpoint], signal, { repoProvided: true, trimOutput: false });
	if (
		result.stdout.includes("[gh subprocess output truncated") ||
		result.stderr.includes("[gh subprocess output truncated")
	) {
		throw new Error(
			"GitHub response exceeded the central 8 MiB capture limit; split this review. No truncated data was exported.",
		);
	}
	if (result.exitCode !== 0) throw new Error(`GitHub snapshot read failed: ${result.stderr || result.stdout}`);
	try {
		return JSON.parse(result.stdout) as T;
	} catch {
		throw new Error("Invalid GitHub snapshot response; export aborted.");
	}
}

export async function captureReviewExportSnapshot(
	cwd: string,
	scope: ReviewExportScope,
	signal?: AbortSignal,
): Promise<ReviewExportSnapshot> {
	throwIfAborted(signal);
	const repository = vcs.requireGit(cwd);
	if (scope.kind !== "pr" && repository.info().isReftable) {
		throw new Error(
			"Local export requires byte-exact Git blob reads, which the central VCS reftable fallback cannot provide. No lossy or truncated source was exported.",
		);
	}
	const root = await fs.realpath(repository.info().repoRoot);
	const limitations = [
		"Repository-root .tmp is excluded from the exported diff and changed files.",
		"NUL-containing or non-UTF-8 files are binary: changed identities and byte metadata are retained, without embedding binary payloads in the text diff.",
	];
	const cache = new Map<string, Buffer | undefined>();
	const observations = new Map<string, Observation>();
	let capturedBytes = 0;
	let disposed = false;
	let baseCommit: string | null = null;
	let targetCommit: string;
	let changes: ReviewExportChange[];
	let targetPaths: Set<string>;
	let basePaths: Set<string>;
	let readVersion: (filePath: string, version: Version) => Promise<Buffer | undefined>;
	let checkState = async () => {};
	const included = (values: string[]) => new Set(values.filter(value => !isTemporary(value)).map(relativePath));
	const pin = async (ref: string) => {
		const sha = await repository.resolveRef(ref, signal);
		if (!sha || !/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error(`Cannot pin Git revision: ${ref}`);
		return (await repository.commitDetails(sha, signal)).sha;
	};

	if (scope.kind === "pr") {
		if (!/^[\w.-]+\/[\w.-]+$/.test(scope.repo) || !Number.isSafeInteger(scope.number) || scope.number < 1)
			throw new Error("Invalid pull request identity.");
		const pr = await ghJson<{ base: { sha: string }; head: { sha: string; repo: { full_name: string } | null } }>(
			root,
			`repos/${scope.repo}/pulls/${scope.number}`,
			signal,
		);
		if (!/^[a-f0-9]{40,64}$/i.test(pr.base.sha) || !/^[a-f0-9]{40,64}$/i.test(pr.head.sha))
			throw new Error("GitHub did not return pinned commit identities.");
		targetCommit = pr.head.sha;
		const comparison = await ghJson<{
			merge_base_commit: { sha: string };
			files?: Array<{ filename: string; previous_filename?: string; status: string }>;
		}>(root, `repos/${scope.repo}/compare/${pr.base.sha}...${targetCommit}`, signal);
		baseCommit = comparison.merge_base_commit.sha;
		if (!/^[a-f0-9]{40,64}$/i.test(baseCommit)) throw new Error("GitHub did not return a pinned merge base.");
		const headRepo = pr.head.repo?.full_name ?? scope.repo;
		if (!/^[\w.-]+\/[\w.-]+$/.test(headRepo)) throw new Error("Invalid pull request head repository.");
		const loadTree = async (repo: string, sha: string) => {
			const tree = await ghJson<{
				truncated: boolean;
				tree: Array<{ path: string; sha: string; mode: string; type: string }>;
			}>(root, `repos/${repo}/git/trees/${sha}?recursive=1`, signal);
			if (tree.truncated)
				throw new Error("GitHub recursive tree was truncated; split this review. No partial tree was exported.");
			const entries = new Map<string, Entry>();
			for (const entry of tree.tree) {
				if (entry.type === "tree" || isTemporary(entry.path)) continue;
				relativePath(entry.path);
				entries.set(entry.path, entry);
			}
			return entries;
		};
		const before = await loadTree(scope.repo, baseCommit);
		const after = await loadTree(headRepo, targetCommit);
		basePaths = new Set(before.keys());
		targetPaths = new Set(after.keys());
		changes = [];
		for (const filePath of new Set([...before.keys(), ...after.keys()])) {
			const oldEntry = before.get(filePath);
			const newEntry = after.get(filePath);
			if (oldEntry?.sha === newEntry?.sha && oldEntry?.mode === newEntry?.mode) continue;
			changes.push({
				path: filePath,
				status: !oldEntry ? "A" : !newEntry ? "D" : "M",
				beforeMode: oldEntry?.mode,
				afterMode: newEntry?.mode,
			});
		}
		// Compare's file list is capped by GitHub; complete pinned trees above remain authoritative.
		for (const hint of comparison.files ?? []) {
			if (
				hint.status !== "renamed" ||
				!hint.previous_filename ||
				isTemporary(hint.filename) ||
				isTemporary(hint.previous_filename)
			)
				continue;
			const added = changes.find(change => change.path === hint.filename && change.status === "A");
			const deleted = changes.find(change => change.path === hint.previous_filename && change.status === "D");
			if (added && deleted) {
				added.previousPath = deleted.path;
				added.beforeMode = deleted.beforeMode;
				added.status = "R";
				changes.splice(changes.indexOf(deleted), 1);
			}
		}
		if ((comparison.files?.length ?? 0) >= 300) {
			limitations.push(
				"GitHub caps compare rename hints at 300 files; complete pinned trees retain every changed path and version, but additional edited renames may be represented as deletion plus addition.",
			);
		}
		for (const [filePath, entry] of after) {
			if (entry.mode !== "100644" && entry.mode !== "100755") {
				targetPaths.delete(filePath);
				limitations.push(
					`Target file inventory excludes ${filePath}: ${entry.mode === "120000" ? "symlink" : "submodule or unsupported entry"}.`,
				);
			}
		}
		readVersion = async (filePath, version) => {
			const entry = (version === "base" ? before : after).get(filePath);
			if (!entry) return undefined;
			if (entry.mode !== "100644" && entry.mode !== "100755")
				throw new Error(`Unsupported GitHub entry: ${filePath} (${entry.mode})`);
			const blob = await ghJson<{ encoding: string; content: string; size: number; sha: string }>(
				root,
				`repos/${version === "base" ? scope.repo : headRepo}/git/blobs/${entry.sha}`,
				signal,
			);
			if (blob.encoding !== "base64" || blob.sha !== entry.sha || blob.size > FILE_LIMIT)
				throw new Error(`Unsupported or oversized GitHub blob; split review: ${filePath}`);
			const bytes = Buffer.from(blob.content, "base64");
			if (bytes.length !== blob.size) throw new Error(`Incomplete GitHub blob: ${filePath}`);
			return bytes;
		};
	} else {
		targetCommit = await pin(
			scope.kind === "commit" ? scope.ref : scope.kind === "base-branch" ? scope.targetRef : "HEAD",
		);
		if (scope.kind === "commit")
			baseCommit = (await repository.commitDetails(targetCommit, signal)).parents[0] ?? null;
		else if (scope.kind === "base-branch") {
			const selectedBase = await pin(scope.baseRef);
			baseCommit = (await repository.mergeBase(selectedBase, targetCommit, signal)) ?? null;
			if (!baseCommit) throw new Error("Selected branches have no common history.");
		} else baseCommit = targetCommit;
		basePaths = baseCommit ? included(await repository.lsTree(baseCommit, [], signal)) : new Set();
		targetPaths = included(await repository.lsTree(targetCommit, [], signal));
		const state = async () => {
			const status = parseStatus(
				await repository.statusPorcelain({ nulTerminated: true, untracked: "all" }, signal),
			);
			const untracked = [...included(await repository.lsFiles(true, true, signal))].sort();
			const tracked = [...included(await repository.lsFiles(false, true, signal))].sort();
			const files = [...new Set([...basePaths, ...tracked])];
			const staged = files.length ? await repository.diffChanges({ cached: true, files }, signal) : [];
			return {
				status,
				untracked,
				fingerprint: JSON.stringify({
					head: await repository.headSha(signal),
					status,
					untracked,
					tracked,
					staged: staged.flatMap(change => {
						const beforePath = change.previousPath ?? change.path;
						const sides: string[][] = [];
						if (!isTemporary(beforePath) && change.beforeMode)
							sides.push(["base", beforePath, change.beforeMode, change.beforeId ?? ""]);
						if (!isTemporary(change.path) && change.afterMode)
							sides.push(["index", change.path, change.afterMode, change.afterId ?? ""]);
						return sides;
					}),
				}),
			};
		};
		const initial = scope.kind === "uncommitted" ? await state() : undefined;
		const nativeChanges = await repository.diffChanges(
			{
				...(baseCommit ? { base: baseCommit } : {}),
				...(scope.kind === "uncommitted" ? {} : { head: targetCommit }),
			},
			signal,
		);
		changes = nativeChanges.flatMap<ReviewExportChange>(change => {
			if (!isTemporary(change.path)) relativePath(change.path);
			if (change.previousPath && !isTemporary(change.previousPath)) relativePath(change.previousPath);
			if (isTemporary(change.path)) {
				return change.previousPath && !isTemporary(change.previousPath)
					? [{ path: change.previousPath, status: "D", beforeMode: change.beforeMode }]
					: [];
			}
			if (change.previousPath && isTemporary(change.previousPath)) {
				return [{ path: change.path, status: "A", afterMode: change.afterMode }];
			}
			return [
				{
					path: change.path,
					...(change.previousPath ? { previousPath: change.previousPath } : {}),
					status: !change.beforeMode ? "A" : !change.afterMode ? "D" : change.previousPath ? "R" : "M",
					beforeMode: change.beforeMode,
					afterMode: change.afterMode,
				},
			];
		});
		const readBlob = async (filePath: string, version: Version) => {
			const sha = version === "base" ? baseCommit : targetCommit;
			if (!sha || !(version === "base" ? basePaths : targetPaths).has(filePath)) return undefined;
			const result = await repository.showBlob(`${sha}:${filePath}`, FILE_LIMIT, signal);
			if (result.truncated) throw new Error(`Git blob exceeded the capture limit; split review: ${filePath}`);
			return result.data;
		};
		readVersion = readBlob;
		if (scope.kind === "uncommitted") {
			if (!initial) throw new Error("Missing initial worktree observation.");
			if ((await repository.headSha(signal)) !== targetCommit)
				throw new Error("HEAD changed while pinning worktree snapshot.");
			const omitted = new Set(initial.untracked.filter(value => untrackedExclusion(value)));
			for (const filePath of omitted) {
				if (!basePaths.has(filePath)) limitations.push(`Excluded ${filePath}: ${untrackedExclusion(filePath)}.`);
			}
			const candidates = new Set<string>();
			for (const change of changes) {
				candidates.add(change.path);
				if (change.previousPath) candidates.add(change.previousPath);
			}
			for (const row of initial.status) {
				candidates.add(row.path);
				if (row.previousPath) candidates.add(row.previousPath);
			}
			for (const filePath of initial.untracked) if (!omitted.has(filePath)) candidates.add(filePath);
			const hints = changes;
			changes = [];
			const worktreeRead = async (filePath: string) => {
				const observation = await observe(root, filePath);
				const previous = observations.get(filePath);
				if (previous && (!sameBytes(previous.bytes, observation.bytes) || previous.mode !== observation.mode))
					throw new Error(`Worktree changed during capture: ${filePath}`);
				if (!previous) {
					capturedBytes += observation.bytes?.length ?? 0;
					if (capturedBytes > CAPTURE_LIMIT)
						throw new Error("Frozen worktree contents exceed the capture limit; split this review.");
				}
				observations.set(filePath, observation);
				return observation;
			};
			for (const filePath of candidates) {
				if (isTemporary(filePath) || (omitted.has(filePath) && !basePaths.has(filePath))) continue;
				const before = await readBlob(filePath, "base");
				const after = await worktreeRead(filePath);
				if (after.bytes) targetPaths.add(filePath);
				else targetPaths.delete(filePath);
				const hint = hints.find(change => change.path === filePath || change.previousPath === filePath);
				const beforeMode = hint?.beforeMode;
				const afterMode =
					after.bytes === undefined
						? undefined
						: process.platform === "win32"
							? (hint?.afterMode ?? (hint?.previousPath ? undefined : (beforeMode ?? "100644")))
							: after.mode;
				if (sameBytes(before, after.bytes) && (!beforeMode || beforeMode === afterMode)) continue;
				changes.push({
					path: filePath,
					status: before === undefined ? "A" : after.bytes === undefined ? "D" : "M",
					beforeMode,
					afterMode,
				});
				cache.set(`base:${filePath}`, before);
				cache.set(`target:${filePath}`, after.bytes);
				capturedBytes += before?.length ?? 0;
				if (capturedBytes > CAPTURE_LIMIT)
					throw new Error("Frozen changed files exceed the capture limit; split this review.");
			}
			for (const hint of [
				...hints,
				...initial.status
					.filter(row => row.previousPath)
					.map(row => ({ path: row.path, previousPath: row.previousPath })),
			]) {
				const added = changes.find(change => change.path === hint.path && change.status === "A");
				const deleted = changes.find(change => change.path === hint.previousPath && change.status === "D");
				if (added && deleted) {
					added.status = "R";
					added.previousPath = deleted.path;
					added.beforeMode = deleted.beforeMode;
					changes.splice(changes.indexOf(deleted), 1);
				}
			}
			for (const filePath of omitted) if (!basePaths.has(filePath)) targetPaths.delete(filePath);
			readVersion = async (filePath, version) =>
				version === "base" ? readBlob(filePath, version) : (await worktreeRead(filePath)).bytes;
			checkState = async () => {
				if ((await state()).fingerprint !== initial.fingerprint)
					throw new Error("Git worktree or index state changed during export; retry from a stable worktree.");
				for (const [filePath, observation] of observations) {
					const current = await observe(root, filePath);
					if (!sameBytes(observation.bytes, current.bytes) || observation.mode !== current.mode)
						throw new Error(`Observed worktree contents changed: ${filePath}`);
				}
				if ((await state()).fingerprint !== initial.fingerprint)
					throw new Error("Git state changed while validating export.");
			};
		}
	}

	const readFile = async (filePath: string, version: Version = "target"): Promise<Uint8Array | undefined> => {
		throwIfAborted(signal);
		if (disposed) throw new Error("Review snapshot is disposed.");
		if (isTemporary(filePath)) return undefined;
		relativePath(filePath);
		if (!(version === "base" ? basePaths : targetPaths).has(filePath)) return undefined;
		const key = `${version}:${filePath}`;
		if (!cache.has(key)) {
			const bytes = await readVersion(filePath, version);
			if (scope.kind !== "uncommitted" || version === "base") capturedBytes += bytes?.length ?? 0;
			if (capturedBytes > CAPTURE_LIMIT)
				throw new Error("Frozen review contents exceed the capture limit; split this review.");
			cache.set(key, bytes);
		}
		const bytes = cache.get(key);
		// Consumers cannot mutate the frozen snapshot through a returned view.
		return bytes === undefined ? undefined : Buffer.from(bytes);
	};
	changes.sort((a, b) => a.path.localeCompare(b.path));
	const patches: string[] = [];
	let diffBytes = 0;
	for (const change of changes) {
		throwIfAborted(signal);
		supported(change);
		const before = change.status === "A" ? undefined : await readFile(change.previousPath ?? change.path, "base");
		const after = change.status === "D" ? undefined : await readFile(change.path);
		if (change.status !== "A" && before === undefined)
			throw new Error(`Missing required original changed file: ${change.previousPath ?? change.path}`);
		if (change.status !== "D" && after === undefined)
			throw new Error(`Missing required target changed file: ${change.path}`);
		const patch = renderPatch(change, before, after);
		diffBytes += Buffer.byteLength(patch);
		if (diffBytes > DIFF_LIMIT || capturedBytes > CAPTURE_LIMIT)
			throw new Error("Complete diff or changed files exceed the capture limit; split this review.");
		patches.push(patch);
	}
	await checkState();
	return {
		root,
		scope,
		mode: scope.kind,
		baseCommit,
		targetCommit,
		diff: patches.join(""),
		changes,
		limitations,
		readFile,
		async assertUnchanged() {
			throwIfAborted(signal);
			if (disposed) throw new Error("Review snapshot is disposed.");
			await checkState();
		},
		async dispose() {
			disposed = true;
			cache.clear();
			observations.clear();
		},
	};
}
