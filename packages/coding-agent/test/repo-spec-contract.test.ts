import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import { Settings } from "../src/config/settings";
import { OmpIndexesBridge } from "../src/modes/zcode/indexes";
import { RepoService } from "../src/repo/service";
import type { RepoQueryResult, RepoSymbolHit, RepoTextHit } from "../src/repo/types";
import { createTools, type ToolSession } from "../src/tools";
import { RepoTool } from "../src/tools/repo";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(files: Record<string, string> = {}) {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-spec-"));
	cleanups.push(() => fs.rm(temporary, { recursive: true, force: true }));
	const root = path.join(temporary, "project");
	const agentDir = path.join(temporary, "profile");
	await fs.mkdir(root);
	await fs.mkdir(agentDir);
	for (const [relative, text] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
		await fs.writeFile(path.join(root, relative), text);
	}
	const service = new RepoService({ cwd: root, agentDir });
	cleanups.push(() => service.close());
	return { root, agentDir, service };
}

async function bridgeFixture() {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-bridge-spec-"));
	cleanups.push(() => fs.rm(temporary, { recursive: true, force: true }));
	const root = path.join(temporary, "project");
	const agentDir = path.join(temporary, "profile");
	await fs.mkdir(root);
	await fs.mkdir(agentDir);
	const canonicalRoot = await fs.realpath(root);
	const workspace = {
		workspacePath: canonicalRoot,
		workspaceIdentity: "repo-spec:local",
		workspaceKey: "repo-spec:local",
	};
	const bridge = new OmpIndexesBridge({ agentDir, notify() {} });
	cleanups.push(() => bridge.dispose());
	let operation = 0;
	return {
		root: canonicalRoot,
		agentDir,
		request(action: string, fields: Record<string, unknown> = {}) {
			return bridge.handleRepo(action, { workspace, operationId: `spec-${++operation}`, ...fields });
		},
	};
}

