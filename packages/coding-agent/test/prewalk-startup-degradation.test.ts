import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { resolvePrewalkTarget } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

import { cfgPrewalkEnabled, cfgPrewalkInto } from "@oh-my-pi/pi-coding-agent/session/settings";

// Regression for #6064: prewalk is an optional, off-by-default optimization.
// A missing key (or unresolvable target) for the prewalk hand-off model must
// leave prewalk unarmed with a warning, never abort startup and lock the user
// out of the app.
describe("prewalk startup degradation", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-prewalk-repro-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("leaves prewalk unarmed instead of crashing when the target has no configured auth", async () => {
		const settings = Settings.isolated();
		cfgPrewalkEnabled.set(settings, true);
		settings.setModelRole("smol", "cerebras/zai-glm-4.7");
		// Force the no-auth condition: hasAuth() also consults $HOME/.env via
		// getEnvApiKey (packages/utils/src/env.ts), so a CEREBRAS_API_KEY in the
		// runner's home .env would otherwise legitimately arm prewalk and make
		// this test environment-dependent.
		vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(false);

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk).toBeUndefined();
	});

	test("arms prewalk when the target resolves and has configured auth", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const settings = Settings.isolated();
		cfgPrewalkEnabled.set(settings, true);
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		authStorage.keys.setRuntime(model.provider, "test-key");

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk?.target.provider).toBe(model.provider);
		expect(options.prewalk?.target.id).toBe(model.id);
	});

	test("arms the configured prewalk.into target instead of @smol", async () => {
		const smol = getBundledModel("anthropic", "claude-sonnet-4-5");
		const into = getBundledModel("openai", "gpt-4o");
		if (!smol || !into) throw new Error("expected claude-sonnet-4-5 and gpt-4o to be bundled");
		const settings = Settings.isolated();
		cfgPrewalkEnabled.set(settings, true);
		cfgPrewalkInto.set(settings, `${into.provider}/${into.id}`);
		settings.setModelRole("smol", `${smol.provider}/${smol.id}`);
		authStorage.keys.setRuntime(smol.provider, "test-key");
		authStorage.keys.setRuntime(into.provider, "test-key");

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk?.target.provider).toBe(into.provider);
		expect(options.prewalk?.target.id).toBe(into.id);
	});

	test("skips a disabled provider and arms the next enabled prewalk candidate", async () => {
		const disabled = getBundledModel("anthropic", "claude-sonnet-4-5");
		const enabled = getBundledModel("openai", "gpt-4o");
		if (!disabled || !enabled) throw new Error("expected claude-sonnet-4-5 and gpt-4o to be bundled");
		const settings = Settings.isolated({ disabledProviders: [disabled.provider] });
		authStorage.keys.setRuntime(disabled.provider, "test-key");
		authStorage.keys.setRuntime(enabled.provider, "test-key");

		const options = await buildSessionOptions(
			parseArgs(["--prewalk-into", `${disabled.provider}/${disabled.id},${enabled.provider}/${enabled.id}`]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.prewalk?.target.provider).toBe(enabled.provider);
		expect(options.prewalk?.target.id).toBe(enabled.id);
	});

	test("arms a later candidate of the configured prewalk.into role when the first is unavailable", async () => {
		const disabled = getBundledModel("anthropic", "claude-sonnet-4-5");
		const enabled = getBundledModel("openai", "gpt-4o");
		if (!disabled || !enabled) throw new Error("expected claude-sonnet-4-5 and gpt-4o to be bundled");
		const settings = Settings.isolated({ disabledProviders: [disabled.provider] });
		cfgPrewalkEnabled.set(settings, true);
		settings.setModelRole("smol", `${disabled.provider}/${disabled.id},${enabled.provider}/${enabled.id}`);
		authStorage.keys.setRuntime(disabled.provider, "test-key");
		authStorage.keys.setRuntime(enabled.provider, "test-key");

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk?.target.provider).toBe(enabled.provider);
		expect(options.prewalk?.target.id).toBe(enabled.id);
	});

	test("continues past an unauthenticated automatic alias to an explicit role fallback", async () => {
		const automatic = getBundledModel("anthropic", "claude-haiku-5-5");
		const fallback = getBundledModel("openai", "gpt-4o");
		if (!automatic || !fallback) throw new Error("expected bundled prewalk models");
		const settings = Settings.isolated({ modelRoles: { smol: `@smol,${fallback.provider}/${fallback.id}` } });
		const registry = {
			getAll: () => [automatic, fallback],
			getAvailable: () => [automatic, fallback],
			hasConfiguredAuth: (model: typeof fallback) => model.provider === fallback.provider,
			getDiscoveryProviderId: () => undefined,
		} as unknown as ModelRegistry;

		const result = await resolvePrewalkTarget(["@smol"], "@smol", registry, {}, new Set(), { settings });
		expect(result.prewalk?.target.id).toBe(fallback.id);
	});

	test("discovers an earlier configured candidate before an automatic role fallback", async () => {
		const automatic = getBundledModel("anthropic", "claude-haiku-5-5");
		const discovered = getBundledModel("openai", "gpt-4o");
		if (!automatic || !discovered) throw new Error("expected bundled prewalk models");
		const settings = Settings.isolated({ modelRoles: { smol: `${discovered.provider}/${discovered.id},@smol` } });
		let refreshed = false;
		const registry = {
			getAll: () => (refreshed ? [discovered, automatic] : [automatic]),
			getAvailable: () => (refreshed ? [discovered, automatic] : [automatic]),
			hasProvider: (provider: string) => provider === discovered.provider,
			hasConfiguredAuth: () => true,
			getDiscoveryProviderId: (provider: string) => provider,
			refreshDiscoverableProviders: async () => {
				refreshed = true;
			},
		} as unknown as ModelRegistry;

		const result = await resolvePrewalkTarget(["@smol"], "@smol", registry, {}, new Set(), { settings });
		expect(refreshed).toBe(true);
		expect(result.prewalk?.target.id).toBe(discovered.id);
	});

	test("does not implicitly re-arm configured prewalk while restoring a session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const settings = Settings.isolated();
		cfgPrewalkEnabled.set(settings, true);
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		authStorage.keys.setRuntime(model.provider, "test-key");

		for (const args of [parseArgs(["--continue"]), parseArgs(["--resume=session.jsonl"])]) {
			const options = await buildSessionOptions(args, [], SessionManager.inMemory(), modelRegistry, settings);
			expect(options.prewalk).toBeUndefined();
		}
	});

	test("honors an explicit prewalk flag while restoring a session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		authStorage.keys.setRuntime(model.provider, "test-key");

		const options = await buildSessionOptions(
			parseArgs(["--continue", "--prewalk"]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.prewalk?.target.provider).toBe(model.provider);
		expect(options.prewalk?.target.id).toBe(model.id);
	});

	test.each(["default", "@default", "@smol"])(
		"preserves the configured default and thinking before --model for explicit prewalk %s",
		async target => {
			const original = getBundledModel("anthropic", "claude-sonnet-4-5");
			const override = getBundledModel("openai", "gpt-4o");
			if (!original || !override) throw new Error("expected bundled prewalk models");
			const settings = Settings.isolated();
			settings.setModelRole("default", `${original.provider}/${original.id}:off`);
			authStorage.keys.setRuntime(original.provider, "test-key");
			authStorage.keys.setRuntime(override.provider, "test-key");

			const options = await buildSessionOptions(
				parseArgs(["--model", `${override.provider}/${override.id}`, "--prewalk-into", target]),
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);

			expect(options.model?.id).toBe(override.id);
			expect(options.prewalk?.target.id).toBe(original.id);
			expect(options.prewalk?.thinkingLevel).toBe("off");
		},
	);

	test("an explicit prewalk thinking suffix overrides the pre-model default thinking", async () => {
		const original = getBundledModel("anthropic", "claude-sonnet-4-5");
		const override = getBundledModel("openai", "gpt-4o");
		if (!original || !override) throw new Error("expected bundled prewalk models");
		const settings = Settings.isolated();
		settings.setModelRole("default", `${original.provider}/${original.id}:high`);
		authStorage.keys.setRuntime(original.provider, "test-key");
		authStorage.keys.setRuntime(override.provider, "test-key");

		const options = await buildSessionOptions(
			parseArgs(["--model", `${override.provider}/${override.id}`, "--prewalk-into", "@default:off"]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.prewalk?.target.id).toBe(original.id);
		expect(options.prewalk?.thinkingLevel).toBe("off");
	});
});
