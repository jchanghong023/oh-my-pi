import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import { artifactVersion, assertSpecWritePath, containedSpecPath } from "./artifacts";
import { DevForgeService, devRepositoryIdentity } from "./forge";
import type { DevGitService, DevOwnedChange } from "./git";
import { readDevRequirement, resolveDevOperationCommit, saveDevRequirement } from "./records";
import type {
	DevActionBinding,
	DevActionResult,
	DevCancelPlan,
	DevDecision,
	DevGitTarget,
	DevPrFact,
	DevPrRef,
	DevRequirementRecord,
	DevRequirementSnapshot,
	DevStoredRequirement,
} from "./types";

type CancellationRepository = Pick<
	VcsGitRepo,
	| "headSha"
	| "currentBranch"
	| "commitDetails"
	| "mergeBase"
	| "diffText"
	| "diffTree"
	| "changedFiles"
	| "readTree"
	| "writeTree"
	| "stageFilesIntoIndex"
	| "applyPatch"
	| "canApplyPatch"
	| "applyOwnedPatch"
	| "previewOwnedPatch"
>;
type CancellationGit = Pick<
	DevGitService,
	| "getOwnedChanges"
	| "getOwnershipConflicts"
	| "previewCancellation"
	| "executeDevGitOperation"
	| "resumeDevGitOperation"
	| "finalizeDevCancellation"
>;
export interface DevCancellationOptions {
	cwd: string;
	repo: CancellationRepository;
	git: CancellationGit;
	stop: (requirementId: string) => Promise<void>;
	snapshot: (requirementId: string) => Promise<DevRequirementSnapshot>;
	records?: {
		read: (requirementId: string) => Promise<DevStoredRequirement>;
		save: (record: DevRequirementRecord, expectedRecordVersion: string | null) => Promise<DevStoredRequirement>;
	};
	forge?: {
		observe: (pr: DevPrRef, signal: AbortSignal) => Promise<DevPrFact>;
		close: (pr: DevPrRef, signal: AbortSignal) => Promise<DevPrFact>;
	};
}
interface CancellationStep {
	id: string;
	patch: string;
	expected: Array<{ path: string; beforeVersion: string | null; afterVersion: string | null }>;
	complete: boolean;
	results: Array<{ path: string; status: "applied" | "unchanged" | "failed"; actualVersion: string | null }>;
}
interface CancellationJournal {
	version: 1;
	plan: DevCancelPlan;
	steps: CancellationStep[];
	started: boolean;
	settled: boolean;
	publicationStarted: boolean;
	complete: boolean;
	error: string | null;
	lastObservedPr: DevPrFact | null;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function auditPath(record: DevRequirementRecord): string {
	return `docs/dev-requirements/${record.requirementId}.json`;
}
function ownedPaths(change: DevOwnedChange): string[] {
	return change.paths?.length ? change.paths : [change.path];
}
function equalPlan(left: DevCancelPlan, right: DevCancelPlan): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Cancellation owns its durable progress, never the native runtime or the real Git index. */
export class DevCancellationService {
	readonly #options: DevCancellationOptions;
	readonly #forge: NonNullable<DevCancellationOptions["forge"]>;
	readonly #inFlight = new Map<string, Promise<DevActionResult>>();

	constructor(options: DevCancellationOptions) {
		this.#options = options;
		const forge = new DevForgeService({ cwd: options.cwd });
		this.#forge = options.forge ?? {
			observe: (pr, signal) => forge.observeDevPr(pr, signal),
			close: (pr, signal) => forge.closeDevPr(pr, signal),
		};
	}

	async #read(requirementId: string): Promise<DevStoredRequirement> {
		return this.#options.records
			? this.#options.records.read(requirementId)
			: readDevRequirement(this.#options.cwd, requirementId);
	}

	async #save(record: DevRequirementRecord, version: string): Promise<DevStoredRequirement> {
		return this.#options.records
			? this.#options.records.save(record, version)
			: saveDevRequirement(this.#options.cwd, record, version);
	}

