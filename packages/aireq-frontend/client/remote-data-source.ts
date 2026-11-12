import type { ChannelClient } from "@zcode/rpc";
import { createUuid } from "@zcode/shared";
import { connectViaWebSocket } from "@zcode/client";
import {
	AIREQ_CONTRACT_VERSION,
	type AIReqRemoteBootstrap,
	type AIReqRemoteWorkflow,
	type AIReqRemoteResponse,
	type AIReqRemoteEvent,
	type AIReqRemotePath,
	type AIReqRemoteArgs,
	type AIReqRemoteResult,
} from "../backend/contract.js";
import type { AIReqDataSource } from "../packages/ui/src/aireq/data-source.js";
import type { AIReqSelection, AIReqWorkflowView } from "../packages/ui/src/aireq/types.js";
import { getEmployeeId } from "../packages/ui/src/aireq/identity.js";

export interface RemoteAIReqDataSourceOptions {
	baseUrl: string;
	demo?: string;
}

/** Browser transport only: business state and service execution belong to the backend. */
export async function createRemoteAIReqDataSource(options: RemoteAIReqDataSourceOptions): Promise<AIReqDataSource> {
	const base = new URL(options.baseUrl);
	if (!base.pathname.endsWith("/")) base.pathname += "/";
	if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("AIReq backend requires an HTTP URL");
	const clientId = createUuid();
	const lifetime = new AbortController();
	const connections = new Set<AbortController>();
	const workflowListeners = new Set<() => void>();
	const modelListeners = new Set<() => void>();
	const issueListeners = new Set<() => void>();
	const schedulerListeners = new Set<() => void>();
	const freeChatListeners = new Set<() => void>();
	const skillListeners = new Set<(sessionId: string) => void>();
	const snapshots = new WeakMap<AIReqWorkflowView, { key: string; reviewScopeKey: string; value: AIReqRemoteWorkflow }>();
	// 头像只切换同一已读取评审中的会话；不把异步刷新间隙当成工作区丢失。
	const resolveSnapshot = (view: AIReqWorkflowView | undefined, target: AIReqSelection): AIReqRemoteWorkflow | undefined => {
		const snapshot = view ? snapshots.get(view) : undefined;
		if (!snapshot || !view) return undefined;
		if (snapshot.key === JSON.stringify(target)) return snapshot.value;
		if (snapshot.value.session?.role !== "reviewer" || snapshot.reviewScopeKey !== JSON.stringify({ ...target, reviewAgent: undefined })) return undefined;
		const group = view.drafts.find(item => item.id === target.irId && item.projectId === target.projectId);
		const review = [group?.review, ...(group?.reviewHistory ?? [])].find(item => item?.agents?.some(agent => agent.session.sessionId === snapshot.value.session?.sessionId));
		const session = review?.agents?.find(agent => agent.id === (target.reviewAgent ?? "summary"))?.session;
		return session ? { ...snapshot.value, session } : undefined;
	};
	let selection: AIReqSelection = {};
	let disposed = false;
	let eventError: Error | undefined;
	let eventSocket: WebSocket | undefined;
	let bootstrapRevision = 0;
	const emit = (listeners: Set<() => void>) => {
		for (const listener of listeners) listener();
	};
	const subscribe = (listeners: Set<() => void>, listener: () => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	const url = (path: string, websocket = false) => {
		const target = new URL(path, base);
		target.searchParams.set("clientId", clientId);
		target.searchParams.set("employeeId", getEmployeeId());
		if (options.demo) target.searchParams.set("demo", options.demo);
		if (websocket) target.protocol = base.protocol === "https:" ? "wss:" : "ws:";
		return target;
	};
	const request = async <T>(path: string, body?: unknown): Promise<T> => {
		if (disposed) throw new Error("AIReq backend connection is disposed");
		const response = await fetch(url(path), {
			method: body === undefined ? "GET" : "POST",
			cache: "no-store",
			signal: lifetime.signal,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const envelope = (await response.json()) as AIReqRemoteResponse<T>;
		if (!envelope.ok) throw new Error(envelope.error.message);
		if (!response.ok) throw new Error(`AIReq backend HTTP ${response.status}`);
		return envelope.value;
	};
	const call = <P extends AIReqRemotePath>(
		path: P,
		args: AIReqRemoteArgs<P>,
		target = selection,
	): Promise<AIReqRemoteResult<P>> => request<AIReqRemoteResult<P>>("api/aireq/call", { path, args, selection: target });
	const readBootstrap = async (): Promise<AIReqRemoteBootstrap> => {
		const incoming = await request<AIReqRemoteBootstrap>("api/aireq/bootstrap");
		if (incoming.contractVersion !== AIREQ_CONTRACT_VERSION)
			throw new Error(`Unsupported AIReq backend contract version: ${incoming.contractVersion}`);
		if (!incoming.serviceManifest || typeof incoming.serviceManifest !== "object" || Array.isArray(incoming.serviceManifest) ||
			Object.values(incoming.serviceManifest).some(members => !Array.isArray(members) || members.some(name => typeof name !== "string" || !name)))
			throw new Error("AIReq backend returned an invalid service capability manifest");
		return incoming;
	};
	let metadata = await readBootstrap();
	selection = { ...metadata.initialSelection };
	let promptDraft = { ...metadata.prompts.draft };
	const refreshMetadata = async () => {
		const revision = ++bootstrapRevision;
		const incoming = await readBootstrap();
		if (revision !== bootstrapRevision) return;
		if (JSON.stringify(promptDraft) === JSON.stringify(metadata.prompts.saved))
			promptDraft = { ...incoming.prompts.draft };
		metadata = incoming;
	};
	const openEvents = async () => {
		const previous = eventSocket;
		eventSocket = undefined;
		previous?.close();
		eventError = undefined;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const socket = new WebSocket(url("api/aireq/events", true));
		eventSocket = socket;
		let opened = false;
		const fail = (error: Error) => {
			if (eventSocket !== socket || disposed) return;
			eventError = error;
			if (!opened) reject(error);
			emit(workflowListeners);
		};
		socket.addEventListener(
			"open",
			() => {
				opened = true;
				resolve();
			},
			{ once: true },
		);
		socket.addEventListener("error", () => fail(new Error("AIReq backend event connection failed")));
		socket.addEventListener("close", event => fail(new Error(`AIReq backend event connection closed (${event.code})`)));
		socket.addEventListener("message", event => {
			if (eventSocket !== socket || disposed) return;
			try {
				const frame = JSON.parse(String(event.data)) as AIReqRemoteEvent;
				if (frame.type === "error") {
					fail(new Error(frame.error?.message ?? "AIReq backend event error"));
					return;
				}
				if (frame.type === "issues") emit(issueListeners);
				if (frame.type === "scheduler") emit(schedulerListeners);
				if (frame.type === "freeChats") emit(freeChatListeners);
				if (frame.type === "skills") for (const listener of skillListeners) listener(frame.sessionId ?? "");
				if (frame.type === "models" || frame.type === "workflow") {
					void refreshMetadata().then(
						() => {
							emit(modelListeners);
							emit(workflowListeners);
						},
						cause => fail(cause instanceof Error ? cause : new Error(String(cause))),
					);
				}
			} catch (cause) {
				fail(cause instanceof Error ? cause : new Error(String(cause)));
			}
		});
		await promise;
	};
	const scenarios: NonNullable<AIReqDataSource["prototype"]> = {
		setProposalMergeScenario: async (...args) => {
			await call("prototype.setProposalMergeScenario", args);
		},
		directoryIssue: async (...args) => (await call("prototype.directoryIssue", args)) ?? undefined,
		restoreDirectory: async (...args) => {
			await call("prototype.restoreDirectory", args);
		},
		readPrHandoff: (...args) => call("prototype.readPrHandoff", args),
	};
	const source: AIReqDataSource = {
		clientId,
		get provenance() {
			return metadata.provenance;
		},
		get backend() {
			return metadata.backend;
		},
		get capabilities() {
			return metadata.capabilities;
		},
		get serviceManifest() { return metadata.serviceManifest; },
		get initialSelection() {
			return metadata.initialSelection;
		},
		get employeeDirectory() {
			return metadata.employeeDirectory;
		},
		async refreshIdentity() {
			await refreshMetadata();
			await openEvents();
			emit(modelListeners);
			emit(workflowListeners);
		},
		async readWorkflow(target) {
			if (eventError) throw eventError;
			selection = { ...target };
			const result = await call("readWorkflow", [target], target);
			snapshots.set(result.view, { key: JSON.stringify(target), reviewScopeKey: JSON.stringify({ ...target, reviewAgent: undefined }), value: result });
			return result.view;
		},
		subscribeWorkflow: listener => subscribe(workflowListeners, listener),
		command: async (action, target, revision) => {
			const result = await call("command", [action, target, revision], target);
			await refreshMetadata();
			if (action.type === "createProposal" && result.projectId && result.irId) {
				const createdSelection = { projectId: result.projectId, irId: result.irId };
				result.view = await source.readWorkflow(createdSelection);
			}
			return result;
		},
		resolveSession: (view, target) => resolveSnapshot(view, target)?.session,
		resolveWorkspace: (view, target) => resolveSnapshot(view, target)?.workspace
			?? { identity: `aireq-remote:${clientId}`, kind: "unavailable" },
		retryMaterial: (path, target) => call("retryMaterial", [path, target], target),
		retrySession: async target => {
			await call("retrySession", [target], target);
			if (eventError) await openEvents();
		},
		createFreeChat: projectId => call("createFreeChat", [projectId]),
		readFreeChat: async taskId => (await call("readFreeChat", [taskId])) ?? undefined,
		readRecentFreeChats: projectId => call("readRecentFreeChats", [projectId]),
		readPrHandoff: group => call("readPrHandoff", [group]),
		selectProject(projectId) {
			selection = { ...selection, projectId };
		},
		async connectWorkspace(workspace, target, session) {
			const connection = new AbortController();
			connections.add(connection);
			const targetUrl = url("api/aireq/services", true);
			targetUrl.searchParams.set("workspace", JSON.stringify(workspace));
			targetUrl.searchParams.set("selection", JSON.stringify(target));
			if (session) targetUrl.searchParams.set("session", JSON.stringify(session));
			try {
				let channelClient: ChannelClient | undefined;
				const services = await connectViaWebSocket(targetUrl.toString(), {
					signal: connection.signal, browserDirect: true, serviceManifest: metadata.serviceManifest,
					onChannelClient: client => { channelClient = client; },
				});
				return {
					services,
					async dispose() {
						// Let the old React subtree release subscriptions/watchers before closing its wire.
						await Promise.resolve();
						await channelClient?.whenIdle();
						connection.abort();
						connections.delete(connection);
					},
				};
			} catch (cause) {
				connection.abort();
				connections.delete(connection);
				throw cause;
			}
		},
		dispose() {
			disposed = true;
			lifetime.abort();
			eventSocket?.close();
			for (const connection of connections) connection.abort();
			connections.clear();
		},
		progress: {
			assignOwner: async (...args) => {
				await call("progress.assignOwner", args);
			},
			updateSr: async (...args) => {
				await call("progress.updateSr", args);
			},
		},
		planning: {
			updateSr: async (...args) => {
				await call("planning.updateSr", args);
			},
		},
		projects: {
			saveRepository: async input => {
				await call("projects.saveRepository", [input]);
				await refreshMetadata();
			},
			readDevelopmentRoot: projectId => metadata.projects.developmentRoots[projectId],
			listDirectories: () => metadata.projects.directories,
			checkProjectDirectory: (...args) => call("projects.checkProjectDirectory", args),
			checkDevelopmentDirectory: (...args) => call("projects.checkDevelopmentDirectory", args),
			checkSharedProjectDirectory: (...args) => call("projects.checkSharedProjectDirectory", args),
		},
		models: {
			get choices() {
				return metadata.models.choices;
			},
			read: () => metadata.models.settings,
			save: async settings => {
				await call("models.save", [settings]);
				await refreshMetadata();
				emit(modelListeners);
			},
			revision: () => metadata.models.revision,
			subscribe: listener => subscribe(modelListeners, listener),
			bindingChanged: binding => binding.configurationRevision !== metadata.models.revision,
			get samples() {
				const samples = metadata.models.samples;
				return samples ? () => structuredClone(samples) : undefined;
			},
		},
		prompts: {
			read: () => ({ saved: metadata.prompts.saved, draft: promptDraft }),
			updateDraft(value) {
				promptDraft = { ...value };
			},
			save: async value => {
				await call("prompts.save", [value]);
				await refreshMetadata();
				promptDraft = { ...metadata.prompts.saved };
			},
		},
		skillDesign: {
			session: (...args) => call("skillDesign.session", args),
			binding: (...args) => call("skillDesign.binding", args),
			workspaceIdentity: (...args) => call("skillDesign.workspaceIdentity", args),
			read: (...args) => call("skillDesign.read", args),
			saveDraft: async (...args) => {
				await call("skillDesign.saveDraft", args);
			},
			prompt: (...args) => call("skillDesign.prompt", args),
			temporaryDirectory: (...args) => call("skillDesign.temporaryDirectory", args),
			readPreview: async (...args) => (await call("skillDesign.readPreview", args)) ?? undefined,
			listSkills: (...args) => call("skillDesign.listSkills", args),
			savePreview: (...args) => call("skillDesign.savePreview", args),
			subscribe(listener) {
				skillListeners.add(listener);
				return {
					dispose() {
						skillListeners.delete(listener);
					},
				};
			},
			get sample() {
				return metadata.skillDesignSample;
			},
		},
		skills: { list: (...args) => call("skills.list", args) },
		collaboration: { peers: projectId => metadata.peers.filter(peer => !projectId || peer.projectId === projectId) },
		freeChats: { subscribe: listener => subscribe(freeChatListeners, listener) },
		get prototype(): AIReqDataSource["prototype"] {
			return metadata.scenarioOperations ? scenarios : undefined;
		},
    issues: {
      read: (...args) => call("issues.read", args),
      create: (...args) => call("issues.create", args),
      configure: async (...args) => { await call("issues.configure", args); },
      runNow: async (...args) => { await call("issues.runNow", args); },
      confirm: async (...args) => { await call("issues.confirm", args); },
      reopen: async (...args) => { await call("issues.reopen", args); },
      subscribe: listener => subscribe(issueListeners, listener),
      dispose: () => { issueListeners.clear(); },
    },
		progressScheduler: {
			read: () => call("progressScheduler.read", []),
			queryTasks: (...args) => call("progressScheduler.queryTasks", args),
			queryRuns: (...args) => call("progressScheduler.queryRuns", args),
			readRun: async (...args) => (await call("progressScheduler.readRun", args)) ?? undefined,
			subscribe: listener => subscribe(schedulerListeners, listener),
			setProjectEnabled: async (...args) => {
				await call("progressScheduler.setProjectEnabled", args);
			},
			configure: async (...args) => {
				await call("progressScheduler.configure", args);
			},
			runNow: async (...args) => {
				await call("progressScheduler.runNow", args);
			},
			advance: async () => {
				await call("progressScheduler.advance", []);
			},
			dispose() {
				schedulerListeners.clear();
			},
		},
	};
	try {
		await openEvents();
	} catch (cause) {
		source.dispose();
		throw cause;
	}
	return source;
}
