import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	ptree,
	readLines,
	removeWithRetries,
	tryAcquireFileLock,
	withTimeout,
} from "@oh-my-pi/pi-utils";
import { KnowledgeService } from "../src/knowledge/service";
import {
	type JsonRpcResponse,
	MCP_PROTOCOL_VERSION,
	type MCPInitializeResult,
	type MCPToolCallResult,
	type MCPToolsListResult,
} from "../src/mcp/types";
import { restoreEnvValue } from "./helpers/settings-test-state";

// The CLI loads commands and workers dynamically; keep Bun's --changed graph honest.
import "../src/commands/knowledge";
import "../src/knowledge/engine";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	const errors: unknown[] = [];
	for (const cleanup of cleanups.splice(0).reverse()) {
		try {
			await cleanup();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length) throw new AggregateError(errors, "Knowledge MCP cleanup failed");
});

interface Query extends Record<string, unknown> {
	query: string;
	mode?: "search" | "grep";
	case?: boolean;
	path?: string;
	cursor?: string;
}

function text(result: MCPToolCallResult): string {
	return result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

function continuation(result: MCPToolCallResult): Query | undefined {
	const json = text(result).match(/^More results remain\. Continue with the same query: (.+)$/m)?.[1];
	return json ? (JSON.parse(json) as Query) : undefined;
}

const bodies = Array.from(
	{ length: 12 },
	(_, index) => `## Procedure ${index}\nMCPBEACON ${index} ${"complete evidence ".repeat(150)}\nEND_MCP_${index}\n`,
);

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-knowledge-mcp-"));
	cleanups.push(() => removeWithRetries(root));
	const previous = { ...process.env };
	const env: Record<string, string> = {};
	// Do not inherit provider credentials, user config, caches, or project settings.
	for (const key of [
		"PATH",
		"Path",
		"PATHEXT",
		"SYSTEMROOT",
		"SystemRoot",
		"WINDIR",
		"COMSPEC",
		"ComSpec",
		"TEMP",
		"TMP",
		"TMPDIR",
		"BUN_RUNTIME_TRANSPILER_CACHE_PATH",
	]) {
		if (previous[key] !== undefined) env[key] = previous[key];
	}
	Object.assign(env, {
		HOME: path.join(root, "home"),
		USERPROFILE: path.join(root, "home"),
		APPDATA: path.join(root, "appdata"),
		LOCALAPPDATA: path.join(root, "localappdata"),
		XDG_CONFIG_HOME: path.join(root, "xdg-config"),
		XDG_DATA_HOME: path.join(root, "xdg-data"),
		XDG_CACHE_HOME: path.join(root, "xdg-cache"),
		XDG_STATE_HOME: path.join(root, "xdg-state"),
		OMP_CONFIG_ROOT: path.join(root, "config"),
		OMP_CACHE_DIR: "",
		OMP_PROFILE: "",
		PI_PROFILE: "",
		PI_CODING_AGENT_DIR: "",
		OMP_OFFLINE: "0",
		PI_CONFIG_FILES: "",
		BUN_BE_BUN: "1",
	});
	for (const key of Object.keys(process.env)) restoreEnvValue(key, undefined);
	for (const [key, value] of Object.entries(env)) restoreEnvValue(key, value);
	__resetDirsFromEnvForTests();
	cleanups.push(() => {
		for (const key of Object.keys(process.env)) restoreEnvValue(key, undefined);
		for (const [key, value] of Object.entries(previous)) restoreEnvValue(key, value);
		__resetDirsFromEnvForTests();
	});
	const cwd = path.join(root, "project");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(env.HOME, { recursive: true });
	const agentDir = (profile?: string) =>
		path.join(env.OMP_CONFIG_ROOT, ...(profile ? ["profiles", profile] : []), "agent");
	async function configure(profile?: string, modelUrl?: string) {
		await fs.mkdir(agentDir(profile), { recursive: true });
		await Bun.write(
			path.join(agentDir(profile), "config.yml"),
			Bun.YAML.stringify({
				startup: { setupWizard: false },
				mnemopi: modelUrl
					? {
							noEmbeddings: false,
							embeddingModel: `embed-${profile ?? "default"}`,
							embeddingApiUrl: modelUrl,
							embeddingApiKey: `key-${profile ?? "default"}`,
						}
					: { noEmbeddings: true, embeddingModel: "", embeddingApiUrl: "", embeddingApiKey: "" },
				knowledge: {
					reranker: modelUrl
						? {
								model: `rerank-${profile ?? "default"}`,
								baseUrl: modelUrl,
								apiKey: `key-${profile ?? "default"}`,
							}
						: { model: "", baseUrl: "", apiKey: "" },
				},
			}),
		);
	}
	await configure();
	function service(profile?: string) {
		const instance = new KnowledgeService({ agentDir: agentDir(profile), cwd });
		// Never touch an inherited performance-root DB if isolation regresses.
		expect(instance.databasePath).toBe(path.join(agentDir(profile), "knowledge.db"));
		cleanups.push(() => instance.close());
		return instance;
	}
	const command = (args: string[], profile?: string) => [
		process.execPath,
		path.resolve(import.meta.dir, "../src/cli.ts"),
		...(profile ? ["--profile", profile] : []),
		"--cwd",
		cwd,
		...args,
	];
	async function cli(args: string[], profile?: string) {
		return ptree.exec(command(args, profile), {
			cwd,
			env,
			detached: process.platform !== "win32",
			subreaper: true,
			timeout: 30_000,
			stderr: "full",
			allowNonZero: true,
		});
	}
	async function source(
		files: Record<string, string> = {
			"procedures.md": bodies.join("\n"),
			"scope/guide.md": "# Guide\nMCPBEACON stored source.\nMixedCase needle\n",
		},
	) {
		const directory = await fs.mkdtemp(path.join(root, "source-"));
		for (const [name, body] of Object.entries(files)) {
			await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
			await Bun.write(path.join(directory, name), body);
		}
		return directory;
	}
	async function connect(profile?: string) {
		const child = ptree.spawn<"pipe">(command(["knowledge", "mcp"], profile), {
			cwd,
			env,
			stdin: "pipe",
			detached: process.platform !== "win32",
			subreaper: true,
			timeout: 90_000,
		});
		let sequence = 0;
		const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
		const responses: JsonRpcResponse[] = [];
		// Unlike tolerant clients, reject every non-protocol stdout line.
		const reading = (async () => {
			try {
				for await (const line of readLines(child.stdout)) {
					const response = JSON.parse(new TextDecoder().decode(line)) as JsonRpcResponse;
					expect(response.jsonrpc).toBe("2.0");
					expect(typeof response.id).toBe("number");
					responses.push(response);
					const receiver = pending.get(Number(response.id));
					pending.delete(Number(response.id));
					if (response.error) receiver?.reject(new Error(JSON.stringify(response.error)));
					else receiver?.resolve(response.result);
				}
			} finally {
				for (const receiver of pending.values()) receiver.reject(new Error("MCP stdout closed"));
				pending.clear();
			}
		})();
		// Observe failures immediately; EOF and cleanup still await the original promise.
		void reading.catch(() => {});
		cleanups.push(async () => {
			child.kill();
			await Promise.allSettled([child.exitedCleanly, reading]);
		});
		function send(method: string, params?: Record<string, unknown>, id?: number) {
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params, ...(id === undefined ? {} : { id }) })}\n`,
			);
			void child.stdin.flush();
		}
		function start<T>(method: string, params?: Record<string, unknown>, id = ++sequence) {
			const deferred = Promise.withResolvers<unknown>();
			pending.set(id, deferred);
			send(method, params, id);
			const result = withTimeout(deferred.promise, 25_000, new Error(`MCP ${method} timed out`)) as Promise<T>;
			void result.catch(() => {});
			return { id, result };
		}
		const request = <T>(method: string, params?: Record<string, unknown>) => start<T>(method, params).result;
		const initialized = await request<MCPInitializeResult>("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "knowledge-consumer-test", version: "1" },
		});
		send("notifications/initialized");
		return {
			initialized,
			responses,
			request,
			start,
			call: (args: Record<string, unknown>) =>
				request<MCPToolCallResult>("tools/call", { name: "knowledge_search", arguments: args }),
			cancel(id: number) {
				send("notifications/cancelled", { requestId: id, reason: "consumer cancellation" });
				pending.get(id)?.reject(new Error("consumer cancellation"));
				pending.delete(id);
			},
			async eof() {
				await child.stdin.end();
				expect(await withTimeout(child.exitedCleanly, 10_000, new Error("MCP did not exit after stdin EOF"))).toBe(
					0,
				);
				await reading;
			},
		};
	}
	return { root, cwd, agentDir, configure, service, cli, source, connect };
}

/** Real local wire fixture; only optional model inference is scripted. */
function modelServer() {
	const requests: Array<{ model: string; authorization: string | null }> = [];
	let held = Promise.withResolvers<void>();
	const releases = new Set<() => void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as {
				model: string;
				input?: string | string[];
				query?: string;
				documents?: string[];
			};
			requests.push({ model: body.model, authorization: request.headers.get("authorization") });
			const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
			if (inputs.some(input => input.includes("HOLDMCPMODEL"))) {
				const release = Promise.withResolvers<void>();
				releases.add(release.resolve);
				held.resolve();
				held = Promise.withResolvers<void>();
				try {
					await release.promise;
				} finally {
					releases.delete(release.resolve);
				}
			}
			if (new URL(request.url).pathname.endsWith("/embeddings")) {
				return Response.json({
					object: "list",
					model: body.model,
					data: inputs.map((_, index) => ({ object: "embedding", index, embedding: [1, 0, 0] })),
				});
			}
			if (new URL(request.url).pathname.endsWith("/rerank")) {
				return Response.json({
					model: body.model,
					results: (body.documents ?? []).map((_, index) => ({ index, relevance_score: index })),
				});
			}
			return new Response("unexpected model route", { status: 404 });
		},
	});
	function releaseHeld() {
		for (const release of releases) release();
		releases.clear();
	}
	cleanups.push(() => {
		releaseHeld();
		server.stop(true);
	});
	return { url: `http://127.0.0.1:${server.port}/v1`, requests, held: () => held.promise, release: releaseHeld };
}

