import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { AgentPauseGate } from "@oh-my-pi/pi-agent-core";
import { Emitter } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import { AgentRegistry, MAIN_AGENT_ID, type AgentRef } from "../registry/agent-registry";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import { cancelPendingInteractions, installNativeWebGuiInteractions } from "./native-interactions";
import {
	acquireBrowserProject,
	attachBrowserProjectSession,
	detachBrowserProjectSession,
	listBrowserProjects,
	markBrowserProjectExiting,
	readBrowserProject,
	resolveBrowserProjectRoot,
	type BrowserProjectLease,
	type BrowserProjectRecord,
} from "./project-registry";
import type { WebGuiServiceContext } from "./rpc-contract";
import { readWebGuiSessionInfo } from "./session-source";

interface OwnedRoot {
	projectId: string;
	ownerId: string;
	readonly registry: AgentRegistry;
	manager?: SessionManager;
	rootRef?: AgentRef;
	session?: AgentSession;
	settled?: boolean;
	stopPrepared?: boolean;
	sdkReturned?: boolean;
	startupCleanups?: Set<() => Promise<void>>;
}

export interface WebGuiNativePorts {
	createSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
}

let nativePorts: WebGuiNativePorts | undefined;

/** Installed only by the explicit native/browser composition entry, never a module import. */
export function configureWebGuiNativePorts(ports: WebGuiNativePorts): void {
	if (nativePorts && nativePorts !== ports && hasWebGuiNativeResources())
		throw new Error("Cannot replace an active WebGUI native host");
	nativePorts = ports;
}

export function webGuiNativePorts(): WebGuiNativePorts {
	if (!nativePorts) throw new Error("Native WebGUI composition has not been activated");
	return nativePorts;
}

export function hasWebGuiNativeResources(): boolean {
	return roots.size > 0 || leases.size > 0 || pending.size > 0;
}

const leases = new Map<string, BrowserProjectLease>();
const roots = new Set<OwnedRoot>();
const openings = new Map<string, Promise<BrowserProjectRecord>>();
const pending = new Set<Promise<unknown>>();
const resumes = new Map<string, Promise<AgentSession>>();
const privateSessions = new WeakSet<AgentSession>();
const sessionChanges = new Emitter<void>();

export function subscribeWebGuiNativeSessions(listener: () => void): () => void {
	const subscription = sessionChanges.event(listener);
	return () => subscription.dispose();
}

export function assertWebGuiNativeAdmission(): void {
	if (exiting) throw new Error("WebGUI is exiting; new work is not accepted");
}
let exiting = false;
let closing: Promise<void> | undefined;

export function runWebGuiNativeMutation<T>(operation: () => Promise<T>): Promise<T> {
	if (exiting) return Promise.reject(new Error("WebGUI is exiting; new work is not accepted"));
	const promise = operation();
	pending.add(promise);
	void promise.then(
		() => pending.delete(promise),
		() => pending.delete(promise),
	);
	return promise;
}

/** Only explicit terminal entry can reopen admission after a successful shutdown. */
export function enableWebGuiNativeSessions(): void {
	if (closing || hasWebGuiNativeResources()) {
		if (exiting) throw new Error("WebGUI settlement is still pending; retry exit first");
		return;
	}
	exiting = false;
}

function assertProject(context: WebGuiServiceContext): BrowserProjectRecord {
	context.signal.throwIfAborted();
	if (exiting) throw new Error("WebGUI is exiting");
	const project = context.projectId ? readBrowserProject(context.projectId) : null;
	if (!project || project.mode !== "webgui" || project.phase !== "active")
		throw new Error("Select an active WebGUI project first");
	if (context.nativeSession && !project.nativeSessions?.has(context.nativeSession))
		throw new Error("The native WebGUI binding is no longer owned by this project");
	return project;
}

export interface WebGuiProjectBinding {
	projectId: string;
	root: string;
	url: string;
}

