import { describe, expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { RpcForkHost, type RpcForkContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-host";
import { RpcForkQueueController, type RpcForkQueueSnapshot } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-queue";
import { RpcForkJobController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-jobs";
import { RpcForkSearchController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-search";
import { RpcForkFeedbackController, RpcForkHookTelemetry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-state";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const makeContext = (emitted: object[]): RpcForkContext => ({
	emit: frame => emitted.push(frame),
	success: (id, command, data) => ({ id, type: "response", command, success: true, data }) as RpcResponse,
	error: (id, command, message, code) =>
		({ id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) }) as RpcResponse,
});

const userMessage = (text: string): AgentMessage =>
	({ role: "user", content: text, timestamp: new Date().toISOString() }) as unknown as AgentMessage;

interface QueueFixture {
	host: RpcForkHost;
	agent: Agent;
	emitted: object[];
	run: (command: object) => Promise<RpcResponse>;
	setQueues: (steering: AgentMessage[], followUp: AgentMessage[]) => void;
	current: { steering: AgentMessage[]; followUp: AgentMessage[] };
}

function setupQueue(activate = true, agent = new Agent()): QueueFixture {
	const emitted: object[] = [];
	const host = new RpcForkHost(makeContext(emitted));
	if (activate) host.activate();
	const current = {
		get steering(): AgentMessage[] {
			return [...agent.peekSteeringQueue()];
		},
		get followUp(): AgentMessage[] {
			return [...agent.peekFollowUpQueue()];
		},
	};
	const session = { agent } as unknown as AgentSession;
	new RpcForkQueueController(host, session);
	return {
		host,
		agent,
		emitted,
		run: command => host.handleCommand(command as { type: string }) as Promise<RpcResponse>,
		setQueues: (steering, followUp) => agent.replaceQueues(steering, followUp),
		current,
	};
}

describe("RpcForkQueueController (5.1)", () => {
	test("get_queue mints stable ids and reports text/imageCount per entry", async () => {
		const fx = setupQueue();
		fx.setQueues([userMessage("first"), userMessage("second")], [userMessage("third")]);
		const first = (await fx.run({ id: "q1", type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		const snapshot1 = first.data as RpcForkQueueSnapshot;
		expect(snapshot1.steering.map(entry => entry.text)).toEqual(["first", "second"]);
		expect(snapshot1.followUp.map(entry => entry.text)).toEqual(["third"]);
		expect(snapshot1.steering.every(entry => entry.id.length > 0)).toBe(true);
		expect(snapshot1.steering.every(entry => entry.imageCount === 0)).toBe(true);

		// Ids are stable across repeated reads while entries stay queued.
		const second = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		expect((second.data as RpcForkQueueSnapshot).steering.map(entry => entry.id)).toEqual(
			snapshot1.steering.map(entry => entry.id),
		);
	});

	test("remove_queued drops the entry, keeps the rest, and emits queue_updated", async () => {
		const fx = setupQueue();
		const a = userMessage("a");
		const b = userMessage("b");
		fx.setQueues([a, b], []);
		const listed = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		const ids = (listed.data as RpcForkQueueSnapshot).steering.map(entry => entry.id);

		const removed = await fx.run({ id: "r1", type: "remove_queued", queue: "steering", entryId: ids[0] });
		expect(removed).toMatchObject({ command: "remove_queued", success: true });
		expect(fx.current.steering.map(message => (message as { content: string }).content)).toEqual(["b"]);
		expect(fx.emitted.at(-1)).toMatchObject({ type: "queue_updated", steeringCount: 1, followUpCount: 0 });

		const unknown = await fx.run({ type: "remove_queued", queue: "steering", entryId: "q999" });
		expect(unknown).toMatchObject({ success: false, code: "unknown_queue_entry" });
	});

	test("reorder_queue applies the full permutation and rejects partial or duplicate ids", async () => {
		const fx = setupQueue();
		fx.setQueues([userMessage("a"), userMessage("b"), userMessage("c")], []);
		const listed = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		const ids = (listed.data as RpcForkQueueSnapshot).steering.map(entry => entry.id);

		const bad = await fx.run({ type: "reorder_queue", queue: "steering", ids: [ids[0]] });
		expect(bad).toMatchObject({ success: false, code: "unknown_queue_entry" });

		const reordered = await fx.run({
			id: "o1",
			type: "reorder_queue",
			queue: "steering",
			ids: [ids[2], ids[0], ids[1]],
		});
		expect(reordered).toMatchObject({ success: true });
		expect(fx.current.steering.map(message => (message as { content: string }).content)).toEqual(["c", "a", "b"]);
		expect(fx.emitted.at(-1)).toMatchObject({ type: "queue_updated", steeringCount: 3 });

		// Injection order follows the new arrangement.
		const after = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		expect((after.data as RpcForkQueueSnapshot).steering.map(entry => entry.id)).toEqual([ids[2], ids[0], ids[1]]);
	});

	test("clear_queue clears one or both queues; invalid queue names rejected", async () => {
		const fx = setupQueue();
		fx.setQueues([userMessage("a")], [userMessage("b")]);
		const cleared = await fx.run({ id: "c1", type: "clear_queue", queue: "steering" });
		expect(cleared).toMatchObject({ success: true });
		expect(fx.current.steering).toHaveLength(0);
		expect(fx.current.followUp).toHaveLength(1);

		const all = await fx.run({ type: "clear_queue" });
		expect(all).toMatchObject({ success: true });
		expect(fx.current.followUp).toHaveLength(0);

		const bad = await fx.run({ type: "clear_queue", queue: " sideways " });
		expect(bad).toMatchObject({ success: false });
	});

	test("clear_queue guards the snapshot with expectedRevision and reports the new revision", async () => {
		const fx = setupQueue();
		fx.setQueues([userMessage("a")], [userMessage("b")]);
		const listed = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		const staleRevision = (listed.data as RpcForkQueueSnapshot).revision;

		// A stale revision must not drop entries enqueued after the caller read the queue.
		fx.setQueues([userMessage("a"), userMessage("late")], [userMessage("b")]);
		const conflicted = await fx.run({
			id: "c2",
			type: "clear_queue",
			queue: "steering",
			expectedRevision: staleRevision,
		});
		expect(conflicted).toMatchObject({ command: "clear_queue", success: false, code: "revision_conflict" });
		expect(fx.current.steering).toHaveLength(2);

		// A matching revision clears and reports the post-clear revision.
		const fresh = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		const currentRevision = (fresh.data as RpcForkQueueSnapshot).revision;
		const cleared = (await fx.run({
			id: "c3",
			type: "clear_queue",
			queue: "steering",
			expectedRevision: currentRevision,
		})) as Extract<RpcResponse, { command: "clear_queue"; success: true }>;
		expect(cleared.success).toBe(true);
		expect(cleared.data.revision).toBeGreaterThan(currentRevision);
		const after = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		expect((after.data as RpcForkQueueSnapshot).revision).toBe(cleared.data.revision);
		expect(fx.current.steering).toHaveLength(0);

		// Omitting expectedRevision keeps the legacy unconditional clear.
		const legacy = await fx.run({ type: "clear_queue" });
		expect(legacy).toMatchObject({ command: "clear_queue", success: true });
		expect(fx.current.followUp).toHaveLength(0);
	});

	test("remove_queued guards the snapshot with expectedRevision and reports the new revision", async () => {
		const fx = setupQueue();
		const a = userMessage("a");
		const late = userMessage("late");
		fx.setQueues([a], [userMessage("b")]);
		const listed = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		const staleRevision = (listed.data as RpcForkQueueSnapshot).revision;
		const staleId = (listed.data as RpcForkQueueSnapshot).steering.map(entry => entry.id)[0];

		// A still-valid id must not remove after the queue changed post-read.
		fx.setQueues([a, late], [userMessage("b")]);
		const conflicted = await fx.run({
			id: "r2",
			type: "remove_queued",
			queue: "steering",
			entryId: staleId,
			expectedRevision: staleRevision,
		});
		expect(conflicted).toMatchObject({ command: "remove_queued", success: false, code: "revision_conflict" });
		expect(fx.current.steering).toHaveLength(2);

		// A matching revision removes the entry and reports the post-remove revision.
		const fresh = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		const freshIds = (fresh.data as RpcForkQueueSnapshot).steering.map(entry => entry.id);
		const currentRevision = (fresh.data as RpcForkQueueSnapshot).revision;
		const removed = (await fx.run({
			id: "r3",
			type: "remove_queued",
			queue: "steering",
			entryId: freshIds[0],
			expectedRevision: currentRevision,
		})) as Extract<RpcResponse, { command: "remove_queued"; success: true }>;
		expect(removed.success).toBe(true);
		expect(removed.data.revision).toBeGreaterThan(currentRevision);
		const after = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		expect((after.data as RpcForkQueueSnapshot).revision).toBe(removed.data.revision);
		expect(fx.current.steering.map(message => (message as { content: string }).content)).toEqual(["late"]);

		// Omitting expectedRevision keeps the legacy id-based remove.
		const legacy = await fx.run({ type: "remove_queued", queue: "steering", entryId: freshIds[1] });
		expect(legacy).toMatchObject({ command: "remove_queued", success: true });
		expect(fx.current.steering).toHaveLength(0);
	});

	test("reorder_queue guards the snapshot with expectedRevision and reports the new revision", async () => {
		const fx = setupQueue();
		const a = userMessage("a");
		const b = userMessage("b");
		fx.setQueues([a, b], []);
		const listed = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		const staleRevision = (listed.data as RpcForkQueueSnapshot).revision;
		const ids = (listed.data as RpcForkQueueSnapshot).steering.map(entry => entry.id);

		// A still-valid permutation must not reorder after the queue changed elsewhere.
		fx.setQueues([a, b], [userMessage("late")]);
		const conflicted = await fx.run({
			id: "o2",
			type: "reorder_queue",
			queue: "steering",
			ids: [ids[1], ids[0]],
			expectedRevision: staleRevision,
		});
		expect(conflicted).toMatchObject({ command: "reorder_queue", success: false, code: "revision_conflict" });
		expect(fx.current.steering.map(message => (message as { content: string }).content)).toEqual(["a", "b"]);

		// A matching revision reorders and reports the post-reorder revision.
		const fresh = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		const freshIds = (fresh.data as RpcForkQueueSnapshot).steering.map(entry => entry.id);
		const currentRevision = (fresh.data as RpcForkQueueSnapshot).revision;
		const reordered = (await fx.run({
			id: "o3",
			type: "reorder_queue",
			queue: "steering",
			ids: [freshIds[1], freshIds[0]],
			expectedRevision: currentRevision,
		})) as Extract<RpcResponse, { command: "reorder_queue"; success: true }>;
		expect(reordered.success).toBe(true);
		expect(reordered.data.revision).toBeGreaterThan(currentRevision);
		const after = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		expect((after.data as RpcForkQueueSnapshot).revision).toBe(reordered.data.revision);
		expect(fx.current.steering.map(message => (message as { content: string }).content)).toEqual(["b", "a"]);

		// Omitting expectedRevision keeps the legacy set-checked reorder.
		const legacy = await fx.run({ type: "reorder_queue", queue: "steering", ids: [freshIds[0], freshIds[1]] });
		expect(legacy).toMatchObject({ command: "reorder_queue", success: true });
		expect(fx.current.steering.map(message => (message as { content: string }).content)).toEqual(["a", "b"]);
	});

	test("user queue edits move/remove hidden companions without deleting runtime context", async () => {
		const fx = setupQueue();
		const a = userMessage("a");
		const b = userMessage("b");
		const companion = (text: string): AgentMessage => ({
			role: "custom",
			customType: "fullsend-notice",
			content: text,
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		});
		const beforeA = companion("for a");
		const beforeB = companion("for b");
		const advisor: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "runtime advice",
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
		};
		fx.setQueues([beforeA, a, advisor, beforeB, b], []);
		const listed = (await fx.run({ type: "get_queue" })) as Extract<
			RpcResponse,
			{ command: "get_queue"; success: true }
		>;
		expect(listed.data.steering.map(entry => entry.text)).toEqual(["a", "b"]);
		const ids = listed.data.steering.map(entry => entry.id);
		await fx.run({ type: "reorder_queue", queue: "steering", ids: [ids[1], ids[0]] });
		expect(fx.current.steering).toEqual([beforeB, b, advisor, beforeA, a]);
		await fx.run({ type: "remove_queued", queue: "steering", entryId: ids[1] });
		expect(fx.current.steering).toEqual([advisor, beforeA, a]);
		await fx.run({ type: "clear_queue", queue: "steering" });
		expect(fx.current.steering).toEqual([advisor]);
		expect(fx.emitted.at(-1)).toMatchObject({ type: "queue_updated", steeringCount: 0, followUpCount: 0 });
	});

	test("runtime enqueue and consumption invalidate v3 snapshots, but not before negotiation or after disposal", () => {
		const fx = setupQueue(false);
		fx.agent.followUp(userMessage("queued before negotiation"));
		expect(fx.emitted).toEqual([]);
		fx.host.activate();
		fx.agent.steer(userMessage("runtime steering"));
		expect(fx.emitted.at(-1)).toMatchObject({ type: "queue_updated", steeringCount: 1, followUpCount: 1 });
		fx.agent.clearFollowUpQueue();
		expect(fx.emitted.at(-1)).toMatchObject({ type: "queue_updated", steeringCount: 1, followUpCount: 0 });
		const emittedCount = fx.emitted.length;
		fx.host.dispose("done");
		fx.agent.clearSteeringQueue();
		expect(fx.emitted).toHaveLength(emittedCount);
	});

	test("editing steering does not cancel a follow-up batch whose preparation is in flight", async () => {
		const model = createMockModel({ responses: [{ content: ["first turn"] }, { content: ["follow-up delivered"] }] });
		const agent = new Agent({ initialState: { model: model.model }, streamFn: model.stream });
		const fx = setupQueue(true, agent);
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		agent.prepareQueuedMessages = async (_messages, signal) => {
			started.resolve(signal);
			await release.promise;
			return { commit: () => [] };
		};
		agent.followUp(userMessage("claimed follow-up"));
		const running = agent.prompt("opening turn");
		try {
			const preparationSignal = await started.promise;
			expect(await fx.run({ type: "clear_queue", queue: "steering" })).toMatchObject({ success: true });
			expect(preparationSignal.aborted).toBe(false);
			release.resolve();
			await running;
			expect(
				agent.state.messages.filter(message => message.role === "user" && message.content === "claimed follow-up"),
			).toHaveLength(1);
			expect(
				agent.state.messages.some(
					message =>
						message.role === "assistant" &&
						message.content.some(block => block.type === "text" && block.text === "follow-up delivered"),
				),
			).toBe(true);
		} finally {
			release.resolve();
			await running;
			fx.host.dispose("done");
		}
	});
});

describe("RpcForkJobController (5.2)", () => {
	test("get_jobs without a job manager returns empty arrays; cancel_job unknown id fails with code", async () => {
		const emitted: object[] = [];
		const host = new RpcForkHost(makeContext(emitted));
		host.activate();
		const session = { asyncJobManager: undefined, getAgentId: () => "agent-1" } as unknown as AgentSession;
		new RpcForkJobController(host, session);

		const jobs = await host.handleCommand({ id: "j1", type: "get_jobs" } as never);
		expect(jobs).toMatchObject({ command: "get_jobs", success: true, data: { running: [], recent: [] } });

		const cancel = await host.handleCommand({ id: "j2", type: "cancel_job", jobId: "nope" } as never);
		expect(cancel).toMatchObject({ command: "cancel_job", success: false, code: "unknown_job" });
	});

	test("cancel_job on a settled job reports already_completed with no message field", async () => {
		const emitted: object[] = [];
		const host = new RpcForkHost(makeContext(emitted));
		host.activate();
		const job = {
			id: "job-done",
			type: "bash",
			status: "completed",
			label: "echo done",
			startTime: Date.now() - 1_000,
			endTime: Date.now(),
			ownerId: "agent-1",
		};
		// Minimal AsyncJobManager stub covering executeCancel/buildJobResult reads.
		const manager = {
			getJob: (id: string) => (id === job.id ? job : undefined),
			isJobResultConsumed: () => false,
			consumeJobResults: () => {},
		};
		const session = { asyncJobManager: manager, getAgentId: () => "agent-1" } as unknown as AgentSession;
		new RpcForkJobController(host, session);

		const cancel = (await host.handleCommand({
			id: "j3",
			type: "cancel_job",
			jobId: "job-done",
		} as never)) as Extract<RpcResponse, { command: "cancel_job"; success: true }>;
		expect(cancel.success).toBe(true);
		expect(cancel.data).toEqual({ jobId: "job-done", status: "already_completed" });
	});
});

describe("RpcForkSearchController (5.7)", () => {
	test("fuzzy query hits files and directories with ignore rules and truncation flag", async () => {
		await using rootDir = await TempDir.create("rpc-search-root-");
		const root = path.resolve(rootDir.path());
		await fs.mkdir(path.join(root, "rpc-demo-dir"), { recursive: true });
		await fs.writeFile(path.join(root, "rpc-demo-file.txt"), "x");
		await fs.writeFile(path.join(root, "unrelated.log"), "x");

		const emitted: object[] = [];
		const host = new RpcForkHost(makeContext(emitted));
		host.activate();
		const session = { sessionManager: { getCwd: () => root } } as unknown as AgentSession;
		new RpcForkSearchController(host, session);

		const response = (await host.handleCommand({
			id: "s1",
			type: "search_paths",
			query: "rpcdemo",
		} as never)) as Extract<RpcResponse, { command: "search_paths"; success: true }>;
		expect(response.success).toBe(true);
		const paths = (response.data as { entries: Array<{ path: string; type: string }>; truncated: boolean }).entries;
		expect(paths.some(entry => entry.path.endsWith("rpc-demo-file.txt") && entry.type === "file")).toBe(true);
		expect(paths.some(entry => entry.path.endsWith("rpc-demo-dir") && entry.type === "dir")).toBe(true);
		expect(paths.some(entry => entry.path.endsWith("unrelated.log"))).toBe(false);

		const missing = await host.handleCommand({ type: "search_paths" } as never);
		expect(missing).toMatchObject({ success: false });
	});
});

describe("RpcForkFeedbackController (5.8)", () => {
	test("submit_feedback appends a local jsonl record and rejects invalid ratings", async () => {
		await using agentDir = await TempDir.create("rpc-feedback-agent-");
		const emitted: object[] = [];
		const host = new RpcForkHost(makeContext(emitted));
		host.activate();
		const session = { sessionId: "sess-1" } as unknown as AgentSession;
		const controller = new RpcForkFeedbackController(host, session, { agentDir: path.resolve(agentDir.path()) });

		const ok = (await host.handleCommand({
			id: "f1",
			type: "submit_feedback",
			messageId: "msg-9",
			rating: "up",
			comment: "  great answer  ",
		} as never)) as Extract<RpcResponse, { command: "submit_feedback"; success: true }>;
		expect(ok.data).toMatchObject({ stored: true });
		const file = (ok.data as { file: string }).file;
		const lines = (await fs.readFile(file, "utf-8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			sessionId: "sess-1",
			messageId: "msg-9",
			rating: "up",
			comment: "great answer",
		});
		expect(controller.feedbackFile).toBe(file);

		const bad = await host.handleCommand({ type: "submit_feedback", messageId: "m", rating: "meh" } as never);
		expect(bad).toMatchObject({ success: false });
	});
});

describe("RpcForkHookTelemetry + goal snapshot (5.8)", () => {
	test("classifies extension sources and stays silent before v3", () => {
		const emitted: object[] = [];
		const host = new RpcForkHost(makeContext(emitted));
		const session = { sessionManager: { getCwd: () => "D:/work/project" } } as unknown as AgentSession;
		const telemetry = new RpcForkHookTelemetry(host, session);

		telemetry.onHookExecuted({
			extensionPath: "D:/work/project/.omp/hooks/pre/x.ts",
			event: "session_start",
			durationMs: 1.4,
			status: "ok",
		});
		expect(emitted).toHaveLength(0); // gated on v3

		host.activate();
		const userHook = path.join(getAgentDir(), "hooks", "y.ts");
		telemetry.onHookExecuted({
			extensionPath: "D:/work/project/.omp/hooks/pre/x.ts",
			event: "session_start",
			durationMs: 1.4,
			status: "ok",
		});
		telemetry.onHookExecuted({
			extensionPath: userHook,
			event: "turn_start",
			durationMs: 12.6,
			status: "error",
			reason: "boom",
		});
		telemetry.onHookExecuted({
			extensionPath: "D:/plugins/z/hooks/z.ts",
			event: "tool_call",
			durationMs: 3,
			status: "timeout",
			reason: "slow",
		});
		expect(emitted).toHaveLength(3);
		expect(emitted[0]).toMatchObject({
			type: "hook_executed",
			hookId: "x.ts",
			event: "session_start",
			source: "workspace",
			durationMs: 1,
			status: "ok",
		});
		expect(emitted[1]).toMatchObject({ hookId: "y.ts", source: "user", status: "error", reason: "boom" });
		expect(emitted[2]).toMatchObject({ source: "plugin", status: "timeout" });
	});
});
