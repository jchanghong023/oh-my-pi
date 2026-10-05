import { beforeAll, describe, expect, it } from "bun:test";
import { MAGIC_KEYWORDS } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { containsMagicKeyword, highlightMagicKeywords, setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
	// The host registers the whole table at startup (interactive-mode /
	// startup-composer), so the fork row must be part of it.
	setMagicKeywords(MAGIC_KEYWORDS);
});

describe("fullsend keyword detection", () => {
	it("matches standalone lowercase prose", () => {
		for (const text of ["fullsend", "please fullsend this", "fullsend the rollout", 'say "fullsend" now']) {
			expect(containsMagicKeyword(text, "fullsend")).toBe(true);
		}
	});

	it("ignores casing, derived words, paths, members, and calls", () => {
		for (const text of [
			"Fullsend",
			"FULLSEND",
			"fullsending",
			"fullsender",
			"prefullsend",
			"packages/coding-agent/src/modes/fullsend.ts",
			"object.fullsend",
			"fullsend()",
		]) {
			expect(containsMagicKeyword(text, "fullsend")).toBe(false);
		}
	});

	it("ignores code and XML regions", () => {
		expect(containsMagicKeyword("use `fullsend` here", "fullsend")).toBe(false);
		expect(containsMagicKeyword("```\nfullsend\n```", "fullsend")).toBe(false);
		expect(containsMagicKeyword("<note>fullsend</note>", "fullsend")).toBe(false);
		expect(containsMagicKeyword("run `setup` then fullsend the task", "fullsend")).toBe(true);
	});
});

describe("fullsend keyword highlighting", () => {
	it("decorates standalone prose while preserving visible text", () => {
		for (const input of ["please fullsend this", 'please "fullsend," then continue']) {
			const decorated = highlightMagicKeywords(input);
			expect(decorated).not.toBe(input);
			expect(decorated).toContain("\x1b");
			expect(Bun.stripANSI(decorated)).toBe(input);
		}
	});

	it("leaves excluded forms untouched", () => {
		for (const input of ["nothing here", "Fullsend this", "fullsending", "fullsend.ts", "fullsend()"])
			expect(highlightMagicKeywords(input)).toBe(input);
	});

	it("does not cross-trigger with other magic keywords", () => {
		const otherWords = MAGIC_KEYWORDS.filter(keyword => keyword.word !== "fullsend").map(keyword => keyword.word);
		for (const word of otherWords) expect(containsMagicKeyword("fullsend", word)).toBe(false);
		setMagicKeywords([{ word: "fullsend", hue: [300, 360] }]);
		try {
			expect(highlightMagicKeywords(otherWords.join(" "))).toBe(otherWords.join(" "));
		} finally {
			setMagicKeywords(MAGIC_KEYWORDS);
		}
	});
});