function binding(project: BrowserProjectRecord): WebGuiProjectBinding {
	return {
		projectId: project.projectId,
		root: project.root,
		url: `/?project=${encodeURIComponent(project.projectId)}`,
	};
}

/** Opening a project acquires only its mode lease, never an Agent or a model turn. */
export function openWebGuiNativeProject(directory: string, create = false): Promise<WebGuiProjectBinding> {
	return runWebGuiNativeMutation(async () => {
		if (!directory.trim() || !path.isAbsolute(directory)) throw new Error("Expected an absolute local project path");
		if (create) await fs.mkdir(directory, { recursive: true });
		const entered = await fs.realpath(directory);
		if (!(await fs.stat(entered)).isDirectory()) throw new Error("Project path is not a directory");
		const project = await openProject(entered);
		return binding(project);
	});
}

async function openProject(directory: string): Promise<BrowserProjectRecord> {
	if (exiting) throw new Error("WebGUI is exiting");
	const root = await resolveBrowserProjectRoot(directory);
	if (exiting) throw new Error("WebGUI is exiting");
	const key = normalizePathForComparison(root);
	const existing = listBrowserProjects().find(project => normalizePathForComparison(project.root) === key);
	if (existing) {
		if (existing.mode !== "webgui" || existing.phase !== "active")
			throw new Error(`项目已被 AIReq 占用或正在退出，请先结清原模式：${root}`);
		return existing;
	}
	const inFlight = openings.get(key);
	if (inFlight) return inFlight;
	const opening = (async () => {
		const lease = await acquireBrowserProject(root, "webgui");
		leases.set(lease.projectId, lease);
		try {
			if (exiting) throw new Error("WebGUI exited during project admission");
			await lease.activate(
				() => {
					const current = readBrowserProject(lease.projectId)?.nativeSession;
					return current ? readWebGuiSessionInfo(current) : { bound: false };
				},
				{ allowLan: true },
			);
			return readBrowserProject(lease.projectId)!;
		} catch (error) {
			try {
				await lease.close();
				leases.delete(lease.projectId);
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "WebGUI project admission and settlement failed");
			}
			throw error;
		}
	})();
	openings.set(key, opening);
	void opening.then(
		() => openings.delete(key),
		() => openings.delete(key),
	);
	return opening;
}

export async function listWebGuiNativeSessions(context: WebGuiServiceContext): Promise<AgentSession[]> {
	const project = assertProject(context);
	return [...(project.nativeSessions ?? [])].filter(session => !session.isDisposed);
}

/** Resolve resident execution only; reading history or opening a model picker never creates an Agent. */
export async function resolveWebGuiSession(context: WebGuiServiceContext, sessionId?: string): Promise<AgentSession> {
	const project = assertProject(context);
	const session = sessionId
		? [...(project.nativeSessions ?? [])].find(candidate => candidate.sessionId === sessionId)
		: (context.nativeSession ?? project.nativeSession);
	if (!session || session.isDisposed || !project.nativeSessions?.has(session))
		throw new Error(
			sessionId ? `Native session is not resident in this project: ${sessionId}` : "Create a native session first",
		);
	return session;
}

/** Legacy native lookups inherit this root's private registry, never another root's Main. */
export function runWebGuiSession<T>(session: AgentSession, operation: () => T): T {
	// A borrowed terminal keeps its original unscoped lifecycle manager and native defaults.
	return privateSessions.has(session) && session.agentRegistry
		? AgentRegistry.runScoped(session.agentRegistry, operation)
		: operation();
}

function nativeSessionRef(session: AgentSession): AgentRef | undefined {
	const nativeId = session.getAgentId();
	const registry = session.agentRegistry;
	if (!nativeId || !registry) return undefined;
	const ref = registry.get(nativeId);
	if (!ref || ref.session !== session) throw new Error("Native session agent ownership has ended");
	return ref;
}

