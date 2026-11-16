import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { type ModelKind, modelKind } from "@oh-my-pi/pi-catalog/types";
import { selectorCandidates, stdioModelResolver } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-stdio";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");

const fast = getBundledModel("google", "gemini-3.5-flash")!;
const mini = getBundledModel("openai", "gpt-4o-mini")!;
const vertex = getBundledModel("google-vertex", "gemini-3.5-flash")!;
const models = [fast, mini, vertex];
const registry = { getAll: () => models, getAvailable: () => models };
const key = (model: typeof fast) => `${model.provider}/${model.id}`;

describe("auth-gateway stdio model selectors", () => {
	it("skips comma entries that resolve to nothing and follows the chosen role's fallback chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [key(vertex), key(fast)] } });
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@commit,@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("uses a role-keyed chain when the role has no configured primary", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	// A retry must never move to a model the user did not select: a role's
	// built-in priority list would retry on any logged-in provider.
	it("never falls back to a role's built-in priority models", () => {
		const settings = Settings.isolated({});
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast]);
		settings.setModelRole("smol", key(vertex));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([vertex]);
	});

	it("uses the inherited default chain for a role without its own chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { default: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("keeps an explicitly empty role chain from inheriting the default chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [], default: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast]);
	});

	it("keeps model-keyed chains ahead of configured role chains", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(fast)]: [key(vertex)] } });
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
		cfgRetryFallbackChains.set(settings, { smol: [key(mini)], [key(fast)]: [key(vertex)] });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("follows model-keyed chains even when the role primary comes from its defaults", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(fast)]: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("expands role fallbacks transitively without retrying a model in a cycle", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				smol: [key(vertex)],
				[key(vertex)]: [key(mini), key(fast)],
				[key(mini)]: [key(vertex)],
			},
		});
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex, mini]);
	});

	it("does not add role defaults when model fallback is disabled", () => {
		const settings = Settings.isolated({ "retry.modelFallback": false });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast]);
	});

	it("does not add role defaults to an explicit model selector", () => {
		expect(selectorCandidates(key(fast), Settings.isolated({}), registry)).toEqual([fast]);
	});

	it("follows a concrete model's own chain and stops at the first resolvable entry", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(mini)]: [key(vertex)] } });
		expect(selectorCandidates(`${key(mini)},${key(fast)}`, settings, registry)).toEqual([mini, vertex]);
	});

	it("offers nothing when no entry resolves", () => {
		expect(selectorCandidates("@commit", Settings.isolated({}), registry)).toEqual([]);
	});

	describe("on a judge route", () => {
		const jev = getBundledModel("typesafe", "jev-1.14.0")!;
		const catalog = [...models, jev];
		const byKind = (kind: ModelKind | "all" = "chat") =>
			kind === "all" ? catalog : catalog.filter(model => modelKind(model) === kind);
		const kinded = { getAll: byKind, getAvailable: byKind };

		it("resolves a judge model id and the judge role to the judge runner", () => {
			const settings = Settings.isolated({});
			expect(selectorCandidates(key(jev), settings, kinded, "judge")).toEqual([jev]);
			expect(selectorCandidates("@judge", settings, kinded, "judge")).toEqual([jev]);
		});

		it("keeps judge models out of chat routes", () => {
			expect(selectorCandidates(key(jev), Settings.isolated({}), kinded)).toEqual([]);
		});
	});
});

describe("auth-gateway stdio model resolver", () => {
	// A video job id is stateless: a fresh process must poll it without having submitted it.
	it("resolves an unrouted id only to the available video model it names", () => {
		const video = getBundledModel("openrouter", "alibaba/wan-2.6")!;
		const catalog = [fast, video];
		const resolve = stdioModelResolver(new Map(), {
			getAvailable: (kind: ModelKind | "all" = "chat") => catalog.filter(model => modelKind(model) === kind),
		});
		expect(resolve(key(video))).toBe(video);
		expect(resolve(key(fast))).toBeUndefined();
	});
});

