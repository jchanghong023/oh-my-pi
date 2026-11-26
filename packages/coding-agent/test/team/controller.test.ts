/**
 * `/team` controller dispatch-level tests: job-manager registration failures
 * surface as actionable /team messages instead of raw internal errors, and a
 * successful dispatch registers the job and sends the dispatch breadcrumb.
 * Final delivery is acknowledged only after its durable append receipt.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	buildRunnerDeps,
	deliverTeamReport,
	resolveTeamParticipantsForSession,
	startTeamDiscussion,
	waitForSessionIdle,
} from "@oh-my-pi/pi-coding-agent/team/controller";
import * as orchestratorModule from "@oh-my-pi/pi-coding-agent/team/orchestrator";
import type { TeamRunResult } from "@oh-my-pi/pi-coding-agent/team/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type LogEvent, registerLogSink } from "@oh-my-pi/pi-utils/logger";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus, emitSubagentFrame } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { ProcProtocolHandler } from "../../src/internal-urls/proc-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";

afterEach(() => {
	vi.restoreAllMocks();
});

const MODEL: Model = getBundledModel("ascend", "minimax2.7")!;
const MODEL_PATTERN = `${MODEL.provider}/${MODEL.id}`;

interface JobManagerStub {
	registerCalls: number;
	acknowledged: string[];
	registerError?: Error;
}

function stubSession(
	jobManager: JobManagerStub,
	sentMessages: { customType: string; content: string }[],
	getSessionId = () => "session-A",
) {
	const sessionChangeCallbacks = new Set<() => void>();
	return {
		model: MODEL,
		sessionId: "session-A",
		registerSessionChangeCallback: (callback: () => void) => {
			sessionChangeCallbacks.add(callback);
			return () => sessionChangeCallbacks.delete(callback);
		},
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
		appendCustomMessage: async (payload: { customType: string; content: string }) => {
			sentMessages.push({ customType: payload.customType, content: payload.content });
		},
		sessionManager: { getSessionId, getAdditionalDirectories: () => [], getArtifactsDir: () => null },
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
	it("defaults unset settings to three session-model slots", () => {
		const session = {
			model: MODEL,
			modelRegistry: { getAvailable: () => [MODEL, companyModel("GLM-5.2-public")] },
		} as unknown as AgentSession;
		const result = resolveTeamParticipantsForSession(session, Settings.isolated({}));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toBe("session-default");
			expect(result.participants.map(participant => participant.modelPattern)).toEqual([
				MODEL_PATTERN,
				MODEL_PATTERN,
				MODEL_PATTERN,
			]);
		}
	});

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
				expect(result.error).toContain("cannot act as the main agent");
			}
		},
	);
});

describe("team controller dispatch", () => {
	it("rejects a session without background capability before starting any stage", async () => {
		const discussion = vi.spyOn(orchestratorModule, "runTeamDiscussion");
		const output: string[] = [];
		const session = {
			...stubSession({ registerCalls: 0, acknowledged: [] }, []),
			asyncJobManager: undefined,
		} as unknown as AgentSession;
		const result = await startTeamDiscussion("分析缺失后台能力", {
			session,
			settings: teamSettings(),
			cwd: "/tmp/repo",
			hooks: {
				output: text => {
					output.push(text);
				},
			},
		});
		expect(result.started).toBe(false);
		expect(result.jobId).toBeUndefined();
		expect(result.message).toContain("/team requires an async job manager");
		expect(output).toEqual([result.message]);
		expect(discussion).not.toHaveBeenCalled();
	});

	it.each([
		{ persistFails: true, discussionFails: false },
		{ persistFails: false, discussionFails: false },
		{ persistFails: false, discussionFails: true },
	])("keeps team completion out of the model-facing job sink: %j", async ({ persistFails, discussionFails }) => {
		const manager = new AsyncJobManager({});
		const modelSink = vi.fn();
		manager.registerDeliverySink("Main", modelSink);
		const acknowledge = vi.spyOn(manager, "acknowledgeDeliveries");
		const aggregate: TeamRunResult = {
			runId: "team-controller-completion",
			inputVersion: "controller-input-v1",
			candidates: [],
			interpretationDifferences: [],
			status: discussionFails ? ("failed" as const) : ("completed" as const),
			reportMarkdown: discussionFails ? undefined : "durable team report",
			failureReason: discussionFails ? "discussion rejected" : undefined,
			subagentResults: [
				{
					role: "proposer",
					modelPattern: MODEL_PATTERN,
					label: "team-proposal-A",
					outcome: { ok: true, data: { proposal: "Complete raw original with tail evidence" } },
				},
			],
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
		const registerSessionChange = vi.fn(() => vi.fn());
		const session = {
			...stubSession({ registerCalls: 0, acknowledged: [] }, []),
			registerSessionChangeCallback: registerSessionChange,
			model: pinned,
			modelRegistry: { getAvailable: () => [base] },
			asyncJobManager: manager,
			isStreaming: false,
			appendCustomMessage: async (payload: { customType: string }) => {
				if (payload.customType === "team-result") await append();
			},
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
			const recovered = await new ProcProtocolHandler().resolve(parseInternalUrl(`proc://${job.id}`), {
				session: {
					cwd: "/tmp/repo",
					hasUI: false,
					settings: Settings.isolated({ "launch.enabled": false }),
					asyncJobManager: manager,
					getAgentId: () => "Main",
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
				},
			});
			expect(recovered.content).toContain(JSON.stringify(aggregate, null, 2));
			expect(recovered.content).toContain("Complete raw original with tail evidence");
			expect(manager.isJobResultConsumed(job.id)).toBe(false);
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
			expect(registerSessionChange).toHaveBeenCalledTimes(1);
			expect(registerSessionChange.mock.results[0]!.value).toHaveBeenCalledTimes(1);
		} finally {
			discussion.mockRestore();
			await manager.dispose();
		}
	});

	it.each(["session", "job", "reload"] as const)(
		"cancels an A-session discussion through %s without leaking callbacks or delivery",
		async cancelThrough => {
			const manager = new AsyncJobManager({});
			const acknowledge = vi.spyOn(manager, "acknowledgeDeliveries");
			const callbacks = new Set<() => void>();
			let sessionId = "A";
			const eventBus = new EventBus();
			const subagentEventBus = new EventBus();
			const localFrames: unknown[] = [];
			const rootFrames: unknown[] = [];
			const channels = [
				TASK_SUBAGENT_LIFECYCLE_CHANNEL,
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				TASK_SUBAGENT_EVENT_CHANNEL,
			];
			const unsubscribers = channels.flatMap(channel => [
				eventBus.on(channel, frame => {
					localFrames.push(frame);
				}),
				subagentEventBus.on(channel, frame => {
					rootFrames.push(frame);
				}),
			]);
			const childStarted = Promise.withResolvers<AbortSignal>();
			const releaseChild = Promise.withResolvers<void>();
			const child = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				for (const channel of channels) {
					emitSubagentFrame(options.eventBus, options.subagentEventBus, channel, { id: options.id, late: false });
				}
				childStarted.resolve(options.signal!);
				await releaseChild.promise;
				for (const channel of channels) {
					emitSubagentFrame(options.eventBus, options.subagentEventBus, channel, { id: options.id, late: true });
				}
				return {
					index: options.index,
					id: options.id,
					agent: options.agent.name,
					agentSource: options.agent.source,
					task: options.task,
					exitCode: 0,
					output: "late A result",
					stderr: "",
					truncated: false,
					durationMs: 0,
					tokens: 0,
					requests: 1,
					resolvedModel: MODEL_PATTERN,
				};
			});
			const writes: string[] = [];
			const session = {
				...stubSession({ registerCalls: 0, acknowledged: [] }, [], () => sessionId),
				eventBus,
				subagentEventBus,
				get sessionId() {
					return sessionId;
				},
				registerSessionChangeCallback: (callback: () => void) => {
					callbacks.add(callback);
					return () => callbacks.delete(callback);
				},
				asyncJobManager: manager,
				isStreaming: false,
				appendCustomMessage: async () => {
					writes.push(`${sessionId}:report`);
				},
			} as unknown as AgentSession;
			try {
				const dispatched = await startTeamDiscussion("分析 X", {
					session,
					settings: Settings.isolated({ "task.maxConcurrency": 1 }),
					cwd: "/tmp/repo",
					hooks: {
						output: text => {
							writes.push(`${sessionId}:output:${text}`);
						},
						showStatus: text => {
							writes.push(`${sessionId}:status:${text}`);
						},
						showError: text => {
							writes.push(`${sessionId}:error:${text}`);
						},
						rebuildChat: () => {
							writes.push(`${sessionId}:rebuild`);
						},
					},
				});
				const signal = await childStarted.promise;
				expect(callbacks.size).toBe(1);
				expect(rootFrames).toHaveLength(channels.length);
				expect(localFrames).toEqual(rootFrames);
				if (cancelThrough === "job") manager.cancel(dispatched.jobId!);
				// 同一身份的会话重新加载也使旧代际失效，不能只依赖 sessionId 的变化。
				if (cancelThrough !== "reload") sessionId = "B";
				for (const callback of Array.from(callbacks)) callback();
				expect(signal.aborted).toBe(true);
				expect(callbacks.size).toBe(0);
				expect(manager.getJob(dispatched.jobId!)!.status).toBe("cancelled");
				releaseChild.resolve();
				await manager.getJob(dispatched.jobId!)!.promise;
				expect(child).toHaveBeenCalledTimes(1);
				expect(rootFrames).toHaveLength(channels.length);
				expect(localFrames).toEqual(rootFrames);
				expect(writes.filter(write => write.startsWith("B:"))).toEqual([]);
				expect(acknowledge).not.toHaveBeenCalled();
				expect(callbacks.size).toBe(0);
			} finally {
				releaseChild.resolve();
				for (const unsubscribe of unsubscribers) unsubscribe();
				await manager.dispose();
				child.mockRestore();
			}
		},
	);

	it.each(["completed", "failed"] as const)(
		"does not deliver a late %s result or progress into a switched session",
		async status => {
			const manager = new AsyncJobManager({});
			const callbacks = new Set<() => void>();
			let sessionId = "A";
			const discussionStarted = Promise.withResolvers<AbortSignal>();
			const releaseDiscussion = Promise.withResolvers<void>();
			const discussion = vi.spyOn(orchestratorModule, "runTeamDiscussion").mockImplementation(async options => {
				discussionStarted.resolve(options.signal!);
				await releaseDiscussion.promise;
				options.onProgress?.({ stage: "synthesis", text: "late A progress", participants: [] });
				return {
					runId: "team-controller-late-result",
					inputVersion: "controller-input-v1",
					candidates: [],
					interpretationDifferences: [],
					status,
					reportMarkdown: "late report",
					failureReason: status === "failed" ? "late failure" : undefined,
				};
			});
			const append = vi.fn(async () => {});
			const acknowledge = vi.spyOn(manager, "acknowledgeDeliveries");
			const writes: string[] = [];
			const session = {
				...stubSession({ registerCalls: 0, acknowledged: [] }, [], () => sessionId),
				get sessionId() {
					return sessionId;
				},
				asyncJobManager: manager,
				isStreaming: false,
				appendCustomMessage: async (payload: { customType: string }) => {
					if (payload.customType === "team-result") await append();
				},
				registerSessionChangeCallback: (callback: () => void) => {
					callbacks.add(callback);
					return () => callbacks.delete(callback);
				},
			} as unknown as AgentSession;
			try {
				const dispatched = await startTeamDiscussion("分析 X", {
					session,
					settings: teamSettings(),
					cwd: "/tmp/repo",
					hooks: {
						output: text => {
							writes.push(`${sessionId}:${text}`);
						},
						showStatus: text => {
							writes.push(`${sessionId}:${text}`);
						},
						showError: text => {
							writes.push(`${sessionId}:${text}`);
						},
						rebuildChat: () => {
							writes.push(`${sessionId}:rebuild`);
						},
					},
				});
				const signal = await discussionStarted.promise;
				sessionId = "B";
				for (const callback of Array.from(callbacks)) callback();
				expect(signal.aborted).toBe(true);
				releaseDiscussion.resolve();
				await manager.getJob(dispatched.jobId!)!.promise;
				expect(append).not.toHaveBeenCalled();
				expect(acknowledge).not.toHaveBeenCalled();
				expect(writes.filter(write => write.startsWith("B:"))).toEqual([]);
				expect(callbacks.size).toBe(0);
			} finally {
				releaseDiscussion.resolve();
				await manager.dispose();
				discussion.mockRestore();
			}
		},
	);

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
		expect(output[0]).toContain("background job registration failed");
		expect(output[0]).toContain("Background job limit reached");
		expect(output[0]).toContain("hub cancel");
	});

	it("persists the dispatch in the original journal before an active model turn ends", async () => {
		const temp = TempDir.createSync("@pi-team-dispatch-");
		const cwd = temp.path();
		const auth = await AuthStorage.create(":memory:");
		const streamStarted = Promise.withResolvers<void>();
		const releaseStream = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: async () => {
				streamStarted.resolve();
				await releaseStream.promise;
				return { content: ["original turn completed"] };
			},
		});
		const manager = new AsyncJobManager({});
		const journal = SessionManager.create(cwd, cwd);
		const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"));
		vi.spyOn(registry, "getAvailable").mockReturnValue([MODEL]);
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(orchestratorModule, "runTeamDiscussion").mockResolvedValue({
			runId: "dispatch-journal",
			inputVersion: "controller-input-v1",
			candidates: [],
			interpretationDifferences: [],
			status: "cancelled",
		});
		const settings = Settings.isolated({
			"team.members": [MODEL_PATTERN],
			"compaction.enabled": false,
			"prewalk.enabled": false,
			"todo.enabled": false,
		});
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: MODEL, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: journal,
			settings,
			modelRegistry: registry,
			toolRegistry: new Map(),
			ownedAsyncJobManager: manager,
		});
		const prompt = session.prompt("original turn");
		try {
			await Promise.race([streamStarted.promise, prompt]);
			expect(session.isStreaming).toBe(true);
			const idleWait = Promise.withResolvers<"waiting">();
			const waitForIdle = session.waitForIdle.bind(session);
			vi.spyOn(session, "waitForIdle").mockImplementation(() => {
				idleWait.resolve("waiting");
				return waitForIdle();
			});
			const dispatch = startTeamDiscussion("inspect the module", { session, settings, cwd, hooks: {} });
			const result = await Promise.race([dispatch, idleWait.promise]);
			if (result === "waiting") {
				releaseStream.resolve();
				await dispatch;
				throw new Error("Team dispatch waited for the active turn to end");
			}
			expect(result.started).toBe(true);
			expect(session.isStreaming).toBe(true);
			expect(Bun.JSONL.parse(await Bun.file(journal.getSessionFile()!).text())).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "custom_message",
						customType: "team-dispatch",
						content: expect.stringContaining(`[team-dispatch ${result.jobId}]`),
						details: expect.objectContaining({ jobId: result.jobId }),
					}),
				]),
			);
			releaseStream.resolve();
			await prompt;
			expect(mock.calls).toHaveLength(1);
		} finally {
			releaseStream.resolve();
			await prompt.catch(() => {});
			await session.dispose();
			auth.close();
			temp.removeSync();
		}
	});

	it("includes all first 80 question characters in the durable dispatch preview before any truncation marker", async () => {
		const jobManager: JobManagerStub = { registerCalls: 0, acknowledged: [] };
		const sent: { customType: string; content: string }[] = [];
		const prefix = "0123456789".repeat(8);
		const result = await startTeamDiscussion(`${prefix}PRIVATE_TAIL`, {
			session: stubSession(jobManager, sent),
			settings: teamSettings(),
			cwd: "/tmp/repo",
			hooks: {},
		});
		expect(result.started).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.content).toContain(`Original question: ${prefix}…`);
		expect(sent[0]!.content).not.toContain("PRIVATE_TAIL");
	});

	it("reports four independent agents and two distinct models in the dispatch notice", async () => {
		const otherModel = companyModel("GLM-5.2-public");
		const otherPattern = `${otherModel.provider}/${otherModel.id}`;
		const jobManager: JobManagerStub = { registerCalls: 0, acknowledged: [] };
		const sent: { customType: string; content: string }[] = [];
		const session = stubSession(jobManager, sent);
		vi.spyOn(session.modelRegistry, "getAvailable").mockReturnValue([MODEL, otherModel]);
		const result = await startTeamDiscussion("分析 X", {
			session,
			settings: Settings.isolated({
				"team.members": [otherPattern, otherPattern, MODEL_PATTERN, otherPattern],
			}),
			cwd: "/tmp/repo",
			hooks: {},
		});
		expect(result.started).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.content).toContain("4 independent agents");
		expect(sent[0]!.content).toContain("2 distinct models");
	});

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
		expect(result.message).toContain("Background job limit reached (15).");
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
		// Registration succeeds, but the notice cannot be saved.
		vi.spyOn(session, "appendCustomMessage").mockImplementation(async () => {
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
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain(result.jobId!);
			expect(errors[0]).toContain("dispatch notice could not be saved");
			expect(errors[0]).toContain(reason);
			expect(output).toEqual(errors);
			expectDispatchFollowupFailure(events, "notice_dispatch", [
				question,
				"NOTICE_ERROR_CANARY",
				cwd,
				result.message!,
			]);
		} finally {
			dispose();
		}
	});

	it.each(["chat_rebuild", "status_update"] as const)(
		"reports a UI failure without claiming the saved notice was lost when %s throws",
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
			const originalAppend = session.appendCustomMessage.bind(session);
			vi.spyOn(session, "appendCustomMessage").mockImplementation(async (...args) => {
				expect(jobManager.registerCalls).toBe(1);
				calls.push("notice_dispatch");
				await originalAppend(...args);
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
				expect(calls).toEqual([
					"notice_dispatch",
					"chat_rebuild",
					...(failedStage === "status_update" ? ["status_update"] : []),
					"showError",
					"output",
				]);
				expect(errors).toHaveLength(1);
				expect(errors[0]).toContain(result.jobId!);
				expect(errors[0]).toContain("dispatch notice was saved, but the UI update failed");
				expect(errors[0]).toContain(reason);
				expect(output).toEqual(errors);
				expectDispatchFollowupFailure(events, failedStage, [question, "UI_ERROR_CANARY", cwd, sent[0]!.content]);
			} finally {
				dispose();
			}
		},
	);

	it("forwards session-granted workspace directories to the subagent runner deps", () => {
		const jobManager: JobManagerStub = { registerCalls: 0, acknowledged: [] };
		const session = stubSession(jobManager, []);
		(session as unknown as { sessionManager: unknown }).sessionManager = {
			getSessionId: () => "session-A",
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
		expect(await delivery).toBe("cancelled");
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
		).toBe("failed");
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
		expect(await delivery).toBe("completed");
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
		expect(await delivery).toBe("completed");
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
		).toBe("completed");
	});

	it("does not acknowledge cancellation while a durable append resolves", async () => {
		const controller = new AbortController();
		const appending = Promise.withResolvers<AbortSignal | undefined>();
		const release = Promise.withResolvers<void>();
		const acknowledge = vi.fn();
		const persisted: Parameters<AgentSession["appendCustomMessage"]>[0][] = [];
		const session = {
			isStreaming: false,
			appendCustomMessage: async (
				payload: Parameters<AgentSession["appendCustomMessage"]>[0],
				options?: { signal?: AbortSignal },
			) => {
				persisted.push(payload);
				appending.resolve(options?.signal);
				await release.promise;
			},
		};
		const delivery = deliverTeamReport(
			session,
			controller.signal,
			"finished",
			{ jobId: "job-1", question: "question" },
			acknowledge,
		);
		expect(await appending.promise).toBe(controller.signal);
		controller.abort();
		release.resolve();
		expect(await delivery).toBe("cancelled");
		expect(persisted).toEqual([expect.objectContaining({ customType: "team-result", content: "finished" })]);
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