export function webGuiSessionProject(session: AgentSession): WebGuiProjectBinding {
	const project = listBrowserProjects().find(candidate => candidate.nativeSessions?.has(session));
	if (!project || project.mode !== "webgui" || project.phase !== "active")
		throw new Error("Native session project ownership has ended");
	return binding(project);
}

async function createRoot(
	project: BrowserProjectRecord,
	cwd: string,
	manager?: SessionManager,
	options?: CreateAgentSessionOptions,
): Promise<AgentSession> {
	const owned: OwnedRoot = {
		projectId: project.projectId,
		ownerId: project.ownerId,
		registry: new AgentRegistry(),
		manager,
	};
	const rootAgentId = options?.agentId ?? MAIN_AGENT_ID;
	roots.add(owned);
	const unregisterRoot = owned.registry.onChange(event => {
		if (!owned.rootRef && event.type === "registered" && event.ref.id === rootAgentId) owned.rootRef = event.ref;
	});
	try {
		if (!leases.has(project.projectId)) {
			const lease = await acquireBrowserProject(project.root, "webgui", { reuseWebGuiOwner: true });
			if (leases.has(project.projectId)) await lease.close();
			else leases.set(project.projectId, lease);
		}
		if (exiting) throw new Error("WebGUI exited before native session startup");
		const result = await AgentRegistry.runScoped(owned.registry, () =>
			webGuiNativePorts().createSession({
				...options,
				cwd,
				sessionManager: manager,
				agentRegistry: owned.registry,
				bindProcessState: false,
				initialAgentStatus: "idle",
				interactivePrompts: true,
				pauseGate: new AgentPauseGate(),
				strictStartupCleanup: true,
				beforeStartupCleanup: async (_session, attempt) => {
					const ref = attempt.ref;
					if (ref)
						await AgentRegistry.runScoped(owned.registry, () =>
							AgentLifecycleManager.global().releaseDescendants(ref, undefined, {
								strict: true,
								dispose: { strict: true },
							}),
						);
				},
				onStartupCleanupFailure: failure => {
					(owned.startupCleanups ??= new Set()).add(failure.cleanup);
					if (
						!owned.sdkReturned &&
						failure.session &&
						failure.agentId === rootAgentId &&
						failure.parentAgentId === options?.parentAgentId
					)
						owned.session = failure.session;
				},
			}),
		);
		owned.sdkReturned = true;
		owned.session = result.session;
		owned.rootRef ??= nativeSessionRef(result.session);
		const nativeDispose = result.session.dispose.bind(result.session);
		let strictDisposal: Promise<void> | undefined;
		let strictPrepared = false;
		result.session.dispose = options => {
			if (!strictDisposal) {
				const operation = AgentRegistry.runScoped(owned.registry, async () => {
					if (!strictPrepared) {
						result.session.beginDispose({ strict: true });
						await result.session.abort({ clearQueuedInputs: true, strict: true });
						await result.session.waitForAdmittedSubmissions();
						if (owned.rootRef)
							await AgentLifecycleManager.global().releaseDescendants(owned.rootRef, undefined, {
								strict: true,
								dispose: { ...options, strict: true },
							});
						strictPrepared = true;
					}
					await nativeDispose({ ...options, strict: true });
				});
				strictDisposal = operation;
				void operation.catch(() => {
					if (strictDisposal === operation) strictDisposal = undefined;
				});
			}
			return strictDisposal;
		};
		privateSessions.add(result.session);
		owned.manager = result.session.sessionManager;
		installNativeWebGuiInteractions(result.session, { setToolUIContext: result.setToolUIContext });
		if (exiting) throw new Error("WebGUI exited during native session startup");
		attachBrowserProjectSession(project.projectId, project.ownerId, result.session);
		sessionChanges.fire();
		return result.session;
	} catch (error) {
		try {
			await settleOwnedRoot(owned);
			roots.delete(owned);
		} catch (cleanup) {
			throw new AggregateError(
				[error, cleanup],
				"Native session startup and settlement failed; project remains locked",
			);
		}
		throw error;
	} finally {
		unregisterRoot();
	}
}