	async #journalPath(operationId: string): Promise<string> {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId))
			throw new Error("Invalid cancellation operation identity");
		const relative = `.omp/dev-workbench/cancellations/${operationId}.json`;
		await assertSpecWritePath(this.#options.cwd, relative);
		return containedSpecPath(this.#options.cwd, relative);
	}

	async #writeJournal(journal: CancellationJournal): Promise<void> {
		const file = await this.#journalPath(journal.plan.preview.binding.operationId);
		await fs.mkdir(path.dirname(file), { recursive: true });
		const temporary = `${file}.${crypto.randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify(journal), { flag: "wx", mode: 0o600 });
			await fs.rename(temporary, file);
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}

	async #readJournal(operationId: string): Promise<CancellationJournal> {
		const journal: CancellationJournal = JSON.parse(await fs.readFile(await this.#journalPath(operationId), "utf8"));
		if (
			journal.version !== 1 ||
			journal.plan.preview.binding.operationId !== operationId ||
			!Array.isArray(journal.steps)
		) {
			throw new Error("Invalid cancellation recovery journal");
		}
		return journal;
	}

	async #confirmedPrHead(
		record: DevRequirementRecord,
		target: DevGitTarget,
		headSha: string,
		signal: AbortSignal,
	): Promise<boolean> {
		if (!record.pr) return false;
		const ref = (value: string) => value.replace(/^refs\/heads\//, "");
		const confirmed = new Set<string>();
		for (const operation of record.gitOperations) {
			signal.throwIfAborted();
			if (
				operation.kind === "cancel" ||
				!record.decisions.some(decision => decision.operationId === operation.operationId) ||
				devRepositoryIdentity(operation.target.sourceRepository) !==
					devRepositoryIdentity(target.sourceRepository) ||
				devRepositoryIdentity(operation.target.baseRepository) !== devRepositoryIdentity(target.baseRepository) ||
				ref(operation.target.sourceRef) !== ref(record.pr.pr.sourceRef) ||
				ref(operation.target.baseRef) !== ref(record.pr.pr.baseRef)
			)
				continue;
			const sha = await resolveDevOperationCommit(this.#options.cwd, record.requirementId, operation.operationId);
			if (sha) confirmed.add(sha);
		}
		// Every intervening commit needs its own confirmed operation and actual record-blob proof.
		// An arbitrary descendant of the previously observed PR head is not ownership evidence.
		let current = headSha;
		while (current !== record.pr.headSha) {
			signal.throwIfAborted();
			if (!confirmed.delete(current)) return false;
			const details = await this.#options.repo.commitDetails(current, signal);
			if (details.parents.length !== 1) return false;
			current = details.parents[0];
		}
		return true;
	}

	async #pr(
		pr: DevPrFact | null,
		signal: AbortSignal,
		requireClosed = false,
		allowPublishedHead = false,
		observed?: (fact: DevPrFact) => Promise<void>,
		publishedSha?: string | null,
		confirmPublishedHead?: (headSha: string) => Promise<boolean>,
	): Promise<DevPrFact | null> {
		if (!pr) return null;
		const actual = await this.#forge.observe(pr.pr, signal);
		await observed?.(actual);
		if (actual.state === "merged" || actual.mergeSha)
			throw new Error("PR has merged; cancellation is forbidden. Create a linked fix requirement instead.");
		const ref = (value: string) => value.replace(/^refs\/heads\//, "");
		if (
			actual.pr.forge !== pr.pr.forge ||
			actual.pr.number !== pr.pr.number ||
			devRepositoryIdentity(actual.pr.repository) !== devRepositoryIdentity(pr.pr.repository) ||
			ref(actual.pr.sourceRef) !== ref(pr.pr.sourceRef) ||
			ref(actual.pr.baseRef) !== ref(pr.pr.baseRef)
		) {
			throw new Error("PR source/head/base changed after cancellation preview");
		}
		if (
			actual.headSha !== pr.headSha &&
			(!allowPublishedHead || (publishedSha !== undefined && actual.headSha !== publishedSha)) &&
			!(await confirmPublishedHead?.(actual.headSha))
		)
			throw new Error("PR source/head/base changed after cancellation preview");
		if (requireClosed && actual.state !== "closed")
			throw new Error("PR is open or reopened; cancellation remains unsettled");
		return actual;
	}

	async #version(relative: string): Promise<string | null> {
		const file = await containedSpecPath(this.#options.cwd, relative);
		try {
			return artifactVersion(await fs.readFile(file));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			throw error;
		}
	}

	async #orderedChanges(
		changes: DevOwnedChange[],
		conflicts: DevCancelPlan["conflicts"],
		signal: AbortSignal,
	): Promise<DevOwnedChange[]> {
		const committed = new Map<string, DevOwnedChange[]>();
		const dirty: DevOwnedChange[] = [];
		for (const change of changes) {
			if (change.layer !== "committed") {
				dirty.push(change);
				continue;
			}
			if (!change.commitSha) {
				conflicts.push({ path: change.path, reason: "Committed patch has no proven commit identity" });
				continue;
			}
			const group = committed.get(change.commitSha) ?? [];
			group.push(change);
			committed.set(change.commitSha, group);
		}
		const shas = [...committed.keys()];
		const predecessors = new Map<string, Set<string>>();
		for (const sha of shas) {
			const details = await this.#options.repo.commitDetails(sha, signal);
			const group = committed.get(sha)!;
			for (const change of group) {
				if (!change.parentSha || !details.parents.includes(change.parentSha)) {
					conflicts.push({
						path: change.path,
						reason: `Commit ${sha} lacks a proven parent/mainline for its owned patch`,
					});
				}
			}
			const ancestors = new Set<string>();
			for (const other of shas) {
				if (other !== sha && (await this.#options.repo.mergeBase(other, sha, signal)) === other)
					ancestors.add(other);
			}
			predecessors.set(sha, ancestors);
		}
		const ordered: DevOwnedChange[] = [];
		// Captures are appended in mutation order. Index layers describe location, not chronology.
		ordered.push(...dirty.reverse());
		while (committed.size) {
			const leaves = [...committed.keys()].filter(
				sha => ![...committed.keys()].some(other => predecessors.get(other)?.has(sha)),
			);
			if (!leaves.length) throw new Error("Owned commit ancestry is cyclic or unavailable");
			for (const sha of leaves) {
				ordered.push(...committed.get(sha)!.slice().reverse());
				committed.delete(sha);
			}
		}
		return ordered;
	}

	async planDevCancellation(
		record: DevRequirementRecord,
		binding: DevActionBinding,
		target: DevGitTarget,
		signal: AbortSignal,
	): Promise<DevCancelPlan> {
		signal.throwIfAborted();
		try {
			const existing = await this.#readJournal(binding.operationId);
			if (
				existing.plan.preview.binding.requirementId !== record.requirementId ||
				JSON.stringify(existing.plan.preview.binding) !== JSON.stringify(binding) ||
				JSON.stringify(existing.plan.preview.target) !== JSON.stringify(target)
			) {
				throw new Error("Cancellation operation identity is already bound to a different scope");
			}
			return structuredClone(existing.plan);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		if (
			record.lifecycle === "completed" ||
			record.lifecycle === "cancelled" ||
			record.pr?.state === "merged" ||
			record.marks["pr-merged"]
		) {
			throw new Error("Merged/completed/cancelled requirements cannot be deleted");
		}
		const stored = await this.#read(record.requirementId);
		if (
			stored.recordVersion !== binding.expectedRecordVersion ||
			binding.requirementId !== record.requirementId ||
			binding.expectedStage !== stored.record.stage
		) {
			throw new Error("Cancellation preview record is stale");
		}
		record = stored.record;
		if (record.lifecycle !== "active")
			throw new Error(
				"Requirement is not active; resume its original cancellation operation if it is still unsettled",
			);
		if ((await this.#options.repo.currentBranch(signal)) !== record.branch)
			throw new Error("Cancellation requires the original existing branch");
		const pr = await this.#pr(stored.record.pr, signal, false, false, undefined, undefined, headSha =>
			this.#confirmedPrHead(stored.record, target, headSha, signal),
		);
		const head = await this.#options.repo.headSha(signal);
		if (!head) throw new Error("Cancellation requires an existing HEAD");
		const conflicts: DevCancelPlan["conflicts"] = [];
		conflicts.push(...(await this.#options.git.getOwnershipConflicts(record.requirementId, signal)));
		let changes: DevOwnedChange[];
		try {
			const recovered = await this.#options.git.getOwnedChanges(record.requirementId, signal);
			for (const change of recovered) {
				if (ownedPaths(change).includes(auditPath(record))) {
					for (const file of ownedPaths(change).filter(file => file !== auditPath(record))) {
						conflicts.push({
							path: file,
							reason: "Owned patch is mixed with the audit record and requires an exact native non-record scope",
						});
					}
				}
				if (change.layer !== "committed" && ownedPaths(change).length > 1)
					conflicts.push({
						path: change.path,
						reason:
							"Dirty multi-path patch lacks individual baseline versions; exact per-path ownership is required",
					});
			}
			changes = recovered.filter(change => !ownedPaths(change).includes(auditPath(record)));
		} catch (error) {
			changes = [];
			conflicts.push({ path: record.requirementId, reason: `Ownership recovery failed: ${errorText(error)}` });
		}
		const ordered = await this.#orderedChanges(changes, conflicts, signal);
		const committedShas = [...new Set(changes.flatMap(change => change.committedShas))];
		for (const operation of record.gitOperations.filter(operation => operation.kind !== "cancel")) {
			const resolved = await resolveDevOperationCommit(
				this.#options.cwd,
				record.requirementId,
				operation.operationId,
			);
			for (const sha of [...operation.knownCommitShas, ...(resolved ? [resolved] : [])]) {
				if (!committedShas.includes(sha)) committedShas.push(sha);
				const details = await this.#options.repo.commitDetails(sha, signal);
				const parent =
					details.parents.length === 1
						? details.parents[0]
						: changes.find(change => change.commitSha === sha)?.parentSha;
				if (!parent) {
					conflicts.push({ path: sha, reason: "Commit has no proven compensation parent/mainline" });
					continue;
				}
				const touched = await this.#options.repo.changedFiles({ base: parent, head: sha, binary: true }, signal);
				for (const file of touched) {
					if (
						file !== auditPath(record) &&
						!changes.some(change => ownedPaths(change).includes(file) && change.commitSha === sha)
					) {
						conflicts.push({
							path: file,
							reason: `Owned commit ${sha} has no exact recoverable patch for this path`,
						});
					}
				}
			}
		}
		const required = new Set([
			...record.materials.map(material => material.path),
			...record.syncRevisions.flatMap(revision => [
				...revision.files.map(file => file.path),
				...revision.mainSpecs.map(file => file.path),
			]),
		]);
		for (const file of required) {
			if (!changes.some(change => ownedPaths(change).includes(file)))
				conflicts.push({
					path: file,
					reason: "No exact owned patch/baseline; existing or external content will not be deleted",
				});
		}
		const paths = [...new Set([...changes.flatMap(ownedPaths), ...required])].filter(
			file => file !== auditPath(record),
		);
		for (const file of paths) await assertSpecWritePath(this.#options.cwd, file);
		const directory = await containedSpecPath(this.#options.cwd, ".omp/dev-workbench/cancellation-indexes");
		await assertSpecWritePath(this.#options.cwd, ".omp/dev-workbench/cancellation-indexes");
		await fs.mkdir(directory, { recursive: true });
		const temporary = await fs.mkdtemp(path.join(directory, "preview-"));
		const index = path.join(temporary, "index");
		const commitIndex = path.join(temporary, "commit-index");
		const stagedIndex = path.join(temporary, "staged-index");
		const steps: CancellationStep[] = [];
		let patch = "";
		let stagedPatch = "";
		try {
			await this.#options.repo.readTree(head, index, signal);
			await this.#options.repo.readTree(head, commitIndex, signal);
			await this.#options.repo.readTree(head, stagedIndex, signal);
			const staged = await this.#options.repo.diffText({ cached: true, binary: true }, signal);
			if (staged) await this.#options.repo.applyPatch(staged, { cached: true, indexPath: stagedIndex }, signal);
			const originalStagedTree = await this.#options.repo.writeTree(stagedIndex, signal);
			for (const change of changes) {
				if (
					(change.layer === "unstaged" || change.layer === "untracked") &&
					change.patch &&
					(await this.#options.repo.canApplyPatch(
						change.patch,
						{ reverse: true, cached: true, indexPath: stagedIndex },
						signal,
					))
				) {
					conflicts.push({
						path: change.path,
						reason:
							"Owned unstaged/untracked patch is now staged; its index ownership must be explicitly reconfirmed",
					});
				}
			}
			for (const change of ordered) {
				try {
					if (change.layer === "committed")
						await this.#options.repo.applyPatch(
							change.patch,
							{ reverse: true, cached: true, indexPath: commitIndex },
							signal,
						);
					if (change.layer === "committed" || change.layer === "staged")
						await this.#options.repo.applyPatch(
							change.patch,
							{ reverse: true, cached: true, indexPath: stagedIndex },
							signal,
						);
				} catch (error) {
					conflicts.push({ path: change.path, reason: `Compensation commit/index conflict: ${errorText(error)}` });
				}
			}
			patch = await this.#options.repo.diffTree(
				head,
				await this.#options.repo.writeTree(commitIndex, signal),
				true,
				signal,
			);
			stagedPatch = await this.#options.repo.diffTree(
				originalStagedTree,
				await this.#options.repo.writeTree(stagedIndex, signal),
				true,
				signal,
			);
			// Snapshot only confirmed paths through native clean filters; the real index remains untouched.
			await this.#options.repo.stageFilesIntoIndex(paths, index, signal);
			const terminalDirty = new Map<string, DevOwnedChange>();
			for (const change of changes) {
				if (change.layer !== "committed") for (const file of ownedPaths(change)) terminalDirty.set(file, change);
			}
			for (const change of changes.filter(item => item.layer === "untracked")) {
				const terminal = terminalDirty.get(change.path)!;
				if ((await this.#version(change.path)) !== terminal.afterVersion || change.beforeVersion !== null) {
					conflicts.push({
						path: change.path,
						reason: "Untracked content no longer matches its terminal owned postimage",
					});
				}
			}
			const initialDirtyTree = await this.#options.repo.writeTree(index, signal);
			for (const change of ordered) {
				if (!change.patch || (change.layer !== "committed" && !change.baselineIndexVersion)) {
					conflicts.push({ path: change.path, reason: "Owned patch or original index baseline is unavailable" });
					continue;
				}
				const beforeTree = await this.#options.repo.writeTree(index, signal);
				try {
					await this.#options.repo.applyPatch(
						change.patch,
						{ reverse: true, cached: true, indexPath: index },
						signal,
					);
					const afterTree = await this.#options.repo.writeTree(index, signal);
					const changedPaths = [
						...new Set([
							...(await this.#options.repo.changedFiles(
								{ base: beforeTree, head: afterTree, binary: true },
								signal,
							)),
							...(await this.#options.repo.changedFiles(
								{ base: afterTree, head: beforeTree, binary: true },
								signal,
							)),
						]),
					];
					if (changedPaths.some(file => !paths.includes(file)))
						throw new Error("Owned patch touches an undeclared path (including rename endpoint)");
				} catch (error) {
					conflicts.push({ path: change.path, reason: errorText(error) });
					// This alternate index is private; restoring it never touches the real index/worktree.
					await this.#options.repo.readTree(beforeTree, index, signal);
				}
			}
			const inverse = await this.#options.repo.diffTree(
				initialDirtyTree,
				await this.#options.repo.writeTree(index, signal),
				true,
				signal,
			);
			if (inverse) {
				try {
					const { expected } = await this.#options.repo.previewOwnedPatch(inverse, { reverse: false }, signal);
					if (expected.some(file => !paths.includes(file.path)))
						throw new Error("Native raw preview exceeds declared cancellation paths");
					for (const file of expected) {
						if ((await this.#version(file.path)) !== file.beforeVersion)
							throw new Error(`Working bytes changed during cancellation preview: ${file.path}`);
					}
					steps.push({ id: binding.operationId, patch: inverse, expected, complete: false, results: [] });
				} catch (error) {
					conflicts.push({
						path: record.requirementId,
						reason: `Native cancellation preview failed: ${errorText(error)}`,
					});
				}
			}
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
		const files = [];
		for (const file of paths) {
			const version = await this.#version(file);
			if (version !== null) files.push({ path: file, version });
		}
		const cancellation = {
			committedShas,
			changes: changes.map(change => ({
				id: change.id,
				path: change.path,
				paths: ownedPaths(change),
				layer: change.layer,
				patch: change.patch,
				beforeVersion: change.beforeVersion,
				afterVersion: change.afterVersion,
				commitSha: change.commitSha,
				parentSha: change.parentSha,
			})),
			materials: record.materials.map(material => material.path),
			mainSpecs: [
				...new Set([
					...record.syncRevisions.flatMap(revision => revision.mainSpecs.map(file => file.path)),
					...paths.filter(file => file.startsWith("openspec/specs/")),
				]),
			],
			archivePaths: [
				...new Set([
					...record.syncRevisions.flatMap(revision =>
						revision.archivedChangePath ? [revision.archivedChangePath] : [],
					),
					...paths.filter(file => file.startsWith("openspec/changes/archive/")),
				]),
			],
			conflicts,
		};
		const preview = await this.#options.git.previewCancellation(
			stored.record,
			{ binding, target, files, paths, patch, stagedPatch, cancellation },
			signal,
		);
		const plan: DevCancelPlan = { preview, committedShas, paths, conflicts, pr };
		await this.#writeJournal({
			version: 1,
			plan,
			steps,
			started: false,
			settled: false,
			publicationStarted: false,
			complete: false,
			error: null,
			lastObservedPr: pr,
		});
		return structuredClone(plan);
	}

	executeDevCancellation(plan: DevCancelPlan, decision: DevDecision, signal: AbortSignal): Promise<DevActionResult> {
		const operationId = plan.preview.binding.operationId;
		const pending = this.#inFlight.get(operationId);
		if (pending) return pending;
		const operation = this.#execute(plan, decision, signal).finally(() => this.#inFlight.delete(operationId));
		this.#inFlight.set(operationId, operation);
		return operation;
	}

	async #execute(plan: DevCancelPlan, decision: DevDecision, signal: AbortSignal): Promise<DevActionResult> {
		const binding = plan.preview.binding;
		const journal = await this.#readJournal(binding.operationId);
		if (
			!equalPlan(journal.plan, plan) ||
			decision.operationId !== binding.operationId ||
			decision.stage !== binding.expectedStage ||
			JSON.stringify(decision.files) !== JSON.stringify(binding.files) ||
			!decision.userReply.trim()
		) {
			throw new Error("Cancellation confirmation does not match its host-owned preview");
		}
		if (plan.conflicts.length)
			throw new Error(
				`Cancellation has unresolved conflicts: ${plan.conflicts.map(item => `${item.path}: ${item.reason}`).join("; ")}`,
			);
		let publication: DevActionResult | null = null;
		const checkPr = (requireClosed = false, allowPublishedHead = journal.publicationStarted) =>
			this.#pr(
				plan.pr,
				signal,
				requireClosed,
				allowPublishedHead,
				async actual => {
					journal.lastObservedPr = actual;
					await this.#writeJournal(journal);
				},
				publication?.persistence.commit.sha,
			);
		try {
			signal.throwIfAborted();
			let stored = await this.#read(binding.requirementId);
			if (journal.complete)
				return this.#options.git.resumeDevGitOperation(binding.requirementId, binding.operationId, signal);
			const alreadyStarted =
				stored.record.lifecycle === "cancelling" &&
				stored.record.decisions.some(item => item.operationId === binding.operationId);
			if (!journal.started && !alreadyStarted) {
				if (stored.recordVersion !== binding.expectedRecordVersion || stored.record.lifecycle !== "active")
					throw new Error("Cancellation confirmation is stale");
				if ((await this.#options.repo.headSha(signal)) !== plan.preview.headSha)
					throw new Error("Cancellation HEAD changed after preview");
				for (const file of plan.preview.files)
					if ((await this.#version(file.path)) !== file.version)
						throw new Error(`Cancellation file changed: ${file.path}`);
				await checkPr();
				stored = await this.#save(
					{ ...stored.record, lifecycle: "cancelling", decisions: [...stored.record.decisions, decision] },
					stored.recordVersion,
				);
			} else if (!alreadyStarted && !(journal.publicationStarted && stored.record.lifecycle === "cancelled")) {
				throw new Error("Requirement no longer belongs to this cancellation");
			}
			journal.started = true;
			await this.#writeJournal(journal);
			if (!journal.settled) {
				await this.#options.stop(binding.requirementId);
				journal.settled = true;
				await this.#writeJournal(journal);
			}
			let pr = await checkPr();
			if (pr?.state === "open") {
				try {
					await this.#forge.close(pr.pr, signal);
				} catch (error) {
					// A lost close response is not a failed close, nor proof of success.
					pr = await checkPr(true);
					if (!pr) throw error;
				}
			}
			const closedPr = await checkPr(true);
			if (closedPr && !journal.publicationStarted) {
				const current = await this.#read(binding.requirementId);
				await this.#save({ ...current.record, pr: closedPr }, current.recordVersion);
			}
			for (const step of journal.steps) {
				if (step.complete) continue;
				signal.throwIfAborted();
				await checkPr(true, false);
				if ((await this.#options.repo.headSha(signal)) !== plan.preview.headSha)
					throw new Error("HEAD changed before a destructive cancellation batch");
				for (const file of step.expected) await assertSpecWritePath(this.#options.cwd, file.path);
				const applied = await this.#options.repo.applyOwnedPatch(
					step.patch,
					{ reverse: false, expected: step.expected },
					signal,
				);
				step.complete = applied.complete;
				step.results = applied.paths;
				journal.error = applied.complete
					? null
					: (applied.diagnostic ??
						applied.paths
							.filter(file => file.status === "failed")
							.map(file => file.path)
							.join(", "));
				await this.#writeJournal(journal);
				if (!applied.complete)
					throw new Error(`Cancellation partially applied; remaining paths require resolution: ${journal.error}`);
			}
			const finalVersions = new Map<string, string | null>();
			for (const step of journal.steps)
				for (const file of step.expected) finalVersions.set(file.path, file.afterVersion);
			if (!journal.publicationStarted) {
				for (const [file, version] of finalVersions) {
					if ((await this.#version(file)) !== version)
						throw new Error(`Cancellation output changed before publication: ${file}`);
				}
			}
			await checkPr(true);
			const resuming = journal.publicationStarted;
			journal.publicationStarted = true;
			await this.#writeJournal(journal);
			let result: DevActionResult;
			if (resuming) {
				try {
					result = await this.#options.git.resumeDevGitOperation(
						binding.requirementId,
						binding.operationId,
						signal,
					);
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
					result = await this.#options.git.executeDevGitOperation(plan.preview, decision, signal);
				}
			} else result = await this.#options.git.executeDevGitOperation(plan.preview, decision, signal);
			publication = result;
			await checkPr(true, true);
			if (
				result.persistence.commit.status === "succeeded" &&
				result.persistence.commit.indexReconciled &&
				result.persistence.push.status === "succeeded"
			) {
				result = await this.#options.git.finalizeDevCancellation(
					binding.requirementId,
					binding.operationId,
					signal,
				);
				publication = result;
			}
			journal.complete =
				result.persistence.save === "succeeded" &&
				result.persistence.commit.status === "succeeded" &&
				result.persistence.commit.indexReconciled &&
				result.persistence.push.status === "succeeded" &&
				result.snapshot.record.lifecycle === "cancelled";
			journal.error = result.persistence.error ?? null;
			await this.#writeJournal(journal);
			return result;
		} catch (error) {
			journal.error = errorText(error);
			await this.#writeJournal(journal);
			return {
				snapshot: await this.#options.snapshot(binding.requirementId),
				persistence: publication
					? { ...publication.persistence, error: journal.error }
					: {
							save: journal.started ? "succeeded" : "not-started",
							commit: {
								status: journal.publicationStarted ? "unknown" : "not-started",
								sha: null,
								indexReconciled: false,
							},
							push: {
								status: journal.publicationStarted ? "unknown" : "not-started",
								target: journal.publicationStarted ? plan.preview.target : null,
							},
							error: journal.error,
						},
			};
		}
	}
}
