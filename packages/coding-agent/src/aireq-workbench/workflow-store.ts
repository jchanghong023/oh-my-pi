import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { replaceFileAtomically, writeFileAtomically } from "../utils/atomic-file";
import {
	assertKeys,
	buildRequirementSnapshot,
	canonicalJson,
	decodeRequirementPackage,
	digestFiles,
	encodeRequirementPackage,
	safeMaterialPath,
	sha256,
	stableId,
	validatePackageManifest,
} from "./requirement-package";
import { assertSnapshotFiles, AIReqWorkflowGit, listMaterialFiles, readMaterialFiles } from "./workflow-git";
import {
	AIREQ_WORKFLOW_STAGES,
	type AIReqDecodedPackage,
	type AIReqDocument,
	type AIReqMaterialView,
	type AIReqNativeSessionRef,
	type AIReqObjectRef,
	type AIReqOperationReceipt,
	type AIReqPackageManifest,
	type AIReqProject,
	type AIReqProjectState,
	type AIReqRequirementContent,
	type AIReqRequirementGroup,
	type AIReqRequirementSnapshot,
	type AIReqReview,
	type AIReqSystemRequirement,
	type AIReqWorkflowCommand,
	type AIReqWorkflowResult,
	type AIReqWorkflowStage,
	type AIReqWorkflowView,
	type AIReqWorktree,
} from "./workflow-types";

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`${name} is required`);
	return stableId(value);
}
function clone<T>(value: T): T {
	return structuredClone(value);
}
function stateDirectory(project: AIReqProject): string {
	return path.join(project.commonDir, "omp-aireq-workflow-v1");
}
export function requirementRoot(project: AIReqProject, group: AIReqRequirementGroup): string {
	return group.worktree?.path ?? path.join(stateDirectory(project), "drafts", group.id);
}
function groupFor(state: AIReqProjectState, irId: string | undefined): AIReqRequirementGroup {
	const group = state.groups.find(g => g.id === required(irId, "irId"));
	if (!group) throw new Error("Unknown IR");
	if (group.status === "deleted") throw new Error("IR was deleted; retained materials and history are not active");
	return group;
}
function srFor(
	state: AIReqProjectState,
	group: AIReqRequirementGroup,
	srId: string | undefined,
): AIReqSystemRequirement {
	const sr = state.srs.find(s => s.id === required(srId, "srId") && s.irId === group.id);
	if (!sr) throw new Error("Unknown SR or mismatched IR");
	return sr;
}
function assertEditable(group: AIReqRequirementGroup): void {
	if (group.status === "frozen" || group.merge) throw new Error("Entire IR/SR group is frozen");
}
function assertRemovable(state: AIReqProjectState, group: AIReqRequirementGroup): void {
	if (
		state.srs.some(
			sr =>
				sr.irId === group.id &&
				(sr.status !== "pending" ||
					sr.stage !== undefined ||
					sr.worktree !== undefined ||
					sr.round !== 0 ||
					sr.sessions.length > 0 ||
					sr.approvals.length > 0 ||
					sr.materials.length > 0 ||
					sr.materialDigest !== undefined ||
					sr.codePr !== undefined ||
					sr.codeMerge !== undefined ||
					state.activeSrId === sr.id),
		)
	)
		throw new Error("Started SR prevents requirement deletion; development slot remains occupied");
	assertEditable(group);
}
function assertProjectTimestamps(project: { createdAt?: unknown; updatedAt?: unknown }): void {
	for (const value of [project.createdAt, project.updatedAt]) {
		if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
			throw new Error("Project createdAt/updatedAt must be persisted ISO timestamps; old states are not migrated");
	}
}
function validateState(value: unknown): asserts value is AIReqProjectState {
	assertKeys(
		value,
		["version", "project", "revision", "releases", "groups", "srs", "activeSrId", "operations", "owner"],
		"workflow state",
	);
	if (value.version !== 1) throw new Error("Unsupported AIReq state version; old states are not migrated");
	assertKeys(
		value.project,
		[
			"id",
			"name",
			"root",
			"commonDir",
			"revision",
			"createdAt",
			"updatedAt",
			"defaultBranch",
			"remote",
			"repositoryId",
		],
		"project",
	);
	if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)
		throw new Error("Invalid workflow revision");
	const state = value as unknown as AIReqProjectState;
	stableId(state.project.id);
	assertProjectTimestamps(state.project);
	for (const key of ["releases", "groups", "srs", "operations"] as const)
		if (!Array.isArray(state[key])) throw new Error(`Invalid ${key}`);
	validateNestedState(state);
	const unique = (values: string[], label: string) => {
		if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
		for (const id of values) stableId(id);
	};
	unique(
		state.releases.map(r => r.id),
		"Release IDs",
	);
	unique(
		state.groups.map(g => g.id),
		"IR IDs",
	);
	unique(
		state.srs.map(s => s.id),
		"SR IDs",
	);
	unique(
		state.operations.map(o => o.operationId),
		"operation IDs",
	);
	for (const release of state.releases) {
		assertKeys(release, ["id", "projectId", "title", "createdAt"], "release");
		if (release.projectId !== state.project.id || !release.title.trim())
			throw new Error("Invalid Release reference/title");
	}
	for (const group of state.groups) {
		assertKeys(
			group,
			[
				"id",
				"projectId",
				"releaseId",
				"title",
				"documentPath",
				"origin",
				"status",
				"revision",
				"srIds",
				"files",
				"evidenceFiles",
				"retiredFiles",
				"worktree",
				"sessions",
				"snapshot",
				"confirmation",
				"review",
				"requirementsPr",
				"merge",
				"packageId",
				"packageDigest",
				"createdAt",
				"deletion",
			],
			"IR",
		);
		if (group.projectId !== state.project.id || !state.releases.some(r => r.id === group.releaseId))
			throw new Error("Invalid IR project/Release reference");
		if (
			!["draft", "reviewing", "confirmed", "requirements-pr", "frozen", "deleted"].includes(group.status) ||
			!["local", "browser", "import"].includes(group.origin)
		)
			throw new Error("Invalid IR state");
		unique(group.srIds, "IR members");
		if (
			canonicalJson([...group.srIds].sort()) !==
			canonicalJson(
				state.srs
					.filter(s => s.irId === group.id)
					.map(s => s.id)
					.sort(),
			)
		)
			throw new Error("IR/SR membership mismatch");
		if (
			group.status === "frozen" &&
			(!group.snapshot || !group.merge || !group.review?.passed || !group.confirmation)
		)
			throw new Error("Frozen authority incomplete");
		if (group.merge && group.status !== "frozen")
			throw new Error("Merged requirement authority cannot leave the frozen state");
		if (group.status === "deleted") {
			assertRemovable(state, group);
			const receipt = state.operations.find(operation => operation.operationId === group.deletion?.operationId);
			if (
				!group.deletion ||
				!receipt ||
				receipt.type !== "deleteRequirement" ||
				receipt.status !== "completed" ||
				receipt.irId !== group.id ||
				receipt.srId !== undefined ||
				canonicalJson(receipt.deletion) !== canonicalJson(group.deletion)
			)
				throw new Error("Deleted IR requires its exact completed audit receipt");
			if (
				group.deletion.manualCloseNeeded !== Boolean(group.requirementsPr) ||
				group.deletion.requirementsPrUrl !== group.requirementsPr?.url
			)
				throw new Error("Deleted IR must retain the true manual PR closure requirement");
		} else if (group.deletion !== undefined) throw new Error("Deletion tombstone cannot be active");
	}
	for (const sr of state.srs) {
		assertKeys(
			sr,
			[
				"id",
				"projectId",
				"irId",
				"title",
				"documentPath",
				"status",
				"stage",
				"round",
				"worktree",
				"sessions",
				"approvals",
				"materials",
				"materialDigest",
				"codePr",
				"codeMerge",
			],
			"SR",
		);
		if (
			sr.projectId !== state.project.id ||
			!state.groups.some(g => g.id === sr.irId) ||
			!["pending", "developing", "completed"].includes(sr.status) ||
			!Number.isSafeInteger(sr.round) ||
			sr.round < 0
		)
			throw new Error("Invalid SR reference/state");
		if (sr.stage && !AIREQ_WORKFLOW_STAGES.includes(sr.stage)) throw new Error("Unknown SR stage");
		if (sr.status === "developing" && (!sr.stage || !sr.worktree || state.activeSrId !== sr.id))
			throw new Error("SR slot/worktree mismatch");
	}
	if (
		state.srs.filter(s => s.status === "developing").length > 1 ||
		(state.activeSrId && !state.srs.some(s => s.id === state.activeSrId && s.status === "developing"))
	)
		throw new Error("Project-wide SR development slot conflict");
	for (const operation of state.operations) {
		assertKeys(
			operation,
			[
				"operationId",
				"commandDigest",
				"type",
				"status",
				"startedAt",
				"completedAt",
				"revision",
				"irId",
				"srId",
				"steps",
				"error",
				"deletion",
			],
			"operation",
		);
		if (!["running", "completed", "failed"].includes(operation.status) || !Array.isArray(operation.steps))
			throw new Error("Invalid operation receipt");
		if (
			operation.deletion !== undefined &&
			(operation.type !== "deleteRequirement" ||
				operation.status !== "completed" ||
				operation.deletion.operationId !== operation.operationId ||
				operation.srId !== undefined ||
				operation.completedAt !== operation.deletion.deletedAt ||
				!state.groups.some(
					group =>
						group.id === operation.irId &&
						group.status === "deleted" &&
						canonicalJson(group.deletion) === canonicalJson(operation.deletion),
				))
		)
			throw new Error("Invalid deletion receipt authority");
		if (operation.type === "deleteRequirement" && operation.status === "completed" && !operation.deletion)
			throw new Error("Completed deletion requires retained tombstone result");
	}
}
async function readJson(file: string): Promise<unknown> {
	return JSON.parse(await fs.readFile(file, "utf8"));
}
async function withLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
	await fs.mkdir(path.dirname(directory), { recursive: true });
	try {
		await fs.mkdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(`AIReq state is locked; unknown old-host work is not automatically taken over: ${directory}`);
		throw error;
	}
	try {
		await fs.writeFile(
			path.join(directory, "owner.json"),
			JSON.stringify({ hostname: os.hostname(), processId: process.pid, createdAt: now() }),
			{ flag: "wx", mode: 0o600 },
		);
		return await action();
	} finally {
		await fs.rm(directory, { recursive: true });
	}
}
export interface AIReqMutationContext {
	state: AIReqProjectState;
	receipt: AIReqOperationReceipt;
	step(name: string, detail: string): Promise<void>;
}
export class AIReqWorkflowStore {
	constructor(readonly registryDirectory: string) {}
	async listProjects(): Promise<AIReqProject[]> {
		try {
			const raw = await readJson(path.join(this.registryDirectory, "registry-v1.json"));
			assertKeys(raw, ["version", "projects"], "registry");
			if (raw.version !== 1 || !Array.isArray(raw.projects)) throw new Error("Unsupported AIReq registry");
			for (const project of raw.projects) {
				assertKeys(
					project,
					[
						"id",
						"name",
						"root",
						"commonDir",
						"revision",
						"createdAt",
						"updatedAt",
						"defaultBranch",
						"remote",
						"repositoryId",
					],
					"registered project",
				);
				stableId(project.id as string);
				assertProjectTimestamps(project);
				if (
					typeof project.name !== "string" ||
					!project.name.trim() ||
					typeof project.root !== "string" ||
					!path.isAbsolute(project.root) ||
					typeof project.commonDir !== "string" ||
					!path.isAbsolute(project.commonDir)
				)
					throw new Error("Invalid registered project identity");
			}
			if (
				new Set(raw.projects.map(p => p.id)).size !== raw.projects.length ||
				new Set(raw.projects.map(p => p.commonDir)).size !== raw.projects.length
			)
				throw new Error("Duplicate registered project identity");
			return raw.projects as AIReqProject[];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}
	async registerProject(root: string, name: string): Promise<AIReqProject> {
		if (!name.trim()) throw new Error("Project name required");
		const inspected = await new AIReqWorkflowGit().inspect(root);
		return withLock(path.join(this.registryDirectory, "registry.lock"), async () => {
			const projects = await this.listProjects();
			const existing = projects.find(p => p.commonDir === inspected.commonDir);
			if (existing) return existing;
			const registeredAt = now();
			const project: AIReqProject = {
				...inspected,
				id: `project-${sha256(inspected.commonDir).slice(0, 24)}`,
				name: name.trim(),
				revision: 0,
				createdAt: registeredAt,
				updatedAt: registeredAt,
			};
			const directory = stateDirectory(project);
			await fs.mkdir(directory, { recursive: true });
			const file = path.join(directory, "state.json");
			let state: AIReqProjectState;
			try {
				const saved = await readJson(file);
				validateState(saved);
				state = saved;
				if (state.project.id !== project.id) throw new Error("Shared project identity conflict");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				state = { version: 1, project, revision: 0, releases: [], groups: [], srs: [], operations: [] };
				await writeFileAtomically(file, JSON.stringify(state));
			}
			projects.push(state.project);
			await writeFileAtomically(
				path.join(this.registryDirectory, "registry-v1.json"),
				JSON.stringify({ version: 1, projects }),
			);
			return state.project;
		});
	}
	async read(projectId: string): Promise<AIReqProjectState> {
		stableId(projectId);
		const project = (await this.listProjects()).find(p => p.id === projectId);
		if (!project) throw new Error("Project is not registered");
		const state = await readJson(path.join(stateDirectory(project), "state.json"));
		validateState(state);
		if (state.project.id !== projectId || state.project.commonDir !== project.commonDir)
			throw new Error("Project identity does not match registry");
		return state;
	}
	async mutate(
		projectId: string,
		expectedRevision: number,
		operationId: string,
		command: unknown,
		effect: (context: AIReqMutationContext) => Promise<void>,
	): Promise<AIReqWorkflowResult> {
		stableId(operationId);
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid expectedRevision");
		const original = await this.read(projectId);
		const directory = stateDirectory(original.project);
		return withLock(path.join(directory, "mutation.lock"), async () => {
			const state = await this.read(projectId);
			const commandDigest = sha256(canonicalJson(command));
			let receipt = state.operations.find(o => o.operationId === operationId);
			const result = (): AIReqWorkflowResult => ({
				operationId,
				projectId,
				revision: receipt!.revision,
				irId: receipt!.irId,
				srId: receipt!.srId,
				status: receipt!.status,
				receipt: clone(receipt!),
				error: receipt!.error,
			});
			if (receipt) {
				if (receipt.commandDigest !== commandDigest) throw new Error("operationId reused with a different command");
				if (receipt.status === "completed") return result();
				if (receipt.status === "running")
					throw new Error("Previous operation has unknown unsettled effects; explicit host settlement required");
				if (state.revision !== receipt.revision)
					throw new Error("Project advanced after failed operation; cannot resume against different state");
			} else {
				if (state.revision !== expectedRevision)
					throw new Error(`Revision conflict: expected ${expectedRevision}, actual ${state.revision}`);
				if (state.owner || state.operations.some(o => o.status === "running"))
					throw new Error("Unknown old-host work blocks mutation");
				receipt = {
					operationId,
					commandDigest,
					type: (command as { type?: string }).type ?? "nativeUpdate",
					status: "running",
					startedAt: now(),
					revision: state.revision,
					steps: [],
				};
				state.operations.push(receipt);
			}
			if (state.owner) throw new Error("Another host owns unsettled project work");
			state.owner = { hostname: os.hostname(), processId: process.pid, token: newId(), acquiredAt: now() };
			receipt.status = "running";
			delete receipt.error;
			const persist = async () => {
				state.revision++;
				state.project.revision = state.revision;
				state.project.updatedAt = now();
				receipt!.revision = state.revision;
				validateState(state);
				await writeFileAtomically(path.join(directory, "state.json"), JSON.stringify(state));
			};
			await persist();
			try {
				await effect({
					state,
					receipt,
					step: async (name, detail) => {
						const prior = receipt!.steps.find(s => s.name === name);
						if (prior) {
							if (prior.detail !== detail) throw new Error(`Operation checkpoint conflict: ${name}`);
							return;
						}
						receipt!.steps.push({ name, detail, at: now() });
						await persist();
					},
				});
				receipt.status = "completed";
				receipt.completedAt = now();
			} catch (error) {
				receipt.status = "failed";
				receipt.error = errorText(error);
			}
			delete state.owner;
			await persist();
			return result();
		});
	}
	/** Settlement precedes the single durable tombstone/receipt write; failures retain the original domain objects. */
	async deleteRequirement(
		command: Extract<AIReqWorkflowCommand, { type: "deleteRequirement" }>,
		settle: () => Promise<void>,
		admittedRevision?: number,
	): Promise<AIReqWorkflowResult> {
		validateCommand(command);
		if (command.type !== "deleteRequirement") throw new Error("Explicit deleteRequirement command required");
		if (
			admittedRevision !== undefined &&
			(!Number.isSafeInteger(admittedRevision) || admittedRevision < command.expectedRevision)
		)
			throw new Error("Invalid host settlement admission revision");
		const { projectId, irId, operationId } = command;
		const initial = await this.read(projectId);
		return withLock(path.join(stateDirectory(initial.project), "mutation.lock"), async () => {
			const original = await this.read(projectId);
			const commandDigest = sha256(canonicalJson(command));
			const prior = original.operations.find(operation => operation.operationId === operationId);
			const result = (receipt: AIReqOperationReceipt): AIReqWorkflowResult => ({
				operationId,
				projectId,
				irId: receipt.irId,
				revision: receipt.revision,
				status: receipt.status,
				receipt: clone(receipt),
				deletion: receipt.deletion ? clone(receipt.deletion) : undefined,
				error: receipt.error,
			});
			if (prior) {
				if (prior.commandDigest !== commandDigest) throw new Error("operationId reused with a different command");
				if (prior.status === "completed") return result(prior);
				if (prior.status === "running")
					throw new Error("Previous operation has unknown unsettled effects; explicit host settlement required");
				if (original.revision !== prior.revision)
					throw new Error("Project advanced after failed operation; cannot resume against different state");
			} else if (original.revision !== (admittedRevision ?? command.expectedRevision))
				throw new Error(`Revision conflict: expected ${command.expectedRevision}, actual ${original.revision}`);
			if (original.owner || original.operations.some(operation => operation.status === "running"))
				throw new Error("Unknown old-host work blocks mutation");
			const receipt: AIReqOperationReceipt = prior
				? clone(prior)
				: {
						operationId,
						commandDigest,
						type: "deleteRequirement",
						status: "running",
						startedAt: now(),
						revision: original.revision,
						irId,
						steps: [],
					};
			delete receipt.error;
			delete receipt.completedAt;
			let next = clone(original);
			try {
				const group = groupFor(next, irId);
				assertRemovable(next, group);
				await settle();
				const deletedAt = now();
				const deletion = {
					version: 1 as const,
					operationId,
					deletedAt,
					manualCloseNeeded: Boolean(group.requirementsPr),
					...(group.requirementsPr ? { requirementsPrUrl: group.requirementsPr.url } : {}),
				};
				group.status = "deleted";
				group.deletion = deletion;
				group.revision++;
				receipt.status = "completed";
				receipt.completedAt = deletedAt;
				receipt.deletion = deletion;
				receipt.steps = [
					{ name: "owned-ir-settled", at: deletedAt, detail: irId },
					{
						name: "requirement-deleted",
						at: deletedAt,
						detail: "Navigation/admission removed; files, Git branches/worktrees and native history retained",
					},
				];
			} catch (error) {
				next = clone(original);
				receipt.status = "failed";
				receipt.error = errorText(error);
				delete receipt.deletion;
			}
			next.operations = next.operations.filter(operation => operation.operationId !== operationId);
			next.operations.push(receipt);
			next.revision++;
			next.project.revision = next.revision;
			next.project.updatedAt = now();
			receipt.revision = next.revision;
			validateState(next);
			await writeFileAtomically(path.join(stateDirectory(next.project), "state.json"), JSON.stringify(next));
			return result(receipt);
		});
	}
	async view(projectId?: string): Promise<AIReqWorkflowView> {
		const registered = await this.listProjects();
		const projects: AIReqProject[] = [];
		for (const p of registered) projects.push((await this.read(p.id)).project);
		const empty: AIReqWorkflowView = {
			version: 1,
			revision: 0,
			projects,
			releases: [],
			groups: [],
			drafts: [],
			srs: [],
			materials: [],
			operations: [],
			sessions: [],
			running: [],
		};
		if (!projectId) return empty;
		const state = await this.read(projectId);
		const groups = state.groups.filter(group => group.status !== "deleted");
		const srs = state.srs.filter(sr => groups.some(group => group.id === sr.irId));
		const formal = groups.filter(g => ["confirmed", "requirements-pr", "frozen"].includes(g.status));
		const materials: AIReqMaterialView[] = [];
		for (const group of groups)
			for (const file of [...group.files, ...(group.evidenceFiles ?? [])])
				materials.push({
					...file,
					projectId,
					irId: group.id,
					kind:
						file.path === group.documentPath
							? "ir"
							: srs.some(s => s.irId === group.id && s.documentPath === file.path)
								? "sr"
								: "attachment",
					srId: srs.find(s => s.irId === group.id && s.documentPath === file.path)?.id,
					valid: true,
				});
		for (const sr of srs) {
			if (sr.stage)
				sr.materialDigest = digestFiles(
					sr.materials
						.filter(m => m.stage === sr.stage && m.round === sr.round && m.valid)
						.map(({ path, sha256, size }) => ({ path, sha256, size })),
				);
			for (const m of sr.materials)
				materials.push({ ...m, projectId, irId: sr.irId, srId: sr.id, kind: m.kind, valid: m.valid });
		}
		const changes: NonNullable<AIReqWorkflowView["changes"]> = [];
		let changeError: string | undefined;
		for (const sr of srs)
			if (sr.status === "developing" && sr.worktree) {
				try {
					for (const file of await new AIReqWorkflowGit().changes(sr.worktree))
						changes.push({ ...file, projectId, irId: sr.irId, srId: sr.id });
				} catch (error) {
					changeError = errorText(error);
				}
			}
		return {
			...empty,
			// Registry iteration and this read may straddle a mutation. The
			// selected project's metadata must come from this exact state too.
			projects: projects.map(project => (project.id === projectId ? state.project : project)),
			revision: state.revision,
			currentProjectId: projectId,
			releases: state.releases,
			groups: formal,
			drafts: groups.filter(g => !formal.includes(g)),
			srs,
			materials,
			operations: state.operations,
			sessions: [...groups.flatMap(g => g.sessions), ...srs.flatMap(s => s.sessions)],
			activeSrId: state.activeSrId,
			changes,
			error: changeError,
		};
	}
}
export interface AIReqWorkflowPorts {
	review(input: {
		ref: AIReqObjectRef;
		snapshot: AIReqRequirementSnapshot;
		documents: Map<string, Uint8Array>;
		operationId: string;
	}): Promise<AIReqReview>;
	settle(ref: AIReqObjectRef, reason: string): Promise<void>;
	start(input: {
		ref: AIReqObjectRef;
		stage: "requirements" | AIReqWorkflowStage;
		round: number;
		worktree?: AIReqWorktree;
		snapshot?: AIReqRequirementSnapshot;
		operationId: string;
	}): Promise<AIReqNativeSessionRef>;
}
export interface AIReqStageDocument extends AIReqDocument {
	kind: "solution" | "plan" | "completion" | "ut" | "st" | "delivery";
}
export class AIReqWorkflowService {
	constructor(
		readonly store: AIReqWorkflowStore,
		readonly git: AIReqWorkflowGit,
		readonly ports: AIReqWorkflowPorts,
	) {}
	/** Validate control authority before aborting work, without waiting on that work's mutation lock. */
	async assertSettlement(command: AIReqWorkflowCommand, state: AIReqProjectState): Promise<void> {
		validateCommand(command);
		if (!["stop", "backStage", "deleteRequirement"].includes(command.type))
			throw new Error("Explicit workflow settlement command required");
		if (state.project.id !== command.projectId) throw new Error("Settlement project mismatch");
		if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)
			throw new Error("Invalid expectedRevision");
		const prior = state.operations.find(receipt => receipt.operationId === command.operationId);
		if (prior && prior.commandDigest !== sha256(canonicalJson(command)))
			throw new Error("Operation identity conflict");
		if (prior?.status === "completed") return;
		if (
			prior?.status === "running" ||
			state.revision !== (prior?.status === "failed" ? prior.revision : command.expectedRevision)
		)
			throw new Error(
				`Stale workflow control revision: expected ${command.expectedRevision}, actual ${state.revision}` +
					(prior ? `; prior operation ${prior.status} at revision ${prior.revision}` : ""),
			);
		const group = groupFor(state, command.irId);
		if (command.type === "deleteRequirement") {
			if (group.status === "reviewing") throw new Error("This IR cannot be removed");
			assertRemovable(state, group);
			return;
		}
		if (command.type === "stop" && !command.srId) return;
		const sr = srFor(state, group, command.srId);
		if (sr.status !== "developing" || state.activeSrId !== sr.id || !sr.worktree || !sr.stage)
			throw new Error("SR is not the active developing SR");
		await this.#assertFrozen(state, group);
		await assertSnapshotFiles(sr.worktree.path, group.snapshot!);
		if (
			command.type === "backStage" &&
			!prior?.steps.some(step => step.name === "back") &&
			AIREQ_WORKFLOW_STAGES.indexOf(command.stage) >= AIREQ_WORKFLOW_STAGES.indexOf(sr.stage)
		)
			throw new Error("Back requires an earlier stage");
	}
	/** admittedRevision is host-only, after a serialized stop/back/delete admission and native settlement. */
	async command(command: AIReqWorkflowCommand, admittedRevision?: number): Promise<AIReqWorkflowResult> {
		validateCommand(command);
		if (
			admittedRevision !== undefined &&
			(!["stop", "backStage", "deleteRequirement"].includes(command.type) ||
				!Number.isSafeInteger(admittedRevision) ||
				admittedRevision < command.expectedRevision)
		)
			throw new Error("Invalid host settlement admission revision");
		if (command.type === "registerProject") {
			const project = await this.store.registerProject(command.root, command.name);
			const target = await this.store.read(project.id);
			return this.store.mutate(
				project.id,
				target.revision,
				command.operationId,
				{ ...command, root: project.root },
				async () => {},
			);
		}
		const projectId = required(command.projectId, "projectId");
		if (command.type === "importPackage")
			throw new Error("Binary package must be decoded and passed to importPackage");
		if (command.type === "deleteRequirement")
			return this.store.deleteRequirement(
				command,
				() => this.ports.settle({ projectId, irId: command.irId }, "delete-requirement"),
				admittedRevision,
			);
		return this.store.mutate(
			projectId,
			admittedRevision ?? command.expectedRevision,
			command.operationId,
			command,
			async context => {
				const { state, receipt, step } = context;
				if (command.type === "createRelease") {
					if (!command.title.trim()) throw new Error("Release title required");
					const id = receipt.steps.find(s => s.name === "release-id")?.detail ?? newId();
					await step("release-id", id);
					if (!state.releases.some(r => r.id === id))
						state.releases.push({ id, projectId, title: command.title.trim(), createdAt: now() });
					return;
				}
				if (command.type === "createLocalDraft" || command.type === "createBrowserDraft") {
					if (!state.releases.some(r => r.id === command.releaseId))
						throw new Error("Select a registered Release");
					const id = receipt.steps.find(s => s.name === "ir-id")?.detail ?? newId();
					receipt.irId = id;
					await step("ir-id", id);
					let group = state.groups.find(g => g.id === id);
					if (group?.status === "deleted")
						throw new Error("IR was deleted; a failed draft operation cannot revive its retained stable ID");
					if (!group) {
						group = {
							id,
							projectId,
							releaseId: command.releaseId,
							title: "",
							documentPath: `docs/aireq/requirements/${id}/ir.md`,
							origin: command.type === "createLocalDraft" ? "local" : "browser",
							status: "draft",
							revision: 0,
							srIds: [],
							files: [],
							sessions: [],
							createdAt: now(),
						};
						state.groups.push(group);
					}
					await step("group-created", group.id);
					if (command.type === "createLocalDraft" && !group.worktree) {
						group.worktree = await this.git.createWorktree(
							state.project,
							"requirements",
							id,
							command.operationId,
						);
						await step("worktree", JSON.stringify(group.worktree));
					}
					if (!group.sessions.length) {
						const session = await this.ports.start({
							ref: { projectId, irId: id },
							stage: "requirements",
							round: 0,
							worktree: group.worktree,
							operationId: command.operationId,
						});
						await assertSession(session, { projectId, irId: id }, "requirements", 0);
						group.sessions.push(session);
						await step("session", session.sessionId);
					}
					return;
				}
				if (
					command.srId &&
					(["confirmRequirements", "markRequirementsPrSubmitted", "markRequirementsMerged"].includes(
						command.type,
					) ||
						(command.type === "publishMaterials" && command.scope === "requirements"))
				)
					throw new Error("IR requirement action must not be bound to an SR");
				const group = groupFor(state, command.irId);
				receipt.irId = group.id;
				const ref: AIReqObjectRef = { projectId, irId: group.id, ...(command.srId ? { srId: command.srId } : {}) };
				if (command.type === "confirmRequirements") {
					assertEditable(group);
					try {
						if (!group.snapshot || group.snapshot.digest !== command.snapshotDigest)
							throw new Error("Requirements changed; confirm current snapshot");
						if (receipt.steps.some(s => s.name === "review-invalidated"))
							throw new Error(
								"Review snapshot changed; edit current materials and explicitly confirm with a new operation",
							);
						const snapshot = clone(group.snapshot);
						const root = requirementRoot(state.project, group);
						try {
							await assertSnapshotFiles(root, snapshot);
						} catch (error) {
							if (receipt.steps.some(s => s.name === "review-result"))
								await step("review-invalidated", snapshot.digest);
							throw error;
						}
						const documents = await readMaterialFiles(
							root,
							snapshot.files.map(f => f.path),
						);
						group.status = "reviewing";
						delete group.review;
						const savedConfirmation = receipt.steps.find(s => s.name === "confirmation-record");
						group.confirmation = savedConfirmation
							? JSON.parse(savedConfirmation.detail)
							: { operationId: command.operationId, snapshotDigest: snapshot.digest, confirmedAt: now() };
						await step("confirmation", snapshot.digest);
						await step("confirmation-record", JSON.stringify(group.confirmation));
						const savedReview = receipt.steps.find(s => s.name === "review-result");
						const review: AIReqReview = savedReview
							? JSON.parse(savedReview.detail)
							: await this.ports.review({
									ref,
									snapshot: clone(snapshot),
									documents,
									operationId: command.operationId,
								});
						if (!savedReview) await step("review-result", JSON.stringify(review));
						if (
							review.snapshotDigest !== snapshot.digest ||
							typeof review.passed !== "boolean" ||
							review.reviewer.role !== "reviewer" ||
							!("irId" in review.reviewer) ||
							review.reviewer.irId !== group.id ||
							review.reviewer.projectId !== projectId ||
							review.reviewer.srId !== undefined ||
							review.reviewer.phase !== "requirements" ||
							group.sessions.some(s => s.sessionId === review.reviewer.sessionId) ||
							!review.report.trim()
						)
							throw new Error("Review does not bind independent native reviewer to exact snapshot");
						await fs.access(review.reviewer.sessionFile);
						try {
							await assertSnapshotFiles(root, snapshot);
						} catch (error) {
							await step("review-invalidated", snapshot.digest);
							throw error;
						}
						group.review = review;
						group.status = review.passed ? "confirmed" : "draft";
						if (!review.passed) delete group.confirmation;
						if (review.passed) await saveReviewEvidence(state.project, group);
						await step("review", review.id);
						return;
					} catch (error) {
						group.status = "draft";
						delete group.confirmation;
						delete group.review;
						delete group.requirementsPr;
						delete group.evidenceFiles;
						throw error;
					}
				}
				if (command.type === "markRequirementsPrSubmitted") {
					if (group.status === "frozen" || group.merge)
						throw new Error("Frozen requirements cannot register or change PR submission");
					await this.#assertConfirmed(state, group);
					if (!group.worktree || !state.project.remote)
						throw new Error("Local requirement branch and company remote required");
					await this.git.verifyPublished(state.project, group.worktree, [
						...group.files,
						...(group.evidenceFiles ?? []),
						...(group.retiredFiles ?? []),
					]);
					const latest = await this.git.latestDefault(state.project);
					group.requirementsPr = prFact(command.url, group.worktree.branch, latest.branch);
					group.status = "requirements-pr";
					return;
				}
				if (command.type === "markRequirementsMerged") {
					if (group.status === "frozen") {
						await this.#assertFrozen(state, group);
						return;
					}
					await this.#assertConfirmed(state, group);
					if (!group.requirementsPr) throw new Error("Register manual requirements PR before merge");
					await this.ports.settle(ref, "requirements-frozen");
					await this.#assertConfirmed(state, group);
					group.merge = await this.git.verifyMerged(
						state.project,
						group.snapshot!,
						group.evidenceFiles,
						group.retiredFiles,
					);
					group.status = "frozen";
					await step("requirements-merged", group.merge.commit);
					return;
				}
				if (command.type === "publishMaterials" && command.scope === "requirements") {
					if (group.status === "frozen") throw new Error("Frozen requirement branch cannot publish edits");
					await this.#assertConfirmed(state, group);
					if (!group.worktree) throw new Error("Browser drafts do not operate Git");
					const versions = [...group.files, ...(group.evidenceFiles ?? []), ...(group.retiredFiles ?? [])];
					if (canonicalJson([...command.paths].sort()) !== canonicalJson(versions.map(f => f.path).sort()))
						throw new Error(
							"Publish must include the exact complete confirmed requirement set, review evidence and owned retired paths",
						);
					if (
						command.versions &&
						canonicalJson([...command.versions].sort((a, b) => a.path.localeCompare(b.path))) !==
							canonicalJson([...versions].sort((a, b) => a.path.localeCompare(b.path)))
					)
						throw new Error("Selected requirement file/deletion versions changed");
					await this.ports.settle(ref, "publish-requirements");
					await this.#assertConfirmed(state, group);
					await this.git.publish(
						state.project,
						group.worktree,
						command.paths,
						command.message,
						command.push,
						receipt,
						step,
						versions,
					);
					return;
				}
				if (command.type === "stop" && !command.srId) {
					await this.ports.settle(ref, "stop");
					return;
				}
				const sr = srFor(state, group, command.srId);
				receipt.srId = sr.id;
				if (command.type === "startSr") {
					await this.#assertFrozen(state, group);
					if (sr.status !== "pending" && !receipt.steps.some(s => s.name === "worktree"))
						throw new Error("SR already started or completed");
					if (state.activeSrId && state.activeSrId !== sr.id)
						throw new Error("Another SR holds this project's development slot");
					// Reserve before native start; failures retain this slot and real worktree.
					if (!sr.worktree)
						sr.worktree = await this.git.createWorktree(
							state.project,
							"development",
							sr.id,
							command.operationId,
							{
								snapshot: group.snapshot!,
								evidenceFiles: group.evidenceFiles,
								retiredFiles: group.retiredFiles,
							},
						);
					sr.stage = "solution";
					sr.round = 1;
					sr.status = "developing";
					state.activeSrId = sr.id;
					await step("worktree", JSON.stringify(sr.worktree));
					const session = await this.ports.start({
						ref,
						stage: sr.stage,
						round: sr.round,
						worktree: sr.worktree,
						snapshot: group.snapshot,
						operationId: command.operationId,
					});
					await assertSession(session, ref, sr.stage, sr.round);
					sr.sessions.push(session);
					await step("session", session.sessionId);
					return;
				}
				if (sr.status !== "developing" || state.activeSrId !== sr.id || !sr.worktree || !sr.stage)
					throw new Error("SR is not the active developing SR");
				await this.#assertFrozen(state, group);
				await assertSnapshotFiles(sr.worktree.path, group.snapshot!);
				if (command.type === "stop") {
					await this.ports.settle(ref, "stop");
					return;
				}
				if (command.type === "backStage") {
					if (!receipt.steps.some(s => s.name === "back")) {
						if (AIREQ_WORKFLOW_STAGES.indexOf(command.stage) >= AIREQ_WORKFLOW_STAGES.indexOf(sr.stage))
							throw new Error("Back requires an earlier stage");
						await this.ports.settle(ref, "back");
						await this.#assertFrozen(state, group);
						await assertSnapshotFiles(sr.worktree.path, group.snapshot!);
						const previous = sr.stage;
						sr.stage = command.stage;
						sr.round++;
						delete sr.codePr;
						delete sr.materialDigest;
						const cutoff = AIREQ_WORKFLOW_STAGES.indexOf(command.stage);
						sr.approvals = sr.approvals.filter(a => AIREQ_WORKFLOW_STAGES.indexOf(a.stage) < cutoff);
						for (const material of sr.materials)
							if (AIREQ_WORKFLOW_STAGES.indexOf(material.stage) >= cutoff) material.valid = false;
						await step("back", `${previous}->${sr.stage}:${sr.round}`);
					}
					const session = await this.ports.start({
						ref,
						stage: sr.stage,
						round: sr.round,
						worktree: sr.worktree,
						snapshot: group.snapshot,
						operationId: command.operationId,
					});
					await assertSession(session, ref, sr.stage, sr.round);
					if (!sr.sessions.some(s => s.sessionId === session.sessionId)) sr.sessions.push(session);
					return;
				}
				if (command.type === "approveStage") {
					if (receipt.steps.some(s => s.name === "approved")) {
						await this.#assertApprovals(sr);
						const session = await this.ports.start({
							ref,
							stage: sr.stage,
							round: sr.round,
							worktree: sr.worktree,
							snapshot: group.snapshot,
							operationId: command.operationId,
						});
						await assertSession(session, ref, sr.stage, sr.round);
						if (!sr.sessions.some(s => s.sessionId === session.sessionId)) sr.sessions.push(session);
						return;
					}
					if (command.stage !== sr.stage || command.round !== sr.round || sr.stage === "pr")
						throw new Error("Stale stage approval");
					await this.#assertApprovals(sr);
					const materials = await currentMaterials(sr);
					const digest = digestFiles(materials);
					if (digest !== command.materialDigest) throw new Error("Stage material version changed");
					const kinds = sr.materials
						.filter(m => m.valid && m.round === sr.round && m.stage === sr.stage)
						.map(m => m.kind);
					const needed =
						sr.stage === "solution"
							? ["solution"]
							: sr.stage === "planning"
								? ["plan"]
								: ["completion", "ut", "st"];
					if (needed.some(k => !kinds.includes(k as (typeof kinds)[number])))
						throw new Error(`Missing required materials: ${needed.join(", ")}`);
					await this.ports.settle(ref, "approve-stage");
					await this.#assertFrozen(state, group);
					await assertSnapshotFiles(sr.worktree.path, group.snapshot!);
					await this.#assertApprovals(sr);
					await currentMaterials(sr);
					sr.approvals.push({
						stage: sr.stage,
						round: sr.round,
						operationId: command.operationId,
						digest,
						files: materials,
						approvedAt: now(),
					});
					sr.stage = AIREQ_WORKFLOW_STAGES[AIREQ_WORKFLOW_STAGES.indexOf(sr.stage) + 1];
					delete sr.materialDigest;
					await step("approved", `${command.stage}:${digest}`);
					const session = await this.ports.start({
						ref,
						stage: sr.stage,
						round: sr.round,
						worktree: sr.worktree,
						snapshot: group.snapshot,
						operationId: command.operationId,
					});
					await assertSession(session, ref, sr.stage, sr.round);
					sr.sessions.push(session);
					return;
				}
				if (command.type === "publishMaterials") {
					await this.ports.settle(ref, "publish-development");
					await this.#assertFrozen(state, group);
					await assertSnapshotFiles(sr.worktree.path, group.snapshot!);
					await this.#assertApprovals(sr);
					const formal = new Set(
						sr.materials.flatMap(m => [m.path, materialHistoryPath(sr.id, m.sha256, m.path)]),
					);
					for (const file of command.paths) {
						safeMaterialPath(file);
						if (file.startsWith("docs/aireq/") && !formal.has(file))
							throw new Error("Publish scope touches frozen, runtime or another object's formal files");
						if (!formal.has(file) && !["executing", "pr"].includes(sr.stage))
							throw new Error("Implementation publishing is not authorized in solution/planning");
					}
					if (
						!Array.isArray(command.versions) ||
						command.versions.length !== command.paths.length ||
						new Set(command.versions.map(f => f.path)).size !== command.paths.length ||
						command.paths.some(p => !command.versions!.some(f => f.path === p))
					)
						throw new Error("Explicit development file versions required for every selected path");
					if (
						!receipt.steps.some(s => s.name === "commit") &&
						!(await this.git.operationCommit(sr.worktree, command.operationId))
					) {
						const changes = await this.git.changes(sr.worktree);
						for (const version of command.versions) {
							const actual = changes.find(c => c.path === version.path);
							if (!actual || actual.sha256 !== version.sha256 || actual.size !== version.size)
								throw new Error(`Selected implementation/material bytes changed: ${version.path}`);
						}
						await step("development-files", digestFiles(command.versions));
					}
					await this.git.publish(
						state.project,
						sr.worktree,
						command.paths,
						command.message,
						command.push,
						receipt,
						step,
					);
					return;
				}
				if (command.type === "markCodePrSubmitted") {
					if (sr.stage !== "pr") throw new Error("Code PR requires delivery stage");
					await this.#assertApprovals(sr);
					await this.git.verifyPublished(
						state.project,
						sr.worktree,
						sr.materials.filter(m => m.valid),
						true,
					);
					const latest = await this.git.latestDefault(state.project);
					sr.codePr = prFact(command.url, sr.worktree.branch, latest.branch);
					return;
				}
				if (command.type === "markCodeMerged") {
					if (sr.stage !== "pr" || !sr.codePr)
						throw new Error("Manual code PR must be registered before code merge");
					await this.#assertApprovals(sr);
					await this.ports.settle(ref, "code-merged");
					await this.#assertFrozen(state, group);
					await assertSnapshotFiles(sr.worktree.path, group.snapshot!);
					await this.#assertApprovals(sr);
					sr.codeMerge = await this.git.verifyCodeMerged(state.project, sr.worktree);
					sr.status = "completed";
					delete state.activeSrId;
					await step("code-merged", sr.codeMerge.commit);
					return;
				}
				throw new Error(`Unsupported workflow command: ${command.type}`);
			},
		);
	}
	async updateRequirements(
		ref: AIReqObjectRef,
		expectedRevision: number,
		operationId: string,
		content: AIReqRequirementContent,
	): Promise<AIReqWorkflowResult> {
		if (ref.srId !== undefined) throw new Error("Only the IR requirements actor can update the complete IR/SR group");
		const normalized = clone(content);
		const metadataPath = `docs/aireq/requirements/${ref.irId}/requirements.json`;
		if (normalized.attachments.some(a => a.path === metadataPath))
			throw new Error("Requirement metadata is domain-owned");
		normalized.attachments.push({
			path: metadataPath,
			content: canonicalJson({
				version: 1,
				irId: ref.irId,
				title: content.title,
				documentPath: content.document.path,
				srs: content.srs.map(s => ({ id: s.id, title: s.title, documentPath: s.document.path })),
			}),
		});
		const snapshot = buildRequirementSnapshot(ref.projectId, ref.irId, normalized);
		return this.store.mutate(
			ref.projectId,
			expectedRevision,
			operationId,
			{ type: "updateRequirements", ref, snapshot },
			async ({ state, receipt, step }) => {
				const group = groupFor(state, ref.irId);
				assertEditable(group);
				receipt.irId = group.id;
				for (const sr of normalized.srs) {
					const existing = state.srs.find(s => s.id === sr.id);
					if (existing && existing.irId !== group.id) throw new Error("SR ID belongs to another IR");
				}
				if (
					group.snapshot &&
					(group.snapshot.digest === snapshot.digest ||
						(group.origin === "import" &&
							buildRequirementSnapshot(group.snapshot.projectId, group.id, normalized).digest ===
								group.snapshot.digest))
				) {
					await assertSnapshotFiles(requirementRoot(state.project, group), group.snapshot);
					return;
				}
				group.status = "draft";
				delete group.confirmation;
				delete group.review;
				delete group.requirementsPr;
				delete group.evidenceFiles;
				await step("requirements-edit", snapshot.digest);
				const root = requirementRoot(state.project, group);
				await fs.mkdir(root, { recursive: true });
				// Every prior snapshot is already immutable on disk. Retire only removed owned paths.
				const retiredFiles = (group.retiredFiles ?? []).filter(
					file => !snapshot.files.some(next => next.path === file.path),
				);
				for (const file of group.files.filter(old => !snapshot.files.some(next => next.path === old.path))) {
					const target = path.join(stateDirectory(state.project), "history", group.id, operationId, file.path);
					let bytes: Uint8Array;
					try {
						bytes = (await readMaterialFiles(root, [file.path])).get(file.path)!;
						if (receipt.steps.some(checkpoint => checkpoint.name === `retired:${file.path}`))
							throw new Error(`Retired material reappeared; refusing stale retry: ${file.path}`);
						if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
							throw new Error(`Owned material changed before retirement: ${file.path}`);
						try {
							await fs.lstat(target);
							throw new Error(`Retired material reappeared after archival: ${file.path}`);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						}
						await fs.mkdir(path.dirname(target), { recursive: true });
						await fs.rename(path.join(root, file.path), target);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
					bytes = await fs.readFile(target);
					if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
						throw new Error(`Retired material history changed: ${file.path}`);
					if (!retiredFiles.some(old => old.path === file.path))
						retiredFiles.push({ path: file.path, sha256: sha256(""), size: -1 });
					await step(`retired:${file.path}`, file.sha256);
				}
				for (const doc of [
					normalized.document,
					...normalized.srs.map(s => s.document),
					...normalized.attachments,
				]) {
					await checkpointMaterial(root, doc, receipt, step, "file");
					await checkpointMaterial(
						path.join(stateDirectory(state.project), "snapshots", group.id, snapshot.digest),
						doc,
						receipt,
						step,
						"snapshot",
						true,
					);
				}
				group.title = normalized.title;
				group.documentPath = normalized.document.path;
				group.srIds = normalized.srs.map(s => s.id);
				group.files = snapshot.files;
				group.retiredFiles = retiredFiles;
				group.snapshot = snapshot;
				group.revision++;
				group.status = "draft";
				delete group.confirmation;
				delete group.review;
				delete group.requirementsPr;
				delete group.evidenceFiles;
				state.srs = state.srs.filter(s => s.irId !== group.id || group.srIds.includes(s.id));
				for (const entry of normalized.srs) {
					let sr = state.srs.find(s => s.id === entry.id);
					if (!sr) {
						sr = {
							id: entry.id,
							projectId: ref.projectId,
							irId: group.id,
							title: entry.title,
							documentPath: entry.document.path,
							status: "pending",
							round: 0,
							sessions: [],
							approvals: [],
							materials: [],
						};
						state.srs.push(sr);
					} else {
						sr.title = entry.title;
						sr.documentPath = entry.document.path;
					}
				}
				await assertSnapshotFiles(root, snapshot);
				await step("files", snapshot.digest);
			},
		);
	}
	async saveStageMaterials(
		ref: AIReqObjectRef,
		expectedRevision: number,
		operationId: string,
		stage: AIReqWorkflowStage,
		round: number,
		documents: AIReqStageDocument[],
	): Promise<AIReqWorkflowResult> {
		return this.store.mutate(
			ref.projectId,
			expectedRevision,
			operationId,
			{ type: "saveStageMaterials", ref, stage, round, documents },
			async ({ state, receipt, step }) => {
				const group = groupFor(state, ref.irId);
				const sr = srFor(state, group, ref.srId);
				receipt.irId = group.id;
				receipt.srId = sr.id;
				await this.#assertFrozen(state, group);
				if (sr.status !== "developing" || sr.stage !== stage || sr.round !== round || !sr.worktree)
					throw new Error("Stale material output");
				await assertSnapshotFiles(sr.worktree.path, group.snapshot!);
				if (
					!documents.length ||
					new Set(documents.map(d => d.path)).size !== documents.length ||
					new Set(documents.map(d => d.kind)).size !== documents.length
				)
					throw new Error("Exactly one current material of each kind is allowed");
				const allowed =
					stage === "solution"
						? ["solution"]
						: stage === "planning"
							? ["plan"]
							: stage === "executing"
								? ["completion", "ut", "st"]
								: ["delivery"];
				for (const doc of documents) {
					assertKeys(doc, ["path", "content", "kind"], "stage material");
					if (
						!doc.path.startsWith(`docs/aireq/development/${sr.id}/`) ||
						doc.path.includes("/history/") ||
						!doc.path.endsWith(".md") ||
						!/^#\s+\S/m.test(doc.content) ||
						!allowed.includes(doc.kind) ||
						sr.materials.some(material => material.stage !== stage && material.path === doc.path)
					)
						throw new Error("Complete Markdown material path/kind must belong exclusively to current SR/stage");
				}
				await this.#assertApprovals(
					sr,
					documents.flatMap(doc => [doc.path, materialHistoryPath(sr.id, sha256(doc.content), doc.path)]),
				);
				for (const old of sr.materials)
					if (old.stage === stage) {
						if (documents.some(doc => doc.path === old.path)) {
							const history = materialHistoryPath(sr.id, old.sha256, old.path);
							await fs.access(path.join(sr.worktree.path, history));
							old.path = history;
						}
						old.valid = false;
					}
				const cutoff = AIREQ_WORKFLOW_STAGES.indexOf(stage);
				sr.approvals = sr.approvals.filter(a => AIREQ_WORKFLOW_STAGES.indexOf(a.stage) < cutoff);
				for (const material of sr.materials)
					if (AIREQ_WORKFLOW_STAGES.indexOf(material.stage) > cutoff) material.valid = false;
				await step("stage-edit", `${stage}:${round}`);
				for (const doc of documents) {
					const hash = sha256(doc.content);
					await checkpointMaterial(
						sr.worktree.path,
						{ path: materialHistoryPath(sr.id, hash, doc.path), content: doc.content },
						receipt,
						step,
						"history",
						true,
					);
					await checkpointMaterial(sr.worktree.path, doc, receipt, step, "file");
					sr.materials.push({
						stage,
						kind: doc.kind,
						path: doc.path,
						sha256: hash,
						size: Buffer.byteLength(doc.content),
						round,
						valid: true,
					});
				}
				await this.#assertFrozen(state, group);
				await assertSnapshotFiles(sr.worktree.path, group.snapshot!);
				sr.materialDigest = digestFiles(await currentMaterials(sr));
				await step("materials", sr.materialDigest);
			},
		);
	}
	async bindSession(
		ref: AIReqObjectRef,
		expectedRevision: number,
		operationId: string,
		session: AIReqNativeSessionRef,
	): Promise<AIReqWorkflowResult> {
		return this.store.mutate(
			ref.projectId,
			expectedRevision,
			operationId,
			{ type: "bindSession", ref, session },
			async ({ state }) => {
				const group = groupFor(state, ref.irId);
				const sr = ref.srId ? srFor(state, group, ref.srId) : undefined;
				await assertSession(session, ref, sr?.stage ?? "requirements", sr?.round ?? 0);
				const sessions = sr?.sessions ?? group.sessions;
				if (!sessions.some(s => s.sessionId === session.sessionId)) sessions.push(session);
			},
		);
	}
	async readMaterial(ref: AIReqObjectRef, materialPath: string): Promise<AIReqMaterialView> {
		safeMaterialPath(materialPath);
		const view = await this.store.view(ref.projectId);
		const material = view.materials.find(
			m =>
				m.irId === ref.irId &&
				m.path === materialPath &&
				(!ref.srId || m.srId === ref.srId || m.kind === "ir" || m.kind === "attachment"),
		);
		if (!material) throw new Error("Material is not owned by requested object");
		const state = await this.store.read(ref.projectId);
		const group = groupFor(state, ref.irId);
		const sr = material.stage ? srFor(state, group, material.srId) : undefined;
		const root = sr?.worktree?.path ?? requirementRoot(state.project, group);
		try {
			const bytes = (await readMaterialFiles(root, [materialPath])).get(materialPath)!;
			if (sha256(bytes) !== material.sha256) throw new Error("Material changed since its recorded version");
			return { ...material, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
		} catch (error) {
			return { ...material, error: errorText(error) };
		}
	}
	async exportPackage(projectId: string, irId: string, targetZip: string): Promise<void> {
		const state = await this.store.read(projectId);
		const group = groupFor(state, irId);
		await this.#assertConfirmed(state, group);
		const snapshot = group.snapshot!;
		if (group.origin === "import" && group.packageId) {
			const original = JSON.parse(
				await fs.readFile(
					path.join(stateDirectory(state.project), "packages", group.packageId, "manifest.json"),
					"utf8",
				),
			) as AIReqPackageManifest;
			if (sha256(canonicalJson(original)) !== group.packageDigest)
				throw new Error("Original imported package manifest changed");
			if (
				original.snapshot.digest === snapshot.digest &&
				original.confirmation.operationId === group.confirmation!.operationId &&
				original.review.id === group.review!.id
			) {
				await encodeRequirementPackage(
					targetZip,
					original,
					await readMaterialFiles(
						requirementRoot(state.project, group),
						snapshot.files.map(f => f.path),
					),
				);
				return;
			}
		}
		const review: AIReqPackageManifest["review"] = {
			id: group.review!.id,
			snapshotDigest: group.review!.snapshotDigest,
			passed: group.review!.passed,
			report: group.review!.report,
			createdAt: group.review!.createdAt,
			reviewer: { sessionId: group.review!.reviewer.sessionId, role: "reviewer" },
		};
		const packageId = `package-${sha256(canonicalJson({ snapshotDigest: snapshot.digest, confirmation: group.confirmation, review, releaseId: group.releaseId, sourceProjectId: snapshot.projectId }))}`;
		const manifest: AIReqPackageManifest = {
			format: "omp-aireq-requirements",
			version: 1,
			packageId,
			sourceProjectId: snapshot.projectId,
			repositoryId: state.project.repositoryId,
			irId,
			releaseId: group.releaseId,
			createdAt: group.confirmation!.confirmedAt,
			snapshot,
			confirmation: group.confirmation!,
			review,
			files: snapshot.files,
		};
		await encodeRequirementPackage(
			targetZip,
			manifest,
			await readMaterialFiles(
				requirementRoot(state.project, group),
				snapshot.files.map(f => f.path),
			),
		);
	}
	async importPackage(
		command: Extract<AIReqWorkflowCommand, { type: "importPackage" }>,
		decoded: AIReqDecodedPackage,
	): Promise<AIReqWorkflowResult> {
		const projectId = required(command.projectId, "projectId");
		const manifest = validatePackageManifest(decoded.manifest, decoded.files);
		if (command.packageId !== manifest.packageId || decoded.digest !== sha256(canonicalJson(manifest)))
			throw new Error("Package upload identity mismatch");
		for (const file of manifest.files) {
			const bytes = decoded.files.get(file.path);
			if (!bytes || bytes.length !== file.size || sha256(bytes) !== file.sha256)
				throw new Error(`Package material changed: ${file.path}`);
		}
		return this.store.mutate(
			projectId,
			command.expectedRevision,
			command.operationId,
			{ ...command, packageDigest: decoded.digest },
			async ({ state, receipt, step }) => {
				if (manifest.repositoryId !== state.project.repositoryId)
					throw new Error("Package belongs to another source repository");
				if (!state.releases.some(r => r.id === command.releaseId)) throw new Error("Unknown target Release");
				const duplicate = state.groups.find(g => g.packageId === manifest.packageId);
				if (duplicate) {
					if (duplicate.status === "deleted")
						throw new Error("Package IR was deleted; duplicate import cannot revive retained stable IDs");
					if (duplicate.packageDigest !== decoded.digest) throw new Error("Conflicting duplicate package ID");
					receipt.irId = duplicate.id;
					return;
				}
				if (
					state.groups.some(g => g.id === manifest.irId) ||
					manifest.snapshot.srs.some(s => state.srs.some(existing => existing.id === s.id))
				)
					throw new Error("Imported stable IDs conflict with existing materials; no overwrite performed");
				const worktree = await this.git.createWorktree(
					state.project,
					"requirements",
					manifest.irId,
					command.operationId,
				);
				receipt.irId = manifest.irId;
				await step("worktree", JSON.stringify(worktree));
				for (const [name, bytes] of decoded.files) {
					await checkpointMaterial(worktree.path, { path: name, content: bytes }, receipt, step, "file");
					await checkpointMaterial(
						path.join(stateDirectory(state.project), "snapshots", manifest.irId, manifest.snapshot.digest),
						{ path: name, content: bytes },
						receipt,
						step,
						"snapshot",
						true,
					);
				}
				await checkpointMaterial(
					path.join(stateDirectory(state.project), "packages", manifest.packageId),
					{ path: "manifest.json", content: canonicalJson(manifest) },
					receipt,
					step,
					"package-manifest",
					true,
				);
				const group: AIReqRequirementGroup = {
					id: manifest.irId,
					projectId,
					releaseId: command.releaseId,
					title: manifest.snapshot.title,
					documentPath: manifest.snapshot.documentPath,
					origin: "import",
					status: "confirmed",
					revision: 0,
					srIds: manifest.snapshot.srs.map(s => s.id),
					files: manifest.files,
					worktree,
					sessions: [],
					snapshot: manifest.snapshot,
					confirmation: manifest.confirmation,
					review: {
						...manifest.review,
						reviewer: {
							sessionId: manifest.review.reviewer.sessionId,
							role: "reviewer",
							sourceProjectId: manifest.sourceProjectId,
							imported: true,
						},
					},
					packageId: manifest.packageId,
					packageDigest: decoded.digest,
					createdAt: now(),
				};
				await assertSnapshotFiles(worktree.path, group.snapshot!);
				await saveReviewEvidence(state.project, group);
				state.groups.push(group);
				for (const s of manifest.snapshot.srs)
					state.srs.push({
						id: s.id,
						projectId,
						irId: group.id,
						title: s.title,
						documentPath: s.documentPath,
						status: "pending",
						round: 0,
						sessions: [],
						approvals: [],
						materials: [],
					});
				await step("imported", decoded.digest);
			},
		);
	}
	async #assertConfirmed(state: AIReqProjectState, group: AIReqRequirementGroup): Promise<void> {
		if (
			!group.snapshot ||
			!group.confirmation ||
			!group.review?.passed ||
			group.confirmation.snapshotDigest !== group.snapshot.digest ||
			group.review.snapshotDigest !== group.snapshot.digest ||
			!["confirmed", "requirements-pr", "frozen"].includes(group.status)
		)
			throw new Error("Current complete requirements require explicit confirmation and passing independent review");
		await assertSnapshotFiles(requirementRoot(state.project, group), group.snapshot);
		for (const file of group.retiredFiles ?? []) {
			try {
				await fs.lstat(path.join(requirementRoot(state.project, group), file.path));
				throw new Error(`Retired material reappeared: ${file.path}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		for (const file of group.evidenceFiles ?? []) {
			const bytes = (await readMaterialFiles(requirementRoot(state.project, group), [file.path])).get(file.path)!;
			if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
				throw new Error("Confirmation/review evidence changed");
		}
		if (
			canonicalJson(group.srIds) !== canonicalJson(group.snapshot.srs.map(s => s.id)) ||
			group.title !== group.snapshot.title
		)
			throw new Error("Confirmed IR/SR membership/title changed");
		for (const entry of group.snapshot.srs) {
			const sr = state.srs.find(s => s.id === entry.id && s.irId === group.id);
			if (!sr || sr.title !== entry.title || sr.documentPath !== entry.documentPath)
				throw new Error("Confirmed SR identity/title changed");
		}
	}
	async #assertFrozen(state: AIReqProjectState, group: AIReqRequirementGroup): Promise<void> {
		if (group.status !== "frozen" || !group.merge)
			throw new Error("Requirements PR must be Git-confirmed and whole group frozen before SR development");
		await this.#assertConfirmed(state, group);
	}
	async #assertApprovals(sr: AIReqSystemRequirement, permittedNewFiles: string[] = []): Promise<void> {
		await assertDevelopmentSet(sr, permittedNewFiles);
		if (!sr.worktree) throw new Error("SR worktree missing");
		for (const approval of sr.approvals) {
			const files = await readMaterialFiles(
				sr.worktree.path,
				approval.files.map(f => f.path),
			);
			for (const file of approval.files)
				if (sha256(files.get(file.path)!) !== file.sha256)
					throw new Error(`Upstream approval invalidated: ${file.path}`);
		}
		const stageIndex = AIREQ_WORKFLOW_STAGES.indexOf(sr.stage!);
		for (let i = 0; i < stageIndex; i++)
			if (!sr.approvals.some(a => a.stage === AIREQ_WORKFLOW_STAGES[i]))
				throw new Error("Required upstream approval missing");
	}
}
async function currentMaterials(sr: AIReqSystemRequirement) {
	await assertDevelopmentSet(sr);
	if (!sr.worktree) throw new Error("SR worktree missing");
	const materials = sr.materials
		.filter(m => m.valid && m.stage === sr.stage && m.round === sr.round)
		.map(({ path, sha256, size }) => ({ path, sha256, size }));
	const bytes = await readMaterialFiles(
		sr.worktree.path,
		materials.map(m => m.path),
	);
	for (const material of materials)
		if (sha256(bytes.get(material.path)!) !== material.sha256 || bytes.get(material.path)!.length !== material.size)
			throw new Error(`Stage output changed: ${material.path}`);
	return materials;
}
async function assertSession(
	session: AIReqNativeSessionRef,
	ref: AIReqObjectRef,
	stage: "requirements" | AIReqWorkflowStage,
	round: number,
): Promise<void> {
	if (
		session.projectId !== ref.projectId ||
		session.irId !== ref.irId ||
		session.srId !== ref.srId ||
		session.phase !== stage ||
		session.role !== stage ||
		session.round !== round ||
		!session.sessionId ||
		!session.sessionFile
	)
		throw new Error("Native session identity/phase/round mismatch");
	await fs.access(session.sessionFile);
}
function prFact(url: string, sourceBranch: string, targetBranch: string) {
	const parsed = new URL(url);
	if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
		throw new Error("Manual PR URL must be an HTTP(S) URL without credentials");
	return { url: parsed.href, sourceBranch, targetBranch, recordedAt: now(), platformVerified: false as const };
}
async function writeMaterial(root: string, relative: string, content: string | Uint8Array): Promise<void> {
	safeMaterialPath(relative);
	await fs.mkdir(root, { recursive: true });
	const canonical = await fs.realpath(root);
	const target = path.resolve(root, relative);
	let parent = canonical;
	for (const segment of relative.split("/").slice(0, -1)) {
		parent = path.join(parent, segment);
		try {
			await fs.mkdir(parent);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const info = await fs.lstat(parent);
		if (info.isSymbolicLink() || !info.isDirectory())
			throw new Error(`Material parent alias/non-directory forbidden: ${relative}`);
		const resolved = await fs.realpath(parent);
		if (!resolved.startsWith(`${canonical}${path.sep}`))
			throw new Error(`Material parent escapes authority: ${relative}`);
	}
	try {
		if ((await fs.lstat(target)).isSymbolicLink()) throw new Error(`Material symlink forbidden: ${relative}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (typeof content === "string") await writeFileAtomically(target, content, 0o644);
	else {
		const temp = `${target}.${newId()}.tmp`;
		try {
			const handle = await fs.open(temp, "wx", 0o644);
			try {
				await handle.writeFile(content);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await replaceFileAtomically(temp, target);
		} finally {
			await fs.rm(temp, { force: true });
		}
	}
}
export { decodeRequirementPackage };
async function saveReviewEvidence(project: AIReqProject, group: AIReqRequirementGroup): Promise<void> {
	const review = group.review!;
	const file = `docs/aireq/reviews/${group.id}/${group.snapshot!.digest}-${stableId(review.id)}.json`;
	const content = canonicalJson({
		version: 1,
		irId: group.id,
		snapshot: group.snapshot,
		confirmation: group.confirmation,
		review: {
			id: review.id,
			snapshotDigest: review.snapshotDigest,
			passed: review.passed,
			report: review.report,
			createdAt: review.createdAt,
			reviewer: { sessionId: review.reviewer.sessionId, role: "reviewer" },
		},
	});
	try {
		if ((await fs.readFile(path.join(requirementRoot(project, group), file), "utf8")) !== content)
			throw new Error("Immutable review evidence conflicts with existing record");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await writeMaterial(requirementRoot(project, group), file, content);
	group.evidenceFiles = [{ path: file, sha256: sha256(content), size: Buffer.byteLength(content) }];
}
function validateCommand(command: AIReqWorkflowCommand): void {
	const payloads: Record<AIReqWorkflowCommand["type"], string[]> = {
		registerProject: ["registrationScope", "root", "name"],
		createRelease: ["title"],
		createLocalDraft: ["releaseId"],
		createBrowserDraft: ["releaseId"],
		importPackage: ["releaseId", "packageId"],
		deleteRequirement: ["version"],
		confirmRequirements: ["snapshotDigest"],
		markRequirementsPrSubmitted: ["url"],
		markCodePrSubmitted: ["url"],
		markRequirementsMerged: [],
		markCodeMerged: [],
		startSr: [],
		approveStage: ["stage", "round", "materialDigest"],
		backStage: ["stage"],
		stop: [],
		publishMaterials: ["scope", "paths", "message", "push"],
	};
	if (!command || typeof command !== "object" || !Object.hasOwn(payloads, command.type))
		throw new Error("Unknown workflow command");
	assertKeys(
		command,
		[
			"type",
			"operationId",
			"expectedRevision",
			"projectId",
			"irId",
			"srId",
			...payloads[command.type],
			...(command.type === "publishMaterials" ? ["versions"] : []),
		],
		"workflow command",
	);
	stableId(command.operationId);
	for (const key of payloads[command.type]) if (!(key in command)) throw new Error(`Missing command field: ${key}`);
	if (
		command.type === "registerProject" &&
		(command.registrationScope !== "target-root" ||
			command.expectedRevision !== 0 ||
			command.projectId !== undefined ||
			command.irId !== undefined ||
			command.srId !== undefined ||
			typeof command.root !== "string" ||
			!command.root ||
			typeof command.name !== "string" ||
			!command.name.trim())
	)
		throw new Error("Registration requires target-root scope, expectedRevision 0 and no selected object reference");
	if (command.type === "deleteRequirement") {
		if (command.version !== 1 || command.srId !== undefined)
			throw new Error("Deletion requires version 1 and an exact IR-only reference");
		required(command.projectId, "projectId");
		required(command.irId, "irId");
		if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)
			throw new Error("Invalid expectedRevision");
	}
	if (
		command.type === "publishMaterials" &&
		(!["requirements", "development"].includes(command.scope) ||
			!Array.isArray(command.paths) ||
			typeof command.push !== "boolean" ||
			new Set(command.paths).size !== command.paths.length)
	)
		throw new Error("Invalid explicit material publish scope");
	if (command.type === "publishMaterials" && command.versions !== undefined) {
		if (!Array.isArray(command.versions)) throw new Error("Invalid publish file versions");
		for (const file of command.versions) {
			assertKeys(file, ["path", "sha256", "size"], "publish file version");
			safeMaterialPath(file.path);
			if (!/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < -1)
				throw new Error("Invalid publish file version");
		}
	}
	if (
		command.type === "approveStage" &&
		(!AIREQ_WORKFLOW_STAGES.includes(command.stage) ||
			!Number.isSafeInteger(command.round) ||
			command.round < 1 ||
			!/^[a-f0-9]{64}$/.test(command.materialDigest))
	)
		throw new Error("Invalid explicit approval identity/version");
	if (command.type === "backStage" && !["solution", "planning", "executing"].includes(command.stage))
		throw new Error("Invalid return stage");
}
function validateNestedState(state: AIReqProjectState): void {
	const files = (value: unknown) => {
		if (!Array.isArray(value)) throw new Error("Invalid file versions");
		const seen = new Set<string>();
		for (const file of value) {
			assertKeys(file, ["path", "sha256", "size"], "file version");
			safeMaterialPath(file.path as string);
			if (
				typeof file.sha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(file.sha256) ||
				!Number.isSafeInteger(file.size) ||
				(file.size as number) < -1
			)
				throw new Error("Invalid material hash/size");
			const key = (file.path as string).toLowerCase();
			if (seen.has(key)) throw new Error("Duplicate material paths");
			seen.add(key);
		}
	};
	const session = (value: unknown) => {
		assertKeys(
			value,
			["projectId", "irId", "srId", "sessionId", "sessionFile", "role", "phase", "round"],
			"native session",
		);
		if (
			typeof value.sessionId !== "string" ||
			!value.sessionId ||
			typeof value.sessionFile !== "string" ||
			!value.sessionFile ||
			!Number.isSafeInteger(value.round)
		)
			throw new Error("Invalid native history reference");
	};
	const worktree = (value: unknown) => {
		if (value === undefined) return;
		assertKeys(value, ["path", "branch", "baseCommit"], "worktree");
		if (
			typeof value.path !== "string" ||
			!path.isAbsolute(value.path) ||
			typeof value.branch !== "string" ||
			typeof value.baseCommit !== "string" ||
			!/^[0-9a-f]{40,64}$/.test(value.baseCommit)
		)
			throw new Error("Invalid worktree identity");
	};
	const pr = (value: unknown) => {
		if (value === undefined) return;
		assertKeys(value, ["url", "sourceBranch", "targetBranch", "recordedAt", "platformVerified"], "manual PR fact");
		if (value.platformVerified !== false) throw new Error("AIReq cannot claim PR platform verification");
	};
	const merge = (value: unknown) => {
		if (value === undefined) return;
		assertKeys(value, ["commit", "branch", "checkedAt", "files"], "merge fact");
		if (typeof value.commit !== "string" || !/^[0-9a-f]{40,64}$/.test(value.commit))
			throw new Error("Invalid merge commit");
		files(value.files);
	};
	const deletion = (value: unknown) => {
		if (value === undefined) return;
		assertKeys(
			value,
			["version", "operationId", "deletedAt", "manualCloseNeeded", "requirementsPrUrl"],
			"requirement deletion",
		);
		if (
			value.version !== 1 ||
			typeof value.deletedAt !== "string" ||
			!Number.isFinite(Date.parse(value.deletedAt)) ||
			typeof value.manualCloseNeeded !== "boolean"
		)
			throw new Error("Invalid requirement tombstone");
		stableId(value.operationId as string);
		if (value.manualCloseNeeded) {
			if (typeof value.requirementsPrUrl !== "string") throw new Error("Manual PR closure URL required");
			const url = new URL(value.requirementsPrUrl);
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
				throw new Error("Invalid retained manual PR URL");
		} else if (value.requirementsPrUrl !== undefined)
			throw new Error("Unregistered PR cannot require manual closure");
	};
	if (state.owner) assertKeys(state.owner, ["hostname", "processId", "token", "acquiredAt"], "project owner");
	for (const group of state.groups) {
		files(group.files);
		if (group.evidenceFiles) files(group.evidenceFiles);
		if (group.retiredFiles) {
			files(group.retiredFiles);
			for (const file of group.retiredFiles)
				if (
					file.size !== -1 ||
					file.sha256 !== sha256("") ||
					!file.path.startsWith(`docs/aireq/requirements/${group.id}/`) ||
					group.files.some(current => current.path === file.path)
				)
					throw new Error("Invalid owned requirement retirement");
		}
		worktree(group.worktree);
		pr(group.requirementsPr);
		merge(group.merge);
		if (!Array.isArray(group.sessions)) throw new Error("Invalid IR sessions");
		for (const ref of group.sessions) session(ref);
		deletion(group.deletion);
		if (group.confirmation)
			assertKeys(group.confirmation, ["operationId", "snapshotDigest", "confirmedAt"], "confirmation");
		if (group.snapshot) {
			assertKeys(
				group.snapshot,
				["version", "projectId", "irId", "title", "documentPath", "srs", "files", "digest"],
				"requirement snapshot",
			);
			const { digest, ...basis } = group.snapshot;
			if (
				group.snapshot.version !== 1 ||
				sha256(canonicalJson(basis)) !== digest ||
				group.snapshot.irId !== group.id
			)
				throw new Error("Invalid immutable requirement snapshot");
			files(group.snapshot.files);
			for (const sr of group.snapshot.srs) assertKeys(sr, ["id", "title", "documentPath"], "snapshot SR");
		}
		if (group.review) {
			assertKeys(group.review, ["id", "snapshotDigest", "passed", "report", "reviewer", "createdAt"], "review");
			if ("imported" in group.review.reviewer) {
				assertKeys(
					group.review.reviewer,
					["sessionId", "role", "sourceProjectId", "imported"],
					"imported reviewer",
				);
				if (group.origin !== "import" || group.review.reviewer.imported !== true)
					throw new Error("Invalid imported review provenance");
			} else session(group.review.reviewer);
		}
	}
	for (const sr of state.srs) {
		worktree(sr.worktree);
		pr(sr.codePr);
		merge(sr.codeMerge);
		for (const ref of sr.sessions) session(ref);
		for (const approval of sr.approvals) {
			assertKeys(approval, ["stage", "round", "operationId", "digest", "files", "approvedAt"], "stage approval");
			files(approval.files);
			if (!AIREQ_WORKFLOW_STAGES.includes(approval.stage) || digestFiles(approval.files) !== approval.digest)
				throw new Error("Invalid approval snapshot");
		}
		for (const material of sr.materials) {
			assertKeys(material, ["stage", "kind", "path", "sha256", "size", "round", "valid"], "stage material");
			files([{ path: material.path, sha256: material.sha256, size: material.size }]);
			if (!AIREQ_WORKFLOW_STAGES.includes(material.stage) || typeof material.valid !== "boolean")
				throw new Error("Invalid stage material");
		}
	}
	for (const receipt of state.operations) {
		deletion(receipt.deletion);
		if (typeof receipt.commandDigest !== "string" || !/^[0-9a-f]{64}$/.test(receipt.commandDigest))
			throw new Error("Invalid receipt digest");
		for (const step of receipt.steps) assertKeys(step, ["name", "at", "detail"], "operation checkpoint");
	}
}
function materialHistoryPath(srId: string, hash: string, file: string): string {
	return `docs/aireq/development/${srId}/history/${hash}/${path.basename(file)}`;
}
async function assertDevelopmentSet(sr: AIReqSystemRequirement, permittedNewFiles: string[] = []): Promise<void> {
	if (!sr.worktree) throw new Error("SR worktree missing");
	const expected = new Set(sr.materials.flatMap(m => [m.path, materialHistoryPath(sr.id, m.sha256, m.path)]));
	let actual: string[];
	try {
		actual = await listMaterialFiles(sr.worktree.path, `docs/aireq/development/${sr.id}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !expected.size) return;
		throw error;
	}
	if (
		actual.some(file => !expected.has(file) && !permittedNewFiles.includes(file)) ||
		[...expected].some(file => !actual.includes(file))
	)
		throw new Error(
			"Technical material file set changed; synchronize explicit current-stage output before approval/publish",
		);
}
async function checkpointMaterial(
	root: string,
	doc: { path: string; content: string | Uint8Array },
	receipt: AIReqOperationReceipt,
	step: (name: string, detail: string) => Promise<void>,
	prefix: string,
	immutable = false,
): Promise<void> {
	const name = `${prefix}:${doc.path}`;
	const digest = sha256(doc.content);
	const checkpoint = receipt.steps.find(s => s.name === name);
	let existing: Uint8Array | undefined;
	try {
		existing = (await readMaterialFiles(root, [doc.path])).get(doc.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (checkpoint) {
		if (checkpoint.detail !== digest || !existing || sha256(existing) !== digest)
			throw new Error(`Previously saved file changed; refusing stale retry: ${doc.path}`);
		return;
	}
	if (immutable && existing && sha256(existing) !== digest)
		throw new Error(`Immutable material snapshot conflict: ${doc.path}`);
	if (!existing || sha256(existing) !== digest) await writeMaterial(root, doc.path, doc.content);
	await step(name, digest);
}
