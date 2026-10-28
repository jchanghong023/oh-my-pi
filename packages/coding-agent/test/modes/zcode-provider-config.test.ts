import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ZCodeProviderConfiguration } from "../../src/modes/zcode/provider-config";
import { AuthStorage } from "../../src/session/auth-storage";

const directories: string[] = [];
const authStores: AuthStorage[] = [];
afterEach(async () => {
	for (const auth of authStores.splice(0)) auth.close();
	await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture(baseUrl = "http://localhost:1234/v1") {
	const dir = await mkdtemp(join(tmpdir(), "omp-zcode-provider-"));
	directories.push(dir);
	const modelsPath = join(dir, "models.yml");
	await writeFile(
		modelsPath,
		`providers:\n  local-test:\n    baseUrl: ${baseUrl}\n    apiKey: secret-one\n    api: openai-completions\n    models:\n      - id: model-a\n        reasoning: false\n`,
	);
	const settings = Settings.isolated();
	const auth = await AuthStorage.create(":memory:");
	authStores.push(auth);
	const modelRegistry = new ModelRegistry(auth, modelsPath, { settings });
	return { cwd: dir, dir, modelsPath, settings, modelRegistry };
}

function connectivityServer(mode: "success" | "unauthorized" | "empty" = "success") {
	let contacted = false;
	let authorization: string | null = null;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			contacted = true;
			authorization = request.headers.get("authorization");
			await request.json();
			if (mode === "unauthorized" || authorization !== "Bearer secret-one") {
				return Response.json(
					{ error: { message: "Invalid test API key", type: "authentication_error" } },
					{ status: 401 },
				);
			}
			const chunks = [
				{
					id: "connectivity",
					object: "chat.completion.chunk",
					model: "model-a",
					choices: [
						{
							index: 0,
							delta: { role: "assistant", content: mode === "empty" ? "" : "OK" },
							finish_reason: null,
						},
					],
				},
				{
					id: "connectivity",
					object: "chat.completion.chunk",
					model: "model-a",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
			];
			return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	return {
		server,
		get contacted() {
			return contacted;
		},
		get authorization() {
			return authorization;
		},
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
	};
}

describe("ZCode provider configuration consumer", () => {
	test("connectivity executes the native workspace model without changing configuration", async () => {
		const endpoint = connectivityServer();
		const f = await fixture(endpoint.baseUrl);
		const other = await fixture();
		try {
			const config = new ZCodeProviderConfiguration({ records: () => [other, f] });
			const before = await readFile(f.modelsPath, "utf8");
			const model = f.modelRegistry.find("local-test", "model-a");
			const role = f.settings.getModelRole("default");
			expect(model).toBeDefined();
			expect(
				await config.testModelConnectivity({
					workspace: { workspacePath: f.dir, workspaceKey: "fixture" },
					selection: { providerId: "local-test", modelId: "model-a" },
				}),
			).toEqual({ success: true });
			expect(endpoint.authorization).toBe("Bearer secret-one");
			expect(f.modelRegistry.find("local-test", "model-a")).toBe(model);
			expect(f.settings.getModelRole("default")).toBe(role);
			expect(await readFile(f.modelsPath, "utf8")).toBe(before);
			expect(await f.modelRegistry.getApiKey(model!)).toBe("secret-one");
		} finally {
			await endpoint.server.stop(true);
		}
	});

	for (const mode of ["unauthorized", "empty"] as const) {
		test(`connectivity rejects ${mode} HTTP completions`, async () => {
			const endpoint = connectivityServer(mode);
			const f = await fixture(endpoint.baseUrl);
			try {
				const config = new ZCodeProviderConfiguration({ records: () => [f] });
				await expect(
					config.testModelConnectivity({
						workspace: { workspacePath: f.dir, workspaceKey: "fixture" },
						selection: { providerId: "local-test", modelId: "model-a" },
					}),
				).rejects.toThrow(mode === "empty" ? "no completion text" : "Invalid test API key");
			} finally {
				await endpoint.server.stop(true);
			}
		});
	}

	test("unknown models, invalid parameters and cancellation never issue a completion", async () => {
		const endpoint = connectivityServer();
		const f = await fixture(endpoint.baseUrl);
		try {
			const config = new ZCodeProviderConfiguration({ records: () => [f] });
			const params = {
				workspace: { workspacePath: f.dir, workspaceKey: "fixture" },
				selection: { providerId: "local-test", modelId: "missing" },
			};
			await expect(config.testModelConnectivity(params)).rejects.toThrow("Unknown model");
			await expect(config.testModelConnectivity({ ...params, extra: true })).rejects.toThrow();
			const controller = new AbortController();
			controller.abort(new Error("test cancelled"));
			await expect(config.testModelConnectivity(params, controller.signal)).rejects.toThrow("test cancelled");
			expect(endpoint.contacted).toBe(false);
		} finally {
			await endpoint.server.stop(true);
		}
	});

	test("connectivity rejects unreachable native endpoints", async () => {
		const endpoint = connectivityServer();
		await endpoint.server.stop(true);
		const f = await fixture(endpoint.baseUrl);
		const config = new ZCodeProviderConfiguration({ records: () => [f] });
		await expect(
			config.testModelConnectivity({
				workspace: { workspacePath: f.dir, workspaceKey: "fixture" },
				selection: { providerId: "local-test", modelId: "model-a" },
			}),
		).rejects.toThrow();
	});

	test("cancellation stops an in-flight native connectivity request", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch() {
				started.resolve();
				await release.promise;
				return new Response();
			},
		});
		const f = await fixture(`http://127.0.0.1:${server.port}/v1`);
		const controller = new AbortController();
		try {
			const config = new ZCodeProviderConfiguration({ records: () => [f] });
			const result = config.testModelConnectivity(
				{
					workspace: { workspacePath: f.dir, workspaceKey: "fixture" },
					selection: { providerId: "local-test", modelId: "model-a" },
				},
				controller.signal,
			);
			const settled = Promise.allSettled([result]);
			await started.promise;
			controller.abort(new Error("test cancelled"));
			const [outcome] = await settled;
			expect(outcome?.status).toBe("rejected");
			if (outcome?.status !== "rejected") throw new Error("Cancelled completion unexpectedly succeeded");
			expect(outcome.reason.message).toContain("test cancelled");
		} finally {
			release.resolve();
			controller.abort();
			await server.stop(true);
		}
	});

	test("workspace templates and callbacks do not modify a different workspace", async () => {
		const f = await fixture();
		const calls: string[] = [];
		const config = new ZCodeProviderConfiguration({
			applyInteractionPreferences: (cwd, enabled) => {
				calls.push(`${cwd}:${enabled}`);
				return 2;
			},
			applyModelIoPreferences: () => 1,
		});
		const workspace = { workspacePath: f.dir, workspaceKey: "fixture" };
		const result = await config.updateInteractionPreferences({
			workspace,
			preferences: { askUserQuestionAutoResolutionEnabled: false },
		});
		expect(result.snoozedInteractionCount).toBe(2);
		expect(config.getWorkspacePreferences(f.dir).askUserQuestionAutoResolutionEnabled).toBe(false);
		expect(config.getWorkspacePreferences(join(f.dir, "other")).askUserQuestionAutoResolutionEnabled).toBe(true);
		expect(calls).toHaveLength(1);
		expect(
			(await config.updateModelIoPreferences({ workspace, preferences: { fullRetentionEnabled: true } }))
				.updatedSessionCount,
		).toBe(1);
	});

	test("missing live consumer fails without committing a preference template", async () => {
		const f = await fixture();
		const config = new ZCodeProviderConfiguration({ records: () => [f] });
		await expect(
			config.updateModelIoPreferences({
				workspace: { workspacePath: f.dir, workspaceKey: "fixture" },
				preferences: { fullRetentionEnabled: true },
			}),
		).rejects.toThrow();
		expect(config.getWorkspacePreferences(f.dir).fullRetentionEnabled).toBe(false);
	});
});
