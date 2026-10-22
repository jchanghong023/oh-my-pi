import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	countActorTranscript,
	makeActorTranscriptStore,
	seedActorTranscript,
} from "../../src/modes/zcode/workflows/actor-transcript";
import {
	buildImportedCache,
	preflightAmendImport,
	rebuildImportedCacheForResume,
} from "../../src/modes/zcode/workflows/import-cache";
import { createWorkflowJournal } from "../../src/modes/zcode/workflows/journal";
import { WorkflowEngine, type WorkflowDriver } from "../../src/modes/zcode/workflows/vendor/dynamic-workflow/index";
import { SessionManager } from "../../src/session/session-manager";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "omp-workflow-amend-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const journal = createWorkflowJournal(dir);
	cleanup.push(async () => journal.close());
	return { dir, journal };
}

test("missing completed ask boundary rejects amendment without stopping or creating a successor", async () => {
	const { journal } = await fixture();
	journal.createRun({ runId: "live", status: "running", caps: { maxConcurrency: 1 }, spentTokens: 0 });
	journal.putNode({
		runId: "live",
		siteId: "ask",
		ordinal: 0,
		kind: "ask",
		actorSiteId: "actor",
		actorOrdinal: 0,
		actorSeq: 0,
		inputHash: "input",
		status: "completed",
		result: "answer",
	});
	expect(preflightAmendImport(journal, "live")).toEqual({ ok: false, reason: "missing_boundaries" });
	expect(journal.getRun("live")?.status).toBe("running");
	expect(journal.listRuns({ limit: 10 }).map(run => run.runId)).toEqual(["live"]);
});

test("completed and quiet inflight native transcript prefixes rebuild identically after journal restart", async () => {
	const { dir, journal } = await fixture();
	const source = SessionManager.create(dir, join(dir, "sessions"));
	cleanup.push(() => source.close());
	for (const content of ["first ask", "first answer", "inflight ask"])
		source.appendMessage({ role: "user", content, timestamp: 1 });
	await source.ensureOnDisk();
	await source.flush();
	const store = makeActorTranscriptStore({ read: async () => ({ messages: source.buildSessionContext().messages }) });
	journal.createRun({ runId: "predecessor", status: "stopped", caps: { maxConcurrency: 1 }, spentTokens: 4 });
	journal.putActor({
		runId: "predecessor",
		siteId: "actor",
		ordinal: 0,
		name: "writer",
		persona: { name: "writer" },
		sessionId: source.getSessionId(),
		resolvedModel: "provider/model",
	});
	journal.putNode({
		runId: "predecessor",
		siteId: "ask",
		ordinal: 0,
		kind: "ask",
		actorSiteId: "actor",
		actorOrdinal: 0,
		actorSeq: 0,
		inputHash: "first",
		status: "completed",
		messageBoundary: 2,
		result: "cached answer",
	});
	journal.putNode({
		runId: "predecessor",
		siteId: "ask",
		ordinal: 1,
		kind: "ask",
		actorSiteId: "actor",
		actorOrdinal: 0,
		actorSeq: 1,
		inputHash: "second",
		status: "running",
	});
	const unquiet = await buildImportedCache({ journal, actorTranscriptStore: store }, "predecessor", {
		quietSessions: new Set(),
	});
	expect(unquiet.ok && unquiet.cache.actors.get("writer")?.inFlight).toBeUndefined();
	const built = await buildImportedCache({ journal, actorTranscriptStore: store }, "predecessor", {
		quietSessions: new Set([source.getSessionId()]),
	});
	expect(built.ok).toBe(true);
	if (!built.ok) throw new Error(built.reason);
	expect(built.cache.actors.get("writer")).toMatchObject({
		entries: [{ result: "cached answer", messageBoundary: 2 }],
		inFlight: { inputHash: "second", messageBoundary: 3 },
		resolvedModel: "provider/model",
	});
	// A separate SQLite connection models a new service process, not an in-memory cache.
	const reopened = createWorkflowJournal(dir);
	try {
		const rebuilt = await rebuildImportedCacheForResume(
			{ journal: reopened, actorTranscriptStore: store },
			{ runId: "successor", predecessorRunId: "predecessor" },
		);
		expect(rebuilt).toEqual(built.cache);
		expect(await countActorTranscript(store, source.getSessionId())).toBe(3);
	} finally {
		reopened.close();
	}
});

