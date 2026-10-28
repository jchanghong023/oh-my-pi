import { beforeAll, describe, expect, test } from "bun:test";
import { getOAuthCredentialProvider, getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { OAuthSelectorComponent } from "../src/overlays/oauth-selector";
import { initTheme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

describe("OAuth logout selector", () => {
	test("offers one canonical logout entry for shared credentials, including disabled providers", () => {
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
			selector.handleInput("\x1b[B");
			selector.handleInput("\r");
			expect(selected).toBe("openai-codex");
		} finally {
			selector.stopValidation();
		}
	});

	test("keeps different canonical credentials independently selectable", () => {
		const other = getOAuthProviders().find(
			provider => provider.id !== "openai-codex" && provider.id === getOAuthCredentialProvider(provider.id),
		)!;
		const selected: string[] = [];
		const selector = new OAuthSelectorComponent(
			"logout",
			{
				credentials: { has: provider => provider === "openai-codex" || provider === other.id },
				keys: { source: () => undefined },
			},
			provider => selected.push(provider),
			() => {},
		);
		try {
			selector.handleInput("\r");
			selector.handleInput("\x1b[B");
			selector.handleInput("\r");
			selector.handleInput("\x1b[B");
			selector.handleInput("\r");
			expect(new Set(selected)).toEqual(new Set(["openai-codex", other.id]));
		} finally {
			selector.stopValidation();
		}
	});

	test("keeps device aliases available as separate login methods", () => {
		const aliasIndex = getOAuthProviders().findIndex(provider => provider.id === "openai-codex-device");
		let selected: string | undefined;
		const selector = new OAuthSelectorComponent(
			"login",
			{ credentials: { has: () => false }, keys: { source: () => undefined } },
			provider => {
				selected = provider;
			},
			() => {},
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
		} finally {
			selector.stopValidation();
		}
	});
});
