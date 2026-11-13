import { Emitter } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import { ServiceChannels } from "../../../../vendor/zcode-frontend/packages/shared/src/channels";
import type {
	BroadcastClaimAcquireResult,
	BroadcastMessage,
} from "../../../../vendor/zcode-frontend/packages/services/src/broadcast/broadcast";
import type { AppSettings } from "../../../../vendor/zcode-frontend/packages/shared/src/protocol";
import type { WebGuiServiceContext, WebGuiServiceDefinition } from "./rpc-contract";
import { createWebGuiService } from "./service-channel";
import { createModelSelectionService } from "./services-model-selection";

// 浏览器标签之间的真实广播：同进程内按连接分发，发送者不接收自己的消息。
const broadcastHubs = new Map<string, Emitter<BroadcastMessage>>();
function broadcastHub(connectionId: string): Emitter<BroadcastMessage> {
	let hub = broadcastHubs.get(connectionId);
	if (!hub) {
		hub = new Emitter<BroadcastMessage>();
		broadcastHubs.set(connectionId, hub);
	}
	return hub;
}

/** Connection-local presentation views, not snapshots of native OMP configuration or accounts. */
export function createUiServices(context: WebGuiServiceContext): readonly WebGuiServiceDefinition[] {
	context.signal.throwIfAborted();

	// The minimal browser shell only needs presentation preferences; no native settings are read or written.
	const settings: AppSettings = { recentProjects: [], locale: "zh-CN" };

	return [
		createWebGuiService(ServiceChannels.Setting, {
			get: (): AppSettings => settings,
		}),
		createModelSelectionService(context),
		createWebGuiService(
			ServiceChannels.Broadcast,
			{
				send: (message: unknown): void => {
					if (!message || typeof message !== "object") return;
					for (const [connectionId, hub] of broadcastHubs) {
						if (connectionId !== context.connectionId) hub.fire(message as BroadcastMessage);
					}
				},
				// Cross-process coordination has no browser implementation in the minimal shell.
				acquireClaim: (): BroadcastClaimAcquireResult => ({ status: "unavailable" }),
				commitClaim: async () => undefined,
				releaseClaim: async () => undefined,
				tryClaim: async () => false,
			},
			{ events: { onMessage: broadcastHub(context.connectionId).event } },
		),
	];
}