test("native seed prefix survives reopen, completes partial copy and never appends old messages after own history", async () => {
	const { dir } = await fixture();
	let target = SessionManager.create(dir, join(dir, "sessions"));
	cleanup.push(() => target.close());
	const source = SessionManager.inMemory(dir);
	for (const content of ["old one", "old two", "late old three", "late old four"])
		source.appendMessage({ role: "user", content, timestamp: 1 });
	const store = makeActorTranscriptStore({ read: async () => ({ messages: source.buildSessionContext().messages }) });
	const seed = { sourceSessionId: "source", messageCount: 1 };
	const id = target.getSessionId();
	expect(await seedActorTranscript({ seed, store, target, targetSessionId: id })).toBe(1);
	const file = target.getSessionFile()!;
	await target.close();
	target = await SessionManager.open(file, join(dir, "sessions"));
	expect(await seedActorTranscript({ seed: { ...seed, messageCount: 2 }, store, target, targetSessionId: id })).toBe(
		2,
	);
	expect(
		await seedActorTranscript({ seed: { ...seed, messageCount: 2 }, store, target, targetSessionId: id }),
	).toBeUndefined();
	target.appendMessage({ role: "user", content: "new own history", timestamp: 2 });
	await target.flush();
	expect(
		await seedActorTranscript({ seed: { ...seed, messageCount: 4 }, store, target, targetSessionId: id }),
	).toBeUndefined();
	expect(
		target.buildSessionContext().messages.map(message => ("content" in message ? message.content : undefined)),
	).toEqual(["old one", "old two", "new own history"]);
});

test("amend and restart replay actual journaled world effects without executing them twice", async () => {
	const { dir, journal } = await fixture();
	const effect = join(dir, "effect.txt");
	let executions = 0;
	const driver: WorkflowDriver = {
		journal,
		emit() {},
		createActorSession() {
			throw new Error("Unexpected actor creation");
		},
		startAsk() {
			throw new Error("Unexpected model ask");
		},
		respondToSubmit() {
			throw new Error("Unexpected submit");
		},
		cancelAsk() {},
		async executeWorldRead() {
			executions++;
			await appendFile(effect, "effect\n");
			return { exitCode: 0, stdout: "done", stderr: "" };
		},
	};
	const config = { driver, caps: { maxConcurrency: 1 }, askSpecs: new Map(), validate: () => [] };
	const original = new WorkflowEngine({ ...config, runId: "original" });
	const result = await original.worldRead("command", "run", ["effect"]);
	original.complete(result);
	const built = await buildImportedCache({ journal }, "original");
	if (!built.ok) throw new Error(built.reason);
	const amended = new WorkflowEngine({
		...config,
		runId: "amended",
		resumedFrom: "original",
		importedCache: built.cache,
	});
	expect(await amended.worldRead("command", "run", ["effect"])).toEqual(result);
	amended.stop("user");
	const rebuilt = await rebuildImportedCacheForResume({ journal }, { runId: "amended", predecessorRunId: "original" });
	const resumed = new WorkflowEngine({ ...config, runId: "amended", importedCache: rebuilt });
	expect(await resumed.worldRead("command", "run", ["effect"])).toEqual(result);
	resumed.complete(result);
	expect(executions).toBe(1);
	expect(await readFile(effect, "utf8")).toBe("effect\n");
});

test("native seeding refuses a truncated source without writing a partial target", async () => {
	const { dir } = await fixture();
	const target = SessionManager.inMemory(dir);
	const source = SessionManager.inMemory(dir);
	source.appendMessage({ role: "user", content: "only one", timestamp: 1 });
	const store = makeActorTranscriptStore({ read: async () => ({ messages: source.buildSessionContext().messages }) });
	await expect(
		seedActorTranscript({
			seed: { sourceSessionId: "short", messageCount: 2 },
			store,
			target,
			targetSessionId: target.getSessionId(),
		}),
	).rejects.toThrow("boundary requires the first 2");
	expect(target.buildSessionContext().messages).toEqual([]);
});
