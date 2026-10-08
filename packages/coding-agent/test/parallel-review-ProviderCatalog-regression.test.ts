import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import * as companyModels from "../src/config/company-models";
import * as companyProvider from "../src/config/company-provider";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { getZcodeApiModels } from "../src/config/zcode-api-models";
import { AuthStorage } from "../src/session/auth-storage";

const SOURCE_ID = "ext://parallel-review-provider-catalog";
const PROVIDER_ID = "reserved-projection-fixture";

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
		"cannot resurrect an inactive lane or reroute its active sibling (offline: %s)",
		async offline => {
			vi.spyOn(companyProvider, "isCompanyLaneActive").mockReturnValue(offline);
			vi.spyOn(companyProvider, "getCompanyConfigError").mockReturnValue(undefined);
			const company = seedModels<"anthropic-messages">("company").map(spec =>
				buildModel({ ...spec, baseUrl: "http://company.invalid/gateway", contextWindow: 200_000 }),
			);
			vi.spyOn(companyModels, "getCompanyChatModels").mockReturnValue(company);
			vi.spyOn(companyModels, "getCompanyChatModelIds").mockReturnValue(company.map(model => model.id));
			const proxy = getZcodeApiModels();
			const active = offline ? company[0]! : proxy[0]!;
			const inactive = offline ? proxy[0]! : company[0]!;
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
					models: [
						{
							id: "bootstrap",
							name: "Bootstrap",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
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
								model.provider === active.provider
									? { ...model, baseUrl: "https://replacement.invalid" }
									: model.provider === PROVIDER_ID
										? { ...model, id: "projected" }
										: model,
							),
							{ ...inactive, id: "resurrected" },
						],
					},
				},
				SOURCE_ID,
			);

			const assertLaneRouting = () => {
				// The extension's own projection must still work; only reserved rows
				// are restored or removed, including provider-scoped selector lookups.
				expect(registry.find(PROVIDER_ID, "projected")?.baseUrl).toBe("http://extension.invalid");
				expect(registry.find(inactive.provider, "resurrected")).toBeUndefined();
				expect(registry.getAll().some(model => model.provider === inactive.provider)).toBe(false);
				expect(registry.find(active.provider, active.id)?.baseUrl).toBe(active.baseUrl);
			};
			assertLaneRouting();
			await registry.refresh("offline");
			assertLaneRouting();
		},
	);
});
