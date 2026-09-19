/**
 * `/team` default-runner unit tests: the resolved-model guard accepts
 * selector and routing annotations after the requested pattern and rejects
 * genuinely different models.
 */
import { describe, expect, it } from "bun:test";
import { modelMatches } from "@oh-my-pi/pi-coding-agent/team";

describe("team modelMatches", () => {
	const pattern = "openrouter/foo";

	it("accepts an exact match and an unknown resolved model", () => {
		expect(modelMatches(pattern, pattern)).toBe(true);
		expect(modelMatches(undefined, pattern)).toBe(true);
	});

	it("accepts thinking-suffix and routing annotations after the base id", () => {
		expect(modelMatches(`${pattern}[thinking]`, pattern)).toBe(true);
		expect(modelMatches(`${pattern}:some-profile`, pattern)).toBe(true);
		expect(modelMatches(`${pattern}@upstream-only`, pattern)).toBe(true);
	});

	it("rejects a genuinely different model", () => {
		expect(modelMatches("openrouter/other", pattern)).toBe(false);
		// A longer id sharing the prefix is a different model, not an annotation.
		expect(modelMatches("openrouter/foobar", pattern)).toBe(false);
	});
});
