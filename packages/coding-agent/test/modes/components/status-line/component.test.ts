import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../../src/config/settings";
import { SessionStatusLine } from "../../../../src/modes/interactive/status-line";
import type { StatusLineSettings } from "../../../../src/modes/view-model/status-line/types";
import type { AgentViewSession } from "../../../../src/session/agent-session-handle";
import { SessionManager } from "../../../../src/session/session-manager";
import { createStatusLine, statusSegs } from "../../../../src/ui/status/status-line";
import { StatusLineTestComponents } from "../../../helpers/status-line";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { printRows } from "../../../../src/ui/print-rows";
import { ensureTheme } from "../../../../src/ui/theme/service";
import "../../../../src/ui/styles/status";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const statusLines = new StatusLineTestComponents();
const costOnly: StatusLineSettings = { preset: "custom", leftSegments: ["cost"], rightSegments: [] };

function makeSession(
	prewalkArmed = false,
	{
		cost = 0,
		advisorCost = 0,
		usingSubscription = false,
		advisorUsingSubscription = false,
		contextPercent,
	}: {
		cost?: number;
		advisorCost?: number;
		usingSubscription?: boolean;
		advisorUsingSubscription?: boolean;
		contextPercent?: number | null;
	} = {},
): AgentViewSession {
	const model = { id: "model", name: "Model", provider: "p", api: "x", input: ["text"], contextWindow: 128000 };
	return {
		messages: [],
		model,
		state: { messages: [], model },
		isStreaming: false,
		getContextUsage: () => ({
			tokens: contextPercent === null ? 0 : 42,
			contextWindow: 128000,
			...(contextPercent !== undefined ? { percent: contextPercent } : {}),
		}),
		sessionManager: Object.assign(SessionManager.inMemory(process.cwd()), {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				premiumRequests: 0,
				cost,
				tokensPerSecond: null,
			}),
		}),
		getPrewalkState: () => (prewalkArmed ? { target: { id: "cheap-model", provider: "openai" } } : undefined),
		getAdvisorStatusOverview: () => ({
			configured: advisorCost > 0,
			advisors: advisorCost > 0 ? [{ name: "test", status: "running" as const }] : [],
		}),
		getAdvisorCost: () => advisorCost,
		isAdvisorUsingSubscription: () => advisorUsingSubscription,
		isFastModeActive: () => false,
		isAutoThinking: () => false,
		autoResolvedThinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		getAnthropicSlowModeLabel: () => undefined,
		getGoalModeState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		getPromptCacheStatus: () => undefined,
		compactionSpeculation: undefined,
		modelRegistry: { isUsingSubscription: () => usingSubscription },
		subscribe: () => () => {},
	} as unknown as AgentViewSession;
}

/** The status line's segments as plain text (`nerd`: Nerd Font glyphs). */
function statusText(session: AgentViewSession, nerd = false): string {
	const line = statusLines.track(new SessionStatusLine(session));
	return statusSegs(line.settings(), line.facts(), nerd)
		.map(seg => `${seg.icon ?? ""}${seg.spans.map(span => span.t).join("")}`)
		.join(" | ");
}

function costText(session: AgentViewSession, preset: "unicode" | "ascii" | "nerd" = "unicode"): string {
	const saved = currentTheme();
	setCurrentTheme(loadThemeSync("dark", { symbolPreset: preset }));
	try {
		const line = statusLines.track(new SessionStatusLine(session));
		line.previewSettings(costOnly);
		return Bun.stripANSI(
			printRows(
				() =>
					createStatusLine({
						settings: () => line.settings(),
						facts: () => line.facts(),
						placement: () => ({ bar: "full", gap: false, autocomplete: false }),
						nerd: () => preset === "nerd",
					}).panel,
				120,
			).join("\n"),
		);
	} finally {
		setCurrentTheme(saved);
	}
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	ensureTheme();
});

afterAll(() => {
	statusLines.dispose();
});

describe("session status line", () => {
	it("shows the Prewalk annotation when prewalk is armed", () => {
		expect(statusText(makeSession(true))).toContain("Prewalk");
		expect(statusText(makeSession(false))).not.toContain("Prewalk");
	});

	it("shows the context window without a percent while usage is unknown", () => {
		expect(statusText(makeSession())).toMatch(/\d%/);
		const unknown = statusText(makeSession(false, { contextPercent: null }));
		expect(unknown).toContain("128K");
		expect(unknown).not.toMatch(/\d%/);
	});

	it("shows primary and advisor costs separately on different billing plans", () => {
		expect(costText(makeSession(false, { cost: 2.67, advisorCost: 0.41, usingSubscription: true }))).toContain(
			"S2.67 + 👁 $0.41",
		);
	});

	it.each([
		["unicode", "S2.67 + 👁 0.41"],
		["ascii", "S2.67 + 0.41 (adv)"],
		["nerd", "\u{f067a} 2.67 + \uea70 0.41"],
	] as const)("labels same-plan advisor costs in the %s symbol preset", (preset, expected) => {
		const session = makeSession(false, {
			cost: 2.67,
			advisorCost: 0.41,
			usingSubscription: true,
			advisorUsingSubscription: true,
		});
		expect(costText(session, preset)).toContain(expected);
	});

	it("omits advisor cost when the advisor has never been active", () => {
		const text = costText(makeSession(false, { cost: 2.67, usingSubscription: true }));
		expect(text).toContain("S2.67");
		expect(text).not.toContain("👁");
		expect(text).not.toContain("(adv)");
	});
});
