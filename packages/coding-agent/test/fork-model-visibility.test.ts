import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	isProviderVisible,
	setForkModelVisibilityFilteringForTests,
} from "@oh-my-pi/pi-coding-agent/modes/fork-model-visibility";

let previousFiltering = false;

beforeEach(() => {
	previousFiltering = setForkModelVisibilityFilteringForTests(true);
});

afterEach(() => {
	setForkModelVisibilityFilteringForTests(previousFiltering);
});

describe("fork model provider visibility", () => {
	test("shows only the four selected built-in providers", () => {
		for (const provider of ["opencode-go", "opencode-zen", "openai-codex", "deepseek"]) {
			expect(isProviderVisible(provider)).toBe(true);
		}

		for (const provider of ["anthropic", "openai", "google", "groq", "vllm", "llama.cpp"]) {
			expect(isProviderVisible(provider)).toBe(false);
		}
	});

	test("keeps non-bundled custom providers visible", () => {
		for (const provider of ["command-code", "ascend", "my-private-provider"]) {
			expect(isProviderVisible(provider)).toBe(true);
		}
	});
});
