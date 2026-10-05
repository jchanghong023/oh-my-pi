import { afterEach, describe, expect, test, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { getExtensionUISelectOptionLabel, type ExtensionUIContext } from "../../src/extensibility/extensions/types";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { resetContextForCommand } from "../../src/slash-commands/helpers/clear";
import {
	formatLogoutCommandResult,
	logoutProviderForCommand,
	type LogoutCommandUI,
} from "../../src/slash-commands/helpers/logout";

const storages: AuthStorage[] = [];
afterEach(() => {
	for (const storage of storages.splice(0)) storage.close();
	vi.restoreAllMocks();
});

async function logoutFixture() {
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	storages.push(storage);
	await storage.credentials.set("anthropic", [
		{ type: "oauth", access: "access-a", refresh: "refresh-a", expires: Date.now() + 60_000, email: "a@example.com" },
		{ type: "oauth", access: "access-b", refresh: "refresh-b", expires: Date.now() + 60_000, email: "b@example.com" },
	]);
	const refreshProvider = vi.fn(async () => {});
	const session = {
		sessionId: "logout-session",
		sessionGeneration: 0,
		isDisposed: false,
		modelRegistry: { authStorage: storage, refreshProvider },
	} as unknown as Pick<AgentSession, "modelRegistry" | "sessionId" | "sessionGeneration" | "isDisposed">;
	return { storage, refreshProvider, session };
}

describe("shared logout business", () => {
	test("no argument selects a real provider and removes only the selected stored account", async () => {
		const { storage, session, refreshProvider } = await logoutFixture();
		const originalRows = storage.credentials.list("anthropic");
		const selectedId = originalRows[1]!.id;
		const ui: LogoutCommandUI = {
			selectProvider: vi.fn(async (providers: Parameters<LogoutCommandUI["selectProvider"]>[0]) => {
				expect(providers.map(provider => provider.id)).toContain("anthropic");
				return "anthropic";
			}),
			selectAccount: vi.fn(
				async (
					provider: Parameters<LogoutCommandUI["selectAccount"]>[0],
					accounts: Parameters<LogoutCommandUI["selectAccount"]>[1],
				) => {
					expect(provider.id).toBe("anthropic");
					expect(accounts.map(account => account.credentialId).sort()).toEqual(
						originalRows.map(row => row.id).sort(),
					);
					return selectedId;
				},
			),
		};
		const result = await logoutProviderForCommand(session, undefined, ui);
		expect(result.status).toBe("removed");
		expect(storage.credentials.list("anthropic").map(row => row.id)).toEqual([originalRows[0]!.id]);
		expect(refreshProvider).toHaveBeenCalledWith("anthropic", "online");
		expect(formatLogoutCommandResult(result)?.message).toContain("b@example.com");
	});

	test("explicit provider and account cancellation leave every credential intact", async () => {
		const { storage, session, refreshProvider } = await logoutFixture();
		const before = storage.credentials.list("anthropic");
		const ui: LogoutCommandUI = {
			selectProvider: vi.fn(async () => {
				throw new Error("must not select provider");
			}),
			selectAccount: vi.fn(async () => undefined),
		};
		expect(await logoutProviderForCommand(session, "anthropic", ui)).toEqual({ status: "cancelled" });
		expect(storage.credentials.list("anthropic")).toEqual(before);
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	test("invalid or disappeared selections never remove a different account", async () => {
		const { storage, session, refreshProvider } = await logoutFixture();
		const ui: LogoutCommandUI = {
			selectProvider: vi.fn(async () => "anthropic"),
			selectAccount: vi.fn(async (_provider, accounts) => {
				await storage.credentials.removeById("anthropic", accounts[0]!.credentialId);
				return accounts[0]!.credentialId;
			}),
		};
		const unknown = await logoutProviderForCommand(session, "not-a-provider", ui);
		expect(unknown.status).toBe("skipped");
		expect(ui.selectAccount).not.toHaveBeenCalled();
		const stale = await logoutProviderForCommand(session, "anthropic", ui);
		expect(stale.status).toBe("skipped");
		expect(storage.credentials.list("anthropic")).toHaveLength(1);
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	test("a session switch during selection cannot remove credentials", async () => {
		const { storage, session, refreshProvider } = await logoutFixture();
		const before = storage.credentials.list("anthropic");
		let generation = 0;
		Object.defineProperty(session, "sessionGeneration", { get: () => generation });
		const result = await logoutProviderForCommand(session, "anthropic", {
			selectProvider: async () => "anthropic",
			selectAccount: async (_provider, accounts) => {
				generation++;
				return accounts[0]!.credentialId;
			},
		});
		expect(result.status).toBe("skipped");
		expect(storage.credentials.list("anthropic")).toEqual(before);
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	test("ACP logout uses real provider/account dialogs and consumes only the chosen credential", async () => {
		const { storage, session, refreshProvider } = await logoutFixture();
		const originalRows = storage.credentials.list("anthropic");
		const output: string[] = [];
		const select = vi.fn<ExtensionUIContext["select"]>(async (_title, options) => {
			const chosen =
				options.find(option => getExtensionUISelectOptionLabel(option).includes("b@example.com")) ?? options[0];
			return chosen === undefined ? undefined : getExtensionUISelectOptionLabel(chosen);
		});
		const runtime = {
			session,
			cwd: "/logout-test",
			settings: Settings.isolated(),
			sessionManager: { getCwd: () => "/logout-test" },
			output: (text: string) => {
				output.push(text);
			},
			ui: { select, confirm: async () => false },
			refreshCommands: async () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;
		expect(await executeAcpBuiltinSlashCommand("/logout", runtime)).toEqual({ consumed: true });
		expect(select).toHaveBeenCalledTimes(2);
		expect(storage.credentials.list("anthropic").map(row => row.id)).toEqual([originalRows[0]!.id]);
		expect(refreshProvider).toHaveBeenCalledWith("anthropic", "online");
		expect(output.join("\n")).toContain("b@example.com");
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

	test("ACP clear uses in-place reset, not a new session", async () => {
		const resetSessionContext = vi.fn(async () => ({ droppedCount: 2 }));
		const newSession = vi.fn(async () => true);
		const output: string[] = [];
		const runtime = {
			session: { isCompacting: false, sessionGeneration: 0, isDisposed: false, resetSessionContext, newSession },
			settings: Settings.isolated(),
			cwd: "/clear-test",
			sessionManager: { getCwd: () => "/clear-test" },
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: async () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;
		expect(await executeAcpBuiltinSlashCommand("/clear", runtime)).toEqual({ consumed: true });
		expect(resetSessionContext).toHaveBeenCalledTimes(1);
		expect(newSession).not.toHaveBeenCalled();
		expect(output.join("\n")).toContain("2 messages dropped");
	});
});
