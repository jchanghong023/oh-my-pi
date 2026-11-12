import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentSession, type CreateAgentSessionResult } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import { AgentRegistry } from "../registry/agent-registry";
import type { Settings } from "../config/settings";
import type { ExtensionUIDialogOptions } from "../extensibility/extensions/types";
import { AIReqWorkflowStore, AIReqWorkflowService, type AIReqStageDocument } from "./workflow-store";
import { AIReqWorkflowGit, readMaterialFiles } from "./workflow-git";
import {
	decodeRequirementPackage,
	safeMaterialPath,
	sha256,
	canonicalJson,
	validateRequirementContent,
} from "./requirement-package";
import {
	createAIReqWorkflowRuntime,
	type AIReqFrozenAuthority,
	type AIReqWorkflowRuntime,
	type AIReqWorkflowBinding,
} from "./workflow-runtime";
import type {
	AIReqDecodedPackage,
	AIReqDocument,
	AIReqNativeSessionRef,
	AIReqObjectRef,
	AIReqProject,
	AIReqProjectState,
	AIReqRequirementGroup,
	AIReqRequirementContent,
	AIReqRequirementSnapshot,
	AIReqWorkflowCommand,
	AIReqWorkflowView,
} from "./workflow-types";
import { bindAIReqNativeServiceOwner, notifyAIReqNativeSessions } from "./native/native-session-host";
import {
	nativeWebGuiQuestions,
	nativeWebGuiInteractionOrigin,
	bindAIReqNativeSurface,
	aiReqNativeSurfaceSnapshot,
	updateAIReqNativeSurfaceEditor,
	respondAIReqNativeSurface,
	subscribeAIReqNativeSurface,
	releaseAIReqNativeSurface,
	type NativeWebGuiInteractionAnswer,
} from "./native/native-interactions";
import { setAIReqNativeProject, removeAIReqNativeProject, readBrowserProject } from "./native/project-registry";
import type { AIReqNativeServiceOwner, WebGuiServiceContext } from "./native/rpc-contract";
import { acquireBrowserProject, type BrowserProjectLease } from "../webgui/project-registry";
import { readWebGuiSessionInfo } from "../webgui/session-source";
import {
	beginNativeWebGuiHostStop,
	stopNativeWebGuiCommands,
	disposeNativeWebGuiCommands,
} from "./native/native-commands";
import { bindNativeWebGuiCommandEnvironment } from "./native/native-command-host";
import { installNativeWebGuiSessionOperations } from "./native/native-command-session-operations";
import { MCPManager, type MCPAuthHandler } from "../mcp/manager";
import { hasExplicitRepairIntent, specDescendantAgentIds, type AIReqNativeInputKind } from "../spec-driven/actors";
import { isLocalAgentSession } from "../session/agent-session-handle";
import { aiReqNativePredictionAction } from "./native/native-predictions";
import type { AIReqNativeSurfaceTarget, AIReqNativePredictionAction } from "./native/native-surface-types";
import { AIReqNativeCollabProjection, bindAIReqNativeCollabProjection } from "./native/native-collab-projection";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils/dirs";
import { settleAIReqNativeAttachments } from "./native/native-attachments";
import { refreshNativeWebGuiSession } from "./native/native-chat";
import { settleAIReqNativeMutations } from "./native/native-session-host";

interface ProjectRuntime {
	project: AIReqProject;
	root: AgentSession;
	settings: Settings;
	runtime: AIReqWorkflowRuntime;
	owned: boolean;
	lease?: BrowserProjectLease;
}
export interface AIReqBrowserBinding {
	projectId: string;
	irId?: string;
	srId?: string;
	sessionId?: string;
	round?: number;
	epoch: number;
}
type BrowserBinding = AIReqBrowserBinding;
interface AdmittedNativeInput {
	operationId: string;
	ref: AIReqNativeSessionRef;
	kind: AIReqNativeInputKind;
	browser?: { browserId: string; epoch: number };
	joins: Set<Promise<unknown>>;
}
const nativeOwners = new Map<string, AIReqWorkflowHost>();

