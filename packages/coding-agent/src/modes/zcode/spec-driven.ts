import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ZodError } from "zod";
import { containedSpecPath, formalMaterialPaths, parseSpecSolution } from "../../spec-driven/artifacts";
import {
	observeSpecDrivenController,
	peekSpecDrivenController,
	type SpecControllerObservation,
} from "../../spec-driven/controller";
import { SPEC_PHASES, stageForPhase } from "../../spec-driven/stages";
import type { SpecDrivenStatus } from "../../spec-driven/types";
import { writeFileAtomically } from "../../utils/atomic-file";
import { getOmpProfileStorageIdentity } from "./profiles";
import type { ZCodeSessionManager, ZCodeSessionRecord } from "./sessions";
import {
	ompSpecRunSchema,
	type OmpSpecDetails,
	type OmpSpecMaterial,
	type OmpSpecRun,
	type OmpSpecRunBinding,
} from "./schema";

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
type Artifact = {
	id: string;
	materialId: string;
	title: string;
	sourcePath: string;
	contentType: string;
	expectedVersion?: string;
	versions: ArtifactVersion[];
};
/** Query index of observed identities and versions only. Formal files and SDK sessions own all bodies. */
type Saved = {
	format: 2;
	storage: string;
	sourceFile: string;
	workspaceIdentity: string;
	remoteSessionId: string | null;
	runId: string;
	sessionId: string;
	cwd: string;
	changeId: string;
	phase: SpecDrivenStatus["phase"];
	createdAt: number;
	updatedAt: number;
	generation: number;
	archivedChangePath?: string;
	specificationVersion?: string;
	selection?: SpecDrivenStatus["selection"];
	closing?: SpecDrivenStatus["closing"];
	awaitingAcceptance?: boolean;
	artifacts: Artifact[];
};
type Owner = {
	record: ZCodeSessionRecord;
	sourceGeneration: number;
	unsubscribe: () => void;
	tail: Promise<void>;
	current: SpecControllerObservation | null;
	onChange: () => void;
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Observes the native workspace controller; cold queries never create or restore one. */
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
		if (this.#owners.has(record.id)) throw new Error("Native specification source owner has not been released");
		const owner: Owner = {
			record,
			sourceGeneration: record.session.sessionGeneration,
			onChange,
			current: null,
			tail: Promise.resolve(),
			unsubscribe: () => {},
		};
		this.#owners.set(record.id, owner);
		owner.unsubscribe = observeSpecDrivenController(record.session.sessionManager, observation => {
			if (observation.runId !== owner.current?.runId) owner.sourceGeneration = record.session.sessionGeneration;
			owner.current = observation;
			owner.onChange();
			const captured = structuredClone(observation);
			owner.tail = owner.tail
				.then(() => this.#capture(owner, captured))
				.catch(error => {
					process.stderr.write(`Native specification observation: ${String(error)}\n`);
				});
		});
	}
	#live(owner: Owner | undefined, runId?: string): owner is Owner {
		return (
			!!owner &&
			owner.sourceGeneration === owner.record.session.sessionGeneration &&
			this.manager.get(owner.record.id) === owner.record &&
			!!owner.current &&
			!owner.current.disposed &&
			!owner.current.released &&
			(!runId || owner.current.runId === runId)
		);
	}
	interaction(sessionId: string): SpecControllerObservation["interaction"] | undefined {
		const owner = this.#owners.get(sessionId);
		return this.#live(owner) ? structuredClone(owner.current!.interaction) : undefined;
	}
	async #directory(cwd: string, runId: string): Promise<string> {
		if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid native run identity");
		return containedSpecPath(cwd, `.omp/spec-sessions/${runId}`);
	}
	async #capture(owner: Owner, observation: SpecControllerObservation): Promise<void> {
		const { runId, status } = observation;
		if (!runId || !status.changeId) return;
		const previous = this.#runs.get(runId);
		const artifacts = structuredClone(previous?.artifacts ?? []);
		const original = `openspec/changes/${status.changeId}/`;
		const archive = status.archivedChangePath ?? status.closing?.archivedChangePath;
		const relocated = (file: string) =>
			archive && file.startsWith(original) ? `${archive}/${file.slice(original.length)}` : file;
		const approvedVersions = new Map(
			Object.values(observation.approvals).flatMap(approval =>
				approval.files.map(file => [relocated(file.path), file.version] as const),
			),
		);
		const formalPaths =
			status.paths && !observation.approvals.requirements
				? await formalMaterialPaths(observation.cwd, status.paths, status.changeId, archive)
				: [];
		const requirements =
			observation.approvals.requirements?.files ??
			formalPaths.slice(0, -3).map(file => ({ path: file, version: "" }));
		const requirementIdentity = (file: string) =>
			archive && file.startsWith(`${archive}/`) ? `${original}${file.slice(archive.length + 1)}` : file;
		const documents = [
			...requirements.map(file => {
				const identity = requirementIdentity(file.path);
				return { id: `requirement:${identity}`, title: identity, file };
			}),
			...(
				[
					["solution", "完整方案文件", status.solution, status.paths?.solution],
					["plan", "完整计划文件", status.plan, status.paths?.plan],
					["report", "完成报告", status.report, status.paths?.report],
				] as const
			).flatMap(([id, title, document, planned]) => {
				const file = document ?? (planned ? { path: planned, version: "" } : undefined);
				return file ? [{ id, title, file }] : [];
			}),
		];
		for (const artifact of artifacts) artifact.sourcePath = relocated(artifact.sourcePath);
		for (const { id, title, file } of documents) {
			const artifactId = id.length <= 64 ? id : `native:${digest(Buffer.from(id)).slice(0, 48)}`;
			let artifact = artifacts.find(item => item.id === artifactId);
			if (!artifact) {
				artifact = {
					id: artifactId,
					materialId: id,
					title: title.slice(0, 120),
					sourcePath: relocated(file.path),
					contentType: file.path.endsWith(".md") ? "text/markdown" : "application/json",
					versions: [],
				};
				artifacts.push(artifact);
			}
			artifact.sourcePath = relocated(file.path);
			const expectedVersion = approvedVersions.get(artifact.sourcePath);
			artifact.expectedVersion = expectedVersion;
			try {
				const bytes = await readFile(await containedSpecPath(observation.cwd, artifact.sourcePath));
				const hash = digest(bytes);
				if (expectedVersion && hash !== expectedVersion) continue;
				const last = artifact.versions.at(-1);
				if (!last || last.digest !== hash)
					artifact.versions.push({
						version: (last?.version ?? 0) + 1,
						digest: hash,
						bytes: bytes.length,
						sourceVersion: expectedVersion || hash,
						createdAt: observation.updatedAt,
					});
			} catch {
				/* Readiness is determined independently by each query; no workflow failure. */
			}
		}
		const saved: Saved = {
			format: 2,
			storage: JSON.stringify(getOmpProfileStorageIdentity()),
			sourceFile: owner.record.session.sessionManager.getSessionFile() ?? "",
			workspaceIdentity: this.identity(owner.record.cwd),
			remoteSessionId: this.remote(owner.record.cwd),
			runId,
			sessionId: owner.record.id,
			cwd: observation.cwd,
			changeId: status.changeId,
			phase: status.phase,
			createdAt: observation.createdAt,
			updatedAt: observation.updatedAt,
			generation: status.generation,
			archivedChangePath: archive,
			closing: status.closing,
			awaitingAcceptance: status.awaitingAcceptance,
			specificationVersion: status.specification?.version ?? previous?.specificationVersion,
			selection: status.selection,
			artifacts,
		};
		this.#runs.set(runId, saved);
		const directory = await this.#directory(saved.cwd, runId);
		await mkdir(directory, { recursive: true });
		await writeFileAtomically(path.join(directory, "zcode.json"), JSON.stringify(saved));
		owner.onChange();
	}
	async #row(saved: Saved): Promise<OmpSpecRun> {
		const owner = this.#owners.get(saved.sessionId);
		const live = this.#live(owner, saved.runId);
		const status = live ? owner.current!.status : undefined;
		let useTeam = status?.useTeam;
		if (!live) {
			try {
				const workspace = JSON.parse(
					await readFile(await containedSpecPath(saved.cwd, ".omp/dev/state.json"), "utf8"),
				);
				if (workspace.version === 1 && typeof workspace.team === "boolean" && workspace.run?.runId === saved.runId)
					useTeam = workspace.team;
			} catch {
				/* Historical facts remain readable when current workspace state is absent or damaged. */
			}
		}
		const materials: OmpSpecMaterial[] = [];
		let candidates: OmpSpecDetails["candidates"] = [];
		let recommendedCandidateId: string | null = null;
		for (const artifact of saved.artifacts) {
			const version = artifact.versions.at(-1);
			let readiness: OmpSpecMaterial["readiness"] = "unknown";
			try {
				const bytes = await readFile(await containedSpecPath(saved.cwd, artifact.sourcePath));
				readiness = version && digest(bytes) === version.digest ? "present" : "unknown";
				if (artifact.id === "solution" && readiness === "present") {
					try {
						const solution = parseSpecSolution({
							path: artifact.sourcePath,
							content: bytes.toString("utf8"),
							version: version!.digest,
						});
						candidates = solution.candidates;
						recommendedCandidateId = solution.recommendedCandidateId;
					} catch {
						readiness = "unreadable";
					}
				}
			} catch (error) {
				readiness =
					(error as NodeJS.ErrnoException).code === "ENOENT"
						? version || artifact.expectedVersion
							? "missing"
							: "not_generated"
						: "unreadable";
			}
			materials.push({
				id: artifact.materialId,
				title: artifact.title,
				readiness,
				sourceVersion: artifact.expectedVersion ?? version?.sourceVersion ?? null,
				...(version ? { artifactId: artifact.id, version: version.version } : {}),
			});
		}
		for (const [id, title] of [
			["requirements", "需求文件"],
			["solution", "完整方案文件"],
			["plan", "完整计划文件"],
			["report", "完成报告"],
		]) {
			if (
				!materials.some(material =>
					id === "requirements" ? material.id.startsWith("requirement:") : material.id === id,
				)
			)
				materials.push({ id: id!, title: title!, readiness: "not_generated", sourceVersion: null });
		}
		const terminal = saved.phase === "idle" && !!saved.archivedChangePath;
		const state: OmpSpecDetails["state"] = terminal
			? "terminal"
			: !live || status?.blockedReason || owner?.current?.error
				? "blocked"
				: status?.awaitingAcceptance
					? "waiting"
					: "active";
		const versions = Object.fromEntries(
			saved.artifacts.flatMap(artifact => {
				const last = artifact.versions.at(-1);
				return last && ["solution", "plan", "report"].includes(artifact.id) ? [[artifact.id, last.digest]] : [];
			}),
		);
		return ompSpecRunSchema.parse({
			runId: saved.runId,
			status: terminal ? "completed" : live ? "running" : "stopped",
			...(!live && !terminal ? { stopReason: "interrupted" } : {}),
			usage: null,
			actors: [],
			nodes: [],
			spec: {
				changeId: saved.changeId,
				phase: status?.phase ?? saved.phase,
				stage: (status?.phase ?? saved.phase) === "idle" ? null : stageForPhase(status?.phase ?? saved.phase),
				state,
				explanation:
					status?.blockedReason ??
					(live
						? (owner.current!.error ?? owner.current!.notice ?? state)
						: "Read-only historical observation; no live native owner"),
				useTeam,
				teamMutable: live && owner.current!.teamMutable,
				generation: status?.generation ?? saved.generation,
				live,
				readOnly: !live || terminal,
				workspaceIdentity: saved.workspaceIdentity,
				workspacePath: saved.cwd,
				sessionId: saved.sessionId,
				createdAt: saved.createdAt,
				updatedAt: saved.updatedAt,
				awaitingAcceptance: status?.awaitingAcceptance ?? saved.awaitingAcceptance,
				closing: status?.closing ?? saved.closing,
				archivedChangePath: saved.archivedChangePath,
				versions: {
					...versions,
					...(saved.specificationVersion ? { specification: saved.specificationVersion } : {}),
				},
				candidates,
				recommendedCandidateId,
				selectedCandidate: saved.selection
					? { id: saved.selection.candidateId, userReply: saved.selection.userReply }
					: null,
				actions:
					live && !terminal
						? owner.current!.interaction.actions.map(action => ({
								...action,
								binding: {
									runId: saved.runId,
									generation: status!.generation,
									phase: status!.phase,
									files: saved.artifacts.flatMap(artifact => {
										const version = artifact.versions.at(-1);
										return version ? [{ path: artifact.sourcePath, version: version.digest }] : [];
									}),
									actionId: action.id,
								},
							}))
						: [],
				...(live ? { interaction: owner.current!.interaction } : {}),
				materials,
			},
		});
	}
	async runs(sessionId: string): Promise<OmpSpecRun[]> {
		const owner = this.#owners.get(sessionId);
		if (owner) {
			for (;;) {
				const pending = owner.tail;
				await pending;
				if (pending === owner.tail) break;
			}
		}
		const source = owner
			? { cwd: owner.record.cwd, file: owner.record.session.sessionManager.getSessionFile() ?? "" }
			: await this.manager.read(sessionId).then(read => ({ cwd: read.cwd, file: read.info.path }));
		const root = await realpath(vcs.gitInfo(source.cwd)?.repoRoot ?? source.cwd);
		let entries: string[] = [];
		try {
			entries = await readdir(await containedSpecPath(root, ".omp/spec-sessions"));
		} catch (error) {
			if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))
				throw error;
		}
		const coldRows = new Map<string, OmpSpecRun>();
		for (const runId of entries) {
			if (!/^[a-zA-Z0-9_-]+$/.test(runId) || this.#runs.has(runId)) continue;
			let saved: Saved;
			try {
				saved = JSON.parse(
					await readFile(path.join(await this.#directory(root, runId), "zcode.json"), "utf8"),
				) as Saved;
				if (
					saved.format !== 2 ||
					saved.runId !== runId ||
					saved.sessionId !== sessionId ||
					saved.sourceFile !== source.file ||
					saved.cwd !== root ||
					saved.storage !== JSON.stringify(getOmpProfileStorageIdentity()) ||
					saved.workspaceIdentity !== this.identity(source.cwd) ||
					saved.remoteSessionId !== this.remote(source.cwd) ||
					!SPEC_PHASES.includes(saved.phase) ||
					!Array.isArray(saved.artifacts)
				)
					continue;
				if (
					!saved.artifacts.every(
						artifact =>
							typeof artifact.id === "string" &&
							typeof artifact.materialId === "string" &&
							typeof artifact.sourcePath === "string" &&
							typeof artifact.title === "string" &&
							typeof artifact.contentType === "string" &&
							Array.isArray(artifact.versions) &&
							artifact.versions.every(
								version =>
									Number.isSafeInteger(version.version) &&
									version.version > 0 &&
									/^[a-f0-9]{64}$/.test(version.digest) &&
									Number.isSafeInteger(version.bytes) &&
									version.bytes >= 0 &&
									Number.isFinite(version.createdAt),
							),
					)
				)
					continue;
			} catch {
				/* Foreign or incomplete observations are not owned by this source. */
				continue;
			}
			try {
				coldRows.set(runId, await this.#row(saved));
			} catch (error) {
				if (error instanceof ZodError) continue;
				throw error;
			}
			this.#runs.set(runId, saved);
		}
		return (
			await Promise.all(
				[...this.#runs.values()]
					.filter(
						saved =>
							saved.sessionId === sessionId &&
							saved.sourceFile === source.file &&
							saved.storage === JSON.stringify(getOmpProfileStorageIdentity()) &&
							saved.workspaceIdentity === this.identity(source.cwd) &&
							saved.remoteSessionId === this.remote(source.cwd),
					)
					.map(saved => coldRows.get(saved.runId) ?? this.#row(saved)),
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
		return (
			await Promise.all(
				sessions
					.filter(info => this.identity(info.cwd) === this.identity(workspacePath))
					.map(info => this.runs(info.id)),
			)
		)
			.flat()
			.sort((a, b) => b.spec.updatedAt - a.spec.updatedAt);
	}
	async #owned(sessionId: string, runId: string): Promise<Saved | undefined> {
		return (await this.runs(sessionId)).some(row => row.runId === runId) ? this.#runs.get(runId) : undefined;
	}
	async artifacts(sessionId: string, runId: string) {
		const saved = await this.#owned(sessionId, runId);
		if (!saved) return undefined;
		return {
			artifacts: saved.artifacts
				.filter(artifact => artifact.versions.length)
				.map(artifact => ({
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
		if (!artifact || !version) throw new Error("Native artifact version not found");
		const bytes = await readFile(await containedSpecPath(saved.cwd, artifact.sourcePath));
		if (digest(bytes) !== version.digest)
			throw new Error("Native artifact version is no longer available from the formal material");
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
	async validate(record: ZCodeSessionRecord | undefined, text: string, binding: OmpSpecRunBinding): Promise<void> {
		const owner = record ? this.#owners.get(record.id) : undefined;
		const controller = record ? peekSpecDrivenController(record.session.sessionManager) : undefined;
		const assertCurrent = () => {
			const current = controller?.observation();
			if (
				!this.#live(owner, binding.runId) ||
				owner.record !== record ||
				!current ||
				current.runId !== binding.runId ||
				current.status.generation !== binding.generation ||
				current.status.phase !== binding.phase ||
				current.released ||
				current.disposed
			)
				throw new OmpSpecActionRejection(
					"guard.specRun",
					"Native specification action binding is stale or readonly",
				);
		};
		assertCurrent();
		if (binding.actionId === undefined && !text.startsWith("/")) return;
		const saved = this.#runs.get(binding.runId);
		const expected =
			saved?.artifacts.flatMap(artifact => {
				const version = artifact.versions.at(-1);
				return version ? [{ path: artifact.sourcePath, version: version.digest }] : [];
			}) ?? [];
		if (JSON.stringify(expected) !== JSON.stringify(binding.files))
			throw new OmpSpecActionRejection("guard.specRun", "Native specification material binding is stale");
		for (const file of binding.files) {
			try {
				if (digest(await readFile(await containedSpecPath(saved!.cwd, file.path))) !== file.version)
					throw new Error("changed");
			} catch {
				throw new OmpSpecActionRejection("guard.specRun", "Native specification material binding is stale");
			}
		}
		assertCurrent();
		if (
			!controller!
				.actions()
				.some(
					action =>
						action.available &&
						(!binding.actionId || action.id === binding.actionId) &&
						(action.command === text ||
							((action.requiresInput || (action.id === "next" && binding.phase === "solution")) &&
								text.startsWith(`${action.command} `) &&
								(action.requiresInput
									? text.slice(action.command.length).trim()
									: /^\S+$/.test(text.slice(action.command.length).trim())))),
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
	}
	async dispose(): Promise<void> {
		await Promise.all([...this.#owners.keys()].map(id => this.detach(id)));
	}
}