describe("repository approved-spec boundaries", () => {
	// Candidate overflow must fail the entire query, including a cached/repeated query.
	it("accepts 100000 candidates, rejects 100001 without partial pages, and permits narrowing", async () => {
		const { service } = await fixture();
		await service.build();
		const generation = (await service.status()).generation!;
		// Seed real persisted rows rather than creating 100000 OS files or mocking retrieval.
		service.storage.transaction(() => {
			service.storage.db
				.query(`
				WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<100000)
				INSERT INTO files(id,generation,path,category,hash,size,mtime,text)
				SELECT id,?,printf('src/%06d.py',id),'source','fixture',10,0,'massbeacon' FROM n
			`)
				.run(generation);
			service.storage.db.exec("INSERT INTO files_fts(rowid,text) SELECT id,text FROM files");
			service.storage.db.exec(`
				INSERT INTO symbols(file_id,name,qualname,name_folded,qualname_folded,kind,start_line,end_line,signature)
				SELECT id,'massbeacon','massbeacon','massbeacon','massbeacon','function',1,1,'def massbeacon():' FROM files
			`);
		});
		for (const action of ["search", "symbol"] as const) {
			const accepted = await service[action]("massbeacon");
			expect(accepted.hits).toHaveLength(20);
			expect(accepted.truncated).toBe(true);
			expect(accepted.cursor).toBeDefined();
		}
		service.storage.transaction(() => {
			service.storage.insertFile(
				{
					path: "overflow.py",
					category: "source",
					hash: "overflow",
					size: 10,
					mtimeMs: 0,
					text: "massbeacon",
					symbols: [
						{
							name: "massbeacon",
							qualname: "massbeacon",
							kind: "function",
							startLine: 1,
							endLine: 1,
							signature: "def massbeacon():",
						},
					],
				},
				generation,
			);
			// A published content change invalidates the locator cache, as in maintenance.
			service.storage.db.exec(
				"UPDATE state SET generation='overflow-generation'; UPDATE files SET generation='overflow-generation'",
			);
		});
		for (const action of ["search", "symbol"] as const) {
			for (let attempt = 0; attempt < 2; attempt++)
				await expect(service[action]("massbeacon")).rejects.toThrow(/exceeds candidate limit; narrow/);
			const narrowed = await service[action]("massbeacon", { path: "overflow.py" });
			expect(narrowed.hits).toMatchObject([{ path: "overflow.py", startLine: 1 }]);
			expect(narrowed.cursor).toBeUndefined();
			expect(narrowed.truncated).toBe(false);
		}
	});

	// Index storage is independent of the source tree after a successful full check.
	it("serves checked status, text and symbols from SQLite after source removal", async () => {
		const { root, service } = await fixture({ "src/cache.py": "def archive_beacon(value=7): return value\n" });
		await service.build();
		const before = await service.status();
		await fs.rm(path.join(root, "src"), { recursive: true });
		expect(await service.status()).toEqual(before);
		expect((await service.search("archive_beacon")).hits).toMatchObject([
			{ path: "src/cache.py", startLine: 1, snippet: "def archive_beacon(value=7): return value" },
		]);
		expect((await service.symbol("archive_beacon")).hits).toMatchObject([
			{ path: "src/cache.py", kind: "function", signature: "def archive_beacon(value=7):" },
		]);
	});

	// A disappeared directory must fail enumeration, not certify an empty replacement tree.
	it("retains the published generation and exposes uncertainty when the root directory disappears", async () => {
		const { root, service } = await fixture({ "source.py": "def directory_beacon(): pass\n" });
		await service.build();
		const before = await service.status();
		const moved = `${root}-moved`;
		await fs.rename(root, moved);
		try {
			await expect(service.reconcile()).rejects.toThrow();
			expect(await service.status()).toMatchObject({
				generation: before.generation,
				fileCount: 1,
				unchecked: true,
				needsReconcile: true,
			});
			expect((await service.status()).uncertainReasons.join("\n")).toContain("reconcile failed");
			expect((await service.symbol("directory_beacon")).hits).toMatchObject([
				{ path: "source.py", name: "directory_beacon" },
			]);
		} finally {
			await fs.rename(moved, root);
		}
		await service.reconcile();
		expect((await service.status()).unchecked).toBe(false);
		expect(await fs.readFile(path.join(root, "source.py"), "utf8")).toBe("def directory_beacon(): pass\n");
	});

	// Parser failures cannot leave earlier module/function records searchable.
	it("keeps comment-only-suite text but drops every definition and clears failure after repair", async () => {
		const { root, service } = await fixture({ "suite.py": "def previous_definition(): pass\n" });
		await service.build();
		await fs.writeFile(
			path.join(root, "suite.py"),
			"def previous_definition(): pass\nclass Broken:\n    # commentsuitebeacon\n",
		);
		service.markChanged(["suite.py"]);
		expect((await service.search("commentsuitebeacon")).hits).toMatchObject([{ path: "suite.py", startLine: 3 }]);
		expect((await service.symbol("previous_definition")).hits).toEqual([]);
		expect((await service.symbol("suite")).hits).toEqual([]);
		expect((await service.status()).failures).toMatchObject([{ path: "suite.py", kind: "parse" }]);
		await fs.writeFile(path.join(root, "suite.py"), "class Repaired:\n    # commentsuitebeacon\n    pass\n");
		service.markChanged(["suite.py"]);
		expect((await service.symbol("Repaired")).hits).toMatchObject([
			{ path: "suite.py", kind: "class", name: "Repaired", startLine: 1, endLine: 3, signature: "class Repaired:" },
		]);
		expect((await service.status()).failures).toEqual([]);
	});

	// UTF-8 rejection and the 2 MiB boundary apply on Windows as well as POSIX.
	it("indexes hidden text and exactly 2 MiB while reporting invalid UTF-8 and oversized files", async () => {
		const { root, service } = await fixture({ ".hidden/beacon.txt": "hiddenbeacon\n" });
		await fs.writeFile(path.join(root, "limit.txt"), `limitbeacon${" ".repeat(2 * 1024 * 1024 - 11)}`);
		await fs.writeFile(path.join(root, "oversized.txt"), "x".repeat(2 * 1024 * 1024 + 1));
		await fs.writeFile(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
		await service.build();
		expect((await service.search("hiddenbeacon")).hits).toMatchObject([
			{ path: ".hidden/beacon.txt", category: "other" },
		]);
		expect((await service.search("limitbeacon")).hits).toMatchObject([{ path: "limit.txt", startLine: 1 }]);
		expect(await service.status()).toMatchObject({ fileCount: 2, failureCount: 2, incomplete: true });
		expect((await service.status()).failures).toEqual([
			{ path: "invalid.txt", kind: "binary", message: "Invalid UTF-8" },
			{ path: "oversized.txt", kind: "oversize", message: "File exceeds 2097152 bytes" },
		]);
	});

	// Unchanged fingerprints reuse old parser evidence; only rebuild reparses it.
	it("retains historical parser failures on update and repairs them on explicit rebuild", async () => {
		const { service } = await fixture({ "legacy.py": "def recovered_definition(): pass\n" });
		await service.build();
		const generation = (await service.status()).generation!;
		service.storage.transaction(() => {
			service.storage.db.exec("DELETE FROM symbols");
			service.storage.putFailure(
				{ path: "legacy.py", kind: "parse", message: "legacy parser rejected this definition" },
				generation,
			);
		});
		await service.reconcile();
		expect((await service.symbol("recovered_definition")).hits).toEqual([]);
		expect((await service.status()).failures).toMatchObject([{ path: "legacy.py", kind: "parse" }]);
		await service.rebuild();
		expect((await service.symbol("recovered_definition")).hits).toMatchObject([
			{ path: "legacy.py", name: "recovered_definition", signature: "def recovered_definition():" },
		]);
		expect((await service.status()).failures).toEqual([]);
	});

	// Profile identity must separate generations even for the exact same root.
	it("isolates profiles for one canonical project root", async () => {
		const { root, agentDir, service } = await fixture({ "scope.py": "def profile_alpha(): pass\n" });
		await service.build();
		const peer = new RepoService({ cwd: root, agentDir: `${agentDir}-other` });
		cleanups.push(() => peer.close());
		expect((await peer.status()).exists).toBe(false);
		await fs.writeFile(path.join(root, "scope.py"), "def profile_beta(): pass\n");
		await peer.build();
		expect((await service.symbol("profile_alpha")).hits).toMatchObject([{ path: "scope.py", name: "profile_alpha" }]);
		expect((await service.symbol("profile_beta")).hits).toEqual([]);
		expect((await peer.symbol("profile_beta")).hits).toMatchObject([{ path: "scope.py", name: "profile_beta" }]);
		expect((await peer.symbol("profile_alpha")).hits).toEqual([]);
	});

	// Cursor identity uses the chosen normalized scope, action and original query.
	it("accepts equivalent path cursors but rejects cross-action, cross-path and cross-query cursors", async () => {
		const { service } = await fixture({
			"src/a.py": "def cursorbeacon(): pass\n",
			"src/b.py": "def cursorbeacon(): pass\n",
			"other/c.py": "def cursorbeacon(): pass\n",
		});
		await service.build();
		for (const action of ["search", "symbol"] as const) {
			const first = await service[action]("cursorbeacon", { path: "./src//", limit: 1 });
			expect(first.cursor).toBeDefined();
			const second = await service[action]("cursorbeacon", { path: "src/../src", limit: 1, cursor: first.cursor });
			expect([...first.hits, ...second.hits].map(hit => hit.path)).toEqual(["src/a.py", "src/b.py"]);
			expect(second.cursor).toBeUndefined();
			await expect(service[action]("cursorbeacon", { path: "other", cursor: first.cursor })).rejects.toThrow(
				"Invalid repository index cursor",
			);
			await expect(service[action]("CURSORBEACON", { path: "src", cursor: first.cursor })).rejects.toThrow(
				"Invalid repository index cursor",
			);
			const other = action === "search" ? "symbol" : "search";
			await expect(service[other]("cursorbeacon", { path: "src", cursor: first.cursor })).rejects.toThrow(
				"Invalid repository index cursor",
			);
		}
	});
});

describe("Repo ZCode bridge query boundaries", () => {
	for (const indexed of [false, true]) {
		// The missing-index fast path must not bypass the same service contract.
		it(`rejects overlong UTF-16 queries before returning ${indexed ? "indexed" : "missing"} results`, async () => {
			const f = await bridgeFixture();
			if (indexed) await f.request("init", { confirmedRoot: f.root });
			for (const action of ["text", "symbol"]) {
				const accepted = (await f.request(action, { query: "😀".repeat(250) })) as RepoQueryResult<RepoTextHit>;
				expect(accepted.status).toBe(indexed ? "ok" : "missing");
				expect(accepted.hits).toEqual([]);
				for (const query of ["x".repeat(501), `${"😀".repeat(250)}x`])
					await expect(f.request(action, { query })).rejects.toThrow(
						"Repository query exceeds 500 characters; narrow it.",
					);
			}
			if (!indexed) expect(await fs.readdir(f.agentDir)).toEqual([]);
		});
	}

	// Without an index there can be no literal-backslash identity to prefer.
	it("rejects escaping Windows-style paths on the missing-index bridge without creating storage", async () => {
		const f = await bridgeFixture();
		for (const action of ["text", "symbol"]) {
			for (const filter of ["../outside", "..\\outside", "src\\..\\..\\outside"])
				await expect(f.request(action, { query: "probe", path: filter })).rejects.toThrow(
					"Repository path must stay within the index root",
				);
		}
		expect(await fs.readdir(f.agentDir)).toEqual([]);
	});

	// GUI requests may ask for a larger page but may never receive more than 20.
	it("caps both bridge query actions at 20 and preserves complete non-overlapping continuation", async () => {
		const f = await bridgeFixture();
		for (let index = 0; index < 25; index++)
			await fs.writeFile(path.join(f.root, `${String(index).padStart(2, "0")}.py`), "def bridgebeacon(): pass\n");
		await f.request("init", { confirmedRoot: f.root });
		for (const action of ["text", "symbol"]) {
			const first = (await f.request(action, { query: "bridgebeacon", limit: 50 })) as RepoQueryResult<
				RepoTextHit | RepoSymbolHit
			>;
			expect(first.hits).toHaveLength(20);
			expect(first.cursor).toBeDefined();
			const second = (await f.request(action, {
				query: "bridgebeacon",
				limit: 50,
				cursor: first.cursor,
			})) as typeof first;
			expect(second.hits).toHaveLength(5);
			expect(new Set([...first.hits, ...second.hits].map(hit => hit.path)).size).toBe(25);
			expect(second.cursor).toBeUndefined();
		}
	});
});

describe("Repo AI tool input contract", () => {
	// The schema offers only read-only fields; shared argument validation strips unknown keys.
	it("offers only read-only query fields, rejects maintenance actions, and keeps missing queries actionable", async () => {
		const f = await bridgeFixture();
		const tool = new RepoTool({
			cwd: f.root,
			settings: Object.assign(Settings.isolated({}), { getAgentDir: () => f.agentDir }),
		} as unknown as ToolSession);
		const validate = (arguments_: Record<string, unknown>) =>
			validateToolArguments(tool, { type: "toolCall", id: "spec-input", name: "repo", arguments: arguments_ });
		const wire = tool.parameters.toJsonSchema() as { properties: Record<string, unknown> };
		expect(Object.keys(wire.properties).sort()).toEqual(["action", "cursor", "path", "query"]);
		expect(() => validate({ action: "build" })).toThrow();
		for (const args of [
			{ query: "probe", category: "source" },
			{ query: "probe", limit: 1 },
			{ query: "probe", rebuild: true },
		])
			expect(validate(args)).toEqual({ query: "probe" });
		for (const action of [undefined, "search", "symbol"] as const) {
			const result = await tool.execute("spec-missing", { ...(action ? { action } : {}), query: "probe" });
			expect(result.details).toMatchObject({ queryStatus: "missing", hits: [] });
			expect(result.content).toContainEqual({
				type: "text",
				text: expect.stringContaining("Open /repo to build one; use read/grep"),
			});
			const accepted = await tool.execute("spec-limit", { ...(action ? { action } : {}), query: "😀".repeat(250) });
			expect(accepted.details).toMatchObject({ queryStatus: "missing", hits: [] });
			for (const query of ["x".repeat(501), `${"😀".repeat(250)}x`])
				await expect(tool.execute("spec-overlimit", { ...(action ? { action } : {}), query })).rejects.toThrow(
					"Repository query exceeds 500 characters; narrow it.",
				);
		}
		expect(await fs.readdir(f.agentDir)).toEqual([]);
	});

	// Disabling devices changes discovery only, not read-only query behavior.
	it("exposes repo directly when xdev is disabled without creating an index for queries", async () => {
		const f = await bridgeFixture();
		const session = {
			cwd: f.root,
			hasUI: false,
			settings: Object.assign(Settings.isolated({ "tools.xdev": false }), { getAgentDir: () => f.agentDir }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
		const tools = await createTools(session);
		const repo = tools.find(tool => tool.name === "repo");
		if (!repo) throw new Error("xdev=false must retain the top-level repo tool");
		expect(repo.approval).toBe("read");
		const result = await repo.execute("spec-direct", { query: "probe" });
		expect(result.details).toMatchObject({ queryStatus: "missing", hits: [] });
		expect(await fs.readdir(f.agentDir)).toEqual([]);
	});
});
