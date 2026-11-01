import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeService } from "../src/knowledge/service";
import type { KnowledgeSectionHit } from "../src/knowledge/types";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type ModelRequest = { model: string; input?: string | string[]; query?: string; documents?: string[] };
type RerankMode = "reverse" | "tie" | "http" | "duplicate" | "range" | "missing" | "nan" | "infinity" | "hold";

/** A deterministic wire-compatible test server, not a claim about model quality. */
function modelServer() {
	const requests: Array<{ route: string; body: ModelRequest }> = [];
	let embedding: "ok" | "http" | "zero" | "short" | "nonfinite" | "partial" | "hold" = "ok";
	let rerank: RerankMode = "reverse";
	let held = Promise.withResolvers<void>();
	const releases = new Set<() => void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const route = new URL(request.url).pathname;
			const body = (await request.json()) as ModelRequest;
			requests.push({ route, body });
			if (
				(route.endsWith("/embeddings") && embedding === "hold") ||
				(route.endsWith("/rerank") && rerank === "hold")
			) {
				const pending = Promise.withResolvers<void>();
				releases.add(pending.resolve);
				held.resolve();
				try {
					await pending.promise;
				} finally {
					releases.delete(pending.resolve);
				}
			}
			if (route.endsWith("/embeddings")) {
				if (embedding === "http") return new Response("offline", { status: 503 });
				const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
				if (embedding === "nonfinite") {
					return new Response(
						`{"object":"list","model":${JSON.stringify(body.model)},"data":[{"object":"embedding","index":0,"embedding":[1e999,0,0]}]}`,
					);
				}
				return Response.json({
					object: "list",
					model: body.model,
					data: inputs.map((text, index) => ({
						object: "embedding",
						index,
						embedding:
							embedding === "zero"
								? [0, 0, 0]
								: embedding === "short" || (embedding === "partial" && text.includes("Restart"))
									? [1, 0]
									: text.includes("distractor")
										? [0, 1, 0]
										: [1, 0, 0],
					})),
				});
			}
			if (route.endsWith("/rerank")) {
				if (rerank === "http") return new Response("offline", { status: 503 });
				const docs = body.documents ?? [];
				let results = docs.map((_, index) => ({ index, relevance_score: rerank === "tie" ? 1 : index }));
				if (rerank === "duplicate" && results.length > 1) results[1] = { ...results[1]!, index: 0 };
				if (rerank === "range" && results.length) results[0] = { ...results[0]!, index: docs.length };
				if (rerank === "missing") results = results.slice(1);
				if (rerank === "nan")
					return new Response('{"model":"rerank-test","results":[{"index":0,"relevance_score":NaN}]}');
				if (rerank === "infinity")
					return new Response('{"model":"rerank-test","results":[{"index":0,"relevance_score":1e999}]}');
				return Response.json({ model: body.model, results });
			}
			return new Response("unexpected route", { status: 404 });
		},
	});
	function releaseHeld() {
		for (const release of releases) release();
		releases.clear();
		held = Promise.withResolvers<void>();
	}
	cleanups.push(() => {
		releaseHeld();
		server.stop(true);
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		requests,
		setEmbedding(value: typeof embedding) {
			embedding = value;
		},
		setRerank(value: RerankMode) {
			rerank = value;
		},
		held() {
			return held.promise;
		},
		releaseHeld,
	};
}

