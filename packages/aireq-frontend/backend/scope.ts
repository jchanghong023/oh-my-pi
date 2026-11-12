import { AsyncLocalStorage } from "node:async_hooks";
import { parentPort } from "node:worker_threads";
import { createPrototypeDataSource } from "./prototype-data-source.js";
import { setEmployeeIdProvider, isEmployeeId } from "../packages/ui/src/aireq/identity.js";
import { prototypeSettingsWriteAllowed } from "../packages/ui/src/aireq/mock/backend.js";
import { setPrototypeProjectContext } from "../packages/ui/src/aireq/mock/free-chats.js";
import {
	ChannelServer,
	SocketProtocol,
	ProxyChannel,
	Emitter,
	VSBuffer,
	DisposableStore,
	type ISocket,
} from "@zcode/rpc";
import * as descriptors from "@zcode/services";
import type { AIReqSelection, AIReqNativeSessionRef } from "../packages/ui/src/aireq/types.js";
import {
	AIREQ_CONTRACT_VERSION,
	type AIReqRemoteBootstrap,
	type AIReqRemoteEvent,
	type AIReqRemoteErrorCode,
} from "./contract.js";
import { validateAIReqRemoteCall } from "./call-validation.js";
import type { ScopeRequest, ScopeResponse } from "./transport.js";

const identities = new AsyncLocalStorage<string>();
setEmployeeIdProvider(() => identities.getStore() ?? "");
const projects = new AsyncLocalStorage<{ projectId?: string }>();
setPrototypeProjectContext({
	read: () => projects.getStore()?.projectId,
	write: projectId => {
		const context = projects.getStore();
		if (context) context.projectId = projectId;
	},
});

