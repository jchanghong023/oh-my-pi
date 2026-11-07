import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent, withFileLock } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { artifactVersion, assertSpecWritePath, containedSpecPath } from "./artifacts";
import { devRepositoryIdentity } from "./forge";
import {
	loadDevRequirements,
	readDevRequirement,
	resolveDevOperationCommit,
	saveDevRequirement,
	serializeDevRequirement,
} from "./records";
import type {
	DevActionBinding,
	DevActionResult,
	DevDecision,
	DevGitAction,
	DevGitPreview,
	DevGitTarget,
	DevRequirementRecord,
	DevRequirementSnapshot,
	DevStoredRequirement,
	SpecFileVersion,
} from "./types";

export interface DevGitRecords {
	read(requirementId: string): Promise<DevStoredRequirement>;
	save(record: DevRequirementRecord, expectedRecordVersion: string | null): Promise<DevStoredRequirement>;
	list(): Promise<DevStoredRequirement[]>;
	resolveOperationCommit?(requirementId: string, operationId: string): Promise<string | null>;
}
export interface DevGitServiceOptions {
	cwd: string;
	repo?: VcsGitRepo;
	records?: DevGitRecords;
	snapshot?: (requirementId: string) => Promise<DevRequirementSnapshot>;
	applyDecision?: (
		record: DevRequirementRecord,
		decision: DevDecision,
		operation: DevGitAction,
	) => DevRequirementRecord | Promise<DevRequirementRecord>;
}
export interface DevOwnedChange {
	id: string;
	path: string;
	paths?: string[];
	layer: "committed" | "staged" | "unstaged" | "untracked";
	beforeVersion: string | null;
	afterVersion: string | null;
	patch: string;
	committedShas: string[];
	baselineIndexVersion: string;
	parentSha: string | null;
	commitSha: string | null;
}
export interface DevOwnedToolEvent {
	toolCallId: string;
	toolName: string;
	input: unknown;
	sessionId: string;
	isError?: boolean;
}
interface OwnedCapture {
	requirementId: string;
	baselineIndexVersion: string;
	beforeTree: string;
	complete: boolean;
	files: Array<{ path: string; beforeVersion: string | null; preimagePath: string }>;
}
interface PreviewState {
	preview: DevGitPreview;
	patch: string;
	stagedPatch: string | null;
	indexPath: string;
	reconciledIndexPath: string;
	recordPath: string;
	originalRecordVersion: string;
	scopeHash: string;
	scopePaths: string[];
	ownedChangeIds: string[];
}
interface Receipt {
	state: PreviewState;
	decision: DevDecision;
	result: DevActionResult["persistence"];
	message: string;
	savedRecordVersion: string | null;
	commitTree: string | null;
	finalRecord: DevRequirementRecord | null;
	authoritativeRecordVersion: string | null;
	finalized: boolean;
	saveAttempted: boolean;
}
const SCOPED_HOOKS = [
	"pre-commit",
	"prepare-commit-msg",
	"commit-msg",
	"post-commit",
	"reference-transaction",
	"pre-push",
] as const;
const FETCH_HOOKS = ["reference-transaction", "pre-auto-gc"] as const;
const PUSH_HOOKS = ["pre-push", "reference-transaction"] as const;
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function labelRecordPatch(patch: string, requirementId: string): string {
	const file = recordPath(requirementId);
	return patch
		.split("\n")
		.map(line => {
			if (line.startsWith("diff --git ")) return `diff --git a/${file} b/${file}`;
			if (line.startsWith("--- ") && line !== "--- /dev/null") return `--- a/${file}`;
			if (line.startsWith("+++ ") && line !== "+++ /dev/null") return `+++ b/${file}`;
			return line;
		})
		.join("\n");
}
function validId(value: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value.includes(".."))
		throw new Error("Unsafe requirement or operation identity");
	return value;
}
function recordPath(id: string): string {
	return `docs/dev-requirements/${validId(id)}.json`;
}
export function sanitizeDevRemoteUrl(value: string): string {
	if (!value.includes("://")) return value.replace(/^[^@/]+:[^@/]+@/, "");
	const url = new URL(value);
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	return url.toString();
}
function patchPaths(patch: string): string[] {
	const found = new Set<string>();
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const quoted = /^diff --git ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(line);
			const plain = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
			if (quoted) {
				found.add((JSON.parse(quoted[1]) as string).slice(2));
				found.add((JSON.parse(quoted[2]) as string).slice(2));
			} else if (plain) {
				found.add(plain[1]);
				found.add(plain[2]);
			}
		}
		if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
		let file = line.slice(4).split("\t")[0];
		if (file === "/dev/null") continue;
		if (file.startsWith('"')) file = JSON.parse(file) as string;
		file = file.replace(/^[ab]\//, "");
		found.add(file);
	}
	return [...found];
}
/** Keep each file's hunk offsets intact; staged overlap is resolved by the native three-way merge. */
function patchFiles(patch: string): string[] {
	return patch.split(/(?=^diff --git )/m).filter(Boolean);
}

