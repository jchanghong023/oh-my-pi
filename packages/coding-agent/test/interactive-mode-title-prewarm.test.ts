import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";

// Issue #6462: the first submit used to spawn the local tiny-title worker
// synchronously ahead of the first frame, and title generation started before
// the optimistic user row painted. Startup now prewarms an idle worker, and the
// submit handler paints the pending row before kicking off titling.
describe("InteractiveMode tiny-title prewarm", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let term: ModeTerminal;
	// Titling (and thus the prewarm gate) is disabled when PI_NO_TITLE is set,
	// which the test env exports globally. Clear it per-test and restore after.
	let previousNoTitle: string | undefined;

	beforeAll(() => {
		initTheme();
		tempDir = TempDir.createSync("@pi-interactive-mode-title-prewarm-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		previousNoTitle = Bun.env.PI_NO_TITLE;
		delete Bun.env.PI_NO_TITLE;

		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "git.enabled": false } });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "git.enabled": false }),
			modelRegistry,
		});
		vi.spyOn(session, "prewarmModelConnection").mockImplementation(() => {});
		term = createModeTerminal();
		mode = new InteractiveMode(session, "test", () => {}, [], undefined, undefined, term.frame);
	});

	afterEach(async () => {
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		vi.restoreAllMocks();
		await session?.dispose();
		resetSettingsForTest();
		if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
		else Bun.env.PI_NO_TITLE = previousNoTitle;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	async function finishStartup(): Promise<void> {
		const ready = Promise.withResolvers<void>();
		await mode.init({ suppressWelcomeIntro: true, startupBackgroundWork: ready.resolve });
		// The title probe runs synchronously in the same background callback.
		await ready.promise;
	}

	it("prewarms the configured local tiny role on startup for an unnamed session", async () => {
		session.settings.setModelRole("tiny", "local/lfm2.5-230m");
		const prewarm = vi.spyOn(tinyTitleClient, "prewarm").mockImplementation(() => {});

		await finishStartup();

		expect(prewarm).toHaveBeenCalledWith("lfm2.5-230m");
	});

	it("does not prewarm when the session is already named", async () => {
		session.settings.setModelRole("tiny", "local/lfm2.5-230m");
		vi.spyOn(mode.sessionManager, "getSessionName").mockReturnValue("resumed-session");
		const prewarm = vi.spyOn(tinyTitleClient, "prewarm").mockImplementation(() => {});

		await finishStartup();

		expect(prewarm).not.toHaveBeenCalled();
	});

	it("does not prewarm an unconfigured default row", async () => {
		const prewarm = vi.spyOn(tinyTitleClient, "prewarm").mockImplementation(() => {});

		await finishStartup();

		expect(prewarm).not.toHaveBeenCalled();
	});

	it("does not prewarm a paid tiny role", async () => {
		const prewarm = vi.spyOn(tinyTitleClient, "prewarm").mockImplementation(() => {});
		session.settings.setModelRole("tiny", "anthropic/claude-haiku-4-5");

		await finishStartup();

		expect(prewarm).not.toHaveBeenCalled();
	});
});
