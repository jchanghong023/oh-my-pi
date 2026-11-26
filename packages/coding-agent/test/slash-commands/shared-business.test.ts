import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthCredentialProvider, getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { Settings } from "../../src/config/settings";
import { ACP_BUILTIN_SLASH_COMMANDS, executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import { type BuiltinSlashCommandRuntime, executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
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
	const refreshScopedModels = vi.fn(async () => {});
	const session = {
		sessionId: "logout-session",
		sessionGeneration: 0,
		isDisposed: false,
		refreshScopedModels,
		modelRegistry: { authStorage: storage, refreshProvider },
	} as unknown as Pick<
		AgentSession,
		"modelRegistry" | "sessionId" | "sessionGeneration" | "isDisposed" | "refreshScopedModels"
	>;
	return { storage, refreshProvider, refreshScopedModels, session };
}

describe("shared logout business", () => {
	test("no argument selects a real provider and removes only the selected stored account", async () => {
		const { storage, session, refreshProvider, refreshScopedModels } = await logoutFixture();
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
		expect(refreshScopedModels).toHaveBeenCalledTimes(1);
		expect(result.status === "removed" && result.account.credentialId).toBe(selectedId);
	});

	test.each(["picker", "explicit"])("logs out retired credentials via %s", async method => {
		const { storage, session, refreshProvider } = await logoutFixture();
		const id = "google-gemini-cli";
		await storage.credentials.set(id, [
			{ type: "oauth", access: "retired-access", refresh: "retired-refresh", expires: Date.now() + 60_000 },
		]);
		expect(getOAuthProviders().some(provider => provider.id === id)).toBe(false);
		const stored = storage.credentials.list(id)[0]!;
		const selectProvider = vi.fn(async (providers: Parameters<LogoutCommandUI["selectProvider"]>[0]) => {
			expect(providers.filter(provider => provider.id === id)).toHaveLength(1);
			return id;
		});
		const result = await logoutProviderForCommand(session, method === "explicit" ? id : undefined, {
			selectProvider,
			selectAccount: async (provider, accounts) => {
				expect(provider.id).toBe(id);
				return accounts[0]!.credentialId;
			},
		});
		expect(selectProvider).toHaveBeenCalledTimes(method === "explicit" ? 0 : 1);
		expect(result).toMatchObject({ status: "removed", account: { provider: id, credentialId: stored.id } });
		expect(storage.credentials.list(id)).toEqual([]);
		expect(storage.credentials.list("anthropic")).toHaveLength(2);
		expect(refreshProvider).toHaveBeenCalledWith(id, "online");
	});

	test("explicit provider and account cancellation leave every credential intact", async () => {
		const { storage, session, refreshProvider } = await logoutFixture();
		const before = storage.credentials.list("anthropic");
		const ui: LogoutCommandUI = {
			selectProvider: vi.fn(async () => undefined),
			selectAccount: vi.fn(async () => undefined),
		};
		expect(await logoutProviderForCommand(session, "anthropic", ui)).toEqual({ status: "cancelled" });
		expect(storage.credentials.list("anthropic")).toEqual(before);
		expect(refreshProvider).not.toHaveBeenCalled();
		expect(ui.selectProvider).not.toHaveBeenCalled();
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

	test.each(["sessionId", "sessionGeneration", "modelRegistry", "isDisposed"] as const)(
		"cancels logout when %s changes during account selection",
		async field => {
			const { storage, session, refreshProvider } = await logoutFixture();
			const before = storage.credentials.list("anthropic");
			const result = await logoutProviderForCommand(session, "anthropic", {
				selectProvider: async () => "anthropic",
				selectAccount: async (_provider, accounts) => {
					Object.defineProperty(session, field, {
						value:
							field === "modelRegistry"
								? { ...session.modelRegistry }
								: field === "isDisposed"
									? true
									: field === "sessionGeneration"
										? 1
										: "replacement",
						configurable: true,
					});
					return accounts[0]!.credentialId;
				},
			});
			expect(result.status).toBe("skipped");
			expect(formatLogoutCommandResult(result)?.level).toBe("error");
			expect(storage.credentials.list("anthropic")).toEqual(before);
			expect(refreshProvider).not.toHaveBeenCalled();
		},
	);

	test("warns about the real remaining auth source after removing the selected account", async () => {
		const { storage, session, refreshProvider } = await logoutFixture();
		await storage.credentials.set("anthropic", [{ type: "api_key", key: "stored-key" }]);
		storage.keys.setRuntime("anthropic", "runtime-key");
		const result = await logoutProviderForCommand(session, "anthropic", {
			selectProvider: async () => undefined,
			selectAccount: async (_provider, accounts) => accounts[0]?.credentialId,
		});
		expect(storage.credentials.list("anthropic")).toEqual([]);
		expect(refreshProvider).toHaveBeenCalledWith("anthropic", "online");
		expect(result.status).toBe("removed");
		expect("remainingSource" in result ? result.remainingSource : undefined).toBe(
			storage.keys.describe("anthropic", session.sessionId),
		);
		expect(await storage.keys.get("anthropic", session.sessionId)).toBe("runtime-key");
		expect(formatLogoutCommandResult(result)?.level).toBe("warning");
	});

	test("cancelling provider selection lists only stored providers and leaves all accounts untouched", async () => {
		const { storage, session, refreshProvider } = await logoutFixture();
		await storage.credentials.set("openai-codex", [{ type: "api_key", key: "other-stored-key" }]);
		const before = storage.credentials.list("anthropic");
		const other = storage.credentials.list("openai-codex");
		const selectAccount = vi.fn();
		const result = await logoutProviderForCommand(session, undefined, {
			selectProvider: async providers => {
				expect(providers.length).toBeGreaterThanOrEqual(2);
				expect(providers.map(provider => provider.id)).toEqual(
					Array.from(new Set(providers.map(provider => getOAuthCredentialProvider(provider.id)))),
				);
				for (const provider of providers)
					expect(storage.credentials.has(getOAuthCredentialProvider(provider.id))).toBe(true);
				return undefined;
			},
			selectAccount,
		});
		expect(result).toEqual({ status: "cancelled" });
		expect(formatLogoutCommandResult(result)).toBeUndefined();
		expect(storage.credentials.list("anthropic")).toEqual(before);
		expect(storage.credentials.list("openai-codex")).toEqual(other);
		expect(selectAccount).not.toHaveBeenCalled();
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	test("explains non-stored auth at its source without offering account selection", async () => {
		const { storage, session, refreshProvider } = await logoutFixture();
		for (const row of storage.credentials.list("anthropic"))
			await storage.credentials.removeById("anthropic", row.id);
		storage.keys.setRuntime("anthropic", "non-stored-key");
		const describeSource = vi.spyOn(storage.keys, "describe");
		const ui = { selectProvider: vi.fn(), selectAccount: vi.fn() };
		const result = await logoutProviderForCommand(session, "anthropic", ui);
		expect(result.status).toBe("skipped");
		expect(formatLogoutCommandResult(result)?.level).toBe("error");
		expect(describeSource).toHaveBeenCalledWith("anthropic", session.sessionId);
		expect(storage.credentials.list("anthropic")).toEqual([]);
		expect(await storage.keys.get("anthropic", session.sessionId)).toBe("non-stored-key");
		expect(ui.selectProvider).not.toHaveBeenCalled();
		expect(ui.selectAccount).not.toHaveBeenCalled();
		expect(refreshProvider).not.toHaveBeenCalled();
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
