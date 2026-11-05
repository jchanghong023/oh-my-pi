import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { KNOWLEDGE_WORKER_ARG } from "../../src/cli/worker-selectors";
import { KnowledgeService } from "../../src/knowledge/service";
import type { KnowledgeBuildResult, KnowledgeSearchResult } from "../../src/knowledge/types";
import type { KnowledgeWorkerInbound } from "../../src/knowledge/worker-protocol";
import { OmpIndexesBridge, type OmpIndexesBridgeOptions } from "../../src/modes/zcode/indexes";

const knowledgeListResultSchema = z
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
	const bridge = new OmpIndexesBridge({
		agentDir,
		notify(method, params) {
			notifications.push({ method, params });
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
		wiki<T = Record<string, unknown>>(action: string, fields: Record<string, unknown> = {}, signal?: AbortSignal) {
			return bridge.handleKnowledge(
				action,
				{ workspace, operationId: `wiki-${++sequence}`, ...fields },
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
		if (!Array.isArray(options) && options.cmd?.includes(KNOWLEDGE_WORKER_ARG)) {
			const send = proc.send.bind(proc);
			let owned = false;
			const sendSpy = vi.spyOn(proc, "send").mockImplementation((message: unknown) => {
				const request = message as KnowledgeWorkerInbound;
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
		expect(knowledgeListResultSchema.parse(await f.wiki("list"))).toEqual({ indexes: [] });
		// 保留未折叠的 /./，Windows 上同时覆盖 / 与 realpath 的反斜杠规范化。
		const equivalentConfirmation = `${documents.replaceAll("\\", "/")}/./`;
		const built = await f.wiki<KnowledgeBuildResult>("init", {
			directory: documents,
			confirmedDirectory: equivalentConfirmation,
			name: "manual",
		});
		expect(built.index.documentCount).toBe(3);
		expect(built.failed).toBe(0);
		const observer = new KnowledgeService({ agentDir: f.agentDir, cwd: f.root });
		cleanups.push(() => observer.close());
		expect(observer.databasePath).toBe(path.join(f.agentDir, "knowledge.db"));
		expect((await observer.list())[0]?.name).toBe("manual");
		expect(f.notifications.find(event => event.method === "omp/wiki/progress")?.params.workspace).toEqual(
			f.workspace,
		);
		const started = performance.now();
		const found = await f.wiki<KnowledgeSearchResult>("search", { query: "Guide", index: "manual", limit: 1 });
		expect(performance.now() - started).toBeGreaterThanOrEqual(500);
		expect(found.total).toBeGreaterThan(0);
		const sections = [];
		let cursor: string | undefined;
		do {
			const page = await f.wiki<KnowledgeSearchResult>("grep", {
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
		expect((await f.wiki<KnowledgeSearchResult>("grep", { query: "full stored final", index: "manual" })).total).toBe(
			3,
		);
		await f.wiki("remove", { name: "manual" });
		expect(await observer.list()).toEqual([]);
		await expect(f.wiki("remove", { name: "missing" })).rejects.toThrow();
	}, 30_000);

	it("binds operation cancellation to the exact workspace and closes in-flight work on EOF", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.root, "guide.md"), "# Guide\nstored cancellation evidence\n");
		const nextSearch = observeSearches(f.agentDir);
		await f.wiki("init", { name: "manual", directory: f.root, confirmedDirectory: f.root });
		const admitted = nextSearch();
		const pending = f.bridge.handleKnowledge("search", {
			workspace: f.workspace,
			operationId: "searching",
			query: "evidence",
		});
		// 提前只收集结果，不启动 Bun 异步 matcher；取消必须在 matcher 等待结果之前发出。
		const rejected = Promise.allSettled([pending]);
		// 真实 IPC 发出证明 bridge 已登记操作且 service 已准入，不能靠固定 sleep 猜测启动时间。
		const worker = await admitted;
		expect(
			await f.bridge.handleKnowledge("cancel", {
				workspace: { ...f.workspace, workspaceIdentity: "other-workspace" },
				operationId: "searching",
			}),
		).toEqual({ cancelled: false });
		expect(await f.bridge.handleKnowledge("cancel", { workspace: f.workspace, operationId: "searching" })).toEqual({
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
			f.bridge.handleKnowledge("list", { workspace: f.workspace, operationId: "bad", action: "remove" }),
		).toThrow();
		expect(() =>
			f.bridge.handleKnowledge("list", { workspace: f.workspace, operationId: "bad", extra: true }),
		).toThrow();
		await expect(
			f.wiki("init", { directory: f.root, confirmedDirectory: path.dirname(f.root), name: "manual" }),
		).rejects.toThrow("Confirm document directory");
		expect(knowledgeListResultSchema.parse(await f.wiki("list"))).toEqual({ indexes: [] });
	});
});
