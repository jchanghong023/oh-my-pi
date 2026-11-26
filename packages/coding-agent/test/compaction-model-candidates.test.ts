import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_COMPACTION_SETTINGS, shouldUseProviderNativeCompaction } from "@oh-my-pi/pi-agent-core/compaction";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
afterAll(() => authStorage.close());

describe("resolveCompactionModelCandidates", () => {
	test("a filtered largest model does not hide a smaller provider-native fallback", () => {
		const definition = {
			name: "Compaction candidate",
			reasoning: false,
			input: ["text"] as Array<"text">,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 1024,
		};
		const liveModel = buildModel({
			...definition,
			id: "active-model",
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl: "https://codex.invalid",
			contextWindow: 200_000,
			remoteCompaction: { enabled: false },
		});
		const fallback = buildModel({
			...definition,
			id: "native-fallback",
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl: "https://codex.invalid",
			contextWindow: 300_000,
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		});
		const largest = buildModel({
			...definition,
			id: "other-provider",
			provider: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://anthropic.invalid",
			contextWindow: 400_000,
		});
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings, ignoreLocalModelConfig: true });
		const host = { settings, modelRegistry, model: () => liveModel } as unknown as SessionMaintenanceHost;
		const candidates = new SessionMaintenance(host).resolveCompactionModelCandidates(
			liveModel,
			[liveModel, largest, fallback],
			candidate =>
				candidate.provider === liveModel.provider &&
				shouldUseProviderNativeCompaction(candidate, DEFAULT_COMPACTION_SETTINGS),
		);
		expect(candidates).toEqual([fallback]);
	});
});
