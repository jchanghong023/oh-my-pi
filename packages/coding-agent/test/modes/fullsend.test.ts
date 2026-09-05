import { beforeAll, describe, expect, it } from "bun:test";
import { containsFullsend, highlightFullsend, renderFullsendNotice } from "@oh-my-pi/pi-coding-agent/modes/fullsend";
import { containsOrchestrate, highlightOrchestrate } from "@oh-my-pi/pi-coding-agent/modes/orchestrate";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { containsUltrathink, highlightUltrathink } from "@oh-my-pi/pi-coding-agent/modes/ultrathink";
import { containsWorkflow, highlightWorkflow } from "@oh-my-pi/pi-coding-agent/modes/workflow";

beforeAll(() => {
	initTheme();
});

describe("fullsend keyword detection", () => {
	it("matches standalone lowercase prose", () => {
		for (const text of ["fullsend", "please fullsend this", "fullsend the rollout", 'say "fullsend" now']) {
			expect(containsFullsend(text)).toBe(true);
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
			expect(containsFullsend(text)).toBe(false);
		}
	});

	it("ignores code and XML regions", () => {
		expect(containsFullsend("use `fullsend` here")).toBe(false);
		expect(containsFullsend("```\nfullsend\n```")).toBe(false);
		expect(containsFullsend("<note>fullsend</note>")).toBe(false);
		expect(containsFullsend("run `setup` then fullsend the task")).toBe(true);
	});
});

describe("fullsend keyword highlighting", () => {
	it("decorates standalone prose while preserving visible text", () => {
		for (const input of ["please fullsend this", 'please "fullsend," then continue']) {
			const decorated = highlightFullsend(input);
			expect(decorated).not.toBe(input);
			expect(decorated).toContain("\x1b");
			expect(Bun.stripANSI(decorated)).toBe(input);
		}
	});

	it("leaves excluded forms untouched", () => {
		for (const input of ["nothing here", "Fullsend this", "fullsending", "fullsend.ts", "fullsend()"])
			expect(highlightFullsend(input)).toBe(input);
	});

	it("does not cross-trigger with other magic keywords", () => {
		for (const [contains, highlight] of [
			[containsUltrathink, highlightUltrathink],
			[containsOrchestrate, highlightOrchestrate],
			[containsWorkflow, highlightWorkflow],
		] as const) {
			expect(contains("fullsend")).toBe(false);
			expect(highlight("fullsend")).toBe("fullsend");
		}
		expect(containsFullsend("ultrathink orchestrate workflowz")).toBe(false);
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