export function createWebGuiNativeSession(
	context: WebGuiServiceContext,
	workspacePath?: string,
	options?: CreateAgentSessionOptions,
): Promise<AgentSession> {
	return runWebGuiNativeMutation(async () => {
		const project = assertProject(context);
		const cwd = workspacePath ? await fs.realpath(workspacePath) : project.root;
		if (normalizePathForComparison(await resolveBrowserProjectRoot(cwd)) !== normalizePathForComparison(project.root))
			throw new Error("Session workspace does not belong to the selected project");
		assertProject(context);
		return createRoot(project, cwd, undefined, options);
	});
}

/** Explicit continuation restores its own runtime at the journal's real cwd, not the caller's cwd. */
export function resumeWebGuiNativeSession(
	context: WebGuiServiceContext,
	sessionId: string,
	options?: CreateAgentSessionOptions,
): Promise<AgentSession> {
	context.signal.throwIfAborted();
	if (!sessionId) return Promise.reject(new Error("Expected a native history session ID"));
	if (exiting) return Promise.reject(new Error("WebGUI is exiting"));
	const resident = listBrowserProjects()
		.flatMap(project => [...(project.nativeSessions ?? [])])
		.find(session => session.sessionId === sessionId && !session.isDisposed);
	if (resident) {
		webGuiSessionProject(resident);
		return Promise.resolve(resident);
	}
	const inFlight = resumes.get(sessionId);
	if (inFlight) return inFlight;
	const operation = runWebGuiNativeMutation(async () => {
		const info = (await SessionManager.listAll()).find(item => item.id === sessionId);
		if (!info?.cwd || !info.path) throw new Error(`Native history not found: ${sessionId}`);
		const cwd = await fs.realpath(info.cwd);
		if (!(await fs.stat(cwd)).isDirectory()) throw new Error("Native history workspace is unavailable");
		const project = await openProject(cwd);
		context.signal.throwIfAborted();
		const current = [...(readBrowserProject(project.projectId)?.nativeSessions ?? [])].find(
			session => session.sessionId === sessionId && !session.isDisposed,
		);
		if (current) return current;
		const manager = await SessionManager.open(info.path, undefined, undefined, {
			throwIfMissing: true,
			runtimeOwnership: true,
		});
		try {
			if (
				manager.getSessionId() !== sessionId ||
				normalizePathForComparison(await fs.realpath(manager.getCwd())) !== normalizePathForComparison(cwd)
			)
				throw new Error("Native history identity or workspace changed during continuation");
			if (
				normalizePathForComparison(await resolveBrowserProjectRoot(manager.getCwd())) !==
				normalizePathForComparison(project.root)
			)
				throw new Error("Native history moved outside its admitted project");
		} catch (error) {
			await manager.close();
			throw error;
		}
		return createRoot(project, manager.getCwd(), manager, options);
	});
	resumes.set(sessionId, operation);
	void operation.then(
		() => resumes.delete(sessionId),
		() => resumes.delete(sessionId),
	);
	return operation;
}

