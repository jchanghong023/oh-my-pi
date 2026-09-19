/**
 * `/team` controller dispatch-level tests: job-manager registration failures
 * surface as actionable /team messages instead of raw internal errors, and a
 * successful dispatch registers the job, suppresses model-facing delivery,
 * and lands the dispatch breadcrumb in the transcript.
 */
import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { startTeamDiscussion, waitForSessionIdle } from "@oh-my-pi/pi-coding-agent/team";

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

	it("registers the job, suppresses delivery, and lands the dispatch breadcrumb", async () => {
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
		// Model-facing delivery suppressed for this job id.
		expect(jobManager.acknowledged).toEqual(["bg_stub_1"]);
		// The dispatch breadcrumb carries the ASCII job marker.
		expect(sent).toHaveLength(1);
		expect(sent[0]!.customType).toBe("team-dispatch");
		expect(sent[0]!.content).toContain("[team-dispatch bg_stub_1]");
	});
});

describe("waitForSessionIdle", () => {
	const neverAborted = () => new AbortController().signal;

	it("resolves immediately when the session is idle", async () => {
		const started = Date.now();
		const idle = await waitForSessionIdle({ isStreaming: false }, neverAborted(), {
			timeoutMs: 1_000,
			pollMs: 5,
		});
		expect(idle).toBe(true);
		expect(Date.now() - started).toBeLessThan(100);
	});

	it("waits until a streaming turn ends instead of queueing into the volatile next-turn buffer", async () => {
		let streaming = true;
		const session = {
			get isStreaming() {
				return streaming;
			},
		};
		setTimeout(() => {
			streaming = false;
		}, 25);
		const started = Date.now();
		const idle = await waitForSessionIdle(session, neverAborted(), { timeoutMs: 5_000, pollMs: 5 });
		expect(idle).toBe(true);
		expect(streaming).toBe(false);
		expect(Date.now() - started).toBeGreaterThanOrEqual(20);
	});

	it("gives up after the bound and reports the session as still streaming", async () => {
		const session = { isStreaming: true };
		const started = Date.now();
		const idle = await waitForSessionIdle(session, neverAborted(), { timeoutMs: 30, pollMs: 5 });
		expect(idle).toBe(false);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(25);
		expect(elapsed).toBeLessThan(2_000);
	});

	it("stops waiting when the job signal aborts", async () => {
		const controller = new AbortController();
		controller.abort();
		const session = { isStreaming: true };
		const started = Date.now();
		const idle = await waitForSessionIdle(session, controller.signal, { timeoutMs: 5_000, pollMs: 5 });
		expect(idle).toBe(false);
		expect(Date.now() - started).toBeLessThan(100);
	});
});
