import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import { getOmpProfileStorageIdentity } from "./profiles";
import { containedSpecPath } from "../../spec-driven/artifacts";
import {
	observeSpecDrivenController,
	peekSpecDrivenController,
	type SpecControllerObservation,
} from "../../spec-driven/controller";
import { stageForPhase } from "../../spec-driven/stages";
import { writeFileAtomically } from "../../utils/atomic-file";
import type { ZCodeSessionManager, ZCodeSessionRecord } from "./sessions";
import {
	ompSpecRunSchema,
	type OmpSpecRun,
	type OmpSpecDetails,
	type OmpSpecMaterial,
	type OmpSpecRunBinding,
} from "./schema";

/** A nonadmitted bound action, distinct from native execution or storage failures. */
export class OmpSpecActionRejection extends Error {
	constructor(
		readonly reasonCode: "guard.specRun" | "guard.specAction",
		message: string,
	) {
		super(message);
	}
}
type ArtifactVersion = {
	version: number;
	digest: string;
	bytes: number;
	sourceVersion: string | null;
	createdAt: number;
};
type Artifact = { id: string; title: string; sourcePath: string; contentType: string; versions: ArtifactVersion[] };
type Saved = {
	format: 1;
	storage: string;
	sourceFile: string;
	workspaceIdentity: string;
	remoteSessionId: string | null;
	row: OmpSpecRun;
	artifacts: Artifact[];
};
type Owner = {
	record: ZCodeSessionRecord;
	sourceGeneration: number;
	storage: string;
	workspaceIdentity: string;
	remoteSessionId: string | null;
	unsubscribe: () => void;
	tail: Promise<void>;
	current: SpecControllerObservation | null;
	onChange: () => void;
};
const terminal = (phase: string) => phase === "completed" || phase === "cancelled";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Read-only native observations. This class never creates or restores a controller. */
export class OmpSpecDrivenBridge {
	readonly #owners = new Map<string, Owner>();
	readonly #runs = new Map<string, Saved>();
	constructor(
		readonly manager: ZCodeSessionManager,
		readonly identity: (cwd: string) => string = cwd => cwd,
		readonly remote: (cwd: string) => string | null = () => null,
	) {}
	attach(record: ZCodeSessionRecord, onChange: () => void): void {
		if (this.#owners.get(record.id)?.record === record) return;
		const previous = this.#owners.get(record.id);
		if (previous) throw new Error("Native specification source owner has not been released");
		const owner: Owner = {
			record,
			sourceGeneration: record.session.sessionGeneration,
			storage: JSON.stringify(getOmpProfileStorageIdentity()),
			workspaceIdentity: this.identity(record.cwd),
			remoteSessionId: this.remote(record.cwd),
			onChange,
			current: null,
			tail: Promise.resolve(),
			unsubscribe: () => {},
		};
		this.#owners.set(record.id, owner);
		owner.unsubscribe = observeSpecDrivenController(record.session.sessionManager, observation => {
			if (observation.runId && observation.runId !== owner.current?.runId)
				owner.sourceGeneration = record.session.sessionGeneration;
			owner.current = observation;
			owner.onChange();
			// Clone at observation time: queued filesystem work must not see a later native version.
			const captured = structuredClone(observation);
			owner.tail = owner.tail
				.then(() => this.#capture(owner, captured))
				.catch(error => {
					process.stderr.write(`Native specification observation: ${String(error)}\n`);
				});
		});
	}
	interaction(sessionId: string): SpecControllerObservation["interaction"] | undefined {
		const owner = this.#owners.get(sessionId);
		if (
			!owner ||
			owner.sourceGeneration !== owner.record.session.sessionGeneration ||
			this.manager.get(sessionId) !== owner.record ||
			owner.current?.disposed
		)
			return undefined;
		return owner.current ? structuredClone(owner.current.interaction) : undefined;
	}
	async #directory(cwd: string, runId: string): Promise<string> {
		if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid native run identity");
		return containedSpecPath(cwd, `.omp/spec-sessions/${runId}`);
	}
	async #capture(owner: Owner, observation: SpecControllerObservation): Promise<void> {
		const { runId, status } = observation;
		if (!runId || !status.changeId) return;
		const directory = await this.#directory(owner.record.cwd, runId);
		const previous = this.#runs.get(runId);
		const live =
			this.#owners.get(owner.record.id) === owner &&
			owner.sourceGeneration === owner.record.session.sessionGeneration &&
			owner.current?.runId === runId &&
			!observation.disposed &&
			!observation.released;
		const state: OmpSpecDetails["state"] = terminal(status.phase)
			? "terminal"
			: status.paused
				? "paused"
				: status.blockedReason
					? "blocked"
					: status.phase.startsWith("awaiting-")
						? "waiting"
						: "active";
		const artifacts = structuredClone(previous?.artifacts ?? []);
		const materials: OmpSpecMaterial[] = [];
		await mkdir(path.join(directory, "zcode-artifacts"), { recursive: true });
		const capture = async (
			id: string,
			title: string,
			sourcePath: string,
			sourceVersion: string | null,
			generated: boolean,
			content?: Buffer,
			expectedHash?: string,
		) => {
			if (!generated) {
				materials.push({ id, title, readiness: "not_generated", sourceVersion });
				return;
			}
			const artifactId = id.length <= 64 ? id : `native:${digest(Buffer.from(id)).slice(0, 48)}`;
			try {
				const bytes = content ?? (await readFile(await containedSpecPath(owner.record.cwd, sourcePath)));
				const hash = digest(bytes);
				if (expectedHash && hash !== expectedHash) {
					const historical = artifacts
						.find(item => item.id === artifactId)
						?.versions.find(item => item.digest === expectedHash && item.sourceVersion === sourceVersion);
					materials.push({
						id,
						title,
						readiness: historical ? "present" : "unknown",
						sourceVersion,
						...(historical ? { artifactId, version: historical.version } : {}),
					});
					return;
				}
				let artifact = artifacts.find(item => item.id === artifactId);
				if (!artifact) {
					artifact = {
						id: artifactId,
						title: title.slice(0, 120),
						sourcePath,
						contentType: sourcePath.endsWith(".md") ? "text/markdown" : "application/json",
						versions: [],
					};
					artifacts.push(artifact);
				}
				let version = artifact.versions.at(-1);
				if (!version || version.digest !== hash || version.sourceVersion !== sourceVersion) {
					const target = await containedSpecPath(
						owner.record.cwd,
						`.omp/spec-sessions/${runId}/zcode-artifacts/${hash}`,
					);
					try {
						await writeFile(target, bytes, { flag: "wx" });
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						if (digest(await readFile(target)) !== hash)
							throw new Error("Existing native artifact capture is corrupt");
					}
					version = {
						version: artifact.versions.length + 1,
						digest: hash,
						bytes: bytes.length,
						sourceVersion,
						createdAt: observation.updatedAt,
					};
					artifact.versions.push(version);
				}
				materials.push({ id, title, readiness: "present", sourceVersion, artifactId, version: version.version });
			} catch (error) {
				materials.push({
					id,
					title,
					readiness: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable",
					sourceVersion,
				});
			}
		};
		const change = `openspec/changes/${status.changeId}`;
		await capture(
			"proposal",
			"Proposal",
			`${change}/proposal.md`,
			status.specification?.version ?? null,
			!!status.specification,
			undefined,
			status.specification ? digest(Buffer.from(status.specification.proposal)) : undefined,
		);
		for (const spec of status.specification?.specs ?? [])
			await capture(
				`spec:${spec.path}`,
				spec.path,
				`${change}/${spec.path}`,
				status.specification!.version,
				true,
				undefined,
				digest(Buffer.from(spec.content)),
			);
		let nativeState: { solution?: unknown; plan?: { path?: string; documentVersion?: string } } | undefined;
		try {
			nativeState = JSON.parse(
				await readFile(await containedSpecPath(owner.record.cwd, `.omp/spec-sessions/${runId}/state.json`), "utf8"),
			);
		} catch {
			/* Readiness is represented below, not as fabricated content. */
		}
		await capture(
			"solution",
			"Selected solution",
			`.omp/spec-sessions/${runId}/state.json#/solution`,
			status.solution?.version ?? null,
			!!status.solution,
			nativeState?.solution === undefined ? undefined : Buffer.from(JSON.stringify(nativeState.solution)),
			status.solution?.artifactVersion,
		);
		const planPath =
			nativeState?.plan?.path &&
			/^docs\/superpowers\/plans\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(nativeState.plan.path) &&
			nativeState.plan.path.endsWith(`-${status.changeId}.md`)
				? nativeState.plan.path
				: undefined;
		if (status.plan && planPath && nativeState?.plan) {
			try {
				const bytes = await readFile(await containedSpecPath(owner.record.cwd, planPath));
				const snapshot = { path: planPath, content: bytes.toString("utf8"), version: digest(bytes) };
				if (digest(Buffer.from(JSON.stringify([snapshot, nativeState.plan]))) !== status.plan.artifactVersion) {
					materials.push({
						id: "plan",
						title: "Implementation plan",
						readiness: "unknown",
						sourceVersion: status.plan.version,
					});
				} else
					await capture(
						"plan",
						"Implementation plan",
						planPath,
						status.plan.version,
						true,
						bytes,
						nativeState.plan.documentVersion,
					);
			} catch (error) {
				materials.push({
					id: "plan",
					title: "Implementation plan",
					readiness: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable",
					sourceVersion: status.plan.version,
				});
			}
		} else
			await capture(
				"plan",
				"Implementation plan",
				`.omp/spec-sessions/${runId}/unavailable-plan`,
				status.plan?.version ?? null,
				!!status.plan,
			);
		for (const [index, candidate] of (status.team?.candidates ?? []).entries())
			await capture(
				`candidate:${candidate.id}`,
				candidate.label,
				`.omp/spec-sessions/${runId}/state.json#/status/team/candidates/${index}`,
				candidate.version,
				true,
				Buffer.from(JSON.stringify(candidate)),
			);
		for (const handoff of status.handoffs ?? [])
			await capture(
				`handoff:${handoff.actorId}:${handoff.transition}`,
				handoff.transition,
				handoff.path,
				handoff.digest,
				true,
				undefined,
				handoff.digest,
			);
		for (const review of status.reviewArtifacts ?? [])
			await capture(
				`review:${review.slotId}`,
				review.slotId,
				review.path,
				review.version,
				true,
				undefined,
				review.version,
			);
		await capture(
			"verification",
			"Verification",
			`${change}/verification.md`,
			status.acceptanceVersion ?? null,
			!!status.acceptanceVersion,
		);
		try {
			const checks = await readdir(await containedSpecPath(owner.record.cwd, `${change}/checks`), {
				withFileTypes: true,
			});
			for (const check of checks)
				if (check.isFile())
					await capture(`check:${check.name}`, check.name, `${change}/checks/${check.name}`, null, true);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				materials.push({ id: "checks", title: "Check references", readiness: "unreadable", sourceVersion: null });
		}
		const evidence = {
			tasks: status.tasks,
			reviews: status.reviews,
			executionEvidence: status.executionEvidence ?? null,
			gitEvidence: status.gitEvidence ?? null,
			pendingClosure: status.pendingClosure,
		};
		await capture(
			"evidence",
			"Verification and check references",
			`.omp/spec-sessions/${runId}/state.json#/status`,
			status.acceptanceVersion ?? status.plan?.version ?? null,
			true,
			Buffer.from(JSON.stringify(evidence)),
		);
		const details: OmpSpecDetails = {
			changeId: status.changeId,
			phase: status.phase,
			stage: stageForPhase(status.phase),
			state,
			explanation:
				status.blockedReason ??
				(status.paused
					? "Native execution is paused"
					: state === "waiting"
						? "Waiting for native user input"
						: status.phase),
			generation: status.generation,
			live,
			readOnly: !live || terminal(status.phase),
			workspaceIdentity: owner.workspaceIdentity,
			workspacePath: owner.record.cwd,
			sessionId: owner.record.id,
			createdAt: observation.createdAt,
			updatedAt: observation.updatedAt,
			progress: {
				completed: (status.plan?.tasks ?? []).filter(task =>
					status.tasks.some(item => item.id === task.id && item.status === "completed"),
				).length,
				total: status.plan?.tasks.length ?? 0,
			},
			tasks: (status.plan?.tasks ?? []).map(task => ({
				id: task.id,
				title: task.title,
				dependencies: task.dependencies,
				requirementIds: task.requirementIds,
				status: status.tasks.find(item => item.id === task.id)?.status ?? "pending",
			})),
			versions: {
				...(status.specification ? { specification: status.specification.version } : {}),
				...(status.solution ? { solution: status.solution.version } : {}),
				...(status.plan ? { plan: status.plan.version } : {}),
				...(status.selection ? { candidate: status.selection.candidateVersion } : {}),
				...(status.acceptanceVersion ? { acceptance: status.acceptanceVersion } : {}),
			},
			questions: status.questions,
			// Team results retain internal fields; publish only the native candidate contract.
			candidates: (status.team?.candidates ?? []).map(
				({
					id,
					label,
					version,
					proposal,
					adoptable,
					reviewSucceeded,
					recheckSucceeded,
					unresolvedBlocking,
					exclusionReason,
					conditions,
				}) => ({
					id,
					label,
					version,
					proposal,
					adoptable,
					reviewSucceeded,
					recheckSucceeded,
					unresolvedBlocking,
					exclusionReason,
					conditions,
				}),
			),
			selectedCandidate: status.selection
				? { id: status.selection.candidateId, version: status.selection.candidateVersion }
				: null,
			actions:
				live && !terminal(status.phase)
					? observation.interaction.actions.map(action => ({
							...action,
							binding: {
								runId,
								generation: status.generation,
								actionId: action.id,
								actionVersion: action.version ?? action.command,
							},
						}))
					: [],
			interaction:
				live && !terminal(status.phase)
					? observation.interaction
					: {
							...observation.interaction,
							recipient: undefined,
							actions: [],
							blockedReason: live
								? "Terminal run; controls unavailable"
								: "Read-only historical observation; no live native owner",
						},
			clarification: status.clarification,
			materials,
		};
		const row = ompSpecRunSchema.parse({
			runId,
			status:
				status.phase === "completed"
					? "completed"
					: status.phase === "cancelled"
						? "stopped"
						: state === "active"
							? "running"
							: "pending",
			...(status.phase === "cancelled" ? { stopReason: "user" } : {}),
			usage: null,
			actors: [],
			nodes: [],
			spec: details,
		});
		const saved: Saved = {
			format: 1,
			storage: owner.storage,
			sourceFile: owner.record.session.sessionManager.getSessionFile() ?? "",
			workspaceIdentity: details.workspaceIdentity,
			remoteSessionId: owner.remoteSessionId,
			row,
			artifacts: artifacts.filter(artifact => artifact.versions.length > 0),
		};
		this.#runs.set(runId, saved);
		await writeFileAtomically(
			await containedSpecPath(owner.record.cwd, `.omp/spec-sessions/${runId}/zcode.json`),
			JSON.stringify(saved),
		);
		owner.onChange();
	}
	async #readonly(saved: Saved): Promise<OmpSpecRun> {
		const owner = this.#owners.get(saved.row.spec.sessionId);
		const live =
			owner &&
			owner.sourceGeneration === owner.record.session.sessionGeneration &&
			owner.current?.runId === saved.row.runId &&
			!owner.current.disposed &&
			!owner.current.released &&
			this.manager.get(owner.record.id) === owner.record;
		if (live) return saved.row;
		const materials = await Promise.all(
			saved.row.spec.materials.map(async material => {
				if (!material.artifactId || !material.version) return material;
				const artifact = saved.artifacts.find(item => item.id === material.artifactId);
				const version = artifact?.versions.find(item => item.version === material.version);
				if (!artifact || !version || !/^[a-f0-9]{64}$/.test(version.digest))
					return { ...material, readiness: "unknown" as const };
				try {
					const bytes = await readFile(
						await containedSpecPath(
							saved.row.spec.workspacePath,
							`.omp/spec-sessions/${saved.row.runId}/zcode-artifacts/${version.digest}`,
						),
					);
					if (digest(bytes) !== version.digest) return { ...material, readiness: "unreadable" as const };
					// Inspect current readiness only; historical byte responses always use the immutable capture.
					if (
						!artifact.sourcePath.includes("#") &&
						(artifact.sourcePath.startsWith(`openspec/changes/${saved.row.spec.changeId}/`) ||
							artifact.sourcePath.startsWith("docs/superpowers/plans/"))
					) {
						const source = await containedSpecPath(saved.row.spec.workspacePath, artifact.sourcePath);
						if (!(await stat(source)).isFile()) throw new Error("Native material is not a readable file");
						await access(source, constants.R_OK);
					}
					return material;
				} catch (error) {
					return {
						...material,
						readiness:
							(error as NodeJS.ErrnoException).code === "ENOENT"
								? ("missing" as const)
								: ("unreadable" as const),
					};
				}
			}),
		);
		return {
			...saved.row,
			...(!terminal(saved.row.spec.phase) ? { status: "stopped" as const, stopReason: "interrupted" as const } : {}),
			spec: {
				...saved.row.spec,
				live: false,
				readOnly: true,
				...(!terminal(saved.row.spec.phase) ? { state: "blocked" as const } : {}),
				explanation: `Read-only historical observation; no live native owner. Last native state: ${saved.row.spec.explanation}`,
				actions: [],
				...(saved.row.spec.interaction
					? {
							interaction: {
								...saved.row.spec.interaction,
								recipient: undefined,
								actions: [],
								blockedReason: "Read-only historical observation; no live native owner",
							},
						}
					: {}),
				materials,
			},
		};
	}
	async runs(sessionId: string): Promise<OmpSpecRun[]> {
		const owner = this.#owners.get(sessionId);
		await owner?.tail;
		const source = owner
			? { cwd: owner.record.cwd, file: owner.record.session.sessionManager.getSessionFile() ?? "" }
			: await this.manager.read(sessionId).then(read => ({ cwd: read.cwd, file: read.info.path }));
		let entries: string[] = [];
		try {
			entries = await readdir(await containedSpecPath(source.cwd, ".omp/spec-sessions"));
		} catch (error) {
			// Missing/inaccessible project storage must not break independently persisted chat history.
			if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))
				throw error;
		}
		for (const runId of entries) {
			if (!/^[a-zA-Z0-9_-]+$/.test(runId) || this.#runs.has(runId)) continue;
			try {
				const saved = JSON.parse(
					await readFile(await containedSpecPath(source.cwd, `.omp/spec-sessions/${runId}/zcode.json`), "utf8"),
				) as Saved;
				const row = ompSpecRunSchema.parse(saved.row);
				if (
					saved.format !== 1 ||
					saved.storage !== JSON.stringify(getOmpProfileStorageIdentity()) ||
					saved.remoteSessionId !== this.remote(source.cwd) ||
					saved.sourceFile !== source.file ||
					saved.workspaceIdentity !== this.identity(source.cwd) ||
					row.spec.sessionId !== sessionId ||
					row.spec.workspacePath !== source.cwd ||
					row.runId !== runId
				)
					continue;
				this.#runs.set(runId, {
					...saved,
					row: { ...row, spec: { ...row.spec, live: false, readOnly: true, actions: [] } },
				});
			} catch {
				/* Foreign, incomplete, or corrupt observations are not native runs owned by this source. */
			}
		}
		return (
			await Promise.all(
				[...this.#runs.values()]
					.filter(
						saved =>
							saved.row.spec.sessionId === sessionId &&
							saved.sourceFile === source.file &&
							saved.storage === JSON.stringify(getOmpProfileStorageIdentity()) &&
							saved.remoteSessionId === this.remote(source.cwd) &&
							saved.workspaceIdentity === this.identity(source.cwd),
					)
					.map(saved => this.#readonly(saved)),
			)
		).sort((a, b) => b.spec.updatedAt - a.spec.updatedAt);
	}
	async workspaceRuns(
		workspacePath: string,
		workspaceIdentity?: string,
		remoteSessionId?: string,
	): Promise<OmpSpecRun[]> {
		if (
			(workspaceIdentity?.trim() || workspacePath) !== this.identity(workspacePath) ||
			(remoteSessionId ?? null) !== this.remote(workspacePath)
		)
			return [];
		const sessions = await this.manager.list();
		const rows = await Promise.all(
			sessions
				.filter(info => path.resolve(info.cwd) === path.resolve(workspacePath))
				.map(info => this.runs(info.id)),
		);
		return rows.flat().sort((a, b) => b.spec.updatedAt - a.spec.updatedAt);
	}
	async #owned(sessionId: string, runId: string): Promise<Saved | undefined> {
		if (!(await this.runs(sessionId)).some(row => row.runId === runId)) return undefined;
		return this.#runs.get(runId);
	}
	async artifacts(sessionId: string, runId: string) {
		const saved = await this.#owned(sessionId, runId);
		if (!saved) return undefined;
		return {
			artifacts: saved.artifacts.map(artifact => ({
				id: artifact.id,
				title: artifact.title,
				kind: artifact.contentType === "text/markdown" ? ("markdown" as const) : ("file" as const),
				version: artifact.versions.at(-1)!.version,
				contentType: artifact.contentType,
				sourcePath: artifact.sourcePath,
				versions: artifact.versions.map(version => ({
					version: version.version,
					publishedAt: version.createdAt,
					bytes: version.bytes,
					contentType: artifact.contentType,
				})),
				itemCount: 0,
			})),
		};
	}
	async artifactRead(input: {
		sessionId: string;
		runId: string;
		artifactId: string;
		version: number;
		offset: number;
		limit: number;
	}) {
		const saved = await this.#owned(input.sessionId, input.runId);
		if (!saved) return undefined;
		const artifact = saved.artifacts.find(item => item.id === input.artifactId);
		const version = artifact?.versions.find(item => item.version === input.version);
		if (!artifact || !version || !/^[a-f0-9]{64}$/.test(version.digest))
			throw new Error("Native artifact version not found");
		const bytes = await readFile(
			await containedSpecPath(
				saved.row.spec.workspacePath,
				`.omp/spec-sessions/${input.runId}/zcode-artifacts/${version.digest}`,
			),
		);
		if (digest(bytes) !== version.digest) throw new Error("Native artifact historical bytes are corrupt");
		const end = Math.min(bytes.length, input.offset + Math.min(input.limit, 512 * 1024));
		return {
			dataBase64: bytes.subarray(input.offset, end).toString("base64"),
			mediaType: artifact.contentType,
			totalBytes: bytes.length,
			nextOffset: end < bytes.length ? end : null,
		};
	}
	async artifactData(input: { sessionId: string; runId: string; artifactId: string }) {
		const saved = await this.#owned(input.sessionId, input.runId);
		if (!saved) return undefined;
		if (!saved.artifacts.some(item => item.id === input.artifactId)) throw new Error("Native artifact not found");
		throw new Error("Native file artifacts have no report-item data; use workflowRunArtifactRead");
	}
	validate(record: ZCodeSessionRecord | undefined, text: string, binding: OmpSpecRunBinding): void {
		const owner = record ? this.#owners.get(record.id) : undefined;
		const observation = owner?.current;
		if (
			!record ||
			!owner ||
			owner.record !== record ||
			owner.sourceGeneration !== record.session.sessionGeneration ||
			owner.storage !== JSON.stringify(getOmpProfileStorageIdentity()) ||
			owner.workspaceIdentity !== this.identity(record.cwd) ||
			owner.remoteSessionId !== this.remote(record.cwd) ||
			this.manager.get(record.id) !== record ||
			!observation ||
			observation.runId !== binding.runId ||
			observation.status.generation !== binding.generation ||
			observation.disposed ||
			observation.released ||
			terminal(observation.status.phase)
		)
			throw new OmpSpecActionRejection("guard.specRun", "Native specification action binding is stale or readonly");
		// Ordinary dialogue binds the live run, not an advertised command/version.
		// Keep action-bearing input on the strict command path, even when its text is prose.
		if (binding.actionId === undefined && binding.actionVersion === undefined && !text.startsWith("/")) return;
		if (
			!peekSpecDrivenController(record.session.sessionManager)
				?.actions()
				.some(
					action =>
						action.available &&
						(!binding.actionId || binding.actionId === action.id) &&
						(action.version !== undefined
							? binding.actionVersion === action.version
							: !binding.actionVersion || binding.actionVersion === action.command) &&
						(action.command === text ||
							(action.requiresInput &&
								text.startsWith(`${action.command} `) &&
								text.slice(action.command.length).trim())),
				)
		)
			throw new OmpSpecActionRejection(
				"guard.specAction",
				"Command is not an allowed current native specification action",
			);
	}
	async detach(sessionId: string): Promise<void> {
		const owner = this.#owners.get(sessionId);
		if (!owner) return;
		owner.unsubscribe();
		this.#owners.delete(sessionId);
		await owner.tail;
		for (const saved of this.#runs.values())
			if (saved.row.spec.sessionId === sessionId) {
				saved.row = {
					...saved.row,
					spec: {
						...saved.row.spec,
						live: false,
						readOnly: true,
						actions: [],
						...(saved.row.spec.interaction
							? {
									interaction: {
										...saved.row.spec.interaction,
										recipient: undefined,
										actions: [],
										blockedReason: "Read-only historical observation; no live native owner",
									},
								}
							: {}),
					},
				};
				await writeFileAtomically(
					await containedSpecPath(
						saved.row.spec.workspacePath,
						`.omp/spec-sessions/${saved.row.runId}/zcode.json`,
					),
					JSON.stringify(saved),
				);
			}
	}
	async dispose(): Promise<void> {
		await Promise.all([...this.#owners.keys()].map(id => this.detach(id)));
	}
}
