import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fuseRanked } from "@oh-my-pi/pi-mnemopi/core/rank-fusion";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveKnowledgeModels as resolveKnowledgeModelsUnscoped } from "../src/knowledge/models";

const dirs: string[] = [];
const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function config(value: object): Promise<{ agentDir: string; cwd: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-models-"));
	dirs.push(dir);
	await Bun.write(path.join(dir, "config.yml"), JSON.stringify(value));
	return { agentDir: dir, cwd: dir };
}

function server(fetch: (request: Request) => Response | Promise<Response>): string {
	const instance = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
	servers.push(instance);
	return `http://127.0.0.1:${instance.port}/v1`;
}

function resolveKnowledgeModels(options: Parameters<typeof resolveKnowledgeModelsUnscoped>[0], maxInputChars = 8192) {
	return withMnemopiRuntimeOptions({ embeddings: { disabled: false, maxInputChars } }, () =>
		resolveKnowledgeModelsUnscoped(options),
	);
}

describe("Knowledge model adapters", () => {
	test("offline defaults send 8B embedding and rerank requests only to the company gateway", async () => {
		const requests: Array<{ route: string; model: string; auth: string | null }> = [];
		const baseUrl = server(async req => {
			const body = (await req.json()) as { model: string; input?: string[]; documents?: string[] };
			const route = new URL(req.url).pathname;
			requests.push({ route, model: body.model, auth: req.headers.get("authorization") });
			return Response.json(
				route.endsWith("/embeddings")
					? {
							model: body.model,
							data: body.input!.map((_, index) => ({ index, embedding: Array(4096).fill(0.5) })),
						}
					: {
							results: body
								.documents!.map((_, index) => ({ index, relevance_score: index === 0 ? 0.9 : 0.2 }))
								.reverse(),
							usage: { total_tokens: 12 },
						},
			);
		});
		const options = await config({});
		const disabled = await config({ knowledge: { reranker: { model: "" } } });
		const partial = await config({ knowledge: { reranker: { baseUrl: "http://other.invalid/v1" } } });
		const explicit = await config({
			knowledge: { reranker: { model: "custom-rank", baseUrl, apiKey: "custom-key" } },
		});
		const claudeDir = path.join(options.cwd, "claude");
		await Bun.write(
			path.join(claudeDir, "settings.json"),
			JSON.stringify({
				env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "company-key" },
			}),
		);
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`
			import { setCompanyOfflineEnabled } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/config/company-provider.ts"))};
			import { KnowledgeService } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/knowledge/service.ts"))};
			import { resolveKnowledgeModels } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/knowledge/models.ts"))};
			const options = ${JSON.stringify(options)};
			await setCompanyOfflineEnabled(false);
			const online = await resolveKnowledgeModels(options);
			if (online.embedding || online.reranker) throw new Error("company defaults leaked online");
			await setCompanyOfflineEnabled(true);
			const models = await resolveKnowledgeModels(options);
			await Bun.write(${JSON.stringify(path.join(claudeDir, "settings.json"))}, "{}");
			const source = ${JSON.stringify(path.join(options.cwd, "source"))};
			await Bun.write(source + "/guide.md", ${JSON.stringify("# MBIST\n\nMBIST repair uses redundant columns.\n")});
			const service = new KnowledgeService(options);
			try {
				await service.init(source, "mbist");
				const result = await service.searchKnowledge("MBIST");
				if (!/retrieval:\\s*hybrid/i.test(result.text) || !/reranked:\\s*yes/i.test(result.text)) throw new Error(result.text);
			} finally { await service.close(); }
			const vectors = await models.embedding.embed(["MBIST repair", "lunch"]);
			const scores = await models.reranker.rerank("MBIST", ["repair", "lunch"]);
			for (const options of ${JSON.stringify([disabled, partial])}) {
				if ((await resolveKnowledgeModels(options)).reranker) throw new Error("explicit setup overridden");
			}
			if ((await resolveKnowledgeModels({ ...options, reranker: false })).reranker) throw new Error("disabled reranker enabled");
			const custom = await resolveKnowledgeModels(${JSON.stringify(explicit)});
			await custom.reranker.rerank("MBIST", ["repair", "lunch"]);
			console.log(JSON.stringify({ dimensions: vectors.map(row => row.length), scores }));
		`,
			],
			{
				cwd: options.cwd,
				env: {
					...process.env,
					CLAUDE_CONFIG_DIR: claudeDir,
					PI_CONFIG_FILES: "",
					MNEMOPI_EMBEDDING_MODEL: "",
					MNEMOPI_EMBEDDING_API_URL: "",
					MNEMOPI_EMBEDDING_API_KEY: "",
					MNEMOPI_EMBEDDINGS_VIA_API: "",
					MNEMOPI_NO_EMBEDDINGS: "",
					OPENROUTER_BASE_URL: "",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(
			requests
				.slice(0, -3)
				.some(
					request =>
						request.route === "/v1/embeddings" &&
						request.model === "Qwen3-Embedding-8B" &&
						request.auth === "Bearer company-key",
				),
		).toBe(true);
		expect(
			requests
				.slice(0, -3)
				.some(
					request =>
						request.route === "/v1/rerank" &&
						request.model === "Qwen3-Reranker-8B" &&
						request.auth === "Bearer company-key",
				),
		).toBe(true);
		expect(JSON.parse(stdout)).toEqual({ dimensions: [4096, 4096], scores: [0.9, 0.2] });
		expect(requests.slice(-3)).toEqual([
			{ route: "/v1/embeddings", model: "Qwen3-Embedding-8B", auth: "Bearer company-key" },
			{ route: "/v1/rerank", model: "Qwen3-Reranker-8B", auth: "Bearer company-key" },
			{ route: "/v1/rerank", model: "custom-rank", auth: "Bearer custom-key" },
		]);
	});

	test("knowledge embedding retries a temporary overload and stops after four attempts", async () => {
		let calls = 0;
		let fail = false;
		const baseUrl = server(async req => {
			calls++;
			if (fail || calls === 1) return new Response("overloaded", { status: 503, headers: { "Retry-After": "0" } });
			const body = (await req.json()) as { model: string };
			return Response.json({ model: body.model, data: [{ index: 0, embedding: [1, 2] }] });
		});
		const options = await config({
			mnemopi: { embeddingModel: "local", embeddingApiUrl: baseUrl, embeddingApiKey: "" },
		});
		const { embedding } = await resolveKnowledgeModels(options);
		expect(await embedding!.embed(["MBIST repair"])).toEqual([[1, 2]]);
		expect(calls).toBe(2);
		fail = true;
		await expect(embedding!.embed(["MBIST repair"])).rejects.toThrow();
		expect(calls).toBe(6);
	});

	test("explicit embedding configuration sends only its own credentials and orders indexed rows", async () => {
		const requests: Array<{ auth: string | null; body: { model: string; input: string[] } }> = [];
		const baseUrl = server(async req => {
			requests.push({
				auth: req.headers.get("authorization"),
				body: (await req.json()) as { model: string; input: string[] },
			});
			return Response.json({
				model: "local-model",
				data: [
					{ index: 1, embedding: [3, 4] },
					{ index: 0, embedding: [1, 2] },
				],
			});
		});
		const options = await config({
			mnemopi: { embeddingModel: "local-model", embeddingApiUrl: baseUrl, embeddingApiKey: "local-key" },
		});
		const { embedding } = await resolveKnowledgeModels(options);
		expect(embedding).toBeDefined();
		expect(await embedding!.embed(["first", "second"])).toEqual([
			[1, 2],
			[3, 4],
		]);
		expect(requests).toEqual([
			{ auth: "Bearer local-key", body: { model: "local-model", input: ["first", "second"] } },
		]);
		const other = await config({
			mnemopi: { embeddingModel: "different-model", embeddingApiUrl: baseUrl, embeddingApiKey: "local-key" },
		});
		const otherEmbedding = (await resolveKnowledgeModels(other)).embedding;
		expect(otherEmbedding).toBeDefined();
		expect(otherEmbedding!.identity).not.toBe(embedding!.identity);
	});

	test("splits clipped inputs for a capacity-limited endpoint and preserves ordered vectors", async () => {
		const requests: string[][] = [];
		let inconsistent = false;
		const baseUrl = server(async req => {
			const body = (await req.json()) as { model: string; input: string[] };
			requests.push(body.input);
			if (body.input.length > 16 || body.input.reduce((sum, text) => sum + text.length, 0) > 32768) {
				return new Response("capacity exceeded", { status: 413 });
			}
			const data = body.input
				.map((text, index) => ({
					index,
					embedding: inconsistent && requests.length > 1 ? [text.charCodeAt(0)] : [text.charCodeAt(0), 1],
				}))
				.reverse();
			return Response.json({ model: body.model, data });
		});
		const options = await config({
			mnemopi: { embeddingModel: "local", embeddingApiUrl: baseUrl, embeddingApiKey: "" },
		});
		const { embedding } = await resolveKnowledgeModels(options, 6000);
		const texts = [
			...Array.from({ length: 7 }, (_, index) => String(index + 1).repeat(8000)),
			...Array.from({ length: 25 }, (_, index) => String.fromCharCode(97 + index)),
			"3".repeat(1000),
		];
		expect(await embedding!.embed(texts)).toEqual(texts.map(text => [text.charCodeAt(0), 1]));
		expect(
			requests
				.flat()
				.map(text => text.length)
				.sort((a, b) => a - b),
		).toEqual(texts.map(text => Math.min(text.length, 6000)).sort((a, b) => a - b));
		requests.length = 0;
		inconsistent = true;
		await expect(embedding!.embed(texts)).rejects.toThrow();
	});

	test("runs at most eight batches and returns vectors in input order when the first batch finishes late", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const lastStarted = Promise.withResolvers<void>();
		const requests: string[][] = [];
		let active = 0;
		let peak = 0;
		const texts = Array.from({ length: 160 }, (_, index) => `section-${index}`);
		const baseUrl = server(async req => {
			const body = (await req.json()) as { model: string; input: string[] };
			requests.push(body.input);
			active++;
			peak = Math.max(peak, active);
			if (requests.length === 8) entered.resolve();
			if (requests.length === 10) lastStarted.resolve();
			try {
				await release.promise;
				if (body.input[0] === texts[0]) await releaseFirst.promise;
				return Response.json({
					model: body.model,
					data: body.input.map((text, index) => ({ index, embedding: [Number(text.slice(8)), 1] })).reverse(),
				});
			} finally {
				active--;
			}
		});
		const options = await config({
			mnemopi: { embeddingModel: "local", embeddingApiUrl: baseUrl, embeddingApiKey: "" },
		});
		const { embedding } = await resolveKnowledgeModels(options);
		const pending = embedding!.embed(texts);
		try {
			await entered.promise;
			expect(requests).toHaveLength(8);
			release.resolve();
			await lastStarted.promise;
			releaseFirst.resolve();
			expect(await pending).toEqual(texts.map((_, index) => [index, 1]));
			expect(peak).toBe(8);
			expect(requests.map(batch => batch.length)).toEqual(Array(10).fill(16));
		} finally {
			release.resolve();
			releaseFirst.resolve();
			await pending.catch(() => {});
		}
	});

	test("an invalid batch cancels in-flight siblings and prevents queued embedding requests", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const baseUrl = server(async req => {
			const body = (await req.json()) as { model: string; input: string[] };
			calls++;
			if (calls === 8) entered.resolve();
			await entered.promise;
			if (body.input[0] === "section-0") return Response.json({ model: body.model, data: [] });
			await release.promise;
			return Response.json({
				model: body.model,
				data: body.input.map((_, index) => ({ index, embedding: [1, 2] })),
			});
		});
		const options = await config({
			mnemopi: { embeddingModel: "local", embeddingApiUrl: baseUrl, embeddingApiKey: "" },
		});
		const { embedding } = await resolveKnowledgeModels(options);
		try {
			await expect(embedding!.embed(Array.from({ length: 160 }, (_, index) => `section-${index}`))).rejects.toThrow(
				"Knowledge embedding unavailable or invalid",
			);
			expect(calls).toBe(8);
		} finally {
			release.resolve();
		}
	});

	test("cancelling a parallel embedding request prevents queued batches", async () => {
		let calls = 0;
		const controller = new AbortController();
		const baseUrl = server(async req => {
			calls++;
			const body = (await req.json()) as { model: string; input: string[] };
			controller.abort(new Error("cancelled between batches"));
			return Response.json({
				model: body.model,
				data: body.input.map((_, index) => ({ index, embedding: [1, 2] })),
			});
		});
		const options = await config({
			mnemopi: { embeddingModel: "local", embeddingApiUrl: baseUrl, embeddingApiKey: "" },
		});
		const { embedding } = await resolveKnowledgeModels(options);
		const texts = Array.from({ length: 160 }, (_, index) => `short-${index}`);
		await expect(embedding!.embed(texts, controller.signal)).rejects.toThrow("cancelled between batches");
		expect(calls).toBeGreaterThan(0);
		expect(calls).toBeLessThanOrEqual(8);
	});

	test("blank model follows the existing environment fallback when an API URL is configured", async () => {
		const previous = Bun.env.MNEMOPI_EMBEDDING_MODEL;
		Bun.env.MNEMOPI_EMBEDDING_MODEL = "environment-model";
		try {
			const requests: Array<{ model: string; input: string[] }> = [];
			const baseUrl = server(async req => {
				const body = (await req.json()) as { model: string; input: string[] };
				requests.push(body);
				return Response.json({ model: body.model, data: [{ index: 0, embedding: [1, 2] }] });
			});
			const options = await config({
				mnemopi: { embeddingModel: "", embeddingVariant: "en", embeddingApiUrl: baseUrl, embeddingApiKey: "" },
			});
			const { embedding } = await resolveKnowledgeModels(options);
			expect(await embedding!.embed(["text"])).toEqual([[1, 2]]);
			expect(requests).toEqual([{ model: "environment-model", input: ["text"] }]);
		} finally {
			if (previous === undefined) delete Bun.env.MNEMOPI_EMBEDDING_MODEL;
			else Bun.env.MNEMOPI_EMBEDDING_MODEL = previous;
		}
	});

	test("explicit blank API settings do not inherit environment URL or credentials", async () => {
		const previousUrl = Bun.env.MNEMOPI_EMBEDDING_API_URL;
		const previousKey = Bun.env.MNEMOPI_EMBEDDING_API_KEY;
		Bun.env.MNEMOPI_EMBEDDING_API_URL = "https://example.invalid/v1";
		Bun.env.MNEMOPI_EMBEDDING_API_KEY = "environment-key";
		try {
			const options = await config({
				mnemopi: { embeddingModel: "openai/text-embedding-3-small", embeddingApiUrl: "", embeddingApiKey: "" },
			});
			expect((await resolveKnowledgeModels(options)).embedding).toBeUndefined();
		} finally {
			if (previousUrl === undefined) delete Bun.env.MNEMOPI_EMBEDDING_API_URL;
			else Bun.env.MNEMOPI_EMBEDDING_API_URL = previousUrl;
			if (previousKey === undefined) delete Bun.env.MNEMOPI_EMBEDDING_API_KEY;
			else Bun.env.MNEMOPI_EMBEDDING_API_KEY = previousKey;
		}
	});

	test("strict embedding failures exclude inputs, credentials and response bodies from diagnostics", async () => {
		const baseUrl = server(
			() => new Response("response-body-secret", { status: 500, headers: { "Retry-After": "0" } }),
		);
		const options = await config({
			mnemopi: { embeddingModel: "local", embeddingApiUrl: baseUrl, embeddingApiKey: "credential-secret" },
		});
		const { embedding } = await resolveKnowledgeModels(options);
		const events: logger.LogEvent[] = [];
		const dispose = logger.registerLogSink(event => {
			if (event.context?.component === "mnemopi.embeddings") events.push(event);
		});
		try {
			await expect(embedding!.embed(["private-query", "private-document"])).rejects.toThrow();
			expect(events.length).toBeGreaterThan(0);
			const output = JSON.stringify(events);
			for (const secret of ["private-query", "private-document", "credential-secret", "response-body-secret"]) {
				expect(output).not.toContain(secret);
			}
		} finally {
			dispose();
		}
	});

	test("disabled embedding makes no request and does not disable independent reranking", async () => {
		let calls = 0;
		const baseUrl = server(async req => {
			calls++;
			expect(new URL(req.url).pathname).toBe("/v1/rerank");
			expect(req.headers.get("authorization")).toBe("Bearer rerank-key");
			expect(await req.json()).toEqual({ model: "reranker", query: "question", documents: ["a", "b"] });
			return Response.json({
				model: "reranker",
				results: [
					{ index: 1, relevance_score: 0.9 },
					{ index: 0, relevance_score: 0.1 },
				],
			});
		});
		const options = await config({
			mnemopi: { noEmbeddings: true },
			knowledge: { reranker: { model: "reranker", baseUrl, apiKey: "rerank-key" } },
		});
		const models = await resolveKnowledgeModels(options);
		expect(models.embedding).toBeUndefined();
		expect(await models.reranker!.rerank("question", ["a", "b"])).toEqual([0.1, 0.9]);
		expect(calls).toBe(1);
	});

	test("rerank failures warn with safe HTTP, decode and validation reasons", async () => {
		let payload: unknown = {};
		let status = 200;
		let rawJson: string | undefined;
		const baseUrl = server(() =>
			rawJson === undefined ? Response.json(payload, { status }) : new Response(rawJson),
		);
		const options = await config({
			mnemopi: { noEmbeddings: true },
			knowledge: { reranker: { model: "rank", baseUrl, apiKey: "credential-secret" } },
		});
		const { reranker } = await resolveKnowledgeModels(options);
		const events: logger.LogEvent[] = [];
		const dispose = logger.registerLogSink(event => {
			if (event.level === "warn" && event.context?.stage === "rerank.request") events.push(event);
		});
		const cases = [
			{ payload: { error: { message: "response-body-secret" } }, status: 503, reason: "http_error" },
			{ payload: {}, reason: "response_schema" },
			{ payload: { model: 123, results: [] }, reason: "response_schema" },
			{ payload: { results: [{ index: 0, relevance_score: "response-body-secret" }] }, reason: "response_schema" },
			{ payload: { model: "response-model-secret", results: [] }, reason: "model_mismatch" },
			{ payload: { results: [] }, reason: "result_count" },
			{ payload: { results: [{ index: 1, relevance_score: 1 }] }, reason: "invalid_index" },
			{ payload: { results: [{ index: 0.5, relevance_score: 1 }] }, reason: "invalid_index" },
			{
				payload: {},
				rawJson: '{"results":[{"index":0,"relevance_score":1e999}]}',
				reason: "response_schema",
			},
		];
		try {
			for (const failure of cases) {
				payload = failure.payload;
				status = failure.status ?? 200;
				rawJson = "rawJson" in failure ? failure.rawJson : undefined;
				await expect(reranker!.rerank("private-query", ["private-document"])).rejects.toThrow();
				expect(events.at(-1)?.context).toMatchObject({ reason: failure.reason });
				if (status !== 200) expect(events.at(-1)?.context?.status).toBe(status);
			}
			rawJson = undefined;
			payload = {
				results: [
					{ index: 0, relevance_score: 1 },
					{ index: 0, relevance_score: 2 },
				],
			};
			await expect(reranker!.rerank("private-query", ["private-document", "second-document"])).rejects.toThrow();
			expect(events.at(-1)?.context?.reason).toBe("duplicate_index");
			rawJson = "response-body-secret";
			await expect(reranker!.rerank("private-query", ["private-document"])).rejects.toThrow();
			expect(events.at(-1)?.context).toMatchObject({ reason: "response_json", error_type: "SyntaxError" });
			expect(events).toHaveLength(cases.length + 2);
			const output = JSON.stringify(events);
			for (const secret of [
				"private-query",
				"private-document",
				"second-document",
				"credential-secret",
				"response-body-secret",
				"response-model-secret",
			]) {
				expect(output).not.toContain(secret);
			}
		} finally {
			dispose();
		}
	});

	test("rerank timeouts warn but caller cancellation stays a cancellation", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<Response>();
		const baseUrl = server(() => {
			started.resolve();
			return release.promise;
		});
		const options = await config({
			mnemopi: { noEmbeddings: true },
			knowledge: { reranker: { model: "rank", baseUrl, apiKey: "" } },
		});
		const { reranker } = await resolveKnowledgeModels(options);
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() => AbortSignal.abort(new DOMException("timeout-secret", "TimeoutError")));
		const events: logger.LogEvent[] = [];
		const dispose = logger.registerLogSink(event => {
			if (event.level === "warn" && event.context?.stage === "rerank.request") events.push(event);
		});
		try {
			await expect(reranker!.rerank("private-query", ["private-document"])).rejects.toMatchObject({
				name: "TimeoutError",
			});
			expect(events).toHaveLength(1);
			expect(events[0]?.context).toMatchObject({ reason: "timeout", error_type: "TimeoutError" });
			expect(JSON.stringify(events)).not.toContain("timeout-secret");
			timeout.mockImplementation(() => new AbortController().signal);
			const controller = new AbortController();
			const pending = reranker!.rerank("q", ["a"], controller.signal);
			await started.promise;
			controller.abort(new Error("caller-cancellation"));
			await expect(pending).rejects.toThrow("caller-cancellation");
			expect(events).toHaveLength(1);
		} finally {
			timeout.mockRestore();
			dispose();
			release.resolve(Response.json({ results: [{ index: 0, relevance_score: 1 }] }));
		}
	});

	test("environment-disabled embeddings skip import and query requests", async () => {
		const requests: Array<{ model: string; input: string[] }> = [];
		const baseUrl = server(async request => {
			const body = (await request.json()) as { model: string; input: string[] };
			requests.push(body);
			return Response.json({
				model: body.model,
				data: body.input.map((_, index) => ({ index, embedding: [1, 2] })),
			});
		});
		const options = await config({
			mnemopi: { noEmbeddings: false, embeddingModel: "local", embeddingApiUrl: baseUrl, embeddingApiKey: "" },
		});
		const source = path.join(options.cwd, "source");
		await fs.mkdir(source);
		await Bun.write(path.join(source, "guide.md"), "# Guide\n\nA unique platypus checklist.\n");
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`
					import { KnowledgeIndexEngine } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/knowledge/engine.ts"))};
					import { resolveKnowledgeModels } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/knowledge/models.ts"))};
					import { withMnemopiRuntimeOptions } from ${JSON.stringify(path.resolve(import.meta.dir, "../../mnemopi/src/core/runtime-options.ts"))};
					const options = ${JSON.stringify(options)};
					const models = await resolveKnowledgeModels(options);
					const engine = new KnowledgeIndexEngine(options);
					try {
						await withMnemopiRuntimeOptions(
							{ embeddings: { disabled: false, maxInputChars: 8192 } },
							() => engine.init(${JSON.stringify(source)}, "seed"),
						);
						await engine.init(${JSON.stringify(source)}, "guide");
						const result = await engine.searchWindowAsync("platypus");
						console.log(JSON.stringify({ embedding: !!models.embedding, total: result.total }));
					} finally {
						engine.close();
					}
				`,
			],
			{
				cwd: options.cwd,
				env: { ...process.env, PI_CONFIG_FILES: "", MNEMOPI_NO_EMBEDDINGS: "1" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" });
		const result = JSON.parse(stdout) as { embedding: boolean; total: number };
		expect(result.embedding).toBe(false);
		expect(result.total).toBeGreaterThan(0);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.model).toBe("local");
		expect(requests[0]?.input.join(" ")).toContain("platypus");
	});

	test("rejects unsafe endpoints without sending credentials or input", async () => {
		let calls = 0;
		const baseUrl = server(() => {
			calls++;
			return Response.json({});
		});
		const authority = baseUrl.replace("http://", "");
		const invalid = [
			`http://user:credential-secret@${authority}`,
			`${baseUrl}?token=query-secret`,
			`${baseUrl}#fragment-secret`,
			`ftp://${authority}`,
		];
		const events: logger.LogEvent[] = [];
		const dispose = logger.registerLogSink(event => events.push(event));
		try {
			for (const url of invalid) {
				const options = await config({
					mnemopi: { embeddingModel: "local", embeddingApiUrl: url, embeddingApiKey: "api-secret" },
					knowledge: { reranker: { model: "rank", baseUrl: url, apiKey: "api-secret" } },
				});
				const models = await resolveKnowledgeModels(options);
				expect(models.embedding).toBeUndefined();
				expect(models.reranker).toBeUndefined();
			}
			expect(calls).toBe(0);
			const valid = await config({
				mnemopi: { embeddingModel: "local", embeddingApiUrl: baseUrl, embeddingApiKey: "api-secret" },
			});
			const embedding = (await resolveKnowledgeModels(valid)).embedding;
			expect(embedding).toBeDefined();
			await expect(embedding!.embed(["private-query"])).rejects.toThrow();
			expect(calls).toBe(1);
			expect(events.filter(event => event.context?.component === "mnemopi.embeddings").length).toBeGreaterThan(0);
			const output = JSON.stringify(events);
			for (const secret of ["credential-secret", "query-secret", "fragment-secret", "api-secret", "private-query"]) {
				expect(output).not.toContain(secret);
			}
		} finally {
			dispose();
		}
	});

	test("invalid embedding rows or model and invalid rerank scores are rejected", async () => {
		let payload: unknown = {
			model: "local",
			data: [
				{ index: 0, embedding: [1, 2] },
				{ index: 0, embedding: [3, 4] },
			],
		};
		const baseUrl = server(() => Response.json(payload));
		const options = await config({
			mnemopi: { embeddingModel: "local", embeddingApiUrl: baseUrl, embeddingApiKey: "" },
			knowledge: { reranker: { model: "rank", baseUrl, apiKey: "" } },
		});
		const models = await resolveKnowledgeModels(options);
		await expect(models.embedding!.embed(["a", "b"])).rejects.toThrow();
		payload = { model: "other", data: [{ index: 0, embedding: [1, 2] }] };
		await expect(models.embedding!.embed(["a"])).rejects.toThrow();
		payload = { model: "local", data: [{ index: 0, embedding: [0, 0] }] };
		await expect(models.embedding!.embed(["a"])).rejects.toThrow();
		payload = { model: "local", data: [{ embedding: [1, 2] }] };
		await expect(models.embedding!.embed(["a"])).rejects.toThrow();
		payload = {
			model: "local",
			data: [
				{ index: 0, embedding: [1, 2] },
				{ index: 1, embedding: [3] },
			],
		};
		await expect(models.embedding!.embed(["a", "b"])).rejects.toThrow();
		payload = {
			model: "rank",
			results: [
				{ index: 0, relevance_score: 1 },
				{ index: 0, relevance_score: 2 },
			],
		};
		await expect(models.reranker!.rerank("q", ["a", "b"])).rejects.toThrow();
	});

	test("cancellation propagates instead of yielding model results", async () => {
		let arrived: (() => void) | undefined;
		const baseUrl = server(() => {
			arrived?.();
			return Promise.withResolvers<Response>().promise;
		});
		const options = await config({
			mnemopi: { embeddingModel: "local", embeddingApiUrl: baseUrl, embeddingApiKey: "" },
			knowledge: { reranker: { model: "rank", baseUrl, apiKey: "" } },
		});
		const models = await resolveKnowledgeModels(options);
		for (const operation of [
			(signal: AbortSignal) => models.embedding!.embed(["a"], signal),
			(signal: AbortSignal) => models.reranker!.rerank("q", ["a"], signal),
		]) {
			const controller = new AbortController();
			const started = Promise.withResolvers<void>();
			arrived = started.resolve;
			const pending = operation(controller.signal);
			await started.promise;
			controller.abort(new Error("cancelled by caller"));
			await expect(pending).rejects.toThrow("cancelled by caller");
		}
	});
});

test("RRF counts a duplicate only once per ranked list and breaks ties by identity", () => {
	const fused = fuseRanked(
		[
			["b", "b", "a"],
			["a", "b", "c"],
		],
		value => value,
		(a, b) => a.localeCompare(b),
	);
	expect(fused.map(item => item.key)).toEqual(["a", "b", "c"]);
	expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62);
	expect(fused[1].score).toBeCloseTo(1 / 61 + 1 / 62);
	expect(fused[2].score).toBeCloseTo(1 / 63);
});
