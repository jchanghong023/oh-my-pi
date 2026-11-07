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
	type DevComposerPredictionFrame,
} from "../../src/dev-workbench/host";
import { createDevLocalSessionBridge } from "../../src/dev-workbench/collab";
import { DevNativeUiController } from "../../src/dev-workbench/native-ui";
import type { Skill } from "../../src/extensibility/skills";
import { cfgGoalContinuationModes } from "../../src/goals/settings";
import { RpcGoalController } from "../../src/modes/rpc/rpc-goal";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../../src/session/messages";
import { cfgTeamMembers } from "../../src/team/settings";
import type { DevSessionTarget } from "../../src/spec-driven/types";
import { bindSpecSkillPolicy, checkSkillReadAccess } from "../../src/spec-driven/skill-policy";
import { contentText, createProviderFixture, type ModelRequest, type Reply } from "../spec-driven/provider-fixture";
import { MCPManager, type MCPAuthHandler } from "../../src/mcp/manager";

async function fixture(
	delay?: () => Promise<void>,
	authMode?: "session-ui" | "programmatic",
	skillCommands?: boolean,
	prediction: { enabled?: boolean; alternatives?: boolean; reply?: (request: ModelRequest) => Reply } = {},
) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workbench-host-"));
	const agentDir = path.join(cwd, "agent");
	await fs.mkdir(agentDir);
	const skills: Skill[] = [];
	if (skillCommands !== undefined) {
		const baseDir = path.join(agentDir, "skills", "jch-grill-me");
		await fs.mkdir(baseDir, { recursive: true });
		const filePath = path.join(baseDir, "SKILL.md");
		await fs.writeFile(
			filePath,
			"---\nname: jch-grill-me\ndescription: Native input probe\n---\nAsk one precise native skill question at a time.\n",
		);
		skills.push({
			name: "jch-grill-me",
			description: "Native input probe",
			baseDir,
			filePath,
			source: "bundled-jch",
			hide: true,
		});
	}
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
			await delay?.();
			return prediction.reply?.(request) ?? { text: "Native response" };
		},
	});
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  deepseek:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 1000000\n`,
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
			...(skillCommands === undefined ? {} : { "skills.enableSkillCommands": skillCommands }),
			"composer.predictions": prediction.enabled ?? false,
			"composer.predictionAlternatives": prediction.alternatives ?? false,
		},
	});
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	const model = registry.find("deepseek", "chat-a");
	if (!model) throw new Error("Isolated provider model unavailable");
	let ordinaryAuthCalls = 0;
	const sourceMcp = authMode
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
		skills,
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
		nativeMcpUiAuthHandler: authMode === "session-ui" ? ordinaryAuthHandler : undefined,
	});
	return {
		cwd,
		host,
		session,
		settings,
		provider,
		skill: skills[0],
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

describe("native workbench host", () => {
	test("one native side turn supplies all browsers and persists prediction usage without browser-triggered requests", async () => {
		await using f = await fixture(undefined, undefined, undefined, {
			enabled: true,
			alternatives: true,
			reply: () => ({ text: "run the tests\nshow the diff" }),
		});
		const imported = await f.host.controller.createRequirement({ source: "import" });
		const target = await f.host.controller.prepareSession(imported.record.requirementId);
		const native = f.host.controller.resolveSession(target);
		const offered = Promise.withResolvers<DevComposerPredictionFrame>();
		const frames: DevComposerPredictionFrame[] = [];
		const observe = f.host.observeBrowser("browser-a", frame => {
			if ("t" in frame && frame.t === "composer-prediction") {
				const prediction = frame as DevComposerPredictionFrame;
				frames.push(prediction);
				if (prediction.choices.length) offered.resolve(prediction);
			}
		});
		const detach = await f.host.subscribeNative("browser-a", target.requirementId, () => {});
		try {
			expect(f.host.composerPrediction("browser-a", target)).toEqual({ choices: [] });
			expect(f.provider.requests).toHaveLength(0);
			const input = f.host.prepareDevInput("browser-a", target);
			expect(await f.host.submitDevInput("browser-a", { requestId: input.requestId, text: "fix the bug" })).toEqual({
				kind: "accepted",
			});
			expect(await offered.promise).toEqual({
				t: "composer-prediction",
				target,
				choices: ["run the tests", "show the diff"],
			});
			const secondBrowser: object[] = [];
			const detachSecond = await f.host.subscribeNative("browser-b", target.requirementId, frame =>
				secondBrowser.push(frame),
			);
			try {
				expect(secondBrowser).toContainEqual({
					t: "composer-prediction",
					target,
					choices: ["run the tests", "show the diff"],
				});
				expect(f.host.composerPrediction("browser-b", target).choices).toEqual(["run the tests", "show the diff"]);
				f.host.composerPrediction("browser-a", target, "shown");
				f.host.composerPrediction("browser-a", target, "accepted", 1);
				expect(() => f.host.composerPrediction("browser-a", target, "accepted", 2)).toThrow();
				expect(() =>
					f.host.composerPrediction("browser-a", { ...target, generation: target.generation + 1 }),
				).toThrow();
				expect(f.provider.requests).toHaveLength(2);
				expect(native.sessionManager.getEntries().filter(entry => entry.type === "model_usage")).toContainEqual(
					expect.objectContaining({ purpose: "composer-prediction" }),
				);
				expect(native.messages.filter(message => message.role === "assistant")).toHaveLength(1);
				expect(f.session.messages).toEqual([]);
			} finally {
				await detachSecond();
			}
		} finally {
			observe();
			await detach();
		}
	}, 120_000);

	test("a native draft skips the billed prediction request", async () => {
		await using f = await fixture(undefined, undefined, undefined, { enabled: true });
		const imported = await f.host.controller.createRequirement({ source: "import" });
		const target = await f.host.controller.prepareSession(imported.record.requirementId);
		const native = f.host.controller.resolveSession(target);
		f.host.updateNativeEditor("browser-a", target, "already drafting the next message");
		await native.prompt("fix the bug");
		await f.host.close();
		expect(f.provider.requests).toHaveLength(1);
		expect(native.sessionManager.getEntries().filter(entry => entry.type === "model_usage")).toEqual([]);
	}, 120_000);

	test("host close cancels and settles its prediction without offering a held reply", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let requests = 0;
		await using f = await fixture(
			async () => {
				if (++requests === 2) {
					entered.resolve();
					await release.promise;
				}
			},
			undefined,
			undefined,
			{ enabled: true },
		);
		const imported = await f.host.controller.createRequirement({ source: "import" });
		const target = await f.host.controller.prepareSession(imported.record.requirementId);
		const native = f.host.controller.resolveSession(target);
		const offered: object[] = [];
		const observe = f.host.observeBrowser("browser-a", frame => {
			if (
				"t" in frame &&
				frame.t === "composer-prediction" &&
				"choices" in frame &&
				Array.isArray(frame.choices) &&
				frame.choices.length
			)
				offered.push(frame);
		});
		try {
			await native.prompt("fix the bug");
			await entered.promise;
			await f.host.close();
			release.resolve();
			expect(offered).toEqual([]);
			expect(f.provider.requests).toHaveLength(2);
		} finally {
			release.resolve();
			observe();
		}
	}, 120_000);

	test("a new native turn retires a held prediction and cannot leak it into the next draft", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let requests = 0;
		await using f = await fixture(
			async () => {
				if (++requests === 2) {
					entered.resolve();
					await release.promise;
				}
			},
			undefined,
			undefined,
			{ enabled: true },
		);
		const imported = await f.host.controller.createRequirement({ source: "import" });
		const target = await f.host.controller.prepareSession(imported.record.requirementId);
		const native = f.host.controller.resolveSession(target);
		const offered: object[] = [];
		const observe = f.host.observeBrowser("browser-a", frame => {
			if (
				"t" in frame &&
				frame.t === "composer-prediction" &&
				"choices" in frame &&
				Array.isArray(frame.choices) &&
				frame.choices.length
			)
				offered.push(frame);
		});
		try {
			await native.prompt("first task");
			await entered.promise;
			f.host.updateNativeEditor("browser-a", target, "the next draft already exists");
			await native.prompt("different task");
			expect(f.host.composerPrediction("browser-a", target)).toEqual({ choices: [] });
			release.resolve();
			await f.host.close();
			expect(offered).toEqual([]);
			expect(f.provider.requests).toHaveLength(3);
		} finally {
			release.resolve();
			observe();
		}
	}, 120_000);

	test("canonical repeated opening preserves the real root and cold records have no actors", async () => {
		await using f = await fixture();
		const rootId = f.session.sessionId;
		const reopened = await createDevWorkbenchHost({
			session: f.session,
			settings: f.settings,
			cwd: path.join(f.cwd, "."),
		});
		expect(reopened).toBe(f.host);
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
		expect(first).toBe(second);
		expect(first.url).toBe(second.url);
		expect((await fetch(first.loopbackUrl)).status).toBe(200);
		expect(await f.host.controller.listRequirements()).toEqual([]);
		const imported = await f.host.controller.createRequirement({ source: "import" });
		expect(imported.runtime).toBeNull();
		expect(f.host.controller.nativeSessions()).toEqual([]);
		expect(f.provider.requests).toEqual([]);
		expect(f.session.sessionId).toBe(rootId);
		expect(f.session.messages).toEqual([]);
	}, 120_000);

	test("composer model slash input uses native selection once per bound receipt without touching the ordinary root", async () => {
		await using f = await fixture();
		const imported = await f.host.controller.createRequirement({ source: "import" });
		const target = await f.host.controller.prepareSession(imported.record.requirementId);
		const native = f.host.controller.resolveSession(target);
		const rootModel = f.session.model;
		const rootMessages = [...f.session.messages];
		const prepared = f.host.prepareDevInput("browser-a", target);
		const selection = f.host.submitDevInput("browser-a", { requestId: prepared.requestId, text: "/model" });
		const request = f.host.nativeUi.pending().find(item => item.kind === "select" && item.title === "Native model");
		if (!request) throw new Error("Composer slash command did not open the native model selector");
		expect((await f.host.submitDevInput("browser-a", { requestId: prepared.requestId, text: "/model" })).kind).toBe(
			"unknown",
		);
		expect(f.host.nativeUi.pending().filter(item => item.requestId === request.requestId)).toHaveLength(1);
		expect((await f.host.respondNativeUi({ ...request, value: "deepseek/chat-a" })).accepted).toBe(true);
		expect(await selection).toEqual({ kind: "accepted" });
		expect(
			await f.host.submitDevInput("browser-a", { requestId: prepared.requestId, text: "/model nonexistent" }),
		).toEqual({ kind: "accepted" });
		expect(f.host.nativeUi.pending()).toHaveLength(0);
		expect(native.model?.id).toBe("chat-a");
		expect(f.session.model).toBe(rootModel);
		expect(f.session.messages).toEqual(rootMessages);
		expect(f.provider.requests).toEqual([]);
	}, 120_000);

	test("composer skill input loads native instructions and preserves admission, identity, display and scope", async () => {
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		await using f = await fixture(
			async () => {
				entered.resolve();
				await release.promise;
			},
			undefined,
			true,
		);
		const imported = await f.host.controller.createRequirement({ source: "import" });
		const target = await f.host.controller.prepareSession(imported.record.requirementId);
		const native = f.host.controller.resolveSession(target);
		const skill = f.skill;
		if (!skill) throw new Error("Native skill fixture is required");
		const access = { scope: native.sessionManager, getSessionBranch: () => native.sessionManager.getBranch() };
		expect(() => checkSkillReadAccess(skill, access)).toThrow("explicit current-session invocation required");
		const text = "/skill:jch-grill-me BROWSER_NATIVE_SKILL_SLASH_PROBE";
		const prepared = f.host.prepareDevInput("browser-a", target);
		try {
			expect(await f.host.submitDevInput("browser-a", { requestId: prepared.requestId, text })).toEqual({
				kind: "accepted",
			});
			await entered.promise;
			expect(native.isStreaming).toBe(true);
			expect(f.host.inspectDevInput("browser-a", prepared.requestId)).toEqual({ kind: "accepted" });
			expect(await f.host.submitDevInput("browser-a", { requestId: prepared.requestId, text })).toEqual({
				kind: "accepted",
			});
			const message = native.messages.find(
				item => item.role === "custom" && item.customType === SKILL_PROMPT_MESSAGE_TYPE,
			);
			expect(message).toMatchObject({
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				inputId: prepared.requestId,
				display: true,
				attribution: "user",
				details: { name: skill.name, path: skill.filePath, args: "BROWSER_NATIVE_SKILL_SLASH_PROBE", prompt: text },
			});
			expect(contentText(message && "content" in message ? message.content : undefined)).toContain(
				"Ask one precise native skill question at a time.",
			);
			const providerText = f.provider.requests[0]?.messages.map(item => contentText(item.content)).join("\n") ?? "";
			expect(providerText).toContain("Ask one precise native skill question at a time.");
			expect(providerText).toContain("BROWSER_NATIVE_SKILL_SLASH_PROBE");
			expect(() => checkSkillReadAccess(skill, access)).not.toThrow();
			expect(() => checkSkillReadAccess(skill, { scope: f.session.sessionManager })).toThrow(
				"explicit current-session invocation required",
			);
			const queued = f.host.prepareDevInput("browser-a", target);
			const queuedText = "  /skill:jch-grill-me queued native arguments  ";
			expect(await f.host.submitDevInput("browser-a", { requestId: queued.requestId, text: queuedText })).toEqual({
				kind: "accepted",
			});
			expect(native.getQueuedMessages().followUp).toEqual([queuedText]);
			expect(native.getQueuedInputMessages()).toHaveLength(1);
			expect(native.getQueuedInputMessages()[0]).toMatchObject({
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				inputId: queued.requestId,
				details: { args: "queued native arguments", prompt: queuedText.trim() },
			});
			expect(f.provider.requests).toHaveLength(1);
			expect(native.mutateQueuedInput(queued.requestId, "delete")).toBe(true);
			release.resolve();
			await native.waitForIdle();
			expect(f.provider.requests).toHaveLength(1);
			expect(f.session.messages).toEqual([]);
		} finally {
			release.resolve();
		}
	}, 120_000);

	test("composer skill dispatch respects the native skill setting and phase policy", async () => {
		await using disabled = await fixture(undefined, undefined, false);
		const disabledRecord = await disabled.host.controller.createRequirement({ source: "import" });
		const disabledTarget = await disabled.host.controller.prepareSession(disabledRecord.record.requirementId);
		const disabledNative = disabled.host.controller.resolveSession(disabledTarget);
		const prepared = disabled.host.prepareDevInput("browser-a", disabledTarget);
		const text = "/skill:jch-grill-me ordinary text while skill commands are disabled";
		expect(await disabled.host.submitDevInput("browser-a", { requestId: prepared.requestId, text })).toEqual({
			kind: "accepted",
		});
		await disabledNative.waitForIdle();
		expect(
			disabledNative.messages.some(item => item.role === "custom" && item.customType === SKILL_PROMPT_MESSAGE_TYPE),
		).toBe(false);
		const disabledUserText =
			disabled.provider.requests[0]?.messages
				.filter(item => item.role === "user")
				.map(item => contentText(item.content))
				.join("\n") ?? "";
		expect(disabledUserText).toContain(text);
		expect(disabledUserText).not.toContain("Ask one precise native skill question at a time.");

		await using enabled = await fixture(undefined, undefined, true);
		const enabledRecord = await enabled.host.controller.createRequirement({ source: "import" });
		const enabledTarget = await enabled.host.controller.prepareSession(enabledRecord.record.requirementId);
		const enabledNative = enabled.host.controller.resolveSession(enabledTarget);
		const enabledMessages = [...enabledNative.messages];
		const unbind = bindSpecSkillPolicy(enabledNative.sessionManager, { phase: "blocked probe", allowedSkills: [] });
		try {
			const denied = enabled.host.prepareDevInput("browser-a", enabledTarget);
			const result = await enabled.host.submitDevInput("browser-a", { requestId: denied.requestId, text });
			expect(result).toMatchObject({
				kind: "rejected",
				message: expect.stringContaining("not allowed during blocked probe"),
			});
			expect(enabled.host.inspectDevInput("browser-a", denied.requestId)).toEqual(result);
			expect(await enabled.host.submitDevInput("browser-a", { requestId: denied.requestId, text })).toEqual(result);
			expect(enabled.provider.requests).toEqual([]);
			expect(enabledNative.messages).toEqual(enabledMessages);
		} finally {
			unbind();
		}
	}, 120_000);

	test("native input identity rejects other browsers and stale targets before execution", async () => {
		await using f = await fixture();
		const imported = await f.host.controller.createRequirement({ source: "import" });
		const target = await f.host.controller.prepareSession(imported.record.requirementId);
		const prepared = f.host.prepareDevInput("browser-a", target);
		expect(
			(await f.host.submitDevInput("browser-b", { requestId: prepared.requestId, text: "must not run" })).kind,
		).toBe("rejected");
		expect(f.host.inspectDevInput("browser-b", prepared.requestId).kind).toBe("unknown");
		expect(() => f.host.prepareDevInput("browser-a", { ...target, generation: target.generation + 1 })).toThrow();
		expect(f.host.getNativeCommands(target).some(command => command.name === "goal")).toBe(false);
		expect(
			(
				await f.host.runDevNativeCommand("browser-a", {
					target,
					command: "goal",
					args: ["start", "Not authorized in the business stage"],
				})
			).kind,
		).toBe("rejected");
		expect(f.host.controller.resolveSession(target).getGoalModeState()).toBeUndefined();
		expect(f.provider.requests).toEqual([]);
		const native = f.host.controller.resolveSession(target);
		const frames: object[] = [];
		const bridge = createDevLocalSessionBridge(f.host.sessionPort(native), frame => frames.push(frame));
		const messagesBefore = [...native.messages];
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const holding = f.host.controller.submitNativeInput(target, async () => {
			entered.resolve();
			await release.promise;
		});
		try {
			await entered.promise;
			expect((await bridge.sendFrame({ t: "prompt", text: "must not bypass Dev admission" })).kind).toBe("rejected");
			expect(frames).toContainEqual(
				expect.objectContaining({ t: "error", message: expect.stringContaining("原生输入不会排队越过此边界") }),
			);
			expect(native.messages).toEqual(messagesBefore);
			expect(f.provider.requests).toEqual([]);
			release.resolve();
			expect(await holding).toBe(false);
			await f.host.controller.stop(imported.record.requirementId);
			const stoppedMessages = [...native.messages];
			expect((await bridge.sendFrame({ t: "prompt", text: "must not reuse the captured generation" })).kind).toBe(
				"rejected",
			);
			expect(frames).toContainEqual(
				expect.objectContaining({ t: "error", message: expect.stringContaining("代际已改变") }),
			);
			expect(native.messages).toEqual(stoppedMessages);
			expect(f.provider.requests).toEqual([]);
		} finally {
			release.resolve();
			await holding;
			await bridge.close();
		}
	}, 120_000);

	test("exclusive Dev temporarily binds attributed MCP UI and restores the exact ordinary callback on exit", async () => {
		await using f = await fixture(undefined, "session-ui");
		const manager = f.host.rootSession.nativeChildCapabilities?.mcpManager;
		if (!(manager instanceof MCPManager)) throw new Error("A concrete borrowed native MCP manager is required");
		const sourceMcp = f.sourceMcp;
		if (!sourceMcp) throw new Error("The ordinary native MCP manager is required");
		expect(manager).toBe(sourceMcp);
		expect(manager.getAuthHandler()).not.toBe(f.ordinaryAuthHandler);
		await expect(
			f.host.handleNativeMcpAuth("no-server", { wwwAuthenticate: [] }, { scope: "owner", toolCallId: "not-active" }),
		).rejects.toThrow();
		expect(f.host.nativeUi.pending()).toEqual([]);
		expect(f.ordinaryAuthCalls()).toBe(0);
		expect(f.provider.requests).toEqual([]);
		await f.host.close();
		expect(manager.getAuthHandler()).toBe(f.ordinaryAuthHandler);
		expect(f.session.isDisposed).toBe(false);
	}, 120_000);

	test("exclusive Dev preserves an explicitly programmatic MCP authentication callback", async () => {
		await using f = await fixture(undefined, "programmatic");
		const manager = f.host.rootSession.nativeChildCapabilities?.mcpManager;
		if (!(manager instanceof MCPManager)) throw new Error("A concrete borrowed native MCP manager is required");
		const sourceMcp = f.sourceMcp;
		if (!sourceMcp) throw new Error("The ordinary native MCP manager is required");
		expect(manager).toBe(sourceMcp);
		expect(manager.getAuthHandler()).toBe(f.ordinaryAuthHandler);
		expect(f.host.nativeUi.pending()).toEqual([]);
		expect(f.ordinaryAuthCalls()).toBe(0);
		await f.host.close();
		expect(manager.getAuthHandler()).toBe(f.ordinaryAuthHandler);
	}, 120_000);

	test("failed Dev settlement keeps writes blocked and the borrowed root alive until an explicit exit retry succeeds", async () => {
		await using f = await fixture(undefined, "session-ui");
		const record = await f.host.controller.createRequirement({ source: "import" });
		const manager = f.sourceMcp;
		if (!manager) throw new Error("Native MCP fixture manager is required");
		const dispose = f.host.controller.dispose.bind(f.host.controller);
		let blocked = true;
		f.host.controller.dispose = async () => {
			if (blocked) throw new Error("Native descendant settlement remains blocked");
			await dispose();
		};
		try {
			await expect(f.host.close()).rejects.toThrow();
			expect(() => f.host.assertWritable("browser-a")).toThrow();
			expect(f.session.isDisposed).toBe(false);
			expect(manager.getAuthHandler()).not.toBe(f.ordinaryAuthHandler);
			blocked = false;
			await f.host.close();
			expect(manager.getAuthHandler()).toBe(f.ordinaryAuthHandler);
			expect(f.session.isDisposed).toBe(false);
			const resumed = await createDevWorkbenchHost({
				session: f.session,
				settings: f.settings,
				cwd: f.cwd,
				mcpManager: manager,
				nativeMcpUiAuthHandler: f.ordinaryAuthHandler,
			});
			try {
				expect((await resumed.controller.getRequirement(record.record.requirementId)).record.lifecycle).toBe(
					"active",
				);
				expect(resumed.controller.nativeSessions()).toEqual([]);
				expect(f.provider.requests).toEqual([]);
			} finally {
				await resumed.close();
			}
		} finally {
			blocked = false;
			f.host.controller.dispose = dispose;
		}
	}, 120_000);

	test("detaching a browser leaves admitted native work running and repeated input never replays", async () => {
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		await using f = await fixture(async () => {
			entered.resolve();
			await release.promise;
		});
		const imported = await f.host.controller.createRequirement({ source: "import" });
		const target = await f.host.controller.prepareSession(imported.record.requirementId);
		const frames: object[] = [];
		const detach = await f.host.subscribeNative("browser-a", imported.record.requirementId, frame =>
			frames.push(frame),
		);
		const prepared = f.host.prepareDevInput("browser-a", target);
		try {
			expect(
				await f.host.submitDevInput("browser-a", { requestId: prepared.requestId, text: "A single native input" }),
			).toEqual({ kind: "accepted" });
			await entered.promise;
			const queued = f.host.prepareDevInput("browser-a", target);
			expect(
				(
					await f.host.submitDevInput("browser-a", {
						requestId: queued.requestId,
						text: "Remove only this queued native input",
					})
				).kind,
			).toBe("accepted");
			expect(f.host.controller.resolveSession(target).queuedMessageCount).toBe(1);
			const remove = f.host.runDevNativeCommand("browser-a", {
				target,
				command: "queue",
				args: ["remove", queued.requestId],
			});
			const permission = f.host.nativeUi.pending().find(request => request.kind === "confirm");
			if (!permission) throw new Error("Native queue confirmation was not presented");
			expect((await f.host.respondNativeUi({ ...permission, value: true })).accepted).toBe(true);
			expect(await remove).toEqual({ kind: "accepted" });
			expect(f.host.controller.resolveSession(target).queuedMessageCount).toBe(0);
			await detach();
			const native = f.host.controller.resolveSession(target);
			expect(native.isStreaming).toBe(true);
			expect(
				await f.host.submitDevInput("browser-a", { requestId: prepared.requestId, text: "must not replay" }),
			).toEqual({ kind: "accepted" });
			expect(f.provider.requests).toHaveLength(1);
			release.resolve();
			await native.waitForIdle();
			const restored: object[] = [];
			const detachAgain = await f.host.subscribeNative("browser-a", imported.record.requirementId, frame =>
				restored.push(frame),
			);
			expect(restored.length).toBeGreaterThan(0);
			expect(f.provider.requests).toHaveLength(1);
			await detachAgain();
		} finally {
			release.resolve();
		}
	}, 120_000);

	test("true host shutdown settles native work and waits without cancelling the requirement record", async () => {
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		await using f = await fixture(async () => {
			entered.resolve();
			await release.promise;
		});
		const imported = await f.host.controller.createRequirement({ source: "import" });
		const target = await f.host.controller.prepareSession(imported.record.requirementId);
		const prepared = f.host.prepareDevInput("browser-a", target);
		try {
			expect(
				(await f.host.submitDevInput("browser-a", { requestId: prepared.requestId, text: "One owned native turn" }))
					.kind,
			).toBe("accepted");
			await entered.promise;
			const native = f.host.controller.resolveSession(target);
			const confirm = f.host.nativeUi
				.createContext(() => target)
				.confirm("Pending native permission", "No implicit approval on shutdown");
			const closing = f.host.close();
			release.resolve();
			await closing;
			expect(await confirm).toBe(false);
			expect(native.isStreaming).toBe(false);
			expect(f.host.controller.nativeSessions()).toEqual([]);
			expect(f.session.isDisposed).toBe(false);
			expect((await f.host.controller.getRequirement(imported.record.requirementId)).record.lifecycle).toBe(
				"active",
			);
			expect(f.provider.requests).toHaveLength(1);
		} finally {
			release.resolve();
		}
	}, 120_000);
});

test("native RPC keeps its default policy while the workbench explicitly follows existing interactive Goal settings", async () => {
	await using ordinary = await fixture();
	cfgGoalContinuationModes.set(ordinary.settings, ["interactive"]);
	const rpc = new RpcGoalController(ordinary.session);
	const detachRpc = ordinary.session.subscribe(event => rpc.observe(event));
	try {
		await rpc.handle({ op: "create", objective: "Do not start a model under the disabled RPC continuation policy" });
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
	await using workbench = await fixture(async () => {
		entered.resolve();
		await release.promise;
	});
	cfgGoalContinuationModes.set(workbench.settings, ["interactive"]);
	const interactive = createDevGoalController(workbench.session);
	const detachInteractive = workbench.session.subscribe(event => interactive.observe(event));
	try {
		await interactive.handle({ op: "create", objective: "Execute one explicitly authorized native continuation" });
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
		detachInteractive();
	}
}, 120_000);

describe("native human waits", () => {
	test("first exact response wins while old generations and denied approvals never grant", async () => {
		const ui = new DevNativeUiController();
		let target: DevSessionTarget = { requirementId: "r1", sessionId: "native-s1", generation: 1 };
		const context = ui.createContext(() => target);
		const selected = context.select("Pick", ["One", "Two"]);
		const request = ui.pending()[0];
		expect(await ui.respondDevNativeUi({ ...request, generation: 2, value: "One" })).toEqual({
			accepted: false,
			reason: "Native request owner or generation changed",
		});
		expect(await ui.respondDevNativeUi({ ...request, value: "One" })).toEqual({ accepted: true });
		expect(await ui.respondDevNativeUi({ ...request, value: "Two" })).toEqual({
			accepted: false,
			reason: "This native request has already ended",
		});
		expect(await selected).toBe("One");
		const approval = context.approve!({ compact: "Sensitive tool", full: "Exact path and arguments" });
		const pending = ui.pending()[0];
		expect((await ui.respondDevNativeUi({ ...pending, value: "session" })).accepted).toBe(false);
		expect((await ui.respondDevNativeUi({ ...pending, value: "deny" })).accepted).toBe(true);
		expect(await approval).toBe("deny");
		const stale = context.confirm("Confirm", "Do not answer in another generation");
		const staleRequest = ui.pending()[0];
		target = { ...target, generation: 3 };
		expect((await ui.respondDevNativeUi({ ...staleRequest, value: true })).accepted).toBe(false);
		ui.close();
		expect(await stale).toBe(false);
	});

	test("native abort closes waits, not subscriber detachment; rich ask returns exact selected facts", async () => {
		const ui = new DevNativeUiController();
		const target = { requirementId: "r2", sessionId: "native-s2", generation: 7 };
		const context = ui.createContext(() => target);
		const abort = new AbortController();
		const editor = context.editor("Native editor", "original", { signal: abort.signal });
		const unsubscribe = ui.observe(() => {});
		unsubscribe();
		expect(ui.pending()).toHaveLength(1);
		abort.abort();
		expect(await editor).toBeUndefined();
		const ask = context.askDialog!([{ id: "q", question: "Choice?", options: [{ label: "A" }, { label: "B" }] }]);
		const request = ui.pending()[0];
		const answer = {
			kind: "submit" as const,
			results: [
				{
					id: "q",
					question: "Choice?",
					options: ["A", "B"],
					multi: false,
					selectedOptions: ["B"],
					note: "human detail",
				},
			],
		};
		expect((await ui.respondDevNativeUi({ ...request, value: answer })).accepted).toBe(true);
		expect(await ask).toEqual(answer);
		ui.close();
	});

	test("native editor and persistent widgets rehydrate facts without replaying paste or notifications", () => {
		const ui = new DevNativeUiController();
		const target = { requirementId: "r3", sessionId: "native-s3", generation: 4 };
		const context = ui.createContext(() => target);
		ui.updateEditor(target, "Actual browser draft Ω");
		expect(context.getEditorText()).toBe("Actual browser draft Ω");
		context.pasteToEditor("\nNative addition");
		context.setStatus("work", "Native work");
		context.setWidget("progress", ["native row"], { placement: "belowEditor" });
		context.notify("Ephemeral notification");
		const snapshot = ui.snapshot();
		expect(snapshot).toContainEqual({
			t: "native-ui-state",
			target,
			method: "setEditorText",
			value: "Actual browser draft Ω\nNative addition",
		});
		expect(snapshot.some(event => event.method === "pasteToEditor" || event.method === "notify")).toBe(false);
		expect(snapshot).toContainEqual({
			t: "native-ui-state",
			target,
			method: "setWidget",
			value: { key: "progress", content: ["native row"], options: { placement: "belowEditor" } },
		});
		ui.updateEditor({ ...target, generation: 5 }, "Different generation");
		expect(context.getEditorText()).toBe("Actual browser draft Ω\nNative addition");
		ui.close();
	});
});
