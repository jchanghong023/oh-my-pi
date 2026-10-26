import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { peekSpecDrivenController } from "@oh-my-pi/pi-coding-agent/spec-driven/controller";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { TspTestTerminal } from "../../../tui/test/native/tsp-harness";
import { createProviderFixture, type ProviderFixture, REQUIREMENT } from "./provider-fixture";

// This exercises NativeBackend frames through the official reference document,
// not a Tern process or its pixel layout. No PI_TUI_NATIVE probe/fallback claim.
describe("Dev native TSP surface", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let provider: ProviderFixture;
	let mode: InteractiveMode;
	let terminal: TspTestTerminal;
	let pump: NodeJS.Timeout | undefined;
	let resizeTerminal: (columns: number, rows: number) => void;

	beforeAll(() => initTheme());

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-dev-tsp-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		provider = createProviderFixture({ requirementsQuestion: "TSP_STAGE_QUESTION" });
		modelRegistry.registerProvider("dev-tsp-fixture", {
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
		const model = modelRegistry.find("dev-tsp-fixture", "chat");
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
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		// Composer owns its real render scheduler. Only the existing test
		// terminal's hello/ack delivery is driven here, with no renderer mock.
		pump = setInterval(() => {
			terminal.answerProbe();
			while (terminal.deliver()) {}
		}, 1);
	});

	afterEach(async () => {
		try {
			await peekSpecDrivenController(session.sessionManager)?.dispose();
			mode?.stop();
			mode?.onInputCallback?.({ text: "", cancelled: true, started: false });
			await Promise.resolve();
			await session?.dispose();
		} finally {
			if (pump !== undefined) clearInterval(pump);
			pump = undefined;
			await provider?.[Symbol.asyncDispose]();
			authStorage?.close();
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
				const state = peekSpecDrivenController(session.sessionManager)?.observation();
				throw new Error(
					`Native surface timeout: ${predicate.toString()}; native=${mode.ui.nativeRendering}, frames=${terminal.frames.length}, phase=${state?.status.phase}, error=${state?.error ?? state?.status.blockedReason ?? ""}, applyErrors=${JSON.stringify(terminal.errors)}, providerFailures=${JSON.stringify(provider.failures)}`,
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

	function expectDevLines() {
		const widgets: string[][] = [];
		const visit = (node: TspNode): void => {
			if (node.k === "rows" && Array.isArray(node.p?.lines)) {
				const lines = node.p.lines.filter((line): line is string => typeof line === "string").map(Bun.stripANSI);
				if (lines.some(line => line.startsWith("Dev ·"))) widgets.push(lines);
			}
			for (const child of node.c ?? []) visit(child);
		};
		visit(document());
		expect(widgets).toHaveLength(1);
		expect(widgets[0]).toHaveLength(3);
		expect(widgets[0]![1]).toContain("/dev new");
		expect(widgets[0]![2]).toContain("/session");
	}

	it("keeps the three Dev rows, editable draft and attachment through both viewport sizes and restores root on exit", async () => {
		session.sessionManager.appendMessage({ role: "user", content: "TSP_ORDINARY_ROOT", timestamp: Date.now() });
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		await init();
		await until(() => content().includes("TSP_ORDINARY_ROOT"));
		await mode.handleDevInput("/dev");
		const controller = peekSpecDrivenController(session.sessionManager)!;
		await until(() => content().includes("Dev ·") && !content().includes("TSP_ORDINARY_ROOT"));
		expect(controller.status().phase).toBe("idle");
		const image = {
			type: "image" as const,
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
			mimeType: "image/png",
		};
		mode.editor.setText("TSP_UNSENT_DRAFT");
		mode.editor.pendingImages.push(image);
		mode.editor.pendingImageLinks.push(undefined);
		await mode.handleDevInput("TSP_UNSENT_DRAFT", { images: [image] });
		mode.ui.requestRender();
		await until(() => content().includes("TSP_UNSENT_DRAFT"));
		expectDevLines();
		for (const [columns, rows] of [
			[120, 36],
			[100, 28],
		] as const) {
			const previousFrames = terminal.frames.length;
			resizeTerminal(columns, rows);
			await until(() => terminal.frames.length > previousFrames && content().includes("TSP_UNSENT_DRAFT"));
			expect(terminal.columns).toBe(columns);
			expect(terminal.rows).toBe(rows);
			expectDevLines();
			expect(mode.ui.hasOverlay()).toBe(false);
			expect(mode.editor.pendingImages).toEqual([image]);
		}
		// Input still reaches the native composer after the resize round trip.
		terminal.send("!");
		await until(() => content().includes("TSP_UNSENT_DRAFT!"));
		expect(mode.editor.getExpandedText()).toBe("TSP_UNSENT_DRAFT!");
		await controller.exit();
		await until(() => content().includes("TSP_ORDINARY_ROOT") && !content().includes("Dev ·"));
		expect(mode.session).toBe(session);
		expect(mode.editor.getExpandedText()).toBe("TSP_UNSENT_DRAFT!");
		expect(mode.editor.pendingImages).toEqual([image]);
		expect(session.messages).toHaveLength(1);
	}, 60_000);

	it("renders the controller-owned requirements session and opens manual config/details without sending its draft", async () => {
		session.sessionManager.appendMessage({ role: "user", content: "TSP_HIDDEN_ROOT", timestamp: Date.now() });
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		await init();
		await mode.handleDevInput("/dev");
		const controller = peekSpecDrivenController(session.sessionManager)!;
		await mode.handleDevInput(`/dev new ${REQUIREMENT}`);
		await until(
			() =>
				controller.status().phase === "requirements" &&
				!controller.observation().active &&
				content().includes("TSP_STAGE_QUESTION") &&
				!content().includes("TSP_HIDDEN_ROOT"),
		);
		const stage = controller.nativeSession();
		if (!stage) throw new Error("Controller did not expose its requirements session");
		expect(mode.session).toBe(stage);
		const stageMessageCount = stage.messages.length;
		expect(stageMessageCount).toBeGreaterThan(0);
		expect(provider.requests.length).toBeGreaterThan(0);
		expect(provider.failures).toEqual([]);
		expect(mode.agent).toBe(stage.agent);
		expect(mode.sessionManager).toBe(stage.sessionManager);
		mode.editor.setText("TSP_VIEWER_DRAFT");
		mode.ui.requestRender();
		await until(() => content().includes("TSP_VIEWER_DRAFT"));
		const beforeConfiguration = content();
		const useTeam = controller.status().useTeam;
		const configuration = mode.handleDevInput("/dev config");
		await until(() => content() !== beforeConfiguration && content().includes("Team"));
		terminal.send("\x1b");
		await configuration;
		await until(() => !mode.ui.hasOverlay() && content().includes("TSP_VIEWER_DRAFT"));
		expect(controller.status().useTeam).toBe(useTeam);
		await mode.handleDevInput("/session");
		await until(
			() => mode.ui.hasOverlay() && content().includes("Dev 工作区") && content().includes(stage.sessionId),
		);
		terminal.send("\x1b");
		await until(() => !mode.ui.hasOverlay() && content().includes("TSP_STAGE_QUESTION"));
		expect(mode.editor.getExpandedText()).toBe("TSP_VIEWER_DRAFT");
		expect(stage.messages).toHaveLength(stageMessageCount);
		expect(session.messages).toHaveLength(1);
		await controller.exit();
		await until(
			() =>
				content().includes("TSP_HIDDEN_ROOT") &&
				!content().includes("TSP_STAGE_QUESTION") &&
				!content().includes("Dev ·"),
		);
	}, 60_000);
});
