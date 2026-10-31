import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fuseRanked } from "@oh-my-pi/pi-mnemopi/core/rank-fusion";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveWikiModels as resolveWikiModelsUnscoped } from "../src/docs/models";

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

function resolveWikiModels(options: Parameters<typeof resolveWikiModelsUnscoped>[0], maxInputChars = 8192) {
	return withMnemopiRuntimeOptions({ embeddings: { disabled: false, maxInputChars } }, () =>
		resolveWikiModelsUnscoped(options),
	);
}

describe("Wiki model adapters", () => {
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
		const { embedding } = await resolveWikiModels(options);
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
		const otherEmbedding = (await resolveWikiModels(other)).embedding;
		expect(otherEmbedding).toBeDefined();
		expect(otherEmbedding!.identity).not.toBe(embedding!.identity);
	});

	test("splits clipped inputs for a capacity-limited endpoint and preserves ordered vectors", async () => {
		const requests: string[][] = [];
		let inconsistent = false;
		const baseUrl = server(async req => {
			const body = (await req.json()) as { model: string; input: string[] };
			requests.push(body.input);
			if (body.input.length > 4 || body.input.reduce((sum, text) => sum + text.length, 0) > 8192) {
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
		const { embedding } = await resolveWikiModels(options, 6000);
		const texts = [
			"1".repeat(8000),
			"2".repeat(8000),
			...Array.from({ length: 25 }, (_, index) => String.fromCharCode(97 + index)),
			"3".repeat(1000),
		];
		expect(await embedding!.embed(texts)).toEqual(texts.map(text => [text.charCodeAt(0), 1]));
		expect(requests.flat().map(text => text.length)).toEqual(texts.map(text => Math.min(text.length, 6000)));
		requests.length = 0;
		inconsistent = true;
		await expect(embedding!.embed(texts)).rejects.toThrow("Wiki embedding unavailable or invalid");
	});

	test("cancelling a split embedding request prevents later batches", async () => {
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
		const { embedding } = await resolveWikiModels(options);
		const texts = Array.from({ length: 25 }, (_, index) => `short-${index}`);
		await expect(embedding!.embed(texts, controller.signal)).rejects.toThrow("cancelled between batches");
		expect(calls).toBe(1);
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
			const { embedding } = await resolveWikiModels(options);
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
			expect((await resolveWikiModels(options)).embedding).toBeUndefined();
		} finally {
			if (previousUrl === undefined) delete Bun.env.MNEMOPI_EMBEDDING_API_URL;
			else Bun.env.MNEMOPI_EMBEDDING_API_URL = previousUrl;
			if (previousKey === undefined) delete Bun.env.MNEMOPI_EMBEDDING_API_KEY;
			else Bun.env.MNEMOPI_EMBEDDING_API_KEY = previousKey;
		}
	});

	test("strict embedding failures exclude inputs, credentials and response bodies from diagnostics", async () => {
		const baseUrl = server(() => new Response("response-body-secret", { status: 500 }));
		const options = await config({
			mnemopi: { embeddingModel: "local", embeddingApiUrl: baseUrl, embeddingApiKey: "credential-secret" },
		});
		const { embedding } = await resolveWikiModels(options);
		const events: logger.LogEvent[] = [];
		const dispose = logger.registerLogSink(event => {
			if (event.context?.component === "mnemopi.embeddings") events.push(event);
		});
		try {
			await expect(embedding!.embed(["private-query", "private-document"])).rejects.toThrow(
				"Wiki embedding unavailable or invalid",
			);
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
			wiki: { reranker: { model: "reranker", baseUrl, apiKey: "rerank-key" } },
		});
		const models = await resolveWikiModels(options);
		expect(models.embedding).toBeUndefined();
		expect(await models.reranker!.rerank("question", ["a", "b"])).toEqual([0.1, 0.9]);
		expect(calls).toBe(1);
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
					import { DocsSearchEngine } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/docs/engine.ts"))};
					import { resolveWikiModels } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/docs/models.ts"))};
					import { withMnemopiRuntimeOptions } from ${JSON.stringify(path.resolve(import.meta.dir, "../../mnemopi/src/core/runtime-options.ts"))};
					const options = ${JSON.stringify(options)};
					const models = await resolveWikiModels(options);
					const engine = new DocsSearchEngine(options);
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
					wiki: { reranker: { model: "rank", baseUrl: url, apiKey: "api-secret" } },
				});
				const models = await resolveWikiModels(options);
				expect(models.embedding).toBeUndefined();
				expect(models.reranker).toBeUndefined();
			}
			expect(calls).toBe(0);
			const valid = await config({
				mnemopi: { embeddingModel: "local", embeddingApiUrl: baseUrl, embeddingApiKey: "api-secret" },
			});
			const embedding = (await resolveWikiModels(valid)).embedding;
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
			wiki: { reranker: { model: "rank", baseUrl, apiKey: "" } },
		});
		const models = await resolveWikiModels(options);
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
			wiki: { reranker: { model: "rank", baseUrl, apiKey: "" } },
		});
		const models = await resolveWikiModels(options);
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
