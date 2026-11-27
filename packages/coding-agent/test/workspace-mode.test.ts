import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import * as compaction from "@oh-my-pi/pi-agent-core/compaction";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { resolveLocalRoot } from "../src/internal-urls/local-protocol";
import { createAgentSession } from "../src/sdk";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { isWorkspaceModeContext, WORKSPACE_MODE_STATE_TYPE } from "../src/workspace-mode";
import { assistantMsg, userMsg } from "./utilities";

function text(message: AgentMessage | Message): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string"
		? message.content
		: message.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

// Match actual resolved paths, never prompt prose or the model's answer.
function reminders(messages: readonly Message[], localRoot: string): Message[] {
	return messages.filter(message => text(message).includes(localRoot) && text(message).includes(os.tmpdir()));
}

interface Harness {
	session: AgentSession;
	mock: MockModel;
	localRoot: string;
}

describe("native workspace input delivery", () => {
	let temp: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		temp = TempDir.createSync("@pi-workspace-");
		auth = await AuthStorage.create(temp.join("auth.db"));
		auth.keys.setRuntime("anthropic", "workspace-test-key");
		registry = new ModelRegistry(auth, temp.join("models.yml"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			for (const session of sessions.splice(0)) await session.dispose();
		} finally {
			auth.close();
			await temp.remove();
		}
	});

	async function harness(
		options: {
			manager?: SessionManager;
			cwd?: string;
			mock?: MockModelOptions;
			settings?: Settings;
			onRequest?: (session: AgentSession, options: Parameters<StreamFn>[2]) => Promise<void>;
			convert?: (messages: AgentMessage[]) => Message[];
		} = {},
	): Promise<Harness> {
		const cwd = options.cwd ?? temp.join("project");
		await fs.mkdir(cwd, { recursive: true });
		const manager = options.manager ?? SessionManager.inMemory(cwd);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Bundled test model unavailable");
		const mock = createMockModel({ handler: { content: ["finished"] }, ...options.mock });
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Workspace consumer fixture"], tools: [] },
			getApiKey: () => "workspace-test-key",
			// Same primary seam as the SDK: workspace preparation precedes configured conversion.
			transformContext: messages => session.prepareWorkspaceModeContext(messages),
			convertToLlm: options.convert ?? convertToLlm,
			steeringMode: "all",
			followUpMode: "all",
			streamFn: async (selected, context, streamOptions) => {
				await options.onRequest?.(session, streamOptions);
				return mock.stream(selected, context, streamOptions);
			},
		});
		const session: AgentSession = new AgentSession({
			agent,
			sessionManager: manager,
			settings:
				options.settings ??
				Settings.isolated({
					"compaction.enabled": false,
					"retry.enabled": false,
					steeringMode: "all",
					followUpMode: "all",
				}),
			modelRegistry: registry,
			toolRegistry: new Map(),
			convertToLlm: options.convert ?? convertToLlm,
		});
		sessions.push(session);
		const localRoot = resolveLocalRoot({
			getArtifactsDir: () => manager.getArtifactsDir(),
			getSessionId: () => manager.getSessionId(),
		});
		return { session, mock, localRoot };
	}

	it("toggles independently, preserves user content, and drops obsolete active context", async () => {
		const { session, mock, localRoot } = await harness();
		const model = session.model;
		const tools = session.getEnabledToolNames();
		await session.prompt("ordinary");
		expect(reminders(mock.calls[0].context.messages, localRoot)).toHaveLength(0);
		session.setWorkspaceModeState({ enabled: true });
		expect(mock.calls).toHaveLength(1);
		const input = "  external C:\\outside\\target.txt\nkeep original whitespace  ";
		await session.prompt(input);
		expect(reminders(mock.calls[1].context.messages, localRoot)).toHaveLength(1);
		expect(mock.calls[1].context.messages.some(message => message.role === "user" && text(message) === input)).toBe(
			true,
		);
		const stored = session.messages.find(message => message.role === "user" && text(message) === input);
		expect(stored).toMatchObject({ content: [{ type: "text", text: input }] });
		session.setWorkspaceModeState({ enabled: false });
		expect(session.messages.some(isWorkspaceModeContext)).toBe(false);
		await session.prompt("after disable");
		expect(reminders(mock.calls[2].context.messages, localRoot)).toHaveLength(0);
		expect(session.model).toBe(model);
		expect(session.getEnabledToolNames()).toEqual(tools);
	});

	it("delivers one pure-text reminder with an actual live steering batch", async () => {
		let once = false;
		const liveRequests: Message[][] = [];
		const { session, mock, localRoot } = await harness({
			convert: messages =>
				convertToLlm(messages).map(message =>
					message.role === "user"
						? { ...message, content: text(message).replaceAll("private-value", "[redacted]") }
						: message,
				),
			onRequest: async (current, options) => {
				if (once) return;
				once = true;
				await current.steer("first steer");
				await current.steer("second steer private-value");
				const live = options?.liveSteering;
				if (!live) throw new Error("Primary provider did not offer live steering");
				const claim = await live.claim(new AbortController().signal);
				if (!claim) throw new Error("Workspace steering was not live-deliverable");
				liveRequests.push([...claim.messages]);
				claim.accept();
			},
		});
		session.setWorkspaceModeState({ enabled: true });
		await session.prompt("start");
		expect(liveRequests).toHaveLength(1);
		expect(reminders(liveRequests[0], localRoot)).toHaveLength(1);
		expect(liveRequests[0].every(message => message.role === "user")).toBe(true);
		expect(liveRequests[0].map(text)).toContain("first steer");
		expect(liveRequests[0].map(text)).toContain("second steer [redacted]");
		expect(reminders(mock.calls[0].context.messages, localRoot)).toHaveLength(1);
		// Replay must deliver the accepted items in order without changing their role or text.
		const replay = await session.convertMessagesToLlm(session.messages);
		const delivered = replay
			.slice(mock.calls[0].context.messages.length)
			.filter(message => message.role !== "assistant");
		expect<Array<{ role: Message["role"]; content: string }>>(
			delivered.map(message => ({ role: message.role, content: text(message) })),
		).toEqual(liveRequests[0].map(message => ({ role: message.role, content: text(message) })));
	});

	it("refreshes a queued follow-up batch exactly once and does not treat synthetic input as a submission", async () => {
		let once = false;
		const { session, mock, localRoot } = await harness({
			onRequest: async current => {
				if (once) return;
				once = true;
				await current.followUp("follow one");
				await current.followUp("follow two");
			},
		});
		session.setWorkspaceModeState({ enabled: true });
		await session.prompt("start");
		await session.waitForIdle();
		const delivered = mock.calls.find(call => call.context.messages.some(message => text(message) === "follow two"));
		expect(delivered).toBeDefined();
		// The initial submission and this delivered batch each retain their slot.
		expect(reminders(delivered!.context.messages, localRoot)).toHaveLength(2);
		expect(delivered!.context.messages.some(message => text(message) === "follow one")).toBe(true);
		const contexts = session.messages.filter(isWorkspaceModeContext).length;
		await session.prompt("internal continuation", { synthetic: true });
		expect(session.messages.filter(isWorkspaceModeContext)).toHaveLength(contexts);
		const fresh = await harness();
		fresh.session.setWorkspaceModeState({ enabled: true });
		await fresh.session.prompt("synthetic only", { synthetic: true });
		expect(reminders(fresh.mock.calls[0].context.messages, fresh.localRoot)).toHaveLength(0);
	});

	it("excludes rebuilt delivery context and retained turns from the native compression prefix", async () => {
		const { session } = await harness({
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.keepRecentTokens": 1,
				"retry.enabled": false,
			}),
			convert: messages =>
				convertToLlm(messages).map(message =>
					message.role === "user"
						? { ...message, content: text(message).replaceAll("private-value", "[redacted]") }
						: message,
				),
		});
		vi.spyOn(registry, "getAvailable").mockReturnValue([session.model!]);
		session.setWorkspaceModeState({ enabled: true });
		const summarized = [userMsg("summarize private-value"), assistantMsg("old answer")];
		const retained = [userMsg("retained turn"), assistantMsg("retained answer")];
		for (const message of [...summarized, ...retained]) {
			session.agent.appendMessage(message);
			session.sessionManager.appendMessage(message);
		}
		const captured: Message[][] = [];
		const stopped = new Error("captured native compression context");
		vi.spyOn(compaction, "compact").mockImplementation(
			async (_preparation, model, _auth, _instructions, signal, options) => {
				if (!options?.buildProviderContext) throw new Error("Missing native compression context builder");
				const context = await options.buildProviderContext(summarized, retained, signal, model);
				captured.push(context.messages);
				throw stopped;
			},
		);
		await expect(session.compact()).rejects.toThrow(stopped.message);
		expect(captured).toHaveLength(1);
		expect(captured[0].map(text)).toEqual(["summarize [redacted]", "old answer"]);
	});

	it("restores the selected branch, preserves enabled state on rebuild, and starts new sessions disabled", async () => {
		const manager = SessionManager.inMemory(temp.path());
		const enabled = manager.appendCustomEntry(WORKSPACE_MODE_STATE_TYPE, { enabled: true });
		manager.appendCustomEntry(WORKSPACE_MODE_STATE_TYPE, { enabled: false });
		const { session, mock, localRoot } = await harness({ manager });
		await session.prompt("off branch");
		expect(reminders(mock.calls[0].context.messages, localRoot)).toHaveLength(0);
		manager.branch(enabled);
		session.replaceMessagesFromSessionContext(session.buildDisplaySessionContext().messages);
		await session.prompt("restored branch");
		expect(reminders(mock.calls[1].context.messages, localRoot)).toHaveLength(1);
		// Retry a rebuilt admitted input, without submitting another user turn.
		session.replaceMessagesFromSessionContext(
			session.buildDisplaySessionContext().messages.filter(message => message.role !== "assistant"),
		);
		await session.agent.continue();
		expect(reminders(mock.calls.at(-1)!.context.messages, localRoot)).toHaveLength(1);
		await session.newSession();
		await session.prompt("new session");
		expect(reminders(mock.calls.at(-1)!.context.messages, localRoot)).toHaveLength(0);
	});

	it("restores persisted enabled and disabled sessions without leaking active contexts", async () => {
		const manager = SessionManager.create(temp.path(), temp.join("sessions"));
		const original = await harness({ manager });
		original.session.setWorkspaceModeState({ enabled: true });
		await original.session.prompt("persist enabled");
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Persistent fixture has no session file");
		await original.session.dispose();
		sessions.splice(sessions.indexOf(original.session), 1);
		const resumed = await harness({ manager: await SessionManager.open(file, temp.join("sessions")) });
		await resumed.session.prompt("resumed enabled");
		expect(reminders(resumed.mock.calls[0].context.messages, resumed.localRoot)).toHaveLength(1);
		resumed.session.setWorkspaceModeState({ enabled: false });
		await resumed.session.sessionManager.flush();
		await resumed.session.dispose();
		sessions.splice(sessions.indexOf(resumed.session), 1);
		const disabled = await harness({ manager: await SessionManager.open(file, temp.join("sessions")) });
		await disabled.session.prompt("resumed disabled");
		expect(reminders(disabled.mock.calls[0].context.messages, disabled.localRoot)).toHaveLength(0);
	});

	it("delivers through the production SDK primary request seam", async () => {
		const bodies: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				bodies.push(await request.text());
				const chunk = {
					id: "workspace-local",
					choices: [{ index: 0, delta: { content: "finished" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				};
				return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		try {
			const bundled = getBundledModel("venice", "deepseek-v4-1-flash");
			if (!bundled) throw new Error("Bundled local-compatible test model unavailable");
			auth.keys.setRuntime(bundled.provider, "local-fixture-key");
			const manager = SessionManager.inMemory(temp.path());
			const { session } = await createAgentSession({
				cwd: temp.path(),
				agentDir: temp.path(),
				sessionManager: manager,
				authStorage: auth,
				modelRegistry: registry,
				settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
				model: { ...bundled, baseUrl: `http://127.0.0.1:${server.port}/v1` },
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			sessions.push(session);
			const root = resolveLocalRoot({
				getArtifactsDir: () => manager.getArtifactsDir(),
				getSessionId: () => manager.getSessionId(),
			});
			session.setWorkspaceModeState({ enabled: true });
			await session.prompt("SDK local capture");
			expect(bodies).toHaveLength(1);
			expect(JSON.stringify(JSON.parse(bodies[0]))).toContain(JSON.stringify(root).slice(1, -1));
			session.setWorkspaceModeState({ enabled: false });
			await session.prompt("SDK disabled capture");
			expect(bodies).toHaveLength(2);
			expect(JSON.stringify(JSON.parse(bodies[1]))).not.toContain(JSON.stringify(root).slice(1, -1));
		} finally {
			server.stop(true);
		}
	});

	it("keeps Plan context while workspace is active", async () => {
		const { session, mock, localRoot } = await harness();
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "PLAN.md"), "# Workspace coexistence plan\n");
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		session.setWorkspaceModeState({ enabled: true });
		await session.prompt("design only");
		const request = mock.calls[0].context.messages;
		expect(reminders(request, localRoot)).toHaveLength(1);
		expect(request.some(message => message.role === "developer" && text(message).includes("PLAN.md"))).toBe(true);
	});

	it("resolves Git roots through path aliases without trusting cwd when no Git project exists", async () => {
		const repo = temp.join("repository");
		await fs.mkdir(path.join(repo, "nested"), { recursive: true });
		const git = Bun.spawn(["git", "init", "--quiet", repo], { stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(git.stderr).text();
		if ((await git.exited) !== 0) throw new Error(`Git fixture initialization failed: ${stderr}`);
		const alias = temp.join("alias");
		await fs.symlink(repo, alias, process.platform === "win32" ? "junction" : "dir");
		const canonical = await fs.realpath(repo);
		const gitHarness = await harness({ cwd: path.join(alias, "nested") });
		gitHarness.session.setWorkspaceModeState({ enabled: true });
		await gitHarness.session.prompt("inspect repository");
		const gitReminder = reminders(gitHarness.mock.calls[0].context.messages, gitHarness.localRoot);
		expect(gitReminder).toHaveLength(1);
		expect(text(gitReminder[0])).toContain(canonical);
		expect(text(gitReminder[0])).not.toContain(alias);
		const noGit = await harness({ cwd: temp.join("no-repository") });
		noGit.session.setWorkspaceModeState({ enabled: true });
		await noGit.session.prompt("inspect non-project");
		const noGitReminder = reminders(noGit.mock.calls[0].context.messages, noGit.localRoot);
		expect(noGitReminder).toHaveLength(1);
		expect(text(noGitReminder[0])).not.toContain(temp.join("no-repository"));
		expect(text(noGitReminder[0])).not.toContain(canonical);
	});
});
