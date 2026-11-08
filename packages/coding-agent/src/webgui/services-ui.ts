import type { ProviderSettingsView } from "../../../../vendor/zcode-frontend/packages/provider/src/facades";
import type { BroadcastClaimAcquireResult } from "../../../../vendor/zcode-frontend/packages/services/src/broadcast/broadcast";
import type { ClientScenesResponse } from "../../../../vendor/zcode-frontend/packages/services/src/client-scenes/clientScenes";
import type { OffPeakClientConfig } from "../../../../vendor/zcode-frontend/packages/services/src/coding-plan-subscription/codingPlanSubscription";
import { ServiceChannels } from "../../../../vendor/zcode-frontend/packages/shared/src/channels";
import type { ClientConfigSnapshot } from "../../../../vendor/zcode-frontend/packages/shared/src/clientConfig";
import type {
	CodingPlanBatchPreviewResponse,
	CodingPlanBillingDiscountConfig,
	StartPlanPreviewConfig,
} from "../../../../vendor/zcode-frontend/packages/shared/src/coding-plan-subscription";
import {
	createDynamicWorkflowClientConfig,
	type DynamicWorkflowClientConfig,
} from "../../../../vendor/zcode-frontend/packages/shared/src/dynamic-workflow-feature";
import type { MarketingTouchSnapshot } from "../../../../vendor/zcode-frontend/packages/shared/src/marketingTouch";
import type {
	OAuthCachedSessionRestoreResult,
	OAuthProviderId,
	OAuthProviderMeta,
	UserInfo,
} from "../../../../vendor/zcode-frontend/packages/shared/src/oauth";
import type { AppSettings } from "../../../../vendor/zcode-frontend/packages/shared/src/protocol";
import type { UsageEntitlementSnapshot } from "../../../../vendor/zcode-frontend/packages/shared/src/usage-stats";
import type { WebGuiServiceContext, WebGuiServiceDefinition } from "./rpc-contract";
import { createWebGuiService } from "./service-channel";
import { createModelSelectionService } from "./services-model-selection";

