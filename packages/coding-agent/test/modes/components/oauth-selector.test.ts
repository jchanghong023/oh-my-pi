import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { OAuthSelector, type OAuthSelectorAuthSource } from "../../../src/ui/overlays/pickers/oauth-selector";
import { mountOverlay } from "../../helpers/overlay-terminal";

import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const authStorage = {
	credentials: { has: (_providerId: string) => false },
	keys: { source: (_providerId: string) => undefined },
} as unknown as OAuthSelectorAuthSource;

/**
 * Type `query` into the selector, then press Enter when `confirm`; answers the screen before the
 * Enter and the providers picked.
 */
function search(
	mode: "login" | "logout",
	auth: OAuthSelectorAuthSource,
	query: string,
	options: { confirm?: boolean; disabledProviders?: readonly string[] } = {},
): { rendered: string; selected: string[] } {
	const selected: string[] = [];
	const term = mountOverlay(
		() =>
			OAuthSelector({
				mode,
				auth,
				...(options.disabledProviders ? { disabledProviders: options.disabledProviders } : {}),
				onSelect: providerId => selected.push(providerId),
				onCancel: () => {},
			}),
		{ columns: 80 },
	);
	try {
		term.type(query);
		const rendered = term.screen().join("\n");
		if (options.confirm) term.press("enter");
		return { rendered, selected };
	} finally {
		term.dispose();
	}
}

/** Auth with a stored OpenCode Go key. */
const storedOpencodeGo = {
	credentials: { has: (providerId: string) => providerId === "opencode-go" },
	keys: {
		source: (providerId: string) => (providerId === "opencode-go" ? { kind: "api_key", concrete: true } : undefined),
	},
} as unknown as OAuthSelectorAuthSource;

describe("OAuth selector", () => {
	it("fuzzy-filters overflowing provider lists from typed input", () => {
		const providers = getOAuthProviders();
		expect(providers.length).toBeGreaterThan(10);
		const target = providers.find(provider => provider.available && provider.id === "vllm");
		if (!target) throw new Error("Expected the available vllm login entry");

		const { rendered, selected } = search("login", authStorage, target.id, { confirm: true });
		expect(rendered).toContain(target.name);
		expect(rendered).toContain(target.id);
		expect(selected).toEqual([target.id]);
	});

	it("does not offer env-only providers as logout targets", () => {
		const auth = {
			credentials: { has: (_providerId: string) => false },
			keys: {
				source: (providerId: string) =>
					providerId === "opencode-go" || providerId === "opencode-zen"
						? { kind: "api_key", concrete: true }
						: undefined,
			},
		} as unknown as OAuthSelectorAuthSource;
		const { rendered, selected } = search("logout", auth, "opencode-go", { confirm: true });
		expect(rendered).toContain("No stored provider credentials to log out");
		expect(selected).toEqual([]);
	});

	it("offers stored providers as logout targets", () => {
		const { rendered, selected } = search("logout", storedOpencodeGo, "opencode-go", { confirm: true });
		expect(rendered).toContain("OpenCode Go");
		expect(rendered).toContain("logged in");
		expect(selected).toEqual(["opencode-go"]);
	});

	it("offers the registered storage provider in logout and the device alias in login", () => {
		const canonical = "openai-codex";
		const alias = "openai-codex-device";
		const auth: OAuthSelectorAuthSource = {
			credentials: { has: id => id === canonical },
			keys: { source: () => undefined },
		};
		const { selected } = search("logout", auth, "", { confirm: true });
		expect(selected).toEqual([canonical]);
		expect(search("login", auth, alias, { confirm: true }).selected).toEqual([alias]);
	});

	describe("disabledProviders", () => {
		afterEach(() => {
			resetSettingsForTest();
		});

		it("hides disabled providers from the login list even when searched", async () => {
			const providers = getOAuthProviders();
			const victim =
				providers.find(provider => provider.available && provider.id === "vllm") ??
				providers.find(provider => provider.available) ??
				providers[0];
			if (!victim) throw new Error("Expected a provider to exercise disabled login filtering");

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: [victim.id] } });

			const { rendered } = search("login", authStorage, victim.id, {
				disabledProviders: cfgDisabledProviders.get(settings),
			});
			expect(rendered).not.toContain(victim.name);
		});

		it("hides alias logins whose storeCredentialsAs target is disabled", async () => {
			const alias = getOAuthProviders().find(provider => provider.storeCredentialsAs === "openai-codex");
			if (!alias) throw new Error("Expected a login alias storing openai-codex credentials");
			expect(alias.id).not.toBe("openai-codex");

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["openai-codex"] } });

			const { rendered } = search("login", authStorage, alias.id, {
				disabledProviders: cfgDisabledProviders.get(settings),
			});
			expect(rendered).not.toContain(alias.name);
		});

		it("keeps disabled providers as logout targets", async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["opencode-go"] } });

			const { rendered, selected } = search("logout", storedOpencodeGo, "opencode-go", {
				disabledProviders: cfgDisabledProviders.get(settings),
				confirm: true,
			});
			expect(rendered).toContain("OpenCode Go");
			expect(selected).toEqual(["opencode-go"]);
		});
	});
});
