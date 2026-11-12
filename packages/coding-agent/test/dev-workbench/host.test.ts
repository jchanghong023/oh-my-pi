import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { requireGit } from "@oh-my-pi/pi-natives/vcs";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import {
	createDevGoalController,
	createDevWorkbenchHost,
	getOrStartDevWorkbench,
	type DevWorkbenchHost,
} from "../../src/dev-workbench/host";
import {
	bindDevNativeSurface,
	devNativeSurfaceSnapshot,
	nativeWebGuiQuestions,
	releaseDevNativeSurface,
	subscribeDevNativeSurface,
	updateDevNativeSurfaceEditor,
	withNativeWebGuiInteractionScope,
} from "../../src/dev-workbench/native/native-interactions";
import { nativeChatRuntimeForSession } from "../../src/dev-workbench/native/native-chat";
import { resolveNativeFileContexts } from "../../src/dev-workbench/native/native-attachments";
import { devNativePredictionAction } from "../../src/dev-workbench/native/native-predictions";
import type {
	DevNativePredictionSnapshot,
	DevNativeSurfaceTarget,
} from "../../src/dev-workbench/native/native-surface-types";
import { cfgComposerPredictionAlternatives, cfgComposerPredictions } from "../../src/modes/settings";
import {
	executeWebGuiSessionCommand,
	nativeWebGuiSessionCommands,
	resolveWebGuiSession,
} from "../../src/dev-workbench/native/native-session-host";
import { loadSkillPromptBody } from "../../src/extensibility/skills";
import { cfgGoalContinuationModes } from "../../src/goals/settings";
import { RpcGoalController } from "../../src/modes/rpc/rpc-goal";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../../src/session/messages";
import { cfgTeamMembers } from "../../src/team/settings";
import { TEAM_RESULT_MESSAGE_TYPE } from "../../src/team/controller";
import { TEAM_READ_ONLY_TOOLS } from "../../src/team/runner";
import { bindSpecSkillPolicy, checkSkillReadAccess } from "../../src/spec-driven/skill-policy";
import { contentText, createProviderFixture, type ModelRequest, type Reply } from "../spec-driven/provider-fixture";
import { MCPManager, type MCPAuthHandler } from "../../src/mcp/manager";
import { eventually, registeredFixtureProject } from "./fixture";

interface NativeHostFixture {
	host: DevWorkbenchHost;
	projectId: string;
}

