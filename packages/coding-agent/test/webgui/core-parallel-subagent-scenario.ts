import { expect } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	testId,
	TID_TASK_ITEM,
	TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER,
	TID_V4_SUBAGENT_OPEN_SIDE_PANE,
	TID_CHAT_SUMMARY_PANEL,
} from "../../../../vendor/zcode-frontend/packages/shared/src/test-ids";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, type SubagentLifecyclePayload } from "../../src/task/types";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import type { BrowserGlobals } from "./core-browser-dom";
import type { NativeBrowserCase } from "./core-browser-types";

interface Child {
	id: string;
	session: AgentSession;
	manager: SessionManager;
	file: string;
	finish(): void;
	prompt: Promise<boolean>;
}

/** Port of SAT24 through actual SDK/registry/RPC and browser consumers, without seven cloud calls. */
export async function parallelSubagentScenario(native: NativeBrowserCase): Promise<void> {
	const { page, session: root } = native;
	const registry = root.agentRegistry;
	const model = root.model;
	const eventBus = root.subagentEventBus;
	if (!registry || !model || !eventBus)
		throw new Error("Parallel fixture requires the bound native registry, model and event bus");
	const manager = root.sessionManager;
	const rootId = root.sessionId;
	const rootCwd = manager.getCwd();
	const other = await native.seedHistory(
		"Parallel unrelated history",
		"UNRELATED_HISTORY_USER",
		"UNRELATED_HISTORY_REPLY",
	);
	const user = {
		role: "user" as const,
		content: "Observe three existing native child assignments",
		timestamp: Date.now(),
	};
	manager.appendMessage(user);
	root.agent.appendMessage(user);
	const call = createAssistantMessage("");
	call.stopReason = "toolUse";
	call.content = [
		{
			type: "toolCall",
			id: "parallel-native-task",
			name: "task",
			arguments: {
				tasks: [
					{
						name: "ParallelA",
						agent: "task",
						task: "Private child A assignment",
						solutionSpace: "one test assignment",
					},
					{
						name: "ParallelB",
						agent: "task",
						task: "Private child B assignment",
						solutionSpace: "one test assignment",
					},
					{
						name: "ParallelC",
						agent: "task",
						task: "Private child C assignment",
						solutionSpace: "one test assignment",
					},
				],
			},
		},
	];
	manager.appendMessage(call);
	root.agent.appendMessage(call);
	await manager.setSessionName("Parallel parent", "user");
	await manager.ensureOnDisk();
	await manager.flush();
	const artifacts = manager.getArtifactsDir();
	if (!artifacts) throw new Error("Parallel native fixture has no artifact directory");
	await fs.mkdir(artifacts, { recursive: true });
	const children: Child[] = [];
	let withheld: { original: string; temporary: string } | undefined;
	const lifecycle = (child: Child, status: SubagentLifecyclePayload["status"]) => {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: child.id,
			agent: "task",
			agentSource: "bundled",
			status,
			index: children.indexOf(child),
			description: `Native assignment ${child.id}`,
			parentToolCallId: "parallel-native-task",
			sessionFile: child.file,
		} satisfies SubagentLifecyclePayload);
	};
	try {
		for (const id of ["ParallelA", "ParallelB", "ParallelC"]) {
			const file = path.join(artifacts, `${id}.jsonl`);
			const childManager = await SessionManager.open(file, undefined, undefined, {
				initialCwd: rootCwd,
				suppressBreadcrumb: true,
			});
			childManager.appendMessage({ role: "user", content: `Assignment for ${id}`, timestamp: Date.now() });
			if (id !== "ParallelC") {
				childManager.appendMessage(createAssistantMessage(`Initial ${id} history`));
				await childManager.ensureOnDisk();
				await childManager.flush();
			}
			const { session } = await createAgentSession({
				cwd: rootCwd,
				agentDir: path.join(rootCwd, "agent"),
				sessionManager: childManager,
				authStorage: root.modelRegistry.authStorage,
				modelRegistry: root.modelRegistry,
				model,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"async.enabled": false,
					"memory.backend": "off",
				}),
				toolNames: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				preloadedCustomToolPaths: [],
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				bindProcessState: false,
				offline: true,
				agentRegistry: registry,
				agentId: id,
				taskDepth: 1,
				parentAgentId: root.getAgentId(),
				subagentEventBus: root.subagentEventBus,
			});
			const began = Promise.withResolvers<void>();
			const barrier = Promise.withResolvers<void>();
			const response = createMockModel({ responses: [{ content: [`Finished ${id}`] }] });
			session.agent.streamFn = (selectedModel, context, options) => {
				const stream = new AssistantMessageEventStream();
				void (async () => {
					for await (const event of response.stream(selectedModel, context, options)) {
						stream.push(event);
						if (event.type === "text_delta") {
							began.resolve();
							await barrier.promise;
						}
					}
				})().catch(error => {
					stream.fail(error);
					began.reject(error);
				});
				return stream;
			};
			const prompt = session.prompt(`Continue the private ${id} assignment`);
			void prompt.catch(error => began.reject(error));
			children.push({ id, session, manager: childManager, file, finish: () => barrier.resolve(), prompt });
			await began.promise;
			expect(session.isStreaming).toBe(true);
		}
		const last = children[2]!;
		// Withhold only a private fixture journal, reproducing publication before disk visibility.
		if (await Bun.file(last.file).exists()) {
			withheld = { original: last.file, temporary: `${last.file}.not-yet-published` };
			await fs.rename(withheld.original, withheld.temporary);
		}
		expect(await Bun.file(last.file).exists()).toBe(false);
		await page.goto(native.url, { waitUntil: "domcontentloaded" });
		await page.waitForSelector('[data-testid="v4-timeline"]', { visible: true });
		const expectedIds = children.map(child => child.session.sessionId).sort();
		const trigger = `[data-testid="${TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER}"]`;
		const panel = `[data-testid="${TID_CHAT_SUMMARY_PANEL}"]`;
		const readCompleteProjection = async () => {
			await page.waitForFunction(
				(control, summary, ids) => {
					const { document } = globalThis as BrowserGlobals;
					const pane = document.querySelector("[data-running-subagent-ids]");
					const actual = (pane?.getAttribute("data-running-subagent-ids") ?? "").split(",").filter(Boolean).sort();
					return (
						JSON.stringify(actual) === JSON.stringify(ids) &&
						Number(document.querySelector(control)?.getAttribute("data-background-subagent-count")) ===
							ids.length &&
						Number(document.querySelector(summary)?.getAttribute("data-running-agent-count")) === ids.length
					);
				},
				{},
				trigger,
				panel,
				expectedIds,
			);
			// Native running entries live in the status panel, not the completed tool summary row.
			await page.locator(trigger).click();
			for (const childId of expectedIds) {
				await page.waitForSelector(
					`${panel} [data-running-subagent-session-trigger="true"][data-child-session-id=${JSON.stringify(childId)}]`,
					{ visible: true },
				);
			}
			const actualEntries = await page.$$eval(`${panel} [data-running-subagent-session-trigger="true"]`, entries =>
				entries.map(entry => entry.getAttribute("data-child-session-id")).sort(),
			);
			expect(actualEntries).toEqual(expectedIds);
			expect(root.sessionId).toBe(rootId);
			expect(manager.getCwd()).toBe(rootCwd);
		};
		for (const child of children) lifecycle(child, "started");
		await readCompleteProjection();
		expect(await Bun.file(last.file).exists()).toBe(false);
		const otherRow = `[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, other.sessionId))}]`;
		await page.locator(otherRow).click();
		await page.waitForFunction(
			text => {
				const { document } = globalThis as BrowserGlobals;
				return document.querySelector('[data-testid="v4-timeline"]')?.textContent?.includes(text);
			},
			{},
			other.assistantText,
		);
		await page.locator(`[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, rootId))}]`).click();
		await readCompleteProjection();
		if (withheld) {
			await fs.rename(withheld.temporary, withheld.original);
			withheld = undefined;
		}
		for (const child of children) child.finish();
		await Promise.all(children.map(child => child.prompt));
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "parallel-native-task",
			toolName: "task",
			timestamp: Date.now(),
			isError: false,
			content: [{ type: "text", text: "All three native child assignments completed" }],
			details: {
				results: children.map(child => ({ id: child.id, agent: "task", exitCode: 0, description: child.id })),
			},
		};
		manager.appendMessage(result);
		root.agent.appendMessage(result);
		await manager.flush();
		for (const child of children) lifecycle(child, "completed");
		await page.waitForFunction(() => {
			const { document } = globalThis as BrowserGlobals;
			return document.querySelector("[data-running-subagent-ids]")?.getAttribute("data-running-subagent-ids") === "";
		});
		expect(new Set(children.map(child => child.session.sessionId)).size).toBe(3);
		expect(root.sessionId).toBe(rootId);
		// 原生 task 工具名是小写；配对失败时 Agent 摘要行会退化成不可点击的裸摘要。
		// 同一次 task 派发 3 个子代理时只有第一条摘要能和工具行配对，其余裸 subagent 行
		// 也必须能各自下钻——所以逐个子代理点开并读到它自己的正文，而不是只断言 id 存在。
		for (const child of children) {
			const openChild = `[data-testid=${JSON.stringify(
				testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, child.session.sessionId),
			)}]`;
			await page.waitForSelector(openChild, { visible: true });
			await page.locator(openChild).click();
			await page.waitForFunction(
				text => {
					const { document } = globalThis as BrowserGlobals;
					// forceMount 会保留非活动 tab，必须只看当前活动面板，否则读到上一个子会话。
					const active = document.querySelector(
						'[data-side-pane-content-slot] [role="tabpanel"][data-state="active"]',
					);
					return (active?.textContent ?? "").includes(text);
				},
				{},
				`Finished ${child.id}`,
			);
		}
	} finally {
		for (const child of children) child.finish();
		if (withheld) await fs.rename(withheld.temporary, withheld.original);
		for (const child of children.reverse()) {
			await child.session.abort();
			await child.session.dispose();
			await child.manager.close();
		}
	}
}
