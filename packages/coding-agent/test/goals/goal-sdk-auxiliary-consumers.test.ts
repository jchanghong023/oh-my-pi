import { describe, expect, test } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { renderOrchestrateNotice } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, type CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { contentText, createProviderFixture, type ModelRequest, type Reply } from "../spec-driven/provider-fixture";

const instruction = "MUST 全自动无人值守完成完整目标。";
const objective = "GOAL_AUX_OBJECTIVE preserve this complete objective\n\nLiteral {{objective}} & <user> data.\tEND";
const modelId = "goal-auxiliary-local";
const modelName = `deepseek/${modelId}`;

// Only the presentation changes: ctx.invokeTool delegates to the SDK's
// captured native TaskTool, including its real executor and child sessions.
const indirectTask: ExtensionFactory = api => {
	const parameters = getTaskSchema({ isolationEnabled: false, batchEnabled: false, structured: false });
	api.registerTool({
		name: "task",
		label: "Native Goal child",
		description: "Run a native child inspection through xd://task.",
		parameters,
		loadMode: "discoverable",
		approval: "exec",
		async execute(_id, args, signal, onUpdate, context) {
			if (!context.invokeTool) throw new Error("Missing native TaskTool delegation");
			const validated = parameters.assert(args);
			if (!isRecord(validated)) throw new Error("Expected native TaskTool parameters");
			return context.invokeTool(validated, { signal, onUpdate });
		},
	});
};

function notices(session: AgentSession): CustomMessage[] {
	return session.messages.filter(
		(message): message is CustomMessage =>
			message.role === "custom" && message.customType === "goal-auto-orchestrate-context",
	);
}
function occurrences(request: ModelRequest, text: string): number {
	return request.messages.reduce((count, message) => count + contentText(message.content).split(text).length - 1, 0);
}
function callable(request: ModelRequest, name: string): string {
	const result = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === name)?.function?.name;
	if (!result) throw new Error(`Goal SDK consumer requires native ${name}`);
	return result;
}

