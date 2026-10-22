import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import type { ToolSession } from "../../src/tools";
import { AskTool } from "../../src/tools/ask";
import { ZCodeInteractions } from "../../src/modes/zcode/interactions";
import { ZCodeCommandHost } from "../../src/modes/zcode/commands";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { EventBus } from "../../src/utils/event-bus";

describe("ZCode session interactions", () => {
	it("publishes a selection and resolves only its owning pending request", async () => {
		const a = new ZCodeInteractions(() => {});
		const b = new ZCodeInteractions(() => {});
		const answer = a.ui.select("Choose", ["A", "B"]);
		const id = a.pending[0]!.interactionId;
		expect(b.resolve(id, { optionId: "A" })).toBe(false);
		expect(a.resolve(id, { optionId: "B" })).toBe(true);
		expect(await answer).toBe("B");
		expect(a.pending).toEqual([]);
		expect(a.resolve(id, { optionId: "A" })).toBe(false);
	});
	it("cancels a blocked confirmation without accepting late approval", async () => {
		const interactions = new ZCodeInteractions(() => {});
		const answer = interactions.ui.confirm("Plan", "Execute?");
		const id = interactions.pending[0]!.interactionId;
		interactions.cancel();
		expect(await answer).toBe(false);
		expect(interactions.resolve(id, { optionId: "yes" })).toBe(false);
	});
	it("aborts only the requested dialog and preserves another session", async () => {
		const a = new ZCodeInteractions(() => {});
		const b = new ZCodeInteractions(() => {});
		const controller = new AbortController();
		const cancelled = a.ui.input("Question", undefined, { signal: controller.signal });
		const other = b.ui.input("Other");
		controller.abort();
		expect(await cancelled).toBeUndefined();
		expect(b.pending).toHaveLength(1);
		b.resolve(b.pending[0]!.interactionId, { text: "Answer" });
		expect(await other).toBe("Answer");
	});
	it("maps public free-text answers without trimming operator content", async () => {
		const interactions = new ZCodeInteractions(() => {});
		const answer = interactions.ui.input("Question");
		interactions.resolve(interactions.pending[0]!.interactionId, { freeText: "  answer\n" });
		expect(await answer).toBe("  answer\n");
	});
	it("maps rich public question answers to the shared ask result", async () => {
		const interactions = new ZCodeInteractions(() => {});
		const answer = interactions.ui.askDialog!([
			{ id: "q1", question: "Choose?", options: [{ label: "A" }, { label: "B" }] },
		]);
		interactions.resolve(interactions.pending[0]!.interactionId, {
			action: "accept",
			content: { answers: { "Choose?": "B" } },
		});
		expect(await answer).toMatchObject({ kind: "submit", results: [{ id: "q1", selectedOptions: ["B"] }] });
	});
	it("submits all native questions together and preserves multi-select and custom answers", async () => {
		const interactions = new ZCodeInteractions(() => {});
		const answer = interactions.ui.askDialog!([
			{ id: "first", question: "Pick several", multi: true, options: [{ label: "A" }, { label: "B" }] },
			{ id: "second", question: "Describe", options: [{ label: "Default" }] },
		]);
		expect(interactions.pending).toHaveLength(1);
		expect(interactions.pending[0]!.payload).toMatchObject({
			questions: [{ header: "first", multiSelect: true }, { header: "second" }],
		});
		interactions.resolve(interactions.pending[0]!.interactionId, {
			action: "accept",
			content: { answers: { first: ["A", "B"], second: ["  custom\n"] } },
		});
		expect(await answer).toMatchObject({
			kind: "submit",
			results: [
				{ id: "first", selectedOptions: ["A", "B"] },
				{ id: "second", selectedOptions: [], customInput: "  custom\n" },
			],
		});
	});
	it("does not fabricate missing answers in a multi-question response", async () => {
		const interactions = new ZCodeInteractions(() => {});
		const answer = interactions.ui.askDialog!([
			{ id: "a", question: "First", options: [{ label: "A" }] },
			{ id: "b", question: "Second", options: [{ label: "B" }] },
		]);
		interactions.resolve(interactions.pending[0]!.interactionId, { answers: { a: ["A"] } });
		// 用户裁定/新语义(interactions.ts):任一题缺答案字段按空串处理,不再整单作废。
		// 「不凭空捏造答案」的意图保留:b 仍是空回答,不会凭空选中 "B"。
		expect(await answer).toMatchObject({
			kind: "submit",
			results: [
				{ id: "a", selectedOptions: ["A"], customInput: undefined },
				{ id: "b", selectedOptions: [], customInput: "" },
			],
		});
	});
	it("preserves explicit indexed skips and lossless desktop multi-select values", async () => {
		const interactions = new ZCodeInteractions(() => {});
		const answer = interactions.ui.askDialog!([
			{ id: "a", question: "First", options: [{ label: "A" }] },
			{ id: "b", question: "Second", multi: true, options: [{ label: "B, C" }, { label: "D" }] },
		]);
		interactions.resolve(interactions.pending[0]!.interactionId, {
			action: "accept",
			content: {
				answers: { Second: "B, C, D" },
				answer_0: [],
				answer_1: ["B, C", "D"],
			},
		});
		expect(await answer).toMatchObject({
			kind: "submit",
			results: [
				{ id: "a", selectedOptions: [], customInput: undefined },
				{ id: "b", selectedOptions: ["B, C", "D"], customInput: undefined },
			],
		});
	});
	it("accepts explicit blank answers without inventing missing indexed fields", async () => {
		const interactions = new ZCodeInteractions(() => {});
		const questions = [
			{ id: "a", question: "First", options: [{ label: "A" }] },
			{ id: "b", question: "Second", options: [{ label: "B" }] },
		];
		const blank = interactions.ui.askDialog!(questions);
		interactions.resolve(interactions.pending[0]!.interactionId, { answer_0: "", answer_1: "B" });
		expect(await blank).toMatchObject({
			kind: "submit",
			results: [
				{ id: "a", selectedOptions: [] },
				{ id: "b", selectedOptions: ["B"] },
			],
		});
		const incomplete = interactions.ui.askDialog!(questions);
		interactions.resolve(interactions.pending[0]!.interactionId, { answers: {}, answer_1: "B" });
		// 用户裁定/新语义(interactions.ts):缺失的 answer_0 按空串处理,不再整单作废。
		// 「不捏造缺失索引字段」的意图保留:a 保持空回答,不会凭空选中 "A"。
		expect(await incomplete).toMatchObject({
			kind: "submit",
			results: [
				{ id: "a", selectedOptions: [], customInput: "" },
				{ id: "b", selectedOptions: ["B"], customInput: undefined },
			],
		});
	});
	it("keeps real native empty single-select, decline, and cancel semantics", async () => {
		const ask = (response: unknown) => {
			const interactions = new ZCodeInteractions(() => {});
			const tool = AskTool.createIf({
				cwd: ".",
				hasUI: false,
				canPromptUser: true,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			} as ToolSession)!;
			let aborted = false;
			const result = tool.execute(
				"empty-or-dismiss",
				{ questions: [{ id: "a", question: "First", options: [{ label: "A" }] }] },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: interactions.ui,
					abort: () => {
						aborted = true;
					},
				} as unknown as AgentToolContext,
			);
			interactions.resolve(interactions.pending[0]!.interactionId, response);
			return { interactions, isAborted: () => aborted, result };
		};
		// 用户裁定/新语义(interactions.ts):显式空串保留为有效空回答(customInput 为空串),
		// 不再被归一化为 undefined 而判为用户取消。
		const blank = ask({ action: "accept", content: { answers: {}, answer_0: "" } });
		await expect(blank.result).resolves.toMatchObject({
			details: { multi: false, selectedOptions: [], customInput: "" },
		});
		expect(blank.isAborted()).toBe(false);
		expect(blank.interactions.pending).toEqual([]);
		// 用户裁定/新语义(interactions.ts):decline(Escape dismiss)是「用户拒绝」而非硬取消,
		// 以 DECLINED_CUSTOM_INPUT 产出 declined tool_result 并继续收口请求。
		const decline = ask({ action: "decline" });
		await expect(decline.result).resolves.toMatchObject({
			details: { selectedOptions: [], customInput: "User declined to answer" },
		});
		expect(decline.isAborted()).toBe(false);
		expect(decline.interactions.pending).toEqual([]);
		// cancel 语义保留(用户裁定/新语义中 cancel 仍是取消):硬取消整轮并中止请求。
		const cancel = ask({ action: "cancel" });
		await expect(cancel.result).rejects.toThrow("Ask tool was cancelled by the user");
		expect(cancel.isAborted()).toBe(true);
		expect(cancel.interactions.pending).toEqual([]);
	});
	it("delivers skipped questions and empty multi-select through the real native Ask tool", async () => {
		for (const questions of [
			[
				{ id: "a", question: "First", options: [{ label: "A" }] },
				{ id: "b", question: "Second", multi: true, options: [{ label: "B, C" }, { label: "D" }] },
			],
			[{ id: "a", question: "First", multi: true, options: [{ label: "A" }] }],
		]) {
			const interactions = new ZCodeInteractions(() => {});
			const tool = AskTool.createIf({
				cwd: ".",
				hasUI: false,
				canPromptUser: true,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			} as ToolSession)!;
			let aborted = false;
			const result = tool.execute("explicit-skips", { questions }, undefined, undefined, {
				hasUI: true,
				ui: interactions.ui,
				abort: () => {
					aborted = true;
				},
			} as unknown as AgentToolContext);
			interactions.resolve(interactions.pending[0]!.interactionId, {
				action: "accept",
				content: { answers: {}, answer_0: "", ...(questions.length > 1 ? { answer_1: ["B, C", "D"] } : {}) },
			});
			const completed = await result;
			if (questions.length > 1) {
				// 用户裁定/新语义(interactions.ts):answer_0 的显式空串保留为有效空回答
				// (customInput 为空串而非 undefined),跳过的题 a 不再被判为取消。
				expect(completed.details).toMatchObject({
					results: [
						{ id: "a", selectedOptions: [], customInput: "" },
						{ id: "b", selectedOptions: ["B, C", "D"], customInput: undefined },
					],
				});
				expect(completed.content).toEqual([{ type: "text", text: 'User answers:\na: ""\nb: [B, C, D]' }]);
			} else {
				expect(completed.details).toMatchObject({ multi: true, selectedOptions: [], customInput: "" });
				// 空串 customInput 使空多选同样是一次有效回答(用户裁定/新语义),
				// 渲染为空自定义输入而非 "did not select any options"。
				expect(completed.content).toEqual([{ type: "text", text: "User provided custom input: " }]);
			}
			expect(aborted).toBe(false);
			expect(interactions.pending).toEqual([]);
		}
	});
	it("delegates real native child questions and cancels only their owning child", async () => {
		const parent = new ZCodeInteractions(() => {});
		const peer = parent.createSubagentUI({
			agentId: "peer",
			agentName: "task",
			sessionId: "peer-session",
			parentSessionId: "parent-session",
		});
		const child = parent.createSubagentUI({
			agentId: "child",
			agentName: "task",
			sessionId: "child-session",
			parentSessionId: "parent-session",
			parentToolCallId: "spawn-call",
		});
		const parentAnswer = parent.ui.input("Parent");
		const peerAnswer = peer.ui.input("Peer");
		const tool = AskTool.createIf({
			cwd: ".",
			hasUI: false,
			canPromptUser: true,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as ToolSession)!;
		let aborted = false;
		const childAnswer = tool.execute(
			"child-ask",
			{
				questions: [{ id: "q", question: "Child?", options: [{ label: "Continue" }] }],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: child.ui,
				abort: () => {
					aborted = true;
				},
			} as unknown as AgentToolContext,
		);
		const pending = parent.pending.find(
			item => "origin" in item.payload && item.payload.origin?.agentId === "child",
		)!;
		expect(pending.payload).toMatchObject({
			origin: {
				kind: "subagent",
				agentId: "child",
				agentType: "task",
				childSessionId: "child-session",
				parentSessionId: "parent-session",
				parentToolCallId: "spawn-call",
			},
		});
		parent.resolve(pending.interactionId, { answers: { q: ["Continue"] } });
		expect(await childAnswer).toMatchObject({ details: { selectedOptions: ["Continue"] } });
		expect(aborted).toBe(false);
		await expect(child.ui.approve!({ full: "Child native approval", compact: "Approval" })).rejects.toThrow(
			"Native tool approval is not supported by the ZCode host",
		);
		child.dispose();
		expect(parent.pending).toHaveLength(2);
		parent.cancel();
		expect(await parentAnswer).toBeUndefined();
		expect(await peerAnswer).toBeUndefined();
		expect(await peer.ui.input("After stop")).toBeUndefined();
	});
	it("rejects native tool approval without publishing a surrogate interaction", async () => {
		const interactions = new ZCodeInteractions(() => {});
		await expect(interactions.ui.approve!({ full: "Native approval", compact: "Approve" })).rejects.toThrow(
			"Native tool approval is not supported by the ZCode host",
		);
		expect(interactions.pending).toHaveLength(0);
	});
	it("delivers a public option answer through the real nonterminal Ask tool", async () => {
		const interactions = new ZCodeInteractions(() => {});
		const tool = AskTool.createIf({
			cwd: ".",
			hasUI: false,
			canPromptUser: true,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as ToolSession);
		expect(tool).not.toBeNull();
		let aborted = false;
		const result = tool!.execute(
			"ask-call",
			{
				questions: [
					{
						id: "confirm",
						question: "Continue isolated session?",
						options: [{ label: "Continue" }, { label: "Cancel" }],
					},
				],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: interactions.ui,
				abort: () => {
					aborted = true;
				},
			} as unknown as AgentToolContext,
		);
		const pending = interactions.pending[0]!;
		expect(pending.payload).toMatchObject({
			prompt: "Continue isolated session?",
			toolName: "AskUserQuestion",
			options: [
				{ optionId: "Continue", label: "Continue" },
				{ optionId: "Cancel", label: "Cancel" },
			],
		});
		expect(interactions.resolve(pending.interactionId, { optionId: "Continue" })).toBe(true);
		expect(await result).toMatchObject({ details: { selectedOptions: ["Continue"] } });
		expect(aborted).toBe(false);
		expect(interactions.pending).toEqual([]);
	});
	it("snoozes real pending timers and publishes the actual pending count", async () => {
		const interactions = new ZCodeInteractions(() => {});
		const answer = interactions.ui.input("Question", undefined, { timeout: 60000 });
		expect(interactions.setAutoResolutionEnabled(false)).toBe(1);
		expect(interactions.pending[0]!.autoResolution?.state).toBe("snoozed");
		interactions.cancel();
		await answer;
	});
	it("rejects a registered terminal command before it can reach the model", async () => {
		let prompts = 0;
		const session = {
			agent: { addBeforeQueuedMessageDequeueHook: () => () => {} },
			subscribe: () => () => {},
			prompt: async () => {
				prompts++;
			},
		} as unknown as AgentSession;
		const host = new ZCodeCommandHost(session, ".", () => {});
		await expect(host.dispatch("/display")).rejects.toMatchObject({ code: "unsupported" });
		expect(prompts).toBe(0);
	});
	it("rejects /move and /wt at dispatch because they would chdir the shared process", async () => {
		// 用户裁定(findings P2):/move、/wt 的 headless handle 会 setProjectDir →
		// process.chdir 改整个进程 cwd,违反同进程多会话禁令;app-server 直接拒绝,仅 TUI 可用。
		let prompts = 0;
		const session = {
			agent: { addBeforeQueuedMessageDequeueHook: () => () => {} },
			subscribe: () => () => {},
			prompt: async () => {
				prompts++;
			},
		} as unknown as AgentSession;
		const host = new ZCodeCommandHost(session, ".", () => {});
		for (const text of ["/move ..", "/move", "/wt feature-x", "/worktree"]) {
			await expect(host.dispatch(text)).rejects.toMatchObject({
				code: "unsupported",
				message: "/move、/wt 仅 TUI 可用",
			});
		}
		expect(prompts).toBe(0);
	});
	it("does not return accepted when runtime initialization fails", async () => {
		const session = {
			subscribe: () => () => {},
			agent: { addBeforeQueuedMessageDequeueHook: () => () => {} },
		} as unknown as AgentSession;
		const host = new ZCodeCommandHost(session, ".", () => {});
		host.initialize = async () => {
			throw new Error("initialization failed");
		};
		await expect(host.dispatch("hello")).rejects.toThrow("initialization failed");
	});
	it("waits for the real submit admission while leaving final completion separate", async () => {
		const session = {
			subscribe: () => () => {},
			agent: { addBeforeQueuedMessageDequeueHook: () => () => {} },
		} as unknown as AgentSession;
		const started = Promise.withResolvers<void>();
		const durableAdmission = Promise.withResolvers<void>();
		const host = new ZCodeCommandHost(session, ".", () => {}, {
			submit: async () => {
				started.resolve();
				await durableAdmission.promise;
			},
		});
		host.initialize = async () => {};
		let accepted = false;
		const request = host.dispatch("hello").then(receipt => {
			accepted = true;
			return receipt;
		});
		await started.promise;
		expect(accepted).toBe(false);
		durableAdmission.resolve();
		const receipt = await request;
		expect(receipt.accepted).toBe(true);
		await receipt.completion;
	});
	for (const busy of ["streaming", "compacting"] as const) {
		it(`controls the native Goal while ${busy} without admitting controls to the held objective queue`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-zcode-goal-control-"));
			const authStorage = await AuthStorage.create(":memory:");
			// AgentSession 在 prompt admission 时也校验 registry auth；不能只给 Agent.getApiKey。
			authStorage.keys.setRuntime("anthropic", "zcode-goal-test-key");
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const providerStopped = Promise.withResolvers<void>();
			const mock = createMockModel({
				responses:
					busy === "streaming"
						? [
								async (_context, options) => {
									// 流由本用例的 Stop/abort 释放，不用长定时器或真实 provider 续跑。
									const signal = options!.signal!;
									const stopped = Promise.withResolvers<void>();
									const onAbort = () => stopped.resolve();
									signal.addEventListener("abort", onAbort, { once: true });
									if (signal.aborted) stopped.resolve();
									started.resolve();
									try {
										await stopped.promise;
										return { content: ["interrupted"] };
									} finally {
										signal.removeEventListener("abort", onAbort);
										providerStopped.resolve();
									}
								},
							]
						: [{ content: ["first answer"] }, { content: ["second answer"] }],
			});
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [],
				},
				convertToLlm,
				streamFn: mock.stream,
			});
			const sessionManager = SessionManager.inMemory();
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"compaction.keepRecentTokens": 1,
				"compaction.experimentalContextManagement": false,
			});
			const testModelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"), {
				ignoreLocalModelConfig: true,
				settings,
				fetch: () => Promise.reject(new Error("network forbidden in Goal control regression")),
			});
			let extensionRunner: ExtensionRunner | undefined;
			if (busy === "compacting") {
				const runtime = new ExtensionRuntime();
				const extension = await loadExtensionFromFactory(
					pi => {
						pi.on("session_before_compact", async () => {
							started.resolve();
							await release.promise;
							return { cancel: true };
						});
					},
					root,
					new EventBus(),
					runtime,
					"zcode-goal-control-compaction",
				);
				extensionRunner = new ExtensionRunner([extension], runtime, root, sessionManager, testModelRegistry);
			}
			const session = new AgentSession({
				agent,
				sessionManager,
				settings,
				modelRegistry: testModelRegistry,
				extensionRunner,
			});
			const host = new ZCodeCommandHost(session, root, () => {});
			// 只跳过外部插件发现；命令 admission、Goal 控制器、原生状态和事件均走真实实现。
			host.initialize = async () => {};
			const updates: Array<{ id: string; status: string }> = [];
			const unsubscribe = session.subscribe(event => {
				if (event.type === "goal_updated" && event.state)
					updates.push({ id: event.state.goal.id, status: event.state.goal.status });
			});
			let work: Promise<unknown> | undefined;
			try {
				if (busy === "compacting") {
					await session.prompt("first turn");
					await session.prompt("second turn");
				}
				await session.goalRuntime.createGoal({ objective: "original objective" });
				const goalId = session.getGoalModeState()!.goal.id;
				updates.length = 0;
				session.setQueueAutoDrain(false);
				work = busy === "streaming" ? session.prompt("busy turn") : session.compact().catch(error => error);
				await started.promise;
				expect(session.isStreaming).toBe(busy === "streaming");
				expect(session.isCompacting).toBe(busy === "compacting");
				const inputs = [
					{ text: "/goal set replacement objective", inputId: "goal-set" },
					{ text: "/goal next objective", inputId: "goal-objective" },
					{ text: "/goal-autopilot unattended objective", inputId: "goal-autopilot" },
				];
				for (const input of inputs) {
					const receipt = await host.dispatch(input.text, {
						inputId: input.inputId,
						sourceCommand: {
							sessionId: null,
							commandId: input.inputId,
							fingerprint: input.text,
							type: "goal",
						},
					});
					await receipt.completion;
				}
				const queued = session.getQueuedInputMessages();
				expect(queued).toHaveLength(inputs.length);
				for (const [index, input] of inputs.entries()) {
					expect(queued[index]).toBe(agent.peekFollowUpQueue()[index]);
					expect(queued[index]).toMatchObject({
						inputId: input.inputId,
						sourceCommand: {
							sessionId: null,
							commandId: input.inputId,
							fingerprint: input.text,
							type: "goal",
						},
					});
				}
				expect(session.getGoalModeState()!.goal.objective).toBe("original objective");
				// 原缺陷把 pause 排到运行中目标后；必须在 busy 尚未解除时观察到 owner 的暂停事实。
				const paused = await host.dispatch("/goal pause", { inputId: "goal-pause" });
				await paused.completion;
				expect(session.getGoalModeState()).toMatchObject({
					enabled: false,
					goal: { id: goalId, status: "paused", objective: "original objective" },
				});
				expect(updates.at(-1)).toEqual({ id: goalId, status: "paused" });
				const resumed = await host.dispatch("/goal resume", { inputId: "goal-resume" });
				await resumed.completion;
				expect(session.getGoalModeState()).toMatchObject({
					enabled: true,
					goal: { id: goalId, status: "active", objective: "original objective" },
				});
				expect(updates.at(-1)).toEqual({ id: goalId, status: "active" });
				expect(session.isStreaming || session.isCompacting).toBe(true);
				// resume 只能恢复同一 Goal；busy 边界仍由本用例持有，不能偷偷另起 provider 请求。
				expect(mock.calls).toHaveLength(busy === "streaming" ? 1 : 2);
				if (busy === "streaming") expect(mock.calls[0]!.options!.signal!.aborted).toBe(false);
				expect(session.getQueuedInputMessages()).toEqual(queued);
				for (const [index, message] of queued.entries())
					expect(session.getQueuedInputMessages()[index]).toBe(message);
				host.cancel();
				release.resolve();
				await session.abort({ reason: USER_INTERRUPT_LABEL, preserveQueuedInputs: true });
				if (busy === "streaming") {
					await providerStopped.promise;
					expect(mock.calls[0]!.options!.signal!.aborted).toBe(true);
				}
				await work;
				await session.waitForIdle();
				expect(session.getQueueAutoDrain()).toBe(false);
				expect(session.getQueuedInputMessages()).toEqual(queued);
				for (const [index, message] of queued.entries())
					expect(session.getQueuedInputMessages()[index]).toBe(message);
				expect(mock.calls).toHaveLength(busy === "streaming" ? 1 : 2);
			} finally {
				host.dispose();
				unsubscribe();
				release.resolve();
				await session.abort({ reason: USER_INTERRUPT_LABEL, preserveQueuedInputs: true });
				await work;
				await session.dispose();
				authStorage.close();
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	}
});
