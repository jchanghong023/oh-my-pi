import type { ModelSelectionView } from "../../../../vendor/zcode-frontend/packages/provider/src/facades";
import { Emitter } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import { ServiceChannels } from "../../../../vendor/zcode-frontend/packages/shared/src/channels";
import { cfgEnabledModels } from "../config/model-settings";
import type { AgentSession } from "../session/agent-session";
import { assertNativeChat, nativeChatChanges, nativeChatRuntimeForSession } from "./native-chat";
import {
	listWebGuiNativeSessions,
	resolveWebGuiSession,
	runWebGuiSession,
	webGuiNativePorts,
} from "./native-session-host";
import { readBrowserProject } from "./project-registry";
import type { WebGuiServiceContext, WebGuiServiceDefinition } from "./rpc-contract";
import { createWebGuiService } from "./service-channel";

interface SessionModelInput {
	readonly sessionId: string;
	readonly providerId: string;
	readonly modelId: string;
}

function sessionModelInput(value: unknown): SessionModelInput {
	if (
		typeof value !== "object" ||
		value === null ||
		!("sessionId" in value) ||
		typeof value.sessionId !== "string" ||
		!value.sessionId.trim() ||
		!("providerId" in value) ||
		typeof value.providerId !== "string" ||
		!value.providerId.trim() ||
		!("modelId" in value) ||
		typeof value.modelId !== "string" ||
		!value.modelId.trim()
	)
		throw new TypeError("Session model selection requires sessionId, providerId and modelId");
	return { sessionId: value.sessionId, providerId: value.providerId, modelId: value.modelId };
}

/** Each browser observes its selected resident; selection never creates or resumes an Agent. */
export function createModelSelectionService(context: WebGuiServiceContext): WebGuiServiceDefinition {
	const changes = new Emitter<ModelSelectionView>();
	let revision = 0;
	let disposed = false;
	let selectedId: string | undefined;
	let selected: AgentSession | undefined;
	let cleanups: Array<() => void> = [];
	let requestGeneration = 0;
	const assertOpen = () => {
		context.signal.throwIfAborted();
		if (disposed) throw new Error("The model selection connection is closed");
	};
	const view = (session: AgentSession | undefined): ModelSelectionView => {
		if (!session || session.isDisposed) return { revision, providers: [], nativeSession: null };
		const guest = webGuiNativePorts().collabGuest(session);
		const current = guest ? guest.state?.model : session.model;
		return {
			revision,
			providers: [],
			nativeSession: {
				sessionId: session.sessionId,
				workspacePath: session.sessionManager.getCwd(),
				chatAvailable: !guest?.readOnly,
				taskRunsAvailable: !guest && !!session.agentRegistry,
				models: guest
					? []
					: session
							.getAvailableModels()
							.map(model => ({ providerId: model.provider, modelId: model.id, name: model.name })),
			},
			...(current ? { preferredSelection: { providerId: current.provider, modelId: current.id } } : {}),
		};
	};
	const publish = () => {
		if (disposed || context.signal.aborted) return;
		revision++;
		changes.fire(view(selected));
	};
	const observe = (session: AgentSession | undefined) => {
		if (session === selected) return;
		for (const cleanup of cleanups) cleanup();
		cleanups = [];
		selected = session;
		if (!session) return;
		cleanups.push(nativeChatRuntimeForSession(session).retain());
		cleanups.push(
			session.subscribe(event => {
				if (event.type === "model_changed" || event.type === "queue_update") publish();
			}),
		);
		cleanups.push(session.modelRegistry.subscribeMirror(publish).unsubscribe);
		cleanups.push(cfgEnabledModels.listen(session.settings, publish));
	};
	const getView = async (value?: unknown): Promise<ModelSelectionView> => {
		assertOpen();
		const generation = ++requestGeneration;
		const id = value && typeof value === "object" && "sessionId" in value ? value.sessionId : undefined;
		if (id !== undefined && (typeof id !== "string" || !id.trim()))
			throw new TypeError("Invalid native session identity");
		const residents = context.projectId ? await listWebGuiNativeSessions(context) : [];
		const session =
			typeof id === "string"
				? residents.find(candidate => candidate.sessionId === id)
				: selectedId
					? residents.find(candidate => candidate.sessionId === selectedId)
					: residents[0];
		assertOpen();
		// Superseding an observer must not substitute its session into another caller's result.
		if (generation !== requestGeneration) return view(session);
		selectedId = typeof id === "string" ? id : session?.sessionId;
		observe(session);
		revision++;
		return view(session);
	};
	const runtimeChanges = nativeChatChanges.event(id => {
		if (selected && (id === selected.sessionId || id === selectedId)) publish();
	});
	return createWebGuiService(
		ServiceChannels.ModelSelection,
		{
			getView,
			setSessionModel: async (value: unknown): Promise<ModelSelectionView> => {
				assertOpen();
				const input = sessionModelInput(value);
				const session = await resolveWebGuiSession(context, input.sessionId);
				if (webGuiNativePorts().collabGuest(session))
					throw new Error("The native collaboration host controls its model.");
				if (session.isSessionTransitioning) throw new Error("The native session is transitioning");
				const generation = session.sessionGeneration;
				const model = session
					.getAvailableModels()
					.find(candidate => candidate.provider === input.providerId && candidate.id === input.modelId);
				if (!model) throw new Error("The selected model is unavailable or has no configured authentication");
				const project = context.projectId ? readBrowserProject(context.projectId) : undefined;
				assertNativeChat({ ...context, nativeSession: session });
				const operation = runWebGuiSession(session, () => session.setModelTemporary(model));
				project?.pendingModelSelections?.add(operation);
				try {
					await operation;
				} finally {
					project?.pendingModelSelections?.delete(operation);
				}
				assertOpen();
				if (
					(await resolveWebGuiSession(context, input.sessionId)) !== session ||
					session.sessionGeneration !== generation
				)
					throw new Error("The native session changed; refresh the model selection");
				if (session.model?.provider !== input.providerId || session.model.id !== input.modelId)
					throw new Error("The native session did not retain the selected model");
				if (!selectedId || selectedId === input.sessionId) {
					selectedId = input.sessionId;
					observe(session);
					publish();
				}
				return view(session);
			},
		},
		{
			events: { onDidChange: changes.event },
			dispose: () => {
				disposed = true;
				requestGeneration++;
				for (const cleanup of cleanups) cleanup();
				cleanups = [];
				runtimeChanges.dispose();
				changes.dispose();
			},
		},
	);
}