async function settleStartupCleanups(owned: OwnedRoot): Promise<void> {
	if (!owned.startupCleanups) return;
	const failures: unknown[] = [];
	for (const cleanup of owned.startupCleanups) {
		try {
			await cleanup();
			owned.startupCleanups.delete(cleanup);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "Native startup resources remain unsettled");
}

async function settleOwnedRoot(owned: OwnedRoot): Promise<void> {
	if (owned.settled) return;
	await AgentRegistry.runScoped(owned.registry, async () => {
		if (!owned.sdkReturned && owned.startupCleanups?.size) {
			await settleStartupCleanups(owned);
			if (!owned.session || owned.session.sessionManager !== owned.manager) await owned.manager?.close();
			owned.settled = true;
			return;
		}
		const session = owned.session;
		if (session) {
			if (!owned.stopPrepared) {
				cancelPendingInteractions(session, "WebGUI is exiting");
				await session.abort({ clearQueuedInputs: true, strict: true });
				await session.waitForAdmittedSubmissions();
				session.beginDispose({ strict: true });
				owned.stopPrepared = true;
			}
			await settleStartupCleanups(owned);
			await session.dispose({ strict: true });
		} else {
			// SDK startup can fail after native children/resources registered but before returning a root.
			for (const ref of owned.registry.list().reverse()) {
				if (ref.session) {
					await ref.session.abort({ clearQueuedInputs: true, strict: true });
					await ref.session.dispose({ strict: true });
				}
				owned.registry.unregister(ref.id, ref);
			}
			await owned.manager?.close();
		}
		const remaining = owned.registry.list().filter(ref => ref.session && ref.session !== session);
		if (remaining.length)
			throw new Error(`Native descendants remain unsettled: ${remaining.map(ref => ref.id).join(", ")}`);
	});
	if (owned.session) detachBrowserProjectSession(owned.projectId, owned.ownerId, owned.session);
	owned.settled = true;
}

/** Reject all new work immediately, then settle every root before any project lease is released. */
export function closeWebGuiNativeSessions(): Promise<void> {
	return settleWebGuiNativeSessions();
}

function settleWebGuiNativeSessions(): Promise<void> {
	if (closing) return closing;
	exiting = true;
	const operation = (async () => {
		const live = [
			...new Set(
				listBrowserProjects()
					.filter(project => project.mode === "webgui")
					.flatMap(project => [...(project.nativeSessions ?? [])]),
			),
		];
		for (const project of listBrowserProjects()) {
			if (project.mode === "webgui") markBrowserProjectExiting(project.projectId, project.ownerId);
		}
		for (const lease of leases.values()) await lease.markExiting();
		const aborts = Promise.allSettled(
			live
				.filter(session => !session.isDisposed)
				.map(session =>
					runWebGuiSession(session, async () => {
						cancelPendingInteractions(session, "WebGUI is exiting");
						await session.abort({ clearQueuedInputs: true, strict: true });
						await session.waitForAdmittedSubmissions();
					}),
				),
		);
		await Promise.allSettled([...pending]);
		await Promise.allSettled(listBrowserProjects().flatMap(project => [...(project.pendingModelSelections ?? [])]));
		const abortResults = await aborts;
		const ownedSessions = new Set([...roots].map(root => root.session));
		const borrowed = listBrowserProjects()
			.filter(project => project.mode === "webgui")
			.flatMap(project => [...(project.nativeSessions ?? [])])
			.filter(session => !ownedSessions.has(session));
		const results = await Promise.allSettled([
			...[...roots].map(root => settleOwnedRoot(root)),
			...borrowed.map(session =>
				runWebGuiSession(session, async () => {
					const root = nativeSessionRef(session);
					cancelPendingInteractions(session, "WebGUI is exiting");
					await session.abort({ clearQueuedInputs: true, strict: true });
					await session.waitForAdmittedSubmissions();
					if (root)
						await AgentLifecycleManager.global().releaseDescendants(root, undefined, {
							strict: true,
							dispose: { strict: true },
						});
				}),
			),
		]);
		const failures = [...abortResults, ...results]
			.filter(result => result.status === "rejected")
			.map(result => result.reason);
		if (failures.length)
			throw new AggregateError(failures, "WebGUI native work remains unsettled; project leases retained");
	})();
	closing = operation;
	void operation.then(
		() => {
			closing = undefined;
		},
		() => {
			closing = undefined;
		},
	);
	return operation;
}

/** Called only after session, attachment and other native mutation settlement has succeeded. */
export async function releaseWebGuiNativeProjects(): Promise<void> {
	for (const lease of leases.values()) {
		const project = readBrowserProject(lease.projectId);
		await Promise.allSettled([...(project?.pendingModelSelections ?? [])]);
	}
	for (const [id, lease] of leases) {
		await lease.close();
		leases.delete(id);
	}
	roots.clear();
}
