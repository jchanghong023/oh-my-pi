import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isolateDaemonForSmokeTest } from "@oh-my-pi/pi-coding-agent/daemon/client";
import { stripClaudeToolPrefix } from "../../ai/src/providers/anthropic-identity";

const CLI = path.join(import.meta.dir, "../src/cli.ts");
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(
	options: {
		companyUrl?: string;
		readUrl?: string;
		visionUrl?: string;
		modelRoles?: Record<string, string>;
		offline?: boolean;
	} = {},
) {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-offline-subcommands-"));
	tempDirs.push(home);
	const claudeDir = path.join(home, "claude");
	await fs.mkdir(claudeDir);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		SystemRoot: process.env.SystemRoot ?? "",
		HOME: home,
		USERPROFILE: home,
		OMP_CONFIG_ROOT: path.join(home, "config"),
		PI_CODING_AGENT_DIR: path.join(home, "agent"),
		OMP_COMMIT_CACHE_DB: path.join(home, "commit-inference.db"),
		PI_CONFIG_DIR: ".omp",
		CLAUDE_CONFIG_DIR: claudeDir,
		NO_COLOR: "1",
	};
	if (options.offline !== false) env.OMP_OFFLINE = "1";
	const agentDir = env.PI_CODING_AGENT_DIR!;
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const companyPath = path.join(claudeDir, "settings.json");
	const companyText = JSON.stringify({
		env: { ANTHROPIC_BASE_URL: options.companyUrl, ANTHROPIC_AUTH_TOKEN: "fixture-token" },
	});
	if (options.companyUrl) await fs.writeFile(companyPath, companyText);
	const image = path.join(home, "image.png");
	await fs.writeFile(image, Buffer.from(PNG_1X1, "base64"));
	const extension = path.join(home, "catalog-extension.ts");
	await fs.writeFile(
		extension,
		`
		export default function (pi) {
			pi.registerProvider("opencode-go", {
				api: "anthropic-messages", baseUrl: "http://discovery.invalid", apiKey: "fixture-key",
				fetchDynamicModels: async () => {
					process.stderr.write("UNEXPECTED_EXTENSION_DISCOVERY\\n");
					throw new Error("fixture forbids catalog discovery");
				},
			});
		}
	`,
	);
	const configPath = path.join(agentDir, "config.yml");
	const configText = JSON.stringify({
		extensions: [extension],
		images: { questionTimeoutMs: 5000 },
		...(options.modelRoles ? { modelRoles: options.modelRoles } : {}),
	});
	await fs.writeFile(configPath, configText);
	const modelsPath = path.join(agentDir, "models.yml");
	const modelsText = JSON.stringify({
		providers: {
			ascend: {
				api: "anthropic-messages",
				baseUrl: options.visionUrl,
				apiKey: "local-vision-key",
				models: [{ id: "vision", input: ["text", "image"] }],
			},
		},
	});
	if (options.visionUrl) await fs.writeFile(modelsPath, modelsText);
	const guard = path.join(home, "network-guard.ts");
	const requestUrl = options.visionUrl ?? options.companyUrl;
	const endpoint = requestUrl
		? `${requestUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/messages${options.visionUrl ? "?beta=true" : ""}`
		: undefined;
	await fs.writeFile(
		guard,
		`
		const original = globalThis.fetch.bind(globalThis);
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== ${JSON.stringify(endpoint)} && url !== ${JSON.stringify(options.readUrl)}) {
				process.stderr.write("UNEXPECTED_NETWORK_FETCH\\n");
				throw new Error("fixture forbids network discovery");
			}
			return original(input, init);
		};
	`,
	);
	return {
		home,
		env,
		agentDir,
		image,
		companyPath,
		companyText,
		configPath,
		configText,
		modelsPath,
		modelsText,
		async run(args: string[], entry = CLI, allowDiscovery = false) {
			const child = Bun.spawn([process.execPath, "--preload", guard, entry, ...args], {
				cwd: home,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (!allowDiscovery) {
				expect(stderr).not.toContain("UNEXPECTED_NETWORK_FETCH");
				expect(stderr).not.toContain("UNEXPECTED_EXTENSION_DISCOVERY");
			}
			return { stdout, stderr, exitCode };
		},
	};
}

async function stageCommitFixture(home: string, env: Record<string, string>): Promise<void> {
	await fs.writeFile(path.join(home, "source.ts"), "export const offlineFixture = true;\n");
	for (const args of [
		["init", "--initial-branch=main"],
		["config", "--local", "user.name", "Fixture"],
		["config", "--local", "user.email", "fixture@example.invalid"],
		["commit", "--allow-empty", "-m", "baseline"],
		["add", "source.ts"],
	]) {
		const child = Bun.spawn(["git", ...args], {
			cwd: home,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
	}
}

function anthropicResponse(
	model: string,
	text = "offline vision answer",
	toolCall?: { name: string; input: Record<string, unknown> },
): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "offline-read-fixture",
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: toolCall
				? { type: "tool_use", id: `fixture-${toolCall.name}`, name: toolCall.name, input: {} }
				: { type: "text", text: "" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: toolCall
				? { type: "input_json_delta", partial_json: JSON.stringify(toolCall.input) }
				: { type: "text_delta", text },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: toolCall ? "tool_use" : "end_turn", stop_sequence: null },
			usage: { output_tokens: 3 },
		},
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

function anthropicCommitResponse(body: {
	model: string;
	tools?: Array<{ name: string }>;
	messages?: Array<{ content: string | Array<{ type: string }> }>;
}): Response {
	const text = "# feat: added offline fixture\n\n- Added the offline fixture.";
	const proposalTool = body.tools?.find(tool => stripClaudeToolPrefix(tool.name) === "propose_commit");
	if (!proposalTool) return anthropicResponse(body.model, text);
	const hasToolResult = body.messages?.some(
		message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_result"),
	);
	return anthropicResponse(
		body.model,
		text,
		hasToolResult
			? undefined
			: {
					name: proposalTool.name,
					input: { type: "feat", scope: null, summary: "added offline fixture", details: [], issue_refs: [] },
				},
	);
}

it("offers AST Edit and fetches a URL in an offline CLI session with web search disabled", async () => {
	let offered: string[] | undefined;
	let toolResult: string | undefined;
	const expectedContent = "fixture content fetched by the agent";
	using server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname === "/page.txt") return new Response(expectedContent);
			const body = (await request.json()) as {
				model: string;
				tools?: Array<{ name: string }>;
				messages?: Array<{ content: string | Array<{ type: string; content?: unknown }> }>;
			};
			offered = body.tools?.map(tool => stripClaudeToolPrefix(tool.name));
			const result = body.messages
				?.flatMap(message => (typeof message.content === "string" ? [] : message.content))
				.find(block => block.type === "tool_result");
			if (result) {
				toolResult = JSON.stringify(result.content);
				return anthropicResponse(body.model, "offline URL read completed");
			}
			const read = body.tools?.find(tool => stripClaudeToolPrefix(tool.name) === "read");
			return anthropicResponse(
				body.model,
				"read tool unavailable",
				read && { name: read.name, input: { path: new URL("/page.txt", request.url).href } },
			);
		},
	});
	const f = await fixture({ companyUrl: server.url.href, readUrl: `${server.url.origin}/page.txt` });
	await Bun.write(f.configPath, JSON.stringify({ tools: { commands: false } }));
	const cleanupDaemon = await isolateDaemonForSmokeTest();
	f.env.OMP_DAEMON_DIR = process.env.OMP_DAEMON_DIR!;
	const result = await f
		.run(["--config", f.configPath, "--no-session", "--print", "Read the fixture page."])
		.finally(cleanupDaemon);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout.trim()).toBe("offline URL read completed");
	expect(toolResult).toContain(expectedContent);
	expect(offered).toContain("ast_edit");
	expect(offered).not.toContain("web_search");
}, 30_000);

