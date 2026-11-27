import { afterEach, describe, expect, test, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { ACP_BUILTIN_SLASH_COMMANDS, executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import { type BuiltinSlashCommandRuntime, executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { resetContextForCommand } from "../../src/slash-commands/helpers/clear";
import { listLogoutAccounts, logoutCredential } from "../../src/slash-commands/helpers/logout";

const storages: AuthStorage[] = [];
afterEach(() => {
	for (const storage of storages.splice(0)) storage.close();
	vi.restoreAllMocks();
});

describe("logout credentials", () => {
	test("the TUI dispatches a registered alias and rejects unregistered providers", async () => {
		const showOAuthSelector = vi.fn(async () => {});
		const showWarning = vi.fn();
		const runtime = {
			ctx: { showOAuthSelector, showWarning, composer: { setText: vi.fn() } },
		} as unknown as BuiltinSlashCommandRuntime;

		expect(await executeBuiltinSlashCommand("/logout openai-codex-device", runtime)).toBe(true);
		expect(showOAuthSelector).toHaveBeenCalledWith("logout", "openai-codex-device");
		expect(await executeBuiltinSlashCommand("/logout unknown-oauth-provider", runtime)).toBe(true);
		expect(showWarning).toHaveBeenCalledWith("Unknown OAuth provider: unknown-oauth-provider");
		expect(showOAuthSelector).toHaveBeenCalledTimes(1);
	});

	test("a login alias lists and removes only the selected canonical credential", async () => {
		const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		storages.push(storage);
		const canonical = "openai-codex";
		const alias = "openai-codex-device";
		await storage.credentials.set(canonical, [
			{ type: "api_key", key: "stored-key-a" },
			{ type: "api_key", key: "stored-key-b" },
		]);
		storage.keys.setRuntime(canonical, "runtime-key");
		const refreshProvider = vi.fn(async () => {});
		const refreshScopedModels = vi.fn(async () => {});
		const session = {
			sessionId: "logout-session",
			refreshScopedModels,
			modelRegistry: { authStorage: storage, refreshProvider },
		} as unknown as Pick<AgentSession, "modelRegistry" | "sessionId" | "refreshScopedModels">;

		const rows = storage.credentials.list(canonical);
		const accounts = await listLogoutAccounts(storage, alias, session.sessionId);
		expect(accounts).toHaveLength(2);
		expect(accounts).toContainEqual(expect.objectContaining({ provider: canonical, credentialId: rows[1]!.id }));
		const result = await logoutCredential(session, alias, rows[1]!.id);
		expect(result).toEqual({ removed: true, remainingSource: storage.keys.describe(canonical, session.sessionId) });
		expect(await storage.keys.get(canonical, session.sessionId)).toBe("runtime-key");
		expect(storage.credentials.list(canonical)).toEqual([rows[0]!]);
		expect(refreshProvider).toHaveBeenCalledWith(canonical, "online");
		expect(refreshScopedModels).toHaveBeenCalledTimes(1);

		expect(await logoutCredential(session, alias, rows[1]!.id)).toEqual({ removed: false });
		expect(storage.credentials.list(canonical)).toEqual([rows[0]!]);
		expect(refreshProvider).toHaveBeenCalledTimes(1);
		expect(refreshScopedModels).toHaveBeenCalledTimes(1);
	});
});

describe("shared clear business", () => {
	test("aborts and waits for compaction before resetting the same session", async () => {
		const session = {
			isCompacting: true,
			sessionGeneration: 0,
			isDisposed: false,
			abortCompaction: vi.fn(() => {}),
			resetSessionContext: vi.fn(async () => ({ droppedCount: 3 })),
		};
		vi.spyOn(Bun, "sleep").mockImplementation(async () => {
			session.isCompacting = false;
		});
		expect(await resetContextForCommand(session)).toEqual({ droppedCount: 3 });
		expect(session.abortCompaction).toHaveBeenCalledTimes(1);
		expect(session.resetSessionContext).toHaveBeenCalledTimes(1);
	});

	test("refusal does not invent a successful clear", async () => {
		const resetSessionContext = vi.fn(async () => undefined);
		expect(
			await resetContextForCommand({
				isCompacting: false,
				sessionGeneration: 0,
				isDisposed: false,
				abortCompaction: vi.fn(),
				resetSessionContext,
			}),
		).toBeUndefined();
		expect(resetSessionContext).toHaveBeenCalledTimes(1);
	});

	test("a session switch while compaction settles cannot clear the new owner", async () => {
		const session = {
			isCompacting: true,
			sessionGeneration: 0,
			isDisposed: false,
			abortCompaction: vi.fn(),
			resetSessionContext: vi.fn(async () => ({ droppedCount: 4 })),
		};
		vi.spyOn(Bun, "sleep").mockImplementation(async () => {
			session.sessionGeneration++;
			session.isCompacting = false;
		});
		await expect(resetContextForCommand(session)).rejects.toThrow("Session changed");
		expect(session.resetSessionContext).not.toHaveBeenCalled();
	});
});

function ordinaryTaskDispatchFixture() {
	const output: string[] = [];
	const settings = Settings.isolated();
	const sessionManager = { getCwd: () => "/remote-task-test" };
	const runtime = {
		settings,
		cwd: sessionManager.getCwd(),
		sessionManager,
		output: (text: string) => {
			output.push(text);
		},
		refreshCommands: async () => {},
		reloadPlugins: async () => {},
	} as unknown as SlashCommandRuntime;
	const setText = vi.fn();
	const tuiRuntime = {
		ctx: {
			settings,
			sessionManager,
			session: { getEnabledToolNames: () => ["task", "eval"] },
			composer: { setText },
			showStatus: runtime.output,
			refreshSlashCommandState: runtime.refreshCommands,
		},
	} as unknown as BuiltinSlashCommandRuntime;
	return {
		tui: (text: string) => executeBuiltinSlashCommand(text, tuiRuntime),
		acp: (text: string) => executeAcpBuiltinSlashCommand(text, runtime),
	};
}

describe("shared task dispatch", () => {
	test.each(["ultrathink", "orchestrate", "workflowz"])(
		"/%s preserves internal task whitespace in TUI and falls through in ACP",
		async name => {
			const fixture = ordinaryTaskDispatchFixture();
			const task = "first line  \r\n\r\nlast line";
			const text = `/${name}:\t ${task}\t \r\n`;
			expect(await fixture.tui(text)).toBe(`${name} ${task}`);
			expect(await fixture.acp(text)).toBe(false);
			expect(ACP_BUILTIN_SLASH_COMMANDS.some(command => command.name === name)).toBe(false);
		},
	);
});
