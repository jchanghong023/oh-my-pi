import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import {
	artifactVersion,
	assertSpecWritePath,
	containedSpecPath,
	resolveSpecChangeDirectory,
	SpecArtifactStore,
} from "./artifacts";
import { runOpenSpecDirectory, type SpecDrivenProcessResult } from "./resources";
import type { DevSyncRevision, SpecCloseProgress, SpecFileVersion } from "./types";

interface NativeTarget {
	path: string;
	version: string | null;
}
interface NativeSyncResult {
	archivedChangePath: string | null;
	targets: NativeTarget[];
	progress: SpecCloseProgress;
}
interface NativeSyncFailure {
	message: string;
	progress: SpecCloseProgress;
	targets: NativeTarget[];
}
interface NativeSyncReceipt {
	binding: string;
	state: "started" | "completed" | "failed";
	result?: NativeSyncResult;
	failure?: NativeSyncFailure;
	input?: { expectedTargets: NativeTarget[]; expectedSources: SpecFileVersion[] };
}
interface NativeSyncPlan {
	changeDir: string;
	archivePath: string | null;
	sourceTreeVersion: string;
	paths: string[];
}
interface NativeOwnershipReceipt {
	binding: string;
	progress: SpecCloseProgress;
}

export interface SyncDevRequirementInput {
	cwd: string;
	changeId: string;
	changeDirectory: string;
	acceptedVersions: readonly SpecFileVersion[];
	previous: DevSyncRevision | null;
	operationId: string;
	onProgress: (progress: SpecCloseProgress) => Promise<void>;
	onBeforeWrite?: (paths: readonly string[]) => Promise<string>;
	onAfterWrite?: (captureId: string) => Promise<void>;
}

