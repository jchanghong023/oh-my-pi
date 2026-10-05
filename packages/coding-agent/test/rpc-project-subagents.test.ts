// Unit tests for the fork RPC project-mode durable subagent catalog
// (requirement R5, rpc-ui-protocol.md §8.2/§14.8): the merged running/finished
// directory derived from a session's real artifacts tree, terminal-status
// rules from durable facts only, bounded transcript reads that never truncate
// into corrupt JSON, and the narrow control entry delegating to the injected
// cancel/IRC services. Fixtures write real JSONL transcripts (session header,
// session_init, message records) and .md/.tombstone artifacts beside them —
// the exact layout the executor persists — so listing reads go through the
// production metadata prefix reader, not stubs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	artifactsDirForSessionFile,
	RpcProjectSubagentDirectory,
	RpcProjectSubagentError,
	type RpcProjectSubagentDirectoryDeps,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-project-subagents";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { RpcProjectErrorCode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-project-types";
import type { RpcSubagentSnapshot } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const SID = "sess-under-test";

const tempDirs: TempDir[] = [];

interface SessionTree {
	root: string;
	sessionFile: string;
	artifactsDir: string;
}

/** Session JSONL + its sibling artifacts directory, mirroring SessionManager's layout. */
async function createSessionTree(prefix: string): Promise<SessionTree> {
	const temp = await TempDir.create(prefix);
	tempDirs.push(temp);
	const root = temp.toString();
	const sessionFile = path.join(root, `${SID}.jsonl`);
	await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: SID, timestamp: iso(0), cwd: root })}\n`);
	const artifactsDir = artifactsDirForSessionFile(sessionFile);
	await fs.mkdir(artifactsDir, { recursive: true });
	return { root, sessionFile, artifactsDir };
}

function iso(secondsOffset: number): string {
	return new Date(Date.UTC(2026, 8, 29, 0, 0, secondsOffset)).toISOString();
}

function line(record: object): string {
	return `${JSON.stringify(record)}\n`;
}

function headerRecord(dir: string): object {
	return { type: "session", id: SID, timestamp: iso(0), cwd: dir };
}

function initRecord(task: string, agent?: string): object {
	return {
		type: "session_init",
		id: "init-1",
		parentId: null,
		timestamp: iso(1),
		systemPrompt: "system",
		task,
		tools: [],
		...(agent !== undefined ? { agent } : {}),
	};
}

function messageRecord(id: string, text: string, secondsOffset: number): object {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: iso(secondsOffset),
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

/**
 * A transcript with a conversational history (session_init + one message) —
 * the shape a subagent that actually ran leaves behind.
 */
async function writeConversationalTranscript(
	artifactsDir: string,
	id: string,
	options: { task?: string; agent?: string } = {},
): Promise<string> {
	const transcript = path.join(artifactsDir, `${id}.jsonl`);
	await fs.writeFile(
		transcript,
		line(headerRecord(artifactsDir)) +
			line(initRecord(options.task ?? `task of ${id}`, options.agent)) +
			line(messageRecord("m-1", `hello from ${id}`, 2)),
	);
	return transcript;
}

function snapshot(id: string, index: number, overrides: Partial<RpcSubagentSnapshot> = {}): RpcSubagentSnapshot {
	return {
		id,
		index,
		agent: `agent-${id}`,
		agentSource: "bundled",
		status: "running",
		lastUpdate: Date.parse(iso(30)),
		...overrides,
	};
}

/** Calls recorded against one fake subagent AgentSession. */
interface SubagentSessionLog {
	aborts: string[];
	deliveries: Array<{ from: string; to: string; body: string }>;
}

/** Minimal live-session fake: only the abort/deliverIrcMessage surface `control` uses. */
function fakeSubagentSession(name: string, log: SubagentSessionLog): AgentSession {
	return {
		abort: async (options?: { reason?: string }) => {
			log.aborts.push(`${name}:${options?.reason ?? ""}`);
		},
		deliverIrcMessage: async (message: { from: string; to: string; body: string }) => {
			log.deliveries.push({ from: message.from, to: message.to, body: message.body });
			return "injected" as const;
		},
	} as unknown as AgentSession;
}

/** Directory deps bound to one session tree and a mutable live-snapshot set. */
function makeDirectory(
	tree: SessionTree,
	live: RpcSubagentSnapshot[] = [],
	overrides: Partial<RpcProjectSubagentDirectoryDeps> = {},
): RpcProjectSubagentDirectory {
	return new RpcProjectSubagentDirectory({
		resolveSessionFile: sessionId => (sessionId === SID ? tree.sessionFile : undefined),
		senderId: () => "rpcp:test-main",
		liveSnapshots: sessionId => (sessionId === SID ? live : []),
		...overrides,
	});
}

function expectErrorCode(promise: Promise<unknown>, code: RpcProjectErrorCode): Promise<void> {
	return promise.then(
		() => {
			throw new Error(`expected RpcProjectSubagentError with code ${code}`);
		},
		(error: unknown) => {
			expect(error).toBeInstanceOf(RpcProjectSubagentError);
			expect((error as RpcProjectSubagentError).code).toBe(code);
		},
	);
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
});

afterEach(async () => {
	AgentRegistry.resetGlobalForTests();
	for (const tempDir of tempDirs.splice(0)) {
		await tempDir.remove();
	}
});

describe("RpcProjectSubagentDirectory (R5, rpc-ui-protocol.md §14.8)", () => {
	describe("artifactsDirForSessionFile", () => {
		test("strips the .jsonl suffix and passes other names through", () => {
			expect(artifactsDirForSessionFile(path.join("d", "2026-01-01_x.jsonl"))).toBe(path.join("d", "2026-01-01_x"));
			expect(artifactsDirForSessionFile(path.join("d", "plain"))).toBe(path.join("d", "plain"));
		});
	});

	describe("list", () => {
		test("merges running rows first with finished rows newest-first and live-id precedence", async () => {
			const tree = await createSessionTree("rpc-sub-list-merge-");
			await writeConversationalTranscript(tree.artifactsDir, "Old", { task: "old task" });
			// Same id as the live row: the durable copy must lose.
			await writeConversationalTranscript(tree.artifactsDir, "Live-1");
			const directory = makeDirectory(tree, [
				snapshot("Live-1", 1, {
					sessionFile: path.join(tree.artifactsDir, "Live-1.jsonl"),
					parentToolCallId: "tool-7",
				}),
				snapshot("Live-0", 0),
			]);

			const page = await directory.list(SID);

			const ids = page.items.map(item => item.subagentId);
			// Live rows first sorted by spawn index; the durable "Live-1" copy is gone.
			expect(ids).toEqual(["Live-0", "Live-1", "Old"]);
			const liveRow = page.items[1];
			expect(liveRow.status).toBe("running");
			expect(liveRow.recordReadable).toBe(true);
			expect(liveRow.parentToolCallId).toBe("tool-7");
			expect(liveRow.availableActions).toEqual(["send_message", "stop"]);
			const finishedRow = page.items[2];
			expect(finishedRow.status).toBe("interrupted");
			expect(finishedRow.availableActions).toEqual([]);
			expect(finishedRow.recordReadable).toBe(true);
			expect(typeof page.revision).toBe("string");
		}, 10_000);

		test("status filters split the merged directory", async () => {
			const tree = await createSessionTree("rpc-sub-list-filter-");
			await writeConversationalTranscript(tree.artifactsDir, "Done");
			const directory = makeDirectory(tree, [snapshot("Live-0", 0)]);

			const running = await directory.list(SID, { status: "running" });
			expect(running.items.map(item => item.subagentId)).toEqual(["Live-0"]);
			const finished = await directory.list(SID, { status: "finished" });
			expect(finished.items.map(item => item.subagentId)).toEqual(["Done"]);
		}, 10_000);

		test("terminal statuses come from durable facts only", async () => {
			const tree = await createSessionTree("rpc-sub-list-status-");
			// completed: conversational history + the executor's output artifact.
			const completed = await writeConversationalTranscript(tree.artifactsDir, "Alpha", { task: "alpha task" });
			await fs.writeFile(`${completed.slice(0, -".jsonl".length)}.md`, "final output");
			// aborted: explicit kill marker wins over everything else.
			const aborted = await writeConversationalTranscript(tree.artifactsDir, "Beta");
			await fs.writeFile(`${aborted}.tombstone`, "");
			// interrupted (1): header-only head — nothing ever ran.
			await fs.writeFile(path.join(tree.artifactsDir, "Empty.jsonl"), line(headerRecord(tree.artifactsDir)));
			// interrupted (2): ran, but no completion artifact and no kill marker.
			await writeConversationalTranscript(tree.artifactsDir, "Gamma");

			const page = await makeDirectory(tree).list(SID, { status: "finished" });

			const byId = new Map(page.items.map(item => [item.subagentId, item]));
			expect(byId.get("Alpha")?.status).toBe("completed");
			expect(byId.get("Beta")?.status).toBe("aborted");
			expect(byId.get("Empty")?.status).toBe("interrupted");
			expect(byId.get("Gamma")?.status).toBe("interrupted");
			expect(byId.get("Empty")?.recordReadable).toBe(true);
		}, 10_000);

		test("registry corroboration only applies to the exact transcript", async () => {
			const tree = await createSessionTree("rpc-sub-list-registry-");
			const transcript = await writeConversationalTranscript(tree.artifactsDir, "Parked");
			// A registry ref on THIS transcript upgrades the row to parked.
			AgentRegistry.global().register({
				id: "Parked",
				displayName: "Parked",
				kind: "sub",
				session: null,
				sessionFile: transcript,
				status: "parked",
			});
			// A same-id ref pointing somewhere else must NOT corroborate.
			await writeConversationalTranscript(tree.artifactsDir, "Foreign");
			AgentRegistry.global().register({
				id: "Foreign",
				displayName: "Foreign",
				kind: "sub",
				session: null,
				sessionFile: path.join(tree.root, "elsewhere.jsonl"),
				status: "aborted",
			});

			const page = await makeDirectory(tree).list(SID, { status: "finished" });
			const byId = new Map(page.items.map(item => [item.subagentId, item]));
			expect(byId.get("Parked")?.status).toBe("parked");
			// Parked rows keep send_message available (the IRC bus revives them).
			expect(byId.get("Parked")?.availableActions).toEqual(["send_message"]);
			expect(byId.get("Foreign")?.status).toBe("interrupted");
		}, 10_000);

		test("advisor transcripts and .bak backups are skipped; nested children are discovered", async () => {
			const tree = await createSessionTree("rpc-sub-list-scan-");
			await writeConversationalTranscript(tree.artifactsDir, "Real");
			await writeConversationalTranscript(tree.artifactsDir, "__advisor");
			await writeConversationalTranscript(tree.artifactsDir, "__advisor.extra");
			await fs.writeFile(path.join(tree.artifactsDir, "Backup.jsonl.bak"), "{}\n");
			const nestedDir = path.join(tree.artifactsDir, "Real");
			await fs.mkdir(nestedDir, { recursive: true });
			await writeConversationalTranscript(nestedDir, "Real.Child");

			const page = await makeDirectory(tree).list(SID, { status: "finished" });

			const ids = page.items.map(item => item.subagentId);
			expect(ids).toContain("Real");
			expect(ids).toContain("Real.Child");
			expect(ids).not.toContain("__advisor");
			expect(ids).not.toContain("__advisor.extra");
			expect(ids).not.toContain("Backup");
		}, 10_000);

		test("paginates with a string cursor and validates bounds", async () => {
			const tree = await createSessionTree("rpc-sub-list-page-");
			await writeConversationalTranscript(tree.artifactsDir, "A");
			await writeConversationalTranscript(tree.artifactsDir, "B");
			await writeConversationalTranscript(tree.artifactsDir, "C");
			const directory = makeDirectory(tree);

			const first = await directory.list(SID, { limit: 2 });
			expect(first.items).toHaveLength(2);
			expect(typeof first.nextCursor).toBe("string");
			const second = await directory.list(SID, { limit: 2, cursor: first.nextCursor });
			expect(second.items).toHaveLength(1);
			expect(second.nextCursor).toBeUndefined();

			await expectErrorCode(directory.list(SID, { limit: 0 }), "invalid_params");
			await expectErrorCode(directory.list(SID, { limit: 201 }), "invalid_params");
			await expectErrorCode(directory.list(SID, { limit: 1.5 }), "invalid_params");
			await expectErrorCode(directory.list(SID, { cursor: -1 as never }), "invalid_params");
			await expectErrorCode(directory.list(SID, { cursor: "invalid" }), "invalid_params");
		}, 10_000);

		test("a cursor from a changed snapshot or another filter rejects with stale_cursor", async () => {
			const tree = await createSessionTree("rpc-sub-list-stale-");
			await writeConversationalTranscript(tree.artifactsDir, "A");
			await writeConversationalTranscript(tree.artifactsDir, "B");
			const directory = makeDirectory(tree);
			const first = await directory.list(SID, { limit: 1 });
			expect(first.nextCursor).toBeDefined();
			// The snapshot changed between pages: a third durable row appeared.
			await writeConversationalTranscript(tree.artifactsDir, "C");
			await expectErrorCode(directory.list(SID, { limit: 1, cursor: first.nextCursor }), "stale_cursor");
			// A cursor bound to another filter is stale too, never silently reinterpreted.
			const runningFirst = await makeDirectory(tree, [snapshot("Live-0", 0), snapshot("Live-1", 1)]).list(SID, {
				status: "running",
				limit: 1,
			});
			expect(runningFirst.nextCursor).toBeDefined();
			await expectErrorCode(directory.list(SID, { limit: 1, cursor: runningFirst.nextCursor }), "stale_cursor");
		}, 10_000);

		test("unknown sessions reject with not_found", async () => {
			const tree = await createSessionTree("rpc-sub-list-unknown-");
			await expectErrorCode(makeDirectory(tree).list("no-such-session"), "not_found");
		}, 10_000);

		test("a changed catalog shape bumps the revision", async () => {
			const tree = await createSessionTree("rpc-sub-list-revision-");
			const directory = makeDirectory(tree);
			const before = (await directory.list(SID)).revision;
			await writeConversationalTranscript(tree.artifactsDir, "New");
			const after = (await directory.list(SID)).revision;
			expect(after).not.toBe(before);
			// A scan that observes the same shape leaves the revision alone.
			const again = (await directory.list(SID)).revision;
			expect(again).toBe(after);
		}, 10_000);
	});

	describe("messages", () => {
		test("reads complete records, filters to message entries and reports byte cursors", async () => {
			const tree = await createSessionTree("rpc-sub-msg-basic-");
			const transcript = await writeConversationalTranscript(tree.artifactsDir, "Reader");
			const stat = await fs.stat(transcript);

			const result = await makeDirectory(tree).messages(SID, "Reader");

			expect(result.fromByte).toBe(0);
			expect(result.hasMore).toBe(false);
			expect(result.nextByte).toBe(stat.size);
			expect(result.entries.map(entry => entry.type)).toEqual(["session", "session_init", "message"]);
			expect(result.messages).toHaveLength(1);
			expect((result.messages[0] as { role: string }).role).toBe("user");
		}, 10_000);

		test("resumes from a record boundary returned by a previous read", async () => {
			const tree = await createSessionTree("rpc-sub-msg-resume-");
			const transcript = path.join(tree.artifactsDir, "Chunked.jsonl");
			const records = [
				line(headerRecord(tree.artifactsDir)),
				line(messageRecord("m-1", "first", 2)),
				line(messageRecord("m-2", "second", 3)),
			];
			await fs.writeFile(transcript, records.join(""));
			const directory = makeDirectory(tree);

			const first = await directory.messages(SID, "Chunked", { maxBytes: Buffer.byteLength(records[0]) });
			expect(first.entries).toHaveLength(1);
			expect(first.hasMore).toBe(true);
			const second = await directory.messages(SID, "Chunked", { fromByte: first.nextByte });

			expect(second.entries.map(entry => (entry as { id?: string }).id)).toEqual(["m-1", "m-2"]);
			expect(second.messages).toHaveLength(2);
			expect(second.hasMore).toBe(false);
		}, 10_000);

		test("an oversized first record is reported, never truncated into corrupt JSON", async () => {
			const tree = await createSessionTree("rpc-sub-msg-toolarge-");
			const transcript = path.join(tree.artifactsDir, "Big.jsonl");
			const header = line(headerRecord(tree.artifactsDir));
			const bigRecord = line(messageRecord("m-big", "x".repeat(4096), 2));
			await fs.writeFile(transcript, header + bigRecord);
			const directory = makeDirectory(tree);

			// First window consumes the header; the next read starts AT the big record.
			const first = await directory.messages(SID, "Big", { maxBytes: Buffer.byteLength(header) });
			expect(first.entries).toHaveLength(1);
			const result = await directory.messages(SID, "Big", { fromByte: first.nextByte, maxBytes: 1024 });

			expect(result.entries).toEqual([]);
			expect(result.messages).toEqual([]);
			expect(result.nextByte).toBe(first.nextByte);
			expect(result.hasMore).toBe(true);
			expect(result.recordTooLarge?.byteLength).toBe(Buffer.byteLength(bigRecord));
		}, 10_000);

		test("fromByte past EOF resets to zero with reset: true", async () => {
			const tree = await createSessionTree("rpc-sub-msg-reset-");
			await writeConversationalTranscript(tree.artifactsDir, "Reset");

			const result = await makeDirectory(tree).messages(SID, "Reset", { fromByte: 1_000_000 });

			expect(result.reset).toBe(true);
			expect(result.fromByte).toBe(0);
			expect(result.entries.length).toBeGreaterThan(0);
		}, 10_000);

		test("the final unterminated record is completed at EOF so the cursor advances", async () => {
			const tree = await createSessionTree("rpc-sub-msg-eof-");
			const transcript = path.join(tree.artifactsDir, "NoNewline.jsonl");
			const header = line(headerRecord(tree.artifactsDir));
			await fs.writeFile(transcript, header + JSON.stringify(messageRecord("m-1", "dangling", 2)));
			const directory = makeDirectory(tree);

			const first = await directory.messages(SID, "NoNewline");
			// The window ends at the header's newline; the dangling record stays ahead.
			expect(first.entries).toHaveLength(1);
			expect(first.hasMore).toBe(true);
			const second = await directory.messages(SID, "NoNewline", { fromByte: first.nextByte });

			expect(second.entries.map(entry => (entry as { id?: string }).id)).toEqual(["m-1"]);
			expect(second.nextByte).toBe(
				Buffer.byteLength(header) + Buffer.byteLength(JSON.stringify(messageRecord("m-1", "dangling", 2))),
			);
			expect(second.hasMore).toBe(false);
		}, 10_000);

		test("a foreign live snapshot transcript is rejected instead of overriding the owned artifacts", async () => {
			const tree = await createSessionTree("rpc-sub-msg-live-");
			const elsewhere = await TempDir.create("rpc-sub-msg-live-elsewhere-");
			tempDirs.push(elsewhere);
			const liveTranscript = path.join(elsewhere.toString(), "Elsewhere.jsonl");
			await fs.writeFile(liveTranscript, line(messageRecord("m-1", "from live path", 2)));
			await writeConversationalTranscript(tree.artifactsDir, "Routed");
			const directory = makeDirectory(tree, [snapshot("Routed", 0, { sessionFile: liveTranscript })]);

			await expectErrorCode(directory.messages(SID, "Routed"), "scope_not_allowed");
		}, 10_000);

		test("unknown sessions and subagents reject; malformed windows reject", async () => {
			const tree = await createSessionTree("rpc-sub-msg-errors-");
			await writeConversationalTranscript(tree.artifactsDir, "Known");
			const directory = makeDirectory(tree);

			await expectErrorCode(directory.messages("no-such-session", "Known"), "not_found");
			await expectErrorCode(directory.messages(SID, "no-such-subagent"), "not_found");
			await expectErrorCode(directory.messages(SID, "Known", { fromByte: -1 }), "invalid_params");
			await expectErrorCode(directory.messages(SID, "Known", { maxBytes: 0 }), "invalid_params");
		}, 10_000);
	});

	describe("control", () => {
		test("stop rejects anything that is not currently running", async () => {
			const tree = await createSessionTree("rpc-sub-stop-notrunning-");
			await writeConversationalTranscript(tree.artifactsDir, "Done");
			const directory = makeDirectory(tree);

			await expectErrorCode(directory.control(SID, "Done", "stop"), "not_found");
		}, 10_000);

		test("stop routes through the injected cancel hook", async () => {
			const tree = await createSessionTree("rpc-sub-stop-hook-");
			const transcript = await writeConversationalTranscript(tree.artifactsDir, "Live");
			const cancelled: Array<[string, string]> = [];
			const directory = makeDirectory(tree, [snapshot("Live", 0, { sessionFile: transcript })], {
				cancelSubagent: async (sessionId, subagentId) => {
					cancelled.push([sessionId, subagentId]);
					return true;
				},
			});

			const result = await directory.control(SID, "Live", "stop");

			expect(cancelled).toEqual([[SID, "Live"]]);
			expect(result.status).toBe("stopping");
			expect(result.action).toBe("stop");
		}, 10_000);

		test("a refused or throwing cancel hook surfaces execution_failed", async () => {
			const tree = await createSessionTree("rpc-sub-stop-refused-");
			const transcript = await writeConversationalTranscript(tree.artifactsDir, "Live");
			const refused = makeDirectory(tree, [snapshot("Live", 0, { sessionFile: transcript })], {
				cancelSubagent: async () => false,
			});
			await expectErrorCode(refused.control(SID, "Live", "stop"), "execution_failed");

			const throwing = makeDirectory(tree, [snapshot("Live", 0, { sessionFile: transcript })], {
				cancelSubagent: async () => {
					throw new Error("boom");
				},
			});
			await expectErrorCode(throwing.control(SID, "Live", "stop"), "execution_failed");
		}, 10_000);

		test("the registry fallback aborts an in-project ref and rejects foreign targets", async () => {
			const tree = await createSessionTree("rpc-sub-stop-registry-");
			const inProject = await writeConversationalTranscript(tree.artifactsDir, "InProject");
			AgentRegistry.global().register({
				id: "InProject",
				displayName: "InProject",
				kind: "sub",
				session: null,
				sessionFile: inProject,
				status: "running",
			});
			// Foreign target: same project's live row, but its registry ref (the
			// durable identity) lives under ANOTHER project's session dir.
			const foreignTemp = await TempDir.create("rpc-sub-stop-foreign-");
			tempDirs.push(foreignTemp);
			const foreignRoot = foreignTemp.toString();
			AgentRegistry.global().register({
				id: "Foreign",
				displayName: "Foreign",
				kind: "sub",
				session: null,
				sessionFile: path.join(foreignRoot, "other-project.jsonl"),
				status: "running",
			});
			const directory = makeDirectory(tree, [
				snapshot("InProject", 0, { sessionFile: inProject }),
				snapshot("Foreign", 1, { sessionFile: path.join(foreignRoot, "other-project.jsonl") }),
			]);

			const result = await directory.control(SID, "InProject", "stop");
			expect(result.status).toBe("stopping");
			expect(AgentRegistry.global().get("InProject")?.status).toBe("aborted");

			await expectErrorCode(directory.control(SID, "Foreign", "stop"), "scope_not_allowed");
		}, 10_000);

		test("two concurrent sessions with the same subagent id control their own generation (§13.2/§17.2 O20)", async () => {
			// Two sessions of one project process, each with its OWN artifacts tree
			// and a live subagent registered under the SAME id — the later spawn
			// overwrites the process-global registry entry exactly as in production.
			const treeA = await createSessionTree("rpc-sub-collide-a-");
			const treeB = await createSessionTree("rpc-sub-collide-b-");
			const transcriptA = await writeConversationalTranscript(treeA.artifactsDir, "task-1");
			const transcriptB = await writeConversationalTranscript(treeB.artifactsDir, "task-1");
			const logA: SubagentSessionLog = { aborts: [], deliveries: [] };
			const logB: SubagentSessionLog = { aborts: [], deliveries: [] };
			const sentByBus: Array<{ from: string; to: string; body: string }> = [];
			const trees = new Map<string, SessionTree>([
				["sess-a", treeA],
				["sess-b", treeB],
			]);
			const live = new Map<string, RpcSubagentSnapshot[]>([
				["sess-a", [snapshot("task-1", 0, { sessionFile: transcriptA })]],
				["sess-b", [snapshot("task-1", 0, { sessionFile: transcriptB })]],
			]);
			// The directory captures generations from `registered` events, so it must
			// exist before the spawns; only then do the two same-id refs register.
			const directory = new RpcProjectSubagentDirectory({
				resolveSessionFile: sessionId => trees.get(sessionId)?.sessionFile,
				senderId: sessionId => (sessionId === "sess-a" ? "main-a" : "main-b"),
				liveSnapshots: sessionId => live.get(sessionId) ?? [],
				sendIrcMessage: async message => {
					sentByBus.push({ from: message.from, to: message.to, body: message.body });
					return { to: message.to, outcome: "woken" };
				},
			});
			const refA = AgentRegistry.global().register({
				id: "task-1",
				displayName: "task-1",
				kind: "sub",
				session: fakeSubagentSession("a", logA),
				sessionFile: transcriptA,
				status: "running",
			});
			AgentRegistry.global().register({
				id: "task-1",
				displayName: "task-1",
				kind: "sub",
				session: fakeSubagentSession("b", logB),
				sessionFile: transcriptB,
				status: "running",
			});

			// send_message: session A's generation was superseded, so delivery goes
			// to its OWN live session; session B still owns the global entry and
			// uses the bus. Neither leg reaches the other session's agent.
			const sendA = await directory.control("sess-a", "task-1", "send_message", "hello A");
			expect(sendA.status).toBe("sent");
			expect(sendA.receipts).toEqual([{ to: "task-1", outcome: "injected" }]);
			expect(logA.deliveries).toEqual([{ from: "main-a", to: "task-1", body: "hello A" }]);
			const sendB = await directory.control("sess-b", "task-1", "send_message", "hello B");
			expect(sendB.receipts).toEqual([{ to: "task-1", outcome: "woken" }]);
			expect(sentByBus).toEqual([{ from: "main-b", to: "task-1", body: "hello B" }]);
			expect(logA.deliveries).toHaveLength(1);

			// The executor observes ref identity, including a superseded generation.
			const cancellation = new AbortController();
			const unsubscribe = AgentRegistry.global().onChange(event => {
				if (event.type === "status_changed" && event.ref === refA && event.ref.status === "aborted") {
					cancellation.abort();
				}
			});
			const stopA = await directory.control("sess-a", "task-1", "stop");
			unsubscribe();
			expect(stopA.status).toBe("stopping");
			expect(cancellation.signal.aborted).toBe(true);
			expect(refA.status).toBe("aborted");
			expect(logA.aborts).toEqual([]);
			expect(logB.aborts).toEqual([]);
			expect(AgentRegistry.global().get("task-1")?.status).toBe("running");
			const stopB = await directory.control("sess-b", "task-1", "stop");
			expect(stopB.status).toBe("stopping");
			expect(logB.aborts).toEqual([]);
			expect(AgentRegistry.global().get("task-1")?.status).toBe("aborted");
		}, 10_000);

		test("retains control of live same-id generations beyond eight sessions", async () => {
			const trees = new Map<string, SessionTree>();
			const live = new Map<string, RpcSubagentSnapshot[]>();
			const directory = new RpcProjectSubagentDirectory({
				resolveSessionFile: sessionId => trees.get(sessionId)?.sessionFile,
				senderId: sessionId => sessionId,
				liveSnapshots: sessionId => live.get(sessionId) ?? [],
				sendIrcMessage: async message => ({ to: message.to, outcome: "injected" }),
			});
			try {
				const logs: SubagentSessionLog[] = [];
				for (let index = 0; index < 9; index++) {
					const id = `sess-${index}`;
					const tree = await createSessionTree("rpc-sub-many-collisions-");
					const transcript = await writeConversationalTranscript(tree.artifactsDir, "task-1");
					trees.set(id, tree);
					live.set(id, [snapshot("task-1", 0, { sessionFile: transcript })]);
					const log: SubagentSessionLog = { aborts: [], deliveries: [] };
					logs.push(log);
					AgentRegistry.global().register({
						id: "task-1",
						displayName: "task-1",
						kind: "sub",
						status: "running",
						session: fakeSubagentSession(id, log),
						sessionFile: transcript,
					});
				}
				expect((await directory.control("sess-0", "task-1", "send_message", "oldest")).status).toBe("sent");
				expect(logs[0]!.deliveries).toEqual([{ from: "sess-0", to: "task-1", body: "oldest" }]);
				expect(logs.slice(1).every(log => log.deliveries.length === 0)).toBe(true);
				expect((await directory.control("sess-0", "task-1", "stop")).status).toBe("stopping");
				expect(AgentRegistry.global().get("task-1")?.status).toBe("running");
			} finally {
				directory.dispose();
			}
		}, 10_000);

		test("send_message validates input and configuration", async () => {
			const tree = await createSessionTree("rpc-sub-send-validate-");
			await writeConversationalTranscript(tree.artifactsDir, "Any");
			const directory = makeDirectory(tree);

			await expectErrorCode(directory.control(SID, "Any", "send_message", ""), "invalid_params");
			await expectErrorCode(directory.control(SID, "Any", "send_message"), "invalid_params");
			// No IRC send configured on this host.
			await expectErrorCode(directory.control(SID, "Any", "send_message", "hi"), "unsupported");
			// Unknown session rejects before any send.
			await expectErrorCode(
				makeDirectory(tree, [], { sendIrcMessage: async () => ({ to: "Any", outcome: "injected" }) }).control(
					"no-such-session",
					"Any",
					"send_message",
					"hi",
				),
				"not_found",
			);
			await expectErrorCode(directory.control(SID, "Any", "bogus-action" as never, "hi"), "invalid_params");
		}, 10_000);

		test("send_message fixes the sender identity, guards scope and maps receipt outcomes", async () => {
			const tree = await createSessionTree("rpc-sub-send-delivery-");
			const sent: Array<{ from: string; to: string; body: string }> = [];
			for (const id of ["Parked", "Broken"]) {
				const transcript = await writeConversationalTranscript(tree.artifactsDir, id);
				AgentRegistry.global().register({
					id,
					displayName: id,
					kind: "sub",
					session: null,
					sessionFile: transcript,
					status: "parked",
				});
			}
			const directory = makeDirectory(tree, [], {
				sendIrcMessage: async message => {
					sent.push(message);
					return message.to === "Broken"
						? { to: message.to, outcome: "failed", error: "mailbox gone" }
						: { to: message.to, outcome: "woken" };
				},
			});

			const result = await directory.control(SID, "Parked", "send_message", "status?");

			// The sender identity is fixed server-side; the GUI never impersonates.
			expect(sent).toEqual([{ from: "rpcp:test-main", to: "Parked", body: "status?" }]);
			expect(result.status).toBe("sent");
			expect(result.receipts).toEqual([{ to: "Parked", outcome: "woken" }]);
			expect(result.detail).toContain("processing not implied");

			await expectErrorCode(directory.control(SID, "Broken", "send_message", "hi"), "execution_failed");

			// A registry ref living outside this project's session dir is rejected.
			AgentRegistry.global().register({
				id: "Outside",
				displayName: "Outside",
				kind: "sub",
				session: null,
				sessionFile: path.join(tree.root, "..", "elsewhere.jsonl"),
				status: "parked",
			});
			await expectErrorCode(directory.control(SID, "Outside", "send_message", "hi"), "not_found");
		}, 10_000);
	});
});
