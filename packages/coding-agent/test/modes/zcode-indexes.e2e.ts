import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { DOCS_WORKER_ARG } from "../../src/cli/worker-selectors";
import { DocsService } from "../../src/docs/service";
import type { DocsBuildResult, DocsSearchResult } from "../../src/docs/types";
import type { DocsWorkerInbound } from "../../src/docs/worker-protocol";
import { OmpIndexesBridge, type OmpIndexesBridgeOptions } from "../../src/modes/zcode/indexes";
import { RepoService } from "../../src/repo/service";
import { repoIndexPath } from "../../src/repo/storage";
import type { RepoQueryResult, RepoStatus, RepoSymbolHit, RepoTextHit } from "../../src/repo/types";

const wikiListResultSchema = z
	.object({
		indexes: z.array(
			z
				.object({
					id: z.number().int(),
					name: z.string(),
					rootPath: z.string(),
					documentCount: z.number().int().nonnegative(),
					sectionCount: z.number().int().nonnegative(),
				})
				.strict(),
		),
	})
	.strict();

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-zcode-indexes-"));
	cleanups.push(() => fs.rm(temp, { recursive: true, force: true }));
	const root = path.join(temp, "workspace");
	const agentDir = path.join(temp, "profile");
	await fs.mkdir(root);
	await fs.mkdir(agentDir);
	const canonicalRoot = await fs.realpath(root);
	const workspace = { workspacePath: canonicalRoot, workspaceIdentity: "local:test", workspaceKey: "local:test" };
	const notifications: Array<{ method: string; params: Parameters<OmpIndexesBridgeOptions["notify"]>[1] }> = [];
	let listener: OmpIndexesBridgeOptions["notify"] | undefined;
	const bridge = new OmpIndexesBridge({
		agentDir,
		notify(method, params) {
			notifications.push({ method, params });
			listener?.(method, params);
		},
	});
	cleanups.push(() => bridge.dispose());
	let sequence = 0;
	return {
		root: canonicalRoot,
		agentDir,
		workspace,
		bridge,
		notifications,
		onProgress(callback: OmpIndexesBridgeOptions["notify"]) {
			listener = callback;
		},
		wiki<T = Record<string, unknown>>(action: string, fields: Record<string, unknown> = {}, signal?: AbortSignal) {
			return bridge.handleWiki(
				action,
				{ workspace, operationId: `wiki-${++sequence}`, ...fields },
				signal,
			) as Promise<T>;
		},
		repo<T = Record<string, unknown>>(action: string, fields: Record<string, unknown> = {}, signal?: AbortSignal) {
			return bridge.handleRepo(
				action,
				{ workspace, operationId: `repo-${++sequence}`, ...fields },
				signal,
			) as Promise<T>;
		},
	};
}

/** Observe real worker admission; leave subprocess execution and IPC untouched. */
function observeSearches(agentDir: string) {
	const spawn: typeof Bun.spawn = Bun.spawn;
	const waiters: Array<(proc: Bun.Subprocess) => void> = [];
	const spy = vi.spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
		const proc = Reflect.apply(spawn, Bun, args) as Bun.Subprocess;
		const options = args[0] as { cmd?: string[] };
		if (!Array.isArray(options) && options.cmd?.includes(DOCS_WORKER_ARG)) {
			const send = proc.send.bind(proc);
			let owned = false;
			const sendSpy = vi.spyOn(proc, "send").mockImplementation((message: unknown) => {
				const request = message as DocsWorkerInbound;
				if (request.type === "configure" && request.options.agentDir === agentDir) owned = true;
				send(message);
				if (owned && request.type === "searchWindow") waiters.shift()?.(proc);
			});
			cleanups.push(() => sendSpy.mockRestore());
		}
		return proc;
	}) as typeof Bun.spawn);
	cleanups.push(() => spy.mockRestore());
	return () => {
		const ready = Promise.withResolvers<Bun.Subprocess>();
		waiters.push(ready.resolve);
		return ready.promise;
	};
}

