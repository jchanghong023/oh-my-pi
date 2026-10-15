import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DOCS_WORKER_ARG } from "../src/cli/worker-selectors";
import { DocsService, smokeTestDocsWorker } from "../src/docs/service";
import type { DocsWorkerInbound } from "../src/docs/worker-protocol";
import { restoreEnvValue } from "./helpers/settings-test-state";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-worker-"));
	cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
	const documents = path.join(directory, "documents");
	const agentDir = path.join(directory, "agent");
	await fs.mkdir(documents);
	for (const name of ["a", "b", "c"])
		await Bun.write(path.join(documents, `${name}.md`), `# Evidence\nworkerbeacon ${name} complete final line.\n`);
	const service = new DocsService({ agentDir, cwd: directory });
	cleanups.push(() => service.close());
	await service.init(documents, "manual");
	return { directory, documents, agentDir, service };
}

/** Give real removals finite CPU-bound SQLite work without holding a competing writer lock. */
function expensiveRemoval(service: DocsService) {
	const db = new Database(service.databasePath, { strict: true });
	try {
		db.exec("PRAGMA foreign_keys=ON");
		db.exec(`
		CREATE TRIGGER test_expensive_docs_removal BEFORE DELETE ON doc_indexes
		BEGIN
			SELECT sum(value) FROM (
				WITH RECURSIVE work(value) AS (
					VALUES(0)
					UNION ALL SELECT value + 1 FROM work WHERE value < 10000000
				)
				SELECT value FROM work
			);
		END;
		`);
	} finally {
		db.close();
	}
	cleanups.push(async () => {
		// Never change the trigger while the owned worker may still be executing it.
		await service.close();
		const cleanupDb = new Database(service.databasePath, { strict: true });
		try {
			cleanupDb.exec("PRAGMA foreign_keys=ON");
			cleanupDb.exec("DROP TRIGGER test_expensive_docs_removal");
		} finally {
			cleanupDb.close();
		}
	});
}

function failure(promise: Promise<unknown>): Promise<Error> {
	return promise.then(
		() => {
			throw new Error("Expected the pending operation to reject");
		},
		error => {
			expect(error).toBeInstanceOf(Error);
			return error as Error;
		},
	);
}

/** Observes actual subprocesses without replacing worker execution, IPC, or results. */
function observeWorkers(agentDir: string) {
	const spawn: typeof Bun.spawn = Bun.spawn;
	const workers: Bun.Subprocess[] = [];
	const sent: Array<{ proc: Bun.Subprocess; message: DocsWorkerInbound }> = [];
	const waiters: Array<{ type: DocsWorkerInbound["type"]; resolve: (proc: Bun.Subprocess) => void }> = [];
	const spy = vi.spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
		const proc = Reflect.apply(spawn, Bun, args) as Bun.Subprocess;
		const options = args[0] as { cmd?: string[] };
		if (!Array.isArray(options) && options.cmd?.includes(DOCS_WORKER_ARG)) {
			const send = proc.send.bind(proc);
			let owned = false;
			const sendSpy = vi.spyOn(proc, "send").mockImplementation((message: unknown) => {
				const request = message as DocsWorkerInbound;
				if (request.type === "configure" && request.options.agentDir === agentDir) {
					owned = true;
					workers.push(proc);
				}
				send(message);
				if (!owned) return;
				sent.push({ proc, message: request });
				for (const waiter of waiters.splice(0)) {
					if (waiter.type === request.type) waiter.resolve(proc);
					else waiters.push(waiter);
				}
			});
			cleanups.push(() => sendSpy.mockRestore());
		}
		return proc;
	}) as typeof Bun.spawn);
	cleanups.push(() => spy.mockRestore());
	return {
		workers,
		next(type: DocsWorkerInbound["type"]): Promise<Bun.Subprocess> {
			const prior = sent.find(entry => entry.message.type === type);
			if (prior) return Promise.resolve(prior.proc);
			const pending = Promise.withResolvers<Bun.Subprocess>();
			waiters.push({ type, resolve: pending.resolve });
			return pending.promise;
		},
	};
}