export function startScope(): void {
	if (!parentPort) throw new Error("Backend scope requires its owned worker");
	const port = parentPort;
	const source = createPrototypeDataSource();
	const sockets = new Map<
		string,
		{ employeeId: string; project: { projectId?: string }; kind: string; input: Emitter<VSBuffer>; close(): void }
	>();
	const emit = (event: AIReqRemoteEvent) => {
		for (const [id, socket] of sockets)
			if (socket.kind === "events") port.postMessage({ kind: "send", id, data: JSON.stringify(event) });
	};
	const disposers: (() => void)[] = [source.subscribeWorkflow(() => emit({ type: "workflow" }))];
	if (source.models) disposers.push(source.models.subscribe(() => emit({ type: "models" })));
	if (source.progressScheduler) disposers.push(source.progressScheduler.subscribe(() => emit({ type: "scheduler" })));
	if (source.freeChats) disposers.push(source.freeChats.subscribe(() => emit({ type: "freeChats" })));
	if (source.skillDesign) {
		const sub = source.skillDesign.subscribe(sessionId => emit({ type: "skills", sessionId }));
		disposers.push(() => sub.dispose());
	}
	const methods = new Map<string, { owner: object; method: (...args: unknown[]) => unknown }>();
	const add = (owner: object | undefined, names: string[], prefix = "") => {
		if (!owner) return;
		const entries = owner as Record<string, unknown>;
		for (const name of names)
			if (typeof entries[name] === "function")
				methods.set(prefix + name, { owner, method: entries[name] as (...args: unknown[]) => unknown });
	};
	add(source, [
		"command",
		"readPrHandoff",
		"retryMaterial",
		"retrySession",
		"createFreeChat",
		"readFreeChat",
		"readRecentFreeChats",
		"selectProject",
	]);
	add(source.progress, ["assignOwner", "updateSr"], "progress.");
	add(source.planning, ["updateSr"], "planning.");
	add(
		source.projects,
		[
			"saveRepository",
			"readDevelopmentRoot",
			"listDirectories",
			"checkProjectDirectory",
			"checkDevelopmentDirectory",
			"checkSharedProjectDirectory",
		],
		"projects.",
	);
	add(source.models, ["read", "save", "samples", "revision", "bindingChanged"], "models.");
	add(source.prompts, ["read", "updateDraft", "save"], "prompts.");
	add(source.skills, ["list"], "skills.");
	add(
		source.skillDesign,
		[
			"session",
			"binding",
			"workspaceIdentity",
			"read",
			"saveDraft",
			"prompt",
			"temporaryDirectory",
			"readPreview",
			"listSkills",
			"savePreview",
		],
		"skillDesign.",
	);
	add(source.collaboration, ["peers"], "collaboration.");
	add(
		source.prototype,
		["setProposalMergeScenario", "directoryIssue", "restoreDirectory", "readPrHandoff"],
		"prototype.",
	);
	add(
		source.progressScheduler,
		["read", "queryTasks", "queryRuns", "readRun", "setProjectEnabled", "configure", "runNow", "advance"],
		"progressScheduler.",
	);
	const settingsWrites = new Set([
		"projects.saveRepository",
		"models.save",
		"prompts.save",
		"prompts.updateDraft",
		"progressScheduler.configure",
		"progressScheduler.setProjectEnabled",
		"progressScheduler.runNow",
		"progressScheduler.advance",
	]);
	const mutationPaths = new Set([
		"command",
		"retryMaterial",
		"retrySession",
		"createFreeChat",
		"progress.assignOwner",
		"progress.updateSr",
		"planning.updateSr",
		"projects.saveRepository",
		"models.save",
		"prompts.save",
		"prompts.updateDraft",
		"skillDesign.saveDraft",
		"skillDesign.savePreview",
		"skillDesign.prompt",
		"prototype.setProposalMergeScenario",
		"prototype.restoreDirectory",
		"progressScheduler.setProjectEnabled",
		"progressScheduler.configure",
		"progressScheduler.runNow",
		"progressScheduler.advance",
	]);
	const bootstrap = async (): Promise<AIReqRemoteBootstrap> => {
		if (!source.backend || !source.models || !source.prompts || !source.projects)
			throw new Error("Incomplete prototype composition");
		const view = await source.readWorkflow(source.initialSelection);
		const developmentRoots: Record<string, string> = {};
		for (const project of view.projects) {
			const root = await source.projects.readDevelopmentRoot(project.id);
			if (root) developmentRoots[project.id] = root;
		}
		return {
			contractVersion: AIREQ_CONTRACT_VERSION,
			provenance: source.provenance,
			scenarioOperations: Boolean(source.prototype),
			backend: source.backend,
			capabilities: identities.getStore()
				? { ...source.capabilities }
				: {
						...source.capabilities,
						settingsWrite: false,
						proposalDiscussion: false,
						codeDevelopment: false,
						workflowCommands: [],
					},
			initialSelection: source.initialSelection,
			employeeDirectory: source.employeeDirectory,
			models: {
				choices: source.models.choices,
				settings: await source.models.read(),
				samples: await source.models.samples?.(),
				revision: await source.models.revision(),
			},
			prompts: await source.prompts.read(),
			projects: { directories: await source.projects.listDirectories(), developmentRoots },
			peers: (await source.collaboration?.peers()) ?? [],
			skillDesignSample: source.skillDesign?.sample,
		};
	};
	const identity = (url: URL) => {
		const value = url.searchParams.get("employeeId") ?? "";
		if (value && !isEmployeeId(value))
			throw Object.assign(new Error("Invalid employee identity"), { code: "INVALID_IDENTITY", status: 400 });
		if (!url.searchParams.get("clientId"))
			throw Object.assign(new Error("Missing clientId"), { code: "INVALID_CLIENT", status: 400 });
		return value;
	};
	const parse = (text: string): unknown => {
		try {
			return JSON.parse(text);
		} catch {
			throw Object.assign(new Error("Malformed JSON"), { code: "INVALID_JSON", status: 400 });
		}
	};
	const selectionFrom = (value: unknown): AIReqSelection => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw Object.assign(new Error("Invalid selection"), { code: "INVALID_ARGUMENT", status: 400 });
		return value as AIReqSelection;
	};
	const dispatch = async (url: URL, body?: string): Promise<unknown> => {
		if (url.pathname.endsWith("/bootstrap")) return bootstrap();
		const input = validateAIReqRemoteCall(parse(body ?? ""));
		if (input.path === "readWorkflow") {
			const selection = selectionFrom(input.args[0]);
			const view = await source.readWorkflow(selection);
			return {
				view,
				session: source.resolveSession(view, selection),
				workspace: source.resolveWorkspace(view, selection),
			};
		}
		const entry = methods.get(input.path);
		if (!entry) throw Object.assign(new Error("Unknown AIReq API path"), { code: "UNKNOWN_PATH", status: 404 });
		if (mutationPaths.has(input.path) && !identities.getStore())
			throw Object.assign(new Error("请先登录工号再修改原型状态。"), { code: "FORBIDDEN", status: 403 });
		if (settingsWrites.has(input.path) && !prototypeSettingsWriteAllowed())
			throw Object.assign(new Error("当前账号只读；仅启动此 Web 的人可修改设置。"), {
				code: "FORBIDDEN",
				status: 403,
			});
		if (input.path === "command") {
			const action = input.args[0] as { type?: unknown } | null;
			if (!action || typeof action.type !== "string")
				throw Object.assign(new Error("Invalid workflow action"), { code: "INVALID_ACTION", status: 400 });
			if (!source.capabilities.workflowCommands.includes(action.type as never))
				throw Object.assign(new Error("Forbidden workflow action"), { code: "FORBIDDEN", status: 403 });
			selectionFrom(input.args[1]);
		}
		return await Reflect.apply(entry.method, entry.owner, input.args);
	};
	const open = async (request: ScopeRequest, url: URL, employeeId: string) => {
		const id = request.id;
		const input = new Emitter<VSBuffer>();
		const onClose = new Emitter<void>();
		const onEnd = new Emitter<void>();
		const store = new DisposableStore();
		const kind = url.pathname.endsWith("/events") ? "events" : "services";
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			onClose.fire();
			onEnd.fire();
			store.dispose();
			input.dispose();
			onClose.dispose();
			onEnd.dispose();
			sockets.delete(id);
		};
		sockets.set(id, { employeeId, project: projects.getStore() ?? {}, kind, input, close });
		if (kind === "events") return;
		const selection = selectionFrom(
			parse(url.searchParams.get("selection") ?? JSON.stringify(source.initialSelection)),
		);
		const view = await source.readWorkflow(selection);
		const workspace = source.resolveWorkspace(view, selection);
		const session = source.resolveSession(view, selection);
		const requestedSession = url.searchParams.get("session");
		if (requestedSession) {
			const requested = parse(requestedSession) as AIReqNativeSessionRef;
			if (
				requested?.sessionId &&
				requested.sessionId !== session?.sessionId &&
				!requested.sessionId.startsWith("prototype-skill-design:") &&
				!requested.sessionId.startsWith("prototype-automation-session:")
			)
				throw Object.assign(new Error("Session unavailable for selection"), { code: "FORBIDDEN", status: 403 });
		}
		const connection = await source.connectWorkspace(workspace, selection, session);
		store.add({
			dispose: () => {
				void connection.dispose();
			},
		});
		const socket: ISocket = {
			onData: input.event,
			onClose: onClose.event,
			onEnd: onEnd.event,
			write: buffer => port.postMessage({ kind: "send", id, data: buffer.buffer }),
			end: () => port.postMessage({ kind: "close", id }),
			drain: () => Promise.resolve(),
			dispose: close,
		};
		const protocol = new SocketProtocol(socket);
		store.add(protocol);
		const server = new ChannelServer(protocol, employeeId, 1000, true);
		store.add(server);
		const descriptorEntries = Object.values(descriptors) as unknown[];
		for (const [key, service] of Object.entries(connection.services)) {
			if (!service || typeof service !== "object") continue;
			const descriptorName = key.startsWith("zcode")
				? "IZCode" + key.slice(5)
				: "I" + key[0]!.toUpperCase() + key.slice(1);
			const descriptor = (descriptors as Record<string, unknown>)[descriptorName] as
				| { channelName?: string }
				| undefined;
			if (!descriptor?.channelName || !descriptorEntries.includes(descriptor))
				throw new Error(`Missing service descriptor: ${key}`);
			const channel = ProxyChannel.fromService(service, store);
			const owned = new Set(Object.keys(service));
			server.registerChannel(descriptor.channelName, {
				call: <T>(ctx: string, command: string, args?: unknown[]): Promise<T> =>
					identities.run(employeeId, () => {
						if (!owned.has(command) || /^on[A-Z]/.test(command)) throw new Error("Unknown service method");
						const settingsService = [
							"providerSettingsService",
							"credentialService",
							"hooksService",
							"memoryService",
							"outputStyleService",
						].includes(key);
						const readMethod = /^(?:get|load|read|list|resolve|test|refresh)/.test(command);
						if (
							((settingsService && !readMethod) ||
								(key === "settingService" &&
									command !== "get" &&
									command !== "update" &&
									command !== "getUserInstructions")) &&
							!prototypeSettingsWriteAllowed()
						)
							throw Object.assign(new Error("当前账号只读；仅启动此 Web 的人可修改设置。"), {
								code: "FORBIDDEN",
							});
						return channel.call<T>(ctx, command, args);
					}),
				listen: <T>(ctx: string, event: string, args?: unknown) =>
					identities.run(employeeId, () => {
						if (!owned.has(event) || !/^on[A-Z]/.test(event)) throw new Error("Unknown service event");
						const sourceEvent = channel.listen<T>(ctx, event, args);
						return (listener: (value: T) => void) =>
							sourceEvent(value => identities.run(employeeId, () => listener(value)));
					}),
			});
		}
		server.ready();
	};
	port.on("message", async (request: ScopeRequest) => {
		if (request.kind === "shutdown") {
			for (const socket of sockets.values()) socket.close();
			for (const dispose of disposers) dispose();
			await source.dispose();
			port.postMessage({
				kind: "response",
				id: request.id,
				status: 200,
				response: { ok: true, value: null },
			} satisfies ScopeResponse);
			port.close();
			return;
		}
		if (request.kind === "message") {
			const socket = sockets.get(request.id);
			if (socket && typeof request.data !== "string" && request.data)
				projects.run(socket.project, () =>
					identities.run(socket.employeeId, () =>
						socket.input.fire(VSBuffer.wrap(new Uint8Array(request.data! as Uint8Array))),
					),
				);
			return;
		}
		if (request.kind === "close") {
			sockets.get(request.id)?.close();
			return;
		}
		try {
			const url = new URL(request.url!);
			const employeeId = identity(url);
			const querySelection = url.searchParams.get("selection");
			const context = { projectId: querySelection ? selectionFrom(parse(querySelection)).projectId : undefined };
			const value = await projects.run(context, () =>
				identities.run(employeeId, () =>
					request.kind === "open" ? open(request, url, employeeId) : dispatch(url, request.body),
				),
			);
			port.postMessage({
				kind: "response",
				id: request.id,
				status: 200,
				response: { ok: true, value: value ?? null },
			} satisfies ScopeResponse);
		} catch (error) {
			if (request.kind === "open") sockets.get(request.id)?.close();
			const info = error as { code?: AIReqRemoteErrorCode; status?: number; message?: string };
			port.postMessage({
				kind: "response",
				id: request.id,
				status: info.status ?? 400,
				response: {
					ok: false,
					error: { code: info.code ?? "INVALID_ARGUMENT", message: info.message ?? "Invalid request" },
				},
			} satisfies ScopeResponse);
		}
	});
	port.postMessage({ kind: "ready" });
}