/** Connection-local presentation views, not snapshots of native OMP configuration or accounts. */
export function createUiServices(context: WebGuiServiceContext): readonly WebGuiServiceDefinition[] {
	context.signal.throwIfAborted();

	// No migration markers: no native settings, account, or provider migration has run.
	const settings: AppSettings = { recentProjects: [], locale: "zh-CN" };
	const providerSettings: ProviderSettingsView = {
		revision: 0,
		providerTemplates: [],
		providerOrder: [],
		providers: [],
	};
	const oauthProviders: OAuthProviderMeta[] = [];
	const signedOut: OAuthCachedSessionRestoreResult = { status: "signed-out" };
	const dynamicWorkflow: DynamicWorkflowClientConfig = createDynamicWorkflowClientConfig("disabled", "default");
	const offPeak: OffPeakClientConfig = {
		enabled: false,
		modelSelectionView: { revision: 0, providers: [] },
	};
	const clientConfig: ClientConfigSnapshot = {
		pluginStoreOrder: null,
		zsrcUrl: null,
		uiPluginRecommendations: [],
	};
	const clientScenes: ClientScenesResponse = { code: 0, msg: "", data: [] };
	const subscription: CodingPlanBatchPreviewResponse = {
		productList: [],
		isSubscribed: false,
		isAuthenticated: false,
	};

	return [
		createWebGuiService(ServiceChannels.Setting, {
			get: (): AppSettings => settings,
			// TODO(omp-settings): Map update/updateDataBaseDir and user instruction reads/writes to native OMP settings.
			// Presentation changes are also unavailable until they genuinely mutate connection-owned state and publish changes.
		}),
		// TODO(omp-onboarding): Map record reads, onboarding decisions, append/dismiss/claim, preference sync/update, and clear to OMP onboarding.
		createWebGuiService(ServiceChannels.OnboardingRecord, {}),
		createWebGuiService(ServiceChannels.Credential, {
			// This attachment has no credential registrations; this does not query the native secret store.
			load: (): string | null => null,
			// TODO(omp-credentials): Map authorized credential registration/save/delete to OMP authentication; never expose native secrets implicitly.
		}),
		createWebGuiService(ServiceChannels.Broadcast, {
			acquireClaim: (): BroadcastClaimAcquireResult => ({ status: "unavailable" }),
			// TODO(omp-broadcast): Map send, commitClaim, releaseClaim, tryClaim, and onMessage publishing to OMP multi-client coordination.
		}),
		createWebGuiService(ServiceChannels.OAuth, {
			getProviders: (): OAuthProviderMeta[] => oauthProviders,
			getActiveProvider: (): OAuthProviderId | null => null,
			restoreCachedSession: (): UserInfo | null => null,
			restoreCachedSessionState: (): OAuthCachedSessionRestoreResult => signedOut,
			// TODO(omp-oauth): Map remote restoreSession, OAuth start/poll/callback, refresh, logout/logoutAll, cancelPending, and session changes to OMP authentication.
		}),
		createWebGuiService(ServiceChannels.ProviderSettings, {
			getView: (): ProviderSettingsView => providerSettings,
			// Refresh reads this attachment's registered adapter view; it performs no native or remote discovery.
			refresh: (): ProviderSettingsView => providerSettings,
			// TODO(omp-providers): Map provider/model creation, overlays, deletion, ordering, drafts, enablement, resolution, connectivity tests, and onDidChange publishing to OMP adapters.
		}),
		createModelSelectionService(context),
		createWebGuiService(ServiceChannels.UsageStats, {
			getEntitlementSnapshot: (): UsageEntitlementSnapshot => ({
				generatedAt: Date.now(),
				authenticated: false,
				unavailableReason: "unavailable",
				provider: null,
				remaining: null,
				subscription: null,
				quota: null,
			}),
			// TODO(omp-usage): Map app/local and Coding Plan usage reads, TPS, reset status/opportunity/use/history, and getSnapshot to OMP accounting; never fabricate zero usage.
		}),
		createWebGuiService(ServiceChannels.CodingPlanSubscription, {
			batchPreview: (): CodingPlanBatchPreviewResponse => subscription,
			getDynamicWorkflowClientConfig: (): DynamicWorkflowClientConfig => dynamicWorkflow,
			getOffPeakClientConfig: (): OffPeakClientConfig => offPeak,
			getStartPlanPreview: (): StartPlanPreviewConfig | null => null,
			getBillingDiscount: (): CodingPlanBillingDiscountConfig | undefined => undefined,
			// TODO(omp-subscription): Map product catalogs/details, manual claims, verification/update configs, model context policy, enterprise pricing/balance/orders, previews, payments, and saved cards to OMP subscription capabilities.
		}),
		createWebGuiService(ServiceChannels.ClientConfig, {
			getSnapshot: (): ClientConfigSnapshot => clientConfig,
			// TODO(omp-client-config): Populate this presentation view from explicitly registered OMP public UI configuration, not remote ZCode discovery.
		}),
		createWebGuiService(ServiceChannels.ClientScenes, {
			list: (): ClientScenesResponse => clientScenes,
			// TODO(omp-client-scenes): Populate this connection's scene catalog from OMP UI scene registrations.
		}),
		// TODO(omp-cloud-content): Map readPublishedMedia/prepare/release to authorized OMP content delivery and real lease lifetimes.
		createWebGuiService(ServiceChannels.CloudContent, {}),
		createWebGuiService(ServiceChannels.MarketingTouch, {
			query: (input: unknown): MarketingTouchSnapshot & { scope: string } => {
				if (
					typeof input !== "object" ||
					input === null ||
					!("locale" in input) ||
					(input.locale !== "zh-CN" && input.locale !== "en-US")
				) {
					throw new TypeError("Marketing touch query requires a supported locale");
				}
				// This connection has no configured campaigns; this view does not query a native or remote campaign service.
				return {
					serverTime: Date.now(),
					language: input.locale,
					deliveries: [],
					rejectedCount: 0,
					scope: context.connectionId,
				};
			},
			// TODO(omp-marketing): Integrate native OMP campaign registrations/query and action reporting; report remains unavailable.
		}),
	];
}
