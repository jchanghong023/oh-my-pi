/**
 * `/team` controller dispatch-level tests: job-manager registration failures
 * surface as actionable /team messages instead of raw internal errors, and a
 * successful dispatch registers the job and sends the dispatch breadcrumb.
 * Final delivery is acknowledged only after its durable append receipt.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { JCHTOOLS_API } from "@oh-my-pi/pi-coding-agent/config/jchtools-provider";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	buildRunnerDeps,
	deliverTeamReport,
	resolveTeamParticipantsForSession,
	startTeamDiscussion,
	waitForSessionIdle,
} from "@oh-my-pi/pi-coding-agent/team/controller";
import * as orchestratorModule from "@oh-my-pi/pi-coding-agent/team/orchestrator";
import { type LogEvent, registerLogSink } from "@oh-my-pi/pi-utils/logger";

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

function expectDispatchFollowupFailure(
	events: LogEvent[],
	stage: "notice_dispatch" | "chat_rebuild" | "status_update",
	canaries: string[],
): void {
	const registered = events.filter(event => event.context?.event === "team_dispatch_completed");
	expect(registered).toHaveLength(1);
	expect(registered[0]?.context).toMatchObject({
		stage: "register",
		result: "completed",
		job_id: "bg_stub_1",
	});
	const operationId = registered[0]!.context?.operation_id;
	expect(operationId).toEqual(expect.any(String));
	expect(registered[0]!.context?.team_run_id).toEqual(expect.any(String));
	expect(new Set(events.map(event => event.context?.operation_id))).toEqual(new Set([operationId]));
	expect(new Set(events.map(event => event.context?.team_run_id)).size).toBe(1);

	const stages = ["notice_dispatch", "chat_rebuild", "status_update"];
	const failedIndex = stages.indexOf(stage);
	const expected = stages.slice(0, failedIndex + 1).flatMap((current, index) => [
		[current, "started"],
		[current, index === failedIndex ? "failed" : "completed"],
	]);
	const followups = events.filter(event => String(event.context?.event).startsWith("team_dispatch_followup_"));
	expect(followups.map(event => [event.context?.stage, event.context?.result])).toEqual(expected);
	for (const event of followups) {
		expect(event.level).toBe(event.context?.result === "failed" ? "warn" : "info");
		expect(event.context).toMatchObject({
			component: "team.controller",
			event: `team_dispatch_followup_${event.context?.result}`,
			job_id: "bg_stub_1",
			job_registered: true,
			notice_dispatch_completed: event.context?.stage !== "notice_dispatch" || event.context?.result === "completed",
		});
		if (event.context?.result !== "started") {
			expect(typeof event.context?.elapsed_ms).toBe("number");
			expect(Number.isFinite(event.context?.elapsed_ms)).toBe(true);
			expect(event.context?.elapsed_ms as number).toBeGreaterThanOrEqual(0);
		}
	}
	const failed = followups.at(-1)!;
	expect(failed.context).toMatchObject({ error_type: "Error" });
	expect(typeof failed.context?.followup_elapsed_ms).toBe("number");
	expect(Number.isFinite(failed.context?.followup_elapsed_ms)).toBe(true);
	expect(failed.context?.followup_elapsed_ms as number).toBeGreaterThanOrEqual(failed.context?.elapsed_ms as number);
	const serialized = JSON.stringify(events);
	for (const canary of canaries) expect(serialized).not.toContain(canary);
	for (const event of events) {
		for (const field of ["question", "content", "message", "error", "cwd", "path"]) {
			expect(event.context).not.toHaveProperty(field);
		}
	}
}

function companyModel(id: string): Model {
	return { ...MODEL, provider: "company", id, name: id };
}

describe("effective team rosters", () => {
	it.each([{ members: undefined }, { members: [] }])(
		"defaults unset or empty settings to three session-model slots: %j",
		({ members }) => {
			const session = {
				model: MODEL,
				modelRegistry: { getAvailable: () => [MODEL, companyModel("GLM-5.2-public")] },
			} as unknown as AgentSession;
			const result = resolveTeamParticipantsForSession(
				session,
				Settings.isolated(members ? { "team.members": members } : {}),
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.source).toBe("session-default");
				expect(result.participants.map(participant => participant.modelPattern)).toEqual([
					MODEL_PATTERN,
					MODEL_PATTERN,
					MODEL_PATTERN,
				]);
			}
		},
	);

	it("rejects a configured member filtered out by enabledModels instead of omitting it", () => {
		const allowed = companyModel("GLM-5.2-public");
		const outOfScope = companyModel("Qwen3.6-27B-public");
		const session = {
			model: MODEL,
			modelRegistry: { getAvailable: () => [MODEL, allowed, outOfScope] },
		} as unknown as AgentSession;
		const allowedPattern = `${allowed.provider}/${allowed.id}`;
		const outOfScopePattern = `${outOfScope.provider}/${outOfScope.id}`;
		const result = resolveTeamParticipantsForSession(
			session,
			Settings.isolated({
				"team.members": [allowedPattern, outOfScopePattern],
				enabledModels: [allowedPattern, MODEL_PATTERN],
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(outOfScopePattern);
	});

	it.each([{ members: [] }, { members: ["company/GLM-5.2-public"] }])(
		"rejects a filtered session anchor even when absent from the roster: %j",
		({ members }) => {
			const allowed = companyModel("GLM-5.2-public");
			const session = {
				model: MODEL,
				modelRegistry: { getAvailable: () => [MODEL, allowed] },
			} as unknown as AgentSession;
			const result = resolveTeamParticipantsForSession(
				session,
				Settings.isolated({ "team.members": members, enabledModels: ["company/GLM-5.2-public"] }),
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain(MODEL_PATTERN);
				expect(result.error).toContain("主代理");
			}
		},
	);

	it.each([{ remoteSession: true }, { remoteSession: false }])(
		"rejects remote Agent execution before dispatch whether the remote model is the anchor or a member: %j",
		async ({ remoteSession }) => {
			const remote: Model = { ...MODEL, provider: "jchtools", id: "remote-agent", api: JCHTOOLS_API };
			const remotePattern = `${remote.provider}/${remote.id}`;
			const jobManager: JobManagerStub = { registerCalls: 0, acknowledged: [] };
			const sent: { customType: string; content: string }[] = [];
			const session = {
				...stubSession(jobManager, sent),
				model: remoteSession ? remote : MODEL,
				modelRegistry: { getAvailable: () => [MODEL, remote] },
			} as unknown as AgentSession;
			const result = await startTeamDiscussion("分析 X", {
				session,
				settings: Settings.isolated({ "team.members": [remoteSession ? MODEL_PATTERN : remotePattern] }),
				cwd: "/tmp/repo",
				hooks: {},
			});
			expect(result.started).toBe(false);
			expect(result.message).toContain(remotePattern);
			expect(result.message).toContain("只读");
			expect(result.message).toContain("yield");
			expect(jobManager.registerCalls).toBe(0);
			expect(sent).toEqual([]);
		},
	);
});

describe("team controller dispatch", () => {
	it.each([
		{ persistFails: true, discussionFails: false },
		{ persistFails: false, discussionFails: false },
		{ persistFails: false, discussionFails: true },
	])("keeps team completion out of the model-facing job sink: %j", async ({ persistFails, discussionFails }) => {
		const manager = new AsyncJobManager({});
		const modelSink = vi.fn();
		manager.registerDeliverySink("Main", modelSink);
		const acknowledge = vi.spyOn(manager, "acknowledgeDeliveries");
		const aggregate = {
			status: discussionFails ? ("failed" as const) : ("completed" as const),
			reportMarkdown: discussionFails ? undefined : "durable team report",
			failureReason: discussionFails ? "discussion rejected" : undefined,
		};
		const discussion = vi.spyOn(orchestratorModule, "runTeamDiscussion").mockResolvedValue(aggregate);
		const base: Model = {
			...MODEL,
			provider: "openrouter",
			id: "example/model",
			baseUrl: "https://openrouter.ai/api/v1",
		};
		const pinned: Model = {
			...base,
			compat: { ...base.compat, openRouterRouting: { only: ["cerebras"] } } as Model["compat"],
		};
		const append = vi.fn(async () => {
			if (persistFails) throw new Error("persist receipt rejected");
		});
		const errors: string[] = [];
		const output: string[] = [];
		const session = {
			...stubSession({ registerCalls: 0, acknowledged: [] }, []),
			model: pinned,
			modelRegistry: { getAvailable: () => [base] },
			asyncJobManager: manager,
			isStreaming: false,
			appendCustomMessage: append,
			sessionManager: { getAdditionalDirectories: () => [], getArtifactsDir: () => null },
		} as unknown as AgentSession;
		try {
			const dispatched = await startTeamDiscussion("分析 X", {
				session,
				settings: Settings.isolated(),
				cwd: "/tmp/repo",
				hooks: {
					showError: text => {
						errors.push(text);
					},
					output: text => {
						output.push(text);
					},
				},
			});
			expect(dispatched.started).toBe(true);
			const job = manager.getJob(dispatched.jobId!)!;
			await job.promise;
			expect(discussion).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionModelPattern: "openrouter/example/model@cerebras",
					participants: expect.arrayContaining([
						expect.objectContaining({ modelPattern: "openrouter/example/model@cerebras" }),
					]),
				}),
			);
			expect(append).toHaveBeenCalledTimes(1);
			expect(modelSink).not.toHaveBeenCalled();
			expect(manager.hasPendingDeliveries()).toBe(false);
			expect(manager.getAllJobs()).toContain(job);
			expect(job.structured?.data).toEqual(aggregate);
			expect(manager.isJobResultConsumed(job.id)).toBe(false);
			expect(job.status).toBe(persistFails || discussionFails ? "failed" : "completed");
			if (persistFails) {
				expect(acknowledge).not.toHaveBeenCalled();
				expect(job.errorText).toContain("persist receipt rejected");
				expect(job.errorText).toContain("durable team report");
				expect(errors).toHaveLength(1);
				expect(errors[0]).toContain(`proc://${job.id}`);
				expect(output).toEqual(errors);
			} else {
				expect(acknowledge).toHaveBeenCalledWith([job.id]);
				expect(errors).toEqual([]);
			}
		} finally {
			discussion.mockRestore();
			await manager.dispose();
		}
	});

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

	it("registers without acknowledging the unfinished result, and sends the dispatch breadcrumb", async () => {
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

	it.each([
		{ members: [], agents: 3, distinctModels: 1 },
		{ members: [0], agents: 3, distinctModels: 1 },
		{ members: [0, 1], agents: 3, distinctModels: 2 },
		{ members: [0, 1, 2], agents: 3, distinctModels: 3 },
		{ members: [0, 1, 2, 3], agents: 4, distinctModels: 4 },
		{ members: [1, 1, 0, 1], agents: 4, distinctModels: 2 },
	])(
		"reports independent agent and distinct-model counts in the dispatch notice: %j",
		async ({ members, agents, distinctModels }) => {
			const models = [
				MODEL,
				companyModel("GLM-5.2-public"),
				companyModel("Qwen3.6-27B-public"),
				companyModel("other"),
			];
			const jobManager: JobManagerStub = { registerCalls: 0, acknowledged: [] };
			const sent: { customType: string; content: string }[] = [];
			const session = stubSession(jobManager, sent);
			vi.spyOn(session.modelRegistry, "getAvailable").mockReturnValue(models);
			const result = await startTeamDiscussion("分析 X", {
				session,
				settings: Settings.isolated({
					"team.members": members.map(index => `${models[index]!.provider}/${models[index]!.id}`),
				}),
				cwd: "/tmp/repo",
				hooks: {},
			});
			expect(result.started).toBe(true);
			expect(sent).toHaveLength(1);
			expect(sent[0]!.content).toContain(`${agents} 个独立代理`);
			expect(sent[0]!.content).toContain(`${distinctModels} 个不同模型`);
		},
	);

	it("keeps a rejecting output hook from turning into an unhandled rejection", async () => {
		const jobManager: JobManagerStub = {
			registerCalls: 0,
			acknowledged: [],
			registerError: new Error("Background job limit reached (15)."),
		};
		// Without the catch in the controller this rejection is unhandled and
		// fails the test run between tests.
		const result = await startTeamDiscussion("分析 X", {
			session: stubSession(jobManager, []),
			settings: teamSettings(),
			cwd: "/tmp/repo",
			hooks: {
				output: () => Promise.reject(new Error("transcript output failed")),
			},
		});
		expect(result.started).toBe(false);
		expect(result.message).toContain("无法启动 /team");
	});

	it("still reports a started job when sending the dispatch breadcrumb rejects", async () => {
		const jobManager: JobManagerStub = { registerCalls: 0, acknowledged: [] };
		const errors: string[] = [];
		const output: string[] = [];
		const calls: string[] = [];
		const events: LogEvent[] = [];
		const session = stubSession(jobManager, []);
		const question = "NOTICE_QUESTION_CANARY";
		const reason = "session disposed NOTICE_ERROR_CANARY";
		const cwd = "/private/NOTICE_PATH_CANARY";
		// Registration succeeds, but the notice call itself does not resolve.
		const send = vi.spyOn(session, "sendCustomMessage").mockImplementation(async () => {
			expect(jobManager.registerCalls).toBe(1);
			calls.push("notice_dispatch");
			throw new Error(reason);
		});
		const dispose = registerLogSink(event => {
			if (event.context?.component === "team.controller") events.push(event);
		});
		try {
			const result = await startTeamDiscussion(question, {
				session,
				settings: teamSettings(),
				cwd,
				hooks: {
					rebuildChat: () => {
						calls.push("chat_rebuild");
					},
					showStatus: () => {
						calls.push("status_update");
					},
					showError: text => {
						calls.push("showError");
						errors.push(text);
					},
					output: text => {
						calls.push("output");
						output.push(text);
					},
				},
			});
			expect(result.started).toBe(true);
			expect(result.jobId).toBe("bg_stub_1");
			expect(result.message).toContain(`[team-dispatch ${result.jobId}]`);
			expect(result.message).toContain(question);
			expect(jobManager.registerCalls).toBe(1);
			expect(jobManager.acknowledged).toEqual([]);
			expect(calls).toEqual(["notice_dispatch", "showError", "output"]);
			expect(errors).toEqual([`/team 已启动（任务 ${result.jobId}），但写入派发通知失败：${reason}`]);
			expect(output).toEqual(errors);
			expectDispatchFollowupFailure(events, "notice_dispatch", [
				question,
				"NOTICE_ERROR_CANARY",
				cwd,
				result.message!,
			]);
		} finally {
			dispose();
			send.mockRestore();
		}
	});

	it.each(["chat_rebuild", "status_update"] as const)(
		"keeps the registered job when %s throws after the notice call resolves false",
		async failedStage => {
			const jobManager: JobManagerStub = { registerCalls: 0, acknowledged: [] };
			const sent: { customType: string; content: string }[] = [];
			const session = stubSession(jobManager, sent);
			const calls: string[] = [];
			const errors: string[] = [];
			const output: string[] = [];
			const events: LogEvent[] = [];
			const question = "UI_QUESTION_CANARY";
			const reason = `${failedStage} UI_ERROR_CANARY`;
			const cwd = "/private/UI_PATH_CANARY";
			const originalSend = session.sendCustomMessage.bind(session);
			const send = vi.spyOn(session, "sendCustomMessage").mockImplementation(async (...args) => {
				expect(jobManager.registerCalls).toBe(1);
				calls.push("notice_dispatch");
				const startedTurn = await originalSend(...args);
				// This boolean describes turn startup, not durable persistence.
				expect(startedTurn).toBe(false);
				return startedTurn;
			});
			const dispose = registerLogSink(event => {
				if (event.context?.component === "team.controller") events.push(event);
			});
			try {
				const result = await startTeamDiscussion(question, {
					session,
					settings: teamSettings(),
					cwd,
					hooks: {
						rebuildChat: () => {
							calls.push("chat_rebuild");
							if (failedStage === "chat_rebuild") throw new Error(reason);
						},
						showStatus: text => {
							calls.push("status_update");
							expect(text).toBe("Dispatched /team discussion bg_stub_1");
							throw new Error(reason);
						},
						showError: text => {
							calls.push("showError");
							errors.push(text);
						},
						output: text => {
							calls.push("output");
							output.push(text);
						},
					},
				});
				expect(result.started).toBe(true);
				expect(result.jobId).toBe("bg_stub_1");
				expect(jobManager.registerCalls).toBe(1);
				expect(jobManager.acknowledged).toEqual([]);
				expect(sent).toEqual([{ customType: "team-dispatch", content: result.message! }]);
				expect(sent[0]!.content).toContain(`[team-dispatch ${result.jobId}]`);
				expect(sent[0]!.content).toContain(question);
				expect(send).toHaveBeenCalledWith(
					expect.objectContaining({
						customType: "team-dispatch",
						display: true,
						details: { jobId: result.jobId, question, dispatch: true },
					}),
					{ triggerTurn: false, deliverAs: "nextTurn" },
				);
				expect(calls).toEqual([
					"notice_dispatch",
					"chat_rebuild",
					...(failedStage === "status_update" ? ["status_update"] : []),
					"showError",
					"output",
				]);
				expect(errors).toEqual([`/team 已启动（任务 ${result.jobId}），但写入派发通知失败：${reason}`]);
				expect(output).toEqual(errors);
				expectDispatchFollowupFailure(events, failedStage, [question, "UI_ERROR_CANARY", cwd, sent[0]!.content]);
			} finally {
				dispose();
				send.mockRestore();
			}
		},
	);

	it("forwards session-granted workspace directories to the subagent runner deps", () => {
		const jobManager: JobManagerStub = { registerCalls: 0, acknowledged: [] };
		const session = stubSession(jobManager, []);
		(session as unknown as { sessionManager: unknown }).sessionManager = {
			getArtifactsDir: () => null,
			getAdditionalDirectories: () => ["/granted/root"],
		};
		const deps = buildRunnerDeps(session, teamSettings(), "/tmp/repo");
		// Subagents must keep read access parity with the main agent (CLI --dir,
		// ACP/add-dir granted roots); a dropped forwarding silently denies files.
		expect(deps.additionalDirectories).toEqual(["/granted/root"]);
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

	it("still reports delivery as complete when the post-persist chat rebuild fails", async () => {
		const controller = new AbortController();
		const session = {
			isStreaming: false,
			appendCustomMessage: async () => {},
		};
		// The report is persisted and acknowledged before the rebuild; a UI
		// rebuild error must not turn the delivered discussion into a failure.
		expect(
			await deliverTeamReport(
				session,
				controller.signal,
				"finished",
				{ jobId: "job-1", question: "question" },
				() => {
					throw new Error("rebuild exploded");
				},
			),
		).toBe(true);
	});

	it("does not acknowledge cancellation while a durable append resolves", async () => {
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
				expect(options?.signal?.aborted).toBe(true);
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