describe("auth-gateway stdio credentials", () => {
	it.each([
		{ source: "company snapshot", provider: "company", modelId: "GLM-5.2-public", offline: true },
		{ source: "local custom provider", provider: "stdio-custom", modelId: "fixture", offline: false },
	])(
		"serves $source credentials and rejects missing credentials",
		async ({ provider, modelId, offline }) => {
			await using home = await TempDir.create("@omp-gw-stdio-auth-");
			const requests: Array<{ path: string; authorization: string | null; apiKey: string | null; model: string }> =
				[];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const body = (await request.json()) as { model: string };
					requests.push({
						path: new URL(request.url).pathname,
						authorization: request.headers.get("authorization"),
						apiKey: request.headers.get("x-api-key"),
						model: body.model,
					});
					const events = [
						{
							type: "message_start",
							message: {
								id: "stdio-fixture",
								type: "message",
								role: "assistant",
								model: body.model,
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 5, output_tokens: 0 },
							},
						},
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
						{ type: "content_block_stop", index: 0 },
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 1 },
						},
						{ type: "message_stop" },
					];
					return new Response(
						events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				},
			});
			try {
				const agentDir = home.join("agent");
				const claudeDir = home.join("claude");
				await Promise.all([mkdir(agentDir), mkdir(claudeDir)]);
				const configPath = home.join("config.yml");
				await Bun.write(
					configPath,
					JSON.stringify({
						disabledProviders: [
							...getBundledProviders().filter(id => id !== provider),
							"ollama",
							"llama.cpp",
							"lm-studio",
							"apple",
							"codeagent",
						],
					}),
				);
				const customModel = {
					id: "fixture",
					name: "Fixture",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 4096,
					maxTokens: 128,
				};
				await Bun.write(
					path.join(agentDir, "models.yml"),
					JSON.stringify({
						providers: {
							"stdio-custom": {
								api: "anthropic-messages",
								baseUrl: server.url.origin,
								apiKey: "fixture-token",
								models: [customModel],
							},
							"stdio-missing": {
								api: "anthropic-messages",
								baseUrl: server.url.origin,
								// Configured credential commands register the model even when no token is returned.
								apiKey: "!exit 0",
								models: [customModel],
							},
						},
					}),
				);
				if (offline) {
					await Bun.write(
						path.join(claudeDir, "settings.json"),
						JSON.stringify({
							env: { ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_AUTH_TOKEN: "fixture-token" },
						}),
					);
				}
				const selector = `${provider}/${modelId}`;
				const frames = [
					{ id: "models", path: "/v1/models" },
					...[selector, "stdio-missing/fixture"].map(model => ({
						id: model,
						path: "/v1/chat/completions",
						body: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 16 },
					})),
				];
				const child = Bun.spawn([process.execPath, cliEntry, "auth-gateway", "stdio"], {
					cwd: home.path(),
					env: {
						PATH: process.env.PATH ?? "",
						SystemRoot: process.env.SystemRoot ?? "",
						HOME: home.path(),
						USERPROFILE: home.path(),
						OMP_CONFIG_ROOT: home.join(".omp"),
						PI_CODING_AGENT_DIR: agentDir,
						PI_CONFIG_FILES: configPath,
						CLAUDE_CONFIG_DIR: claudeDir,
						OMP_OFFLINE: offline ? "1" : "0",
						NO_COLOR: "1",
					},
					stdin: Buffer.from(`${frames.map(frame => JSON.stringify(frame)).join("\n")}\n`),
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(await child.exited, stderr).toBe(0);
				const output: unknown[] = stdout
					.trim()
					.split("\n")
					.map(line => JSON.parse(line));
				expect(output).toContainEqual(
					expect.objectContaining({
						id: "models",
						status: 200,
						body: expect.objectContaining({
							data: expect.arrayContaining([
								expect.objectContaining({ id: selector }),
								expect.objectContaining({ id: "stdio-missing/fixture" }),
							]),
						}),
					}),
				);
				expect(output).toContainEqual(
					expect.objectContaining({
						id: selector,
						status: 200,
						body: expect.objectContaining({
							choices: [
								expect.objectContaining({
									message: expect.objectContaining({ role: "assistant", content: "ok" }),
								}),
							],
						}),
					}),
				);
				expect(output).toContainEqual(
					expect.objectContaining({
						id: "stdio-missing/fixture",
						status: 401,
						body: { error: expect.objectContaining({ type: "authentication_error" }) },
					}),
				);
				expect(requests).toEqual([
					{
						path: "/v1/messages",
						authorization: "Bearer fixture-token",
						apiKey: null,
						model: modelId,
					},
				]);
			} finally {
				await server.stop(true);
			}
		},
		30_000,
	);
});

describe.skipIf(process.platform === "win32")("auth-gateway stdio process", () => {
	// Responses used to be cut off at 128 KiB when stdin ended before the reader caught up.
	it("delivers a response larger than the pipe buffer whole after its input ends", async () => {
		using agentDir = TempDir.createSync("@omp-gw-stdio-");
		const id = "x".repeat(300_000);
		const requestPath = agentDir.join("request.jsonl");
		await Bun.write(requestPath, `${JSON.stringify({ id, path: "/v1/unknown" })}\n`);
		// `sleep` keeps the reply unread until the gateway has had time to quit; nothing it emits marks that.
		const script = `"${process.execPath}" "${cliEntry}" auth-gateway stdio < "${requestPath}" | (sleep 3; cat)`;
		const proc = Bun.spawn(["bash", "-c", script], {
			cwd: agentDir.path(),
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir.path() },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const output = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		const lines = output.trim().split("\n");
		expect(JSON.parse(lines.at(-1)!).id).toBe(id);
	}, 30_000);
});
