import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = getAgentDir();
const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;

let tempDir: TempDir;
let authStorage: AuthStorage;

describe("ModelRegistry default custom models config", () => {
	beforeEach(async () => {
		tempDir = TempDir.createSync("@model-registry-default-config-");
		setAgentDir(tempDir.path());
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(async () => {
		authStorage.close();
		// The registry's shared models.db lives in the temp agent dir; Windows
		// keeps its file and directory handles locked until it is closed.
		closeModelCache();
		setAgentDir(originalAgentDir);
		if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		await tempDir.remove().catch(() => {});
	});

	test("loads custom provider models from default models.yaml when models.yml is absent", () => {
		writeModelsYaml("models.yaml", {
			provider: "deepseek",
			modelId: "yaml-model",
			modelName: "YAML default model",
			baseUrl: "https://yaml-default.example.com/v1",
		});

		const [model] = loadDefaultRegistryModels({
			provider: "deepseek",
			modelId: "yaml-model",
		});

		expect(model?.name).toBe("YAML default model");
		expect(model?.baseUrl).toBe("https://yaml-default.example.com/v1");
	});

	test.each(["null", "{apiKey: 7}", "{models: [{id: forbidden-model}]}"])(
		"ignores reserved codeagent input %s without dropping unrelated models",
		codeagent => {
			writeModelsYaml("models.yml", {
				provider: "deepseek",
				modelId: "kept-model",
				modelName: "Kept model",
				baseUrl: "https://unrelated.invalid/v1",
			});
			fs.appendFileSync(path.join(tempDir.path(), "models.yml"), `  codeagent: ${codeagent}\n`);

			const registry = new ModelRegistry(authStorage);

			expect(registry.getError()).toBeUndefined();
			expect(registry.find("deepseek", "kept-model")?.baseUrl).toBe("https://unrelated.invalid/v1");
			expect(registry.find("codeagent", "forbidden-model")).toBeUndefined();
			expect(registry.getReservedProviderWarnings().some(warning => warning.includes("providers.codeagent"))).toBe(
				true,
			);
		},
	);

	test("retains STB decoder metadata on a renamed custom provider", () => {
		writeModelsYaml("models.yml", {
			provider: "deepseek",
			modelId: "local-vision",
			modelName: "Local vision",
			baseUrl: "http://127.0.0.1:8080/v1",
			imageInputDecoder: "stb",
		});

		const [model] = loadDefaultRegistryModels({ provider: "deepseek", modelId: "local-vision" });

		expect(model?.imageInputDecoder).toBe("stb");
	});

	test("prefers default models.yml over models.yaml when both exist", () => {
		writeModelsYaml("models.yml", {
			provider: "deepseek",
			modelId: "from-yml",
			modelName: "YML winner",
			baseUrl: "https://yml-winner.example.com/v1",
		});
		writeModelsYaml("models.yaml", {
			provider: "deepseek",
			modelId: "from-yaml",
			modelName: "YAML loser",
			baseUrl: "https://yaml-loser.example.com/v1",
		});

		const [ymlModel, yamlModel] = loadDefaultRegistryModels(
			{ provider: "deepseek", modelId: "from-yml" },
			{ provider: "deepseek", modelId: "from-yaml" },
		);

		expect(ymlModel?.baseUrl).toBe("https://yml-winner.example.com/v1");
		expect(yamlModel).toBeUndefined();
	});

	test("prefers default models.yaml over legacy models.json when models.yml is absent", () => {
		writeModelsYaml("models.yaml", {
			provider: "deepseek",
			modelId: "from-yaml",
			modelName: "YAML winner over JSON",
			baseUrl: "https://yaml-over-json.example.com/v1",
		});
		writeModelsJson({
			provider: "deepseek",
			modelId: "from-json",
			modelName: "JSON loser",
			baseUrl: "https://json-loser.example.com/v1",
		});

		const [yamlModel, jsonModel] = loadDefaultRegistryModels(
			{ provider: "deepseek", modelId: "from-yaml" },
			{ provider: "deepseek", modelId: "from-json" },
		);

		expect(yamlModel?.baseUrl).toBe("https://yaml-over-json.example.com/v1");
		expect(jsonModel).toBeUndefined();
	});
});

interface ProviderFixture {
	provider: string;
	modelId: string;
	modelName: string;
	baseUrl: string;
	imageInputDecoder?: "stb";
}

interface ModelLookup {
	provider: string;
	modelId: string;
}

interface ModelSnapshot {
	provider: string;
	id: string;
	name: string;
	baseUrl: string | undefined;
	imageInputDecoder?: "stb";
	compat: {
		promptCacheMode: string;
		supportsLongPromptCacheRetention: boolean;
		promptCacheMinimumTokens: number;
		promptCacheMaximumCheckpoints: number;
		supportsForcedToolChoice?: boolean;
		streamIdleTimeoutMs?: number;
		streamRevision?: "possible";
		supportsSamplingParams?: boolean;
		supportsThinkingBindingControls?: boolean;
	};
}

function writeModelsYaml(file: "models.yml" | "models.yaml", fixture: ProviderFixture): void {
	const decoderLine = fixture.imageInputDecoder
		? `        imageInputDecoder: ${fixture.imageInputDecoder}`
		: undefined;
	fs.writeFileSync(
		path.join(tempDir.path(), file),
		[
			"providers:",
			`  ${fixture.provider}:`,
			`    baseUrl: ${fixture.baseUrl}`,
			"    apiKey: TEST_KEY",
			"    api: anthropic-messages",
			"    models:",
			`      - id: ${fixture.modelId}`,
			`        name: ${fixture.modelName}`,
			"        reasoning: false",
			fixture.imageInputDecoder ? "        input: [text, image]" : "        input: [text]",
			...(decoderLine ? [decoderLine] : []),
			"        cost:",
			"          input: 0",
			"          output: 0",
			"          cacheRead: 0",
			"          cacheWrite: 0",
			"        contextWindow: 100000",
			"        maxTokens: 8000",
			"",
		].join("\n"),
	);
}

function writeModelsJson(fixture: ProviderFixture): void {
	fs.writeFileSync(
		path.join(tempDir.path(), "models.json"),
		JSON.stringify({
			providers: {
				[fixture.provider]: {
					baseUrl: fixture.baseUrl,
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					models: [
						{
							id: fixture.modelId,
							name: fixture.modelName,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 8000,
						},
					],
				},
			},
		}),
	);
}

function loadDefaultRegistryModels(...lookups: ModelLookup[]): Array<ModelSnapshot | undefined> {
	const registry = new ModelRegistry(authStorage);
	return lookups.map(lookup => {
		const model = registry.find(lookup.provider, lookup.modelId);
		if (!model) return undefined;
		return {
			provider: model.provider,
			id: model.id,
			name: model.name,
			baseUrl: model.baseUrl,
			imageInputDecoder: model.imageInputDecoder,
			compat: model.compat as ModelSnapshot["compat"],
		};
	});
}
