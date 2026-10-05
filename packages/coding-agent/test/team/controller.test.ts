/**
 * `/team` controller dispatch-level tests: job-manager registration failures
 * surface as actionable /team messages instead of raw internal errors, and a
 * successful dispatch registers the job and lands the dispatch breadcrumb.
 * Final delivery is acknowledged only after its durable append receipt.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { deliverTeamReport, startTeamDiscussion, waitForSessionIdle } from "@oh-my-pi/pi-coding-agent/team";

afterEach(() => {
	vi.restoreAllMocks();
});

const MODEL: Model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const MODEL_PATTERN = `${MODEL.provider}/${MODEL.id}`;

interface JobManagerStub {
	registerCalls: number;
	acknowledged: string[];
	registerError?: Error;
}

function stubSession(jobManager: JobManagerStub, sentMessages: { customType: string; content: string }[]) {
	return {
		model: MODEL,
		modelRegistry: {
			getAvailable: () => [MODEL],
			authStorage: undefined,
		},
		get asyncJobManager() {
			return {
				register: (_type: string, _label: string, run: (ctx: unknown) => Promise<string>) => {
					jobManager.registerCalls++;
					if (jobManager.registerError) throw jobManager.registerError;
					// Never actually runs: register-throw and dispatch-shape are the
					// behaviors under test here; the orchestrator has its own tests.
					void run;
					return "bg_stub_1";
				},
				acknowledgeDeliveries: (ids: string[]) => {
					jobManager.acknowledged.push(...ids);
				},
			};
		},
		sendCustomMessage: async (payload: { customType: string; content: string }) => {
			sentMessages.push({ customType: payload.customType, content: payload.content });
			return false;
		},
		sessionManager: { getArtifactsDir: () => null },
		sessionFile: undefined,
		skills: [],
		promptTemplates: [],
		getAgentId: () => "Main",
	} as unknown as AgentSession;
}

function teamSettings(): Settings {
	return Settings.isolated({ "team.members": [MODEL_PATTERN] });
}

describe("team controller dispatch", () => {
	it("turns a job-manager registration failure into an actionable message", async () => {
		const jobManager: JobManagerStub = {
			registerCalls: 0,
			acknowledged: [],
			registerError: new Error("Background job limit reached (15). Wait for running jobs to finish or cancel one."),
		};
		const sent: { customType: string; content: string }[] = [];
		const output: string[] = [];
		const result = await startTeamDiscussion("分析 X", {
			session: stubSession(jobManager, sent),
			settings: teamSettings(),
			cwd: "/tmp/repo",
			hooks: {
				output: (text: string) => {
					output.push(text);
				},
			},
		});
		expect(result.started).toBe(false);
		expect(jobManager.registerCalls).toBe(1);
		expect(jobManager.acknowledged).toHaveLength(0);
		expect(sent).toHaveLength(0);
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("无法启动 /team");
		expect(output[0]).toContain("Background job limit reached");
		expect(output[0]).toContain("hub cancel");
	});

	it("registers without acknowledging the unfinished result, and lands the dispatch breadcrumb", async () => {
		const jobManager: JobManagerStub = { registerCalls: 0, acknowledged: [] };
		const sent: { customType: string; content: string }[] = [];
		const result = await startTeamDiscussion("分析 X", {
			session: stubSession(jobManager, sent),
			settings: teamSettings(),
			cwd: "/tmp/repo",
			hooks: {},
		});
		expect(result.started).toBe(true);
		expect(result.jobId).toBe("bg_stub_1");
		// The final report has not been persisted by the still-running job.
		expect(jobManager.acknowledged).toEqual([]);
		// The dispatch breadcrumb carries the ASCII job marker.
		expect(sent).toHaveLength(1);
		expect(sent[0]!.customType).toBe("team-dispatch");
		expect(sent[0]!.content).toContain("[team-dispatch bg_stub_1]");
	});
});

describe("waitForSessionIdle", () => {
	it("resolves immediately when the session is idle", async () => {
		expect(await waitForSessionIdle({ isStreaming: false }, new AbortController().signal)).toBe(true);
	});

	it("has no implicit deadline while the owning job remains live", async () => {
		let streaming = true;
		let clock = 0;
		const polls: { promise: Promise<void>; resolve: () => void }[] = [];
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		vi.spyOn(Bun, "sleep").mockImplementation(() => {
			const poll = Promise.withResolvers<void>();
			polls.push(poll);
			return poll.promise;
		});
		const session = {
			get isStreaming() {
				return streaming;
			},
		};
		const waiting = waitForSessionIdle(session, new AbortController().signal);
		expect(polls).toHaveLength(1);
		clock = 24 * 60 * 60_000;
		polls[0]!.resolve();
		await Promise.resolve();
		expect(polls).toHaveLength(2);
		streaming = false;
		polls[1]!.resolve();
		expect(await waiting).toBe(true);
	});

	it("reports a still-streaming session after an explicit deadline", async () => {
		let clock = 0;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		vi.spyOn(Bun, "sleep").mockImplementation(async () => {
			clock += 5;
		});
		expect(
			await waitForSessionIdle({ isStreaming: true }, new AbortController().signal, { timeoutMs: 30, pollMs: 5 }),
		).toBe(false);
	});

	it("stops immediately when the job signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const sleep = vi.spyOn(Bun, "sleep");
		expect(await waitForSessionIdle({ isStreaming: true }, controller.signal)).toBe(false);
		expect(sleep).not.toHaveBeenCalled();
	});
});

describe("team report delivery", () => {
	it("does not deliver a report after cancellation during the idle wait", async () => {
		const controller = new AbortController();
		const sent: unknown[] = [];
		const session = {
			isStreaming: true,
			appendCustomMessage: async (payload: Parameters<AgentSession["appendCustomMessage"]>[0]) => {
				sent.push(typeof payload === "string" ? payload : payload.content);
			},
		};
		const poll = Promise.withResolvers<void>();
		vi.spyOn(Bun, "sleep").mockReturnValue(poll.promise);
		const delivery = deliverTeamReport(session, controller.signal, "finished", {
			jobId: "job-1",
			question: "question",
		});
		controller.abort();
		poll.resolve();
		expect(await delivery).toBe(false);
		expect(sent).toEqual([]);
	});

	it("does not queue a volatile report or claim success when an explicit idle deadline expires", async () => {
		let clock = 0;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		vi.spyOn(Bun, "sleep").mockImplementation(async () => {
			clock += 5;
		});
		const sent: unknown[] = [];
		const session = {
			isStreaming: true,
			appendCustomMessage: async (payload: Parameters<AgentSession["appendCustomMessage"]>[0]) => {
				sent.push(typeof payload === "string" ? payload : payload.content);
			},
		};
		expect(
			await deliverTeamReport(
				session,
				new AbortController().signal,
				"finished",
				{ jobId: "job-1", question: "question" },
				undefined,
				{ timeoutMs: 20, pollMs: 5 },
			),
		).toBe(false);
		expect(sent).toEqual([]);
	});

	it("delivers exactly once after the live turn becomes idle without starting another agent turn", async () => {
		let streaming = true;
		const controller = new AbortController();
		const sent: unknown[] = [];
		const session = {
			get isStreaming() {
				return streaming;
			},
			appendCustomMessage: async (
				payload: Parameters<AgentSession["appendCustomMessage"]>[0],
				options?: { signal?: AbortSignal },
			) => {
				expect(streaming).toBe(false);
				expect(options?.signal).toBe(controller.signal);
				sent.push(typeof payload === "string" ? payload : payload.content);
			},
		};
		const poll = Promise.withResolvers<void>();
		vi.spyOn(Bun, "sleep").mockReturnValue(poll.promise);
		const rebuilt: boolean[] = [];
		const delivery = deliverTeamReport(
			session,
			controller.signal,
			"finished",
			{ jobId: "job-1", question: "question" },
			() => {
				rebuilt.push(true);
			},
		);
		streaming = false;
		poll.resolve();
		expect(await delivery).toBe(true);
		expect(sent).toEqual(["finished"]);
		expect(rebuilt).toEqual([true]);
	});

	it("acknowledges only after the durable append receipt resolves", async () => {
		const controller = new AbortController();
		const appending = Promise.withResolvers<void>();
		const committed = Promise.withResolvers<void>();
		const acknowledge = vi.fn();
		const session = {
			isStreaming: false,
			appendCustomMessage: async (
				_payload: Parameters<AgentSession["appendCustomMessage"]>[0],
				options?: { signal?: AbortSignal },
			) => {
				expect(options?.signal).toBe(controller.signal);
				appending.resolve();
				await committed.promise;
			},
		};
		const delivery = deliverTeamReport(
			session,
			controller.signal,
			"finished",
			{ jobId: "job-1", question: "question" },
			acknowledge,
		);
		await appending.promise;
		expect(acknowledge).not.toHaveBeenCalled();
		committed.resolve();
		expect(await delivery).toBe(true);
		expect(acknowledge).toHaveBeenCalledTimes(1);
	});

	it("does not acknowledge a cancelled durable append", async () => {
		const controller = new AbortController();
		const appending = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const acknowledge = vi.fn();
		const session = {
			isStreaming: false,
			appendCustomMessage: async (
				_payload: Parameters<AgentSession["appendCustomMessage"]>[0],
				options?: { signal?: AbortSignal },
			) => {
				appending.resolve();
				await release.promise;
				options?.signal?.throwIfAborted();
			},
		};
		const delivery = deliverTeamReport(
			session,
			controller.signal,
			"finished",
			{ jobId: "job-1", question: "question" },
			acknowledge,
		);
		await appending.promise;
		controller.abort();
		release.resolve();
		expect(await delivery).toBe(false);
		expect(acknowledge).not.toHaveBeenCalled();
	});

	it("propagates a persistence failure without acknowledging delivery", async () => {
		const error = new Error("persist receipt rejected");
		const acknowledge = vi.fn();
		const session = {
			isStreaming: false,
			appendCustomMessage: async () => {
				throw error;
			},
		};
		await expect(
			deliverTeamReport(
				session,
				new AbortController().signal,
				"finished",
				{ jobId: "job-1", question: "question" },
				acknowledge,
			),
		).rejects.toBe(error);
		expect(acknowledge).not.toHaveBeenCalled();
	});
});