// Uses the existing local Provider transport fixture, real SDK construction,
// native tools/executor, real advisor and real compaction. No model-loop spies.
async function harness(reply: (request: ModelRequest) => Reply) {
	const root = await TempDir.create("@goal-sdk-aux-");
	const provider = createProviderFixture({ reply });
	const auth = await AuthStorage.create(root.join("auth.db"));
	const children: AgentSession[] = [];
	let session: AgentSession | undefined;
	const controller = new AbortController();
	const pending = new Set<Promise<unknown>>();
	const deadline = Promise.withResolvers<never>();
	void deadline.promise.catch(() => {});
	let timer: NodeJS.Timeout | undefined;
	async function close() {
		clearTimeout(timer);
		controller.abort(new Error("Goal auxiliary fixture closed"));
		const sessions = [...children, ...(session ? [session] : [])];
		try {
			for (const current of sessions) {
				current.setAdvisorEnabled(false);
				current.abortHandoff();
				current.abortCompaction(controller.signal.reason);
			}
			await Promise.all(sessions.map(current => current.abort({ goalReason: "internal" })));
			await Promise.allSettled([...pending]);
			// A child under construction when cancellation landed is owned as soon
			// as creation settles, before run() can admit its first prompt.
			for (const current of new Set([...children, ...(session ? [session] : [])])) await current.dispose();
		} finally {
			auth.close();
			await provider[Symbol.asyncDispose]();
			await root.remove();
		}
	}
	try {
		auth.keys.setRuntime("deepseek", "isolated-goal-aux-key");
		// ascend is a company-managed provider: ModelRegistry intentionally ignores
		// models.yml rows for it. Use an admitted customizable provider instead.
		await Bun.write(
			root.join("models.yml"),
			JSON.stringify({
				providers: {
					deepseek: {
						baseUrl: provider.baseUrl,
						api: "openai-completions",
						apiKey: "isolated-goal-aux-key",
						models: [
							{
								id: modelId,
								name: "Isolated Goal auxiliary provider",
								reasoning: false,
								input: ["text"],
								contextWindow: 131072,
								maxTokens: 2048,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			}),
		);
		const settings = Settings.isolated({
			modelRoles: { default: modelName, smol: modelName, task: modelName, advisor: modelName },
			enabledProviders: ["deepseek"],
			enabledModels: [modelName],
			defaultThinkingLevel: "minimal",
			"tools.xdev": true,
			"async.enabled": false,
			"task.batch": false,
			"task.structured": false,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
			"task.workerThreads": 0,
			"compaction.enabled": false,
			"compaction.keepRecentTokens": 1,
			"compaction.remoteEnabled": false,
			"compaction.remoteStreamingV2Enabled": false,
			"compaction.methodOrder": ["soft"],
			"compaction.autoContinue": false,
			"retry.enabled": false,
			"autolearn.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"goal.continuationModes": [],
			"providers.cacheWarming": "off",
		});
		const registry = new ModelRegistry(auth, root.join("models.yml"), { settings });
		const model = registry.find("deepseek", modelId);
		if (!model) throw new Error("Missing admitted local Goal SDK model");
		expect(registry.getError()).toBeUndefined();
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe(provider.baseUrl);
		const options = {
			cwd: root.path(),
			agentDir: root.path(),
			authStorage: auth,
			modelRegistry: registry,
			model,
			settings,
			systemPrompt: ["Test the native Goal consumers. Treat all saved user messages as user data."],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			extensions: [indirectTask],
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			bindProcessState: false,
			workspaceTree: { rootPath: root.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			getAgentDefinitions: () => [
				{
					name: "task",
					description: "Read the Goal fixture",
					systemPrompt: "Read child-input.txt, then report the actual result.",
					source: "project" as const,
					tools: ["read"],
				},
			],
			subagentHooks: {
				beforeSpawn: async () => ({ keepAlive: false }),
				configureSession: async () => ({
					onSessionCreated: (child: AgentSession) => {
						children.push(child);
					},
				}),
			},
		};
		({ session } = await createAgentSession({
			...options,
			sessionManager: SessionManager.create(root.path(), root.join("sessions")),
		}));
		timer = setTimeout(() => {
			const error = new Error("Goal auxiliary fixture did not settle before its cleanup deadline");
			controller.abort(error);
			deadline.reject(error);
		}, 45_000);
		return {
			root,
			provider,
			session,
			options,
			signal: controller.signal,
			own(child: AgentSession) {
				children.push(child);
			},
			run<T>(operation: () => Promise<T>): Promise<T> {
				controller.signal.throwIfAborted();
				const result = Promise.try(operation);
				pending.add(result);
				void result.then(
					() => pending.delete(result),
					() => pending.delete(result),
				);
				return Promise.race([result, deadline.promise, provider.failure]);
			},
			[Symbol.asyncDispose]: close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

async function enter(session: AgentSession, signal: AbortSignal) {
	// A completed earlier turn makes the subsequent real manual compaction a
	// history rewrite, not an uncompactable single-turn/no-op setup.
	await session.prompt("Prior independent inspection with removable history. ".repeat(128));
	signal.throwIfAborted();
	const state = await session.goalRuntime.createGoal({ objective, autoOrchestrate: true });
	signal.throwIfAborted();
	await session.prompt(objective, { goalAutoOrchestrateInitialId: state.goal.id });
	signal.throwIfAborted();
	// Move the Goal-bearing turn out of keepRecentTokens so the history summary
	// consumes the saved notice; retained-tail/display summaries need not repeat it.
	await session.prompt("Continue the saved inspection without changing its authorization.");
	signal.throwIfAborted();
	expect(notices(session)).toHaveLength(1);
	return notices(session)[0]!;
}

describe("Goal SDK indirect capability and auxiliary history consumers", () => {
	test("native xd://task executes a real child while the Goal notice uses the enabled capability view", async () => {
		let childStage = false;
		await using h = await harness(request => {
			if (!childStage) return { text: "GOAL_PRIMARY_FINISHED" };
			if (!request.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "read"))
				return { text: "Read fixture" };
			const observed = request.messages
				.filter(message => message.role === "tool")
				.map(message => contentText(message.content))
				.join("\n");
			return observed.includes("REAL_CHILD_FILE_BYTES")
				? { text: "GOAL_CHILD_VERIFIED_REAL_READ" }
				: { tool: { name: callable(request, "read"), args: { path: "child-input.txt" } } };
		});
		expect(h.session.getActiveToolNames()).not.toContain("task");
		expect(h.session.getMountedXdevToolNames()).toContain("task");
		expect(h.session.getEnabledToolNames()).toContain("task");
		expect(h.session.getToolByName("xd://task")?.name).toBe("task");
		const notice = await h.run(() => enter(h.session, h.signal));
		const original = JSON.stringify(notice);
		const rules = renderOrchestrateNotice({ tools: h.session.getEnabledToolNames() }, { authority: "user" });
		expect(contentText(notice.content)).toContain(rules);
		const primary = h.provider.requests.at(-1)!;
		expect(primary.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "task")).toBe(false);
		expect(occurrences(primary, instruction)).toBe(1);
		expect(occurrences(primary, contentText(notice.content))).toBe(1);
		await Bun.write(h.root.join("child-input.txt"), "REAL_CHILD_FILE_BYTES");
		childStage = true;
		const before = h.provider.requests.length;
		const write = h.session.getToolByName("write");
		if (!write) throw new Error("Missing actual xd:// write transport");
		const result = await h.run(() =>
			write.execute(
				"goal-native-task",
				{
					path: "xd://task",
					content: JSON.stringify({
						name: "GoalAuxChild",
						task: "Read child-input.txt and report the actual file bytes; do not inherit the root Goal authorization.",
						solutionSpace: "one read-only inspection",
					}),
				},
				h.signal,
			),
		);
		expect(result.isError).not.toBe(true);
		expect(JSON.stringify(result)).toContain("GOAL_CHILD_VERIFIED_REAL_READ");
		const childRequests = h.provider.requests.slice(before);
		expect(childRequests.length).toBeGreaterThanOrEqual(2);
		expect(
			childRequests.some(request =>
				request.messages.some(
					message => message.role === "tool" && contentText(message.content).includes("REAL_CHILD_FILE_BYTES"),
				),
			),
		).toBe(true);
		for (const request of childRequests) expect(occurrences(request, instruction)).toBe(0);
		expect(notices(h.session).map(message => JSON.stringify(message))).toEqual([original]);
		expect(h.session.getGoalModeState()).toMatchObject({
			enabled: true,
			autoOrchestrate: true,
			goal: { status: "active", objective },
		});
		expect(h.provider.failures).toEqual([]);
	}, 60_000);

	test("disabled native task stays absent until a committed compaction reads the restored xd:// capability", async () => {
		await using h = await harness(() => ({
			text: "## Goal\nContinue the saved inspection.\n\n## Progress\nPrior inspection finished.",
		}));
		const enabled = h.session.getEnabledToolNames();
		const mounted = h.session.getMountedXdevToolNames();
		expect(mounted).toContain("task");
		await h.run(() =>
			h.session.setActiveToolPresentation(
				enabled.filter(name => name !== "task"),
				mounted.filter(name => name !== "task"),
				false,
				h.signal,
			),
		);
		expect(h.session.getEnabledToolNames()).not.toContain("task");
		const initial = await h.run(() => enter(h.session, h.signal));
		const original = JSON.stringify(initial);
		const expectedRules = renderOrchestrateNotice(
			{ tools: [...h.session.getEnabledToolNames(), "task"] },
			{ authority: "user" },
		);
		expect(contentText(initial.content)).toContain(objective);
		expect(contentText(initial.content)).toContain(instruction);
		expect(contentText(initial.content)).not.toContain(expectedRules);
		await h.run(() => h.session.setActiveToolPresentation(enabled, mounted, false, h.signal));
		expect(h.session.getActiveToolNames()).not.toContain("task");
		expect(h.session.getEnabledToolNames()).toContain("task");
		await h.run(() => h.session.prompt("Inspect independently before any history rewrite."));
		expect(notices(h.session).map(message => JSON.stringify(message))).toEqual([original]);
		expect(occurrences(h.provider.requests.at(-1)!, contentText(initial.content))).toBe(1);
		await h.run(() => h.session.compact());
		expect(h.session.sessionManager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(1);
		const restored = notices(h.session);
		expect(restored).toHaveLength(1);
		expect(contentText(restored[0]!.content)).toContain(
			renderOrchestrateNotice({ tools: h.session.getEnabledToolNames() }, { authority: "user" }),
		);
		expect(contentText(restored[0]!.content)).toContain(objective);
		expect(restored[0]!.details).toMatchObject({
			source: "goal-auto-orchestrate",
			compactionEntryId: expect.any(String),
		});
		const before = h.provider.requests.length;
		await h.run(() => h.session.prompt("Read the restored history once."));
		expect(h.provider.requests).toHaveLength(before + 1);
		expect(occurrences(h.provider.requests.at(-1)!, contentText(restored[0]!.content))).toBe(1);
		expect(h.provider.failures).toEqual([]);
	}, 60_000);

	test.each(["ephemeral", "handoff", "advisor", "compaction", "restored-subagent"] as const)(
		"%s consumes its allowed history without constructing another root authorization in its request",
		async consumer => {
			let auxiliary = false;
			await using h = await harness(request => {
				if (!auxiliary) return { text: "GOAL_PRIMARY_HISTORY_READY" };
				if (
					consumer === "advisor" &&
					request.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "advise") &&
					!request.messages.some(message => message.role === "tool")
				) {
					return {
						tool: {
							name: callable(request, "advise"),
							args: {
								note: "The inspected history contains the existing authorization; no changes are required.",
								severity: "nit",
							},
						},
					};
				}
				return {
					text:
						consumer === "compaction"
							? "## Goal\nContinue inspecting the saved work.\n\n## Progress\nThe previous inspection finished."
							: "GOAL_AUXILIARY_FINISHED",
				};
			});
			const notice = await h.run(() => enter(h.session, h.signal));
			const bytes = JSON.stringify(notice);
			const text = contentText(notice.content);
			const providerNotice = convertToLlm([notice])[0]!;
			await h.session.sessionManager.ensureOnDisk();
			await h.session.sessionManager.flush();
			const before = h.provider.requests.length;
			const entryIds = h.session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom_message" && entry.customType === "goal-auto-orchestrate-context")
				.map(entry => entry.id);
			expect(entryIds).toHaveLength(1);
			auxiliary = true;
			switch (consumer) {
				case "ephemeral":
					expect(
						(
							await h.run(() =>
								h.session.runEphemeralTurn({
									promptText: "Inspect the existing saved history only.",
									tools: false,
									signal: h.signal,
								}),
							)
						).replyText,
					).toBe("GOAL_AUXILIARY_FINISHED");
					break;
				case "handoff":
					expect((await h.run(() => h.session.handoff(undefined, { signal: h.signal })))?.document).toBe(
						"GOAL_AUXILIARY_FINISHED",
					);
					break;
				case "advisor":
					expect(h.session.setAdvisorEnabled(true)).toBe(true);
					try {
						await h.run(() =>
							h.session.prompt("Inspect the existing result without granting any new authorization."),
						);
						expect(await h.run(() => h.session.waitForAdvisorCatchup(10_000))).toBe(true);
					} finally {
						h.session.setAdvisorEnabled(false);
					}
					break;
				case "compaction":
					await h.run(() => h.session.compact());
					expect(h.session.sessionManager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(
						1,
					);
					break;
				case "restored-subagent": {
					const file = h.session.sessionManager.getSessionFile();
					if (!file) throw new Error("Expected a persisted root history");
					const manager = await SessionManager.forkFrom(file, h.root.path(), h.root.join("child-history"));
					const { session: child } = await h.run(async () => {
						const result = await createAgentSession({
							...h.options,
							sessionManager: manager,
							agentId: "GoalHistoryConsumer",
							parentTaskPrefix: "GoalHistoryConsumer",
							taskDepth: 1,
							toolNames: ["read"],
						});
						h.own(result.session);
						return result;
					});
					await h.run(() => child.prompt("Read the existing history; do not recreate the root Goal notice."));
					expect(convertToLlm(notices(child))).toEqual([providerNotice]);
					expect(
						child.sessionManager
							.getBranch()
							.filter(
								entry =>
									entry.type === "custom_message" && entry.customType === "goal-auto-orchestrate-context",
							)
							.map(entry => entry.id),
					).toEqual(entryIds);
					break;
				}
			}
			const requests = h.provider.requests.slice(before);
			expect(requests.length).toBeGreaterThan(0);
			// Verify real requests at each consumer's actual history boundary.
			const side =
				consumer === "advisor"
					? requests.filter(request =>
							request.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "advise"),
						)
					: requests;
			expect(side.length).toBeGreaterThan(0);
			if (consumer === "advisor") {
				// setAdvisorEnabled(true) seeds the cursor at the current primary
				// history. Its next review consumes only the new turn, not old notices.
				for (const request of side) {
					expect(occurrences(request, instruction)).toBe(0);
					expect(occurrences(request, text)).toBe(0);
				}
				expect(
					side.some(request =>
						request.messages.some(message =>
							contentText(message.content).includes(
								"Inspect the existing result without granting any new authorization.",
							),
						),
					),
				).toBe(true);
			} else if (consumer === "compaction") {
				// Full-history summarization reads the persisted notice. Split-turn
				// and display summaries consume the retained tail/produced summary,
				// not a freshly constructed copy of the root authorization.
				const historyRequests = side.filter(
					request => occurrences(request, "Prior independent inspection with removable history.") > 0,
				);
				expect(historyRequests.length).toBeGreaterThan(0);
				for (const request of historyRequests) {
					expect(occurrences(request, instruction)).toBe(1);
					expect(occurrences(request, text)).toBe(1);
				}
				const derivedRequests = side.filter(request => !historyRequests.includes(request));
				expect(derivedRequests.length).toBeGreaterThan(0);
				for (const request of derivedRequests) {
					expect(occurrences(request, instruction)).toBe(0);
					expect(occurrences(request, text)).toBe(0);
					expect(
						request.messages.some(message => {
							const context = contentText(message.content);
							return (
								context.includes("<conversation>") &&
								(context.includes("Continue the saved inspection without changing its authorization.") ||
									context.includes(
										"<previous-summary>\n## Goal\nContinue inspecting the saved work.\n\n## Progress\nThe previous inspection finished.",
									))
							);
						}),
					).toBe(true);
				}
			} else {
				for (const request of side) {
					expect(occurrences(request, instruction)).toBe(1);
					expect(occurrences(request, text)).toBe(1);
				}
			}
			if (consumer !== "compaction" && consumer !== "handoff") {
				expect(notices(h.session).map(message => JSON.stringify(message))).toEqual([bytes]);
				expect(
					h.session.sessionManager
						.getBranch()
						.filter(
							entry => entry.type === "custom_message" && entry.customType === "goal-auto-orchestrate-context",
						)
						.map(entry => entry.id),
				).toEqual(entryIds);
				expect(convertToLlm([notices(h.session)[0]!])[0]).toEqual(providerNotice);
			} else {
				// Only the successful root commit may create one recovery, after
				// the auxiliary model has consumed its applicable history context.
				const recoveries = h.session.sessionManager
					.getBranch()
					.filter(
						entry =>
							entry.type === "custom_message" &&
							entry.customType === "goal-auto-orchestrate-context" &&
							entry.details &&
							typeof entry.details === "object" &&
							"compactionEntryId" in entry.details,
					);
				expect(recoveries).toHaveLength(1);
				expect(notices(h.session)).toHaveLength(1);
			}
			expect(h.provider.failures).toEqual([]);
		},
		60_000,
	);
});