describe("DocsService real owned worker", () => {
	it("executes the same real query smoke used by the released CLI sibling worker", async () => {
		await smokeTestDocsWorker();
	}, 30_000);

	it("does not open or migrate SQLite in its constructor", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-lazy-"));
		cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
		const service = new DocsService({ agentDir: path.join(directory, "not-created") });
		cleanups.push(() => service.close());
		expect(await fs.readdir(directory)).toEqual([]);
		await expect(service.list({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
		expect(await fs.readdir(directory)).toEqual([]);
		expect(await service.list()).toEqual([]);
		expect(await Bun.file(service.databasePath).exists()).toBe(true);
	});

	it("creates, reads and removes the same OMP_WIKI_DIR database across profiles", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shared-wiki-"));
		cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
		const documents = path.join(directory, "documents");
		await fs.mkdir(documents);
		await Bun.write(path.join(documents, "guide.md"), "# Shared\nsharedwikibeacon stored evidence\n");
		const previous = process.env.OMP_WIKI_DIR;
		let writer: DocsService;
		let reader: DocsService;
		try {
			restoreEnvValue("OMP_WIKI_DIR", path.join("team", "wiki"));
			writer = new DocsService({ agentDir: path.join(directory, "profile-a"), cwd: directory });
			reader = new DocsService({ agentDir: path.join(directory, "profile-b"), cwd: directory });
		} finally {
			restoreEnvValue("OMP_WIKI_DIR", previous);
		}
		cleanups.push(
			() => writer.close(),
			() => reader.close(),
		);
		await writer.init(documents, "shared");
		await fs.rm(documents, { recursive: true });
		expect((await reader.search("sharedwikibeacon")).sections.some(hit => hit.text.includes("stored evidence"))).toBe(
			true,
		);
		expect(await Bun.file(path.join(directory, "team", "wiki", "docs.db")).exists()).toBe(true);
		expect(await Bun.file(path.join(directory, "profile-a", "docs.db")).exists()).toBe(false);
		expect(await Bun.file(path.join(directory, "profile-b", "docs.db")).exists()).toBe(false);
		await reader.remove("shared");
		expect(await writer.list()).toEqual([]);
	});

	it("keeps timer heartbeats and another independent service usable during real DB work", async () => {
		const f = await fixture();
		const other = new DocsService({ agentDir: path.join(f.directory, "independent") });
		cleanups.push(() => other.close());
		await other.list();
		expensiveRemoval(f.service);
		let settled = false;
		const removing = f.service.remove("manual").finally(() => {
			settled = true;
		});
		// Real timers are the behavior under test: fake time cannot detect a blocked parent loop.
		let heartbeats = 0;
		const heartbeat = Promise.withResolvers<void>();
		const timer = setInterval(() => {
			heartbeats++;
			heartbeat.resolve();
		}, 5);
		cleanups.push(() => clearInterval(timer));
		try {
			await heartbeat.promise;
			expect(heartbeats).toBeGreaterThan(0);
			expect(settled).toBe(false);
			expect(await other.list()).toEqual([]);
			expect(settled).toBe(false);
		} finally {
			clearInterval(timer);
		}
		await removing;
		expect(await f.service.list()).toEqual([]);
	}, 15_000);

	it.each(["search", "grep"] as const)(
		"cancels queued %s work without killing or rejecting its active peer",
		async mode => {
			const f = await fixture();
			expensiveRemoval(f.service);
			let settled = false;
			const removing = f.service.remove("manual").finally(() => {
				settled = true;
			});
			const controller = new AbortController();
			const queued = failure(f.service.search("workerbeacon", { mode, signal: controller.signal }));
			controller.abort();
			expect((await queued).name).toBe("AbortError");
			expect(settled).toBe(false);
			await removing;
			expect(await f.service.list()).toEqual([]);
		},
		15_000,
	);

	it("kills an actively cancelled real worker and continues independent queued work on a fresh child", async () => {
		const f = await fixture();
		// Reopen under observation so only this fixture's configure identifies ownership.
		await f.service.close();
		const observed = observeWorkers(f.agentDir);
		const service = new DocsService({ agentDir: f.agentDir });
		cleanups.push(() => service.close());
		await service.list();
		expensiveRemoval(service);
		const controller = new AbortController();
		let settled = false;
		const active = failure(
			service.remove("manual", { signal: controller.signal }).finally(() => {
				settled = true;
			}),
		);
		const proc = await observed.next("remove");
		const queued = service.list();
		expect(settled).toBe(false);
		controller.abort();
		expect((await active).name).toBe("AbortError");
		await proc.exited;
		expect((await queued).map(index => index.name)).toEqual(["manual"]);
		expect((await service.list()).map(index => index.name)).toEqual(["manual"]);
		expect(observed.workers).toHaveLength(2);
		expect(observed.workers[1]!.pid).not.toBe(proc.pid);
	}, 15_000);

	it("cancels an owned grep request, recovers on a fresh worker and scans beyond file grep's size limit", async () => {
		const f = await fixture();
		const source = `# Large\n${"padding ".repeat(530_000)}FARBEACON\n`;
		expect(Buffer.byteLength(source)).toBeGreaterThan(4 * 1024 * 1024);
		await Bun.write(path.join(f.documents, "a.md"), source);
		await f.service.remove("manual");
		await f.service.init(f.documents, "manual");
		await fs.rm(f.documents, { recursive: true });
		await f.service.close();
		const observed = observeWorkers(f.agentDir);
		const service = new DocsService({ agentDir: f.agentDir });
		cleanups.push(() => service.close());
		await service.list();
		const controller = new AbortController();
		const active = failure(service.search("FARBEACON$", { mode: "grep", signal: controller.signal }));
		const proc = await observed.next("searchWindow");
		const queued = service.search("^workerbeacon", { mode: "grep" });
		controller.abort();
		expect((await active).name).toBe("AbortError");
		await proc.exited;
		const recovered = await queued;
		expect(recovered.sections.map(hit => hit.path)).toEqual(["b.md", "c.md"]);
		expect(recovered.sections.every(hit => hit.matchKind === "regex")).toBe(true);
		expect(observed.workers).toHaveLength(2);
		expect(observed.workers[1]!.pid).not.toBe(proc.pid);
		const far = await service.search("FARBEACON$", { mode: "grep" });
		expect(far.total).toBe(1);
		expect(far.sections[0]).toMatchObject({ path: "a.md", matchKind: "regex", lineStart: 2, lineEnd: 2 });
		expect(far.sections[0]?.text).toContain("FARBEACON\n");
		expect(far.sections[0]?.documentHash).toBe(new Bun.CryptoHasher("sha256").update(source).digest("hex"));
	}, 20_000);

	it("settles active and queued calls immediately, then reaps the real worker on repeated close", async () => {
		const f = await fixture();
		await f.service.close();
		const observed = observeWorkers(f.agentDir);
		const service = new DocsService({ agentDir: f.agentDir });
		cleanups.push(() => service.close());
		await service.list();
		expensiveRemoval(service);
		let settled = false;
		const active = failure(
			service.remove("manual").finally(() => {
				settled = true;
			}),
		);
		const proc = await observed.next("remove");
		let exited = false;
		void proc.exited.then(() => {
			exited = true;
		});
		const queued = failure(service.list());
		expect(settled).toBe(false);
		const started = performance.now();
		const closing = service.close();
		expect(service.close()).toBe(closing);
		const errors = await Promise.all([active, queued]);
		for (const error of errors) expect(error.message).toBe("Document service is closed");
		expect(performance.now() - started).toBeLessThan(500);
		await expect(service.list()).rejects.toThrow("Document service is closed");
		await closing;
		expect(exited).toBe(true);
		expect(service.close()).toBe(closing);
	}, 15_000);

	it("releases the real idle worker's database before its close barrier resolves", async () => {
		const f = await fixture();
		await f.service.close();
		const observed = observeWorkers(f.agentDir);
		const service = new DocsService({ agentDir: f.agentDir });
		cleanups.push(() => service.close());
		expect((await service.list()).map(index => index.name)).toEqual(["manual"]);
		const proc = await observed.next("list");
		let exited = false;
		void proc.exited.then(() => {
			exited = true;
		});
		const closing = service.close();
		expect(service.close()).toBe(closing);
		await closing;
		expect(exited).toBe(true);
		await fs.rm(f.agentDir, { recursive: true });
		expect(await Bun.file(service.databasePath).exists()).toBe(false);
		expect(service.close()).toBe(closing);
	}, 15_000);

	it("rejects active and queued calls after an actual worker crash and discards the dead child", async () => {
		const f = await fixture();
		await f.service.close();
		const observed = observeWorkers(f.agentDir);
		const service = new DocsService({ agentDir: f.agentDir });
		cleanups.push(() => service.close());
		await service.list();
		expensiveRemoval(service);
		let settled = false;
		const active = failure(
			service.remove("manual").finally(() => {
				settled = true;
			}),
		);
		const proc = await observed.next("remove");
		const queued = failure(service.list());
		expect(settled).toBe(false);
		proc.kill("SIGKILL");
		await proc.exited;
		await Promise.all([active, queued]);
		expect((await service.list()).map(index => index.name)).toEqual(["manual"]);
		expect(observed.workers).toHaveLength(2);
	}, 15_000);

	it.each(["search", "grep"] as const)(
		"invalidates %s cached cursor evidence after raw SQL and FTS-only commits",
		async mode => {
			const f = await fixture();
			await fs.rm(f.documents, { recursive: true });
			const before = await f.service.search("workerbeacon", { mode, limit: 1 });
			expect(before.total).toBe(3);
			expect(before.cursor).toBeDefined();
			const original = before.sections[0]!;
			const changed = "# Changed evidence\nworkerbeacon UPDATED_COMPLETE_FINAL_LINE\n";
			const db = new Database(f.service.databasePath, { strict: true });
			try {
				db.exec("PRAGMA foreign_keys=ON");
				db.transaction(() => {
					db.query("UPDATE sections SET raw_markdown=?,heading_path=?,line_end=2,byte_end=? WHERE id=?").run(
						changed,
						"Changed evidence",
						Buffer.byteLength(changed),
						original.sectionId,
					);
					db.query(
						"UPDATE documents SET relative_path=?,sha256=?,size_bytes=? WHERE id=(SELECT document_id FROM sections WHERE id=?)",
					).run("renamed.md", "f".repeat(64), Buffer.byteLength(changed), original.sectionId);
				})();
			} finally {
				db.close();
			}
			await expect(f.service.search("workerbeacon", { mode, limit: 1, cursor: before.cursor })).rejects.toThrow(
				"Stale",
			);
			const fresh = await f.service.search("workerbeacon", { mode });
			const updated = fresh.sections.find(section => section.sectionId === original.sectionId)!;
			expect(updated.text).toBe(changed);
			expect(updated.path).toBe("renamed.md");
			expect(updated.documentHash).toBe("f".repeat(64));
			expect(updated.headingPath).toBe("Changed evidence");
			const page = await f.service.search("workerbeacon", { mode, limit: 1 });
			const ftsDb = new Database(f.service.databasePath, { strict: true });
			try {
				ftsDb.exec("PRAGMA foreign_keys=ON");
				const row = ftsDb.query("SELECT index_id FROM sections WHERE id=?").get(original.sectionId) as {
					index_id: number;
				};
				ftsDb.transaction(() => {
					ftsDb.query("DELETE FROM sections_fts WHERE rowid=?").run(original.sectionId);
					ftsDb
						.query(
							"INSERT INTO sections_fts(rowid,section_id,index_id,relative_path,heading_path,body) VALUES(?,?,?,?,?,?)",
						)
						.run(
							original.sectionId,
							original.sectionId,
							row.index_id,
							"renamed.md",
							"Changed evidence",
							"isolated_fts_token",
						);
				})();
			} finally {
				ftsDb.close();
			}
			await expect(f.service.search("workerbeacon", { mode, limit: 1, cursor: page.cursor })).rejects.toThrow(
				"Stale",
			);
			if (mode === "grep") {
				const freshGrep = await f.service.search("workerbeacon", { mode });
				expect(freshGrep.total).toBe(3);
				expect(freshGrep.sections.find(section => section.sectionId === original.sectionId)).toMatchObject({
					text: changed,
					path: "renamed.md",
					documentHash: "f".repeat(64),
					matchKind: "regex",
				});
			}
			const fts = await f.service.search("isolated_fts_token");
			expect(fts.sections.map(section => section.sectionId)).toContain(original.sectionId);
			expect(fts.sections.find(section => section.sectionId === original.sectionId)?.text).toBe(changed);
		},
		15_000,
	);

	it("reports a broken warm database instead of returning cached evidence or zero matches", async () => {
		const f = await fixture();
		expect((await f.service.search("workerbeacon")).total).toBe(3);
		const db = new Database(f.service.databasePath, { strict: true });
		try {
			db.exec("PRAGMA foreign_keys=ON");
			db.exec("DROP TABLE sections_fts");
		} finally {
			db.close();
		}
		await expect(f.service.search("workerbeacon")).rejects.toThrow();
	}, 10_000);

	it.each(["search", "grep"] as const)(
		"runs %s page-local budgeting lazily and resumes the excluded next hit",
		async mode => {
			const f = await fixture();
			const ranked = await f.service.search("workerbeacon", { mode });
			const positions: number[] = [];
			const page = await f.service.search("workerbeacon", {
				mode,
				limit: 3,
				characterBudget: 3,
				sectionCost: (_section, position) => {
					positions.push(position);
					return 2;
				},
			});
			expect(positions).toEqual([0, 1]);
			expect(page.sections).toEqual(ranked.sections.slice(0, 1));
			const rest = await f.service.search("workerbeacon", { mode, cursor: page.cursor });
			expect(rest.sections).toEqual(ranked.sections.slice(1));
			expect(rest.hasMore).toBe(false);
		},
		10_000,
	);

	it.each(["search", "grep"] as const)(
		"enforces the %s successful >=500ms floor asynchronously and aborts after DB work",
		async mode => {
			// Platform time is the integration contract; fake time cannot prove the outward floor.
			const f = await fixture();
			const started = performance.now();
			let heartbeats = 0;
			const timer = setInterval(() => {
				heartbeats++;
			}, 5);
			try {
				const result = await f.service.search("workerbeacon", { mode });
				expect(result.total).toBe(3);
				expect(performance.now() - started).toBeGreaterThanOrEqual(500);
				expect(heartbeats).toBeGreaterThan(0);
			} finally {
				clearInterval(timer);
			}
			const controller = new AbortController();
			const examined = Promise.withResolvers<void>();
			const pending = failure(
				f.service.search("workerbeacon", {
					mode,
					signal: controller.signal,
					sectionCost: section => {
						examined.resolve();
						return section.text.length;
					},
				}),
			);
			await examined.promise;
			const abortStarted = performance.now();
			controller.abort();
			expect((await pending).name).toBe("AbortError");
			expect(performance.now() - abortStarted).toBeLessThan(500);
			expect((await f.service.search("workerbeacon", { mode })).total).toBe(3);
		},
		10_000,
	);
});