/** Domain coordinator; all execution remains in the native runtime and all state in the domain store. */
export class AIReqWorkflowHost {
	readonly store: AIReqWorkflowStore;
	readonly service: AIReqWorkflowService;
	readonly collab: AIReqNativeCollabProjection;
	readonly #projects = new Map<string, Promise<ProjectRuntime>>();
	readonly #leases = new Map<string, Promise<BrowserProjectLease | undefined>>();
	readonly #bindings = new Map<string, BrowserBinding>();
	readonly #listeners = new Set<(event: object) => void>();
	readonly #contexts = new Map<string, { browserId: string; epoch: number; sessionId?: string }>();
	readonly #contextObjects = new Map<string, WebGuiServiceContext>();
	readonly #contextAborts = new Map<string, AbortController>();
	readonly #ownedSessions = new Map<string, AgentSession>();
	readonly #nativeRoots = new Set<AgentSession>();
	readonly #nativeOwner: AIReqNativeServiceOwner;
	readonly #packages = new Map<string, { browserId: string; projectId: string; decoded: AIReqDecodedPackage }>();
	readonly #inputs = new Map<string, { browserId: string; digest: string; status: string; error?: string }>();
	readonly #ingesting = new Map<string, Promise<void>>();
	readonly #work = new Set<Promise<unknown>>();
	readonly #nativeTasks = new Map<Promise<unknown>, string>();
	readonly #admittedNativeInputs = new Map<AgentSession, AdmittedNativeInput>();
	readonly #settlingProjects = new Set<string>();
	readonly #disposers: Array<() => void> = [];
	readonly #surfaces = new Map<string, { target: AIReqNativeSurfaceTarget; epoch: number; unsubscribe: () => void }>();
	#closing = false;
	constructor(
		readonly input: { cwd: string; rootSession: AgentSession; settings: Settings; mcpAuth?: MCPAuthHandler },
	) {
		this.#nativeOwner = {
			assertCurrent: (context, id) => this.assertNativeContext(context, id),
			assertSession: session => {
				if (this.#closing || session.isDisposed || (!this.ownsSession(session) && !this.#nativeRoots.has(session)))
					throw new Error("Native session is not active in this AIReq host");
			},
			prepare: context => this.prepareContext(context),
			runInput: <T>(session: AgentSession, operation: () => Promise<T>, text?: string, kind?: AIReqNativeInputKind) =>
				this.runNativeInput(session, operation, text, kind),
			stop: session => this.stopNativeInput(session),
		};
		this.collab = new AIReqNativeCollabProjection({
			settings: input.settings,
			resolveBrowserId: connectionId => {
				const context = this.#contextObjects.get(connectionId);
				const identity = this.#contexts.get(connectionId);
				if (!context || !identity) throw new Error("Originating AIReq native page is no longer available");
				this.assertNativeContext(context);
				return identity.browserId;
			},
			onUpdate: (browserId, event) => this.emit({ t: "collab", browserId, event }),
		});
		this.store = new AIReqWorkflowStore(path.join(input.settings.getAgentDir(), "aireq-projects-v1"));
		installNativeWebGuiSessionOperations();
		this.service = new AIReqWorkflowService(this.store, new AIReqWorkflowGit(), {
			review: async request => {
				const project = await this.project(request.ref.projectId);
				const state = await this.store.read(request.ref.projectId);
				const group = state.groups.find(item => item.id === request.ref.irId);
				if (!group) throw new Error("IR not found");
				const cwd = this.#requirementCwd(project.project, group);
				const files = [...request.documents].map(([file, content]) => ({
					path: file,
					content,
					digest: sha256(content),
				}));
				const parent = group.sessions.filter(session => session.role === "requirements").at(-1);
				if (!parent) throw new Error("Independent review requires the exact requirements native parent");
				await project.runtime.prepare({
					binding: parent,
					cwd,
					outputPaths: [`docs/aireq/intake/${group.id}/requirements.json`],
					sessionRef: parent,
				});
				const result = await project.runtime.review({
					binding: { ...request.ref, phase: "requirements", round: parent.round },
					cwd,
					snapshot: request.snapshot,
					files,
					outputPath: `docs/aireq/reviews/${group.id}/${request.operationId}.json`,
				});
				return {
					id: request.operationId,
					snapshotDigest: result.snapshotDigest,
					passed: result.report.verdict === "pass",
					report: JSON.stringify(result.report),
					reviewer: result.ref,
					createdAt: new Date().toISOString(),
				};
			},
			settle: (ref, reason) => this.#settleNativeWork(ref, reason),
			start: async request => {
				const project = await this.project(request.ref.projectId);
				const state = await this.store.read(request.ref.projectId);
				const group = state.groups.find(item => item.id === request.ref.irId);
				const sr = state.srs.find(item => item.id === request.ref.srId);
				const cwd =
					request.worktree?.path ??
					path.join(project.project.commonDir, "omp-aireq-workflow-v1", "drafts", request.ref.irId);
				await fs.mkdir(cwd, { recursive: true });
				if (request.snapshot && !group) throw new Error("Frozen requirement group not found");
				const authority = request.snapshot ? await this.#frozenAuthority(cwd, group!, request.snapshot) : undefined;
				const earlierMaterials = sr
					? await Promise.all(
							sr.materials
								.filter(material => material.valid)
								.map(async material => ({
									path: material.path,
									content: await fs.readFile(path.join(cwd, material.path), "utf8"),
								})),
						)
					: [];
				return project.runtime.prepare({
					binding: { ...request.ref, phase: request.stage, round: request.round },
					cwd,
					outputPaths:
						request.stage === "requirements"
							? [`docs/aireq/intake/${request.ref.irId}/requirements.json`]
							: this.#stagePaths(request.ref.srId!, request.stage),
					authority,
					contextFiles: [
						...(authority?.files ?? [])
							.filter(document => /\.(?:md|json|txt)$/i.test(document.path))
							.map(document => ({
								path: document.path,
								content:
									typeof document.content === "string"
										? document.content
										: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(document.content),
							})),
						...earlierMaterials,
					],
					decisions: {
						confirmation: group?.confirmation,
						review: group?.review,
						requirementsMerge: group?.merge,
						approvals: sr?.approvals ?? [],
					},
				});
			},
		});
		this.#nativeRoots.add(input.rootSession);
		this.#disposers.push(bindAIReqNativeServiceOwner(input.rootSession, this.#nativeOwner));
	}
	async initialize(): Promise<void> {
		const project = await this.store.registerProject(this.input.cwd, path.basename(this.input.cwd));
		await this.#ensureProjectLease(project);
	}
	#ensureProjectLease(project: AIReqProject): Promise<BrowserProjectLease | undefined> {
		if (this.#closing) return Promise.reject(new Error("AIReq host is exiting"));
		let pending = this.#leases.get(project.id);
		if (!pending) {
			pending = (async () => {
				const owner = nativeOwners.get(project.id);
				if (owner && owner !== this) throw new Error("Project already has another AIReq host");
				const lease =
					normalizePathForComparison(project.root) === normalizePathForComparison(this.input.cwd)
						? undefined
						: await acquireBrowserProject(project.root, "aireq");
				nativeOwners.set(project.id, this);
				return lease;
			})();
			this.#leases.set(project.id, pending);
			void pending.catch(() => {
				if (this.#leases.get(project.id) === pending) this.#leases.delete(project.id);
			});
		}
		return pending;
	}
	#track<T>(task: Promise<T>): Promise<T> {
		this.#work.add(task);
		void task.then(
			() => this.#work.delete(task),
			() => this.#work.delete(task),
		);
		return task;
	}
	observe(listener: (event: object) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	emit(event: object): void {
		for (const listener of this.#listeners) listener(event);
	}
	async view(projectId?: string, selected?: AIReqObjectRef): Promise<AIReqWorkflowView> {
		const view = await this.store.view(projectId);
		if (selected) {
			this.#validateObject(view, selected);
			view.selected = selected;
			const group = [...view.groups, ...view.drafts].find(item => item.id === selected.irId)!;
			const sr = view.srs.find(item => item.id === selected.srId && item.irId === selected.irId);
			const project = view.projects.find(item => item.id === selected.projectId)!;
			view.workspace = {
				path: sr?.worktree?.path ?? this.#requirementCwd(project, group),
				identity: canonicalJson(selected),
			};
		}
		view.running = [];
		for (const pending of this.#projects.values()) {
			const project = await pending;
			const persisted = view.projects.find(item => item.id === project.project.id);
			if (persisted) {
				Object.assign(project.project, persisted);
				const record = readBrowserProject(persisted.id);
				if (record)
					setAIReqNativeProject({
						...record,
						createdAt: Date.parse(persisted.createdAt),
						updatedAt: Date.parse(persisted.updatedAt),
					});
			}
			if (projectId && project.project.id !== projectId) continue;
			for (const ref of project.runtime.references())
				if (project.runtime.session(ref).isStreaming) view.running.push(ref);
		}
		return view;
	}
	#validateObject(view: AIReqWorkflowView, ref: AIReqObjectRef): void {
		if (view.currentProjectId !== ref.projectId) throw new Error("Project identity mismatch");
		if (![...view.groups, ...view.drafts].some(group => group.id === ref.irId && group.projectId === ref.projectId))
			throw new Error("IR identity not found in selected project");
		if (
			ref.srId &&
			!view.srs.some(sr => sr.id === ref.srId && sr.irId === ref.irId && sr.projectId === ref.projectId)
		)
			throw new Error("SR identity does not belong to this IR");
	}
	async bind(
		browserId: string,
		ref: { projectId: string; irId?: string; srId?: string; sessionId?: string; round?: number },
	): Promise<object> {
		if (this.#closing) throw new Error("AIReq host is exiting");
		const view = await this.store.view(ref.projectId);
		this.#assertNativeAdmission(ref.projectId);
		const boundProject = this.#bindings.get(browserId)?.projectId;
		if (boundProject) this.#assertNativeAdmission(boundProject);
		if (ref.irId) this.#validateObject(view, { ...ref, irId: ref.irId });
		else if (ref.srId) throw new Error("SR selection requires its IR");
		const previous = this.#bindings.get(browserId);
		const sessions = ref.irId
			? view.sessions.filter(item => item.irId === ref.irId && item.srId === ref.srId && item.role !== "reviewer")
			: [];
		const session = ref.sessionId
			? sessions.find(item => item.sessionId === ref.sessionId && item.round === ref.round)
			: sessions.at(-1);
		if (ref.sessionId && !session) throw new Error("Native session/round does not belong to the selected AIReq object");
		// Re-reading the exact target is not a new ownership epoch. In particular,
		// observing a session prepared by this page must not revoke its live socket.
		if (
			previous?.projectId === ref.projectId &&
			previous.irId === ref.irId &&
			previous.srId === ref.srId &&
			previous.sessionId === session?.sessionId &&
			previous.round === session?.round
		)
			return { binding: { ...previous }, session };
		const binding = {
			projectId: ref.projectId,
			irId: ref.irId,
			srId: ref.srId,
			sessionId: session?.sessionId,
			round: session?.round,
			epoch: (previous?.epoch ?? 0) + 1,
		};
		this.#bindings.set(browserId, binding);
		this.emit({ t: "binding", browserId, binding });
		return { binding, session };
	}
	binding(browserId: string): BrowserBinding | undefined {
		const value = this.#bindings.get(browserId);
		return value && { ...value };
	}
	assertBrowser(browserId: string, ref: AIReqObjectRef): BrowserBinding {
		const binding = this.#bindings.get(browserId);
		if (!binding || binding.projectId !== ref.projectId || binding.irId !== ref.irId || binding.srId !== ref.srId)
			throw new Error("Browser project/IR/SR binding changed");
		return binding;
	}
	command(browserId: string, command: AIReqWorkflowCommand) {
		return this.#track(this.#executeCommand(browserId, command));
	}
	async #executeCommand(browserId: string, command: AIReqWorkflowCommand) {
		if (this.#closing) throw new Error("AIReq host is exiting");
		if (command.projectId && this.#settlingProjects.has(command.projectId))
			throw new Error("Project workflow control is settling");
		const controlsWork =
			command.type === "stop" || command.type === "backStage" || command.type === "deleteRequirement";
		if (controlsWork && (!command.projectId || !command.irId))
			throw new Error("Workflow control requires an exact project and IR");
		if (controlsWork && command.projectId) this.#settlingProjects.add(command.projectId);
		try {
			if (command.type === "deleteRequirement" && command.projectId) {
				const state = await this.store.read(command.projectId);
				const receipt = state.operations.find(item => item.operationId === command.operationId);
				if (receipt?.status === "completed") {
					if (receipt.commandDigest !== sha256(canonicalJson(command)))
						throw new Error("Operation identity conflict");
					return this.service.command(command);
				}
			}
			if (command.irId) {
				if (!command.projectId) throw new Error("projectId is required");
				this.assertBrowser(browserId, { projectId: command.projectId, irId: command.irId, srId: command.srId });
			}
			if (command.type !== "registerProject" && command.projectId)
				await this.#ensureProjectLease((await this.store.read(command.projectId)).project);
			let admittedRevision: number | undefined;
			if (
				(command.type === "stop" || command.type === "backStage" || command.type === "deleteRequirement") &&
				command.projectId &&
				command.irId
			) {
				const before = await this.store.read(command.projectId);
				await this.service.assertSettlement(command, before);
				const previous = before.operations.find(receipt => receipt.operationId === command.operationId);
				if (previous?.status !== "completed") {
					const ref: AIReqObjectRef = { projectId: command.projectId, irId: command.irId, srId: command.srId };
					const binding = this.assertBrowser(browserId, ref);
					const epoch = binding.epoch;
					const admissions = [...this.#admittedNativeInputs.values()].filter(
						admission => admission.ref.projectId === command.projectId,
					);
					const running = before.operations.filter(receipt => receipt.status === "running");
					if (
						(before.owner || running.length) &&
						(!before.owner ||
							before.owner.hostname !== os.hostname() ||
							before.owner.processId !== process.pid ||
							running.length !== 1 ||
							running[0].type !== "nativeInput" ||
							!admissions.some(
								admission =>
									admission.operationId === running[0].operationId &&
									admission.ref.irId === command.irId &&
									(!command.srId || admission.ref.srId === command.srId),
							))
					)
						throw new Error("Unowned or unrelated unsettled project work blocks workflow control");
					if (this.assertBrowser(browserId, ref).epoch !== epoch)
						throw new Error("Workflow control page binding changed");
					await this.#settleNativeWork(ref, command.type);
					await Promise.all(
						[...this.#nativeTasks].filter(([, id]) => id === command.projectId).map(([task]) => task),
					);
					const after = await this.store.read(command.projectId);
					// Only the exact admitted native receipt may advance while settling.
					// Never rebase a control over unrelated domain changes or operations.
					const authority = (state: AIReqProjectState) =>
						canonicalJson({
							...state,
							revision: 0,
							project: { ...state.project, revision: 0, updatedAt: "" },
							owner: undefined,
							operations: state.operations.filter(
								receipt => !running.some(input => input.operationId === receipt.operationId),
							),
						});
					if (
						after.owner ||
						after.operations.some(receipt => receipt.status === "running") ||
						authority(before) !== authority(after) ||
						running.some(input => {
							const receipt = after.operations.find(item => item.operationId === input.operationId);
							return !receipt || receipt.commandDigest !== input.commandDigest || receipt.type !== input.type;
						})
					)
						throw new Error("Project authority changed during workflow settlement");
					admittedRevision = after.revision;
				}
			}
			if (command.projectId) {
				const pending = this.#projects.get(command.projectId);
				if (pending)
					for (const ref of (await pending).runtime.references())
						if (!command.irId || ref.irId === command.irId) await (await pending).runtime.assertAuthority(ref);
			}
			const staged =
				command.type === "importPackage"
					? this.#packages.get(canonicalJson([browserId, command.projectId, command.packageId]))
					: undefined;
			if (
				command.type === "importPackage" &&
				(!staged || staged.browserId !== browserId || staged.projectId !== command.projectId)
			)
				throw new Error("Package upload does not belong to this browser/project");
			const result =
				command.type === "importPackage"
					? await this.service.importPackage(command, staged!.decoded)
					: await this.service.command(command, admittedRevision);
			const view = await this.view(result.projectId);
			for (const [id, binding] of this.#bindings)
				if (binding.projectId === result.projectId) {
					if (binding.irId && ![...view.groups, ...view.drafts].some(group => group.id === binding.irId)) {
						const cleared: BrowserBinding = { projectId: binding.projectId, epoch: binding.epoch + 1 };
						this.#bindings.set(id, cleared);
						this.#surfaces.get(id)?.unsubscribe();
						this.#surfaces.delete(id);
						this.emit({ t: "binding", browserId: id, binding: cleared });
						continue;
					}
					const session = view.sessions
						.filter(ref => ref.irId === binding.irId && ref.srId === binding.srId && ref.role !== "reviewer")
						.at(-1);
					if (session?.sessionId !== binding.sessionId) {
						binding.sessionId = session?.sessionId;
						binding.round = session?.round;
						binding.epoch++;
						this.emit({ t: "binding", browserId: id, binding: { ...binding } });
					}
				}
			for (const [connectionId, context] of this.#contextObjects)
				if (context.projectId === result.projectId) {
					const page = this.#contexts.get(connectionId)?.browserId;
					const binding = page ? this.#bindings.get(page) : undefined;
					const group = binding?.irId
						? [...view.groups, ...view.drafts].find(item => item.id === binding.irId)
						: undefined;
					const sr = binding?.srId
						? view.srs.find(item => item.id === binding.srId && item.irId === binding.irId)
						: undefined;
					const allowed = sr
						? sr.status === "developing"
						: !!group && group.status !== "frozen" && group.status !== "reviewing" && group.status !== "deleted";
					if (context.inputAllowed !== allowed) {
						Object.assign(context, { inputAllowed: allowed });
						if (context.nativeSession && !context.nativeSession.isDisposed)
							refreshNativeWebGuiSession(context.nativeSession);
					}
				}
			this.emit({ t: "workflow", projectId: result.projectId, view });
			// Return the same committed projection that was published, so the
			// caller can select a created IR without re-reading its old binding.
			return { ...result, view };
		} finally {
			if (controlsWork && command.projectId) this.#settlingProjects.delete(command.projectId);
		}
	}
	async upload(browserId: string, projectId: string, bytes: Uint8Array): Promise<{ packageId: string }> {
		await this.store.read(projectId);
		const decoded = await decodeRequirementPackage(bytes);
		const packageId = decoded.manifest.packageId;
		const key = canonicalJson([browserId, projectId, packageId]);
		const previous = this.#packages.get(key);
		if (previous && previous.decoded.digest !== decoded.digest) throw new Error("Package upload identity conflict");
		this.#packages.set(key, { browserId, projectId, decoded });
		return { packageId };
	}
	async exportPackage(projectId: string, irId: string): Promise<Uint8Array> {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aireq-export-"));
		try {
			const target = path.join(directory, "requirements.zip");
			await this.service.exportPackage(projectId, irId, target);
			return await fs.readFile(target);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	}
	readMaterial(ref: AIReqObjectRef, file: string) {
		safeMaterialPath(file);
		return this.service.readMaterial(ref, file);
	}
	#stagePaths(srId: string, stage: string): string[] {
		const base = `docs/aireq/development/${srId}`;
		return stage === "solution"
			? [`${base}/solution.md`]
			: stage === "planning"
				? [`${base}/plan.md`]
				: stage === "executing"
					? [`${base}/completion.md`, `${base}/ut.md`, `${base}/st.md`]
					: [`${base}/delivery.md`];
	}
	#requirementCwd(project: AIReqProject, group: { id: string; worktree?: { path: string } }): string {
		return group.worktree?.path ?? path.join(project.commonDir, "omp-aireq-workflow-v1", "drafts", group.id);
	}
	async #frozenAuthority(
		cwd: string,
		group: AIReqRequirementGroup,
		snapshot: AIReqRequirementSnapshot,
	): Promise<AIReqFrozenAuthority> {
		// Evidence is frozen alongside the complete IR, every SR and all attachments.
		// Never derive authority digests from checkout bytes: Git filters or real
		// default-branch divergence must still fail the runtime's exact-byte check.
		const versions = [...snapshot.files, ...(group.evidenceFiles ?? [])];
		const documents = await readMaterialFiles(
			cwd,
			versions.map(file => file.path),
		);
		return {
			digest: snapshot.digest,
			files: versions.map(file => ({
				path: file.path,
				content: documents.get(file.path)!,
				digest: file.sha256,
			})),
			roots: [`docs/aireq/requirements/${group.id}`, ...(group.evidenceFiles ?? []).map(file => file.path)],
		};
	}
	async #requirementDocuments(
		state: AIReqProjectState,
		group: AIReqRequirementGroup,
		cwd: string,
	): Promise<AIReqDocument[]> {
		if (!group.files.length) return [];
		const paths = new Set([
			group.documentPath,
			...state.srs.filter(sr => sr.irId === group.id).map(sr => sr.documentPath),
		]);
		const metadata = `docs/aireq/requirements/${group.id}/requirements.json`;
		if (group.files.some(file => file.path === metadata)) paths.add(metadata);
		const versions = new Map(group.files.map(file => [file.path, file]));
		const documents: AIReqDocument[] = [];
		for (const [file, bytes] of await readMaterialFiles(cwd, [...paths])) {
			const version = versions.get(file);
			if (!version || version.size !== bytes.byteLength || version.sha256 !== sha256(bytes))
				throw new Error(`Current requirement material changed outside its recorded snapshot: ${file}`);
			documents.push({ path: file, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
		}
		return documents;
	}
	async #retainImportedAttachments(
		content: AIReqRequirementContent,
		state: AIReqProjectState,
		group: AIReqRequirementGroup,
		cwd: string,
	): Promise<void> {
		validateRequirementContent(content);
		const documents = new Set([
			group.documentPath,
			...state.srs.filter(sr => sr.irId === group.id).map(sr => sr.documentPath),
			content.document.path,
			...content.srs.map(sr => sr.document.path),
			`docs/aireq/requirements/${group.id}/requirements.json`,
		]);
		const supplied = new Set(content.attachments.map(file => file.path));
		const retained = group.files.filter(file => !documents.has(file.path) && !supplied.has(file.path));
		const files = await readMaterialFiles(
			cwd,
			retained.map(file => file.path),
		);
		for (const version of retained) {
			const bytes = files.get(version.path)!;
			if (version.size !== bytes.byteLength || version.sha256 !== sha256(bytes))
				throw new Error(`Imported attachment changed outside its recorded snapshot: ${version.path}`);
			content.attachments.push({ path: version.path, content: bytes });
		}
	}
	#interactionUiOwner(
		projectId: string,
		runtime: AIReqWorkflowRuntime,
		ref: AIReqNativeSessionRef,
		session: AgentSession,
	): AgentSession {
		if (
			ref.projectId !== projectId ||
			session.isDisposed ||
			session.sessionId !== ref.sessionId ||
			session.sessionFile !== ref.sessionFile
		)
			throw new Error("Native UI construction has another owned session identity");
		if (ref.role !== "reviewer") return session;
		const requirement = runtime
			.references()
			.find(
				owner =>
					owner.projectId === projectId &&
					owner.irId === ref.irId &&
					!owner.srId &&
					owner.phase === "requirements" &&
					owner.role === "requirements" &&
					owner.round === ref.round,
			);
		if (!requirement) throw new Error("Independent reviewer has no local requirements UI owner");
		const parent = runtime.session(requirement);
		const registry = parent.agentRegistry;
		const parentId = parent.getAgentId();
		const childId = session.getAgentId();
		if (
			parent.isDisposed ||
			!registry ||
			registry !== session.agentRegistry ||
			!parentId ||
			!childId ||
			registry.get(childId)?.session !== session ||
			!specDescendantAgentIds(registry, parentId).includes(childId)
		)
			throw new Error("Independent reviewer UI has another native registry ancestry");
		return parent;
	}
	async project(projectId: string): Promise<ProjectRuntime> {
		if (this.#closing) throw new Error("AIReq host is exiting");
		let pending = this.#projects.get(projectId);
		if (!pending) {
			pending = (async () => {
				const state = await this.store.read(projectId);
				const project = state.project;
				const lease = await this.#ensureProjectLease(project);
				const same = normalizePathForComparison(project.root) === normalizePathForComparison(this.input.cwd);
				const settings = same ? this.input.settings : await this.input.settings.cloneForCwd(project.root);
				let created: CreateAgentSessionResult | undefined;
				if (!same) {
					const registry = new AgentRegistry();
					created = await AgentRegistry.runScoped(registry, () =>
						createAgentSession({
							cwd: project.root,
							settings,
							sessionManager: SessionManager.inMemory(project.root),
							model: this.input.rootSession.model,
							modelRegistry: this.input.rootSession.modelRegistry,
							authStorage: this.input.rootSession.modelRegistry.authStorage,
							agentRegistry: registry,
							bindProcessState: false,
							hasUI: true,
							interactivePrompts: true,
							deferSkillDescriptionCompression: true,
						}),
					);
				}
				const root = created?.session ?? this.input.rootSession;
				if (!this.#nativeRoots.has(root)) {
					this.#nativeRoots.add(root);
					this.#disposers.push(bindAIReqNativeServiceOwner(root, this.#nativeOwner));
				}
				if (created?.mcpManager && this.input.mcpAuth && !created.mcpManager.getAuthHandler()) {
					const manager = created.mcpManager;
					const handler = this.input.mcpAuth;
					manager.setAuthHandler(handler);
					this.#disposers.push(() => {
						if (manager.getAuthHandler() === handler) manager.setAuthHandler(undefined);
					});
				}
				const runtime = await createAIReqWorkflowRuntime({
					projectId,
					rootSession: root,
					settings,
					cwd: project.root,
					assertCurrent: async binding => {
						if (this.#closing) throw new Error("AIReq native host is exiting");
						const live = await this.store.read(projectId);
						const group = live.groups.find(item => item.id === binding.irId);
						if (!group || group.status === "deleted") throw new Error("Native IR identity ended");
						if (binding.srId) {
							const sr = live.srs.find(item => item.id === binding.srId && item.irId === binding.irId);
							if (!sr || sr.round !== binding.round || sr.stage !== binding.phase || sr.status !== "developing")
								throw new Error("Native SR phase/round has changed");
						} else if (
							group.status === "frozen" ||
							(group.sessions.length
								? !group.sessions.some(
										session => session.round === binding.round && session.phase === "requirements",
									)
								: binding.round !== 0)
						)
							throw new Error("Native requirement round is no longer writable");
					},
					uiForSession: (session, owner) =>
						nativeWebGuiQuestions(this.#interactionUiOwner(projectId, runtime, owner, session)).ui,
					createInteractionUI: (origin, owner) => {
						if (owner.projectId !== projectId) throw new Error("Native descendant has another AIReq project owner");
						const session = runtime.session(owner);
						if (session.isDisposed) throw new Error("Native descendant owner ended");
						if (origin.parentSessionId !== owner.sessionId) {
							const registry = session.agentRegistry;
							const id = session.getAgentId();
							if (
								!registry ||
								!id ||
								!specDescendantAgentIds(registry, id).some(childId => {
									const child = registry.get(childId)?.session;
									return (
										!!child &&
										isLocalAgentSession(child) &&
										!child.isDisposed &&
										child.sessionId === origin.parentSessionId
									);
								})
							)
								throw new Error("Native descendant has no matching AIReq registry ancestry");
						}
						const controller = new AbortController();
						const parentUi = nativeWebGuiQuestions(
							this.#interactionUiOwner(projectId, runtime, owner, session),
						).ui;
						const methods = new Map<
							PropertyKey,
							{ original: unknown; wrapped: (...values: unknown[]) => unknown }
						>();
						const ui = new Proxy(parentUi, {
							get(target, key) {
								const original = Reflect.get(target, key, target);
								const index =
									key === "approve" || key === "askDialog"
										? 1
										: key === "select" || key === "confirm" || key === "input" || key === "editor"
											? 2
											: undefined;
								if (index === undefined || typeof original !== "function") return original;
								const previous = methods.get(key);
								if (previous && previous.original === original) return previous.wrapped;
								const wrapped = (...values: unknown[]) => {
									const options = (values[index] ?? {}) as ExtensionUIDialogOptions;
									values[index] = {
										...options,
										signal: options.signal
											? AbortSignal.any([options.signal, controller.signal])
											: controller.signal,
									};
									return Reflect.apply(original, target, values);
								};
								methods.set(key, { original, wrapped });
								return wrapped;
							},
						});
						const cancel = () => controller.abort(new Error("Native descendant interaction ended"));
						return { ui, cancel, dispose: cancel };
					},
					onSessionCreated: (ref, session) => {
						const unsubscribe = session.subscribe(event => this.emit({ t: "native", binding: ref, event }));
						this.#disposers.push(unsubscribe);
						this.#ownedSessions.set(ref.sessionId, session);
						this.#disposers.push(bindAIReqNativeServiceOwner(session, this.#nativeOwner));
						for (const [id, identity] of this.#contexts)
							if (identity.sessionId === ref.sessionId) {
								const context = this.#contextObjects.get(id);
								if (context)
									Object.assign(context, {
										nativeSession: session,
										workspacePath: session.sessionManager.getCwd(),
									});
							}
						this.#disposers.push(bindAIReqNativeCollabProjection(session, this.collab));
						const record = {
							projectId,
							root: project.root,
							createdAt: Date.parse(project.createdAt),
							updatedAt: Date.parse(project.updatedAt),
							mode: "aireq" as const,
							phase: "active" as const,
							ownerId: projectId,
							pid: process.pid,
							allowLan: false,
							nativeSession: root,
							nativeSessions: new Set(runtime.references().map(item => runtime.session(item))),
							pendingModelSelections: new Set<Promise<void>>(),
						};
						record.nativeSessions.add(session);
						setAIReqNativeProject(record);
						const manager = session.nativeChildCapabilities?.mcpManager;
						this.#disposers.push(
							bindNativeWebGuiCommandEnvironment(session, {
								mcpManager: manager instanceof MCPManager ? manager : created?.mcpManager,
							}),
						);
						notifyAIReqNativeSessions();
					},
				});
				setAIReqNativeProject({
					projectId,
					root: project.root,
					createdAt: Date.parse(project.createdAt),
					updatedAt: Date.parse(project.updatedAt),
					mode: "aireq",
					phase: "active",
					ownerId: projectId,
					pid: process.pid,
					allowLan: false,
					nativeSession: root,
					nativeSessions: new Set(),
					pendingModelSelections: new Set(),
				});
				if (lease) await lease.activate(() => readWebGuiSessionInfo(root), { nativeSession: root });
				return { project, root, settings, runtime, owned: !same, lease };
			})();
			this.#projects.set(projectId, pending);
		}
		return pending;
	}
	async prepare(browserId: string, ref: AIReqObjectRef, authorizeWrites = false): Promise<AIReqNativeSessionRef> {
		this.#assertNativeAdmission(ref.projectId);
		const epoch = this.assertBrowser(browserId, ref).epoch;
		const project = await this.project(ref.projectId);
		const state = await this.store.read(ref.projectId);
		const group = state.groups.find(item => item.id === ref.irId);
		if (!group) throw new Error("IR not found");
		const sr = ref.srId ? state.srs.find(item => item.id === ref.srId && item.irId === ref.irId) : undefined;
		if (ref.srId && (!sr || sr.status !== "developing" || !sr.stage))
			throw new Error("SR is not developing; start it explicitly first");
		if (!ref.srId && (group.status === "frozen" || group.status === "deleted" || group.status === "reviewing"))
			throw new Error("This requirement snapshot is read-only");
		const phase = sr?.stage ?? "requirements";
		const existing = (sr?.sessions ?? group.sessions)
			.filter(item => item.phase === phase && (!sr || item.round === sr.round) && item.role !== "reviewer")
			.at(-1);
		const round = sr?.round ?? existing?.round ?? 0;
		const cwd = sr?.worktree?.path ?? this.#requirementCwd(project.project, group);
		await fs.mkdir(cwd, { recursive: true });
		const binding: AIReqWorkflowBinding = {
			projectId: ref.projectId,
			irId: ref.irId,
			srId: ref.srId,
			phase,
			round,
		};
		const authority = sr && group.snapshot ? await this.#frozenAuthority(cwd, group, group.snapshot) : undefined;
		const native = await project.runtime.prepare({
			binding,
			cwd,
			sessionRef: existing,
			authorizeWrites: authorizeWrites && phase === "executing",
			outputPaths: sr ? this.#stagePaths(sr.id, phase) : [`docs/aireq/intake/${ref.irId}/requirements.json`],
			authority,
			decisions: {
				origin: group.origin,
				packageId: group.packageId,
				packageDigest: group.packageDigest,
				snapshot: group.snapshot,
				files: group.files,
				confirmation: group.confirmation,
				review: group.review,
				requirementsMerge: group.merge,
				approvals: sr?.approvals ?? [],
			},
			contextFiles: sr
				? await Promise.all(
						sr.materials
							.filter(material => material.valid)
							.map(async material => ({
								path: material.path,
								content: await fs.readFile(path.join(cwd, material.path), "utf8"),
							})),
					)
				: await this.#requirementDocuments(state, group, cwd),
		});
		this.#assertNativeAdmission(ref.projectId);
		if (!existing) {
			const result = await this.service.bindSession(ref, state.revision, randomUUID(), native);
			if (result.status !== "completed") throw new Error(result.error ?? "Native session binding failed");
		}
		const current = this.assertBrowser(browserId, ref);
		if (current.epoch !== epoch) throw new Error("Native browser object binding changed");
		current.sessionId = native.sessionId;
		current.round = native.round;
		this.#activateSurface(browserId, native, project.runtime.session(native));
		this.emit({ t: "workflow", projectId: ref.projectId, view: await this.view(ref.projectId) });
		return native;
	}
	ownsSession(session: AgentSession): boolean {
		return this.#ownedSessions.get(session.sessionId) === session;
	}
	async ingest(session: AgentSession): Promise<void> {
		if (session.isStreaming || session.isDisposed || this.#closing) return;
		const existing = this.#ingesting.get(session.sessionId);
		if (existing) return existing;
		const task = (async () => {
			for (const pending of this.#projects.values()) {
				const project = await pending;
				const ref = project.runtime.references().find(item => item.sessionId === session.sessionId);
				if (!ref || ref.role === "reviewer") continue;
				if (this.#settlingProjects.has(ref.projectId)) return;
				await project.runtime.assertAuthority(ref);
				const state = await this.store.read(ref.projectId);
				if (ref.phase === "requirements") {
					const target = path.join(
						session.sessionManager.getCwd(),
						`docs/aireq/intake/${ref.irId}/requirements.json`,
					);
					let raw: string;
					try {
						raw = await fs.readFile(target, "utf8");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
						throw error;
					}
					const content = JSON.parse(raw) as AIReqRequirementContent;
					const digest = sha256(raw);
					const group = state.groups.find(item => item.id === ref.irId);
					if (!group || group.status === "frozen" || group.status === "deleted" || group.status === "reviewing")
						return;
					if (group.origin === "import")
						await this.#retainImportedAttachments(content, state, group, session.sessionManager.getCwd());
					const saved = await this.service.updateRequirements(
						ref,
						state.revision,
						`intake-${ref.sessionId}-${digest}`,
						content,
					);
					if (saved.status === "failed") throw new Error(saved.error ?? "Requirement output ingestion failed");
				} else {
					const documents: AIReqStageDocument[] = [];
					for (const file of this.#stagePaths(ref.srId!, ref.phase)) {
						try {
							documents.push({
								path: file,
								kind: path.basename(file, ".md") as AIReqStageDocument["kind"],
								content: await fs.readFile(path.join(session.sessionManager.getCwd(), file), "utf8"),
							});
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						}
					}
					if (documents.length !== this.#stagePaths(ref.srId!, ref.phase).length) return;
					const saved = await this.service.saveStageMaterials(
						ref,
						state.revision,
						`materials-${ref.sessionId}-${sha256(canonicalJson(documents))}`,
						ref.phase,
						ref.round,
						documents,
					);
					if (saved.status === "failed") throw new Error(saved.error ?? "Formal native material ingestion failed");
					if (ref.phase === "executing" && session.getGoalModeState()?.enabled)
						await session.goalRuntime.pauseGoal();
				}
				this.emit({ t: "workflow", projectId: ref.projectId, view: await this.view(ref.projectId) });
				return;
			}
		})();
		this.#ingesting.set(session.sessionId, task);
		try {
			await task;
		} finally {
			this.#ingesting.delete(session.sessionId);
		}
	}
	collabView(browserId: string) {
		const snapshot = this.collab.read(browserId);
		const target = snapshot?.participant;
		if (snapshot?.status === "joined" && snapshot.header && snapshot.state && target)
			return {
				snapshot,
				conversation: this.collab.conversation(browserId, target),
				summary: this.collab.summary(browserId, target),
			};
		return { snapshot };
	}
	async workspace(browserId: string, projectId?: string) {
		const binding = this.#bindings.get(browserId);
		const id = projectId ?? binding?.projectId ?? (await this.store.listProjects())[0]?.id;
		if (!id) throw new Error("Select a registered AIReq project");
		if (binding && binding.projectId !== id) throw new Error("Browser project binding changed");
		const state = await this.store.read(id);
		const group = binding?.irId ? state.groups.find(item => item.id === binding.irId) : undefined;
		if (binding?.irId && (!group || group.status === "deleted"))
			throw new Error("IR identity is no longer available");
		const sr = binding?.srId
			? state.srs.find(item => item.id === binding.srId && item.irId === binding.irId)
			: undefined;
		if (binding?.srId && !sr) throw new Error("SR identity is no longer available");
		const cwd = sr?.worktree?.path ?? (group ? this.#requirementCwd(state.project, group) : state.project.root);
		const sessions = (sr?.sessions ?? group?.sessions ?? []).filter(item => item.role !== "reviewer");
		const session = binding?.sessionId
			? sessions.find(item => item.sessionId === binding.sessionId && item.round === binding.round)
			: sessions.at(-1);
		if (binding?.sessionId && !session) throw new Error("Bound native session/round is no longer available");
		return {
			project: state.project,
			binding,
			cwd,
			session,
			inputAllowed:
				session?.sessionId === sessions.at(-1)?.sessionId &&
				(sr
					? sr.status === "developing"
					: !!group && group.status !== "frozen" && group.status !== "deleted" && group.status !== "reviewing"),
			workspaceIdentity: canonicalJson({ projectId: id, irId: binding?.irId, srId: binding?.srId }),
		};
	}
	#activateSurface(browserId: string, ref: AIReqNativeSessionRef, session: AgentSession): void {
		const binding = this.assertBrowser(browserId, ref);
		const epoch = binding.epoch;
		const target: AIReqNativeSurfaceTarget = {
			projectId: ref.projectId,
			irId: ref.irId,
			srId: ref.srId,
			sessionId: ref.sessionId,
			phase: ref.phase,
			round: ref.round,
			clientId: browserId.slice(browserId.lastIndexOf(":") + 1),
		};
		const current = () => {
			const live = this.assertBrowser(browserId, ref);
			if (live.epoch !== epoch || live.sessionId !== ref.sessionId || live.round !== ref.round)
				throw new Error("Native surface page/session/round binding changed");
			return target;
		};
		const prior = this.#surfaces.get(browserId);
		if (prior && prior.epoch === epoch && canonicalJson(prior.target) === canonicalJson(target)) return;
		prior?.unsubscribe();
		bindAIReqNativeSurface(session, target, current);
		const unsubscribe = subscribeAIReqNativeSurface(session, target, event =>
			this.emit({ t: "native-surface", projectId: ref.projectId, browserId, target, event }),
		);
		this.#surfaces.set(browserId, { target, epoch, unsubscribe });
	}
	async #surfaceOwner(browserId: string, target: AIReqNativeSurfaceTarget) {
		this.assertBrowser(browserId, target);
		if (target.clientId !== browserId.slice(browserId.lastIndexOf(":") + 1))
			throw new Error("Native surface belongs to another page");
		const binding = this.binding(browserId);
		if (binding?.sessionId !== target.sessionId || binding.round !== target.round)
			throw new Error("Native surface session/round changed");
		const project = await this.project(target.projectId);
		let ref = project.runtime.references().find(item => item.sessionId === target.sessionId);
		if (!ref) {
			const context = await this.nativeContext(browserId, target.projectId);
			this.closeNativeContext(context);
			ref = project.runtime.references().find(item => item.sessionId === target.sessionId);
		}
		if (
			!ref ||
			ref.phase !== target.phase ||
			ref.round !== target.round ||
			ref.irId !== target.irId ||
			ref.srId !== target.srId
		)
			throw new Error("Native surface object/phase/round identity mismatch");
		const session = project.runtime.session(ref);
		this.#activateSurface(browserId, ref, session);
		return session;
	}
	async surfaceSnapshot(browserId: string, target: AIReqNativeSurfaceTarget) {
		return aiReqNativeSurfaceSnapshot(await this.#surfaceOwner(browserId, target), target);
	}
	async surfaceEditor(browserId: string, target: AIReqNativeSurfaceTarget, text: string) {
		updateAIReqNativeSurfaceEditor(await this.#surfaceOwner(browserId, target), target, text);
		return { accepted: true };
	}
	async surfaceResponse(
		browserId: string,
		target: AIReqNativeSurfaceTarget,
		requestId: string,
		answer: NativeWebGuiInteractionAnswer,
	) {
		await respondAIReqNativeSurface(await this.#surfaceOwner(browserId, target), target, requestId, answer);
		return { accepted: true };
	}
	async surfacePrediction(browserId: string, target: AIReqNativeSurfaceTarget, action: AIReqNativePredictionAction) {
		return {
			accepted: true,
			...aiReqNativePredictionAction(await this.#surfaceOwner(browserId, target), target, action),
		};
	}
	async nativeContext(browserId: string, projectId?: string): Promise<WebGuiServiceContext> {
		const metadata = await this.workspace(browserId, projectId);
		const binding = metadata.binding;
		const epoch = binding?.epoch ?? 0;
		const id = metadata.project.id;
		const project = await this.project(id);
		let session: AgentSession | undefined;
		if (metadata.session) {
			let native = project.runtime.references().find(item => item.sessionId === metadata.session!.sessionId);
			if (!native) {
				const saved = metadata.session;
				const state = await this.store.read(id);
				const group = state.groups.find(item => item.id === saved.irId);
				const authority =
					saved.srId && group?.snapshot
						? await this.#frozenAuthority(metadata.cwd, group, group.snapshot)
						: undefined;
				native = await project.runtime.prepare({
					binding: saved,
					cwd: metadata.cwd,
					sessionRef: saved,
					readonlyRecovery: !metadata.inputAllowed,
					outputPaths:
						saved.phase === "requirements"
							? [`docs/aireq/intake/${saved.irId}/requirements.json`]
							: this.#stagePaths(saved.srId!, saved.phase),
					authority,
				});
			}
			session = project.runtime.session(native);
			if ((this.#bindings.get(browserId)?.epoch ?? 0) !== epoch)
				throw new Error("Native browser object binding changed");
			if (binding?.irId) this.#activateSurface(browserId, native, session);
		}
		if ((this.#bindings.get(browserId)?.epoch ?? 0) !== epoch)
			throw new Error("Native browser object binding changed");
		const abort = new AbortController();
		const context: WebGuiServiceContext = {
			connectionId: randomUUID(),
			projectId: id,
			workspacePath: metadata.cwd,
			agentDir: project.settings.getAgentDir(),
			nativeOwner: this.#nativeOwner,
			nativeSession: session,
			inputAllowed: metadata.inputAllowed,
			signal: abort.signal,
		};
		this.#contexts.set(context.connectionId, {
			browserId,
			epoch,
			sessionId: session?.sessionId,
		});
		this.#contextObjects.set(context.connectionId, context);
		this.#contextAborts.set(context.connectionId, abort);
		return context;
	}
	closeNativeContext(context: WebGuiServiceContext): void {
		this.#contextAborts.get(context.connectionId)?.abort();
		this.#contextAborts.delete(context.connectionId);
		this.#contextObjects.delete(context.connectionId);
		this.#contexts.delete(context.connectionId);
	}
	assertNativeContext(context: WebGuiServiceContext, sessionId?: string): void {
		if (context.nativeOwner !== this.#nativeOwner) throw new Error("Native connection owner mismatch");
		if (this.#closing) throw new Error("AIReq host is exiting");
		const identity = this.#contexts.get(context.connectionId);
		if (!identity) throw new Error("Unknown AIReq native connection");
		const current = this.#bindings.get(identity.browserId);
		if ((current?.epoch ?? 0) !== identity.epoch || (current && current.projectId !== context.projectId))
			throw new Error("Native browser object binding changed");
		if (sessionId && sessionId !== (current?.sessionId ?? identity.sessionId))
			throw new Error("Native session does not belong to the selected AIReq object");
	}
	async prepareContext(context: WebGuiServiceContext): Promise<AgentSession> {
		this.assertNativeContext(context);
		const identity = this.#contexts.get(context.connectionId)!;
		const binding = this.#bindings.get(identity.browserId);
		if (!binding?.irId) throw new Error("Select an IR/SR before creating a native conversation");
		if (context.inputAllowed === false) throw new Error("Selected native session is read-only");
		const ref = await this.prepare(identity.browserId, { ...binding, irId: binding.irId });
		const project = await this.project(ref.projectId);
		const session = project.runtime.session(ref);
		Object.assign(context, {
			nativeSession: session,
			workspacePath: session.sessionManager.getCwd(),
			inputAllowed: true,
		});
		identity.sessionId = ref.sessionId;
		return session;
	}
	submit(
		browserId: string,
		input: AIReqObjectRef & {
			operationId: string;
			expectedRevision: number;
			sessionId?: string;
			round?: number;
			text: string;
		},
	): Promise<object> {
		return this.#track(this.#executeSubmit(browserId, input));
	}
	async #executeSubmit(
		browserId: string,
		input: AIReqObjectRef & {
			operationId: string;
			expectedRevision: number;
			sessionId?: string;
			round?: number;
			text: string;
		},
	): Promise<object> {
		if (this.#closing) throw new Error("AIReq host is exiting");
		if (!input.text.trim()) throw new Error("Native message text is required");
		const current = this.assertBrowser(browserId, input);
		const digest = sha256(canonicalJson(input));
		const old = this.#inputs.get(input.operationId);
		if (old) {
			if (old.browserId !== browserId || old.digest !== digest) throw new Error("Input operation identity conflict");
			return { operationId: input.operationId, status: old.status, error: old.error };
		}
		for (const admission of this.#admittedNativeInputs.values())
			if (admission.ref.projectId === input.projectId)
				throw new Error("A durable native input already owns this project; use its native follow-up queue");
		const state = await this.store.read(input.projectId);
		if (state.revision !== input.expectedRevision) throw new Error("Stale workflow revision");
		if (input.sessionId !== undefined && (input.sessionId !== current.sessionId || input.round !== current.round))
			throw new Error("Native session/round binding changed");
		const receipt = { browserId, digest, status: "running", error: undefined as string | undefined };
		this.#inputs.set(input.operationId, receipt);
		let ref: AIReqNativeSessionRef;
		try {
			ref = await this.prepare(browserId, input, hasExplicitRepairIntent(input.text));
		} catch (error) {
			receipt.status = "failed";
			receipt.error = String(error);
			throw error;
		}
		const project = await this.project(ref.projectId);
		const preparedState = await this.store.read(ref.projectId);
		const task = this.store
			.mutate(
				ref.projectId,
				preparedState.revision,
				input.operationId,
				{ type: "nativeInput", browserId, input, session: ref },
				async () => {
					await this.#runAdmittedNativeInput(
						project.runtime.session(ref),
						ref,
						input.operationId,
						"prompt",
						{ browserId, epoch: current.epoch },
						() => project.runtime.submit(ref, input.text),
					);
				},
			)
			.then(async result => {
				// A replay observes completion only after formal ingestion has
				// settled; the native turn's receipt alone is not that boundary.
				if (result.status === "completed") await this.ingest(project.runtime.session(ref));
				this.emit({ t: "workflow", projectId: ref.projectId, view: await this.view(ref.projectId) });
				receipt.status = result.status;
				receipt.error = result.error;
			})
			.catch(error => {
				receipt.status = "failed";
				receipt.error = String(error);
				this.emit({ t: "error", binding: ref, error: receipt.error });
			});
		this.#work.add(task);
		this.#nativeTasks.set(task, ref.projectId);
		void task.finally(() => {
			this.#work.delete(task);
			this.#nativeTasks.delete(task);
		});
		return { operationId: input.operationId, status: receipt.status, session: ref };
	}
	async stopNativeInput(session: AgentSession): Promise<void> {
		for (const pending of this.#projects.values()) {
			const project = await pending;
			const ref = project.runtime.references().find(item => item.sessionId === session.sessionId);
			if (!ref) continue;
			this.#assertNativeAdmission(ref.projectId);
			this.#settlingProjects.add(ref.projectId);
			try {
				await this.#settleNativeWork(ref, "stop");
				await Promise.all([...this.#nativeTasks].filter(([, id]) => id === ref.projectId).map(([task]) => task));
				this.emit({ t: "workflow", projectId: ref.projectId, view: await this.view(ref.projectId) });
			} finally {
				this.#settlingProjects.delete(ref.projectId);
			}
			return;
		}
		throw new Error("Native stop owner is no longer available");
	}
	#assertNativeAdmission(projectId: string): void {
		if (this.#settlingProjects.has(projectId)) throw new Error("Project workflow control is settling");
	}
	/** Abort first; neither command drains nor surface cleanup may wait ahead of the turn they settle. */
	async #settleNativeWork(ref: AIReqObjectRef, reason: string): Promise<void> {
		const pending = this.#projects.get(ref.projectId);
		if (!pending) return;
		const project = await pending;
		const sessions = project.runtime
			.references()
			.filter(native => native.irId === ref.irId && (!ref.srId || native.srId === ref.srId))
			.map(native => project.runtime.session(native));
		for (const session of sessions) {
			nativeWebGuiQuestions(session).cancelPendingInteractions(reason);
			for (const [page, surface] of this.#surfaces)
				if (surface.target.sessionId === session.sessionId) {
					surface.unsubscribe();
					this.#surfaces.delete(page);
				}
		}
		const binding: AIReqWorkflowBinding = { ...ref, phase: "requirements", round: 0 };
		const stopping = reason.includes("back") ? project.runtime.back(binding) : project.runtime.stop(binding);
		const settled = await Promise.allSettled([
			stopping,
			...sessions.map(session => beginNativeWebGuiHostStop(session)),
			...sessions.map(session => releaseAIReqNativeSurface(session)),
			...sessions.map(session => stopNativeWebGuiCommands(session)),
		]);
		const failures = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
		if (failures.length)
			throw new AggregateError(
				failures.map(item => item.reason),
				"Native workflow settlement failed; authority retained",
			);
	}
	/** One durable input owns its native queue/steer admissions and their final settlement. */
	async #runAdmittedNativeInput<T>(
		session: AgentSession,
		ref: AIReqNativeSessionRef,
		operationId: string,
		kind: AIReqNativeInputKind,
		browser: AdmittedNativeInput["browser"],
		operation: () => Promise<T>,
	): Promise<T> {
		this.#assertNativeAdmission(ref.projectId);
		if (this.#admittedNativeInputs.has(session)) throw new Error("Native input already has a durable owner");
		const admission: AdmittedNativeInput = { operationId, ref, kind, browser, joins: new Set() };
		this.#admittedNativeInputs.set(session, admission);
		try {
			// Publish the durable running revision before the held turn begins.
			// Controls must use that revision, not the last completed input's view.
			this.emit({ t: "workflow", projectId: ref.projectId, view: await this.view(ref.projectId) });
			this.#assertNativeAdmission(ref.projectId);
			return await operation();
		} finally {
			// Queue acknowledgements can finish their authority checks after the
			// primary prompt settles. Never complete its receipt ahead of them.
			while (admission.joins.size) await Promise.allSettled(admission.joins);
			this.#admittedNativeInputs.delete(session);
		}
	}
	async runNativeInput<T>(
		session: AgentSession,
		operation: () => Promise<T>,
		text?: string,
		kind: AIReqNativeInputKind = "prompt",
	): Promise<T> {
		if (this.#closing || session.isDisposed) throw new Error("Native input owner is no longer active");
		const origin = nativeWebGuiInteractionOrigin();
		const context = origin ? this.#contextObjects.get(origin.connectionId) : undefined;
		const identity = context ? this.#contexts.get(context.connectionId) : undefined;
		const browser = identity ? { browserId: identity.browserId, epoch: identity.epoch } : undefined;
		const assertOrigin = () => {
			if (!context || !identity || origin?.sessionId !== session.sessionId || context.nativeSession !== session)
				throw new Error("Native follow-up requires its exact originating browser session");
			this.assertNativeContext(context, session.sessionId);
		};
		if (kind === "prompt" && origin) assertOrigin();
		for (const pending of this.#projects.values()) {
			const project = await pending;
			const ref = project.runtime.references().find(item => item.sessionId === session.sessionId);
			if (!ref) continue;
			this.#assertNativeAdmission(ref.projectId);
			if (project.runtime.session(ref) !== session) throw new Error("Native input session identity mismatch");
			const admission = this.#admittedNativeInputs.get(session);
			if (admission) {
				assertOrigin();
				if (
					kind !== "prompt" ||
					admission.kind !== "prompt" ||
					!session.isStreaming ||
					admission.browser?.browserId !== browser?.browserId ||
					admission.browser?.epoch !== browser?.epoch ||
					canonicalJson(admission.ref) !== canonicalJson(ref)
				)
					throw new Error("Only the admitted native input's browser may queue or guide its current turn");
				// Do not acquire mutation.lock again: the first input already owns
				// it until native work and descendants settle. Runtime admission
				// still checks the exact phase, round, stop state and frozen files.
				const joined = project.runtime.runInput(
					ref,
					() => {
						assertOrigin();
						if (this.#admittedNativeInputs.get(session) !== admission || !session.isStreaming)
							throw new Error("The admitted native turn ended before follow-up admission");
						return operation();
					},
					kind,
				);
				admission.joins.add(joined);
				const settled = () => admission.joins.delete(joined);
				void joined.then(settled, settled);
				return joined;
			}
			for (const other of this.#admittedNativeInputs.values())
				if (other.ref.projectId === ref.projectId)
					throw new Error("Another admitted native input owns this project");
			if (kind === "prompt" && ref.phase === "executing" && text && hasExplicitRepairIntent(text)) {
				const state = await this.store.read(ref.projectId);
				const group = state.groups.find(item => item.id === ref.irId);
				if (!group?.snapshot || !ref.srId)
					throw new Error("Explicit repair requires the current frozen SR authority");
				const cwd = session.sessionManager.getCwd();
				await project.runtime.prepare({
					binding: ref,
					cwd,
					sessionRef: ref,
					authorizeWrites: true,
					outputPaths: this.#stagePaths(ref.srId, ref.phase),
					authority: await this.#frozenAuthority(cwd, group, group.snapshot),
				});
			}
			let value: T | undefined;
			const state = await this.store.read(ref.projectId);
			const operationId = randomUUID();
			const task = this.store.mutate(
				ref.projectId,
				state.revision,
				operationId,
				{ type: "nativeInput", session: ref, kind },
				async () => {
					if (kind === "prompt" && origin) assertOrigin();
					value = await this.#runAdmittedNativeInput(session, ref, operationId, kind, browser, () =>
						project.runtime.runInput(ref, operation, kind),
					);
				},
			);
			this.#nativeTasks.set(task, ref.projectId);
			let result: Awaited<typeof task>;
			try {
				result = await task;
			} finally {
				this.#nativeTasks.delete(task);
			}
			if (result.status !== "completed") throw new Error(result.error ?? "Native input failed");
			await this.ingest(session);
			this.emit({ t: "workflow", projectId: ref.projectId, view: await this.view(ref.projectId) });
			return value as T;
		}
		throw new Error("Native session is no longer bound to a AIReq workflow");
	}
	async resolveMcpSession(scope: string, toolCallId: string): Promise<AgentSession> {
		for (const pending of this.#projects.values()) {
			const project = await pending;
			const state = await this.store.read(project.project.id);
			for (const ref of project.runtime.references()) {
				const group = state.groups.find(item => item.id === ref.irId);
				const sr = ref.srId ? state.srs.find(item => item.id === ref.srId && item.irId === ref.irId) : undefined;
				if (
					!group ||
					(ref.srId
						? !sr || sr.status !== "developing" || sr.stage !== ref.phase || sr.round !== ref.round
						: group.status === "frozen" || group.status === "deleted")
				)
					continue;
				const root = project.runtime.session(ref);
				const registry = root.agentRegistry;
				const ownerId = root.getAgentId();
				const descendants =
					registry && ownerId
						? specDescendantAgentIds(registry, ownerId)
								.map(id => registry.get(id)?.session)
								.filter((session): session is AgentSession => !!session && isLocalAgentSession(session))
						: [];
				for (const session of [root, ...descendants])
					if (
						!session.isDisposed &&
						session.sessionManager.getSessionId() === scope &&
						session.agent.state.pendingToolCalls.has(toolCallId)
					)
						return session;
			}
		}
		throw new Error("MCP authorization no longer belongs to an active AIReq native tool call");
	}
	nativeUiOwner(session: AgentSession): AgentSession {
		if (this.ownsSession(session)) return session;
		const id = session.getAgentId();
		for (const root of this.#ownedSessions.values()) {
			const registry = root.agentRegistry;
			const ownerId = root.getAgentId();
			if (
				registry &&
				ownerId &&
				id &&
				registry.get(id)?.session === session &&
				specDescendantAgentIds(registry, ownerId).includes(id)
			)
				return root;
		}
		throw new Error("Native interaction is not a descendant of this AIReq owner");
	}
	async close(): Promise<void> {
		this.#closing = true;
		const failures = [];
		for (const lease of this.#leases.values())
			try {
				await (await lease)?.markExiting();
			} catch (error) {
				failures.push(error);
			}
		try {
			await this.collab.close();
		} catch (error) {
			failures.push(error);
		}
		for (const pending of this.#projects.values())
			try {
				const project = await pending;
				for (const ref of project.runtime.references()) {
					const session = project.runtime.session(ref);
					nativeWebGuiQuestions(session).cancelPendingInteractions("AIReq host exit");
					await releaseAIReqNativeSurface(session);
					await disposeNativeWebGuiCommands(session);
				}
				await project.runtime.dispose();
				if (project.owned) await project.root.dispose();
				await project.settings.flush();
			} catch (error) {
				failures.push(error);
			}
		await Promise.allSettled(this.#nativeTasks.keys());
		await settleAIReqNativeMutations(this.#nativeOwner);
		try {
			await settleAIReqNativeAttachments(new Set(this.#projects.keys()));
		} catch (error) {
			failures.push(error);
		}
		while (this.#work.size) await Promise.allSettled(this.#work);
		await Promise.all(this.#ingesting.values());
		if (failures.length) throw new AggregateError(failures, "AIReq native work remains unsettled; ownership retained");
		for (const dispose of this.#disposers) dispose();
		for (const [id, owner] of nativeOwners)
			if (owner === this) {
				removeAIReqNativeProject(id);
				nativeOwners.delete(id);
			}
		this.#listeners.clear();
		for (const surface of this.#surfaces.values()) surface.unsubscribe();
		this.#surfaces.clear();
		this.#contexts.clear();
		this.#ownedSessions.clear();
		this.#nativeRoots.clear();
		for (const abort of this.#contextAborts.values()) abort.abort();
		this.#contextAborts.clear();
		this.#contextObjects.clear();
	}
	async release(): Promise<void> {
		for (const pending of this.#leases.values()) await (await pending)?.close();
		this.#leases.clear();
	}
}
