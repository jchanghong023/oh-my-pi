import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { __resetDirsFromEnvForTests, getAgentDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { resolveLocalRoot } from "../src/internal-urls/local-protocol";
import { submitInteractiveInput } from "../src/main";
import { InputController } from "../src/modes/controllers/input-controller";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { AgentStorage } from "../src/session/agent-storage";
import { HistoryStorage } from "../src/session/history-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { commandUsage, hintUsage } from "../src/utils/usage-counter";

function text(message: AgentMessage | Message): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string"
		? message.content
		: message.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

describe("InteractiveMode workspace command", () => {
	let temp: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;
	let mock: MockModel;
	let localRoot: string;

	let originalEnv: Record<string, string | undefined>;
	let agentDbPath: string;

	beforeEach(async () => {
		resetSettingsForTest();
		temp = TempDir.createSync("@pi-interactive-workspace-");
		originalEnv = {
			HOME: process.env.HOME,
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
			PI_PROFILE: process.env.PI_PROFILE,
			OMP_PROFILE: process.env.OMP_PROFILE,
		};
		process.env.HOME = temp.path();
		vi.spyOn(os, "homedir").mockReturnValue(temp.path());
		setAgentDir(temp.join("agent"));
		agentDbPath = getAgentDbPath();
		// Do not bind the process-wide counter to storage this fixture will close.
		vi.spyOn(hintUsage, "load").mockResolvedValue(undefined);
		vi.spyOn(commandUsage, "record").mockImplementation(() => {});
		await initTheme();
		await Settings.init({ inMemory: true, cwd: temp.path(), agentDir: temp.join("agent") });
		auth = await AuthStorage.create(temp.join("auth.db"));
		mock = createMockModel({ handler: { content: ["finished"] } });
		mock.input.push("image");
		auth.keys.setRuntime(mock.provider, "workspace-test-key");
		registry = new ModelRegistry(auth, temp.join("models.yml"));
		registry.find = (provider, id) => (provider === mock.provider && id === mock.id ? mock.model : undefined);
		registry.getAvailable = () => [mock.model];
		const model = mock.model;
		const manager = SessionManager.create(temp.path(), temp.join("sessions"));
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Workspace UI consumer fixture"], tools: [] },
			getApiKey: () => "workspace-test-key",
			transformContext: messages => session.prepareWorkspaceModeContext(messages),
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: registry,
			toolRegistry: new Map(),
			convertToLlm,
		});
		mode = new InteractiveMode(session, "test");
		localRoot = resolveLocalRoot({
			getArtifactsDir: () => manager.getArtifactsDir(),
			getSessionId: () => manager.getSessionId(),
		});
	});

	afterEach(async () => {
		mode?.stop();
		for (const key of ["isStreaming", "isCompacting", "extensionRunner"]) {
			Reflect.deleteProperty(session, key);
		}
		await session?.dispose();
		await registry?.awaitBackgroundRefresh();
		auth?.close();
		AgentStorage.close(agentDbPath);
		HistoryStorage.close();
		closeModelCache();
		vi.restoreAllMocks();
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		temp?.removeSync();
		resetSettingsForTest();
	});

	async function submit(prompt: string, input?: Parameters<InteractiveMode["handleWorkspaceModeCommand"]>[1]) {
		const pending = mode.getUserInput();
		expect(await mode.handleWorkspaceModeCommand(prompt, input)).toBe(true);
		const submitted = await pending;
		if (input) {
			expect(submitted.images).toEqual(input.images);
			expect(submitted.imageLinks).toEqual(input.imageLinks);
		}
		await submitInteractiveInput(mode, session, submitted);
		return submitted;
	}

	function reminders(messages: readonly Message[]) {
		return messages.filter(message => text(message).includes(localRoot) && text(message).includes(os.tmpdir()));
	}

	function statusText(width: number): string {
		return [mode.statusLine.getTopBorder(width).content, ...mode.statusLine.render(width)].join(" ");
	}

	it("toggles without submitting", async () => {
		const model = session.model;
		const tools = session.getEnabledToolNames();
		expect(await mode.handleWorkspaceModeCommand()).toBe(false);
		expect(statusText(160)).toContain("Workspace");
		expect(await mode.handleWorkspaceModeCommand()).toBe(false);
		expect(statusText(160)).not.toContain("Workspace");
		expect(mock.calls).toHaveLength(0);
		expect(session.model).toBe(model);
		expect(session.getEnabledToolNames()).toEqual(tools);
	});

	it("submits once when off and already on, preserving text, images, links and the draft", async () => {
		const raw = "  external C:\\outside\\target.txt\nkeep original whitespace  ";
		const images = [
			{
				type: "image" as const,
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
				mimeType: "image/png",
			},
		];
		const imageLinks = ["local://attached.png"];
		mode.editor.setText("newer draft");
		await submit(raw, { images, imageLinks });
		expect(mode.editor.getText()).toBe("newer draft");
		await submit("second message");
		expect(mock.calls).toHaveLength(2);
		expect(reminders(mock.calls[0].context.messages)).toHaveLength(1);
		expect(reminders(mock.calls[1].context.messages)).toHaveLength(2);
		const first = mock.calls[0].context.messages.filter(message => message.role === "user" && text(message) === raw);
		expect(first).toHaveLength(1);
		expect(first[0].content).toEqual([
			{ type: "text", text: raw },
			{ type: "image", data: expect.stringMatching(/.+/), mimeType: expect.stringMatching(/^image\//) },
		]);
		expect(
			session.messages.filter(message => message.role === "user" && text(message) === "second message"),
		).toHaveLength(1);
	});

	it("delivers an idle command without an input waiter exactly once", async () => {
		const controller = new InputController(mode);
		controller.setupEditorSubmitHandler();
		await mode.editor.onSubmit?.("/workspace between turns");
		expect(session.getWorkspaceModeState().enabled).toBe(true);
		expect(mock.calls).toHaveLength(1);
		expect(
			session.messages.filter(message => message.role === "user" && text(message) === "between turns"),
		).toHaveLength(1);
	});

	it("keeps Ctrl+Enter follow-ups distinct from Enter steering", async () => {
		const controller = new InputController(mode);
		controller.setupEditorSubmitHandler();
		let compacting = false;
		Object.defineProperties(session, {
			isStreaming: { configurable: true, value: true },
			isCompacting: { configurable: true, get: () => compacting },
		});
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
		await mode.editor.onSubmit?.("/workspace steer this");
		mode.editor.setText("/workspace follow this");
		await controller.handleFollowUp();
		compacting = true;
		mode.editor.setText("/workspace after compaction");
		await controller.handleFollowUp();
		expect(mode.compactionQueuedMessages).toMatchObject([{ text: "/workspace after compaction", mode: "followUp" }]);
		compacting = false;
		await mode.flushCompactionQueue();
		expect(mode.compactionQueuedMessages).toHaveLength(0);
		expect(prompt.mock.calls).toEqual([
			["steer this", { streamingBehavior: "steer", images: undefined }],
			["follow this", { streamingBehavior: "followUp", images: undefined }],
			["after compaction", { streamingBehavior: "followUp", images: undefined }],
		]);
	});

	it("preserves newer text and attachments while the input hook awaits", async () => {
		vi.spyOn(mode, "showError").mockImplementation(message => {
			throw new Error(message);
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		Object.defineProperty(session, "extensionRunner", {
			configurable: true,
			value: {
				hasHandlers: (event: string) => event === "input",
				getCommand: () => undefined,
				getRegisteredCommands: () => [],
				emitInput: async () => {
					entered.resolve();
					await release.promise;
					return { handled: false };
				},
			} as unknown as NonNullable<AgentSession["extensionRunner"]>,
		});
		const controller = new InputController(mode);
		controller.setupEditorSubmitHandler();
		const pending = mode.getUserInput();
		const dispatch = mode.editor.onSubmit?.("/workspace original request");
		await Promise.race([
			entered.promise,
			Promise.resolve(dispatch).then(() => {
				throw new Error("Workspace submission finished before entering the input hook");
			}),
		]);
		const newerImage = { type: "image" as const, data: "new-image", mimeType: "image/png" };
		mode.editor.pendingImages = [newerImage];
		mode.editor.pendingImageLinks = ["local://newer.png"];
		mode.editor.setText("newer draft");
		release.resolve();
		await dispatch;
		expect((await pending).text).toBe("original request");
		expect(mode.editor.getText()).toBe("newer draft");
		expect(mode.editor.pendingImages).toEqual([newerImage]);
		expect(mode.editor.pendingImageLinks).toEqual(["local://newer.png"]);
	});

	it("keeps Plan and Workspace recognizable in ANSI and structured status", async () => {
		await mode.handlePlanModeCommand();
		const model = session.model;
		const tools = session.getEnabledToolNames();
		await submit("investigate without changing files");
		expect(mode.planModeEnabled).toBe(true);
		const ansi = statusText(180);
		const structured = JSON.stringify(mode.statusLine.describePreview());
		for (const output of [ansi, structured]) {
			expect(output).toContain("Plan");
			expect(output).toContain("Workspace");
		}
		expect(reminders(mock.calls[0].context.messages)).toHaveLength(1);
		expect(session.model).toBe(model);
		expect(session.getEnabledToolNames()).toEqual(tools);
	});

	it("reconciles a new session and restores the saved session's independent status", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await submit("persist workspace state");
		const saved = session.sessionManager.getSessionFile();
		if (!saved) throw new Error("Expected persisted session");
		expect(await session.newSession()).toBe(true);
		expect(statusText(160)).not.toContain("Workspace");
		await session.prompt("ordinary new session");
		expect(mock.calls[1].context.messages.some(message => text(message).includes(os.tmpdir()))).toBe(false);
		expect(await session.switchSession(saved)).toBe(true);
		expect(statusText(160)).toContain("Workspace");
		await session.prompt("resumed user input");
		expect(reminders(mock.calls[2].context.messages)).toHaveLength(1);
	});
});