async function fixture() {
	const envKeys = ["PI_CONFIG_FILES", "MNEMOPI_NO_EMBEDDINGS", "MNEMOPI_EMBEDDING_MAX_INPUT_CHARS"] as const;
	const previousEnv = envKeys.map(key => [key, process.env[key]] as const);
	for (const key of envKeys) delete process.env[key];
	cleanups.push(() => {
		for (const [key, value] of previousEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-semantic-"));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir);
	const server = modelServer();
	let service: KnowledgeService;
	async function configure(options: { embedding?: string; reranker?: boolean } = {}) {
		if (service) await service.close();
		await Bun.write(
			path.join(agentDir, "config.yml"),
			Bun.YAML.stringify({
				mnemopi: options.embedding
					? {
							noEmbeddings: false,
							embeddingModel: options.embedding,
							embeddingApiUrl: server.url,
							embeddingApiKey: "test-key",
						}
					: { noEmbeddings: true, embeddingModel: "", embeddingApiUrl: "", embeddingApiKey: "" },
				knowledge: {
					reranker: options.reranker
						? { model: "rerank-test", baseUrl: server.url, apiKey: "test-key" }
						: { model: "", baseUrl: "", apiKey: "" },
				},
			}),
		);
		service = new KnowledgeService({ agentDir, cwd: root });
		const owned = service;
		cleanups.push(() => {
			server.releaseHeld();
			return owned.close();
		});
		return service;
	}
	async function add(index: string, files: Record<string, string>, signal?: AbortSignal) {
		const dir = path.join(root, `source-${index}`);
		await fs.mkdir(dir);
		for (const [name, contents] of Object.entries(files)) await Bun.write(path.join(dir, name), contents);
		await service.init(dir, index, { signal });
		return dir;
	}
	await configure();
	return {
		root,
		agentDir,
		server,
		configure,
		add,
		get service() {
			return service;
		},
	};
}

function identities(sections: KnowledgeSectionHit[]) {
	return sections.map(section => `${section.index}/${section.path}:${section.sectionId}`);
}

async function allPages(service: KnowledgeService, query: string, limit = 25) {
	const sections: KnowledgeSectionHit[] = [];
	let cursor: string | undefined;
	let total = -1;
	for (let count = 0; count < 100; count++) {
		const page = await service.search(query, { limit, cursor });
		if (total !== -1) expect(page.total).toBe(total);
		total = page.total;
		sections.push(...page.sections);
		if (!page.hasMore) {
			expect(page.cursor).toBeUndefined();
			expect(sections).toHaveLength(total);
			expect(new Set(identities(sections)).size).toBe(total);
			return sections;
		}
		expect(page.cursor).toBeTruthy();
		cursor = page.cursor;
	}
	throw new Error("Pagination did not exhaust");
}

const lexicalFiles = {
	"a.md": "# First\nalpha beta first complete evidence.\n",
	"b.md": "# Second\nalpha beta second complete evidence.\n",
	"c.md": "# Third\nalpha beta third complete evidence.\n",
};

it("scopes semantic candidates before top-k and reports the ranking actually used across pages", async () => {
	const f = await fixture();
	await f.configure({ embedding: "test-embedding", reranker: true });
	const files: Record<string, string> = Object.fromEntries(
		Array.from({ length: 70 }, (_, i) => [`outside/${i}.md`, `# Outside ${i}\nunrelated evidence ${i}\n`]),
	);
	for (let i = 0; i < 4; i++)
		files[`selected/${i}.md`] = `# Selected ${i}\ndistractor scopecontent ${"complete ".repeat(160)}${i}\n`;
	await f.add("manual", files);
	const first = await f.service.searchKnowledge("如何恢复任务", { path: "selected/" });
	expect(first.result.sections.every(hit => hit.path.startsWith("selected/"))).toBe(true);
	expect(first.result.total).toBe(4);
	expect(first.text).toMatch(/retrieval:\s*hybrid/i);
	expect(first.text).toMatch(/reranked:\s*yes/i);
	expect(first.result.cursor).toBeTruthy();
	const rerank = f.server.requests.find(request => request.route.endsWith("/rerank"));
	expect(rerank?.body.documents?.every(document => document.includes("scopecontent"))).toBe(true);
	const count = f.server.requests.length;
	f.server.setEmbedding("http");
	f.server.setRerank("http");
	const next = await f.service.searchKnowledge("如何恢复任务", { path: "selected/", cursor: first.result.cursor });
	expect(next.text).toMatch(/retrieval:\s*hybrid/i);
	expect(next.text).toMatch(/reranked:\s*yes/i);
	expect(next.result.sections[0]?.sectionId).not.toBe(first.result.sections[0]?.sectionId);
	expect(f.server.requests).toHaveLength(count);
	f.server.setRerank("reverse");
	const fallback = await f.service.searchKnowledge("scopecontent", { path: "selected/" });
	expect(fallback.text).toMatch(/retrieval:\s*fulltext/i);
	expect(fallback.text).toMatch(/reranked:\s*yes/i);
	f.server.setRerank("http");
	const failedRerank = await f.service.searchKnowledge("scopecontent changed", { path: "selected/" });
	expect(failedRerank.text).toMatch(/retrieval:\s*fulltext/i);
	expect(failedRerank.text).toMatch(/reranked:\s*no/i);
	const beforeGrep = f.server.requests.length;
	const grep = await f.service.searchKnowledge("scopecontent", { mode: "grep", path: "selected/" });
	expect(grep.text).toMatch(/retrieval:\s*grep/i);
	expect(grep.text).toMatch(/reranked:\s*no/i);
	expect(f.server.requests).toHaveLength(beforeGrep);
}, 60_000);
describe("Knowledge semantic and rerank public contracts", () => {
	it("imports and searches full text with no model configuration and no model requests", async () => {
		const f = await fixture();
		await f.add("manual", lexicalFiles);
		const result = await f.service.search("alpha beta");
		expect(result.total).toBe(3);
		expect(result.sections.every(hit => hit.text.includes("alpha beta"))).toBe(true);
		expect(f.server.requests).toHaveLength(0);
	}, 30_000);

	it("recalls DB-only cross-wording evidence without presenting it as an exact name", async () => {
		const f = await fixture();
		await f.configure({ embedding: "test-embedding" });
		const dir = await f.add("manual", { "repair.md": "# Recovery\nRestart the worker after a failed checkpoint.\n" });
		await fs.rm(dir, { recursive: true });
		const result = await f.service.search("如何恢复任务");
		expect(result.total).toBeGreaterThan(0);
		expect(result.sections.find(hit => hit.path === "repair.md")).toMatchObject({
			index: "manual",
			lineStart: 1,
			lineEnd: 2,
			matchKind: "related",
			text: "# Recovery\nRestart the worker after a failed checkpoint.\n",
		});
		expect(result.sections[0]!.documentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(f.server.requests.filter(request => request.route.endsWith("/embeddings")).length).toBeGreaterThan(1);
	}, 30_000);

	it("excludes an old model generation without excluding its full-text evidence or a valid generation", async () => {
		const f = await fixture();
		await f.configure({ embedding: "old-model" });
		await f.add("old", {
			"old.md": "# Old\nalpha beta old lexical evidence.\n",
			"old-semantic.md": "# Obsolete\nAn old checkpoint needs recovery.\n",
		});
		await f.configure({ embedding: "current-model" });
		await f.add("current", { "current.md": "# Recovery\nRestart a failed checkpoint.\n" });
		const result = await f.service.search("alpha beta");
		expect(result.sections.map(hit => hit.index)).toContain("old");
		expect(result.sections.map(hit => hit.index)).toContain("current");
		expect(result.sections.find(hit => hit.index === "old")!.text).toContain("old lexical evidence");
		expect(result.sections.some(hit => hit.path === "old-semantic.md")).toBe(false);
	}, 30_000);

	it("excludes only the stored generation with a malformed vector, retaining its full-text matches", async () => {
		const f = await fixture();
		await f.configure({ embedding: "test-embedding" });
		await f.add("A", { "semantic-a.md": "# Recovery\nRestart a failed checkpoint.\n" });
		await f.add("B", {
			"lexical-b.md": "# Lexical\nalpha beta complete evidence.\n",
			"semantic-b.md": "# Recovery\nAn unrelated phrase about recovery.\n",
		});
		const db = new Database(f.service.databasePath, { strict: true });
		try {
			db.exec(
				"UPDATE wiki_section_vectors SET vector=x'0000803f' WHERE index_id=(SELECT id FROM doc_indexes WHERE name='B')",
			);
		} finally {
			db.close();
		}
		const result = await f.service.search("alpha beta");
		expect(result.sections.some(hit => hit.index === "A" && hit.path === "semantic-a.md")).toBe(true);
		expect(result.sections.some(hit => hit.index === "B" && hit.path === "lexical-b.md")).toBe(true);
		expect(result.sections.some(hit => hit.index === "B" && hit.path === "semantic-b.md")).toBe(false);
	}, 30_000);

	it("falls back to complete full text without embedding when every stored generation is malformed", async () => {
		const f = await fixture();
		await f.configure({ embedding: "test-embedding" });
		await f.add("A", { "a.md": lexicalFiles["a.md"], "b.md": lexicalFiles["b.md"] });
		await f.add("B", {
			"c.md": lexicalFiles["c.md"],
			"semantic.md": "# Recovery\nRestart a failed checkpoint.\n",
		});
		await f.configure();
		const baseline = await f.service.search("alpha beta");
		expect(baseline.total).toBe(3);
		await f.configure({ embedding: "test-embedding" });
		const db = new Database(f.service.databasePath, { strict: true });
		try {
			const generations = db
				.query(
					"SELECT doc_indexes.name, count(*) AS count FROM wiki_section_vectors JOIN doc_indexes ON doc_indexes.id=wiki_section_vectors.index_id GROUP BY doc_indexes.name ORDER BY doc_indexes.name",
				)
				.all() as Array<{ name: string; count: number }>;
			expect(generations.map(generation => generation.name)).toEqual(["A", "B"]);
			expect(generations.every(generation => generation.count > 0)).toBe(true);
			db.exec("UPDATE wiki_section_vectors SET vector=x'0000803f'");
		} finally {
			db.close();
		}
		const count = f.server.requests.length;
		const sections = await allPages(f.service, "alpha beta", 1);
		expect(identities(sections)).toEqual(identities(baseline.sections));
		expect(sections).toHaveLength(baseline.total);
		expect(f.server.requests.slice(count).filter(request => request.route.endsWith("/embeddings"))).toHaveLength(0);
	}, 30_000);

	it.each(["zero", "short", "nonfinite", "http"] as const)(
		"falls back to complete full text for a %s query vector",
		async invalid => {
			const f = await fixture();
			await f.add("plain", lexicalFiles);
			const baseline = await f.service.search("alpha beta");
			await f.configure({ embedding: "test-embedding" });
			await f.add("vector", { "semantic.md": "# Recovery\nRestart a failed checkpoint.\n" });
			f.server.setEmbedding(invalid);
			const result = await f.service.search("alpha beta");
			expect(identities(result.sections)).toEqual(identities(baseline.sections));
			expect(result.total).toBe(baseline.total);
		},
		30_000,
	);

	it.each(["http", "partial"] as const)(
		"keeps full text available when embedding preparation is %s and never exposes its partial generation",
		async failure => {
			const f = await fixture();
			await f.configure({ embedding: "test-embedding" });
			f.server.setEmbedding(failure);
			await f.add("manual", { ...lexicalFiles, "semantic.md": "# Recovery\nRestart a failed checkpoint.\n" });
			f.server.setEmbedding("ok");
			const requestCount = f.server.requests.length;
			const result = await f.service.search("alpha beta");
			expect(result.total).toBe(3);
			expect(result.sections.every(hit => hit.text.includes("alpha beta"))).toBe(true);
			// A normal query must not repair a failed generation on the user's behalf.
			expect(
				f.server.requests
					.slice(requestCount)
					.every(request => !Array.isArray(request.body.input) || request.body.input.length <= 1),
			).toBe(true);
		},
		30_000,
	);

	it("does not turn cancellation during embedding import into a successful published full-text index", async () => {
		const f = await fixture();
		await f.configure({ embedding: "test-embedding" });
		f.server.setEmbedding("hold");
		const held = f.server.held();
		const controller = new AbortController();
		const pending = f.add("manual", lexicalFiles, controller.signal);
		await held;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await f.configure();
		expect(await f.service.list()).toEqual([]);
	}, 30_000);

	it("preserves distinct identical sources while deduplicating a section recalled by both paths", async () => {
		const f = await fixture();
		await f.configure({ embedding: "test-embedding" });
		const duplicate = "# Shared\nalpha beta identical complete evidence.\n";
		await f.add("first", { "copy.md": duplicate });
		await f.add("second", { "copy.md": duplicate });
		const result = await f.service.search("alpha beta");
		expect(result.total).toBe(2);
		expect(new Set(identities(result.sections)).size).toBe(2);
		expect(result.sections.map(hit => hit.index).sort()).toEqual(["first", "second"]);
		expect(result.sections.every(hit => hit.text === duplicate)).toBe(true);
	}, 30_000);

	it("keeps complete-name evidence first even when semantic and rerank favor a partial name", async () => {
		const f = await fixture();
		await f.configure({ embedding: "test-embedding", reranker: true });
		await f.add("manual", {
			"a.md": "# Exact\nRead mbist_check.rpt for the report.\n",
			"z.md": "# Similar\nRead mbist_check.rpt.bak for the backup.\n",
		});
		const result = await f.service.search("mbist_check.rpt");
		expect(result.sections[0]).toMatchObject({ path: "a.md", matchKind: "exact-name" });
		expect(result.sections.find(hit => hit.path === "z.md")?.matchKind).toBe("related");
		expect(result.exactNameMatches).toBe(1);
	}, 30_000);

	it("paginates all full-text evidence beyond the semantic and rerank candidate windows", async () => {
		const f = await fixture();
		await f.configure({ embedding: "test-embedding" });
		const files = Object.fromEntries(
			Array.from({ length: 140 }, (_, i) => [
				`file-${String(i).padStart(3, "0")}.md`,
				`# Evidence ${i}\nalpha beta source ${i} complete.\n`,
			]),
		);
		await f.add("manual", files);
		const base = await allPages(f.service, "alpha beta", 200);
		await f.configure({ embedding: "test-embedding", reranker: true });
		const pages = await allPages(f.service, "alpha beta");
		expect(pages).toHaveLength(140);
		expect(new Set(pages.map(hit => hit.path)).size).toBe(140);
		const reranks = f.server.requests.filter(request => request.route.endsWith("/rerank"));
		expect(reranks).toHaveLength(1);
		const window = reranks[0]!.body.documents!.length;
		expect(window).toBeGreaterThan(0);
		expect(window).toBeLessThan(140);
		expect(identities(pages.slice(window))).toEqual(identities(base.slice(window)));
	}, 60_000);

	it("continues a fixed external ranking offline, rejects it after reopen, and retains old full-text cursors", async () => {
		const f = await fixture();
		await f.add("plain", lexicalFiles);
		const old = await f.service.search("alpha beta", { limit: 1 });
		expect(old.cursor).toBeTruthy();
		await f.configure({ embedding: "test-embedding", reranker: true });
		await f.add("vector", { "extra.md": "# Recovery\nRestart a failed checkpoint.\n" });
		// The old cursor's corpus changed above, so create a new baseline on the same snapshot.
		await f.configure();
		const fullOrder = await f.service.search("alpha beta");
		const full = await f.service.search("alpha beta", { limit: 1 });
		await f.configure({ embedding: "test-embedding", reranker: true });
		const legacyNext = await f.service.search("alpha beta", { limit: 1, cursor: full.cursor });
		expect(legacyNext.total).toBe(3);
		expect(legacyNext.sections).toEqual(fullOrder.sections.slice(1, 2));
		const first = await f.service.search("alpha beta", { limit: 1 });
		expect(first.cursor).toBeTruthy();
		const count = f.server.requests.length;
		f.server.setEmbedding("http");
		f.server.setRerank("http");
		const next = await f.service.search("alpha beta", { limit: 1, cursor: first.cursor });
		expect(next.sections).toHaveLength(1);
		expect(identities(next.sections)).not.toEqual(identities(first.sections));
		expect(f.server.requests).toHaveLength(count);
		await f.configure({ embedding: "test-embedding", reranker: true });
		await expect(f.service.search("alpha beta", { cursor: first.cursor })).rejects.toThrow();
	}, 30_000);

	it("keeps the failed-rerank full-text order across every continuation after recovery", async () => {
		const f = await fixture();
		await f.add("manual", lexicalFiles);
		const baseline = await f.service.search("alpha beta");
		expect(baseline.total).toBe(3);
		await f.configure({ reranker: true });
		f.server.setRerank("http");
		const first = await f.service.search("alpha beta", { limit: 1 });
		expect(first.total).toBe(baseline.total);
		expect(first.cursor).toBeTruthy();
		expect(f.server.requests.filter(request => request.route.endsWith("/rerank"))).toHaveLength(1);
		const count = f.server.requests.length;
		f.server.setRerank("reverse");
		const sections = [...first.sections];
		let cursor = first.cursor;
		for (let index = 1; index < baseline.total; index++) {
			expect(cursor).toBeTruthy();
			const page = await f.service.search("alpha beta", { limit: 1, cursor });
			expect(page.total).toBe(baseline.total);
			sections.push(...page.sections);
			expect(page.hasMore).toBe(Boolean(page.cursor));
			cursor = page.cursor;
		}
		expect(cursor).toBeUndefined();
		expect(identities(sections)).toEqual(identities(baseline.sections));
		expect(f.server.requests).toHaveLength(count);
		const recovered = await f.service.search("alpha beta");
		expect(identities(recovered.sections)).toEqual(identities(baseline.sections).reverse());
		expect(f.server.requests.filter(request => request.route.endsWith("/rerank"))).toHaveLength(2);
	}, 30_000);

	it("sends the same capped query to embedding and reranking and continues without model calls", async () => {
		const f = await fixture();
		await f.configure({ embedding: "test-embedding", reranker: true });
		await f.add("manual", lexicalFiles);
		const query = `alpha beta ${"z".repeat(510)}`;
		const expected = `${query.slice(0, 499)}…`;
		const count = f.server.requests.length;
		const first = await f.service.search(query, { limit: 1 });
		expect(first.total).toBe(3);
		expect(first.sections).toHaveLength(1);
		expect(first.cursor).toBeTruthy();
		const requests = f.server.requests.slice(count);
		const embeddings = requests.filter(request => request.route.endsWith("/embeddings"));
		const reranks = requests.filter(request => request.route.endsWith("/rerank"));
		expect(embeddings).toHaveLength(1);
		expect(reranks).toHaveLength(1);
		expect(embeddings[0]!.body.input).toEqual([expected]);
		expect(reranks[0]!.body.query).toBe(expected);
		const requestCount = f.server.requests.length;
		const sections = [...first.sections];
		let cursor = first.cursor;
		for (let index = 1; index < first.total; index++) {
			expect(cursor).toBeTruthy();
			const page = await f.service.search(query, { limit: 1, cursor });
			expect(page.total).toBe(first.total);
			sections.push(...page.sections);
			expect(page.hasMore).toBe(Boolean(page.cursor));
			cursor = page.cursor;
		}
		expect(cursor).toBeUndefined();
		expect(sections).toHaveLength(first.total);
		expect(new Set(identities(sections)).size).toBe(first.total);
		expect(f.server.requests).toHaveLength(requestCount);
	}, 30_000);

	it("does not send either model a grep query, including with configured failing services", async () => {
		const f = await fixture();
		await f.configure({ embedding: "test-embedding", reranker: true });
		await f.add("manual", lexicalFiles);
		f.server.setEmbedding("http");
		f.server.setRerank("http");
		const count = f.server.requests.length;
		const result = await f.service.search("alpha beta", { mode: "grep" });
		expect(result.total).toBe(3);
		expect(result.sections.every(hit => hit.matchKind === "regex")).toBe(true);
		expect(f.server.requests).toHaveLength(count);
	}, 30_000);

	it("falls back to fresh full-text evidence after repeated concurrent snapshot changes", async () => {
		const f = await fixture();
		await f.add("manual", lexicalFiles);
		await f.configure({ reranker: true });
		const db = new Database(f.service.databasePath, { strict: true });
		try {
			db.exec("CREATE TABLE search_race_probe (revision INTEGER); INSERT INTO search_race_probe VALUES (0)");
			f.server.setRerank("hold");
			const firstHeld = f.server.held();
			const pending = f.service.search("alpha beta", { limit: 1 });
			await firstHeld;
			db.exec("UPDATE search_race_probe SET revision=revision+1");
			f.server.releaseHeld();
			await f.server.held();
			db.exec("UPDATE search_race_probe SET revision=revision+1");
			f.server.releaseHeld();
			const first = await pending;
			expect(first.total).toBe(3);
			expect(first.sections[0]?.text).toContain("alpha beta");
			expect(first.cursor).toBeTruthy();
			const second = await f.service.search("alpha beta", { limit: 1, cursor: first.cursor });
			expect(second.sections[0]?.sectionId).not.toBe(first.sections[0]?.sectionId);
			expect(f.server.requests.filter(request => request.route.endsWith("/rerank"))).toHaveLength(2);
		} finally {
			f.server.releaseHeld();
			db.close();
		}
	}, 30_000);

	it.each(["update", "delete", "replace"] as const)(
		"rejects a semantic ranking after SQL %s changes stored evidence",
		async operation => {
			const f = await fixture();
			await f.configure({ embedding: "test-embedding" });
			await f.add("manual", lexicalFiles);
			const first = await f.service.search("alpha beta", { limit: 1 });
			expect(first.cursor).toBeTruthy();
			const db = new Database(f.service.databasePath, { strict: true });
			try {
				const id = first.sections[0]!.sectionId;
				if (operation === "update")
					db.query("UPDATE sections SET raw_markdown=? WHERE id=?").run("# Changed\nchanged evidence\n", id);
				else if (operation === "delete") db.query("DELETE FROM sections WHERE id=?").run(id);
				else {
					db.exec("PRAGMA foreign_keys=OFF");
					db.query("UPDATE sections SET id=id+100000 WHERE id=?").run(id);
				}
			} finally {
				db.close();
			}
			await expect(f.service.search("alpha beta", { cursor: first.cursor })).rejects.toThrow();
		},
		30_000,
	);

	it.each([false, true])(
		"reranks %s vector-backed base results without changing their evidence set",
		async vector => {
			const f = await fixture();
			await f.configure(vector ? { embedding: "test-embedding" } : {});
			await f.add("manual", lexicalFiles);
			const base = await f.service.search("alpha beta");
			await f.configure({ ...(vector ? { embedding: "test-embedding" } : {}), reranker: true });
			const ranked = await f.service.search("alpha beta");
			expect(identities(ranked.sections)).toEqual(identities(base.sections).reverse());
			expect(ranked.total).toBe(base.total);
			for (const hit of ranked.sections) {
				const prior = base.sections.find(section => section.sectionId === hit.sectionId)!;
				expect({ ...hit, rank: prior.rank }).toEqual(prior);
			}
		},
		30_000,
	);

	it("preserves base order on equal rerank scores", async () => {
		const f = await fixture();
		await f.add("manual", lexicalFiles);
		const base = await f.service.search("alpha beta");
		await f.configure({ reranker: true });
		f.server.setRerank("tie");
		const ranked = await f.service.search("alpha beta");
		expect(identities(ranked.sections)).toEqual(identities(base.sections));
		expect(f.server.requests.filter(request => request.route.endsWith("/rerank"))).toHaveLength(1);
	}, 30_000);

	it.each(["http", "duplicate", "range", "missing", "nan", "infinity"] as const)(
		"falls back to complete base ordering on reranker %s response",
		async mode => {
			const f = await fixture();
			await f.add("manual", lexicalFiles);
			const base = await f.service.search("alpha beta");
			await f.configure({ reranker: true });
			f.server.setRerank(mode);
			const result = await f.service.search("alpha beta");
			expect(result).toEqual(base);
			expect(f.server.requests.filter(request => request.route.endsWith("/rerank")).length).toBeGreaterThan(0);
		},
		30_000,
	);

	it("does not call a configured reranker for an empty database or a zero-hit full-text search", async () => {
		const f = await fixture();
		await f.configure({ reranker: true });
		await expect(f.service.search("alpha beta")).rejects.toThrow();
		expect(f.server.requests).toHaveLength(0);
		await f.add("manual", lexicalFiles);
		const result = await f.service.search("unrelated words");
		expect(result.total).toBe(0);
		expect(f.server.requests).toHaveLength(0);
	}, 30_000);

	it("aborts rather than falling back while a query embedding is in flight", async () => {
		const f = await fixture();
		await f.configure({ embedding: "test-embedding" });
		await f.add("manual", lexicalFiles);
		f.server.setEmbedding("hold");
		const held = f.server.held();
		const controller = new AbortController();
		const pending = f.service.search("alpha beta", { signal: controller.signal });
		await held;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	}, 30_000);

	it("aborts rather than delivering base results when an in-flight reranker is cancelled", async () => {
		const f = await fixture();
		await f.add("manual", lexicalFiles);
		await f.configure({ reranker: true });
		f.server.setRerank("hold");
		const held = f.server.held();
		const controller = new AbortController();
		const pending = f.service.search("alpha beta", { signal: controller.signal });
		await held;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	}, 30_000);
});
