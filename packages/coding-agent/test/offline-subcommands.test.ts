import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOfflineShmState } from "@oh-my-pi/pi-natives/offline-root";

const CLI = path.join(import.meta.dir, "../src/cli.ts");
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(
	options: {
		companyUrl?: string;
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
		PI_CONFIG_DIR: ".omp",
		CLAUDE_CONFIG_DIR: claudeDir,
		NO_COLOR: "1",
	};
	if (options.offline !== false) env.OMP_OFFLINE = "1";
	const shm = getOfflineShmState(env);
	if (shm) tempDirs.push(path.dirname(shm.runtimeRoot));
	const agentDir = shm ? path.join(shm.runtimeRoot, "agent") : env.PI_CODING_AGENT_DIR!;
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
			pi.registerProvider("offline-subcommand-extension", {
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
			"review-local": {
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
			if (url !== ${JSON.stringify(endpoint)}) {
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
		async run(args: string[]) {
			const child = Bun.spawn([process.execPath, "--preload", guard, CLI, ...args], {
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
			expect(stderr).not.toContain("UNEXPECTED_NETWORK_FETCH");
			expect(stderr).not.toContain("UNEXPECTED_EXTENSION_DISCOVERY");
			return { stdout, stderr, exitCode };
		},
	};
}

function anthropicResponse(model: string): Response {
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
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "offline vision answer" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

describe("offline model-dependent subcommands", () => {
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

	it("honors explicit non-company vision and default roles with unavailable company snapshots", async () => {
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
			for (const role of ["vision", "default"]) {
				// Exercise role expansion as well as @default's existing vision fallback.
				const f = await fixture({
					visionUrl: server.url.origin,
					modelRoles:
						role === "vision"
							? { vision: "review-local/vision" }
							: { default: "@local", local: "review-local/vision" },
				});
				const companyText = role === "default" ? "{ invalid JSON" : undefined;
				if (companyText) await fs.writeFile(f.companyPath, companyText);
				const result = await f.run(["read", `${f.image}?q=describe this image`]);
				expect(result.exitCode, result.stderr).toBe(0);
				expect(result.stdout).toContain("offline vision answer");
				expect(result.stderr).toContain("Company provider unavailable");
				expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
				expect(await fs.readFile(f.modelsPath, "utf8")).toBe(f.modelsText);
				if (companyText) expect(await fs.readFile(f.companyPath, "utf8")).toBe(companyText);
				else expect(await Bun.file(f.companyPath).exists()).toBe(false);
			}
			expect(requests).toEqual([
				{ model: "vision", image: true, apiKey: null, authorization: "Bearer local-vision-key" },
				{ model: "vision", image: true, apiKey: null, authorization: "Bearer local-vision-key" },
			]);
		} finally {
			server.stop(true);
		}
	}, 30_000);

	it("never falls back from implicit or explicit company vision routes to another authenticated provider", async () => {
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
			for (const explicitCompany of [false, true]) {
				const f = await fixture({
					visionUrl: server.url.origin,
					...(explicitCompany
						? {
								modelRoles: {
									vision: "@companyVision",
									companyVision: "company/Qwen3.8-27B",
									default: "review-local/vision",
								},
							}
						: {}),
				});
				const companyText = explicitCompany ? "{ invalid JSON" : undefined;
				if (companyText) await fs.writeFile(f.companyPath, companyText);
				const result = await f.run(["read", `${f.image}?q=describe`]);
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).toContain("Company provider unavailable");
				expect(result.stderr).toContain(explicitCompany ? "not valid JSON" : "cannot read");
				expect(requests).toBe(0);
				expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
				expect(await fs.readFile(f.modelsPath, "utf8")).toBe(f.modelsText);
				if (companyText) expect(await fs.readFile(f.companyPath, "utf8")).toBe(companyText);
				else expect(await Bun.file(f.companyPath).exists()).toBe(false);
			}
		} finally {
			server.stop(true);
		}
	}, 30_000);

	it("reports missing company configuration for X reads without requiring a company vision model", async () => {
		const f = await fixture();
		const result = await f.run(["read", "https://x.com/jack/status/20"]);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stderr).toContain("Company provider unavailable");
		expect(result.stdout).toContain("xAI credentials");
		expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
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

	it("preserves normal render's user model configuration path and migration", async () => {
		const f = await fixture({ offline: false });
		const models = {
			providers: {
				"render-config-fixture": {
					api: "anthropic-messages",
					baseUrl: "http://render-config.invalid",
					apiKey: "fixture-key",
					models: [{ id: "custom-render-model", input: ["text"] }],
				},
			},
		};
		await fs.writeFile(path.join(f.agentDir, "models.json"), JSON.stringify(models));
		const session = path.join(f.home, "render.jsonl");
		const timestamp = "2026-10-17T00:00:00.000Z";
		await fs.writeFile(
			session,
			[
				{ type: "session", version: 3, id: "normal-render", timestamp, cwd: f.home },
				{
					type: "message",
					id: "m1",
					parentId: null,
					timestamp,
					message: { role: "user", content: [{ type: "text", text: "normal render transcript" }], timestamp: 0 },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		const result = await f.run(["render", session, "--plain", "--width", "80", "--height", "24"]);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("normal render transcript");
		expect(Bun.YAML.parse(await fs.readFile(path.join(f.agentDir, "models.yml"), "utf8"))).toEqual(models);
	}, 30_000);

	it("resolves dry-balance company roles and selectors without pretending they are OAuth accounts", async () => {
		const f = await fixture({ companyUrl: "http://company.invalid" });
		for (const args of [[], ["company/GLM-5.2-public"]]) {
			const result = await f.run(["dry-balance", ...args, "--count", "1", "--concurrency", "1", "--json"]);
			expect(result.exitCode).toBe(1);
			const summary = JSON.parse(result.stdout);
			expect(summary.provider).toBe("company");
			expect(summary.model).toBe(args.length ? "company/GLM-5.2-public" : "company/Qwen3.8-27B");
			expect(summary.failure.reasons[0].reason).toBe("no OAuth access resolved");
		}
		const miss = await f.run(["dry-balance", "offline-subcommand-extension/missing", "--count", "1", "--json"]);
		expect(miss.exitCode).not.toBe(0);
		expect(miss.stderr).toContain("missing");
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
