import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { TspTestTerminal } from "../../../tui/test/native/tsp-harness";
import { createProviderFixture, type ProviderFixture } from "./provider-fixture";

// This exercises NativeBackend frames through the official reference document,
// not a Tern process or its pixel layout. No PI_TUI_NATIVE probe/fallback claim.
describe("ordinary native TSP surface", () => {
	let tempDir: TempDir;
	let originalCwd: string;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let provider: ProviderFixture;
	let mode: InteractiveMode;
	let terminal: TspTestTerminal;
	let pump: NodeJS.Timeout | undefined;
	let resizeTerminal: (columns: number, rows: number) => void;

	beforeAll(() => initTheme());

	beforeEach(async () => {
		originalCwd = process.cwd();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-dev-tsp-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		provider = createProviderFixture({ requirementsQuestion: "TSP_STAGE_QUESTION" });
		modelRegistry.registerProvider("deepseek", {
			api: "openai-completions",
			baseUrl: provider.baseUrl,
			apiKey: "local-test-only",
			models: [
				{
					id: "chat",
					name: "Dev TSP local fixture",
					reasoning: false,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200000,
					maxTokens: 4096,
				},
			],
		});
		const model = modelRegistry.find("deepseek", "chat");
		if (!model) throw new Error("Expected local TSP fixture model");
		({ session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: path.join(tempDir.path(), "agent"),
			authStorage,
			model,
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			restrictToolNames: true,
			enableMCP: false,
			enableLsp: false,
			autoTitle: false,
			systemPrompt: "Test",
		}));
		terminal = new TspTestTerminal({ cols: 100, rows: 28 });
		// The shared harness deliberately ignores the resize callback. Retain it
		// here so Composer receives the same notification as a real Terminal.
		let columns = 100;
		let rows = 28;
		let onResize: (() => void) | undefined;
		const start = terminal.start.bind(terminal);
		vi.spyOn(terminal, "start").mockImplementation((input, resize, disconnect, options) => {
			onResize = resize;
			start(input, resize, disconnect, options);
		});
		Object.defineProperties(terminal, {
			columns: { get: () => columns },
			rows: { get: () => rows },
		});
		resizeTerminal = (nextColumns, nextRows) => {
			columns = nextColumns;
			rows = nextRows;
			if (!onResize) throw new Error("Composer did not register a resize callback");
			onResize();
		};
		const composer = new Composer({ terminal });
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, composer);
		// Composer owns its real render scheduler. Only the existing test
		// terminal's hello/ack delivery is driven here, with no renderer mock.
		pump = setInterval(() => {
			terminal.answerProbe();
			while (terminal.deliver()) {}
		}, 1);
	});

	afterEach(async () => {
		try {
			mode?.stop();
			mode?.onInputCallback?.({ text: "", cancelled: true, started: false });
			await Promise.resolve();
			await session?.dispose();
		} finally {
			if (pump !== undefined) clearInterval(pump);
			pump = undefined;
			await provider?.[Symbol.asyncDispose]();
			authStorage?.close();
			setProjectDir(originalCwd);
			tempDir?.removeSync();
			vi.restoreAllMocks();
			resetSettingsForTest();
		}
	});

	function document() {
		const surface = terminal.surface;
		const doc = surface === undefined ? undefined : terminal.docs.get(surface);
		if (!doc) throw new Error("Expected an open TSP reference document");
		return doc.snapshot();
	}

	function strings(value: unknown): string[] {
		if (typeof value === "string") return [Bun.stripANSI(value)];
		if (Array.isArray(value)) return value.flatMap(strings);
		if (value && typeof value === "object") return Object.values(value).flatMap(strings);
		return [];
	}

	function content(): string {
		return strings(document()).join("\n");
	}

	async function until(predicate: () => boolean): Promise<void> {
		const deadline = Date.now() + 5000;
		while (!predicate()) {
			if (Date.now() >= deadline) {
				throw new Error(
					`Native surface timeout: ${predicate.toString()}; native=${mode.ui.nativeRendering}, frames=${terminal.frames.length}, applyErrors=${JSON.stringify(terminal.errors)}, providerFailures=${JSON.stringify(provider.failures)}`,
				);
			}
			await Bun.sleep(5);
		}
		expect(mode.ui.nativeRendering).toBe(true);
		expect(terminal.frames.length).toBeGreaterThan(0);
		expect(terminal.errors).toEqual([]);
	}

	async function init() {
		await mode.init({ suppressWelcomeIntro: true });
		// init mounts the composer but does not replay persisted conversation;
		// the interactive startup caller performs this separate public step.
		await mode.renderInitialMessages();
		await until(() => mode.ui.nativeRendering && terminal.frames.length > 0);
	}

	it("keeps ordinary history, editable draft and attachments across viewport changes", async () => {
		session.sessionManager.appendMessage({ role: "user", content: "TSP_ORDINARY_ROOT", timestamp: Date.now() });
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		await init();
		await until(() => content().includes("TSP_ORDINARY_ROOT"));
		const image = {
			type: "image" as const,
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
			mimeType: "image/png",
		};
		mode.editor.setText("TSP_UNSENT_DRAFT");
		mode.editor.pendingImages.push(image);
		mode.editor.pendingImageLinks.push(undefined);
		mode.ui.requestRender();
		await until(() => content().includes("TSP_UNSENT_DRAFT"));
		for (const [columns, rows] of [
			[120, 36],
			[100, 28],
		] as const) {
			const previousFrames = terminal.frames.length;
			resizeTerminal(columns, rows);
			await until(() => terminal.frames.length > previousFrames && content().includes("TSP_UNSENT_DRAFT"));
			expect(content()).toContain("TSP_ORDINARY_ROOT");
			expect(content()).not.toContain("Dev ·");
			expect(terminal.columns).toBe(columns);
			expect(terminal.rows).toBe(rows);
			expect(mode.ui.hasOverlay()).toBe(false);
			expect(mode.editor.pendingImages).toEqual([image]);
		}
		terminal.send("!");
		await until(() => content().includes("TSP_UNSENT_DRAFT!"));
		expect(mode.editor.getExpandedText()).toBe("TSP_UNSENT_DRAFT!");
		expect(mode.session).toBe(session);
		expect(session.messages).toHaveLength(1);
		expect(provider.requests).toEqual([]);
	}, 60_000);

	it("opens ordinary session details without consuming draft or attachments", async () => {
		await init();
		mode.editor.setText("TSP_VIEWER_DRAFT");
		mode.ui.requestRender();
		await until(() => content().includes("TSP_VIEWER_DRAFT"));
		const messages = [...session.messages];
		await mode.handleSessionCommand();
		await until(() => mode.ui.hasOverlay() && content().includes(session.sessionId));
		terminal.send("\x1b");
		await until(() => !mode.ui.hasOverlay() && content().includes("TSP_VIEWER_DRAFT"));
		expect(mode.editor.getExpandedText()).toBe("TSP_VIEWER_DRAFT");
		expect(session.messages).toEqual(messages);
		expect(provider.requests).toEqual([]);
	}, 60_000);

	it("ordinary persistent cwd movement preserves the native root and its unsent composer draft", async () => {
		await init();
		const next = path.join(tempDir.path(), "destination");
		await fs.mkdir(next);
		mode.editor.setText("TSP_CWD_DRAFT");
		mode.ui.requestRender();
		await until(() => content().includes("TSP_CWD_DRAFT"));
		const history = [...session.messages];
		await mode.handleMoveCommand(next);
		expect(mode.session).toBe(session);
		expect(mode.sessionManager.getCwd()).toBe(next);
		expect(mode.editor.getExpandedText()).toBe("TSP_CWD_DRAFT");
		expect(session.messages).toEqual(history);
		expect(provider.requests).toEqual([]);
	}, 60_000);
});