describe("ZCode optional index bridge with real native services", () => {
	it("indexes real Markdown, returns complete DB-only pages and removes only index data", async () => {
		const f = await fixture();
		const documents = path.join(f.root, "documents");
		await fs.mkdir(documents);
		for (const name of ["a", "b", "c"])
			await fs.writeFile(
				path.join(documents, `${name}.md`),
				`# Guide ${name}\nraw.Token[42] full stored final ${name}.\n`,
			);
		expect(wikiListResultSchema.parse(await f.wiki("list"))).toEqual({ indexes: [] });
		// 保留未折叠的 /./，Windows 上同时覆盖 / 与 realpath 的反斜杠规范化。
		const equivalentConfirmation = `${documents.replaceAll("\\", "/")}/./`;
		const built = await f.wiki<DocsBuildResult>("init", {
			directory: documents,
			confirmedDirectory: equivalentConfirmation,
			name: "manual",
		});
		expect(built.index.documentCount).toBe(3);
		expect(built.failed).toBe(0);
		const observer = new DocsService({ agentDir: f.agentDir, cwd: f.root });
		cleanups.push(() => observer.close());
		expect(observer.databasePath).toBe(path.join(f.agentDir, "docs.db"));
		expect((await observer.list())[0]?.name).toBe("manual");
		expect(f.notifications.find(event => event.method === "omp/wiki/progress")?.params.workspace).toEqual(
			f.workspace,
		);
		const started = performance.now();
		const found = await f.wiki<DocsSearchResult>("search", { query: "Guide", index: "manual", limit: 1 });
		expect(performance.now() - started).toBeGreaterThanOrEqual(490);
		expect(found.total).toBeGreaterThan(0);
		const sections = [];
		let cursor: string | undefined;
		do {
			const page = await f.wiki<DocsSearchResult>("grep", {
				query: "raw\\.Token\\[42\\]",
				index: "manual",
				limit: 1,
				...(cursor ? { cursor } : {}),
			});
			sections.push(...page.sections);
			cursor = page.cursor;
			expect(page.total).toBe(3);
			expect(page.hasMore).toBe(Boolean(cursor));
		} while (cursor);
		expect(new Set(sections.map(section => section.sectionId)).size).toBe(3);
		expect(sections.every(section => section.text.includes("full stored final"))).toBe(true);
		await f.wiki("remove", { name: "manual" });
		expect(await fs.readFile(path.join(documents, "a.md"), "utf8")).toContain("full stored final a");
		await f.wiki("init", { directory: documents, confirmedDirectory: documents, name: "manual" });
		await fs.rm(documents, { recursive: true });
		expect((await f.wiki<DocsSearchResult>("grep", { query: "full stored final", index: "manual" })).total).toBe(3);
		await f.wiki("remove", { name: "manual" });
		expect(await observer.list()).toEqual([]);
		await expect(f.wiki("remove", { name: "missing" })).rejects.toThrow();
	}, 30_000);

	it("keeps missing repository status and queries read-only without creating index storage", async () => {
		const f = await fixture();
		expect(await f.repo<RepoStatus>("status")).toMatchObject({ root: f.root, exists: false, generation: null });
		for (const action of ["text", "symbol"]) {
			expect(await f.repo<RepoQueryResult<RepoTextHit>>(action, { query: "beacon" })).toMatchObject({
				root: f.root,
				status: "missing",
				generation: null,
				hits: [],
				truncated: false,
				warnings: [],
				coverage: { root: f.root, exists: false },
			});
			await expect(f.repo(action, { query: "beacon", path: "../outside" })).rejects.toThrow(
				"Repository path must stay within",
			);
			await expect(f.repo(action, { query: "beacon", cursor: "invalid" })).rejects.toThrow(
				"Invalid repository index cursor",
			);
			await expect(
				f.repo(action, {
					query: "beacon",
					cursor: Buffer.from(JSON.stringify({ generation: "previous-generation" })).toString("base64url"),
				}),
			).rejects.toThrow("Stale repository index cursor");
		}
		expect(await fs.readdir(f.agentDir)).toEqual([]);
		await expect(fs.stat(repoIndexPath(f.agentDir, f.root))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["corrupt", "future"] as const)(
		"reports %s repository storage as recoverable and rebuilds it through the native service",
		async damage => {
			const f = await fixture();
			await fs.writeFile(path.join(f.root, "sample.py"), "def beacon(): return 'recoveredriver'\n");
			const databasePath = repoIndexPath(f.agentDir, f.root);
			await fs.mkdir(path.dirname(databasePath), { recursive: true });
			if (damage === "corrupt") {
				await fs.writeFile(databasePath, "not a SQLite database");
			} else {
				const database = new Database(databasePath);
				try {
					database.run("PRAGMA user_version=999");
				} finally {
					database.close();
				}
			}
			const status = await f.repo<RepoStatus>("status");
			expect(status).toMatchObject({
				root: f.root,
				exists: true,
				generation: null,
				incomplete: true,
				unchecked: true,
				needsReconcile: true,
				uncertainCount: 1,
			});
			expect(status.uncertainReasons[0]).toContain("Repository index recovery required");
			if (damage === "future") expect(status.uncertainReasons[0]).toContain("schema 999");
			await expect(f.repo("text", { query: "recoveredriver" })).rejects.toThrow("recovery required");
			await expect(f.repo("symbol", { query: "beacon" })).rejects.toThrow("recovery required");
			const rebuilt = await f.repo<RepoStatus>("rebuild", { confirmedRoot: status.root });
			expect(rebuilt.exists).toBe(true);
			expect(rebuilt.generation).not.toBeNull();
			expect((await f.repo<RepoStatus>("status")).uncertainReasons).toEqual([]);
			expect((await f.repo<RepoQueryResult<RepoTextHit>>("text", { query: "recoveredriver" })).hits[0]?.path).toBe(
				"sample.py",
			);
			expect((await f.repo<RepoQueryResult<RepoSymbolHit>>("symbol", { query: "beacon" })).hits[0]?.name).toBe(
				"beacon",
			);
		},
		30_000,
	);

	it("accepts canonical-equivalent repository confirmations and rejects a different directory", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.root, "sample.py"), "def beacon(): return 'confirmedriver'\n");
		const alias = path.join(path.dirname(f.root), "workspace-alias");
		await fs.symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir");
		const equivalentRoot = `${f.root.replaceAll("\\", "/")}/./`;
		await expect(f.repo("init", { confirmedRoot: path.dirname(f.root) })).rejects.toThrow("Confirm repository root");
		expect(await fs.readdir(f.agentDir)).toEqual([]);
		await f.repo("init", { confirmedRoot: alias });
		await f.repo("update", { confirmedRoot: equivalentRoot });
		await f.repo("rebuild", {
			confirmedRoot: process.platform === "win32" ? f.root.toUpperCase() : equivalentRoot,
		});
		await expect(f.repo("remove", { confirmedRoot: path.dirname(f.root) })).rejects.toThrow(
			"Confirm repository root",
		);
		expect((await f.repo<RepoStatus>("status")).exists).toBe(true);
		await f.repo("remove", { confirmedRoot: alias });
		expect((await f.repo<RepoStatus>("status")).exists).toBe(false);
		expect(await fs.readFile(path.join(f.root, "sample.py"), "utf8")).toContain("confirmedriver");
	}, 30_000);

	it("uses the TUI repo root/profile and preserves sources through build, queries, update, rebuild and remove", async () => {
		const f = await fixture();
		const source = path.join(f.root, "sample.py");
		await fs.writeFile(source, "def beacon():\n    return 'initialriver'\n");
		await fs.writeFile(path.join(f.root, "second.py"), "def secondary(): return 'initialriver'\n");
		const status = await f.repo<RepoStatus>("status");
		expect(status.root).toBe(f.root);
		expect(status.exists).toBe(false);
		await expect(f.repo("init", { confirmedRoot: path.dirname(f.root) })).rejects.toThrow("Confirm repository root");
		await f.repo("init", { confirmedRoot: status.root });
		const observer = new RepoService({ agentDir: f.agentDir, cwd: f.root });
		cleanups.push(() => observer.close());
		expect((await observer.status()).exists).toBe(true);
		expect(
			(await f.repo<RepoQueryResult<RepoTextHit>>("text", { query: "initialriver" })).hits[0]?.snippet,
		).toContain("initialriver");
		expect((await f.repo<RepoQueryResult<RepoSymbolHit>>("symbol", { query: "beacon" })).hits[0]?.name).toBe(
			"beacon",
		);
		const firstPage = await f.repo<RepoQueryResult<RepoTextHit>>("text", { query: "initialriver", limit: 1 });
		expect(firstPage.hits).toHaveLength(1);
		expect(firstPage.cursor).toBeDefined();
		const secondPage = await f.repo<RepoQueryResult<RepoTextHit>>("text", {
			query: "initialriver",
			limit: 1,
			cursor: firstPage.cursor,
		});
		expect(secondPage.hits).toHaveLength(1);
		expect(secondPage.hits[0]?.path).not.toBe(firstPage.hits[0]?.path);
		const updated = "def beacon():\n    return 'updatedforest'\n";
		await fs.writeFile(source, updated);
		await f.repo("update", { confirmedRoot: status.root });
		expect(
			(await f.repo<RepoQueryResult<RepoTextHit>>("text", { query: "updatedforest" })).hits[0]?.snippet,
		).toContain("updatedforest");
		await f.repo("rebuild", { confirmedRoot: status.root });
		expect(await fs.readFile(source, "utf8")).toBe(updated);
		expect(f.notifications.some(event => event.method === "omp/repo/progress")).toBe(true);
		await f.repo("remove", { confirmedRoot: status.root });
		expect((await f.repo<RepoStatus>("status")).exists).toBe(false);
		expect(await fs.readFile(source, "utf8")).toBe(updated);
	}, 30_000);

	it("retains the previous generation after a cancelled or failed native rebuild", async () => {
		const f = await fixture();
		const source = path.join(f.root, "sample.py");
		await fs.writeFile(source, "def beacon(): return 'oldgeneration'\n");
		const before = await f.repo<RepoStatus>("init", { confirmedRoot: f.root });
		const controller = new AbortController();
		f.onProgress((_method, params) => {
			if (params.progress.phase === "reading") controller.abort(new DOMException("Stopped", "AbortError"));
		});
		await expect(f.repo("rebuild", { confirmedRoot: f.root }, controller.signal)).rejects.toThrow();
		expect((await f.repo<RepoStatus>("status")).generation).toBe(before.generation);
		let changed = false;
		f.onProgress((_method, params) => {
			if (params.progress.phase === "publishing" && !changed) {
				changed = true;
				fsSync.writeFileSync(path.join(f.root, "late.py"), "def late(): pass\n");
			}
		});
		await expect(f.repo("rebuild", { confirmedRoot: f.root })).rejects.toThrow();
		expect(changed).toBe(true);
		expect((await f.repo<RepoStatus>("status")).generation).toBe(before.generation);
		expect(await fs.readFile(source, "utf8")).toBe("def beacon(): return 'oldgeneration'\n");
	}, 30_000);

	it("binds operation cancellation to the exact workspace and closes in-flight work on EOF", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.root, "guide.md"), "# Guide\nstored cancellation evidence\n");
		const nextSearch = observeSearches(f.agentDir);
		await f.wiki("init", { name: "manual", directory: f.root, confirmedDirectory: f.root });
		const admitted = nextSearch();
		const pending = f.bridge.handleWiki("search", {
			workspace: f.workspace,
			operationId: "searching",
			query: "evidence",
		});
		// 提前只收集结果，不启动 Bun 异步 matcher；取消必须在 matcher 等待结果之前发出。
		const rejected = Promise.allSettled([pending]);
		// 真实 IPC 发出证明 bridge 已登记操作且 service 已准入，不能靠固定 sleep 猜测启动时间。
		const worker = await admitted;
		expect(
			await f.bridge.handleWiki("cancel", {
				workspace: { ...f.workspace, workspaceIdentity: "other-workspace" },
				operationId: "searching",
			}),
		).toEqual({ cancelled: false });
		expect(await f.bridge.handleWiki("cancel", { workspace: f.workspace, operationId: "searching" })).toEqual({
			cancelled: true,
		});
		expect((await rejected)[0]).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
		const admittedNext = nextSearch();
		const next = f.wiki("search", { query: "evidence" });
		const closed = Promise.allSettled([next]);
		const nextWorker = await admittedNext;
		await f.bridge.dispose();
		expect((await closed)[0]).toMatchObject({ status: "rejected" });
		// 查询可能已进入原生 outward floor 而复用 idle worker；只有 owner 关闭保证所有子进程退出。
		await Promise.all([worker.exited, nextWorker.exited]);
		await expect(f.wiki("list")).rejects.toThrow("disposed");
	}, 30_000);

	it("rejects unknown fields, action envelopes and unconfirmed document roots before mutation", async () => {
		const f = await fixture();
		expect(() =>
			f.bridge.handleWiki("list", { workspace: f.workspace, operationId: "bad", action: "remove" }),
		).toThrow();
		expect(() =>
			f.bridge.handleRepo("status", { workspace: f.workspace, operationId: "bad", extra: true }),
		).toThrow();
		await expect(
			f.wiki("init", { directory: f.root, confirmedDirectory: path.dirname(f.root), name: "manual" }),
		).rejects.toThrow("Confirm document directory");
		expect(wikiListResultSchema.parse(await f.wiki("list"))).toEqual({ indexes: [] });
	});
});
