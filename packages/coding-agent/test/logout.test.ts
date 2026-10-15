import { afterEach, describe, expect, test, vi } from "bun:test";
import { Settings } from "../src/config/settings";
import { getExtensionUISelectOptionLabel, type ExtensionUIContext } from "../src/extensibility/extensions/types";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import { logoutProviderForCommand } from "../src/slash-commands/helpers/logout";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

const storages: AuthStorage[] = [];
afterEach(() => {
	for (const storage of storages.splice(0)) storage.close();
	vi.restoreAllMocks();
});

async function fixture() {
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	storages.push(storage);
	await storage.credentials.set("anthropic", [{ type: "api_key", key: "stored-key" }]);
	const refreshProvider = vi.fn(async () => {});
	const session = {
		sessionId: "logout-no-ui",
		sessionGeneration: 0,
		isDisposed: false,
		modelRegistry: { authStorage: storage, refreshProvider },
	} as unknown as Pick<AgentSession, "modelRegistry" | "sessionId" | "sessionGeneration" | "isDisposed">;
	const output: string[] = [];
	const runtime = {
		session,
		cwd: "/logout-test",
		settings: Settings.isolated(),
		sessionManager: { getCwd: () => "/logout-test" },
		output: (text: string) => {
			output.push(text);
		},
		refreshCommands: async () => {},
		reloadPlugins: async () => {},
	} as unknown as SlashCommandRuntime;
	return { storage, session, refreshProvider, runtime };
}

describe("logout without ACP elicitation", () => {
	test.each(["/logout", "/logout anthropic"])("%s removes the only stored account without a UI", async command => {
		const { storage, runtime, refreshProvider } = await fixture();
		expect(await executeAcpBuiltinSlashCommand(command, runtime)).toEqual({ consumed: true });
		expect(storage.credentials.list("anthropic")).toEqual([]);
		expect(refreshProvider).toHaveBeenCalledWith("anthropic", "online");
	});

	test("multiple accounts without a UI remain stored even with an explicit provider", async () => {
		const { storage, runtime, refreshProvider } = await fixture();
		await storage.credentials.set("anthropic", [
			{ type: "oauth", access: "a", refresh: "ra", expires: Date.now() + 60_000, email: "a@example.com" },
			{ type: "oauth", access: "b", refresh: "rb", expires: Date.now() + 60_000, email: "b@example.com" },
		]);
		const before = storage.credentials.list("anthropic");
		await executeAcpBuiltinSlashCommand("/logout anthropic", runtime);
		expect(storage.credentials.list("anthropic")).toEqual(before);
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	test("multiple stored providers without a UI are not selected arbitrarily", async () => {
		const { storage, runtime, refreshProvider } = await fixture();
		await storage.credentials.set("openai-codex", [{ type: "api_key", key: "other-key" }]);
		const anthropic = storage.credentials.list("anthropic");
		const codex = storage.credentials.list("openai-codex");
		await executeAcpBuiltinSlashCommand("/logout", runtime);
		expect(storage.credentials.list("anthropic")).toEqual(anthropic);
		expect(storage.credentials.list("openai-codex")).toEqual(codex);
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	test("provider cancellation preserves both providers' sole accounts", async () => {
		const { storage, runtime, refreshProvider } = await fixture();
		await storage.credentials.set("openai-codex", [{ type: "api_key", key: "other-key" }]);
		const anthropic = storage.credentials.list("anthropic");
		const codex = storage.credentials.list("openai-codex");
		const select = vi.fn<ExtensionUIContext["select"]>(async () => undefined);
		runtime.ui = { select, confirm: async () => false };
		await executeAcpBuiltinSlashCommand("/logout", runtime);
		expect(storage.credentials.list("anthropic")).toEqual(anthropic);
		expect(storage.credentials.list("openai-codex")).toEqual(codex);
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	test("selecting a provider removes only its sole account, without an account dialog", async () => {
		const { storage, runtime, refreshProvider } = await fixture();
		await storage.credentials.set("openai-codex", [{ type: "api_key", key: "other-key" }]);
		const anthropic = storage.credentials.list("anthropic");
		const select = vi.fn<ExtensionUIContext["select"]>(async (_title, options) => {
			const chosen = options.find(option => getExtensionUISelectOptionLabel(option).includes("(openai-codex)"));
			if (chosen === undefined) throw new Error("Provider choice is unavailable");
			return getExtensionUISelectOptionLabel(chosen);
		});
		runtime.ui = { select, confirm: async () => false };
		await executeAcpBuiltinSlashCommand("/logout", runtime);
		expect(storage.credentials.list("anthropic")).toEqual(anthropic);
		expect(storage.credentials.list("openai-codex")).toEqual([]);
		expect(refreshProvider).toHaveBeenCalledWith("openai-codex", "online");
	});

	test("an aborted command cannot remove a sole account through automatic selection", async () => {
		const { storage, session, refreshProvider } = await fixture();
		const before = storage.credentials.list("anthropic");
		const controller = new AbortController();
		controller.abort();
		await expect(
			logoutProviderForCommand(
				session,
				undefined,
				{
					selectProvider: async () => {
						throw new Error("must not select a sole provider");
					},
					selectAccount: async () => {
						throw new Error("must not select a sole account");
					},
				},
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(storage.credentials.list("anthropic")).toEqual(before);
		expect(refreshProvider).not.toHaveBeenCalled();
	});
});
