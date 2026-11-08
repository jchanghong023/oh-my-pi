import type { ModelSelectionView } from "../../../../vendor/zcode-frontend/packages/provider/src/facades";
import { Emitter } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import { ServiceChannels } from "../../../../vendor/zcode-frontend/packages/shared/src/channels";
import { cfgEnabledModels } from "../config/model-settings";
import { nativeChatRuntime } from "./native-chat";
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
	) {
		throw new TypeError("Session model selection requires sessionId, providerId and modelId");
	}
	return { sessionId: value.sessionId, providerId: value.providerId, modelId: value.modelId };
}

/** Project-owned native models are identities, never browser provider credentials/configuration. */
export function createModelSelectionService(context: WebGuiServiceContext): WebGuiServiceDefinition {
	const session = context.nativeSession;
	const project = context.projectId ? readBrowserProject(context.projectId) : null;
	const changes = new Emitter<ModelSelectionView>();
	let revision = 0;
	let disposed = false;
	const hasLiveOwner = (): boolean => {
		if (!project) return false;
		const live = readBrowserProject(project.projectId);
		return !!(
			live &&
			live.ownerId === project.ownerId &&
			live.mode === "webgui" &&
			live.phase === "active" &&
			live.nativeSession === session
		);
	};
	const assertSession = (sessionId?: string, generation?: number): void => {
		context.signal.throwIfAborted();
		if (disposed || !session || session.isDisposed || !hasLiveOwner())
			throw new Error("The native session is no longer bound to this project");
		if (
			(sessionId !== undefined && session.isSessionTransitioning) ||
			(sessionId !== undefined && session.sessionId !== sessionId) ||
			(generation !== undefined && session.sessionGeneration !== generation)
		)
			throw new Error("The native session changed; refresh the model selection");
	};
	const getView = (): ModelSelectionView => {
		if (!session) return { revision, providers: [], nativeSession: null };
		assertSession();
		const current = session.model;
		return {
			revision,
			providers: [],
			nativeSession: {
				sessionId: session.sessionId,
				workspacePath: session.sessionManager.getCwd(),
				chatAvailable: true,
				taskRunsAvailable: nativeChatRuntime(context).taskRunsAvailable,
				models: session.getAvailableModels().map(model => ({
					providerId: model.provider,
					modelId: model.id,
					name: model.name,
				})),
			},
			...(current ? { preferredSelection: { providerId: current.provider, modelId: current.id } } : {}),
		};
	};
	const publish = (): void => {
		if (disposed || context.signal.aborted || !session || session.isDisposed || !hasLiveOwner()) return;
		revision++;
		changes.fire(getView());
	};
	let observedSessionId = session?.sessionId;
	const runtimeChanges =
		session && !session.isDisposed && hasLiveOwner()
			? nativeChatRuntime(context).changes.event(() => {
					if (session.sessionId === observedSessionId) return;
					observedSessionId = session.sessionId;
					publish();
				})
			: undefined;
	const unsubscribeSession = session?.subscribe(event => {
		if (event.type === "model_changed" || event.type === "queue_update") publish();
	});
	const unsubscribeCatalog = session?.modelRegistry.subscribeMirror(publish).unsubscribe;
	const unsubscribeEnabledModels = session && cfgEnabledModels.listen(session.settings, publish);
	return createWebGuiService(
		ServiceChannels.ModelSelection,
		{
			getView,
			setSessionModel: async (value: unknown): Promise<ModelSelectionView> => {
				const input = sessionModelInput(value);
				assertSession(input.sessionId);
				if (!session) throw new Error("No native session is bound to this project");
				const generation = session.sessionGeneration;
				const model = session
					.getAvailableModels()
					.find(candidate => candidate.provider === input.providerId && candidate.id === input.modelId);
				if (!model) throw new Error("The selected model is unavailable or has no configured authentication");
				const operation = session.setModelTemporary(model);
				project?.pendingModelSelections?.add(operation);
				try {
					await operation;
				} finally {
					project?.pendingModelSelections?.delete(operation);
				}
				assertSession(input.sessionId, generation);
				const current = session.model;
				if (current?.provider !== input.providerId || current.id !== input.modelId)
					throw new Error("The native session did not retain the selected model");
				return getView();
			},
		},
		{
			events: { onDidChange: changes.event },
			dispose: () => {
				disposed = true;
				unsubscribeSession?.();
				runtimeChanges?.dispose();
				unsubscribeCatalog?.();
				unsubscribeEnabledModels?.();
				changes.dispose();
			},
		},
	);
}
