import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { AppFrame } from "../../src/modes/interactive/frame";
import { initTheme } from "../../src/ui/theme/service";
import { nativeShell } from "../helpers/native-shell";
import { createProviderFixture, type ProviderFixture } from "./provider-fixture";

const image = {
	type: "image" as const,
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
	mimeType: "image/png",
};

// Exercise the real Shell and driver against a Tern protocol peer, not Tern's pixel layout.
describe("ordinary native TSP surface", () => {
	let tempDir: TempDir;
	let originalCwd: string;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let provider: ProviderFixture;
	let mode: InteractiveMode;
	let ui: Awaited<ReturnType<typeof nativeShell>> | undefined;
	let output: EventEmitter & { columns: number; rows: number };

	beforeAll(() => initTheme());

	beforeEach(async () => {
		originalCwd = process.cwd();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-dev-tsp-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		provider = createProviderFixture();
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
		output = Object.assign(new EventEmitter(), { columns: 100, rows: 28 });
	});

	afterEach(async () => {
		try {
			mode?.stop();
			await ui?.[Symbol.asyncDispose]();
			await session?.dispose();
		} finally {
			ui = undefined;
			await provider?.[Symbol.asyncDispose]();
			authStorage?.close();
			setProjectDir(originalCwd);
			tempDir?.removeSync();
			vi.restoreAllMocks();
			resetSettingsForTest();
		}
	});

	function surface() {
		const root = ui?.surface("inline");
		if (!root) throw new Error("Expected an open native session surface");
		return root;
	}

	function strings(value: unknown): string[] {
		if (typeof value === "string") return [Bun.stripANSI(value)];
		if (Array.isArray(value)) return value.flatMap(strings);
		if (value && typeof value === "object") return Object.values(value).flatMap(strings);
		return [];
	}

	function content(): string {
		const root = surface();
		return strings([...root.main, ...root.dock, ...root.layer].map(node => ui!.tree(node.id))).join("\n");
	}

	async function until(predicate: () => boolean): Promise<void> {
		const deadline = Date.now() + 5000;
		while (!predicate()) {
			if (Date.now() >= deadline) {
				throw new Error(
					`Native surface timeout: ${predicate.toString()}; providerFailures=${JSON.stringify(provider.failures)}`,
				);
			}
			await Bun.sleep(5);
		}
		expect(mode.shell.native()).toBe(true);
		expect(surface().role).toBe("omp.session");
	}

	async function init() {
		const frame = new AppFrame({ version: "test", shape: "box" });
		frame.shell.setHome(frame.composer.field);
		// Use the Tern protocol peer's driver, with mutable stdout geometry.
		const start = frame.shell.start.bind(frame.shell);
		vi.spyOn(frame.shell, "start").mockImplementation(options =>
			start({ ...options, driver: { ...options.driver, stdout: output } }),
		);
		const native = await nativeShell(frame.shell);
		ui = native;
		// As with the CLI prepaint, hand the mode an already-started frame.
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, frame);
		await mode.init({ suppressWelcomeIntro: true });
		// The interactive startup caller replays persisted conversation after init.
		await mode.renderInitialMessages();
		return native;
	}

	it("keeps ordinary history, editable draft and attachments across viewport changes", async () => {
		session.sessionManager.appendMessage({ role: "user", content: "TSP_ORDINARY_ROOT", timestamp: Date.now() });
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		const native = await init();
		await until(() => content().includes("TSP_ORDINARY_ROOT"));
		mode.composer.setText("TSP_UNSENT_DRAFT");
		mode.composer.pendingImages.push(image);
		mode.composer.pendingImageLinks.push(undefined);
		await until(() => content().includes("TSP_UNSENT_DRAFT"));
		const root = surface().id;
		for (const [columns, rows] of [
			[120, 36],
			[100, 28],
		] as const) {
			output.columns = columns;
			output.rows = rows;
			output.emit("resize");
			await until(() => mode.shell.size().columns === columns && mode.shell.size().rows === rows);
			expect(surface().id).toBe(root);
			expect(content()).toContain("TSP_UNSENT_DRAFT");
			expect(content()).toContain("TSP_ORDINARY_ROOT");
			expect(content()).not.toContain("Dev ·");
			expect(surface().layer).toEqual([]);
			expect(mode.composer.pendingImages).toEqual([image]);
		}
		native.type("!");
		await until(() => content().includes("TSP_UNSENT_DRAFT!"));
		expect(mode.composer.expandedText()).toBe("TSP_UNSENT_DRAFT!");
		expect(mode.session).toBe(session);
		expect(session.messages).toHaveLength(1);
		expect(provider.requests).toEqual([]);
	}, 60_000);

	it("opens ordinary session details without consuming draft or attachments", async () => {
		const native = await init();
		mode.composer.setText("TSP_VIEWER_DRAFT");
		mode.composer.pendingImages.push(image);
		mode.composer.pendingImageLinks.push(undefined);
		await until(() => content().includes("TSP_VIEWER_DRAFT"));
		const messages = [...session.messages];
		await mode.handleSessionCommand();
		await until(() => surface().layer.length > 0 && content().includes(session.sessionId));
		native.type("\x1b[27u");
		await until(() => surface().layer.length === 0 && content().includes("TSP_VIEWER_DRAFT"));
		expect(mode.composer.expandedText()).toBe("TSP_VIEWER_DRAFT");
		expect(mode.composer.pendingImages).toEqual([image]);
		expect(session.messages).toEqual(messages);
		expect(provider.requests).toEqual([]);
	}, 60_000);

	it("ordinary persistent cwd movement preserves the native root and its unsent composer draft", async () => {
		await init();
		const next = path.join(tempDir.path(), "destination");
		await fs.mkdir(next);
		mode.composer.setText("TSP_CWD_DRAFT");
		await until(() => content().includes("TSP_CWD_DRAFT"));
		const root = surface().id;
		const history = [...session.messages];
		await mode.handleMoveCommand(next);
		expect(mode.session).toBe(session);
		expect(mode.sessionManager.getCwd()).toBe(next);
		expect(surface().id).toBe(root);
		expect(content()).toContain("TSP_CWD_DRAFT");
		expect(mode.composer.expandedText()).toBe("TSP_CWD_DRAFT");
		expect(session.messages).toEqual(history);
		expect(provider.requests).toEqual([]);
	}, 60_000);
});