describe("offline model-dependent subcommands", () => {
	it("rejects an explicit company model outside the offline lane without reading company credentials", async () => {
		const f = await fixture({ offline: false });
		const result = await f.run(["--model", "company/GLM-5.3-public", "--print", "--no-extensions", "hello"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("OMP_OFFLINE=1");
		expect(result.stderr).not.toContain("Company provider unavailable");
		expect(await Bun.file(f.companyPath).exists()).toBe(false);
		expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
	}, 30_000);

	it("keeps shared SDK initialization off terminal streams when company configuration is invalid", async () => {
		const f = await fixture({ modelRoles: { default: "ascend/vision" } });
		await fs.writeFile(f.companyPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "fixture-token" } }));
		const sourceUrl = (file: string) =>
			JSON.stringify(pathToFileURL(path.join(import.meta.dir, "../src", file)).href);
		const script = path.join(f.home, "sdk-company-diagnostics.ts");
		await fs.writeFile(
			script,
			`import { Settings } from ${sourceUrl("config/settings.ts")};
			import { ModelRegistry } from ${sourceUrl("config/model-registry.ts")};
			import { getCompanyConfigError } from ${sourceUrl("config/company-provider.ts")};
			import { discoverAuthStorage, initializeCompanyModelLane, loadCliExtensionProviders } from ${sourceUrl("sdk.ts")};
			const settings = await Settings.init({ cwd: process.cwd() });
			const [laneError, auth] = await Promise.all([
				initializeCompanyModelLane(true),
				discoverAuthStorage(undefined, { settings }),
			]);
			try {
				const registry = new ModelRegistry(auth, undefined, { settings });
				await loadCliExtensionProviders(registry, settings, process.cwd(), { discoverModels: false });
				const nested = await discoverAuthStorage(undefined, { settings });
				nested.close();
				process.stdout.write(JSON.stringify({
					companyAvailable: registry.hasProvider("company"),
					configError: Boolean(getCompanyConfigError()) && laneError === getCompanyConfigError(),
					defaultRole: settings.getModelRole("default"),
				}));
			} finally { auth.close(); }`,
		);
		const result = await f.run([], script);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			companyAvailable: false,
			configError: true,
			defaultRole: "ascend/vision",
		});
		expect(result.stderr).toBe("");
	}, 30_000);

	it("activates auth discovery without Settings and refreshes company policy on a prebuilt registry", async () => {
		const f = await fixture({ companyUrl: "http://127.0.0.1:1" });
		const script = path.join(f.home, "prebuilt-model-runtime.ts");
		const sourceUrl = (file: string) =>
			JSON.stringify(pathToFileURL(path.join(import.meta.dir, "../src", file)).href);
		await fs.writeFile(
			script,
			`import { Database } from "bun:sqlite";
			import { AuthStorage, SqliteAuthCredentialStore } from ${sourceUrl("session/auth-storage.ts")};
			import { ModelRegistry } from ${sourceUrl("config/model-registry.ts")};
			import { Settings } from ${sourceUrl("config/settings.ts")};
			import { getCompanyConfig } from ${sourceUrl("config/company-provider.ts")};
			import { discoverAuthStorage, loadCliExtensionProviders } from ${sourceUrl("sdk.ts")};
			import { resolvePrimaryModel } from ${sourceUrl("commit/model-selection.ts")};
			const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
			try {
				const registry = new ModelRegistry(authStorage);
				registry.getAll();
				await registry.refresh("online");
				const discovered = await discoverAuthStorage();
				try {
					if (!getCompanyConfig()) throw new Error("Auth discovery did not load company credentials");
				} finally { discovered.close(); }
				const settings = await Settings.init({ cwd: process.cwd() });
				await loadCliExtensionProviders(registry, settings, process.cwd());
				const resolved = await resolvePrimaryModel(undefined, settings, registry);
				process.stdout.write(JSON.stringify({
					provider: resolved.model.provider, model: resolved.model.id,
					defaultRole: settings.getModelRole("default"), commitRole: settings.getModelRole("commit"),
				}) + "\\n");
			} finally { authStorage.close(); }`,
		);
		const result = await f.run([], script);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			provider: "company",
			model: "Qwen3.6-35B-A3B",
			defaultRole: "company/GLM-5.3-public",
			commitRole: "company/Qwen3.6-35B-A3B",
		});
		expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
	}, 30_000);

	it("compresses through the default company model using only the local company endpoint", async () => {
		const requests: Array<{ model: string; authorization: string | null }> = [];
		let turn = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { model: string };
				requests.push({ model: body.model, authorization: request.headers.get("authorization") });
				const step = turn++;
				if (step === 0) {
					return anthropicResponse(body.model, "", {
						name: "rewrite",
						input: { text: "Default timeout: 30s.", losses: [] },
					});
				}
				if (step === 2) {
					return anthropicResponse(body.model, "", {
						name: "approve",
						input: { verdict: "Preserved the timeout and its default." },
					});
				}
				return anthropicResponse(body.model, "Ready for review.");
			},
		});
		try {
			const f = await fixture({ companyUrl: server.url.origin });
			const source = path.join(f.home, "source.txt");
			const text = "The timeout defaults to thirty seconds when the caller does not supply a value.";
			await fs.writeFile(source, text);
			const result = await f.run(["compress", source]);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toContain("Default timeout: 30s.");
			expect(requests.length).toBeGreaterThan(0);
			for (const request of requests) {
				expect(request).toEqual({ model: "GLM-5.3-public", authorization: "Bearer fixture-token" });
			}
			expect(await fs.readFile(source, "utf8")).toBe(text);
			expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
			expect(await fs.readFile(f.companyPath, "utf8")).toBe(f.companyText);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	it("initializes agentic commit, legacy commit and the Git AI service with cache-only company roles", async () => {
		const requests: Array<{ model: string; authorization: string | null }> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as Parameters<typeof anthropicCommitResponse>[0];
				requests.push({ model: body.model, authorization: request.headers.get("authorization") });
				return anthropicCommitResponse(body);
			},
		});
		try {
			const f = await fixture({
				companyUrl: server.url.origin,
				modelRoles: { commit: "company/Qwen3.6-35B-A3B", smol: "company/GLM-5.3-public" },
			});
			await stageCommitFixture(f.home, f.env);
			const agentic = await f.run(["commit", "--dry-run", "--no-changelog"]);
			expect(agentic.exitCode, `${agentic.stdout}\n${agentic.stderr}`).toBe(0);
			expect(agentic.stdout).toContain("Qwen3.6-35B-A3B");
			expect(agentic.stdout).toContain("Generated commit message:");
			expect(agentic.stdout).toContain("feat: added offline fixture");
			expect(requests.length).toBeGreaterThan(0);
			for (const request of requests.splice(0)) {
				expect(request).toEqual({ model: "Qwen3.6-35B-A3B", authorization: "Bearer fixture-token" });
			}
			const legacy = await f.run(["commit", "--legacy", "--dry-run", "--no-changelog"]);
			expect(legacy.exitCode, `${legacy.stdout}\n${legacy.stderr}`).toBe(0);
			expect(legacy.stdout).toContain("feat: added offline fixture");
			expect(requests.splice(0)).toEqual([{ model: "GLM-5.3-public", authorization: "Bearer fixture-token" }]);
			const service = path.join(f.home, "git-ai-service.ts");
			await fs.writeFile(
				service,
				`import { generateGitCommit } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "../src/commit/conventional/service.ts")).href)};
				const result = await generateGitCommit({ cwd: process.cwd(), modelOverride: "company/GLM-5.2-public", stageIfEmpty: false });
				process.stdout.write(JSON.stringify(result) + "\\n");`,
			);
			const generated = await f.run([], service);
			expect(generated.exitCode, `${generated.stdout}\n${generated.stderr}`).toBe(0);
			expect(JSON.parse(generated.stdout).commit.summary).toBe("added offline fixture");
			expect(requests).toEqual([{ model: "GLM-5.2-public", authorization: "Bearer fixture-token" }]);
			expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
			expect(await fs.readFile(f.companyPath, "utf8")).toBe(f.companyText);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	it("requires company for implicit compress and commit models but honors an explicit alternate", async () => {
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as Parameters<typeof anthropicCommitResponse>[0];
				requests.push(body.model);
				return anthropicCommitResponse(body);
			},
		});
		try {
			const f = await fixture({ visionUrl: server.url.origin });
			await stageCommitFixture(f.home, f.env);
			const source = path.join(f.home, "source.txt");
			await fs.writeFile(source, "The default timeout is thirty seconds.");
			for (const args of [
				["compress", source],
				["commit", "--dry-run", "--no-changelog"],
			]) {
				const result = await f.run(args);
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).toContain("Company provider unavailable");
				expect(result.stderr).not.toContain("fixture-token");
			}
			expect(requests).toEqual([]);
			const override = await f.run(["commit", "--dry-run", "--no-changelog", "--model", "ascend/vision"]);
			expect(override.exitCode, `${override.stdout}\n${override.stderr}`).toBe(0);
			expect(override.stdout).toContain("vision");
			expect(override.stdout).toContain("feat: added offline fixture");
			expect(new Set(requests)).toEqual(new Set(["vision"]));
		} finally {
			server.stop(true);
		}
	}, 60_000);

	it("keeps normal command extension discovery enabled outside the offline lane", async () => {
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as Parameters<typeof anthropicCommitResponse>[0];
				requests.push(body.model);
				return anthropicCommitResponse(body);
			},
		});
		try {
			const f = await fixture({ offline: false, visionUrl: server.url.origin });
			await stageCommitFixture(f.home, f.env);
			const result = await f.run(["commit", "--dry-run", "--no-changelog", "--model", "ascend/vision"], CLI, true);
			expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("vision");
			expect(result.stdout).toContain("Generated commit message:");
			expect(result.stdout).toContain("feat: added offline fixture");
			expect(result.stderr).toContain("UNEXPECTED_EXTENSION_DISCOVERY");
			expect(result.stderr).not.toContain("Company provider unavailable");
			expect(new Set(requests)).toEqual(new Set(["vision"]));
		} finally {
			server.stop(true);
		}
	}, 30_000);

	it("asks the default company vision model through the real Anthropic route without discovery or config writes", async () => {
		const requests: Array<{
			path: string;
			authorization: string | null;
			apiKey: string | null;
			model: string;
			image: boolean;
		}> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as {
					model: string;
					messages: Array<{ content: Array<{ type: string }> }>;
				};
				requests.push({
					path: new URL(request.url).pathname,
					authorization: request.headers.get("authorization"),
					apiKey: request.headers.get("x-api-key"),
					model: body.model,
					image: body.messages.some(message => message.content.some(block => block.type === "image")),
				});
				return anthropicResponse(body.model);
			},
		});
		try {
			const f = await fixture({ companyUrl: `${server.url.origin}/prefix/v1/` });
			const result = await f.run(["read", `${f.image}?q=describe this image`]);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toContain("offline vision answer");
			expect(requests).toEqual([
				{
					path: "/prefix/v1/messages",
					authorization: "Bearer fixture-token",
					apiKey: null,
					model: "Qwen3.8-27B",
					image: true,
				},
			]);
			expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
			expect(await fs.readFile(f.companyPath, "utf8")).toBe(f.companyText);
		} finally {
			server.stop(true);
		}
	}, 30_000);

	it("honors a non-company default role for image questions despite an invalid company snapshot", async () => {
		const requests: Array<{ model: string; image: boolean; apiKey: string | null; authorization: string | null }> =
			[];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				expect(url.pathname).toBe("/v1/messages");
				expect([...url.searchParams]).toEqual([["beta", "true"]]);
				const body: unknown = await request.json();
				if (
					typeof body !== "object" ||
					body === null ||
					!("model" in body) ||
					typeof body.model !== "string" ||
					!("messages" in body) ||
					!Array.isArray(body.messages)
				) {
					return new Response("Invalid fixture request", { status: 400 });
				}
				requests.push({
					model: body.model,
					image: body.messages.some(
						(message: unknown) =>
							typeof message === "object" &&
							message !== null &&
							"content" in message &&
							Array.isArray(message.content) &&
							message.content.some(
								(block: unknown) =>
									typeof block === "object" && block !== null && "type" in block && block.type === "image",
							),
					),
					apiKey: request.headers.get("x-api-key"),
					authorization: request.headers.get("authorization"),
				});
				return anthropicResponse(body.model);
			},
		});
		try {
			const f = await fixture({
				visionUrl: server.url.origin,
				modelRoles: { default: "@local", local: "ascend/vision" },
			});
			const companyText = "{ invalid JSON";
			await fs.writeFile(f.companyPath, companyText);
			const result = await f.run(["read", `${f.image}?q=describe this image`]);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toContain("offline vision answer");
			expect(result.stderr.match(/Company provider unavailable/g)).toHaveLength(1);
			expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
			expect(await fs.readFile(f.modelsPath, "utf8")).toBe(f.modelsText);
			expect(await fs.readFile(f.companyPath, "utf8")).toBe(companyText);
			expect(requests).toEqual([
				{ model: "vision", image: true, apiKey: null, authorization: "Bearer local-vision-key" },
			]);
		} finally {
			server.stop(true);
		}
	}, 30_000);

	it("does not fall back to another authenticated provider when the configured company vision role is unavailable", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				return anthropicResponse("vision");
			},
		});
		try {
			const f = await fixture({
				visionUrl: server.url.origin,
				modelRoles: {
					vision: "@companyVision",
					companyVision: "company/Qwen3.8-27B",
					default: "ascend/vision",
				},
			});
			const companyText = "{ invalid JSON";
			await fs.writeFile(f.companyPath, companyText);
			const result = await f.run(["read", `${f.image}?q=describe`]);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Company provider unavailable");
			expect(result.stderr).toContain("not valid JSON");
			expect(requests).toBe(0);
			expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
			expect(await fs.readFile(f.modelsPath, "utf8")).toBe(f.modelsText);
			expect(await fs.readFile(f.companyPath, "utf8")).toBe(companyText);
		} finally {
			server.stop(true);
		}
	}, 30_000);

	it("reads ordinary local files and renders sessions without company configuration or auth discovery", async () => {
		const f = await fixture();
		// Auth discovery would reject this incomplete broker configuration.
		f.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:1";
		const text = path.join(f.home, "plain.txt");
		await fs.writeFile(text, "ordinary offline file\n");
		const read = await f.run(["read", text]);
		expect(read.exitCode, read.stderr).toBe(0);
		expect(read.stdout).toContain("ordinary offline file");
		expect(read.stderr).not.toContain("Company provider unavailable");
		const session = path.join(f.home, "render.jsonl");
		const timestamp = "2026-10-17T00:00:00.000Z";
		const source =
			[
				{ type: "session", version: 3, id: "offline-render", timestamp, cwd: f.home },
				{
					type: "message",
					id: "m1",
					parentId: null,
					timestamp,
					message: { role: "user", content: [{ type: "text", text: "pure offline transcript" }], timestamp: 0 },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n") + "\n";
		await fs.writeFile(session, source);
		// The offline render-only UI registry must ignore unrelated broken model config.
		const modelsPath = path.join(f.agentDir, "models.yml");
		const modelsText = "{ invalid YAML";
		await fs.writeFile(modelsPath, modelsText);
		const render = await f.run(["render", session, "--plain", "--width", "80", "--height", "24"]);
		expect(render.exitCode, render.stderr).toBe(0);
		expect(render.stdout).toContain("pure offline transcript");
		expect(render.stderr).not.toContain("Company provider unavailable");
		expect(await fs.readFile(session, "utf8")).toBe(source);
		expect(await fs.readFile(modelsPath, "utf8")).toBe(modelsText);
		expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
	}, 30_000);

	it("does not treat the default company model as an OAuth account in dry-balance", async () => {
		const f = await fixture({ companyUrl: "http://company.invalid" });
		const result = await f.run(["dry-balance", "--count", "1", "--concurrency", "1", "--json"]);
		expect(result.exitCode).toBe(1);
		const summary = JSON.parse(result.stdout);
		expect(summary.provider).toBe("company");
		expect(summary.model).toBe("company/GLM-5.3-public");
		expect(summary.failure.reasons[0].reason).toBe("no OAuth access resolved");
		expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
	}, 30_000);

	it("diagnoses unavailable company config for dry-balance and usage without inventing a company usage endpoint", async () => {
		const missing = await fixture();
		const balance = await missing.run(["dry-balance", "company/Qwen3.8-27B", "--count", "1", "--json"]);
		expect(balance.exitCode).not.toBe(0);
		expect(balance.stderr).toContain("Company provider unavailable");
		for (const f of [missing, await fixture({ companyUrl: "http://company.invalid" })]) {
			const usage = await f.run(["usage", "--provider", "company", "--json"]);
			expect(usage.exitCode, usage.stderr).toBe(0);
			expect(JSON.parse(usage.stdout).reports).toEqual([]);
			expect(usage.stderr.includes("Company provider unavailable")).toBe(f === missing);
		}
	}, 30_000);
});
