import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

describe("status line discuss mode segment", () => {
	it("renders the read-only state exactly", () => {
		const context = {
			session: {},
			width: 120,
			compactThinkingLevel: false,
			options: {},
			planMode: null,
			discussMode: { enabled: true },
			loopMode: null,
			prewalk: null,
			goalMode: null,
			vibeMode: null,
			collab: null,
			usageStats: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
				tokensPerSecond: null,
			},
			contextPercent: 0,
			contextTokens: 0,
			contextWindow: 0,
			autoCompactEnabled: false,
			compactionSpeculation: "idle",
			speculationBlinkOn: true,
			subagentCount: 0,
			activeMs: 0,
			activeRepo: null,
			worktree: null,
			git: { branch: null, status: null, pr: null },
			usage: null,
		} as SegmentContext;

		expect(Bun.stripANSI(renderSegment("mode", context).content)).toBe("Discuss · Read-only");
	});
});