async function legacyDatabase(databasePath: string) {
	const db = new Database(databasePath, { strict: true, create: true });
	try {
		db.exec(await Bun.file(path.join(import.meta.dir, "fixtures/docs-v3.sql")).text());
		db.exec(
			"INSERT INTO doc_indexes(id,name,root_path,schema_id,schema_version,schema_json,schema_hash,state,created_at,updated_at) VALUES(7,'legacy','/removed-source','dft',1,'{}','old','ready','created','updated')",
		);
		db.exec(
			"INSERT INTO documents(id,index_id,relative_path,title,source_kind,sha256,size_bytes,mtime_ms,status) VALUES(7,7,'legacy.md','Guide','markdown','legacy-sha',40,0,'ready')",
		);
		db.query(
			"INSERT INTO sections(id,index_id,document_id,ordinal,heading_path,heading_level,line_start,line_end,byte_start,byte_end,raw_markdown) VALUES(7,7,7,0,'Guide',1,1,2,0,40,?)",
		).run("# Guide\nMCPLEGACY original complete evidence\n");
		db.exec(
			"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) VALUES(7,7,7,'legacy.md','Guide','MCPLEGACY original complete evidence')",
		);
	} finally {
		db.close();
	}
}

describe("knowledge MCP real stdio consumers", () => {
	it.serial(
		"discovers one read-only tool, preserves complete pages and reports recoverable errors without a chat model",
		async () => {
			const f = await fixture();
			const documents = await f.source();
			const initialized = await f.cli(["knowledge", "init", documents, "--name", "manual", "--json"]);
			expect(initialized.exitCode).toBe(0);
			expect(JSON.parse(initialized.stdout).index.documentCount).toBe(2);
			await fs.rm(documents, { recursive: true });
			const client = await f.connect();
			const tools = await client.request<MCPToolsListResult>("tools/list");
			expect(tools.tools.map(tool => tool.name)).toEqual(["knowledge_search"]);
			expect(tools.tools[0]?.annotations?.readOnlyHint).toBe(true);
			const pages: string[] = [];
			let args: Query = { query: "  MCPBEACON  ", unrelated: "ignored" };
			for (let count = 0; count < 20; count++) {
				const started = performance.now();
				const page = await client.call(args);
				expect(performance.now() - started).toBeGreaterThanOrEqual(500);
				expect(page.isError).not.toBe(true);
				pages.push(text(page));
				const next = continuation(page);
				if (!next) break;
				args = next;
			}
			expect(pages.length).toBeGreaterThan(1);
			expect(pages.at(-1)).toMatch(/exhaust|no (?:more|further) results/i);
			const all = pages.join("\n");
			for (const body of bodies) expect(all).toContain(body.trimEnd());
			for (let index = 0; index < bodies.length; index++) expect(all.split(`END_MCP_${index}\n`)).toHaveLength(2);
			expect(all).toMatch(/manual/);
			expect(all).toMatch(/sha256|sha-256/i);
			expect(all).toMatch(/sectionId/i);
			expect(all).toMatch(/retrieval:\s*fulltext/i);
			const grep = await client.call({ query: "mixedcase", mode: "grep", case: false, path: "scope/guide.md" });
			expect(grep.isError).not.toBe(true);
			expect(text(grep)).toContain("MixedCase needle");
			expect(text(grep)).not.toContain("END_MCP_");
			const started = performance.now();
			const empty = await client.call({ query: "MCPABSENTTOKEN" });
			expect(performance.now() - started).toBeGreaterThanOrEqual(500);
			expect(empty.isError).not.toBe(true);
			expect(text(empty)).toMatch(/0|no (?:matching|results|matches)/i);
			expect(text(empty)).toMatch(/exhaust|no (?:more|further) results/i);
			for (const invalid of [
				{},
				{ query: " " },
				{ query: "[", mode: "grep" },
				{ query: "MCPBEACON", cursor: "broken" },
			]) {
				const result = await client.call(invalid);
				expect(result.isError).toBe(true);
				expect(text(result)).toMatch(/query|regex|regular expression|cursor/i);
			}
			expect(text(await client.call({ query: "MCPBEACON", path: "scope/guide.md" }))).toContain("stored source.");
			await client.eof();
			const removed = await f.cli(["knowledge", "remove", "manual", "--force", "--json"]);
			expect(removed.exitCode).toBe(0);
		},
		120_000,
	);

	it.serial(
		"rejects only management arguments for mcp through CLI usage errors before opening storage",
		async () => {
			const f = await fixture();
			for (const args of [["unexpected"], ["--name", "manual"], ["--force"], ["--json"]]) {
				const result = await f.cli(["knowledge", "mcp", ...args]);
				expect(result.exitCode).toBe(2);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("knowledge mcp does not accept");
				expect(await Bun.file(path.join(f.agentDir(), "knowledge.db")).exists()).toBe(false);
			}
			const client = await f.connect();
			const missing = await client.call({ query: "MCPBEACON" });
			expect(missing.isError).toBe(true);
			expect(text(missing)).toMatch(/knowledge init/i);
			const documents = await f.source();
			await f.service().init(documents, "manual");
			expect((await client.call({ query: "MCPBEACON" })).isError).not.toBe(true);
			await client.eof();
		},
		120_000,
	);

	it.serial(
		"shares one database across two MCP and two OMP services while cancellation, EOF and maintenance stay owner scoped",
		async () => {
			const f = await fixture();
			const writer = f.service();
			const reader = f.service();
			const documents = await f.source();
			await writer.init(documents, "manual");
			await fs.rm(documents, { recursive: true });
			const [a, b] = await Promise.all([f.connect(), f.connect()]);
			const [pageA, pageB, ompA, ompB] = await Promise.all([
				a.call({ query: "MCPBEACON" }),
				b.call({ query: "MCPBEACON" }),
				writer.searchKnowledge("MCPBEACON"),
				reader.searchKnowledge("MCPBEACON"),
			]);
			expect(text(pageA)).toBe(text(pageB));
			expect(text(pageA)).toBe(ompA.text);
			expect(ompA.text).toBe(ompB.text);
			const next = continuation(pageB);
			expect(next?.cursor).toBeTruthy();
			const active = a.start<MCPToolCallResult>("tools/call", {
				name: "knowledge_search",
				arguments: { query: "MCPBEACON" },
			});
			await Bun.sleep(50);
			a.cancel(active.id);
			await expect(active.result).rejects.toThrow("consumer cancellation");
			expect((await a.call({ query: "MCPBEACON" })).isError).not.toBe(true);
			await a.eof();
			expect(a.responses.some(response => response.id === active.id)).toBe(false);
			expect((await b.call(next!)).isError).not.toBe(true);
			expect((await reader.searchKnowledge("MCPBEACON")).result.total).toBe(13);
			await writer.remove("manual");
			const stale = await b.call(next!);
			expect(stale.isError).toBe(true);
			expect(text(stale)).toMatch(/cursor|index/i);
			const replacement = await f.source({
				"replacement.md": "# Replacement\nMCPREPLACEMENT current published source\n",
			});
			await writer.init(replacement, "manual");
			expect(text(await b.call({ query: "MCPREPLACEMENT" }))).toContain("current published source");
			expect((await reader.searchKnowledge("MCPREPLACEMENT")).result.total).toBe(1);
			await b.eof();
		},
		120_000,
	);

	it.serial(
		"keeps named-profile corpus and optional-model credentials separate from the default connection",
		async () => {
			const f = await fixture();
			const models = modelServer();
			await f.configure(undefined, models.url);
			await f.configure("separate", models.url);
			await f
				.service()
				.init(await f.source({ "default.md": "# Default\nMCPDEFAULT private default corpus\n" }), "manual");
			await f
				.service("separate")
				.init(await f.source({ "named.md": "# Named\nMCPNAMED private named corpus\n" }), "manual");
			const queryCallsStart = models.requests.length;
			const [a, b] = await Promise.all([f.connect(), f.connect("separate")]);
			const [first, second] = await Promise.all([a.call({ query: "MCPDEFAULT" }), b.call({ query: "MCPNAMED" })]);
			expect(text(first)).toContain("private default corpus");
			expect(text(first)).not.toContain("private named corpus");
			expect(text(second)).toContain("private named corpus");
			expect(text(second)).not.toContain("private default corpus");
			const queryRequests = models.requests.slice(queryCallsStart);
			for (const request of queryRequests) {
				expect(request.authorization).toBe(
					`Bearer key-${request.model.endsWith("separate") ? "separate" : "default"}`,
				);
			}
			expect(queryRequests.some(request => request.model === "embed-default")).toBe(true);
			expect(queryRequests.some(request => request.model === "embed-separate")).toBe(true);
			await Promise.all([a.eof(), b.eof()]);
		},
		120_000,
	);

	it.serial(
		"migrates an old shared schema under concurrent MCP and OMP opens without losing stored evidence",
		async () => {
			const f = await fixture();
			await legacyDatabase(path.join(f.agentDir(), "knowledge.db"));
			const writer = f.service();
			const reader = f.service();
			const [a, b] = await Promise.all([f.connect(), f.connect()]);
			const readMcp = async (client: typeof a) => {
				const result = await client.call({ query: "MCPLEGACY" });
				if (result.isError) throw new Error(text(result));
				return text(result);
			};
			const results = await Promise.allSettled([
				readMcp(a),
				readMcp(b),
				writer.searchKnowledge("MCPLEGACY").then(page => page.text),
				reader.searchKnowledge("MCPLEGACY").then(page => page.text),
			]);
			for (const result of results) {
				if (result.status === "rejected") expect(String(result.reason)).toMatch(/acquire lock|locked|busy/i);
				else expect(result.value).toContain("MCPLEGACY original complete evidence");
			}
			// Bounded contention may fail an initial open; neither connection needs restarting.
			for (const client of [a, b]) {
				const result = await client.call({ query: "MCPLEGACY" });
				expect(result.isError).not.toBe(true);
				expect(text(result)).toContain("MCPLEGACY original complete evidence");
				expect(text(result)).toContain("legacy.md");
				expect(text(result)).toContain("legacy-sha");
			}
			expect((await reader.searchKnowledge("MCPLEGACY")).result.sections[0]?.text).toBe(
				"# Guide\nMCPLEGACY original complete evidence\n",
			);
			await Promise.all([a.eof(), b.eof()]);
		},
		120_000,
	);

	it.serial(
		"reports bounded opening-lock failure and retries the same connection after competing migration completes",
		async () => {
			const f = await fixture();
			const database = path.join(f.agentDir(), "knowledge.db");
			await legacyDatabase(database);
			const lock = tryAcquireFileLock(database);
			expect(lock).not.toBeNull();
			cleanups.push(() => lock?.release());
			const client = await f.connect();
			const failed = await client.call({ query: "MCPLEGACY" });
			expect(failed.isError).toBe(true);
			expect(text(failed)).toMatch(/acquire lock|locked|busy/i);
			lock!.release();
			const peer = f.service();
			expect((await peer.searchKnowledge("MCPLEGACY")).result.total).toBe(1);
			const recovered = await client.call({ query: "MCPLEGACY" });
			expect(recovered.isError).not.toBe(true);
			expect(text(recovered)).toContain("MCPLEGACY original complete evidence");
			expect(text(recovered)).toContain("legacy-sha");
			await client.eof();
		},
		120_000,
	);

	it.serial(
		"cancels model waits and queued requests without late results, invalidates only owned mixed cursors, and shuts down active work on EOF",
		async () => {
			const f = await fixture();
			const models = modelServer();
			await f.configure(undefined, models.url);
			await f.service().init(await f.source(), "manual");
			const [a, b] = await Promise.all([f.connect(), f.connect()]);
			const [firstA, firstB] = await Promise.all([a.call({ query: "MCPBEACON" }), b.call({ query: "MCPBEACON" })]);
			expect(text(firstA)).toMatch(/retrieval:\s*hybrid/i);
			const nextA = continuation(firstA);
			const nextB = continuation(firstB);
			expect(nextA?.cursor).toBeTruthy();
			expect(nextB?.cursor).toBeTruthy();
			const queuedPeerHeld = models.held();
			const queuedPeer = a.start<MCPToolCallResult>("tools/call", {
				name: "knowledge_search",
				arguments: { query: "HOLDMCPMODEL queued peer" },
			});
			await withTimeout(queuedPeerHeld, 10_000, new Error("query never reached the local model fixture"));
			const queued = a.start<MCPToolCallResult>("tools/call", {
				name: "knowledge_search",
				arguments: { query: "MCPBEACON" },
			});
			a.cancel(queued.id);
			await expect(queued.result).rejects.toThrow("consumer cancellation");
			models.release();
			expect((await queuedPeer.result).isError).not.toBe(true);
			expect((await a.call(nextA!)).isError).not.toBe(true);
			const activeHeld = models.held();
			// JSON-RPC request id zero is valid and must not evade cancellation routing.
			const active = a.start<MCPToolCallResult>(
				"tools/call",
				{ name: "knowledge_search", arguments: { query: "HOLDMCPMODEL cancelled" } },
				0,
			);
			await withTimeout(activeHeld, 10_000, new Error("cancellable query never reached the local model fixture"));
			a.cancel(active.id);
			await expect(active.result).rejects.toThrow("consumer cancellation");
			const stale = await a.call(nextA!);
			expect(stale.isError).toBe(true);
			expect(text(stale)).toMatch(/cursor|restart|new search|without.*cursor/i);
			expect((await b.call(nextB!)).isError).not.toBe(true);
			expect((await a.call({ query: "MCPBEACON" })).isError).not.toBe(true);
			expect(a.responses.some(response => response.id === active.id || response.id === queued.id)).toBe(false);
			const eofHeld = models.held();
			const unfinished = a.start<MCPToolCallResult>("tools/call", {
				name: "knowledge_search",
				arguments: { query: "HOLDMCPMODEL eof" },
			});
			await withTimeout(eofHeld, 10_000, new Error("EOF query never reached the local model fixture"));
			await a.eof();
			await expect(unfinished.result).rejects.toThrow();
			expect(a.responses.some(response => response.id === unfinished.id)).toBe(false);
			expect((await b.call({ query: "MCPBEACON" })).isError).not.toBe(true);
			await b.eof();
		},
		120_000,
	);
});
