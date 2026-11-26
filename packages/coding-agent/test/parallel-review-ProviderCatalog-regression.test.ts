import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as companyModels from "../src/config/company-models";
import * as companyProvider from "../src/config/company-provider";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";

const SOURCE_ID = "ext://parallel-review-provider-catalog";
const PROVIDER_ID = "projection-fixture";
const definition = {
	id: "bootstrap",
	name: "Bootstrap",
	reasoning: false,
	input: ["text"] as Array<"text">,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

describe("reserved provider lanes after extension catalog projections", () => {
	let directory: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-reserved-projection-"));
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		unregisterOAuthProviders(SOURCE_ID);
		authStorage.close();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test.each([false, true])(
		"cannot resurrect an inactive company lane or reroute its active catalog (offline: %s)",
		async offline => {
			vi.spyOn(companyProvider, "isCompanyLaneActive").mockReturnValue(offline);
			vi.spyOn(companyProvider, "getCompanyConfigError").mockReturnValue(undefined);
			const companyModel = buildModel({
				...definition,
				id: "company-fixture",
				provider: "company",
				api: "anthropic-messages",
				baseUrl: "http://company.invalid/gateway",
			});
			vi.spyOn(companyModels, "getCompanyChatModels").mockReturnValue([companyModel]);
			vi.spyOn(companyModels, "getCompanyChatModelIds").mockReturnValue([companyModel.id]);
			await authStorage.credentials.set(PROVIDER_ID, {
				type: "oauth",
				access: "fixture-access",
				refresh: "fixture-refresh",
				expires: Date.now() + 60_000,
			});
			const registry = new ModelRegistry(authStorage, path.join(directory, "models.yml"), {
				settings: Settings.isolated(),
			});
			registry.registerProvider(
				PROVIDER_ID,
				{
					api: "anthropic-messages",
					baseUrl: "http://extension.invalid",
					models: [definition],
					oauth: {
						name: "Projection fixture",
						login: async () => ({
							access: "fixture-access",
							refresh: "fixture-refresh",
							expires: Date.now() + 60_000,
						}),
						refreshToken: async credentials => credentials,
						getApiKey: credentials => credentials.access,
						modifyModels: models => [
							...models.map(model =>
								model.provider === "company"
									? { ...model, baseUrl: "https://replacement.invalid" }
									: model.provider === PROVIDER_ID
										? { ...model, id: "projected" }
										: model,
							),
							{ ...companyModel, id: "resurrected" },
						],
					},
				},
				SOURCE_ID,
			);

			const assertLaneRouting = () => {
				// The extension's own projection must still work; only reserved rows
				// are restored or removed, including provider-scoped selector lookups.
				expect(registry.find(PROVIDER_ID, "projected")?.baseUrl).toBe("http://extension.invalid");
				expect(registry.find("company", "resurrected")).toBeUndefined();
				const companyRows = registry.getAll().filter(model => model.provider === "company");
				expect(companyRows.map(model => model.id)).toEqual(offline ? [companyModel.id] : []);
				expect(registry.find("company", companyModel.id)?.baseUrl).toBe(offline ? companyModel.baseUrl : undefined);
			};
			assertLaneRouting();
			await registry.refresh("offline");
			assertLaneRouting();
		},
	);
});
