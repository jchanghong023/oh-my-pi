import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

import {
	cfgDisabledModels,
	cfgDisabledProviders,
	cfgEnabledModels,
} from "@oh-my-pi/pi-coding-agent/config/model-settings";

function bundled(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

describe("disabledProviders takes effect live", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-model-availability-live-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	const startSession = (settings: Settings, modelRegistry: ModelRegistry, scopedModels: Model<Api>[]) => {
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: scopedModels[0],
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			scopedModels: scopedModels.map(model => ({ model })),
		});
		return session;
	};

	it("drops a provider disabled mid-session from the model list and the Ctrl+P cycle", async () => {
		const sonnet = bundled("anthropic", "claude-sonnet-4-5");
		const opus = bundled("anthropic", "claude-opus-4-5");
		const gpt = bundled("openai", "gpt-5");
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		const live = startSession(settings, modelRegistry, [sonnet, gpt, opus]);
		expect(live.getAvailableModels().some(model => model.provider === "openai")).toBe(true);

		cfgDisabledProviders.set(settings, ["openai"]);

		expect(live.scopedModels.map(entry => entry.model.id)).toEqual([sonnet.id, opus.id]);
		expect(live.getAvailableModels().some(model => model.provider === "openai")).toBe(false);
		const cycled = await live.cycleModel();
		expect(cycled?.model.id).toBe(opus.id);
		expect((await live.cycleModel())?.model.id).toBe(sonnet.id);
	});

	it("intersects explicit cycle scopes and rejects models outside enabledModels", async () => {
		const sonnet = bundled("anthropic", "claude-sonnet-4-5");
		const opus = bundled("anthropic", "claude-opus-4-5");
		const gpt = bundled("openai", "gpt-5");
		const settings = Settings.isolated();
		cfgEnabledModels.set(settings, [`${gpt.provider}/${gpt.id}`]);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		const live = startSession(settings, modelRegistry, [sonnet, gpt, opus]);

		expect(live.getAvailableModels().map(model => `${model.provider}/${model.id}`)).toEqual([
			`${gpt.provider}/${gpt.id}`,
		]);
		expect(live.scopedModels.map(entry => `${entry.model.provider}/${entry.model.id}`)).toEqual([
			`${gpt.provider}/${gpt.id}`,
		]);
		live.setScopedModels([sonnet, opus].map(model => ({ model })));
		expect(live.scopedModels).toEqual([]);
		await expect(live.cycleModel()).resolves.toBeUndefined();
		await expect(live.setModel(sonnet)).rejects.toThrow("not enabled");
		await expect(live.setModelTemporary(sonnet)).rejects.toThrow("not enabled");
	});

	it("restricts unscoped and role cycling to enabledModels", async () => {
		const sonnet = bundled("anthropic", "claude-sonnet-4-5");
		const gpt = bundled("openai", "gpt-5");
		const settings = Settings.isolated();
		cfgEnabledModels.set(settings, [`${gpt.provider}/${gpt.id}`]);
		settings.setModelRole("default", `${sonnet.provider}/${sonnet.id}`);
		settings.setModelRole("slow", `${gpt.provider}/${gpt.id}`);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		const live = startSession(settings, modelRegistry, [sonnet]);
		live.setScopedModels([]);

		expect(live.getAvailableModels().map(model => `${model.provider}/${model.id}`)).toEqual([
			`${gpt.provider}/${gpt.id}`,
		]);
		await expect(live.cycleModel()).resolves.toBeUndefined();
		expect(live.getRoleModelCycle(["default", "slow"])?.models.map(entry => entry.role)).toEqual(["slow"]);
	});

	it("restores a previously active model outside the positive selection without allowing ordinary switches", async () => {
		const sonnet = bundled("anthropic", "claude-sonnet-4-5");
		const gpt = bundled("openai", "gpt-5");
		const settings = Settings.isolated({ enabledModels: [`${gpt.provider}/${gpt.id}`] });
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		const live = startSession(settings, modelRegistry, [sonnet, gpt]);
		await live.setModelTemporary(gpt);
		await expect(live.setModelTemporary(sonnet)).rejects.toThrow("not enabled");
		await live.setModelTemporary(sonnet, undefined, { restore: true });
		expect(live.model?.id).toBe(sonnet.id);
		cfgDisabledModels.set(settings, [`${gpt.provider}/${gpt.id}`]);
		await expect(live.setModelTemporary(gpt, undefined, { restore: true })).rejects.toThrow();
		expect(live.model?.id).toBe(sonnet.id);
	});

	it("allows authenticated synthetic models in temporary switches and explicit cycles", async () => {
		const base = bundled("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const synthetic = { ...base, id: "arn:aws:bedrock:us-east-2:1234567890:application-inference-profile/company" };
		authStorage.keys.setRuntime("amazon-bedrock", "test-key");
		const settings = Settings.isolated({ enabledModels: ["amazon-bedrock/*"] });
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		const live = startSession(settings, modelRegistry, [base, synthetic]);
		expect(live.scopedModels.map(entry => entry.model.id)).toContain(synthetic.id);
		await live.setModelTemporary(synthetic);
		expect(live.model?.id).toBe(synthetic.id);
	});

	it("shared registry views keep session exclusions isolated through asynchronous credentials", async () => {
		const model = bundled("anthropic", "claude-sonnet-4-5");
		const startup = Settings.isolated();
		const target = startup.overlay({ disabledModels: [`${model.provider}/${model.id}`] });
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings: startup });
		const scoped = registry.withSettings(target);
		const resolver = scoped.resolver(model);
		expect(scoped.find(model.provider, model.id)).toBeUndefined();
		expect(scoped.getAvailableForProviders(new Set([model.provider])).some(row => row.id === model.id)).toBe(false);
		const [rootKey, scopedKey, resolvedKey] = await Promise.all([
			registry.getApiKey(model),
			scoped.getApiKey(model),
			resolver({ lastChance: false, error: undefined }),
		]);
		expect(rootKey).toBe("test-key");
		expect(scopedKey).toBeUndefined();
		expect(resolvedKey).toBeUndefined();
		cfgDisabledModels.override(target, []);
		expect(await scoped.getApiKey(model)).toBe("test-key");
		cfgDisabledModels.override(startup, ["*"]);
		expect(await registry.getApiKey(model)).toBeUndefined();
		expect(await scoped.getApiKey(model)).toBe("test-key");
	});

	it("uses the current settings view for provider visibility and refresh", async () => {
		const modelsPath = path.join(tempDir.path(), "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					ollama: {
						baseUrl: "http://127.0.0.1:11434",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "ollama" },
					},
				},
			}),
		);
		const requests: string[] = [];
		const startup = Settings.isolated();
		const target = startup.overlay({ disabledProviders: ["ollama"] });
		const registry = new ModelRegistry(authStorage, modelsPath, {
			settings: startup,
			fetch: async input => {
				requests.push(String(input));
				return Response.json({ models: [] });
			},
		});
		const scoped = registry.withSettings(target);

		expect(registry.getDiscoverableProviders()).toContain("ollama");
		expect(scoped.getDiscoverableProviders()).not.toContain("ollama");
		await scoped.refreshProvider("ollama", "online");
		expect(requests).toEqual([]);

		await registry.refreshProvider("ollama", "online");
		expect(requests).toContain("http://127.0.0.1:11434/api/tags");
	});

	it("re-seeds implicit discovery for a provider re-enabled mid-session", async () => {
		const sonnet = bundled("anthropic", "claude-sonnet-4-5");
		const settings = Settings.isolated();
		cfgDisabledProviders.set(settings, ["lm-studio"]);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		startSession(settings, modelRegistry, [sonnet]);
		expect(modelRegistry.getDiscoverableProviders()).not.toContain("lm-studio");
		// Only a catalog rebuild re-seeds implicit discovery; await the one the session's
		// settings listener starts (the rebuild is async and exposes no other signal).
		const reapply = vi.spyOn(modelRegistry, "reapplyModelPolicies");

		cfgDisabledProviders.set(settings, []);
		await Promise.resolve();
		await reapply.mock.results[0]?.value;

		expect(modelRegistry.getDiscoverableProviders()).toContain("lm-studio");
	});
});