async function fingerprint(cwd: string, file: string): Promise<string | null> {
	try {
		return artifactVersion(await fs.readFile(await containedSpecPath(cwd, file)));
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function settleCleanup(cwd: string, progress: SpecCloseProgress): Promise<SpecCloseProgress> {
	if (progress.sideEffects) {
		const { expectedVersions, diagnostic } = progress.sideEffects;
		if (!expectedVersions?.length) throw new Error(diagnostic);
		for (const file of expectedVersions)
			if ((await fingerprint(cwd, file.path)) !== file.version) throw new Error(diagnostic);
	}
	for (const file of [
		...(progress.retirementCleanup?.paths ?? []),
		...(progress.archiveCleanup ? [progress.archiveCleanup.path] : []),
	]) {
		try {
			await fs.lstat(await containedSpecPath(cwd, file));
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		throw new Error(`Native sync recovery still requires explicit cleanup: ${file}`);
	}
	if (progress.retirementCleanup && !progress.retirementCleanup.paths.length)
		throw new Error(progress.retirementCleanup.diagnostic);
	const settled = { ...progress };
	delete settled.retirementCleanup;
	delete settled.archiveCleanup;
	delete settled.sideEffects;
	return settled;
}

/** Apply exactly one host-confirmed revision through native validation and the native archive transaction. */
export async function syncDevRequirement(
	input: SyncDevRequirementInput,
	signal: AbortSignal,
): Promise<DevSyncRevision> {
	signal.throwIfAborted();
	if (!input.operationId || input.operationId.includes("\0")) throw new Error("Invalid sync operation ID");
	const cwd = await fs.realpath(input.cwd);
	let sameOperation = input.previous?.operationId === input.operationId ? input.previous : null;
	if (sameOperation && JSON.stringify(sameOperation.files) !== JSON.stringify(input.acceptedVersions))
		throw new Error("Sync operation is bound to different accepted material versions");
	// This host journal is independent of the native receipt: native completion does not
	// imply that ownership was recorded, and retries must retain the original preimage.
	const ownershipBinding = artifactVersion(JSON.stringify([cwd, input.changeId, input.acceptedVersions]));
	const ownershipRelative = `.omp/dev-workbench/sync/${artifactVersion(input.operationId)}.ownership.json`;
	const ownershipPath = await containedSpecPath(cwd, ownershipRelative);
	let ownedReceipt: NativeOwnershipReceipt | undefined;
	try {
		ownedReceipt = JSON.parse(await fs.readFile(ownershipPath, "utf8")) as NativeOwnershipReceipt;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (ownedReceipt && ownedReceipt.binding !== ownershipBinding)
		throw new Error("Sync ownership receipt belongs to different confirmed materials");
	if (ownedReceipt) {
		const progress = ownedReceipt.progress;
		sameOperation = {
			operationId: input.operationId,
			files: input.acceptedVersions.map(file => ({ ...file })),
			mainSpecs: progress.targetVersions ?? [],
			archivedChangePath: progress.archivedChangePath ?? null,
			progress,
		};
	}
	let ownership = sameOperation?.progress.ownership;
	const resumingCapture = !!ownership;
	let ownershipProgress = sameOperation?.progress;
	const saveOwnership = async (progress: SpecCloseProgress) => {
		if (!ownership) return;
		progress.ownership = ownership;
		ownershipProgress = progress;
		await assertSpecWritePath(cwd, ownershipRelative);
		await assertSpecWritePath(cwd, `${ownershipRelative}.tmp`);
		await fs.mkdir(path.dirname(ownershipPath), { recursive: true });
		await fs.writeFile(`${ownershipPath}.tmp`, JSON.stringify({ binding: ownershipBinding, progress }));
		await fs.rename(`${ownershipPath}.tmp`, ownershipPath);
	};
	const settleOwnership = async (progress = ownershipProgress ?? {}) => {
		if (!ownership) return;
		await saveOwnership(progress);
		if (ownership.state === "pending") {
			if (!input.onAfterWrite) throw new Error("Owned native sync recovery requires its settlement callback");
			await input.onAfterWrite(ownership.captureId);
			ownership.state = "settled";
		}
		await saveOwnership(progress);
		await input.onProgress(progress);
	};
	if (resumingCapture) await settleOwnership();
	if (
		input.previous?.progress.sideEffects ||
		input.previous?.progress.retirementCleanup ||
		input.previous?.progress.archiveCleanup
	) {
		const settled = await settleCleanup(cwd, input.previous.progress);
		await input.onProgress(settled);
		if (sameOperation && input.previous.progress.sideEffects)
			throw new Error("Native rollback was restored; a new explicit sync operation is required");
	}
	if (sameOperation?.progress.synced) {
		const progress = await settleCleanup(cwd, sameOperation.progress);
		await settleOwnership(progress);
		return { ...sameOperation, progress };
	}
	const recordedArchive = input.previous?.archivedChangePath ?? input.previous?.progress.archivedChangePath;
	const directory = await resolveSpecChangeDirectory(cwd, input.changeId, recordedArchive ?? undefined);
	const requested = path.relative(cwd, path.resolve(cwd, input.changeDirectory)).replaceAll(path.sep, "/");
	const active = `openspec/changes/${input.changeId}`;
	const recoveringArchive = requested === active && directory !== active && !recordedArchive;
	if (requested !== directory && !recoveringArchive)
		throw new Error(`Confirmed change directory is not its actual owned location: ${input.changeDirectory}`);
	const store = new SpecArtifactStore({
		cwd,
		changeId: input.changeId,
		archivedChangePath: directory === active ? undefined : directory,
	});
	const check = await store.checkVersions(input.acceptedVersions, directory === active ? undefined : directory);
	if (!check.matches) throw new Error(check.changed.map(item => item.reason).join("\n"));
	const accepted = input.acceptedVersions.map(file => ({
		...file,
		path: file.path.startsWith(`${active}/`) ? `${directory}/${file.path.slice(active.length + 1)}` : file.path,
	}));
	const deltaPrefix = `${directory}/specs/`;
	const targets = [
		...new Set(
			accepted
				.filter(file => file.path.startsWith(deltaPrefix) && file.path.endsWith("/spec.md"))
				.map(file => `openspec/specs/${file.path.slice(deltaPrefix.length)}`),
		),
	];
	for (const file of targets) await assertSpecWritePath(cwd, file);
	const currentTargets = () =>
		Promise.all(targets.map(async file => ({ path: file, version: await fingerprint(cwd, file) })));
	const initialTargets = await currentTargets();
	const publishProgress = async (progress: SpecCloseProgress) => {
		const versions: NativeTarget[] = [];
		const unreadable: string[] = [];
		for (const file of targets) {
			try {
				versions.push({ path: file, version: await fingerprint(cwd, file) });
			} catch {
				unreadable.push(file);
			}
		}
		if (unreadable.length)
			progress.sideEffects = {
				paths: [...new Set([...(progress.sideEffects?.paths ?? []), ...unreadable])],
				diagnostic:
					progress.sideEffects?.diagnostic ??
					"Native sync target versions could not be read; recovery is required",
				expectedVersions:
					progress.sideEffects?.expectedVersions ?? (progress.synced ? progress.targetVersions : initialTargets),
			};
		progress.targetVersions = versions;
		await saveOwnership(progress);
		await input.onProgress(progress);
	};
	const revision = async (progress: SpecCloseProgress): Promise<DevSyncRevision> => ({
		operationId: input.operationId,
		files: input.acceptedVersions.map(file => ({ ...file })),
		mainSpecs: await currentTargets(),
		archivedChangePath: progress.archivedChangePath ?? (directory === active ? null : directory),
		progress,
	});
	const beginOwnedWrite = async (archive: boolean, progress: SpecCloseProgress): Promise<NativeSyncPlan | null> => {
		if (resumingCapture || !input.onBeforeWrite) return null;
		if (!input.onAfterWrite) throw new Error("Owned native sync capture requires its settlement callback");
		const planned = await runOpenSpecDirectory(
			"plan-directory",
			{
				changeDir: await containedSpecPath(cwd, directory),
				mainSpecsDir: await containedSpecPath(cwd, "openspec/specs"),
				changeName: input.changeId,
				archive,
			},
			cwd,
			signal,
		);
		if (planned.exitCode !== 0)
			throw new Error(`Cannot plan owned native sync paths: ${planned.stdout}\n${planned.stderr}`);
		const plan = JSON.parse(planned.stdout) as NativeSyncPlan;
		const paths = plan.paths.map(file => path.relative(cwd, file).replaceAll(path.sep, "/"));
		for (const file of paths) await assertSpecWritePath(cwd, file);
		const captureId = await input.onBeforeWrite(paths);
		if (!captureId) throw new Error("Owned native sync capture requires its original capture ID");
		ownership = { captureId, state: "pending" };
		await saveOwnership(progress);
		await input.onProgress(progress);
		return plan;
	};
	if (directory === active || recoveringArchive) {
		const progress = sameOperation ? { ...sameOperation.progress } : {};
		if (resumingCapture && directory === active)
			throw new Error(
				"Owned native sync was interrupted before archive completion; a new explicit sync operation is required",
			);
		const ownedPlan = directory === active ? await beginOwnedWrite(true, progress) : null;
		try {
			await store.close(
				{
					acceptedVersions: input.acceptedVersions,
					progress,
					onProgress: publishProgress,
					archivePlan: ownedPlan ? JSON.stringify(ownedPlan) : undefined,
				},
				signal,
			);
			const result = await revision(progress);
			await publishProgress(result.progress);
			return result;
		} finally {
			if (ownedPlan) await settleOwnership();
		}
	}

	// A durable native receipt disambiguates a completed write from a lost process response.
	const binding = artifactVersion(JSON.stringify([cwd, input.changeId, directory, input.acceptedVersions]));
	const receiptRelative = `.omp/dev-workbench/sync/${artifactVersion(input.operationId)}.json`;
	await assertSpecWritePath(cwd, receiptRelative);
	const receiptPath = await containedSpecPath(cwd, receiptRelative);
	await fs.mkdir(path.dirname(receiptPath), { recursive: true });
	let receipt: NativeSyncReceipt | undefined;
	try {
		receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as NativeSyncReceipt;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (receipt && receipt.binding !== binding)
		throw new Error("Sync operation receipt belongs to different confirmed materials");
	const relativeProgress = (progress: SpecCloseProgress): SpecCloseProgress => {
		const relative = (file: string) => path.relative(cwd, path.resolve(cwd, file)).replaceAll(path.sep, "/");
		return {
			...progress,
			...(ownership ? { ownership } : {}),
			archivedChangePath: directory,
			...(progress.retirementCleanup
				? {
						retirementCleanup: {
							...progress.retirementCleanup,
							paths: progress.retirementCleanup.paths.map(relative),
						},
					}
				: {}),
			...(progress.sideEffects
				? {
						sideEffects: {
							...progress.sideEffects,
							paths: progress.sideEffects.paths.map(relative),
							expectedVersions: progress.sideEffects.expectedVersions?.map(file => ({
								...file,
								path: relative(file.path),
							})),
						},
					}
				: {}),
		};
	};
	const finish = async (result: NativeSyncResult) => {
		const progress = await settleCleanup(cwd, relativeProgress(result.progress));
		if (result.targets.length)
			progress.targetVersions = result.targets.map(file => ({
				path: path.relative(cwd, path.resolve(cwd, file.path)).replaceAll(path.sep, "/"),
				version: file.version,
			}));
		await publishProgress(progress);
		const verified = await store.checkVersions(input.acceptedVersions, directory);
		if (!verified.matches) throw new Error(verified.changed.map(file => file.reason).join("\n"));
		const settled = await revision(progress);
		if (result.targets.length)
			settled.mainSpecs = result.targets.map(file => ({
				path: path.relative(cwd, path.resolve(cwd, file.path)).replaceAll(path.sep, "/"),
				version: file.version,
			}));
		return settled;
	};
	if (receipt?.state === "completed" && receipt.result) return finish(receipt.result);
	if (receipt?.state === "failed" && receipt.failure?.progress.synced) {
		return finish({ archivedChangePath: directory, targets: [], progress: receipt.failure.progress });
	}
	if (receipt) {
		const message =
			receipt.failure?.message ??
			"Native sync was interrupted; inspect the recorded target versions before a new sync operation";
		const before = receipt.input?.expectedTargets ?? receipt.failure?.targets ?? [];
		const changed: string[] = [];
		for (const file of before) {
			const relative = path.relative(cwd, file.path).replaceAll(path.sep, "/");
			if ((await fingerprint(cwd, relative)) !== file.version) changed.push(relative);
		}
		const progress = relativeProgress(receipt.failure?.progress ?? {});
		if (changed.length)
			progress.sideEffects = {
				paths: changed,
				diagnostic: message,
				expectedVersions: before.map(file => ({
					...file,
					path: path.relative(cwd, file.path).replaceAll(path.sep, "/"),
				})),
			};
		await publishProgress(progress);
		throw new Error(message);
	}
	const before = initialTargets;
	if (resumingCapture)
		throw new Error(
			"Owned native sync was interrupted before its native receipt; a new explicit sync operation is required",
		);
	const ownedPlan = await beginOwnedWrite(false, {});
	try {
		let response: SpecDrivenProcessResult | undefined;
		let processFailure: unknown;
		try {
			response = await runOpenSpecDirectory(
				"sync-directory",
				{
					changeDir: await containedSpecPath(cwd, directory),
					mainSpecsDir: await containedSpecPath(cwd, "openspec/specs"),
					changeName: input.changeId,
					archivePath: null,
					skipSpecs: false,
					expectedSources: await Promise.all(
						accepted.map(async file => ({
							path: await containedSpecPath(cwd, file.path),
							version: file.version,
						})),
					),
					expectedTargets: await Promise.all(
						before.map(async file => ({ path: await containedSpecPath(cwd, file.path), version: file.version })),
					),
					binding,
					receiptPath,
					sourceTreeVersion: ownedPlan?.sourceTreeVersion,
				},
				cwd,
				signal,
			);
		} catch (error) {
			processFailure = error;
		}
		// Read the durable receipt even when the response or cancellation raced process exit.
		let durable: NativeSyncReceipt | undefined;
		try {
			durable = JSON.parse(await fs.readFile(receiptPath, "utf8")) as NativeSyncReceipt;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (durable?.binding !== binding && durable) throw new Error("Native sync receipt binding changed");
		if (durable?.state === "completed" && durable.result) return await finish(durable.result);
		let outcome: { result?: NativeSyncResult; failure?: NativeSyncFailure } = {};
		if (durable?.state === "failed" && durable.failure) outcome.failure = durable.failure;
		else if (response) {
			try {
				outcome = JSON.parse(response.stdout) as typeof outcome;
			} catch (error) {
				processFailure = error;
			}
		}
		if (!response || response.exitCode !== 0 || !outcome.result) {
			const failure = outcome.failure;
			const progress = relativeProgress(failure?.progress ?? {});
			if (!progress.synced) {
				const changed: string[] = [];
				for (const file of before) {
					try {
						if ((await fingerprint(cwd, file.path)) !== file.version) changed.push(file.path);
					} catch {
						changed.push(file.path);
					}
				}
				if (changed.length)
					progress.sideEffects = {
						paths: changed,
						diagnostic: failure?.message ?? String(processFailure ?? response?.stderr),
						expectedVersions: before,
					};
			}
			await publishProgress(progress);
			throw (
				processFailure ??
				new Error(
					failure?.message ?? `OpenSpec directory sync failed: ${response?.stderr ?? "missing native result"}`,
				)
			);
		}
		return await finish(outcome.result);
	} finally {
		if (ownedPlan) await settleOwnership();
	}
}
