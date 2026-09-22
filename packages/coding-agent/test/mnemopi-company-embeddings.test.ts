import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const embeddingsModulePath = join(import.meta.dir, "../src/mnemopi/company-embeddings.ts");
const companyProviderModulePath = join(import.meta.dir, "../src/config/company-provider.ts");
const settingsModulePath = join(import.meta.dir, "../src/config/settings.ts");
const mnemopiConfigModulePath = join(import.meta.dir, "../src/mnemopi/config.ts");

interface ProbeResult {
	noCompanyLane: unknown;
	defaults: unknown;
	defaultsModel: unknown;
	defaultsUrl: unknown;
	defaultsToken: unknown;
	explicitApiUrl: unknown;
	explicitApiKey: unknown;
	envApiUrl: unknown;
	envApiKey: unknown;
	envModelForeign: unknown;
	configuredVariant: unknown;
	configuredModelForeign: unknown;
	configuredModelCompany: unknown;
	configuredModelCompanyModel: unknown;
	wiredModel: unknown;
	wiredUrl: unknown;
	wiredToken: unknown;
	wiredExplicitUrl: unknown;
	wiredExplicitToken: unknown;
}

// Separate process: the company snapshot is captured eagerly per process from
// CLAUDE_CONFIG_DIR, so in-process calls would race the host's real Claude
// credentials (same isolation rationale as company-provider.test.ts). All
// priority branches are exercised inside the single child against one fixture
// snapshot; env vars are read at call time, settings are built per case.
function runEmbeddingProbe(): ProbeResult {
	const home = mkdtempSync(join(tmpdir(), "company-embeddings-"));
	const claudeConfigDir = join(home, ".claude");
	try {
		mkdirSync(claudeConfigDir, { recursive: true });
		writeFileSync(
			join(claudeConfigDir, "settings.json"),
			JSON.stringify({
				env: {
					ANTHROPIC_BASE_URL: "http://internal.invalid/gateway/v1/",
					ANTHROPIC_AUTH_TOKEN: "fixture-secret",
				},
			}),
		);
		const child = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`
				const { setCompanyOfflineEnabled, getCompanyConfig } = await import(${JSON.stringify(companyProviderModulePath)});
				const { getCompanyEmbeddingDefaults } = await import(${JSON.stringify(embeddingsModulePath)});
				const { Settings } = await import(${JSON.stringify(settingsModulePath)});

				// A developer machine may export MNEMOPI_EMBEDDING_*; the baseline
				// branches below require a clean slate.
				delete process.env.MNEMOPI_EMBEDDING_MODEL;
				delete process.env.MNEMOPI_EMBEDDING_API_URL;
				delete process.env.MNEMOPI_EMBEDDING_API_KEY;

				const tokenOf = async defaults => {
					if (!defaults || !defaults.embeddingApiKey) return null;
					const value = defaults.embeddingApiKey();
					return value instanceof Promise ? await value : value;
				};

				// Lane off: the company provider must not surface defaults at all.
				const noCompanyLane = getCompanyEmbeddingDefaults(Settings.isolated({}));

				setCompanyOfflineEnabled(true);
				const defaults = getCompanyEmbeddingDefaults(Settings.isolated({}));

				// An explicit embedding URL must yield undefined: company credentials
				// are never allowed to flow to a user-configured address.
				const explicitApiUrl = getCompanyEmbeddingDefaults(
					Settings.isolated({ "mnemopi.embeddingApiUrl": "http://other.invalid/embed" }),
				);
				const explicitApiKey = getCompanyEmbeddingDefaults(
					Settings.isolated({ "mnemopi.embeddingApiKey": "explicit-key" }),
				);

				process.env.MNEMOPI_EMBEDDING_API_URL = "http://env.invalid/embed";
				const envApiUrl = getCompanyEmbeddingDefaults(Settings.isolated({}));
				delete process.env.MNEMOPI_EMBEDDING_API_URL;
				process.env.MNEMOPI_EMBEDDING_API_KEY = "env-key";
				const envApiKey = getCompanyEmbeddingDefaults(Settings.isolated({}));
				delete process.env.MNEMOPI_EMBEDDING_API_KEY;
				process.env.MNEMOPI_EMBEDDING_MODEL = "openai/text-embedding-3-small";
				const envModelForeign = getCompanyEmbeddingDefaults(Settings.isolated({}));
				delete process.env.MNEMOPI_EMBEDDING_MODEL;

				// Only an explicitly configured variant keeps its user choice; the
				// schema default (multilingual, absent here) yields to the company lane.
				const configuredVariant = getCompanyEmbeddingDefaults(
					Settings.isolated({ "mnemopi.embeddingVariant": "en" }),
				);
				const configuredModelForeign = getCompanyEmbeddingDefaults(
					Settings.isolated({ "mnemopi.embeddingModel": "openai/text-embedding-3-small" }),
				);
				const configuredModelCompany = getCompanyEmbeddingDefaults(
					Settings.isolated({ "mnemopi.embeddingModel": "Qwen3-VL-Embedding-2B" }),
				);

				// The consumption site: loadMnemopiConfig must actually spread the
				// company defaults into providerOptions — an upstream rewrite dropping
				// the spread in mnemopi/config.ts would otherwise keep the priority
				// function green while the real startup path loses the contract.
				const { loadMnemopiConfig } = await import(${JSON.stringify(mnemopiConfigModulePath)});
				const wired = loadMnemopiConfig(Settings.isolated({ "mnemopi.scoping": "global" }), ${JSON.stringify(home)});
				const wiredExplicitUrl = loadMnemopiConfig(
					Settings.isolated({
						"mnemopi.scoping": "global",
						"mnemopi.embeddingApiUrl": "http://other.invalid/embed",
					}),
					${JSON.stringify(home)},
				);

				console.log(JSON.stringify({
					noCompanyLane,
					defaults,
					defaultsModel: defaults?.embeddingModel,
					defaultsUrl: defaults?.embeddingApiUrl,
					defaultsToken: await tokenOf(defaults),
					explicitApiUrl,
					explicitApiKey,
					envApiUrl,
					envApiKey,
					envModelForeign,
					configuredVariant,
					configuredModelForeign,
					configuredModelCompany,
					configuredModelCompanyModel: configuredModelCompany?.embeddingModel,
					wiredModel: wired.providerOptions.embeddingModel,
					wiredUrl: wired.providerOptions.embeddingApiUrl,
					wiredToken: await tokenOf(wired.providerOptions),
					wiredExplicitUrl: wiredExplicitUrl.providerOptions.embeddingApiUrl,
					wiredExplicitToken: wiredExplicitUrl.providerOptions.embeddingApiKey === undefined
						? null
						: await tokenOf(wiredExplicitUrl.providerOptions),
				}));
				`,
			],
			{
				env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeConfigDir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (child.exitCode !== 0) throw new Error(child.stderr.toString());
		return JSON.parse(child.stdout.toString());
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

describe("company embedding defaults priority", () => {
	test("applies the company lane only without explicit embedding configuration", () => {
		const result = runEmbeddingProbe();

		expect(result.noCompanyLane).toBeUndefined();

		// Default: company retrieval model at the company gateway, company token.
		expect(result.defaultsModel).toBe("Qwen3-VL-Embedding-2B");
		expect(result.defaultsUrl).toBe("http://internal.invalid/gateway/v1");
		expect(result.defaultsToken).toBe("fixture-secret");

		// Every explicit embedding setup wins and receives no company defaults —
		// in particular the company token must never target another URL.
		expect(result.explicitApiUrl).toBeUndefined();
		expect(result.explicitApiKey).toBeUndefined();
		expect(result.envApiUrl).toBeUndefined();
		expect(result.envApiKey).toBeUndefined();
		expect(result.envModelForeign).toBeUndefined();
		expect(result.configuredVariant).toBeUndefined();
		expect(result.configuredModelForeign).toBeUndefined();

		// An explicit model inside the company retrieval catalog still rides the
		// company lane with that model.
		expect(result.configuredModelCompany).not.toBeNull();
		expect(result.configuredModelCompanyModel).toBe("Qwen3-VL-Embedding-2B");

		// Wiring: the resolved mnemonic config carries the company defaults, and
		// an explicit URL keeps the explicit value with no company credentials.
		expect(result.wiredModel).toBe("Qwen3-VL-Embedding-2B");
		expect(result.wiredUrl).toBe("http://internal.invalid/gateway/v1");
		expect(result.wiredToken).toBe("fixture-secret");
		expect(result.wiredExplicitUrl).toBe("http://other.invalid/embed");
		expect(result.wiredExplicitToken).toBeNull();
	});
});
