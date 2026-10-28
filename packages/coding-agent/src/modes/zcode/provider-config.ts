import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { completeSimple, type Api, type Model } from "@oh-my-pi/pi-ai";
import { concreteThinkingLevel, parseConfiguredThinkingLevel, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { discoverAuthStorage } from "../../sdk";
import { AuthStorage } from "../../session/auth-storage";
import {
	zcodeProviderTestModelConnectivityParamsSchema,
	zcodeWorkspaceUpdateInteractionPreferencesParamsSchema,
	zcodeWorkspaceUpdateModelIoPreferencesParamsSchema,
} from "./schema/vendor/zcode-protocol/index";

export interface ZCodeConfigurationRecord {
	cwd: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
}
export interface ZCodeWorkspacePreferences {
	askUserQuestionAutoResolutionEnabled: boolean;
	fullRetentionEnabled: boolean;
}
export interface ZCodeProviderConfigurationOptions {
	records?: () => Iterable<ZCodeConfigurationRecord>;
	applyInteractionPreferences?: (cwd: string, enabled: boolean) => number;
	applyModelIoPreferences?: (cwd: string, enabled: boolean) => number;
	createCatalogAuthStorage?: (cwd: string, settings: Settings) => Promise<AuthStorage>;
}

const defaults: ZCodeWorkspacePreferences = { askUserQuestionAutoResolutionEnabled: true, fullRetentionEnabled: false };

/** ZCode's public disabled selector is OMP's explicit reasoning-off selector. */
export function parseZCodeThinkingLevel(value: string | null | undefined) {
	return parseConfiguredThinkingLevel(value === "disabled" ? "off" : value);
}

export function toZCodeReasoningLevel(value: string): string {
	return value === "off" ? "disabled" : value;
}

export class ZCodeProviderConfiguration {
	readonly #options: ZCodeProviderConfigurationOptions;
	readonly #preferences = new Map<string, ZCodeWorkspacePreferences>();
	#serial: Promise<unknown> = Promise.resolve();

	constructor(options: ZCodeProviderConfigurationOptions = {}) {
		this.#options = options;
	}

	#exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.#serial.then(fn);
		this.#serial = result.catch(() => {});
		return result;
	}

	getWorkspacePreferences(cwd: string): ZCodeWorkspacePreferences {
		return { ...(this.#preferences.get(resolve(cwd)) ?? defaults) };
	}

	async catalog(cwd: string): Promise<Model<Api>[]> {
		const settings = await Settings.loadReadOnly({ cwd });
		const auth = await (this.#options.createCatalogAuthStorage?.(cwd, settings) ??
			discoverAuthStorage(undefined, { cwd, settings }));
		try {
			const registry = new ModelRegistry(auth, undefined, { settings });
			await registry.hydrateCredentialScopedModelCaches();
			return registry.getAvailable();
		} finally {
			auth.close();
			settings.cancelPendingSaves();
		}
	}

	async testModelConnectivity(input: unknown, signal?: AbortSignal): Promise<{ success: true }> {
		const { workspace, selection } = zcodeProviderTestModelConnectivityParamsSchema.parse(input);
		signal?.throwIfAborted();
		const cwd = resolve(workspace.workspacePath);
		const live = this.#records().find(record => resolve(record.cwd) === cwd);
		const settings = live?.settings ?? (await Settings.loadReadOnly({ cwd }));
		let auth: AuthStorage | undefined;
		try {
			const registry =
				live?.modelRegistry ??
				new ModelRegistry(
					(auth = await (this.#options.createCatalogAuthStorage?.(cwd, settings) ??
						discoverAuthStorage(undefined, { cwd, settings }))),
					undefined,
					{ settings },
				);
			const model = registry.find(selection.providerId, selection.modelId);
			if (!model) throw new Error(`Unknown model: ${selection.providerId}/${selection.modelId}`);
			const level = selection.options?.reasoningLevel;
			const thinking = level === undefined ? undefined : parseZCodeThinkingLevel(level);
			if (level !== undefined && thinking === undefined) throw new Error("Unsupported reasoning level");
			const sessionId = randomUUID();
			const apiKey = await registry.getApiKey(model, sessionId, { signal });
			const headers = await registry.resolveModelHeaders(model, signal);
			if (apiKey === undefined && Object.keys(headers ?? {}).length === 0)
				throw new Error(`No request authentication for provider: ${model.provider}`);
			const response = await completeSimple(
				model,
				{ messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }] },
				{
					apiKey,
					headers,
					requestAuth: { apiKey, headers },
					signal,
					maxTokens: 8,
					maxHttpAttempts: 1,
					reasoning: toReasoningEffort(concreteThinkingLevel(thinking)),
					disableReasoning: thinking === "off",
				},
			);
			signal?.throwIfAborted();
			if (response.stopReason === "error" || response.stopReason === "aborted")
				throw new Error(response.errorMessage || `Provider request ${response.stopReason}`);
			if (!response.content.some(block => block.type === "text" && block.text.trim().length > 0))
				throw new Error("Provider returned no completion text");
			return { success: true };
		} finally {
			auth?.close();
			if (!live) settings.cancelPendingSaves();
		}
	}

	updateInteractionPreferences(input: unknown) {
		return this.#exclusive(async () => {
			const params = zcodeWorkspaceUpdateInteractionPreferencesParamsSchema.parse(input);
			const cwd = resolve(params.workspace.workspacePath);
			const enabled = params.preferences.askUserQuestionAutoResolutionEnabled;
			if (!this.#options.applyInteractionPreferences && this.#records().some(record => resolve(record.cwd) === cwd))
				throw new Error("Interaction preference consumer is unavailable");
			const count = this.#options.applyInteractionPreferences?.(cwd, enabled) ?? 0;
			this.#preferences.set(cwd, {
				...this.getWorkspacePreferences(cwd),
				askUserQuestionAutoResolutionEnabled: enabled,
			});
			return {
				workspace: params.workspace,
				askUserQuestionAutoResolutionEnabled: enabled,
				snoozedInteractionCount: count,
			};
		});
	}

	updateModelIoPreferences(input: unknown) {
		return this.#exclusive(async () => {
			const params = zcodeWorkspaceUpdateModelIoPreferencesParamsSchema.parse(input);
			const cwd = resolve(params.workspace.workspacePath);
			const enabled = params.preferences.fullRetentionEnabled;
			if (!this.#options.applyModelIoPreferences && this.#records().some(record => resolve(record.cwd) === cwd))
				throw new Error("Model IO retention consumer is unavailable");
			const count = this.#options.applyModelIoPreferences?.(cwd, enabled) ?? 0;
			this.#preferences.set(cwd, { ...this.getWorkspacePreferences(cwd), fullRetentionEnabled: enabled });
			return { workspace: params.workspace, fullRetentionEnabled: enabled, updatedSessionCount: count };
		});
	}

	#records(): ZCodeConfigurationRecord[] {
		return Array.from(this.#options.records?.() ?? []);
	}
}
