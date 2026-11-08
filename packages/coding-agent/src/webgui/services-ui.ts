import type { BroadcastClaimAcquireResult } from "../../../../vendor/zcode-frontend/packages/services/src/broadcast/broadcast";
import { ServiceChannels } from "../../../../vendor/zcode-frontend/packages/shared/src/channels";
import type { ClientConfigSnapshot } from "../../../../vendor/zcode-frontend/packages/shared/src/clientConfig";
import type { AppSettings } from "../../../../vendor/zcode-frontend/packages/shared/src/protocol";
import type { WebGuiServiceContext, WebGuiServiceDefinition } from "./rpc-contract";
import { createWebGuiService } from "./service-channel";
import { createModelSelectionService } from "./services-model-selection";

/** Connection-local presentation views, not snapshots of native OMP configuration or accounts. */
export function createUiServices(context: WebGuiServiceContext): readonly WebGuiServiceDefinition[] {
	context.signal.throwIfAborted();

	// No migration markers: no native settings, account, or provider migration has run.
	const settings: AppSettings = { recentProjects: [], locale: "zh-CN" };
	const clientConfig: ClientConfigSnapshot = {
		pluginStoreOrder: null,
		zsrcUrl: null,
	};

	return [
		createWebGuiService(ServiceChannels.Setting, {
			get: (): AppSettings => settings,
			// TODO(omp-settings): Map update and user instruction reads/writes to native OMP settings.
			// Presentation changes are also unavailable until they genuinely mutate connection-owned state and publish changes.
		}),
		createWebGuiService(ServiceChannels.Credential, {
			// This attachment has no credential registrations; this does not query the native secret store.
			load: (): string | null => null,
			// TODO(omp-credentials): Map authorized credential registration/save/delete to OMP authentication; never expose native secrets implicitly.
		}),
		createWebGuiService(ServiceChannels.Broadcast, {
			acquireClaim: (): BroadcastClaimAcquireResult => ({ status: "unavailable" }),
			// TODO(omp-broadcast): Map send, commitClaim, releaseClaim, tryClaim, and onMessage publishing to OMP multi-client coordination.
		}),
		createWebGuiService(ServiceChannels.ProviderSettings, {
			// TODO(omp-providers): Map provider/model creation, overlays, deletion, ordering, drafts, enablement, resolution, connectivity tests, and onDidChange publishing to OMP adapters.
		}),
		createModelSelectionService(context),
		createWebGuiService(ServiceChannels.ClientConfig, {
			getSnapshot: (): ClientConfigSnapshot => clientConfig,
			// TODO(omp-client-config): Populate this presentation view from explicitly registered OMP public UI configuration, not remote ZCode discovery.
		}),
	];
}
