import { beforeAll, describe, expect, test } from "bun:test";
import { getOAuthCredentialProvider, getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { OAuthSelectorComponent } from "../src/overlays/oauth-selector";
import { initTheme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

describe("OAuth logout selector", () => {
	test("allows logging out through a device-login alias with canonical stored credentials", () => {
		const providers = getOAuthProviders().filter(
			provider => getOAuthCredentialProvider(provider.id) === "openai-codex",
		);
		const aliasIndex = providers.findIndex(provider => provider.id === "openai-codex-device");
		expect(aliasIndex).toBeGreaterThanOrEqual(0);
		let selected: string | undefined;
		const selector = new OAuthSelectorComponent(
			"logout",
			{ credentials: { has: provider => provider === "openai-codex" }, keys: { source: () => undefined } },
			provider => {
				selected = provider;
			},
			() => {},
			{ disabledProviders: ["openai-codex", "openai-codex-device"] },
		);
		try {
			for (let index = 0; index < aliasIndex; index++) selector.handleInput("\x1b[B");
			selector.handleInput("\r");
			expect(selected).toBe("openai-codex-device");
		} finally {
			selector.stopValidation();
		}
	});

	test("does not offer alias logout without stored credentials", () => {
		let selected: string | undefined;
		const selector = new OAuthSelectorComponent(
			"logout",
			{ credentials: { has: () => false }, keys: { source: () => undefined } },
			provider => {
				selected = provider;
			},
			() => {},
		);
		try {
			selector.handleInput("\r");
			expect(selected).toBeUndefined();
			expect(Bun.stripANSI(selector.render(80).join("\n"))).toContain("No stored provider credentials to log out");
		} finally {
			selector.stopValidation();
		}
	});
});
