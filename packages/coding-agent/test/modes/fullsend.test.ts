import { beforeAll, describe, expect, it } from "bun:test";
import { MAGIC_KEYWORDS, renderFullsendNotice } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { containsMagicKeyword, highlightMagicKeywords, setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const FULLSEND_ROWS = MAGIC_KEYWORDS.filter(keyword => keyword.word === "fullsend");

beforeAll(() => {
	initTheme();
	// The host registers the whole table at startup (interactive-mode /
	// startup-composer), so the fork row must be part of it.
	setMagicKeywords(MAGIC_KEYWORDS);
});

describe("fullsend keyword registration", () => {
	it("registers exactly one fullsend row", () => {
		expect(FULLSEND_ROWS.map(row => row.id)).toEqual(["fullsend"]);
	});
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

describe("fullsend notice", () => {
	it("renders the complete delegation contract when task is available", () => {
		const notice = renderFullsendNotice({ tools: ["read", "task"] });
		expect(notice.startsWith("<system-notice>")).toBe(true);
		expect(notice.endsWith("</system-notice>")).toBe(true);
		expect(notice).toContain("Speed and verified quality are joint top priorities");
		expect(notice).toContain("Monetary cost and token usage are not constraints");
		expect(notice).toContain("Dispatch independent substantial work in parallel");
		expect(notice).toContain("Work directly when delegation adds no material speed or verification benefit");
		expect(notice).toContain("launch a replacement when a subagent finishes");
		expect(notice).toContain("When fewer tasks remain than available slots, launch them together");
		expect(notice).toContain("never pad or expand work just to fill the window");
		expect(notice).toContain("complete the required, relevant verification");
		expect(notice).toContain("Yield only when the task is complete");
		expect(notice).not.toMatch(/{{.*}}/);
	});

	it("retains direct execution policy without task-dependent clauses", () => {
		const notice = renderFullsendNotice({ tools: ["read"] });
		expect(notice).toContain("shortest expected wall-clock time");
		expect(notice).toContain("complete the required, relevant verification");
		expect(notice).toContain("Additional calls or spend are not goals");
		expect(notice).toContain("do not expand the requested scope or granted permissions");
		expect(notice).not.toContain("Dispatch independent substantial work in parallel");
		expect(notice).not.toContain("Work directly when delegation");
		expect(notice).not.toContain("keep the concurrency window full");
		expect(notice).not.toMatch(/{{.*}}/);
	});
});