/** One workspace's scoped Git effects, with durable, operation-keyed recovery receipts. */
export class DevGitService {
	readonly cwd: string;
	readonly repo: VcsGitRepo;
	readonly #records: DevGitRecords;
	readonly #snapshot: (requirementId: string) => Promise<DevRequirementSnapshot>;
	readonly #applyDecision: NonNullable<DevGitServiceOptions["applyDecision"]>;
	readonly #active = new Map<string, { confirmation: string; result: Promise<DevActionResult> }>();
	constructor(options: DevGitServiceOptions) {
		this.repo = options.repo ?? vcs.requireGit(options.cwd);
		this.cwd = this.repo.info().repoRoot;
		this.#records = options.records ?? {
			read: id => readDevRequirement(this.cwd, id),
			save: (record, version) => saveDevRequirement(this.cwd, record, version),
			list: () => loadDevRequirements(this.cwd),
			resolveOperationCommit: (id, operationId) => resolveDevOperationCommit(this.cwd, id, operationId),
		};
		this.#snapshot =
			options.snapshot ?? (async id => ({ ...(await this.#records.read(id)), runtime: null, actions: [] }));
		this.#applyDecision =
			options.applyDecision ??
			((record, decision, operation) => {
				if (operation !== "commit" && operation !== "cancel")
					throw new Error("Human marks and test/fix changes require the controller's decision transition");
				const decisions = record.decisions.some(item => item.operationId === decision.operationId)
					? record.decisions
					: [...record.decisions, decision];
				if (operation === "cancel") return { ...record, lifecycle: "cancelled", decisions };
				return { ...record, decisions };
			});
	}
	#directory(operationId: string): string {
		return path.join(this.cwd, ".omp", "dev-workbench", "git-operations", validId(operationId));
	}
	async #readJson<T>(file: string): Promise<T> {
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	}
	async #writeJson(file: string, value: unknown): Promise<void> {
		const relative = path.relative(this.cwd, file).replaceAll("\\", "/");
		await assertSpecWritePath(this.cwd, relative);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await writeFileAtomically(file, `${JSON.stringify(value)}\n`);
	}
	async #indexVersion(): Promise<string> {
		return artifactVersion(await fs.readFile(path.join(this.repo.info().gitDir, "index")));
	}
	async #version(file: string): Promise<string | null> {
		await assertSpecWritePath(this.cwd, file);
		try {
			return artifactVersion(await fs.readFile(await containedSpecPath(this.cwd, file)));
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}
	async #assertFiles(files: SpecFileVersion[]): Promise<void> {
		const seen = new Set<string>();
		for (const file of files) {
			if (seen.has(file.path)) throw new Error(`Duplicate confirmed path: ${file.path}`);
			seen.add(file.path);
			if ((await this.#version(file.path)) !== file.version) throw new Error(`Confirmed file changed: ${file.path}`);
		}
	}
	async #assertHooks(signal: AbortSignal, names: readonly string[] = SCOPED_HOOKS): Promise<void> {
		for (const name of names)
			if (await this.repo.hookPath(name, signal))
				throw new Error(
					`Dev scoped Git cannot execute the effective ${name} hook; resolve the repository hook requirement explicitly`,
				);
	}
	async #snapshotPaths(base: string, files: string[], indexPath: string, signal: AbortSignal): Promise<string> {
		await this.repo.readTree(base, indexPath, signal);
		await this.repo.stageFilesIntoIndex(files, indexPath, signal);
		return this.repo.writeTree(indexPath, signal);
	}
	async #head(signal: AbortSignal): Promise<{ sha: string; ref: string }> {
		const head = await this.repo.head(signal);
		if (!head.commit || !head.refName?.startsWith("refs/heads/"))
			throw new Error("Dev requires an existing symbolic source branch and HEAD");
		return { sha: head.commit, ref: head.refName };
	}
	async #target(target: DevGitTarget, signal: AbortSignal): Promise<void> {
		if (!target.targetRef.startsWith("refs/heads/") || !target.localSourceRef.startsWith("refs/heads/"))
			throw new Error("An explicit existing branch ref is required");
		if (!target.sourceRef || !target.baseRef || !target.sourceRepository || !target.baseRepository)
			throw new Error("Explicit source/base repository and ref are required");
		if (
			target.sourceRepository === target.baseRepository &&
			target.sourceRef.replace(/^refs\/heads\//, "") === target.baseRef.replace(/^refs\/heads\//, "")
		)
			throw new Error("Dev cannot publish directly to the PR base branch");
		const url = await this.repo.remoteUrl(target.remote, signal);
		if (!url || sanitizeDevRemoteUrl(url) !== target.remoteUrl)
			throw new Error("Confirmed publication remote configuration changed");
		let sourceIdentity: string;
		try {
			sourceIdentity = devRepositoryIdentity(url);
		} catch {
			sourceIdentity = sanitizeDevRemoteUrl(url);
		}
		if (
			sourceIdentity !== target.sourceRepository ||
			target.targetRef !==
				(target.sourceRef.startsWith("refs/heads/") ? target.sourceRef : `refs/heads/${target.sourceRef}`)
		)
			throw new Error("Publication ref/repository does not match the confirmed PR source");
		let baseFound = false;
		for (const remote of await this.repo.remoteList(signal)) {
			const baseUrl = await this.repo.remoteUrl(remote, signal);
			if (!baseUrl) continue;
			let baseIdentity: string;
			try {
				baseIdentity = devRepositoryIdentity(baseUrl);
			} catch {
				baseIdentity = sanitizeDevRemoteUrl(baseUrl);
			}
			if (baseIdentity !== target.baseRepository) continue;
			if (!(await this.repo.remoteRef(remote, target.baseRef, signal)).sha)
				throw new Error("Confirmed base branch does not exist on its configured remote");
			baseFound = true;
			break;
		}
		if (!baseFound) throw new Error("No configured remote can verify the confirmed PR base repository");
		const remoteTip = (await this.repo.remoteRef(target.remote, target.targetRef, signal)).sha;
		if (remoteTip !== target.observedTip) throw new Error("Remote tip changed; prepare a new explicit confirmation");
	}
	async #ancestors(head: string, signal: AbortSignal): Promise<string[]> {
		const pending = [head];
		const seen = new Set<string>();
		while (pending.length) {
			const sha = pending.pop()!;
			if (seen.has(sha)) continue;
			seen.add(sha);
			pending.push(...(await this.repo.commitDetails(sha, signal)).parents);
		}
		return [...seen].reverse();
	}
	async #outgoing(tip: string | null, head: string, target: DevGitTarget, signal: AbortSignal): Promise<string[]> {
		if (tip && !(await this.repo.refExists(tip, signal))) {
			await this.#assertHooks(signal, FETCH_HOOKS);
			await this.repo.fetch(
				target.remote,
				target.targetRef,
				`refs/omp/dev-observe/${artifactVersion(`${target.remote}:${target.targetRef}:${tip}`)}`,
				undefined,
				signal,
			);
		}
		if (tip && (await this.repo.mergeBase(tip, head, signal)) !== tip)
			throw new Error("Confirmed remote tip is not an ancestor; publication requires synchronization, never force");
		return tip ? this.repo.revListRange(tip, head, signal) : this.#ancestors(head, signal);
	}
	async #isPublished(sha: string, tip: string | null, target: DevGitTarget, signal: AbortSignal): Promise<boolean> {
		if (tip === sha) return true;
		if (!tip) return false;
		if (!(await this.repo.refExists(tip, signal))) {
			await this.#assertHooks(signal, FETCH_HOOKS);
			await this.repo.fetch(
				target.remote,
				target.targetRef,
				`refs/omp/dev-observe/${artifactVersion(`${target.remote}:${target.targetRef}:${tip}`)}`,
				undefined,
				signal,
			);
		}
		return (await this.repo.mergeBase(sha, tip, signal)) === sha;
	}
	async discoverDevGitTargets(
		requirementId: string,
		signal: AbortSignal = new AbortController().signal,
	): Promise<DevGitTarget[]> {
		await this.#records.read(requirementId);
		const head = await this.#head(signal);
		const sourceBranch = head.ref.slice("refs/heads/".length);
		const configuredRemote = await this.repo.configGet(`branch.${sourceBranch}.remote`, signal);
		const configuredBase = await this.repo.configGet(`branch.${sourceBranch}.merge`, signal);
		const branches = await this.repo.listBranches(true, signal);
		const localBranches = await this.repo.listBranches(false, signal);
		const remotes: Array<{ name: string; url: string; identity: string; tip: string | null; bases: string[] }> = [];
		for (const name of await this.repo.remoteList(signal)) {
			const url = await this.repo.remoteUrl(name, signal);
			if (!url) continue;
			let identity: string;
			try {
				identity = devRepositoryIdentity(url);
			} catch {
				identity = sanitizeDevRemoteUrl(url);
			}
			const refs = new Set(
				localBranches.map(branch => (branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`)),
			);
			if (name === configuredRemote && configuredBase?.startsWith("refs/heads/")) refs.add(configuredBase);
			for (const candidate of branches) {
				const normalized = candidate
					.trim()
					.replace(/^\* /, "")
					.replace(/^(?:refs\/)?remotes\//, "");
				if (normalized.startsWith(`${name}/`) && !normalized.includes(" -> ") && !normalized.endsWith("/HEAD"))
					refs.add(`refs/heads/${normalized.slice(name.length + 1)}`);
			}
			const bases: string[] = [];
			for (const ref of refs) if ((await this.repo.remoteRef(name, ref, signal)).sha) bases.push(ref);
			remotes.push({
				name,
				url: sanitizeDevRemoteUrl(url),
				identity,
				tip: (await this.repo.remoteRef(name, head.ref, signal)).sha,
				bases,
			});
		}
		const result: DevGitTarget[] = [];
		for (const source of remotes)
			for (const base of remotes)
				for (const baseRef of base.bases) {
					if (source.identity === base.identity && baseRef === head.ref) continue;
					result.push({
						localSourceRef: head.ref,
						sourceRepository: source.identity,
						sourceRef: head.ref,
						baseRepository: base.identity,
						baseRef,
						remote: source.name,
						remoteUrl: source.url,
						targetRef: head.ref,
						observedTip: source.tip,
					});
				}
		return result;
	}
	async #pathPatch(head: string, files: string[], directory: string, signal: AbortSignal): Promise<string> {
		if (!files.length) return "";
		const tree = await this.#snapshotPaths(
			head,
			files,
			path.join(directory, `scope-${artifactVersion(JSON.stringify(files))}.index`),
			signal,
		);
		return this.repo.diffTree(head, tree, true, signal);
	}
	async #confirmedPatch(
		requirementId: string,
		head: string,
		files: string[],
		directory: string,
		signal: AbortSignal,
	): Promise<{ patch: string; ownedChangeIds: string[] }> {
		const owned = (await this.getOwnedChanges(requirementId, signal)).filter(
			change => change.layer !== "committed" && files.includes(change.path),
		);
		const ownedPaths = new Set(owned.map(change => change.path));
		const unownedFiles = files.filter(file => !ownedPaths.has(file));
		return {
			patch: vcs.joinPatches([
				...owned.map(change => change.patch),
				await this.#pathPatch(head, unownedFiles, directory, signal),
			]),
			ownedChangeIds: owned.map(change => change.id),
		};
	}
	async previewDevGitOperation(
		record: DevRequirementRecord,
		input: {
			binding: DevActionBinding;
			operation: Exclude<DevGitAction, "cancel">;
			target: DevGitTarget;
			files: SpecFileVersion[];
			paths?: string[];
		},
		signal: AbortSignal,
	): Promise<DevGitPreview> {
		return this.#preview(record, input, null, null, signal);
	}
	async previewCancellation(
		record: DevRequirementRecord,
		input: {
			binding: DevActionBinding;
			target: DevGitTarget;
			files: SpecFileVersion[];
			paths?: string[];
			patch: string;
			stagedPatch?: string;
			cancellation?: DevGitPreview["cancellation"];
		},
		signal: AbortSignal,
	): Promise<DevGitPreview> {
		return this.#preview(record, { ...input, operation: "cancel" }, input.patch, input.stagedPatch ?? null, signal);
	}
	async #preview(
		record: DevRequirementRecord,
		input: {
			binding: DevActionBinding;
			operation: DevGitAction;
			target: DevGitTarget;
			files: SpecFileVersion[];
			paths?: string[];
			cancellation?: DevGitPreview["cancellation"];
		},
		overridePatch: string | null,
		stagedPatch: string | null,
		signal: AbortSignal,
	): Promise<DevGitPreview> {
		signal.throwIfAborted();
		const stored = await this.#records.read(record.requirementId);
		if (
			stored.recordVersion !== input.binding.expectedRecordVersion ||
			stored.record.stage !== input.binding.expectedStage ||
			input.binding.requirementId !== record.requirementId
		)
			throw new Error("Stale requirement confirmation");
		if (stored.record.gitOperations.some(operation => operation.operationId === input.binding.operationId))
			throw new Error("Operation already exists; resume it instead");
		await this.#assertFiles(input.files);
		const head = await this.#head(signal);
		if (
			head.ref !== input.target.localSourceRef ||
			(stored.record.branch !== head.ref && stored.record.branch !== head.ref.slice(11))
		)
			throw new Error("Requirement source branch changed");
		await this.#assertHooks(signal);
		await this.#target(input.target, signal);
		const directory = this.#directory(input.binding.operationId);
		await assertSpecWritePath(
			this.cwd,
			path.relative(this.cwd, path.join(directory, "preview.json")).replaceAll("\\", "/"),
		);
		await fs.mkdir(directory, { recursive: true });
		const indexVersion = await this.#indexVersion();
		const indexPath = path.join(directory, "commit.index");
		const reconciledIndexPath = path.join(directory, "reconciled.index");
		const files = input.paths ?? input.files.map(file => file.path);
		if (stored.record.lifecycle === "completed" || stored.record.lifecycle === "cancelled")
			throw new Error("Finished requirements cannot prepare new Git operations");
		const ownRecord = recordPath(record.requirementId);
		if (stored.record.stage === "testing" && files.some(file => file !== ownRecord))
			throw new Error("Post-merge testing may commit only its own requirement record");
		for (const other of await this.#records.list()) {
			if (other.record.requirementId === record.requirementId) continue;
			const foreign = new Set([
				recordPath(other.record.requirementId),
				...other.record.materials.map(material => material.path),
			]);
			if (files.some(file => foreign.has(file)))
				throw new Error(
					`Confirmed scope includes another requirement's record or materials: ${other.record.requirementId}`,
				);
		}
		for (const file of files) await assertSpecWritePath(this.cwd, file);
		const confirmed =
			overridePatch === null
				? await this.#confirmedPatch(record.requirementId, head.sha, files, directory, signal)
				: { patch: overridePatch, ownedChangeIds: [] };
		const patch = confirmed.patch;
		for (const file of patchPaths(patch))
			if (!files.includes(file)) throw new Error(`Patch exceeds confirmed scope: ${file}`);
		await this.repo.readTree(head.sha, indexPath, signal);
		if (patch) await this.repo.applyPatch(patch, { cached: true, indexPath }, signal);
		const proposedTree = await this.repo.writeTree(indexPath, signal);
		const preview: DevGitPreview = {
			previewId: randomUUID(),
			binding: input.binding,
			headSha: head.sha,
			indexVersion,
			files: input.files,
			paths: files,
			patch,
			patchHash: artifactVersion(patch),
			target: { ...input.target, remoteUrl: sanitizeDevRemoteUrl(input.target.remoteUrl) },
			proposedTree,
			commitsToPublish: await this.#outgoing(input.target.observedTip, head.sha, input.target, signal),
			operation: input.operation,
		};
		if (input.cancellation) preview.cancellation = input.cancellation;
		const state: PreviewState = {
			preview,
			patch,
			stagedPatch,
			indexPath,
			reconciledIndexPath,
			recordPath: recordPath(record.requirementId),
			originalRecordVersion: stored.recordVersion,
			scopePaths: files,
			ownedChangeIds: confirmed.ownedChangeIds,
			scopeHash: artifactVersion(
				JSON.stringify({
					files: input.files,
					scopePaths: files,
					patch,
					stagedPatch,
					sourceRef: head.ref,
					target: preview.target,
				}),
			),
		};
		await this.#writeJson(path.join(directory, "preview.json"), state);
		return preview;
	}
	async #reconcile(state: PreviewState, patch: string, signal: AbortSignal): Promise<void> {
		await fs.copyFile(path.join(this.repo.info().gitDir, "index"), state.reconciledIndexPath);
		for (const unit of patchFiles(patch)) {
			const options = { cached: true, indexPath: state.reconciledIndexPath };
			if (await this.repo.canApplyPatch(unit, { ...options, reverse: true }, signal)) continue;
			await this.repo.applyPatch(unit, { ...options, threeWay: true }, signal);
		}
	}
	async #validateCommit(sha: string, receipt: Receipt, signal: AbortSignal): Promise<void> {
		const detail = await this.repo.commitDetails(sha, signal);
		if (detail.parents.length !== 1 || detail.parents[0] !== receipt.state.preview.headSha)
			throw new Error("Operation commit parent cannot be verified");
		const raw = await this.repo.showBlob(`${sha}:${receipt.state.recordPath}`, undefined, signal);
		if (raw.truncated) throw new Error("Operation record blob is truncated");
		if (artifactVersion(raw.data) !== receipt.savedRecordVersion)
			throw new Error("Committed operation record bytes differ from the saved decision");
		const committed = JSON.parse(raw.data.toString("utf8")) as DevRequirementRecord;
		if (
			committed.requirementId !== receipt.state.preview.binding.requirementId ||
			!committed.gitOperations.some(operation => operation.operationId === receipt.state.preview.binding.operationId)
		)
			throw new Error("Commit does not contain the confirmed requirement operation");
		const parentExists = (await this.repo.lsTree(detail.parents[0], [receipt.state.recordPath], signal)).includes(
			receipt.state.recordPath,
		);
		const parent = parentExists
			? await this.repo.showBlob(`${detail.parents[0]}:${receipt.state.recordPath}`, undefined, signal)
			: null;
		if (parent) {
			if (parent.truncated) throw new Error("Parent record blob is truncated");
			const previous = JSON.parse(parent.data.toString("utf8")) as DevRequirementRecord;
			if (
				previous.gitOperations.some(
					operation => operation.operationId === receipt.state.preview.binding.operationId,
				)
			)
				throw new Error("Operation was already present in the commit parent");
		}
		if ((await this.repo.resolveRef(`${sha}^{tree}`, signal)) !== receipt.commitTree)
			throw new Error("Operation commit tree does not match the confirmed scoped tree");
	}
	async #observeCommit(receipt: Receipt, signal: AbortSignal): Promise<DevActionResult["persistence"]["commit"]> {
		if (!receipt.commitTree || !receipt.savedRecordVersion) return receipt.result.commit;
		const sha =
			receipt.result.commit.sha ??
			(await this.getOperationCommit(
				receipt.state.preview.binding.requirementId,
				receipt.state.preview.binding.operationId,
				signal,
			));
		if (!sha) return receipt.result.commit;
		await this.#validateCommit(sha, receipt, signal);
		let indexReconciled = receipt.result.commit.indexReconciled;
		if (!indexReconciled) {
			try {
				indexReconciled =
					(await this.#indexVersion()) === artifactVersion(await fs.readFile(receipt.state.reconciledIndexPath));
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		return { status: "succeeded", sha, indexReconciled };
	}
	async getOperationCommit(
		requirementId: string,
		operationId: string,
		signal: AbortSignal = new AbortController().signal,
	): Promise<string | null> {
		let receipt: Receipt;
		try {
			receipt = await this.#readJson<Receipt>(path.join(this.#directory(operationId), "receipt.json"));
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return this.#records.resolveOperationCommit
				? this.#records.resolveOperationCommit(requirementId, operationId)
				: resolveDevOperationCommit(this.cwd, requirementId, operationId);
		}
		if (receipt.state.preview.binding.requirementId !== requirementId)
			throw new Error("Operation belongs to a different requirement");
		const known = receipt.result.commit.sha;
		if (known) {
			await this.#validateCommit(known, receipt, signal);
			return known;
		}
		for (const sha of await this.repo.revListTouching("HEAD", receipt.state.recordPath, 10000, signal)) {
			try {
				await this.#validateCommit(sha, receipt, signal);
				return sha;
			} catch {
				/* Only exact blob/tree/parent matches are operation commits. */
			}
		}
		return null;
	}
	async executeDevGitOperation(
		preview: DevGitPreview,
		decision: DevDecision,
		signal: AbortSignal,
	): Promise<DevActionResult> {
		if (decision.operationId !== preview.binding.operationId || decision.stage !== preview.binding.expectedStage)
			throw new Error("Decision is not bound to this confirmation");
		const confirmation = JSON.stringify({ preview, decision });
		const existing = this.#active.get(decision.operationId);
		if (existing) {
			if (existing.confirmation !== confirmation)
				throw new Error("Concurrent confirmation differs from the operation already executing");
			return existing.result;
		}
		const work = this.#execute(preview, decision, signal);
		this.#active.set(decision.operationId, { confirmation, result: work });
		try {
			return await work;
		} finally {
			this.#active.delete(decision.operationId);
		}
	}
	async #execute(preview: DevGitPreview, decision: DevDecision, signal: AbortSignal): Promise<DevActionResult> {
		const directory = this.#directory(decision.operationId);
		const file = path.join(directory, "receipt.json");
		let receipt: Receipt;
		try {
			receipt = await this.#readJson<Receipt>(file);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const state = await this.#readJson<PreviewState>(path.join(directory, "preview.json"));
			if (JSON.stringify(state.preview) !== JSON.stringify(preview))
				throw new Error("Unknown or modified Git confirmation");
			receipt = {
				state,
				decision,
				result: {
					save: "not-started",
					commit: { status: "not-started", sha: null, indexReconciled: false },
					push: { status: "not-started", target: preview.target },
				},
				message: `dev(${preview.binding.requirementId}): ${preview.operation}\n\nomp-operation: ${decision.operationId}`,
				savedRecordVersion: null,
				commitTree: null,
				finalRecord: null,
				authoritativeRecordVersion: null,
				finalized: false,
				saveAttempted: false,
			};
			await this.#writeJson(file, receipt);
		}
		if (
			JSON.stringify(receipt.state.preview) !== JSON.stringify(preview) ||
			JSON.stringify(receipt.decision) !== JSON.stringify(decision)
		)
			throw new Error("Operation identity was already used with different confirmation data");
		const scopeHash = artifactVersion(
			JSON.stringify({
				files: preview.files,
				scopePaths: receipt.state.scopePaths,
				patch: receipt.state.patch,
				stagedPatch: receipt.state.stagedPatch,
				sourceRef: preview.target.localSourceRef,
				target: preview.target,
			}),
		);
		if (scopeHash !== receipt.state.scopeHash || artifactVersion(receipt.state.patch) !== preview.patchHash)
			throw new Error("Git operation scope binding is corrupt");
		const persist = () => this.#writeJson(file, receipt);
		try {
			signal.throwIfAborted();
			if (receipt.result.save !== "succeeded" && !receipt.finalRecord) {
				const stored = await this.#records.read(preview.binding.requirementId);
				const alreadySaved = stored.record.gitOperations.find(
					operation => operation.operationId === decision.operationId,
				);
				if (
					alreadySaved &&
					(alreadySaved.kind !== preview.operation ||
						JSON.stringify(alreadySaved.target) !== JSON.stringify(preview.target) ||
						JSON.stringify(alreadySaved.files) !== JSON.stringify(preview.files) ||
						!stored.record.decisions.some(item => JSON.stringify(item) === JSON.stringify(decision)))
				)
					throw new Error("Saved operation identity differs from this confirmation");
				if (!alreadySaved) {
					const cancelling =
						preview.operation === "cancel" &&
						stored.record.lifecycle === "cancelling" &&
						stored.record.decisions.some(item => JSON.stringify(item) === JSON.stringify(decision));
					if (preview.operation === "cancel" && !cancelling)
						throw new Error("Cancellation must first persist its cancelling decision");
					if (
						(!cancelling && stored.recordVersion !== preview.binding.expectedRecordVersion) ||
						stored.record.stage !== preview.binding.expectedStage
					)
						throw new Error("Stale requirement confirmation");
					const head = await this.#head(signal);
					if (
						head.sha !== preview.headSha ||
						head.ref !== preview.target.localSourceRef ||
						(await this.#indexVersion()) !== preview.indexVersion
					)
						throw new Error("Source HEAD or index changed after confirmation");
					await this.#assertHooks(signal);
					await this.#target(preview.target, signal);
					if (preview.operation !== "cancel") {
						await this.#assertFiles(preview.files);
						const confirmed = await this.#confirmedPatch(
							preview.binding.requirementId,
							preview.headSha,
							receipt.state.scopePaths,
							directory,
							signal,
						);
						if (
							artifactVersion(confirmed.patch) !== preview.patchHash ||
							JSON.stringify(confirmed.ownedChangeIds) !== JSON.stringify(receipt.state.ownedChangeIds)
						)
							throw new Error("Confirmed scope changed");
					}
					const transitioned = await this.#applyDecision(
						structuredClone(stored.record),
						decision,
						preview.operation,
					);
					if (
						transitioned.requirementId !== stored.record.requirementId ||
						transitioned.changeId !== stored.record.changeId ||
						transitioned.branch !== stored.record.branch
					)
						throw new Error("Decision transition cannot replace requirement identity or branch");
					const knownCommitShas = new Set(stored.record.gitOperations.flatMap(item => item.knownCommitShas));
					for (const previous of stored.record.gitOperations) {
						const sha = await this.getOperationCommit(stored.record.requirementId, previous.operationId, signal);
						if (sha) knownCommitShas.add(sha);
					}
					const operation = {
						operationId: decision.operationId,
						kind: preview.operation,
						actor: decision.actor,
						at: decision.at,
						files: preview.files,
						target: preview.target,
						authorizedCommits: [...knownCommitShas].filter(sha => preview.commitsToPublish.includes(sha)),
						knownCommitShas: [...knownCommitShas],
					};
					transitioned.gitOperations = [...transitioned.gitOperations, operation];
					if (!transitioned.decisions.some(item => item.operationId === decision.operationId))
						transitioned.decisions.push(decision);
					if (preview.operation !== "cancel") await this.#assertFiles(preview.files);
					if (preview.operation === "cancel") {
						if (transitioned.lifecycle !== "cancelled")
							throw new Error("Cancellation transition must produce the final cancelled tombstone");
						const bytes = serializeDevRequirement(transitioned);
						await writeFileAtomically(path.join(directory, "final-record.json"), new TextDecoder().decode(bytes));
						receipt.finalRecord = transitioned;
						receipt.savedRecordVersion = artifactVersion(bytes);
						receipt.authoritativeRecordVersion = stored.recordVersion;
					} else {
						receipt.saveAttempted = true;
						await persist();
						const saved = await this.#records.save(transitioned, stored.recordVersion);
						receipt.savedRecordVersion = saved.recordVersion;
					}
				} else receipt.savedRecordVersion = stored.recordVersion;
				receipt.result.save = "succeeded";
				await persist();
			}
			if (receipt.result.commit.status !== "succeeded" || !receipt.result.commit.indexReconciled) {
				if (!receipt.commitTree) {
					if ((await this.#indexVersion()) !== preview.indexVersion)
						throw new Error("Index changed before scoped commit");
					const saved = await this.#records.read(preview.binding.requirementId);
					if (
						saved.recordVersion !==
						(receipt.finalRecord ? receipt.authoritativeRecordVersion : receipt.savedRecordVersion)
					)
						throw new Error("Saved decision changed before scoped commit");
					const state = receipt.state;
					await this.repo.readTree(preview.proposedTree, state.indexPath, signal);
					let recordPatch: string;
					if (receipt.finalRecord) {
						const before = path.join(directory, "record-before");
						if (
							(await this.repo.lsTree(preview.headSha, [state.recordPath], signal)).includes(state.recordPath)
						) {
							const blob = await this.repo.showBlob(`${preview.headSha}:${state.recordPath}`, undefined, signal);
							if (blob.truncated) throw new Error("Original requirement record blob is truncated");
							await fs.writeFile(before, blob.data);
						}
						recordPatch = labelRecordPatch(
							await this.repo.diffNoIndex(before, path.join(directory, "final-record.json"), true, signal),
							preview.binding.requirementId,
						);
					} else recordPatch = await this.#pathPatch(preview.headSha, [state.recordPath], directory, signal);
					// Replace only this record in the isolated confirmation tree.
					const oldRecordPatch = await this.repo.diffText(
						{ base: preview.headSha, head: preview.proposedTree, files: [state.recordPath], binary: true },
						signal,
					);
					if (oldRecordPatch)
						await this.repo.applyPatch(
							oldRecordPatch,
							{ cached: true, indexPath: state.indexPath, reverse: true },
							signal,
						);
					if (recordPatch)
						await this.repo.applyPatch(recordPatch, { cached: true, indexPath: state.indexPath }, signal);
					const commitTree = await this.repo.writeTree(state.indexPath, signal);
					const recordBlob = await this.repo.showBlob(`${commitTree}:${state.recordPath}`, undefined, signal);
					if (recordBlob.truncated || artifactVersion(recordBlob.data) !== receipt.savedRecordVersion)
						throw new Error("Native filters or concurrent writes changed the authoritative record bytes");
					const finalPatch = await this.repo.diffTree(preview.headSha, commitTree, true, signal);
					if (state.stagedPatch !== null) {
						await fs.copyFile(path.join(this.repo.info().gitDir, "index"), state.reconciledIndexPath);
						if (state.stagedPatch)
							await this.repo.applyPatch(
								state.stagedPatch,
								{ cached: true, indexPath: state.reconciledIndexPath },
								signal,
							);
						for (const unit of patchFiles(recordPatch))
							if (
								!(await this.repo.canApplyPatch(
									unit,
									{ cached: true, indexPath: state.reconciledIndexPath, reverse: true },
									signal,
								))
							)
								await this.repo.applyPatch(
									unit,
									{ cached: true, indexPath: state.reconciledIndexPath, threeWay: true },
									signal,
								);
					} else await this.#reconcile(state, finalPatch, signal);
					receipt.commitTree = commitTree;
					await persist();
				}
				if (preview.operation !== "cancel" && !receipt.result.commit.sha)
					await this.#assertFiles(preview.files.filter(file => file.path !== receipt.state.recordPath));
				const committed = await this.repo.commitCreateScoped(
					receipt.message,
					{
						expectedHeadRef: preview.target.localSourceRef,
						expectedHeadSha: preview.headSha,
						expectedIndexVersion: preview.indexVersion,
						indexPath: receipt.state.indexPath,
						reconciledIndexPath: receipt.state.reconciledIndexPath,
						expectedTree: receipt.commitTree,
						files: [...new Set([...receipt.state.scopePaths, receipt.state.recordPath])],
					},
					signal,
				);
				receipt.result.commit = {
					status: committed.refUpdated ? "succeeded" : "failed",
					sha: committed.sha,
					indexReconciled: committed.indexUpdated,
				};
				await persist();
				if (!committed.sha || !committed.refUpdated || !committed.indexUpdated)
					throw new Error(committed.diagnostic ?? "Scoped commit or index reconciliation did not complete");
				await this.#validateCommit(committed.sha, receipt, signal);
			}
			const sha = receipt.result.commit.sha;
			if (!sha) throw new Error("No verified operation commit exists");
			await this.#validateCommit(sha, receipt, signal);
			const configuredUrl = await this.repo.remoteUrl(preview.target.remote, signal);
			if (!configuredUrl || sanitizeDevRemoteUrl(configuredUrl) !== preview.target.remoteUrl)
				throw new Error("Publication remote changed; the successful commit is preserved");
			receipt.result.push.status = "unknown";
			await persist();
			const observed = (await this.repo.remoteRef(preview.target.remote, preview.target.targetRef, signal)).sha;
			if (await this.#isPublished(sha, observed, preview.target, signal)) receipt.result.push.status = "succeeded";
			else {
				if (observed !== preview.target.observedTip)
					throw new Error(
						"Remote changed since confirmation; operation is committed but awaiting synchronization",
					);
				const outgoing = await this.#outgoing(observed, sha, preview.target, signal);
				try {
					await this.#assertAuthorized(outgoing, sha, receipt, signal);
				} catch (error) {
					receipt.result.push.status = "failed";
					throw error;
				}
				receipt.result.push.status = "unknown";
				await persist();
				await this.#assertHooks(signal, PUSH_HOOKS);
				let failure: unknown;
				try {
					await this.repo.push(
						{
							remote: preview.target.remote,
							refspec: `${sha}:${preview.target.targetRef}`,
							forceWithLease: false,
						},
						signal,
					);
				} catch (error) {
					failure = error;
				}
				const tip = (
					await this.repo.remoteRef(preview.target.remote, preview.target.targetRef, AbortSignal.timeout(30_000))
				).sha;
				if (!(await this.#isPublished(sha, tip, preview.target, AbortSignal.timeout(30_000)))) {
					receipt.result.push.status = tip === observed ? "failed" : "unknown";
					throw failure ?? new Error("Remote does not confirm the fixed operation SHA");
				}
				receipt.result.push.status = "succeeded";
			}
			delete receipt.result.error;
			await persist();
		} catch (error) {
			receipt.result.error = errorMessage(error);
			if (receipt.result.save !== "succeeded" && !receipt.finalRecord) {
				const current = await this.#records.read(preview.binding.requirementId).catch(() => null);
				const saved = current?.record.gitOperations.find(
					operation => operation.operationId === decision.operationId,
				);
				if (
					current &&
					saved &&
					saved.kind === preview.operation &&
					JSON.stringify(saved.target) === JSON.stringify(preview.target) &&
					current.record.decisions.some(item => JSON.stringify(item) === JSON.stringify(decision))
				) {
					receipt.result.save = "succeeded";
					receipt.savedRecordVersion = current.recordVersion;
				} else receipt.result.save = !current && receipt.saveAttempted ? "unknown" : "failed";
			}
			if (receipt.result.save === "succeeded" && receipt.result.commit.status === "not-started")
				receipt.result.commit.status = "failed";
			try {
				receipt.result.commit = await this.#observeCommit(receipt, AbortSignal.timeout(30_000));
			} catch (observationError) {
				receipt.result.commit.status = "unknown";
				receipt.result.error += `; commit observation: ${errorMessage(observationError)}`;
			}
			await persist();
		}
		return { snapshot: await this.#snapshot(preview.binding.requirementId), persistence: receipt.result };
	}
	async #assertAuthorized(outgoing: string[], ownSha: string, receipt: Receipt, signal: AbortSignal): Promise<void> {
		const id = receipt.state.preview.binding.requirementId;
		const known = new Set<string>();
		for (const operation of (await this.#records.read(id)).record.gitOperations) {
			const commit = await this.getOperationCommit(id, operation.operationId, signal);
			if (commit) known.add(commit);
		}
		known.add(ownSha);
		const target = receipt.state.preview.target;
		for (const remote of await this.repo.remoteList(signal)) {
			const url = await this.repo.remoteUrl(remote, signal);
			if (!url) continue;
			let identity: string;
			try {
				identity = devRepositoryIdentity(url);
			} catch {
				identity = sanitizeDevRemoteUrl(url);
			}
			if (identity !== target.baseRepository) continue;
			const base = (await this.repo.remoteRef(remote, target.baseRef, signal)).sha;
			if (!base) throw new Error("Confirmed PR base no longer exists");
			if (!(await this.repo.refExists(base, signal))) {
				await this.#assertHooks(signal, FETCH_HOOKS);
				await this.repo.fetch(
					remote,
					target.baseRef,
					`refs/omp/dev-observe/${artifactVersion(`${remote}:${target.baseRef}:${base}`)}`,
					undefined,
					signal,
				);
			}
			for (const sha of await this.#ancestors(base, signal)) known.add(sha);
			known.add(base);
			break;
		}
		for (const sha of outgoing) {
			if (known.has(sha)) continue;
			throw new Error(`Outgoing commit ${sha} has no verified requirement operation; awaiting synchronization`);
		}
	}
	async readDevGitOperation(
		requirementId: string,
		operationId: string,
		signal: AbortSignal = new AbortController().signal,
	): Promise<DevActionResult> {
		const receipt = await this.#readJson<Receipt>(path.join(this.#directory(operationId), "receipt.json"));
		if (receipt.state.preview.binding.requirementId !== requirementId)
			throw new Error("Operation belongs to another requirement");
		const persistence = structuredClone(receipt.result);
		const snapshot = await this.#snapshot(requirementId);
		if (
			(persistence.save === "not-started" || persistence.save === "unknown") &&
			snapshot.record.gitOperations.some(operation => operation.operationId === operationId) &&
			snapshot.record.decisions.some(decision => JSON.stringify(decision) === JSON.stringify(receipt.decision))
		)
			persistence.save = "succeeded";
		try {
			persistence.commit = await this.#observeCommit(receipt, signal);
		} catch (error) {
			persistence.commit.status = "unknown";
			persistence.error = errorMessage(error);
		}
		if (persistence.commit.sha) {
			if (persistence.commit.status !== "succeeded") {
				persistence.push.status = "unknown";
				return { snapshot, persistence };
			}
			try {
				const url = await this.repo.remoteUrl(receipt.state.preview.target.remote, signal);
				if (!url || sanitizeDevRemoteUrl(url) !== receipt.state.preview.target.remoteUrl)
					throw new Error("Confirmed remote configuration changed");
				const tip = (
					await this.repo.remoteRef(
						receipt.state.preview.target.remote,
						receipt.state.preview.target.targetRef,
						signal,
					)
				).sha;
				if (await this.#isPublished(persistence.commit.sha, tip, receipt.state.preview.target, signal))
					persistence.push.status = "succeeded";
				else if (persistence.push.status === "succeeded") persistence.push.status = "unknown";
			} catch (error) {
				persistence.push.status = "unknown";
				persistence.error = errorMessage(error);
			}
		}
		return { snapshot, persistence };
	}
	async resumeDevGitOperation(
		requirementId: string,
		operationId: string,
		signal: AbortSignal,
	): Promise<DevActionResult> {
		const receipt = await this.#readJson<Receipt>(path.join(this.#directory(operationId), "receipt.json"));
		if (receipt.state.preview.binding.requirementId !== requirementId)
			throw new Error("Operation belongs to another requirement");
		return this.executeDevGitOperation(receipt.state.preview, receipt.decision, signal);
	}
	async finalizeDevCancellation(
		requirementId: string,
		operationId: string,
		signal: AbortSignal,
	): Promise<DevActionResult> {
		const file = path.join(this.#directory(operationId), "receipt.json");
		const receipt = await this.#readJson<Receipt>(file);
		if (
			receipt.state.preview.binding.requirementId !== requirementId ||
			receipt.state.preview.operation !== "cancel" ||
			!receipt.finalRecord
		)
			throw new Error("No prepared cancellation tombstone exists for this operation");
		let publicationAttempted = false;
		try {
			signal.throwIfAborted();
			if (
				receipt.result.commit.status !== "succeeded" ||
				!receipt.result.commit.indexReconciled ||
				receipt.result.push.status !== "succeeded" ||
				!receipt.result.commit.sha
			)
				throw new Error("Cancellation Git effects are not settled");
			await this.#validateCommit(receipt.result.commit.sha, receipt, signal);
			const observed = await this.readDevGitOperation(requirementId, operationId, signal);
			if (observed.persistence.push.status !== "succeeded")
				throw new Error("Cancellation publication cannot currently be verified");
			const current = await this.#records.read(requirementId);
			if (current.recordVersion !== receipt.savedRecordVersion) {
				if (
					current.record.lifecycle !== "cancelling" ||
					current.recordVersion !== receipt.authoritativeRecordVersion
				)
					throw new Error("Cancelling record changed before final publication");
				publicationAttempted = true;
				const final = await this.#records.save(receipt.finalRecord, current.recordVersion);
				if (final.recordVersion !== receipt.savedRecordVersion)
					throw new Error("Published cancellation bytes differ from the verified committed tombstone");
			} else if (current.record.lifecycle !== "cancelled")
				throw new Error("Cancellation final record has an unexpected lifecycle");
			receipt.finalized = true;
			receipt.result.save = "succeeded";
			delete receipt.result.error;
		} catch (error) {
			const current = publicationAttempted ? await this.#records.read(requirementId).catch(() => null) : null;
			if (current?.recordVersion === receipt.savedRecordVersion && current?.record.lifecycle === "cancelled") {
				receipt.finalized = true;
				receipt.result.save = "succeeded";
				delete receipt.result.error;
			} else {
				receipt.result.save = "failed";
				receipt.result.error = errorMessage(error);
			}
		}
		await this.#writeJson(file, receipt);
		return { snapshot: await this.#snapshot(requirementId), persistence: receipt.result };
	}
	async getPendingCommitOperation(requirementId: string): Promise<string | null> {
		const record = (await this.#records.read(requirementId)).record;
		const operationIds = new Set([
			...record.gitOperations.map(operation => operation.operationId),
			...record.decisions.map(decision => decision.operationId),
		]);
		for (const operationId of operationIds) {
			let receipt: Receipt;
			try {
				receipt = await this.#readJson<Receipt>(path.join(this.#directory(operationId), "receipt.json"));
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			if (receipt.state.preview.binding.requirementId !== requirementId)
				throw new Error("Operation receipt belongs to another requirement");
			if (receipt.result.commit.status === "succeeded" && receipt.result.commit.indexReconciled) continue;
			const observed = await this.#observeCommit(receipt, AbortSignal.timeout(30_000));
			if (observed.status !== "succeeded" || !observed.indexReconciled) return operationId;
		}
		return null;
	}
	async #dirtyPaths(signal: AbortSignal): Promise<string[]> {
		const head = await this.#head(signal);
		const paths = new Set([
			...(await this.repo.changedFiles({ base: head.sha }, signal)),
			...(await this.repo.lsFiles(true, true, signal)),
		]);
		return [...paths].filter(file => file !== ".omp" && !file.startsWith(".omp/") && !file.startsWith(".git/"));
	}
	async #observedVersion(file: string): Promise<string | null> {
		let current = this.cwd;
		const segments = file.split("/");
		try {
			for (const [index, segment] of segments.entries()) {
				current = path.join(current, segment);
				const stat = await fs.lstat(current);
				if (stat.isSymbolicLink())
					return artifactVersion(`link:${await fs.readlink(current)}:${segments.slice(index + 1).join("/")}`);
				if (index === segments.length - 1)
					return stat.isFile()
						? artifactVersion(await fs.readFile(current))
						: artifactVersion(`mode:${stat.mode}`);
			}
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
		return null;
	}
	async initializeRequirementGit(
		requirementId: string,
		signal: AbortSignal = new AbortController().signal,
	): Promise<void> {
		await this.#records.read(requirementId);
		const file = path.join(
			this.cwd,
			".omp",
			"dev-workbench",
			"ownership-baselines",
			`${validId(requirementId)}.json`,
		);
		try {
			await fs.access(file);
			return;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const head = await this.#head(signal);
		const dirty: Array<{ path: string; version: string | null }> = [];
		for (const path of await this.#dirtyPaths(signal))
			dirty.push({ path, version: await this.#observedVersion(path) });
		await this.#writeJson(file, {
			headSha: head.sha,
			sourceRef: head.ref,
			indexVersion: await this.#indexVersion(),
			dirty,
		});
	}
	async getOwnershipConflicts(
		requirementId: string,
		signal: AbortSignal = new AbortController().signal,
	): Promise<Array<{ path: string; reason: string }>> {
		const file = path.join(
			this.cwd,
			".omp",
			"dev-workbench",
			"ownership-baselines",
			`${validId(requirementId)}.json`,
		);
		let baseline: { dirty: Array<{ path: string; version: string | null }> } | null;
		try {
			baseline = await this.#readJson<typeof baseline>(file);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			baseline = null;
		}
		const known = new Set(
			(await this.getOwnedChanges(requirementId, signal)).flatMap(change => change.paths ?? [change.path]),
		);
		known.add(recordPath(requirementId));
		for (const other of await this.#records.list())
			if (other.record.requirementId !== requirementId) {
				known.add(recordPath(other.record.requirementId));
				for (const material of other.record.materials) known.add(material.path);
			}
		const conflicts: Array<{ path: string; reason: string }> = [];
		for (const path of await this.#dirtyPaths(signal)) {
			if (known.has(path)) continue;
			const previous = baseline?.dirty.find(entry => entry.path === path);
			if (previous && previous.version === (await this.#observedVersion(path))) continue;
			conflicts.push({
				path,
				reason: "Dirty path has no controlled requirement preimage; ownership must be resolved explicitly",
			});
		}
		return conflicts;
	}
	async beginOwnedPaths(
		requirementId: string,
		operationId: string,
		paths: readonly string[],
		signal: AbortSignal = new AbortController().signal,
	): Promise<string> {
		signal.throwIfAborted();
		await this.#records.read(requirementId);
		const id = `capture-${artifactVersion(`${requirementId}:${operationId}`)}`;
		const directory = path.join(this.cwd, ".omp", "dev-workbench", "ownership-captures", id);
		const captureFile = path.join(directory, "capture.json");
		const requestedFiles = [
			...new Set(
				paths.map(requested => path.relative(this.cwd, path.resolve(this.cwd, requested)).replaceAll("\\", "/")),
			),
		];
		for (const file of requestedFiles) await assertSpecWritePath(this.cwd, file);
		await assertSpecWritePath(this.cwd, path.relative(this.cwd, captureFile).replaceAll("\\", "/"));
		try {
			const existing = await this.#readJson<OwnedCapture>(captureFile);
			if (
				existing.requirementId !== requirementId ||
				existing.files.length !== requestedFiles.length ||
				existing.files.some(file => !requestedFiles.includes(file.path))
			)
				throw new Error("Owned mutation identity was reused with another path scope");
			return id;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		await fs.mkdir(directory, { recursive: true });
		const capture: OwnedCapture = {
			requirementId,
			baselineIndexVersion: await this.#indexVersion(),
			beforeTree: "",
			complete: false,
			files: [],
		};
		for (const [index, file] of requestedFiles.entries()) {
			await assertSpecWritePath(this.cwd, file);
			const beforeVersion = await this.#version(file);
			const preimagePath = path.join(directory, `${index}.before`);
			if (beforeVersion !== null) {
				await fs.copyFile(path.join(this.cwd, file), preimagePath);
				await fs.chmod(preimagePath, (await fs.stat(path.join(this.cwd, file))).mode);
			}
			capture.files.push({ path: file, beforeVersion, preimagePath });
		}
		capture.beforeTree = await this.#snapshotPaths(
			(await this.#head(signal)).sha,
			capture.files.map(file => file.path),
			path.join(directory, "before.index"),
			signal,
		);
		for (const file of capture.files)
			if ((await this.#version(file.path)) !== file.beforeVersion)
				throw new Error(`Controlled path changed while capturing its preimage: ${file.path}`);
		await this.#writeJson(captureFile, capture);
		return id;
	}
	async endOwnedPaths(
		requirementId: string,
		captureId: string,
		signal: AbortSignal = new AbortController().signal,
	): Promise<void> {
		const directory = path.join(this.cwd, ".omp", "dev-workbench", "ownership-captures", validId(captureId));
		const capture = await this.#readJson<OwnedCapture>(path.join(directory, "capture.json"));
		if (capture.requirementId !== requirementId)
			throw new Error("Owned mutation capture belongs to another requirement");
		if (capture.complete) return;
		const afterVersions = new Map<string, string | null>();
		for (const file of capture.files) afterVersions.set(file.path, await this.#version(file.path));
		const afterTree = await this.#snapshotPaths(
			capture.beforeTree,
			capture.files.map(file => file.path),
			path.join(directory, "after.index"),
			signal,
		);
		for (const file of capture.files) {
			signal.throwIfAborted();
			const afterVersion = await this.#version(file.path);
			if (afterVersion !== afterVersions.get(file.path))
				throw new Error(`Controlled path changed while capturing its postimage: ${file.path}`);
			let patch = await this.repo.diffText(
				{ base: capture.beforeTree, head: afterTree, files: [file.path], binary: true },
				signal,
			);
			if (patchPaths(patch).some(path => path !== file.path)) {
				const singleTree = await this.#snapshotPaths(
					capture.beforeTree,
					[file.path],
					path.join(directory, "single-path.index"),
					signal,
				);
				patch = await this.repo.diffTree(capture.beforeTree, singleTree, true, signal);
			}
			if (!patch && afterVersion === file.beforeVersion) continue;
			await this.registerOwnedPatch(
				requirementId,
				{
					id: `${captureId}:${file.path}`,
					patch,
					files: [
						{
							path: file.path,
							beforeVersion: file.beforeVersion,
							afterVersion,
							layer: file.beforeVersion === null ? "untracked" : "unstaged",
						},
					],
					baselineIndexVersion: capture.baselineIndexVersion,
				},
				signal,
			);
		}
		capture.complete = true;
		await this.#writeJson(path.join(directory, "capture.json"), capture);
	}
	#nativeCaptureOperation(event: DevOwnedToolEvent): string {
		return `native-${artifactVersion(`${event.sessionId}:${event.toolCallId}`)}`;
	}
	async beginNativeTool(
		requirementId: string,
		event: DevOwnedToolEvent,
		signal: AbortSignal = new AbortController().signal,
	): Promise<void> {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const input = event.input;
		if (!input || typeof input !== "object" || Array.isArray(input)) return;
		const values = input as Record<string, unknown>;
		const paths: string[] = [];
		if (typeof values.path === "string" && !values.path.includes("://")) paths.push(values.path);
		if (typeof values.input === "string") {
			for (const match of values.input.matchAll(/^\[([^#\r\n]+)#[0-9A-Fa-f]{4}\]$/gm)) paths.push(match[1]);
			for (const match of values.input.matchAll(/^MV (.+)$/gm)) paths.push(match[1].replace(/^"|"$/g, ""));
			for (const match of values.input.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm))
				paths.push(match[1]);
		}
		if (paths.length) await this.beginOwnedPaths(requirementId, this.#nativeCaptureOperation(event), paths, signal);
	}
	async endNativeTool(
		requirementId: string,
		event: DevOwnedToolEvent,
		signal: AbortSignal = new AbortController().signal,
	): Promise<void> {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const id = `capture-${artifactVersion(`${requirementId}:${this.#nativeCaptureOperation(event)}`)}`;
		const file = path.join(this.cwd, ".omp", "dev-workbench", "ownership-captures", id, "capture.json");
		try {
			await fs.access(file);
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		await this.endOwnedPaths(requirementId, id, signal);
	}
	async registerOwnedPatch(
		requirementId: string,
		input: {
			id?: string;
			patch: string;
			files: Array<{
				path: string;
				beforeVersion: string | null;
				afterVersion: string | null;
				layer?: DevOwnedChange["layer"];
				parentSha?: string | null;
				commitSha?: string | null;
			}>;
			baselineIndexVersion: string;
		},
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
		const paths = patchPaths(input.patch);
		if (paths.some(file => !input.files.some(owned => owned.path === file)))
			throw new Error("Owned patch exceeds explicit paths");
		const grouped = input.files.length > 1;
		if (
			grouped &&
			input.files.some(
				file =>
					file.layer !== "committed" ||
					!file.commitSha ||
					file.commitSha !== input.files[0].commitSha ||
					!file.parentSha ||
					file.parentSha !== input.files[0].parentSha,
			)
		)
			throw new Error("Grouped ownership requires one committed SHA and an explicit common mainline parent");
		const ledgerPath = path.join(this.cwd, ".omp", "dev-workbench", "ownership", `${validId(requirementId)}.json`);
		await assertSpecWritePath(this.cwd, path.relative(this.cwd, ledgerPath).replaceAll("\\", "/"));
		await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
		await withFileLock(
			ledgerPath,
			async () => {
				const changes = await this.getOwnedChanges(requirementId, signal);
				for (const file of grouped ? input.files.slice(0, 1) : input.files) {
					await assertSpecWritePath(this.cwd, file.path);
					const existing = input.id ? changes.find(change => change.id === input.id) : undefined;
					if (existing) {
						if (
							existing.path !== file.path ||
							existing.patch !== input.patch ||
							existing.beforeVersion !== file.beforeVersion ||
							existing.afterVersion !== file.afterVersion
						)
							throw new Error("Controlled mutation changed after its first ownership settlement");
						continue;
					}
					for (const endpoint of input.files) await assertSpecWritePath(this.cwd, endpoint.path);
					changes.push({
						id: input.id ?? randomUUID(),
						path: file.path,
						...(grouped ? { paths: input.files.map(file => file.path) } : {}),
						layer: file.layer ?? "unstaged",
						beforeVersion: file.beforeVersion,
						afterVersion: file.afterVersion,
						patch: input.patch,
						committedShas: file.commitSha ? [file.commitSha] : [],
						baselineIndexVersion: input.baselineIndexVersion,
						parentSha: file.parentSha ?? null,
						commitSha: file.commitSha ?? null,
					});
				}
				await this.#writeJson(ledgerPath, changes);
			},
			{ signal },
		);
	}
	async getOwnedChanges(
		requirementId: string,
		signal: AbortSignal = new AbortController().signal,
	): Promise<DevOwnedChange[]> {
		signal.throwIfAborted();
		let changes: DevOwnedChange[];
		try {
			changes = await this.#readJson<DevOwnedChange[]>(
				path.join(this.cwd, ".omp", "dev-workbench", "ownership", `${validId(requirementId)}.json`),
			);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			changes = [];
		}
		const record = (await this.#records.read(requirementId)).record;
		for (const operation of record.gitOperations) {
			if (operation.kind === "cancel") continue;
			const sha = await this.getOperationCommit(requirementId, operation.operationId, signal);
			if (!sha) {
				const receipt = await this.#readJson<Receipt>(
					path.join(this.#directory(operation.operationId), "receipt.json"),
				).catch(error => {
					if (isEnoent(error)) return null;
					throw error;
				});
				if (
					receipt &&
					!receipt.result.commit.sha &&
					receipt.result.commit.status !== "succeeded" &&
					(await this.repo.headSha(signal)) === receipt.state.preview.headSha
				)
					continue;
				throw new Error(`Requirement operation ${operation.operationId} has no reliably resolvable commit`);
			}
			const details = await this.repo.commitDetails(sha, signal);
			let parent = details.parents[0];
			if (details.parents.length !== 1) {
				const proven = changes.filter(change => change.layer === "committed" && change.commitSha === sha);
				const parents = new Set(proven.map(change => change.parentSha));
				if (parents.size !== 1 || !proven[0]?.parentSha || !details.parents.includes(proven[0].parentSha))
					throw new Error("Merge operation has no uniquely proven mainline parent");
				parent = proven[0].parentSha;
				const directory = this.#directory(operation.operationId);
				const proof = path.join(directory, "merge-proof.index");
				const expected = path.join(directory, "merge-expected.index");
				await assertSpecWritePath(this.cwd, path.relative(this.cwd, proof).replaceAll("\\", "/"));
				await assertSpecWritePath(this.cwd, path.relative(this.cwd, expected).replaceAll("\\", "/"));
				await fs.mkdir(directory, { recursive: true });
				await this.repo.readTree(parent, proof, signal);
				for (const change of proven)
					await this.repo.applyPatch(change.patch, { cached: true, indexPath: proof }, signal);
				await this.repo.readTree(sha, expected, signal);
				const audit = await this.repo.diffText(
					{ base: parent, head: sha, files: [recordPath(requirementId)], binary: true },
					signal,
				);
				if (audit) await this.repo.applyPatch(audit, { cached: true, indexPath: expected, reverse: true }, signal);
				if ((await this.repo.writeTree(proof, signal)) !== (await this.repo.writeTree(expected, signal)))
					throw new Error("Merge operation lacks exact complete non-audit patch provenance");
			}
			try {
				const receipt = await this.#readJson<Receipt>(
					path.join(this.#directory(operation.operationId), "receipt.json"),
				);
				const consumed = new Set(receipt.state.ownedChangeIds);
				changes = changes.filter(change => change.layer === "committed" || !consumed.has(change.id));
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			const endpoints = (await this.repo.changedFiles({ base: parent, head: sha }, signal)).filter(
				file => file !== recordPath(requirementId),
			);
			changes = changes.filter(change => change.layer !== "committed" || change.commitSha !== sha);
			if (!endpoints.length) continue;
			const patch = await this.repo.diffText({ base: parent, head: sha, files: endpoints, binary: true }, signal);
			const paths = [...new Set([...endpoints, ...patchPaths(patch)])];
			if (paths.includes(recordPath(requirementId)))
				throw new Error("Audit record cannot share a rename patch with owned content");
			const file = paths[0];
			const version = async (ref: string): Promise<string | null> => {
				if (!(await this.repo.lsTree(ref, [file], signal)).includes(file)) return null;
				const blob = await this.repo.showBlob(`${ref}:${file}`, undefined, signal);
				if (blob.truncated) throw new Error(`Owned commit blob truncated: ${file}`);
				return artifactVersion(blob.data);
			};
			changes.push({
				id: `${operation.operationId}:commit`,
				path: file,
				paths,
				layer: "committed",
				beforeVersion: await version(parent),
				afterVersion: await version(sha),
				patch,
				committedShas: [sha],
				baselineIndexVersion: "",
				parentSha: parent,
				commitSha: sha,
			});
		}
		return changes;
	}
}
