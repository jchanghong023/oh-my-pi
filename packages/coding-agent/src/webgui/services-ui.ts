import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import {
	USER_INSTRUCTIONS_MAX_BYTES,
	USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE,
} from "../../../../vendor/zcode-frontend/packages/shared/src/userInstructions";
import { writeFileAtomically } from "../utils/atomic-file";
import type { BroadcastClaimAcquireResult } from "../../../../vendor/zcode-frontend/packages/services/src/broadcast/broadcast";
import { ServiceChannels } from "../../../../vendor/zcode-frontend/packages/shared/src/channels";
import type { ClientConfigSnapshot } from "../../../../vendor/zcode-frontend/packages/shared/src/clientConfig";
import type { AppSettings } from "../../../../vendor/zcode-frontend/packages/shared/src/protocol";
import type { WebGuiServiceContext, WebGuiServiceDefinition } from "./rpc-contract";
import { runWebGuiNativeMutation } from "./native-session-host";
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
	const instructionsPath = path.join(context.nativeSession?.settings.getAgentDir() ?? getAgentDir(), "AGENTS.md");

	return [
		createWebGuiService(ServiceChannels.Setting, {
			get: (): AppSettings => settings,
			getUserInstructions: async () => {
				context.signal.throwIfAborted();
				try {
					const content = await Bun.file(instructionsPath).text();
					context.signal.throwIfAborted();
					return { content, filePath: instructionsPath, exists: true };
				} catch (error) {
					if (!isEnoent(error)) throw error;
					return { content: "", filePath: instructionsPath, exists: false };
				}
			},
			saveUserInstructions: (content: unknown) =>
				runWebGuiNativeMutation(async () => {
					context.signal.throwIfAborted();
					if (typeof content !== "string") throw new Error("User instructions must be text");
					if (Buffer.byteLength(content, "utf8") > USER_INSTRUCTIONS_MAX_BYTES) {
						throw Object.assign(new Error(`User instructions exceed ${USER_INSTRUCTIONS_MAX_BYTES} bytes`), {
							code: USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE,
						});
					}
					await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
					context.signal.throwIfAborted();
					await writeFileAtomically(instructionsPath, content);
					return { filePath: instructionsPath };
				}),
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
