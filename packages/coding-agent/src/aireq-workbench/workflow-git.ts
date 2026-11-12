import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsScopedCommitOptions } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { replaceFileAtomically, writeFileAtomically } from "../utils/atomic-file";
import { canonicalJson, digestFiles, safeMaterialPath, sha256, stableId } from "./requirement-package";
import type {
	AIReqFileVersion,
	AIReqMergeFact,
	AIReqOperationReceipt,
	AIReqProject,
	AIReqRequirementSnapshot,
	AIReqWorktree,
} from "./workflow-types";

const MAX_MATERIAL_BYTES = 64 * 1024 * 1024;
async function blob(root: string, spec: string): Promise<Buffer> {
	const result = await vcs.requireGit(root).showBlob(spec, MAX_MATERIAL_BYTES);
	if (result.truncated) throw new Error(`Git material exceeds 64 MiB: ${spec}`);
	return result.data;
}
export async function readMaterialFiles(root: string, paths: readonly string[]): Promise<Map<string, Uint8Array>> {
	const files = new Map<string, Uint8Array>();
	const canonical = await fs.realpath(root);
	for (const relative of paths) {
		safeMaterialPath(relative);
		const target = path.resolve(root, relative);
		const resolved = await fs.realpath(target);
		if (!resolved.startsWith(`${canonical}${path.sep}`)) throw new Error(`Material escapes worktree: ${relative}`);
		if (!(await fs.lstat(target)).isFile()) throw new Error(`Material is not a regular file: ${relative}`);
		files.set(relative, await fs.readFile(target));
	}
	return files;
}
export async function listMaterialFiles(root: string, relative: string): Promise<string[]> {
	safeMaterialPath(relative);
	const result: string[] = [];
	const visit = async (dir: string) => {
		for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
			const name = `${dir}/${entry.name}`;
			safeMaterialPath(name);
			if (entry.isSymbolicLink()) throw new Error(`Material symlink forbidden: ${name}`);
			if (entry.isDirectory()) await visit(name);
			else if (entry.isFile()) result.push(name);
			else throw new Error(`Unsupported material: ${name}`);
		}
	};
	await visit(relative);
	return result.sort();
}
export async function assertSnapshotFiles(root: string, snapshot: AIReqRequirementSnapshot): Promise<void> {
	const paths = await listMaterialFiles(root, `docs/aireq/requirements/${snapshot.irId}`);
	if (canonicalJson(paths) !== canonicalJson(snapshot.files.map(f => f.path).sort()))
		throw new Error("Frozen requirement file/member set changed");
	const bytes = await readMaterialFiles(root, paths);
	for (const file of snapshot.files)
		if (sha256(bytes.get(file.path)!) !== file.sha256 || bytes.get(file.path)!.length !== file.size)
			throw new Error(`Frozen requirement changed: ${file.path}`);
}
export class AIReqWorkflowGit {
	async inspect(root: string): Promise<Omit<AIReqProject, "id" | "name" | "revision" | "createdAt" | "updatedAt">> {
		const repo = vcs.requireGit(await fs.realpath(root));
		const info = repo.info();
		const commonDir = await fs.realpath(info.commonDir);
		const remotes = await repo.remoteList();
		const remote = remotes.includes("origin") ? "origin" : remotes[0];
		let defaultBranch: string;
		let repositoryId: string;
		if (remote) {
			const advertised = await repo.remoteDefaultBranch(remote);
			defaultBranch = advertised.branch;
			const url = await repo.remoteUrl(remote);
			if (!url) throw new Error(`Missing remote URL: ${remote}`);
			repositoryId = normalizeRepositoryId(url);
		} else {
			const primary = vcs.requireGit(repo.primaryRoot());
			const head = await primary.head();
			if (!head.branch) throw new Error("Local default branch cannot be inferred from a detached primary checkout");
			defaultBranch = head.branch;
			repositoryId = `local-${sha256(commonDir).slice(0, 32)}`;
		}
		return { root: await fs.realpath(repo.primaryRoot()), commonDir, defaultBranch, remote, repositoryId };
	}
	async latestDefault(project: AIReqProject): Promise<{ branch: string; commit: string }> {
		const repo = vcs.requireGit(project.root);
		let branch = project.defaultBranch;
		if (project.remote) {
			const actual = await repo.remoteDefaultBranch(project.remote);
			branch = actual.branch;
			await repo.fetch(project.remote, `refs/heads/${branch}`, `refs/remotes/${project.remote}/${branch}`);
		}
		const ref = project.remote ? `refs/remotes/${project.remote}/${branch}` : `refs/heads/${branch}`;
		const commit = await repo.resolveRef(ref);
		if (!commit) throw new Error(`Actual default branch is unavailable: ${ref}`);
		project.defaultBranch = branch;
		return { branch, commit };
	}
	async createWorktree(
		project: AIReqProject,
		kind: "requirements" | "development",
		id: string,
		operationId: string,
		frozen?: {
			snapshot: AIReqRequirementSnapshot;
			evidenceFiles?: AIReqFileVersion[];
			retiredFiles?: AIReqFileVersion[];
		},
	): Promise<AIReqWorktree> {
		stableId(id);
		if (frozen && kind !== "development") throw new Error("Frozen inputs require an SR development worktree");
		stableId(operationId);
		const repo = vcs.requireGit(project.root);
		const branch = `aireq/${kind}/${id}`;
		const directory = path.join(project.commonDir, "omp-aireq-worktrees", kind, id);
		const markerDirectory = path.join(project.commonDir, "omp-aireq-workflow-v1");
		const marker = path.join(markerDirectory, `worktree-${operationId}.json`);
		let saved: AIReqWorktree | undefined;
		try {
			saved = JSON.parse(await fs.readFile(marker, "utf8")) as AIReqWorktree;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (saved && (saved.branch !== branch || saved.path !== directory))
			throw new Error("Worktree retry identity conflict");
		const existing = (await repo.worktrees()).find(
			entry => entry.branch === `refs/heads/${branch}` || entry.branch === branch,
		);
		if (existing) {
			if (
				!saved ||
				path.resolve(existing.path) !== path.resolve(directory) ||
				!(await fs.stat(directory)).isDirectory()
			)
				throw new Error(`Existing worktree is not owned by this operation: ${branch}`);
			if (frozen) {
				// A retry may validate, but must never rematerialize over retained files.
				await this.verifyMerged(project, frozen.snapshot, frozen.evidenceFiles, frozen.retiredFiles);
				await assertSnapshotFiles(directory, frozen.snapshot);
				for (const file of frozen.evidenceFiles ?? []) {
					const bytes = (await readMaterialFiles(directory, [file.path])).get(file.path)!;
					if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
						throw new Error(`Frozen evidence changed: ${file.path}`);
				}
			}
			return saved;
		}
		if (!saved) {
			if (await repo.refExists(`refs/heads/${branch}`)) throw new Error(`Unowned existing branch: ${branch}`);
			const latest = await this.latestDefault(project);
			saved = { path: directory, branch, baseCommit: latest.commit };
			await fs.mkdir(markerDirectory, { recursive: true });
			await writeFileAtomically(marker, JSON.stringify(saved));
		}
		await fs.mkdir(path.dirname(directory), { recursive: true });
		if (await repo.refExists(`refs/heads/${branch}`)) {
			if ((await repo.resolveRef(`refs/heads/${branch}`)) !== saved.baseCommit)
				throw new Error("Partially created branch changed; manual settlement required");
		} else await repo.createBranch(branch, saved.baseCommit, false);
		await repo.worktreeAdd(directory, branch, { detach: false, clone: false });
		if (frozen) await this.#materializeFrozenWorktree(project, saved, frozen);
		return saved;
	}
	/**
	 * Only the freshly created, still-private checkout may replace smudged input
	 * with canonical frozen blobs. Existing/retry worktrees never enter this path.
	 * Neither Git configuration nor the actual default checkout is modified.
	 */
	async #materializeFrozenWorktree(
		project: AIReqProject,
		worktree: AIReqWorktree,
		frozen: {
			snapshot: AIReqRequirementSnapshot;
			evidenceFiles?: AIReqFileVersion[];
			retiredFiles?: AIReqFileVersion[];
		},
	): Promise<void> {
		const merged = await this.verifyMerged(project, frozen.snapshot, frozen.evidenceFiles, frozen.retiredFiles);
		const repo = vcs.requireGit(worktree.path);
		const head = await repo.head();
		if (merged.commit !== worktree.baseCommit || head.commit !== merged.commit || head.branch !== worktree.branch)
			throw new Error("Latest default or newly owned SR worktree changed before frozen input admission");
		const names = await listMaterialFiles(worktree.path, `docs/aireq/requirements/${frozen.snapshot.irId}`);
		if (canonicalJson(names) !== canonicalJson(frozen.snapshot.files.map(file => file.path).sort()))
			throw new Error("New SR checkout does not contain the exact frozen IR/SR member set");
		if (await repo.isDirty()) throw new Error("New SR checkout changed before frozen input admission");
		const versions = [...frozen.snapshot.files, ...(frozen.evidenceFiles ?? [])];
		const checkout = await readMaterialFiles(
			worktree.path,
			versions.map(file => file.path),
		);
		const replacements: { path: string; before: Uint8Array; content: Buffer; mode: number }[] = [];
		for (const file of versions) {
			const target = path.join(worktree.path, file.path);
			const stat = await fs.lstat(target);
			if (!stat.isFile() || stat.nlink > 1) throw new Error(`Aliased frozen input in new SR checkout: ${file.path}`);
			const before = checkout.get(file.path)!;
			if (before.length === file.size && sha256(before) === file.sha256) continue;
			const content = await blob(worktree.path, `${merged.commit}:${file.path}`);
			if (content.length !== file.size || sha256(content) !== file.sha256)
				throw new Error(`Committed material version mismatch: ${file.path}`);
			replacements.push({ path: target, before, content, mode: stat.mode & 0o777 });
		}
		// Recheck all preimages before replacing any: substantive edits and missing
		// members remain errors, never an invitation to repair a user's checkout.
		if (await repo.isDirty()) throw new Error("New SR checkout changed during frozen input admission");
		for (const file of replacements)
			if (sha256(file.before) !== sha256(await fs.readFile(file.path)))
				throw new Error("New SR frozen input changed during admission");
		for (const file of replacements) {
			const temporary = `${file.path}.${crypto.randomUUID()}.tmp`;
			try {
				await fs.writeFile(temporary, file.content, { flag: "wx", mode: file.mode });
				await replaceFileAtomically(temporary, file.path);
			} finally {
				await fs.rm(temporary, { force: true });
			}
		}
		await assertSnapshotFiles(worktree.path, frozen.snapshot);
		for (const file of frozen.evidenceFiles ?? [])
			if (sha256((await readMaterialFiles(worktree.path, [file.path])).get(file.path)!) !== file.sha256)
				throw new Error(`Frozen evidence changed: ${file.path}`);
	}
	async verifyMerged(
		project: AIReqProject,
		snapshot: AIReqRequirementSnapshot,
		evidenceFiles: AIReqFileVersion[] = [],
		retiredFiles: AIReqFileVersion[] = [],
	): Promise<AIReqMergeFact> {
		if (!project.remote) throw new Error("Requirement merge cannot be registered without a company remote");
		const latest = await this.latestDefault(project);
		const repo = vcs.requireGit(project.root);
		const names = (await repo.lsTree(latest.commit, [`docs/aireq/requirements/${snapshot.irId}`])).sort();
		if (canonicalJson(names) !== canonicalJson(snapshot.files.map(f => f.path).sort()))
			throw new Error("Default branch does not contain exact confirmed IR/SR set");
		await assertTreeFiles(project.root, latest.commit, [...snapshot.files, ...evidenceFiles, ...retiredFiles]);
		return {
			commit: latest.commit,
			branch: latest.branch,
			checkedAt: new Date().toISOString(),
			files: [...snapshot.files, ...evidenceFiles, ...retiredFiles],
		};
	}
	async verifyPublished(
		project: AIReqProject,
		worktree: AIReqWorktree,
		files: AIReqFileVersion[] = [],
		requireClean = false,
	): Promise<void> {
		const repo = vcs.requireGit(worktree.path);
		if (requireClean && (await repo.isDirty()))
			throw new Error("Uncommitted work remains; publish implementation and reports before registering PR");
		if (!project.remote) throw new Error("Company remote required for manual PR");
		const head = await repo.headSha();
		const remote = await repo.remoteRef(project.remote, `refs/heads/${worktree.branch}`);
		if (!head || remote.sha !== head) throw new Error("Source branch commit has not been pushed to company remote");
		await assertTreeFiles(worktree.path, "HEAD", files);
	}
	async changes(worktree: AIReqWorktree): Promise<(AIReqFileVersion & { status: string })[]> {
		const entries = (
			await vcs.requireGit(worktree.path).statusPorcelain({ untracked: "all", nulTerminated: true })
		).split("\0");
		const results: (AIReqFileVersion & { status: string })[] = [];
		for (let i = 0; i < entries.length; i++) {
			const record = entries[i];
			if (!record) continue;
			const status = record.slice(0, 2);
			const name = safeMaterialPath(record.slice(3));
			try {
				const bytes = (await readMaterialFiles(worktree.path, [name])).get(name)!;
				results.push({ path: name, sha256: sha256(bytes), size: bytes.length, status });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				results.push({ path: name, sha256: sha256(""), size: -1, status });
			}
			if (/[RC]/.test(status)) {
				const old = safeMaterialPath(entries[++i]);
				if (status.includes("R")) results.push({ path: old, sha256: sha256(""), size: -1, status: "D " });
			}
		}
		return results;
	}
	async verifyCodeMerged(project: AIReqProject, worktree: AIReqWorktree): Promise<AIReqMergeFact> {
		if (!project.remote) throw new Error("Code merge cannot be registered without a company remote");
		const repo = vcs.requireGit(worktree.path);
		if (await repo.isDirty()) throw new Error("Uncommitted work remains; cannot mark code merged");
		const latest = await this.latestDefault(project);
		const head = await repo.headSha();
		if (!head) throw new Error("SR branch has no commit");
		const paths = await repo.changedFiles({ base: worktree.baseCommit, head });
		if (!paths.length) throw new Error("No committed implementation changes to verify");
		const files: AIReqFileVersion[] = [];
		for (const file of paths) {
			safeMaterialPath(file);
			if (await repo.hasDiff({ base: head, head: latest.commit, files: [file] }))
				throw new Error(`Default branch content/mode mismatch: ${file}`);
			const exists = (await repo.lsTree(head, [file])).includes(file);
			if (!exists) {
				files.push({ path: file, sha256: sha256(""), size: -1 });
				continue;
			}
			const bytes = await blob(worktree.path, `${head}:${file}`);
			files.push({ path: file, sha256: sha256(bytes), size: bytes.length });
		}
		return { commit: latest.commit, branch: latest.branch, checkedAt: new Date().toISOString(), files };
	}
	async operationCommit(worktree: AIReqWorktree, operationId: string): Promise<string | undefined> {
		stableId(operationId);
		const commit = await vcs.requireGit(worktree.path).commitDetails("HEAD");
		return commit.message.split("\n").includes(`AIReq-Operation: ${operationId}`) ? commit.sha : undefined;
	}
	async publish(
		project: AIReqProject,
		worktree: AIReqWorktree,
		paths: string[],
		message: string,
		push: boolean,
		receipt: AIReqOperationReceipt,
		step: (name: string, detail: string) => Promise<void>,
		versions?: AIReqFileVersion[],
	): Promise<void> {
		if (!paths.length || !message.trim() || new Set(paths).size !== paths.length)
			throw new Error("Explicit nonempty unique commit scope and message required");
		for (const file of paths) safeMaterialPath(file);
		const repo = vcs.requireGit(worktree.path);
		const head = await repo.head();
		if (
			head.branch !== worktree.branch ||
			head.branch === project.defaultBranch ||
			!head.branch.startsWith("aireq/") ||
			!head.commit ||
			!head.refName
		)
			throw new Error("Refusing to commit/push the default or unexpected branch");
		if (
			versions &&
			(versions.length !== paths.length ||
				new Set(versions.map(f => f.path)).size !== paths.length ||
				paths.some(file => !versions.some(version => version.path === file)))
		)
			throw new Error("Publish versions must cover exact authorized paths");
		const assertVersions = async () => {
			if (
				versions &&
				canonicalJson(await scopedBytes(worktree.path, [...paths].sort())) !==
					canonicalJson([...versions].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
			)
				throw new Error("Authorized file/deletion versions changed before commit/push");
		};
		await assertVersions();
		const scopeDigest = sha256(
			canonicalJson({
				paths: [...paths].sort(),
				message,
				push,
				...(versions
					? { versions: [...versions].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) }
					: {}),
			}),
		);
		const priorScope = receipt.steps.find(s => s.name === "publish-scope");
		if (priorScope && priorScope.detail !== scopeDigest) throw new Error("Publish retry scope changed");
		if (!priorScope) await step("publish-scope", scopeDigest);
		let committed = receipt.steps.find(s => s.name === "commit")?.detail;
		if (!receipt.steps.some(s => s.name === "index")) {
			let options: VcsScopedCommitOptions;
			const prepared = receipt.steps.find(s => s.name === "git-prepared");
			if (prepared) options = JSON.parse(prepared.detail) as VcsScopedCommitOptions;
			else {
				const directory = path.join(project.commonDir, "omp-aireq-workflow-v1", "operations", receipt.operationId);
				await fs.mkdir(directory, { recursive: true });
				const indexPath = path.join(directory, "commit.index");
				const reconciledIndexPath = path.join(directory, "reconciled.index");
				const realIndex = path.join(repo.info().gitDir, "index");
				const expectedIndexVersion = sha256(await fs.readFile(realIndex));
				const before = await scopedBytes(worktree.path, paths);
				await repo.readTree("HEAD", indexPath);
				await repo.stageFilesIntoIndex(paths, indexPath);
				await fs.copyFile(realIndex, reconciledIndexPath);
				await repo.stageFilesIntoIndex(paths, reconciledIndexPath);
				if (canonicalJson(before) !== canonicalJson(await scopedBytes(worktree.path, paths)))
					throw new Error("Authorized files changed while preparing commit");
				const expectedTree = await repo.writeTree(indexPath);
				const reconciledTree = await repo.writeTree(reconciledIndexPath);
				if (await repo.hasDiff({ base: expectedTree, head: reconciledTree, files: paths }))
					throw new Error("Scoped index content changed during preparation");
				if (!(await repo.hasDiff({ base: "HEAD", head: expectedTree })))
					throw new Error("No changes in authorized commit scope");
				options = {
					expectedHeadRef: head.refName,
					expectedHeadSha: head.commit,
					expectedIndexVersion,
					indexPath,
					reconciledIndexPath,
					expectedTree,
					files: paths,
				};
				await step("git-prepared", JSON.stringify(options));
			}
			await assertVersions();
			if (versions) await assertTreeFiles(worktree.path, options.expectedTree, versions);
			const result = await repo.commitCreateScoped(`${message}\n\nAIReq-Operation: ${receipt.operationId}`, options);
			if (result.refUpdated && result.sha) {
				committed = result.sha;
				await step("commit", result.sha);
			}
			if (result.indexUpdated && result.sha) await step("index", result.sha);
			if (!result.sha || !result.refUpdated || !result.indexUpdated)
				throw new Error(result.diagnostic ?? "Scoped commit/index reconciliation incomplete");
			await fs.rm(options.indexPath, { force: true });
			await fs.rm(options.reconciledIndexPath, { force: true });
		}
		if (!committed) throw new Error("Missing actual commit receipt");
		await assertVersions();
		if (versions) await assertTreeFiles(worktree.path, committed, versions);
		if (push && !receipt.steps.some(s => s.name === "push")) {
			if (!project.remote) throw new Error("Commit saved; no remote configured for push");
			const actual = await repo.remoteDefaultBranch(project.remote);
			if (worktree.branch === actual.branch) throw new Error("Commit saved; refusing default branch push");
			const remoteRef = `refs/heads/${worktree.branch}`;
			if ((await repo.remoteRef(project.remote, remoteRef)).sha !== committed)
				await repo.push({ remote: project.remote, refspec: `${committed}:${remoteRef}`, forceWithLease: false });
			await step("push", `${project.remote}/${worktree.branch}@${committed}`);
		}
	}
}
async function scopedBytes(root: string, paths: string[]): Promise<AIReqFileVersion[]> {
	const result: AIReqFileVersion[] = [];
	for (const file of paths) {
		try {
			const bytes = (await readMaterialFiles(root, [file])).get(file)!;
			result.push({ path: file, sha256: sha256(bytes), size: bytes.length });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			result.push({ path: file, sha256: sha256(""), size: -1 });
		}
	}
	return result;
}
async function assertTreeFiles(root: string, tree: string, files: AIReqFileVersion[]): Promise<void> {
	const repo = vcs.requireGit(root);
	for (const file of files) {
		if (file.size === -1) {
			if ((await repo.lsTree(tree, [file.path])).includes(file.path))
				throw new Error(`Committed retired material remains: ${file.path}`);
			continue;
		}
		const bytes = await blob(root, `${tree}:${file.path}`);
		if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
			throw new Error(`Committed material version mismatch: ${file.path}`);
	}
}
function normalizeRepositoryId(url: string): string {
	if (/^(?:[a-z]:[\\/]|\/|\.\.?[\\/]|file:)/i.test(url)) return `local-${sha256(url).slice(0, 32)}`;
	return url
		.replace(/(\w+:\/\/)[^/@]+@/, "$1")
		.replace(/[?#].*$/, "")
		.replace(/\.git$/, "")
		.replace(/\/$/, "")
		.replace(/^git@([^:]+):/, "ssh://$1/");
}
export { digestFiles };