async function fixture(
	options: {
		delay?: () => Promise<void>;
		authMode?: "session-ui" | "programmatic";
		skillCommands?: boolean;
		reply?: (request: ModelRequest) => Reply;
	} = {},
) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workbench-host-"));
	const agentDir = path.join(cwd, "agent");
	await fs.mkdir(agentDir);
	for (const directory of ["objects", "refs/heads"])
		await fs.mkdir(path.join(cwd, ".git", directory), { recursive: true });
	await fs.writeFile(path.join(cwd, ".git/HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(
		path.join(cwd, ".git/config"),
		"[core]\nrepositoryformatversion = 0\nbare = false\nautocrlf = false\n[user]\nname = Workbench Test\nemail = workbench@example.invalid\n",
	);
	await fs.writeFile(path.join(cwd, "baseline.txt"), "untouched\n");
	const repo = requireGit(cwd);
	await repo.stageFiles(["baseline.txt"]);
	await repo.commitCreate("fixture", {});
	const provider = createProviderFixture({
		reply: async request => {
			await options.delay?.();
			return options.reply?.(request) ?? { text: "Native response" };
		},
	});
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  deepseek:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        input: [text, image]\n        contextWindow: 1000000\n`,
	);
	const settings = await Settings.loadIsolated({
		cwd,
		agentDir,
		inMemory: true,
		overrides: {
			modelRoles: { default: "deepseek/chat-a", smol: "deepseek/chat-a" },
			"compaction.enabled": false,
			"prewalk.enabled": false,
			"tools.xdev": false,
			"async.enabled": false,
			"mcp.startupTimeoutMs": 0,
			"composer.predictions": false,
			...(options.skillCommands === undefined ? {} : { "skills.enableSkillCommands": options.skillCommands }),
		},
	});
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	const model = registry.find("deepseek", "chat-a");
	if (!model) throw new Error("Isolated provider model unavailable");
	let ordinaryAuthCalls = 0;
	const sourceMcp = options.authMode
		? new MCPManager(cwd, null, async () => ({ configs: {}, exaApiKeys: [], sources: {} }))
		: undefined;
	const ordinaryAuthHandler: MCPAuthHandler = async () => {
		ordinaryAuthCalls++;
		throw new Error("The ordinary authentication callback must not handle Dev UI");
	};
	if (sourceMcp) {
		sourceMcp.setAuthStorage(authStorage);
		sourceMcp.setAuthHandler(ordinaryAuthHandler);
	}
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settings,
		model,
		authStorage,
		modelRegistry: registry,
		sessionManager: SessionManager.inMemory(cwd),
		contextFiles: [],
		rules: [],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		disableExtensionDiscovery: true,
		enableMCP: !!sourceMcp,
		mcpManager: sourceMcp,
		enableLsp: false,
		autoTitle: false,
		offline: true,
		bindProcessState: false,
	});
	const host = await createDevWorkbenchHost({
		session,
		settings,
		cwd,
		mcpManager: sourceMcp,
		nativeMcpUiAuthHandler: options.authMode === "session-ui" ? ordinaryAuthHandler : undefined,
	});
	const project = await registeredFixtureProject((await host.workflow.view()).projects, cwd);
	return {
		cwd,
		agentDir,
		host,
		projectId: project.id,
		session,
		settings,
		provider,
		sourceMcp,
		ordinaryAuthHandler,
		ordinaryAuthCalls: () => ordinaryAuthCalls,
		async [Symbol.asyncDispose]() {
			await host.close();
			await session.dispose();
			await registry.awaitBackgroundRefresh();
			await sourceMcp?.disconnectAll();
			authStorage.close();
			await provider[Symbol.asyncDispose]();
			await fs.rm(cwd, { recursive: true, force: true });
		},
	};
}

async function draft(f: NativeHostFixture, browserId = "browser-a") {
	const projectId = f.projectId;
	await f.host.workflow.bind(browserId, { projectId });
	let view = await f.host.workflow.view(projectId);
	await f.host.workflow.command(browserId, {
		type: "createRelease",
		projectId,
		title: "Native host acceptance",
		operationId: crypto.randomUUID(),
		expectedRevision: view.revision,
	});
	view = await f.host.workflow.view(projectId);
	const releaseId = view.releases.at(-1)?.id;
	if (!releaseId) throw new Error("Release missing");
	const created = await f.host.workflow.command(browserId, {
		type: "createBrowserDraft",
		projectId,
		releaseId,
		operationId: crypto.randomUUID(),
		expectedRevision: view.revision,
	});
	if (!created.irId) throw new Error("IR missing");
	const ref = { projectId, irId: created.irId };
	await f.host.workflow.bind(browserId, ref);
	return ref;
}

async function conversation(f: NativeHostFixture) {
	const ref = await draft(f);
	const native = await f.host.workflow.prepare("browser-a", ref);
	const project = await f.host.workflow.project(ref.projectId);
	const session = project.runtime.session(native);
	const context = await f.host.workflow.nativeContext("browser-a", ref.projectId);
	return { ref, native, session, context, runtime: project.runtime };
}

describe("native workflow host", () => {
	test("selected workflow exposes the native workspace and exact session binding rejects a foreign round", async () => {
		await using f = await fixture();
		const { ref, native, session } = await conversation(f);
		const before = await f.host.workflow.view(ref.projectId);
		const selected = await f.host.workflow.view(ref.projectId, ref);
		expect(selected.workspace?.path).toBe(session.sessionManager.getCwd());
		expect(JSON.parse(selected.workspace!.identity)).toEqual(ref);
		await f.host.workflow.bind("exact-session-page", {
			...ref,
			sessionId: native.sessionId,
			round: native.round,
		});
		const binding = f.host.workflow.binding("exact-session-page");
		const metadata = await f.host.workflow.workspace("exact-session-page", ref.projectId);
		expect(metadata.session?.sessionId).toBe(native.sessionId);
		expect(metadata.cwd).toBe(selected.workspace!.path);
		await expect(
			f.host.workflow.bind("exact-session-page", {
				...ref,
				sessionId: native.sessionId,
				round: native.round + 1,
			}),
		).rejects.toThrow("session/round");
		expect(f.host.workflow.binding("exact-session-page")).toEqual(binding);
		await expect(
			f.host.workflow.bind("exact-session-page", { ...ref, sessionId: "foreign-session", round: native.round }),
		).rejects.toThrow("session/round");
		expect((await f.host.workflow.view(ref.projectId)).revision).toBe(before.revision);
		expect(f.provider.requests).toHaveLength(0);
	}, 120_000);

	test("canonical opening reuses listener and root, isolates settings, and read-only selection creates no actor", async () => {
		await using f = await fixture();
		const reopened = await createDevWorkbenchHost({
			session: f.session,
			settings: f.settings,
			cwd: path.join(f.cwd, "."),
		});
		expect(reopened.cwd).toBe(f.host.cwd);
		const unselected = await reopened.workflow.view();
		expect(unselected.currentProjectId).toBeUndefined();
		expect(unselected.sessions).toEqual([]);
		expect(reopened.workflow.binding("browser-a")).toBeUndefined();
		const ordinaryMembers = cfgTeamMembers.get(f.settings);
		cfgTeamMembers.set(f.host.settings, ["dev-only/model"]);
		expect(cfgTeamMembers.get(f.host.settings)).toEqual(["dev-only/model"]);
		expect(cfgTeamMembers.get(f.settings)).toEqual(ordinaryMembers);
		const options = {
			offline: false,
			asset: async (assetPath: string) =>
				assetPath === "/"
					? {
							bytes: new TextEncoder().encode("<!doctype html><title>Native host reuse</title>"),
							contentType: "text/html; charset=utf-8",
						}
					: null,
		};
		const [first, second] = await Promise.all([
			getOrStartDevWorkbench(f.host, options),
			getOrStartDevWorkbench(reopened, options),
		]);
		expect(first.loopbackUrl).toBe(second.loopbackUrl);
		expect((await fetch(first.loopbackUrl)).status).toBe(200);
		const ref = await draft(f);
		const before = await f.host.workflow.view(ref.projectId);
		const beforeRequests = f.provider.requests.length;
		await f.host.workflow.bind("browser-b", ref);
		const after = await f.host.workflow.view(ref.projectId);
		expect(after.revision).toBe(before.revision);
		expect(after.sessions).toEqual(before.sessions);
		expect(after.running).toEqual(before.running);
		expect(f.provider.requests).toHaveLength(beforeRequests);
		expect(f.host.rootSession).toBe(f.session);
		expect(f.session.messages).toEqual([]);
	}, 120_000);

	test("native model selector answers once without changing the ordinary root or running a model", async () => {
		await using f = await fixture();
		const { session } = await conversation(f);
		const rootModel = f.session.model;
		const broker = nativeWebGuiQuestions(session);
		const origin = { connectionId: "model-picker", clientId: "browser-a", sessionId: session.sessionId };
		const selecting = executeWebGuiSessionCommand(session, "/model", origin);
		const request = await eventually(async () => broker.pendingInteractions[0], Boolean);
		if (!request || request.payload.kind !== "userInput") throw new Error("Native model selector missing");
		const option = request.payload.options?.find(item => item.label.includes("chat-a"));
		if (!option) throw new Error("Configured native model was not offered");
		await broker.resolveInteraction(request.interactionId, { optionId: option.optionId }, origin);
		await selecting;
		await expect(
			broker.resolveInteraction(request.interactionId, { optionId: option.optionId }, origin),
		).rejects.toThrow();
		expect(session.model?.id).toBe("chat-a");
		expect(f.session.model).toBe(rootModel);
		expect(f.session.messages).toEqual([]);
		expect(f.provider.requests).toEqual([]);
	}, 120_000);

	test("native skill input retains user attribution and queued identity while phase policy denies unauthorized expansion", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await using f = await fixture({
			skillCommands: true,
			delay: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		const { ref, native, session, context } = await conversation(f);
		const skill = session.skills.find(item => item.name === "jch-grill-me");
		if (!skill) throw new Error("Native requirements skill catalogue missing");
		const access = { scope: session.sessionManager, getSessionBranch: () => session.sessionManager.getBranch() };
		const chat = nativeChatRuntimeForSession(session);
		const inputId = crypto.randomUUID();
		const text = "/skill:jch-grill-me NATIVE_SKILL_PROBE";
		try {
			const body = await loadSkillPromptBody(skill, access);
			expect(await chat.submit(context, session.sessionId, text, inputId, "browser-a", inputId)).toBe("startNow");
			expect(await nativeWebGuiSessionCommands(session)).toContainEqual(
				expect.objectContaining({ name: "skill:jch-grill-me" }),
			);
			await entered.promise;
			const activation = session.messages.find(
				item => item.role === "custom" && item.customType === SKILL_PROMPT_MESSAGE_TYPE,
			);
			expect(activation).toMatchObject({
				role: "custom",
				inputId,
				inputClientId: "browser-a",
				sourceCommand: { sessionId: session.sessionId, commandId: inputId },
				display: true,
				attribution: "user",
				details: { name: skill.name, path: skill.filePath, args: "NATIVE_SKILL_PROBE", prompt: text },
			});
			expect(f.provider.requests[0]?.messages.map(message => contentText(message.content)).join("\n")).toContain(
				body,
			);
			expect(() => checkSkillReadAccess(skill, access)).not.toThrow();
			expect(() => checkSkillReadAccess(skill, { scope: f.session.sessionManager })).toThrow();
			await f.host.workflow.bind("browser-b", ref);
			const foreign = await f.host.workflow.nativeContext("browser-b", ref.projectId);
			await expect(
				chat.submit(foreign, session.sessionId, "MUST_NOT_QUEUE_FOREIGN_BROWSER", crypto.randomUUID(), "browser-b"),
			).rejects.toThrow("Only the admitted native input's browser");
			await expect(
				withNativeWebGuiInteractionScope(
					{ connectionId: context.connectionId, clientId: "browser-a", sessionId: crypto.randomUUID() },
					() =>
						f.host.workflow.runNativeInput(session, () =>
							session.prompt("MUST_NOT_QUEUE_FOREIGN_SESSION", { streamingBehavior: "followUp" }),
						),
				),
			).rejects.toThrow("exact originating browser session");
			const held = await f.host.workflow.view(ref.projectId);
			await expect(
				f.host.workflow.submit("browser-a", {
					...ref,
					sessionId: native.sessionId,
					round: native.round,
					operationId: crypto.randomUUID(),
					expectedRevision: held.revision,
					text: "MUST_NOT_START_ANOTHER_FORMAL_INPUT",
				}),
			).rejects.toThrow("durable native input already owns this project");
			expect((await f.host.workflow.view(ref.projectId)).operations).toEqual(held.operations);
			expect(session.getQueuedInputMessages()).toEqual([]);
			const queuedId = crypto.randomUUID();
			expect(
				await chat.submit(
					context,
					session.sessionId,
					"/skill:jch-grill-me queued arguments",
					queuedId,
					"browser-a",
					queuedId,
				),
			).toBe("queue");
			expect(session.getQueuedInputMessages()).toContainEqual(
				expect.objectContaining({
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					inputId: queuedId,
					inputClientId: "browser-a",
					attribution: "user",
					sourceCommand: expect.objectContaining({ sessionId: session.sessionId, commandId: queuedId }),
					details: expect.objectContaining({ args: "queued arguments" }),
				}),
			);
			expect((await chat.snapshot(context, session.sessionId, "browser-a")).queue.items).toContainEqual(
				expect.objectContaining({
					queueItemId: queuedId,
					sourceCommandId: queuedId,
					clientId: "browser-a",
					text: "/skill:jch-grill-me queued arguments",
					dispatch: { state: "queued" },
				}),
			);
			expect(session.mutateQueuedInput(queuedId, "delete")).toBe(true);
			expect((await chat.snapshot(context, session.sessionId, "browser-a")).queue.items).toEqual([]);
			release.resolve();
			await session.waitForIdle();
			const beforeDenied = JSON.stringify(session.messages);
			await expect(
				chat.submit(
					context,
					session.sessionId,
					"/skill:foreign-unregistered denied",
					crypto.randomUUID(),
					"browser-a",
				),
			).rejects.toThrow("Unknown native command: /skill:foreign-unregistered");
			expect(f.provider.requests).toHaveLength(1);
			const unbind = bindSpecSkillPolicy(session.sessionManager, { phase: "blocked probe", allowedSkills: [] });
			try {
				await expect(
					chat.submit(context, session.sessionId, text, crypto.randomUUID(), "browser-a"),
				).rejects.toThrow("not allowed during blocked probe");
			} finally {
				unbind();
			}
			expect(f.provider.requests).toHaveLength(1);
			expect(JSON.stringify(session.messages)).toEqual(beforeDenied);
			expect(f.session.messages).toEqual([]);
		} finally {
			release.resolve();
		}
	}, 120_000);

	test("native queued text and Skill edits replace image references rather than appending old bytes", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await using f = await fixture({
			skillCommands: true,
			delay: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		const { session, context } = await conversation(f);
		const chat = nativeChatRuntimeForSession(session);
		const cwd = session.sessionManager.getCwd();
		await fs.writeFile(
			path.join(cwd, "a.png"),
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		await fs.writeFile(
			path.join(cwd, "b.png"),
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=",
				"base64",
			),
		);
		try {
			await chat.submit(context, session.sessionId, "hold the native run", crypto.randomUUID(), "browser-a");
			await entered.promise;
			const a = (await resolveNativeFileContexts(context, "@a.png", session.sessionId)).images;
			const b = (await resolveNativeFileContexts(context, "@b.png", session.sessionId)).images;
			expect(a).toHaveLength(1);
			expect(b).toHaveLength(1);
			expect(a[0]!.data).not.toBe(b[0]!.data);
			for (const prefix of ["queued text", "/skill:jch-grill-me queued arguments"]) {
				const inputId = crypto.randomUUID();
				expect(await chat.submit(context, session.sessionId, prefix, inputId, "browser-a")).toBe("queue");
				const queued = () =>
					session.getQueuedInputMessages().find(message => "inputId" in message && message.inputId === inputId)!;
				const images = () => {
					const message = queued();
					return "content" in message && Array.isArray(message.content)
						? message.content.filter(part => part.type === "image")
						: [];
				};
				await chat.editQueued(context, inputId, `${prefix} @a.png`);
				expect(images()).toEqual(a);
				await chat.editQueued(context, inputId, `${prefix} @b.png`);
				expect(images()).toEqual(b);
				await chat.editQueued(context, inputId, prefix);
				expect(images()).toEqual([]);
				expect(queued()).toMatchObject({ inputId, attachments: [], inputClientId: "browser-a" });
				if (prefix.startsWith("/skill:"))
					expect(queued()).toMatchObject({
						role: "custom",
						customType: SKILL_PROMPT_MESSAGE_TYPE,
						attribution: "user",
						details: { prompt: prefix, args: "queued arguments" },
					});
				expect(session.mutateQueuedInput(inputId, "delete")).toBe(true);
			}
			release.resolve();
			await session.waitForIdle();
		} finally {
			release.resolve();
		}
	}, 120_000);

	test("disabled native skill commands cannot expand instructions or issue a provider request", async () => {
		await using f = await fixture({ skillCommands: false });
		const { session, context } = await conversation(f);
		await expect(
			nativeChatRuntimeForSession(session).submit(
				context,
				session.sessionId,
				"/skill:jch-grill-me disabled",
				crypto.randomUUID(),
				"browser-a",
			),
		).rejects.toThrow();
		expect(
			session.messages.some(
				message => message.role === "custom" && message.customType === SKILL_PROMPT_MESSAGE_TYPE,
			),
		).toBe(false);
		expect(f.provider.requests).toEqual([]);
	}, 120_000);

	test("input receipts complete reusable native turns once and reject foreign browsers, revisions, rounds and stale bindings", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await using f = await fixture({
			delay: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		const { ref, native, session, context } = await conversation(f);
		const view = await f.host.workflow.view(ref.projectId);
		const beforeMessages = structuredClone(session.messages);
		const input = {
			...ref,
			sessionId: native.sessionId,
			round: native.round,
			expectedRevision: view.revision,
			operationId: crypto.randomUUID(),
			text: "NATIVE_SINGLE_RECEIPT",
		};
		try {
			await expect(f.host.workflow.submit("browser-b", input)).rejects.toThrow();
			await expect(f.host.workflow.submit("browser-a", { ...input, round: native.round + 1 })).rejects.toThrow();
			await expect(
				f.host.workflow.submit("browser-a", { ...input, expectedRevision: view.revision - 1 }),
			).rejects.toThrow();
			expect(f.provider.requests).toEqual([]);
			expect(session.messages).toEqual(beforeMessages);
			await f.host.workflow.submit("browser-a", input);
			await entered.promise;
			const chat = nativeChatRuntimeForSession(session);
			// No browser stream is attached: the owning session must still keep its
			// projection current across a real running-to-idle transition.
			const running = await chat.snapshot(context, native.sessionId, "browser-a");
			expect(running.control.phase).toBe("running");
			release.resolve();
			await session.waitForIdle();
			await eventually(
				() => f.host.workflow.view(ref.projectId),
				current =>
					current.operations.some(
						operation => operation.operationId === input.operationId && operation.status === "completed",
					) && current.running.length === 0,
				5_000,
			);
			// The input receipt and native turn complete; the borrowed conversation
			// remains reusable. Session termination is not a turn-completion guard.
			const completed = await chat.snapshot(context, native.sessionId, "browser-a");
			expect(completed.control).toMatchObject({
				phase: "completedSuccess",
				canStop: false,
				stopState: "idle",
				activeWorks: [],
				lastError: null,
			});
			expect(completed.revision).toBeGreaterThan(running.revision);
			expect(completed.inputRouting.mode).toBe("startNow");
			expect(completed.queue.items).toEqual([]);
			expect(session.isStreaming).toBe(false);
			expect(session.isDisposed).toBe(false);
			expect(f.provider.requests).toHaveLength(1);
			const messages = JSON.stringify(session.messages);
			expect(
				session.messages.filter(
					message => message.role === "user" && contentText(message.content).includes(input.text),
				),
			).toHaveLength(1);
			expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(1);
			expect(contentText(session.messages.findLast(message => message.role === "assistant")?.content)).toContain(
				"Native response",
			);
			expect(await f.host.workflow.submit("browser-a", input)).toMatchObject({
				operationId: input.operationId,
				status: "completed",
			});
			expect(JSON.stringify(session.messages)).toEqual(messages);
			expect(f.provider.requests).toHaveLength(1);
			await expect(f.host.workflow.submit("browser-a", { ...input, text: "MUST_NOT_REPLAY" })).rejects.toThrow();
			expect(JSON.stringify(session.messages)).toEqual(messages);
			await f.host.workflow.bind("browser-b", ref);
			await expect(f.host.workflow.submit("browser-b", input)).rejects.toThrow();
			const other = await draft(f);
			expect(other.irId).not.toBe(ref.irId);
			expect(() => f.host.workflow.assertNativeContext(context, native.sessionId)).toThrow();
			await expect(resolveWebGuiSession(context, native.sessionId)).rejects.toThrow();
			expect(JSON.stringify(session.messages)).toEqual(messages);
			expect(f.provider.requests).toHaveLength(1);
		} finally {
			release.resolve();
		}
	}, 120_000);

	test("detaching an observer does not own native work; reconnect reads native history without replay", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await using f = await fixture({
			delay: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		const { ref, session, context } = await conversation(f);
		const frames: object[] = [];
		const detach = f.host.workflow.observe(frame => frames.push(frame));
		try {
			const view = await f.host.workflow.view(ref.projectId);
			await f.host.workflow.submit("browser-a", {
				...ref,
				expectedRevision: view.revision,
				operationId: crypto.randomUUID(),
				text: "One admitted turn",
			});
			await entered.promise;
			detach();
			expect(session.isStreaming).toBe(true);
			release.resolve();
			await session.waitForIdle();
			const snapshot = await nativeChatRuntimeForSession(session).snapshot(context, session.sessionId, "browser-a");
			expect(snapshot.rows.totalCount).toBeGreaterThan(0);
			expect(frames.length).toBeGreaterThan(0);
			expect(f.provider.requests).toHaveLength(1);
			expect(f.session.messages).toEqual([]);
		} finally {
			release.resolve();
			detach();
		}
	}, 120_000);

	test("host shutdown cancels pending native permission and settles work without deleting the draft or borrowed root", async () => {
		await using f = await fixture();
		const { ref, session } = await conversation(f);
		const broker = nativeWebGuiQuestions(session);
		const pending = broker.ui.confirm("Pending permission", "Never implicitly approve on exit").then(
			value => ({ value }),
			error => ({ error }),
		);
		expect(broker.pendingInteractions).toHaveLength(1);
		await f.host.close();
		expect(await pending).toHaveProperty("error");
		expect(session.isStreaming).toBe(false);
		expect(f.session.isDisposed).toBe(false);
		expect((await f.host.workflow.store.view(ref.projectId)).drafts.some(item => item.id === ref.irId)).toBe(true);
		expect(f.provider.requests).toEqual([]);
	}, 120_000);

	test("native Team dispatch runs real read-only descendants and persists its report in the selected workflow session", async () => {
		const seen = new Set<string>();
		const readonlyTools = new Set([...TEAM_READ_ONLY_TOOLS, "yield"]);
		await using f = await fixture({
			reply(request) {
				const task = request.messages
					.filter(message => message.role === "user")
					.map(message => contentText(message.content))
					.findLast(text => text.includes("[team-stage:"));
				const stage = task?.match(/\[team-stage:([^\]]+)\]/u)?.[1];
				if (!stage) throw new Error("Only actual native Team descendants are expected");
				// Native title/final-prose turns may omit tools altogether. Only actual
				// advertisements authorize tool calls; do not invent a schema for them.
				if (!request.tools?.length) return { text: "Preserve baseline bytes" };
				for (const tool of request.tools) {
					expect(readonlyTools.has(tool.function?.name.replace(/^_/u, "") ?? "")).toBe(true);
				}
				const advertised = (name: string) => {
					const actual = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === name)?.function
						?.name;
					if (!actual) throw new Error(`Team descendant lacks ${name}`);
					return actual;
				};
				const results = request.messages
					.filter(message => message.role === "tool")
					.map(message => contentText(message.content));
				if (!results.length)
					return { tool: { name: advertised("read"), args: { path: path.join(f.cwd, "baseline.txt") } } };
				expect(results.join("\n")).toContain("untouched");
				seen.add(stage.split(/\s|:/u)[0]!);
				let data: Record<string, unknown>;
				if (stage.startsWith("proposal"))
					data = {
						proposal: "Preserve the observed user bytes.",
						noViableProposal: false,
						investigationBlockedReason: "",
						keyAssumptions: [],
						risks: [],
						unknowns: [],
						acceptanceCriteria: ["Preserve baseline.txt"],
						ambiguityInterpretations: [],
						evidence: [{ claim: "Actual baseline bytes read", source: "baseline.txt:1" }],
					};
				else if (stage.startsWith("alignment"))
					data = {
						unifiedUnderstanding: "Preserve observed user bytes.",
						acceptanceCriteria: ["Preserve baseline.txt"],
						factDifferences: [],
						interpretationDifferences: [],
					};
				else if (stage.startsWith("review"))
					data = {
						noSubstantiveIssues: true,
						reviewSummary: "Read current baseline and preserve it.",
						findings: [],
						blockingResolutions: [],
					};
				else if (stage.startsWith("revision"))
					data = {
						revisedProposal: "Preserve observed user bytes.",
						revisionSummary: "No substantive change required.",
						responses: [],
						reviewFlags: {
							changedCoreDesign: false,
							claimsResolvedBlocking: false,
							newEvidenceChangesAssumptions: false,
							disputesBlockingFinding: false,
						},
					};
				else if (stage.startsWith("synthesis"))
					data = {
						reportMarkdown: "## Evidence\nThe actual baseline.txt contains untouched. Preserve these bytes.",
						recommendedProposal: "A",
						recommendationReason: "Preserves observed user bytes",
						recommendationPreconditions: "Keep baseline.txt",
						hardConstraintViolations: [],
					};
				else throw new Error(`Unexpected Team stage ${stage}`);
				return { tool: { name: advertised("yield"), args: { data } } };
			},
		});
		const { ref, native, session } = await conversation(f);
		cfgTeamMembers.set(session.settings, ["deepseek/chat-a"]);
		expect((await nativeWebGuiSessionCommands(session)).some(command => command.name === "team")).toBe(true);
		expect(
			await executeWebGuiSessionCommand(
				session,
				"/team Read the existing baseline and discuss preserving its bytes; do not modify any material or approve the workflow",
				{ connectionId: "team-browser", clientId: "browser-a", sessionId: native.sessionId },
			),
		).toBe(true);
		const report = await eventually(
			async () =>
				session.messages.find(
					message => message.role === "custom" && message.customType === TEAM_RESULT_MESSAGE_TYPE,
				),
			Boolean,
		);
		expect(report).toMatchObject({ role: "custom", attribution: "agent", display: true });
		expect(contentText(report && "content" in report ? report.content : undefined)).toContain("baseline.txt");
		expect([...seen].some(stage => stage.startsWith("proposal"))).toBe(true);
		expect([...seen].some(stage => stage.startsWith("synthesis"))).toBe(true);
		expect(f.provider.requests.length).toBeGreaterThan(0);
		expect(f.provider.failures).toEqual([]);
		expect(await fs.readFile(path.join(f.cwd, "baseline.txt"), "utf8")).toBe("untouched\n");
		expect(session.sessionId).toBe(native.sessionId);
		expect(
			(await f.host.workflow.view(ref.projectId)).drafts.find(item => item.id === ref.irId)?.confirmation,
		).toBeUndefined();
		expect(f.session.messages).toEqual([]);
	}, 180_000);

	test("failed native settlement retains exclusive ownership, root and MCP binding until explicit exit retry succeeds", async () => {
		await using f = await fixture({ authMode: "session-ui" });
		const { ref, runtime } = await conversation(f);
		const dispose = runtime.dispose.bind(runtime);
		const manager = f.sourceMcp!;
		let blocked = true;
		runtime.dispose = async () => {
			if (blocked) throw new Error("Native descendant settlement remains blocked");
			await dispose();
		};
		try {
			await expect(f.host.close()).rejects.toThrow();
			expect(f.host.stopping).toBe(true);
			expect(f.session.isDisposed).toBe(false);
			expect(manager.getAuthHandler()).not.toBe(f.ordinaryAuthHandler);
			await expect(
				f.host.workflow.command("browser-a", {
					type: "createRelease",
					projectId: ref.projectId,
					title: "must remain blocked",
					operationId: crypto.randomUUID(),
					expectedRevision: (await f.host.workflow.store.view(ref.projectId)).revision,
				}),
			).rejects.toThrow();
			await expect(
				createDevWorkbenchHost({ session: f.session, settings: f.settings, cwd: f.cwd }),
			).rejects.toThrow();
			blocked = false;
			await f.host.close();
			expect(manager.getAuthHandler()).toBe(f.ordinaryAuthHandler);
			expect(f.session.isDisposed).toBe(false);
			const resumed = await createDevWorkbenchHost({ session: f.session, settings: f.settings, cwd: f.cwd });
			try {
				const view = await resumed.workflow.view(ref.projectId);
				expect(view.drafts.some(item => item.id === ref.irId)).toBe(true);
				expect(view.running).toEqual([]);
				expect(f.provider.requests).toEqual([]);
			} finally {
				await resumed.close();
			}
		} finally {
			blocked = false;
			runtime.dispose = dispose;
		}
	}, 120_000);

	test("exclusive Dev restores the exact interactive MCP callback and leaves explicit programmatic auth unchanged", async () => {
		for (const authMode of ["session-ui", "programmatic"] as const) {
			await using f = await fixture({ authMode });
			const manager = f.sourceMcp;
			if (!manager) throw new Error("Native MCP manager missing");
			expect(f.host.rootSession.nativeChildCapabilities?.mcpManager).toBe(manager);
			if (authMode === "programmatic") expect(manager.getAuthHandler()).toBe(f.ordinaryAuthHandler);
			else expect(manager.getAuthHandler()).not.toBe(f.ordinaryAuthHandler);
			expect(f.ordinaryAuthCalls()).toBe(0);
			await f.host.close();
			expect(manager.getAuthHandler()).toBe(f.ordinaryAuthHandler);
			expect(f.session.isDisposed).toBe(false);
			expect(f.provider.requests).toEqual([]);
		}
	}, 120_000);
});

test("native RPC default and Dev interactive Goal retain independent continuation policies", async () => {
	await using ordinary = await fixture();
	cfgGoalContinuationModes.set(ordinary.settings, ["interactive"]);
	const rpc = new RpcGoalController(ordinary.session);
	const detachRpc = ordinary.session.subscribe(event => rpc.observe(event));
	try {
		await rpc.handle({ op: "create", objective: "Do not start a model under disabled RPC continuation" });
		expect(rpc.continuationPending).toBe(false);
		expect(ordinary.provider.requests).toEqual([]);
		expect(cfgGoalContinuationModes.get(ordinary.settings)).toEqual(["interactive"]);
	} finally {
		rpc.stopForHostAbort();
		await rpc.handle({ op: "pause" });
		detachRpc();
	}
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	await using workbench = await fixture({
		delay: async () => {
			entered.resolve();
			await release.promise;
		},
	});
	cfgGoalContinuationModes.set(workbench.settings, ["interactive"]);
	const interactive = createDevGoalController(workbench.session);
	const detach = workbench.session.subscribe(event => interactive.observe(event));
	try {
		await interactive.handle({ op: "create", objective: "Execute one explicitly authorized continuation" });
		expect(interactive.continuationPending).toBe(true);
		await entered.promise;
		interactive.stopForHostAbort();
		release.resolve();
		await workbench.session.waitForIdle();
		expect(workbench.provider.requests).toHaveLength(1);
		expect(cfgGoalContinuationModes.get(workbench.settings)).toEqual(["interactive"]);
	} finally {
		interactive.stopForHostAbort();
		release.resolve();
		await workbench.session.abort();
		await interactive.handle({ op: "pause" });
		detach();
	}
}, 120_000);

describe("native session interaction broker", () => {
	test("first exact response wins; another native session and a denied permission never gain authority", async () => {
		await using f = await fixture();
		const { session } = await conversation(f);
		const broker = nativeWebGuiQuestions(session);
		const selected = broker.ui.select("Pick", ["One", "Two"]);
		const request = broker.pendingInteractions[0]!;
		await expect(
			nativeWebGuiQuestions(f.session).resolveInteraction(request.interactionId, { optionId: "0" }),
		).rejects.toThrow();
		await expect(broker.resolveInteraction(request.interactionId, { optionId: "9" })).rejects.toThrow();
		expect(broker.pendingInteractions).toHaveLength(1);
		await broker.resolveInteraction(request.interactionId, { optionId: "0" });
		expect(await selected).toBe("One");
		await expect(broker.resolveInteraction(request.interactionId, { optionId: "1" })).rejects.toThrow();
		const approval = broker.ui.approve!({ compact: "Sensitive tool", full: "Exact path and arguments" });
		const pending = broker.pendingInteractions[0]!;
		if (pending.payload.kind !== "userInput") throw new Error("Native approval missing");
		const deny = pending.payload.options?.find(option => option.label === "Deny");
		if (!deny) throw new Error("Deny option missing");
		await broker.resolveInteraction(pending.interactionId, { optionId: deny.optionId });
		expect(await approval).toBe("deny");
		expect(f.provider.requests).toEqual([]);
	}, 120_000);

	test("abort ends native waits, observer detachment does not; rich ask returns the actual human selections", async () => {
		await using f = await fixture();
		const { session } = await conversation(f);
		const broker = nativeWebGuiQuestions(session);
		const abort = new AbortController();
		const editor = broker.ui.editor("Native editor", "original", { signal: abort.signal });
		broker.subscribe(() => {})();
		expect(broker.pendingInteractions).toHaveLength(1);
		abort.abort();
		await expect(editor).rejects.toThrow();
		const ask = broker.ui.askDialog!([
			{ id: "q", question: "Choice?", multi: true, options: [{ label: "A" }, { label: "B" }] },
		]);
		const request = broker.pendingInteractions[0]!;
		await broker.resolveInteraction(request.interactionId, { content: { answer_0: ["A", "B", "human detail"] } });
		expect(await ask).toEqual({
			kind: "submit",
			results: [
				{
					id: "q",
					question: "Choice?",
					options: ["A", "B"],
					multi: true,
					selectedOptions: ["A", "B"],
					customInput: "human detail",
				},
			],
		});
	}, 120_000);

	test("browser-origin requests cannot be answered by another connection or replayed after its close", async () => {
		await using f = await fixture();
		const { session } = await conversation(f);
		const broker = nativeWebGuiQuestions(session);
		const origin = { connectionId: "browser-connection-a", clientId: "browser-a", sessionId: session.sessionId };
		const action = withNativeWebGuiInteractionScope(origin, () =>
			broker.browserAction({ action: "openUrl", url: "https://example.invalid/" }),
		);
		const request = broker.pendingInteractions[0]!;
		await expect(
			broker.resolveInteraction(request.interactionId, { action: "accept" }, { ...origin, connectionId: "foreign" }),
		).rejects.toThrow();
		expect(broker.pendingInteractionsFor({ ...origin, connectionId: "foreign" })).toEqual([]);
		broker.cancelConnectionActions(origin.connectionId);
		await expect(action).rejects.toThrow();
		await expect(broker.resolveInteraction(request.interactionId, { action: "accept" }, origin)).rejects.toThrow();
	}, 120_000);
});

describe("native shared composer surface", () => {
	async function surface(f: NativeHostFixture) {
		const h = await conversation(f);
		const target: DevNativeSurfaceTarget = {
			...h.ref,
			sessionId: h.native.sessionId,
			phase: h.native.phase,
			round: h.native.round,
			clientId: "page-a",
		};
		bindDevNativeSurface(h.session, target, () => target);
		return { ...h, target };
	}

	test("one native side turn supplies all browsers and persists prediction usage without browser-triggered requests", async () => {
		await using f = await fixture({ reply: () => ({ text: "run the tests\nshow the diff" }) });
		const h = await surface(f);
		cfgComposerPredictions.set(h.session.settings, true);
		cfgComposerPredictionAlternatives.set(h.session.settings, true);
		const second = { ...h.target, clientId: "page-b" };
		bindDevNativeSurface(h.session, second, () => second);
		const frames: DevNativePredictionSnapshot[] = [];
		const detach = subscribeDevNativeSurface(h.session, h.target, event => {
			if (event.t === "native-prediction") frames.push(event.prediction);
		});
		try {
			expect(devNativeSurfaceSnapshot(h.session, h.target).prediction.choices).toEqual([]);
			expect(devNativeSurfaceSnapshot(h.session, second).prediction.choices).toEqual([]);
			expect(f.provider.requests).toEqual([]);
			await h.runtime.submit(h.native, "fix the bug");
			const prediction = await eventually(
				async () => devNativeSurfaceSnapshot(h.session, h.target).prediction,
				value => value.choices.length === 2,
			);
			expect(prediction.choices).toEqual(["run the tests", "show the diff"]);
			expect(devNativeSurfaceSnapshot(h.session, second).prediction).toEqual({ ...prediction, target: second });
			devNativePredictionAction(h.session, h.target, { type: "shown", generation: prediction.generation });
			devNativePredictionAction(h.session, h.target, {
				type: "accepted",
				generation: prediction.generation,
				rank: 1,
			});
			expect(() =>
				devNativePredictionAction(h.session, h.target, {
					type: "accepted",
					generation: prediction.generation,
					rank: 2,
				}),
			).toThrow();
			expect(() =>
				devNativePredictionAction(
					h.session,
					{ ...h.target, round: h.target.round + 1 },
					{ type: "shown", generation: prediction.generation },
				),
			).toThrow();
			expect(frames.some(frame => frame.choices.length === 2)).toBe(true);
			expect(f.provider.requests).toHaveLength(2);
			expect(h.session.sessionManager.getEntries().filter(entry => entry.type === "model_usage")).toContainEqual(
				expect.objectContaining({ purpose: "composer-prediction" }),
			);
			expect(h.session.messages.filter(message => message.role === "assistant")).toHaveLength(1);
			expect(f.session.messages).toEqual([]);
		} finally {
			detach();
		}
	}, 120_000);

	test("a native draft skips the billed prediction request", async () => {
		await using f = await fixture();
		const h = await surface(f);
		cfgComposerPredictions.set(h.session.settings, true);
		updateDevNativeSurfaceEditor(h.session, h.target, "already drafting the next message");
		expect(nativeWebGuiQuestions(h.session).ui.getEditorText()).toBe("already drafting the next message");
		await h.runtime.submit(h.native, "fix the bug");
		await releaseDevNativeSurface(h.session);
		expect(f.provider.requests).toHaveLength(1);
		expect(
			h.session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "model_usage" && entry.purpose === "composer-prediction"),
		).toEqual([]);
	}, 120_000);

	test("host close cancels and settles its prediction without offering a held reply", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let requests = 0;
		await using f = await fixture({
			delay: async () => {
				if (++requests === 2) {
					entered.resolve();
					await release.promise;
				}
			},
			reply: () => ({ text: "held next-input suggestion" }),
		});
		const h = await surface(f);
		cfgComposerPredictions.set(h.session.settings, true);
		const offered: DevNativePredictionSnapshot[] = [];
		const detach = subscribeDevNativeSurface(h.session, h.target, event => {
			if (event.t === "native-prediction" && event.prediction.choices.length) offered.push(event.prediction);
		});
		try {
			await h.runtime.submit(h.native, "first native turn");
			await entered.promise;
			const closing = f.host.close();
			release.resolve();
			await closing;
			expect(offered).toEqual([]);
			expect(() => devNativeSurfaceSnapshot(h.session, h.target)).toThrow();
			expect(f.provider.requests).toHaveLength(2);
			expect(f.session.isDisposed).toBe(false);
		} finally {
			release.resolve();
			detach();
		}
	}, 120_000);

	test("a new native turn retires a held prediction and cannot leak it into the next draft", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let requests = 0;
		await using f = await fixture({
			delay: async () => {
				if (++requests === 2) {
					entered.resolve();
					await release.promise;
				}
			},
			reply: request => ({
				text: request.messages.some(message => contentText(message.content).includes("SECOND_NATIVE_TURN"))
					? "CURRENT_NEW_PREDICTION"
					: "STALE_HELD_PREDICTION",
			}),
		});
		const h = await surface(f);
		cfgComposerPredictions.set(h.session.settings, true);
		const offered: DevNativePredictionSnapshot[] = [];
		const detach = subscribeDevNativeSurface(h.session, h.target, event => {
			if (event.t === "native-prediction" && event.prediction.choices.length) offered.push(event.prediction);
		});
		try {
			await h.runtime.submit(h.native, "FIRST_NATIVE_TURN");
			await entered.promise;
			const old = devNativeSurfaceSnapshot(h.session, h.target).prediction;
			updateDevNativeSurfaceEditor(h.session, h.target, "new native draft");
			updateDevNativeSurfaceEditor(h.session, h.target, "");
			expect(() =>
				devNativePredictionAction(h.session, h.target, { type: "shown", generation: old.generation }),
			).toThrow();
			await h.runtime.submit(h.native, "SECOND_NATIVE_TURN");
			const current = await eventually(
				async () => devNativeSurfaceSnapshot(h.session, h.target).prediction,
				value => value.choices.includes("CURRENT_NEW_PREDICTION"),
			);
			expect(current.generation).toBeGreaterThan(old.generation);
			release.resolve();
			await releaseDevNativeSurface(h.session);
			expect(offered.some(prediction => prediction.choices.includes("STALE_HELD_PREDICTION"))).toBe(false);
			expect(offered.at(-1)?.choices).toEqual(["CURRENT_NEW_PREDICTION"]);
			expect(f.provider.requests).toHaveLength(4);
			expect(f.session.messages).toEqual([]);
		} finally {
			release.resolve();
			detach();
		}
	}, 120_000);

	test("native editor and persistent widgets rehydrate facts without replaying paste or notifications", async () => {
		await using f = await fixture();
		const h = await surface(f);
		const ui = nativeWebGuiQuestions(h.session).ui;
		updateDevNativeSurfaceEditor(h.session, h.target, "Actual browser draft Ω");
		expect(ui.getEditorText()).toBe("Actual browser draft Ω");
		ui.pasteToEditor("\nNative addition");
		ui.setStatus("work", "Native work");
		ui.setWidget("progress", ["native row"], { placement: "belowEditor" });
		ui.notify("Ephemeral notification");
		const reconnect = { ...h.target, clientId: "reconnected-page" };
		bindDevNativeSurface(h.session, reconnect, () => reconnect);
		const snapshot = devNativeSurfaceSnapshot(h.session, reconnect);
		expect(snapshot.events).toContainEqual(
			expect.objectContaining({
				t: "native-ui-state",
				target: reconnect,
				method: "setEditorText",
				value: "Actual browser draft Ω\nNative addition",
			}),
		);
		expect(snapshot.events.some(event => event.method === "pasteToEditor" || event.method === "notify")).toBe(false);
		expect(snapshot.events).toContainEqual(
			expect.objectContaining({
				target: reconnect,
				method: "setWidget",
				value: { key: "progress", content: ["native row"], options: { placement: "belowEditor" } },
			}),
		);
		expect(() =>
			updateDevNativeSurfaceEditor(h.session, { ...h.target, round: h.target.round + 1 }, "foreign round"),
		).toThrow();
		expect(ui.getEditorText()).toBe("Actual browser draft Ω\nNative addition");
		expect(f.provider.requests).toEqual([]);
	}, 120_000);
});
