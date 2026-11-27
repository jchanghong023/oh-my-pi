/**
 * Startup timing records spans into one in-memory tree until `endTiming()`.
 * Headless runners (print, RPC, ACP) are long-lived, so work done after
 * startup — every session and subagent the run spawns — must not keep
 * appending to that tree for the life of the process.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { parseArgs, type Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, postmortem, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	// `runRootCommand` registers the CLI's extension roots (`--no-extensions` → explicit-only) process-wide.
	clearOmpExtensionCliRoots();

	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

/** Whether a span opened now would be recorded into the startup timing tree. */
function spanRecorded(): boolean {
	return logger.time("post-startup-work", () => logger.openSpanPath().includes("post-startup-work"));
}

function headlessArgs(argv: string[], sessionDir: string): Args {
	const parsed = parseArgs(argv);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = sessionDir;
	return parsed;
}

describe("startup timing after a headless runner starts", () => {
	it("stops recording before print mode runs the prompt", async () => {
		const dir = TempDir.createSync("@pi-headless-timing-");
		tempDirs.push(dir);
		const authStorage = await AuthStorage.create(":memory:");
		let manager: SessionManager | undefined;
		const settings = Settings.isolated();
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const disposers: Array<() => void> = [];
		let disposal: Promise<void> | undefined;
		let recordedDuringStartup: boolean | undefined;
		let recordedDuringPrompt: boolean | undefined;
		const session = {
			extensionRunner: undefined,
			model: { provider: "anthropic", id: "test-model" },
			settings,
			get sessionManager() {
				return manager;
			},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			addDisposer: (dispose: () => void) => {
				disposers.push(dispose);
			},
			setScopedModelsRefresher: () => {},
			getAllToolNames: () => [],
			validateRetryFallbackChains: () => {},
			getLastAssistantMessage: () => undefined,
			disableStopTimeTodoReminders: () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForIdle: async () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			prompt: async () => {
				recordedDuringPrompt = spanRecorded();
				return true;
			},
			dispose: () =>
				(disposal ??= (async () => {
					for (const dispose of disposers.splice(0)) dispose();
					listeners.clear();
					await manager?.close();
				})()),
		} as unknown as AgentSession;
		const quitSpy = spyOn(postmortem, "quit").mockImplementation(async () => {});
		// Don't leave the process-global reviver pointing at this fake session and its closed auth storage.
		const reviverSpy = spyOn(AgentLifecycleManager.global(), "setPersistedSubagentReviverFactory").mockImplementation(
			() => {},
		);
		// Model discovery can otherwise outlive the in-memory auth storage.
		const refreshSpy = spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(() => {});
		// Print mode intentionally keeps recording under PI_TIMING; this case covers the default.
		const savedTiming = process.env.PI_TIMING;
		delete process.env.PI_TIMING;
		const argv = ["--print", "--no-session", "hello"];
		try {
			await runRootCommand(headlessArgs(argv, dir.path()), argv, {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					manager = options?.sessionManager;
					if (!manager) throw new Error("Missing print session manager");
					recordedDuringStartup = spanRecorded();
					return { session } as unknown as CreateAgentSessionResult;
				},
			});
		} finally {
			if (savedTiming !== undefined) process.env.PI_TIMING = savedTiming;
			logger.endTiming();
			quitSpy.mockRestore();
			reviverSpy.mockRestore();
			refreshSpy.mockRestore();
			await session.dispose().catch(() => undefined);
			authStorage.close();
		}
		expect(recordedDuringStartup).toBe(true);
		expect(recordedDuringPrompt).toBe(false);
	}, 15_000);

	it("stops recording before the ACP server runs", async () => {
		const dir = TempDir.createSync("@pi-headless-timing-");
		tempDirs.push(dir);
		const authStorage = await AuthStorage.create(":memory:");
		let recordedWhileServing: boolean | undefined;
		// The ACP server never returns; the stub stops it with a sentinel once it has observed.
		const stopServing = new Error("stop ACP server");
		try {
			await runRootCommand(headlessArgs(["--mode", "acp"], dir.path()), ["--mode", "acp"], {
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated(),
				runAcpMode: async () => {
					recordedWhileServing = spanRecorded();
					throw stopServing;
				},
			});
		} catch (error) {
			if (error !== stopServing) throw error;
		} finally {
			logger.endTiming();
			authStorage.close();
		}
		expect(recordedWhileServing).toBe(false);
	}, 15_000);
});
